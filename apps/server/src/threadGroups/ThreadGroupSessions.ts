import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadGroupId,
  type ThreadGroupNotFoundError,
  ThreadGroupSessionError,
  type ThreadGroupStorageError,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadGroups from "./ThreadGroupService.ts";

/**
 * A group's session: an ordinary thread on the group's environment for
 * talking about the whole group. Its agent reads the group with
 * t3_group_info, which finds the group from the calling thread.
 */
export class ThreadGroupSessions extends Context.Service<
  ThreadGroupSessions,
  {
    /**
     * The group's session thread, started on first use in the scratch
     * project, or the newest local member's project where there is no
     * scratch folder. A deleted session is replaced; an archived one is reused.
     */
    readonly open: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<
      { readonly threadId: ThreadId },
      ThreadGroupNotFoundError | ThreadGroupStorageError | ThreadGroupSessionError
    >;
  }
>()("t3/threadGroups/ThreadGroupSessions") {}

const make = Effect.gen(function* () {
  const groups = yield* ThreadGroups.ThreadGroupService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  // Two clicks on a group must not start two sessions.
  const opening = yield* Semaphore.make(1);

  const liveShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
      Effect.orElseSucceed(() => null),
    );

  const open: ThreadGroupSessions["Service"]["open"] = Effect.fn("ThreadGroupSessions.open")(
    function* (groupId) {
      const failure = (reason: ThreadGroupSessionError["reason"], cause?: unknown) =>
        new ThreadGroupSessionError({ groupId, reason, ...(cause === undefined ? {} : { cause }) });
      const group = yield* groups.get(groupId);
      if (group.sessionThreadId !== null && (yield* liveShell(group.sessionThreadId)) !== null) {
        return { threadId: group.sessionThreadId };
      }
      // The session starts like the group's most recent member here, so it
      // uses a model the user already runs on this machine.
      const here = yield* environment.getEnvironmentId;
      const local = yield* Effect.forEach(
        group.members.filter((member) => member.environmentId === here),
        (member) => liveShell(member.threadId),
      );
      const latest = local
        .filter((shell): shell is OrchestrationV2ThreadShell => shell !== null)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0];
      // Scratch keeps the session out of every member's checkout. Where there
      // is none (a data dir inside a repository), it joins the newest member's
      // project here instead.
      const scratch = yield* folders.ensureScratchProject.pipe(
        Effect.catch((cause) =>
          latest === undefined
            ? Effect.fail(failure("no-scratch-project", cause))
            : Effect.succeed({ projectId: latest.projectId }),
        ),
      );
      const defaults = yield* settings.getSettings.pipe(
        Effect.map((current) => resolveProjectSettings(current, scratch.projectId).settings),
        Effect.mapError((cause) => failure("launch", cause)),
      );
      const modelSelection = latest?.modelSelection ?? defaults.defaultModelSelection;
      if (modelSelection == null) return yield* failure("no-model");
      const commandId = CommandId.make(
        `group-session:${yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => failure("launch", cause)))}`,
      );
      const launched = yield* launches
        .launch({
          commandId,
          projectId: scratch.projectId,
          title: group.title,
          modelSelection,
          runtimeMode: latest?.runtimeMode ?? defaults.defaultRuntimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError((cause) => failure("launch", cause)));
      yield* groups.setSession({ groupId, threadId: launched.threadId });
      return { threadId: launched.threadId };
    },
    (effect) => opening.withPermits(1)(effect),
  );

  return ThreadGroupSessions.of({ open });
});

export const layer = Layer.effect(ThreadGroupSessions, make);
