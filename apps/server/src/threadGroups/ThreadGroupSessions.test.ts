import {
  EnvironmentId,
  ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadGroups from "./ThreadGroupService.ts";
import * as ThreadGroupSessions from "./ThreadGroupSessions.ts";

const here = EnvironmentId.make("env-mini");
const there = EnvironmentId.make("env-laptop");
const scratch = ProjectId.make("scratch");
const decodeModel = Schema.decodeUnknownSync(ModelSelection);
const sonnet = decodeModel({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
const haiku = decodeModel({ instanceId: "claudeAgent", model: "claude-haiku-5-5" });

/** The fields the session reads from a member's shell. */
const shell = (input: {
  readonly model: typeof sonnet;
  readonly updatedAt: string;
  readonly deleted?: boolean;
}) =>
  ({
    projectId: ProjectId.make("acme-api"),
    modelSelection: input.model,
    runtimeMode: "full-access",
    updatedAt: DateTime.makeUnsafe(input.updatedAt),
    deletedAt: input.deleted ? DateTime.makeUnsafe(input.updatedAt) : null,
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map<string, OrchestrationV2ThreadShell>([
  ["older-member", shell({ model: haiku, updatedAt: "2026-10-20T10:00:00Z" })],
  ["newer-member", shell({ model: sonnet, updatedAt: "2026-10-22T10:00:00Z" })],
]);
const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
let scratchAvailable = true;

const layer = ThreadGroupSessions.layer.pipe(
  Layer.provideMerge(ThreadGroups.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  Layer.provide(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        const threadId = ThreadId.make(`session-${launched.length}`);
        shells.set(
          threadId,
          shell({ model: input.modelSelection, updatedAt: "2026-10-23T10:00:00Z" }),
        );
        return Effect.succeed({ threadId, projection: undefined as never, resumed: false });
      },
    }),
  ),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      ensureScratchProject: Effect.suspend(() =>
        scratchAvailable
          ? Effect.succeed({ projectId: scratch })
          : Effect.fail(new ManagedProjectFolders.ScratchUnavailableError()),
      ),
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(here),
      getDescriptor: Effect.succeed(descriptorOf(here, "Mac mini")),
    }),
  ),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const createGroup = (members: ReadonlyArray<{ environmentId: EnvironmentId; threadId: string }>) =>
  ThreadGroups.ThreadGroupService.pipe(
    Effect.flatMap((groups) =>
      groups.update({
        _tag: "create",
        title: "Rate limiting",
        members: members.map((member) => ({ ...member, threadId: ThreadId.make(member.threadId) })),
      }),
    ),
    Effect.map(({ group }) => group!),
  );

it.layer(layer)("ThreadGroupSessions", (it) => {
  it.effect("starts one session in the scratch project, like the newest member here", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([
        { environmentId: here, threadId: "older-member" },
        { environmentId: here, threadId: "newer-member" },
        // Newest of all, but on another environment: its model may not exist here.
        { environmentId: there, threadId: "remote-member" },
      ]);
      launched.length = 0;
      const first = yield* sessions.open(group.id);
      const again = yield* sessions.open(group.id);
      assert.strictEqual(again.threadId, first.threadId);
      assert.strictEqual(launched.length, 1);
      assert.deepInclude(launched[0], {
        projectId: scratch,
        title: "Rate limiting",
        modelSelection: sonnet,
      });
      // It starts empty: the user asks the first question.
      assert.notProperty(launched[0], "initialMessage");
      const stored = yield* (yield* ThreadGroups.ThreadGroupService).get(group.id);
      assert.strictEqual(stored.sessionThreadId, first.threadId);
    }),
  );

  it.effect("replaces a session thread that was deleted", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      const first = yield* sessions.open(group.id);
      shells.set(
        first.threadId,
        shell({ model: sonnet, updatedAt: "2026-10-23T11:00:00Z", deleted: true }),
      );
      const second = yield* sessions.open(group.id);
      assert.notStrictEqual(second.threadId, first.threadId);
    }),
  );

  it.effect("joins the newest member's project when there is no scratch folder", () =>
    Effect.gen(function* () {
      scratchAvailable = false;
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      launched.length = 0;
      yield* sessions.open(group.id);
      assert.strictEqual(launched[0]?.projectId, ProjectId.make("acme-api"));
      scratchAvailable = true;
    }),
  );

  it.effect("needs a model: a member here or a default in settings", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: there, threadId: "remote-only" }]);
      const error = yield* sessions.open(group.id).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadGroupSessionError");
      if (error._tag === "ThreadGroupSessionError") assert.strictEqual(error.reason, "no-model");
    }),
  );
});
