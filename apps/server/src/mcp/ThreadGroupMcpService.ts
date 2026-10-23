import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadGroup,
  type ThreadGroupMcpInfoInput,
  type ThreadGroupMcpInfoResult,
  type ThreadGroupMcpListResult,
  type ThreadGroupMcpMemberInfo,
  type ThreadGroupMcpUpdateInput,
  type ThreadGroupMcpUpdateResult,
  type ThreadGroupMember,
  type ThreadGroupNotFoundError,
  type ThreadGroupStorageError,
  type ThreadGroupUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadGroups from "../threadGroups/ThreadGroupService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const MESSAGE_CHARS = 600;
const MESSAGE_PAGE_SIZE = 100;
/**
 * How far back from a member's newest item the latest messages are looked
 * for: a long turn of tool calls can separate the last ask and reply from the end.
 */
const TAIL_WINDOWS = [200, 1_000, 5_000] as const;
const MEMBER_READ_CONCURRENCY = 4;
/** A machine that went to sleep must not hold the whole description. */
const MEMBER_READ_TIMEOUT = "15 seconds";

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Thread groups as agents use them. A group is stored on one environment and
 * its members can be threads on linked ones, so describing a group reads each
 * member where it lives: here directly, elsewhere through the link, with the
 * caller's own access.
 */
export class ThreadGroupMcpService extends Context.Service<
  ThreadGroupMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ThreadGroupMcpListResult, OrchestratorMcpFailure>;
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadGroupMcpUpdateInput,
    ) => Effect.Effect<ThreadGroupMcpUpdateResult, OrchestratorMcpFailure>;
    readonly info: (
      scope: McpInvocationScope,
      input: ThreadGroupMcpInfoInput,
    ) => Effect.Effect<ThreadGroupMcpInfoResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadGroupMcpService") {}

const groupFailure = (error: ThreadGroupNotFoundError | ThreadGroupStorageError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "ThreadGroupNotFoundError" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** The MCP input as a stored change; members default to the group's environment. */
const toChange = (
  scope: McpInvocationScope,
  input: ThreadGroupMcpUpdateInput,
): ThreadGroupUpdateInput => {
  const members: ReadonlyArray<ThreadGroupMember> = (input.members ?? []).map((member) => ({
    environmentId: member.environmentId ?? scope.environmentId,
    threadId: member.threadId,
  }));
  // The input schema guarantees the fields each action needs.
  const groupId = input.groupId!;
  switch (input.action) {
    case "create":
      return { _tag: "create", title: input.title!, members };
    case "rename":
      return { _tag: "rename", groupId, title: input.title! };
    case "add_members":
      return { _tag: "add-members", groupId, members };
    case "remove_members":
      return { _tag: "remove-members", groupId, members };
    case "delete":
      return { _tag: "delete", groupId };
  }
};

/** The latest ask and the latest answer among a member's newest messages. */
const summarizeMessages = (
  items: OrchestratorMcpThreadReadResult["items"],
): Pick<ThreadGroupMcpMemberInfo, "latestRequest" | "latestReply"> => ({
  latestRequest: items.findLast((item) => item.type === "user_message")?.text ?? null,
  latestReply:
    items.findLast((item) => item.type === "assistant_message" && item.text)?.text ?? null,
});

const make = Effect.gen(function* () {
  const groups = yield* ThreadGroups.ThreadGroupService;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  /**
   * Members here are read as an outside reader (no calling thread), so reading
   * a delegated child's result does not acknowledge it for the caller. Members
   * elsewhere are read through the caller's link only when the caller is an
   * agent here: a call that itself came over a link stays on this environment,
   * so a group cannot carry a caller into environments it has no link to.
   */
  const readThread = (
    scope: McpInvocationScope,
    environmentId: EnvironmentId,
    input: OrchestratorMcpThreadReadInput,
  ) =>
    environmentId === scope.environmentId
      ? orchestrator.readThread({ ...scope, thread: undefined }, input)
      : scope.client === undefined
        ? forwarding.call(scope, OrchestratorToolkit.tools.t3_thread_read, environmentId, input)
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "This thread lives on another environment. Ask from an environment linked to it.",
            }),
          );

  /** The newest message items, looking further back until both an ask and a reply turn up. */
  const readTail = Effect.fnUntraced(function* (
    scope: McpInvocationScope,
    member: ThreadGroupMember,
    itemCount: number,
  ) {
    let items: OrchestratorMcpThreadReadResult["items"] = [];
    for (const window of TAIL_WINDOWS) {
      const from = Math.max(-1, itemCount - window - 1);
      items = [];
      let afterPosition = from;
      // Pages forward from the window start; stops once the newest item is in.
      while (true) {
        const page = yield* readThread(scope, member.environmentId, {
          threadId: member.threadId,
          view: "messages",
          limit: MESSAGE_PAGE_SIZE,
          runLimit: 1,
          maxCharsPerItem: MESSAGE_CHARS,
          // -1 means "from the start"; the wire schema only takes positions.
          ...(afterPosition < 0 ? {} : { afterPosition }),
        });
        items = [...items, ...page.items].slice(-MESSAGE_PAGE_SIZE);
        if (!page.hasMore || page.nextPosition === null) break;
        afterPosition = page.nextPosition;
      }
      const found = (type: string) => items.some((item) => item.type === type);
      if (from === -1 || (found("user_message") && found("assistant_message"))) break;
    }
    return items;
  });

  const readMember = Effect.fn("ThreadGroupMcpService.readMember")(
    function* (
      scope: McpInvocationScope,
      member: ThreadGroupMember,
      environmentLabel: string | null,
    ) {
      const head = yield* readThread(scope, member.environmentId, {
        threadId: member.threadId,
        view: "messages",
        limit: 1,
        runLimit: 1,
        maxCharsPerItem: MESSAGE_CHARS,
      });
      const thread = head.thread;
      const tail = yield* readTail(scope, member, thread.itemCount);
      const task = head.items.find((item) => item.type === "user_message")?.text ?? null;
      const latest = summarizeMessages(tail);
      return {
        ...member,
        environmentLabel,
        thread: {
          projectId: thread.projectId,
          title: thread.title,
          status: thread.status,
          settled: thread.settled,
          snoozed: thread.snoozed,
          providerInstanceId: thread.providerInstanceId,
          model: thread.model,
          branch: thread.branch,
          pendingRequestCount: thread.pendingRequestCount,
          updatedAt: thread.updatedAt,
        },
        task,
        latestRequest: latest.latestRequest !== task ? latest.latestRequest : null,
        latestReply: latest.latestReply,
        unavailable: null,
      } satisfies ThreadGroupMcpMemberInfo;
    },
    (effect, _scope, member, environmentLabel) => {
      const unavailable = (reason: string) =>
        Effect.succeed({
          ...member,
          environmentLabel,
          thread: null,
          task: null,
          latestRequest: null,
          latestReply: null,
          unavailable: reason,
        } satisfies ThreadGroupMcpMemberInfo);
      // One unreadable member (deleted, or its machine is asleep) must not hide the others.
      return effect.pipe(
        Effect.timeoutOrElse({
          duration: MEMBER_READ_TIMEOUT,
          orElse: () => unavailable(`No answer within ${MEMBER_READ_TIMEOUT}.`),
        }),
        Effect.catchTags({ OrchestratorMcpFailure: (failure) => unavailable(failure.message) }),
      );
    },
  );

  const environmentLabels = Effect.fn("ThreadGroupMcpService.environmentLabels")(function* (
    scope: McpInvocationScope,
    group: ThreadGroup,
  ) {
    const labels = new Map<string, string>();
    labels.set(scope.environmentId, (yield* environment.getDescriptor).label);
    if (group.members.some((member) => member.environmentId !== scope.environmentId)) {
      const linked = yield* forwarding
        .links(scope)
        .pipe(Effect.orElseSucceed(() => ({ environmentId: scope.environmentId, links: [] })));
      for (const link of linked.links) labels.set(link.environmentId, link.label);
    }
    return labels;
  });

  const callerGroup = Effect.fn("ThreadGroupMcpService.callerGroup")(function* (
    scope: McpInvocationScope,
  ) {
    const threadId = scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Pass groupId: this caller is not a T3 thread.",
      });
    }
    const { groups: all } = yield* groups.list.pipe(Effect.mapError(groupFailure));
    const group = all.find((candidate) =>
      candidate.members.some(
        (member) => member.environmentId === scope.environmentId && member.threadId === threadId,
      ),
    );
    if (group === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "This thread is not in a group here. Pass groupId; t3_group_list lists the groups.",
      });
    }
    return group;
  });

  const list: ThreadGroupMcpService["Service"]["list"] = Effect.fn("ThreadGroupMcpService.list")(
    function* (scope) {
      const { groups: all } = yield* groups.list.pipe(Effect.mapError(groupFailure));
      return { environmentId: scope.environmentId, groups: all };
    },
  );

  const update: ThreadGroupMcpService["Service"]["update"] = Effect.fn(
    "ThreadGroupMcpService.update",
  )(function* (scope, input) {
    return yield* groups.update(toChange(scope, input)).pipe(Effect.mapError(groupFailure));
  });

  const info: ThreadGroupMcpService["Service"]["info"] = Effect.fn("ThreadGroupMcpService.info")(
    function* (scope, input) {
      const group =
        input.groupId === undefined
          ? yield* callerGroup(scope)
          : yield* groups.get(input.groupId).pipe(Effect.mapError(groupFailure));
      const labels = yield* environmentLabels(scope, group);
      const members = yield* Effect.forEach(
        group.members,
        (member) => readMember(scope, member, labels.get(member.environmentId) ?? null),
        { concurrency: MEMBER_READ_CONCURRENCY },
      );
      const readable = members.flatMap((member) => (member.thread === null ? [] : [member.thread]));
      return {
        environmentId: scope.environmentId,
        group: {
          id: group.id,
          title: group.title,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        },
        status: readable.some((thread) => ACTIVE_STATUSES.has(thread.status)) ? "working" : "idle",
        settled: readable.length > 0 && readable.every((thread) => thread.settled),
        members,
      } satisfies ThreadGroupMcpInfoResult;
    },
  );

  return ThreadGroupMcpService.of({ list, update, info });
});

export const layer = Layer.effect(ThreadGroupMcpService, make);
