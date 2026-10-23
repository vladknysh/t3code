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
let scratchBroken = false;
let disabledModel: string | null = null;
const unreadable = new Set<string>();

const layer = ThreadGroupSessions.layer.pipe(
  Layer.provideMerge(ThreadGroups.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        unreadable.has(threadId)
          ? Effect.die("projection read failed")
          : Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  Layer.provide(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        if (input.modelSelection.model === disabledModel) {
          return Effect.fail(
            new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
              projectId: input.projectId,
              instanceId: input.modelSelection.instanceId,
            }),
          );
        }
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
      ensureScratchProject: Effect.suspend(
        (): Effect.Effect<{ readonly projectId: ProjectId }, ManagedProjectFolders.ScratchError> =>
          scratchBroken
            ? Effect.fail(
                new ManagedProjectFolders.ScratchFolderError({ folder: "/x", cause: "disk" }),
              )
            : scratchAvailable
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
  Layer.provide(
    ServerSettings.layerTest({
      defaultModelSelection: haiku,
      defaultRuntimeMode: "approval-required",
    }),
  ),
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

  it.effect("starts in the project's default mode, not a member's", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      launched.length = 0;
      yield* sessions.open(group.id);
      assert.strictEqual(launched[0]?.runtimeMode, "approval-required");
    }),
  );

  it.effect("falls back to the default model when the member's provider is off", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      disabledModel = sonnet.model;
      launched.length = 0;
      yield* sessions.open(group.id);
      disabledModel = null;
      // The refused launch with the member's model left nothing behind.
      assert.deepStrictEqual(
        launched.map((input) => input.modelSelection),
        [haiku],
      );
    }),
  );

  it.effect("fails instead of starting a second session when a read fails", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      const first = yield* sessions.open(group.id);
      unreadable.add(first.threadId);
      launched.length = 0;
      const exit = yield* sessions.open(group.id).pipe(Effect.exit);
      unreadable.delete(first.threadId);
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual(launched.length, 0);
    }),
  );

  it.effect("does not fall back to a member's checkout when scratch is broken", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: here, threadId: "newer-member" }]);
      scratchBroken = true;
      launched.length = 0;
      const error = yield* sessions.open(group.id).pipe(Effect.flip);
      scratchBroken = false;
      assert.strictEqual(error._tag, "ThreadGroupSessionError");
      assert.strictEqual(launched.length, 0);
    }),
  );

  it.effect("uses the default model when no member lives here", () =>
    Effect.gen(function* () {
      const sessions = yield* ThreadGroupSessions.ThreadGroupSessions;
      const group = yield* createGroup([{ environmentId: there, threadId: "remote-only" }]);
      launched.length = 0;
      yield* sessions.open(group.id);
      assert.deepStrictEqual(launched[0]?.modelSelection, haiku);
    }),
  );
});
