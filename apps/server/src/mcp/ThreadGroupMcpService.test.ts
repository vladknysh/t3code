import {
  EnvironmentId,
  IsoDateTime,
  OrchestratorMcpFailure,
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
import * as Layer from "effect/Layer";

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
const asleep = EnvironmentId.make("env-asleep");
const at = IsoDateTime.make("2026-10-23T10:00:00.000Z");

const scopeFor = (threadId: string): McpInvocationScope => ({
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

const message = (position: number, type: "user_message" | "assistant_message", text: string) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: ThreadId.make("unused"),
  itemId: TurnItemId.make(`item-${position}`),
  runId: null,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type,
  status: "completed" as const,
  title: null,
  text,
  textTruncated: false,
  updatedAt: at,
});

const readResult = (input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: OrchestratorMcpThreadStatus;
  readonly settled?: boolean;
  readonly items: OrchestratorMcpThreadReadResult["items"];
}): OrchestratorMcpThreadReadResult => ({
  thread: {
    threadId: input.threadId,
    projectId: ProjectId.make("acme-api"),
    title: input.title,
    createdBy: "user",
    creationSource: "web",
    status: input.status,
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
    itemCount: input.items.length,
    pendingRequestCount: 0,
    archived: false,
    settled: input.settled ?? false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: at,
    updatedAt: at,
  },
  recentRuns: [],
  items: input.items,
  nextPosition: null,
  hasMore: false,
});

/** Threads each environment would answer with; the asleep one never answers. */
const threadsByEnvironment = new Map<string, OrchestratorMcpThreadReadResult>([
  [
    `${mini}/rate-limit-research-api`,
    readResult({
      threadId: ThreadId.make("rate-limit-research-api"),
      title: "rate-limit-research-api",
      status: "running",
      items: [
        message(0, "user_message", "Research rate limiting for the API gateway"),
        message(1, "assistant_message", "Comparing token bucket and sliding window."),
      ],
    }),
  ],
  [
    `${laptop}/rate-limit-research-web`,
    readResult({
      threadId: ThreadId.make("rate-limit-research-web"),
      title: "rate-limit-research-web",
      status: "idle",
      settled: true,
      items: [
        message(0, "user_message", "Research client-side retry with backoff"),
        message(1, "assistant_message", "Drafted a retry helper."),
        message(2, "user_message", "Add jitter too"),
        message(3, "assistant_message", "Added full jitter."),
      ],
    }),
  ],
]);

const answer = (environmentId: EnvironmentId, threadId: ThreadId) => {
  const result = threadsByEnvironment.get(`${environmentId}/${threadId}`);
  return result === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${environmentId} did not answer.`,
        }),
      )
    : Effect.succeed(result);
};

// Only threads here are read directly; the others can only arrive through a link.
const layer = ThreadGroupMcpService.layer.pipe(
  Layer.provideMerge(ThreadGroups.layer),
  Layer.provide(
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      readThread: (_scope, input) => answer(mini, input.threadId),
    }),
  ),
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId, params) =>
        tool.name === "t3_thread_read"
          ? // The service only forwards t3_thread_read, whose success is a read result.
            (answer(environmentId, (params as { readonly threadId: ThreadId }).threadId) as never)
          : Effect.die(`unexpected forward of ${tool.name}`),
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

it.layer(layer)("ThreadGroupMcpService", (it) => {
  it.effect("reads each member where it lives and rolls the group up", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const scope = scopeFor("orchestrator");
      const { group } = yield* service.update(scope, {
        action: "create",
        title: "rate limits",
        members: [
          { threadId: ThreadId.make("rate-limit-research-api") },
          member(laptop, "rate-limit-research-web"),
          member(asleep, "offline-thread"),
        ],
      });
      // A member without an environment is a thread where the group is stored.
      assert.strictEqual(group?.members[0]?.environmentId, mini);

      const info = yield* service.info(scope, { groupId: group!.id });
      assert.strictEqual(info.status, "working");
      assert.isFalse(info.settled);
      const [api, web, offline] = info.members;
      assert.deepInclude(api, {
        environmentLabel: "Mac mini",
        task: "Research rate limiting for the API gateway",
        latestRequest: null,
        latestReply: "Comparing token bucket and sliding window.",
        unavailable: null,
      });
      assert.strictEqual(api?.thread?.status, "running");
      assert.deepInclude(web, {
        environmentLabel: "MacBook Pro",
        task: "Research client-side retry with backoff",
        latestRequest: "Add jitter too",
        latestReply: "Added full jitter.",
      });
      assert.isTrue(web?.thread?.settled);
      // An unreachable member is reported, not fatal.
      assert.deepInclude(offline, {
        environmentLabel: null,
        thread: null,
        unavailable: "env-asleep did not answer.",
      });
    }),
  );

  it.effect("finds the calling thread's group when no groupId is given", () =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupMcpService.ThreadGroupMcpService;
      const { group } = yield* service.update(scopeFor("orchestrator"), {
        action: "create",
        title: "mine",
        members: [{ threadId: ThreadId.make("rate-limit-research-api") }],
      });
      const info = yield* service.info(scopeFor("rate-limit-research-api"), {});
      assert.strictEqual(info.group.id, group?.id);

      const outsider = yield* service.info(scopeFor("not-grouped"), {}).pipe(Effect.flip);
      assert.strictEqual(outsider.code, "invalid_request");
    }),
  );
});
