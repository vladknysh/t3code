import {
  EnvironmentId,
  IsoDateTime,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadStatus,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadGroups from "../threadGroups/ThreadGroupService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadGroupMcpService from "./ThreadGroupMcpService.ts";

const mini = EnvironmentId.make("env-mini");
const laptop = EnvironmentId.make("env-laptop");
const gone = EnvironmentId.make("env-gone");
const asleep = EnvironmentId.make("env-asleep");
const at = IsoDateTime.make("2026-10-23T10:00:00.000Z");

const threadCaller = (threadId: string): McpInvocationScope => ({
  environmentId: mini,
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** Another environment calling here for one of its agents, over its link. */
const linkCaller: McpInvocationScope = {
  environmentId: mini,
  requestNamespace: "mcp-client:laptop-link",
  thread: undefined,
  client: { sessionId: "laptop-link", label: "T3 Code · MacBook Pro", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

type Item = OrchestratorMcpThreadReadResult["items"][number];

const message = (position: number, type: "user_message" | "assistant_message", text: string) =>
  ({
    position,
    visibility: "local",
    sourceThreadId: ThreadId.make("unused"),
    itemId: TurnItemId.make(`item-${position}`),
    runId: null,
    messageId: null,
    createdBy: null,
    creationSource: null,
    type,
    status: "completed",
    title: null,
    text,
    textTruncated: false,
    updatedAt: at,
  }) satisfies Item;

interface StoredThread {
  readonly title: string;
  readonly status: OrchestratorMcpThreadStatus;
  readonly settled?: boolean;
  /** Message items at their timeline positions; other positions hold activity. */
  readonly items: readonly Item[];
  readonly itemCount: number;
}

/** Answers like t3_thread_read: a messages page after `afterPosition`. */
const page = (
  threadId: ThreadId,
  thread: StoredThread,
  input: OrchestratorMcpThreadReadInput,
): OrchestratorMcpThreadReadResult => {
  const matching = thread.items.filter((item) => item.position > (input.afterPosition ?? -1));
  const items = matching.slice(0, input.limit ?? 50);
  return {
    thread: {
      threadId,
      projectId: ProjectId.make("acme-api"),
      title: thread.title,
      createdBy: "user",
      creationSource: "web",
      status: thread.status,
      latestRunId: null,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5-5",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      titleRegeneration: null,
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      relationshipToParent: null,
      runCount: 1,
      itemCount: thread.itemCount,
      pendingRequestCount: 0,
      archived: false,
      settled: thread.settled ?? false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      createdAt: at,
      updatedAt: at,
    },
    recentRuns: [],
    items,
    nextPosition: items.at(-1)?.position ?? null,
    hasMore: matching.length > items.length,
  };
};

// A long thread: its last reply sits after hundreds of activity items.
const longItems = [
  message(0, "user_message", "Research client-side retry with backoff"),
  ...Array.from({ length: 150 }, (_, index) =>
    message(1 + index * 2, "assistant_message", `progress note ${index}`),
  ),
  message(1_200, "user_message", "Add jitter too"),
  message(1_650, "assistant_message", "Added full jitter."),
];

const stored = new Map<string, StoredThread>([
  [
    `${mini}/rate-limit-research-api`,
    {
      title: "rate-limit-research-api",
      status: "running",
      itemCount: 6,
      items: [
        message(0, "user_message", "Research rate limiting for the API gateway"),
        message(5, "assistant_message", "Comparing token bucket and sliding window."),
      ],
    },
  ],
  [
    // Shorter than the tail window, so its tail read starts from the beginning.
    `${laptop}/short-remote`,
    {
      title: "short-remote",
      status: "idle",
      itemCount: 2,
      items: [
        message(0, "user_message", "Check the CDN cache headers"),
        message(1, "assistant_message", "They are set."),
      ],
    },
  ],
  [
    `${laptop}/rate-limit-research-web`,
    {
      title: "rate-limit-research-web",
      status: "idle",
      settled: true,
      itemCount: 1_700,
      items: longItems,
    },
  ],
]);

const notFound = (environmentId: EnvironmentId) =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: `Not found on ${environmentId}.`,
  });

const answer = (environmentId: EnvironmentId, input: OrchestratorMcpThreadReadInput) => {
  const thread = stored.get(`${environmentId}/${input.threadId}`);
  return thread === undefined
    ? Effect.fail(notFound(environmentId))
    : Effect.succeed(page(input.threadId, thread, input));
};

/** Every local read, so tests can check it was made as an outside reader. */
const localReadScopes: Array<McpInvocationScope> = [];

// Threads here are read directly; the others can only arrive through a link.
const layer = ThreadGroupMcpService.layer.pipe(
  Layer.provideMerge(ThreadGroups.layer),
  Layer.provide(
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      readThread: (scope, input) => {
        localReadScopes.push(scope);
        return answer(mini, input);
      },
    }),
  ),
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId, params) => {
        if (tool.name !== "t3_thread_read") return Effect.die(`unexpected ${tool.name}`);
        if (environmentId === asleep) return Effect.never;
        // Like the real link, the call is encoded for the wire first.
        return Schema.encodeUnknownEffect(tool.parametersSchema as Schema.Encoder<unknown>)(
          params,
        ).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: "bad params" }),
          ),
          // The service forwards only t3_thread_read, whose parameters and success these are.
          Effect.andThen(answer(environmentId, params as OrchestratorMcpThreadReadInput)),
        ) as never;
      },
      links: () =>
        Effect.succeed({
          environmentId: mini,
          links: [
            {
              environmentId: laptop,
              label: "MacBook Pro",
              status: "reachable" as const,
              access: "full-access" as const,
              expiresAt: "2027-01-01T00:00:00.000Z",
              lastError: null,
            },
          ],
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed(descriptorOf(mini, "Mac mini")),
    }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const member = (environmentId: EnvironmentId, threadId: string) => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});

const createGroup = (title: string, members: ReturnType<typeof member>[]) =>
  ThreadGroupMcpService.ThreadGroupMcpService.pipe(
    Effect.flatMap((service) =>
      service.update(threadCaller("orchestrator"), { action: "create", title, members }),
    ),
    Effect.map(({ group }) => group!),
  );

it.layer(layer)("ThreadGroupMcpService", (it) => {
  it.effect("reads each member where it lives and rolls the group up", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const { group } = yield* service.update(threadCaller("orchestrator"), {
        action: "create",
        title: "rate limits",
        members: [
          { threadId: ThreadId.make("rate-limit-research-api") },
          member(laptop, "rate-limit-research-web"),
          member(gone, "deleted-thread"),
          member(laptop, "short-remote"),
        ],
      });
      // A member without an environment is a thread where the group is stored.
      assert.strictEqual(group?.members[0]?.environmentId, mini);

      localReadScopes.length = 0;
      const info = yield* service.info(threadCaller("orchestrator"), { groupId: group!.id });
      assert.strictEqual(info.status, "working");
      assert.isFalse(info.settled);
      const [api, web, deleted] = info.members;
      assert.deepInclude(api, {
        environmentLabel: "Mac mini",
        task: "Research rate limiting for the API gateway",
        latestRequest: null,
        latestReply: "Comparing token bucket and sliding window.",
        unavailable: null,
      });
      assert.strictEqual(api?.thread?.status, "running");
      // The latest reply is the newest one, far past the first pages.
      assert.deepInclude(web, {
        environmentLabel: "MacBook Pro",
        task: "Research client-side retry with backoff",
        latestRequest: "Add jitter too",
        latestReply: "Added full jitter.",
      });
      assert.isTrue(web?.thread?.settled);
      // An unreadable member is reported, not fatal.
      assert.deepInclude(deleted, { thread: null, unavailable: "Not found on env-gone." });
      assert.deepInclude(info.members[3], { latestReply: "They are set.", unavailable: null });
      // Reading as an outside reader keeps delegated results unacknowledged.
      assert.isTrue(localReadScopes.length > 0);
      assert.isTrue(localReadScopes.every((scope) => scope.thread === undefined));
    }),
  );

  it.effect("records the calling agent as where the threads it adds came from", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const { group } = yield* service.update(threadCaller("rate-limit-research-api"), {
        action: "create",
        title: "spawned work",
        members: [
          { threadId: ThreadId.make("rate-limit-research-api") },
          member(laptop, "rate-limit-research-web"),
        ],
      });
      assert.deepStrictEqual(group?.members[1]?.from, member(mini, "rate-limit-research-api"));
      const info = yield* service.info(threadCaller("orchestrator"), { groupId: group!.id });
      assert.strictEqual(info.members[1]?.from?.threadId, "rate-limit-research-api");
      // A forwarded call has no calling thread here, so it records none.
      const forwarded = yield* service.update(linkCaller, {
        action: "create",
        title: "from a link",
        members: [member(mini, "short-local")],
      });
      assert.isNull(forwarded.group?.members[0]?.from);
    }),
  );

  it.effect("reads only this environment's members for a call that came over a link", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const group = yield* createGroup("forwarded", [
        member(mini, "rate-limit-research-api"),
        member(laptop, "rate-limit-research-web"),
      ]);
      const info = yield* service.info(linkCaller, { groupId: group.id });
      assert.strictEqual(info.members[0]?.thread?.title, "rate-limit-research-api");
      assert.isNull(info.members[1]?.thread);
      assert.include(info.members[1]?.unavailable, "another environment");
    }),
  );

  it.effect("gives up on a member whose machine stops answering", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const group = yield* createGroup("sleepy", [
        member(mini, "rate-limit-research-api"),
        member(asleep, "never-answers"),
      ]);
      const fiber = yield* service
        .info(threadCaller("orchestrator"), { groupId: group.id })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      const info = yield* Fiber.join(fiber);
      assert.strictEqual(info.members[0]?.unavailable, null);
      assert.include(info.members[1]?.unavailable, "No answer");
    }),
  );

  it.effect("finds the calling thread's group when no groupId is given", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const group = yield* createGroup("mine", [member(mini, "rate-limit-research-api")]);
      const info = yield* service.info(threadCaller("rate-limit-research-api"), {});
      assert.strictEqual(info.group.id, group.id);

      // The group's session thread is not a member, but asks about the group.
      yield* (yield* ThreadGroups.ThreadGroupService).setSession({
        groupId: group.id,
        threadId: ThreadId.make("group-session"),
      });
      const fromSession = yield* service.info(threadCaller("group-session"), {});
      assert.strictEqual(fromSession.group.id, group.id);

      const outsider = yield* service.info(threadCaller("not-grouped"), {}).pipe(Effect.flip);
      assert.strictEqual(outsider.code, "invalid_request");
    }),
  );
});
