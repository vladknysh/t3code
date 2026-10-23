import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpThreadStatus,
} from "./orchestratorMcp.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ThreadGroup, ThreadGroupId, ThreadGroupMember, ThreadGroupTitle } from "./threadGroup.ts";

export const ThreadGroupMcpListInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
});
export type ThreadGroupMcpListInput = typeof ThreadGroupMcpListInput.Type;

export const ThreadGroupMcpListResult = Schema.Struct({
  environmentId: EnvironmentId,
  groups: Schema.Array(ThreadGroup),
});
export type ThreadGroupMcpListResult = typeof ThreadGroupMcpListResult.Type;

const ThreadGroupMcpMember = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId).annotate({
    description:
      "Environment the thread lives on, from t3_environment_links. Omit for the environment that stores the group.",
  }),
  threadId: ThreadId,
});

export const ThreadGroupMcpUpdateAction = Schema.Literals([
  "create",
  "rename",
  "add_members",
  "remove_members",
  "delete",
]);
export type ThreadGroupMcpUpdateAction = typeof ThreadGroupMcpUpdateAction.Type;

export const ThreadGroupMcpUpdateInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: ThreadGroupMcpUpdateAction,
  groupId: Schema.optional(ThreadGroupId).annotate({
    description: "Group to change. Required for every action except create.",
  }),
  title: Schema.optional(ThreadGroupTitle).annotate({
    description: "Group name. Required for create and rename.",
  }),
  members: Schema.optional(Schema.Array(ThreadGroupMcpMember)).annotate({
    description:
      "Threads to add or remove. Used by create, add_members and remove_members. A thread joins at most one group per environment: adding it moves it out of its last group.",
  }),
}).check(
  Schema.makeFilter((input) => {
    switch (input.action) {
      case "create":
        return input.title !== undefined && input.groupId === undefined
          ? true
          : "create requires title and does not accept groupId.";
      case "rename":
        return input.groupId !== undefined && input.title !== undefined
          ? true
          : "rename requires groupId and title.";
      case "add_members":
      case "remove_members":
        return input.groupId !== undefined && (input.members?.length ?? 0) > 0
          ? true
          : `${input.action} requires groupId and at least one member.`;
      case "delete":
        return input.groupId !== undefined ? true : "delete requires groupId.";
    }
  }),
);
export type ThreadGroupMcpUpdateInput = typeof ThreadGroupMcpUpdateInput.Type;

export const ThreadGroupMcpUpdateResult = Schema.Struct({ group: Schema.NullOr(ThreadGroup) });
export type ThreadGroupMcpUpdateResult = typeof ThreadGroupMcpUpdateResult.Type;

export const ThreadGroupMcpInfoInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  groupId: Schema.optional(ThreadGroupId).annotate({
    description:
      "Group to describe. Omit for the group the calling thread belongs to or is the session of, among the groups stored on this environment.",
  }),
});
export type ThreadGroupMcpInfoInput = typeof ThreadGroupMcpInfoInput.Type;

/** A member as its own environment reports it, or why that could not be read. */
export const ThreadGroupMcpMemberInfo = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  /** The agent thread that brought this member in, such as one that launched it. */
  from: Schema.NullOr(ThreadGroupMember),
  /** Null when the member could not be read; `unavailable` says why. */
  thread: Schema.NullOr(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      status: OrchestratorMcpThreadStatus,
      settled: Schema.Boolean,
      snoozed: Schema.Boolean,
      providerInstanceId: ProviderInstanceId,
      model: Schema.String,
      branch: Schema.NullOr(Schema.String),
      pendingRequestCount: Schema.Number,
      updatedAt: IsoDateTime,
    }),
  ),
  /** The first user message: what the thread was started to do. */
  task: Schema.NullOr(Schema.String),
  /** The latest user message, when it differs from the task. */
  latestRequest: Schema.NullOr(Schema.String),
  /** The latest assistant message: where the work stands. */
  latestReply: Schema.NullOr(Schema.String),
  unavailable: Schema.NullOr(Schema.String),
});
export type ThreadGroupMcpMemberInfo = typeof ThreadGroupMcpMemberInfo.Type;

export const ThreadGroupMcpInfoResult = Schema.Struct({
  environmentId: EnvironmentId,
  group: Schema.Struct({
    id: ThreadGroupId,
    title: Schema.String,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
  /** Working if any member is running, else idle. */
  status: Schema.Literals(["working", "idle"]),
  /** True when every readable member is settled. */
  settled: Schema.Boolean,
  members: Schema.Array(ThreadGroupMcpMemberInfo),
});
export type ThreadGroupMcpInfoResult = typeof ThreadGroupMcpInfoResult.Type;
