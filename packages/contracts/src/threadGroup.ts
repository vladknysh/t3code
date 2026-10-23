import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadGroupId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadGroupId"));
export type ThreadGroupId = typeof ThreadGroupId.Type;

export const ThreadGroupTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
  description: "Short display name for the group.",
});

/**
 * A thread in a group. The group is stored on one environment, but its
 * members can be threads on any environment, so each one names its own.
 */
export const ThreadGroupMember = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ThreadGroupMember = typeof ThreadGroupMember.Type;

/**
 * Threads gathered under one name, like a browser tab group. Only the
 * membership is stored: status, settlement and icons come from the member
 * threads themselves, wherever they live. A group always has members: one
 * that loses its last member is deleted.
 */
export const ThreadGroup = Schema.Struct({
  id: ThreadGroupId,
  title: ThreadGroupTitle,
  members: Schema.Array(ThreadGroupMember),
  /**
   * The thread for talking about the whole group, on the group's own
   * environment. Null until someone opens it; absent from older servers.
   */
  sessionThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadGroup = typeof ThreadGroup.Type;

export const ThreadGroupListResult = Schema.Struct({ groups: Schema.Array(ThreadGroup) });
export type ThreadGroupListResult = typeof ThreadGroupListResult.Type;

export const ThreadGroupCreateInput = Schema.Struct({
  title: ThreadGroupTitle,
  members: Schema.Array(ThreadGroupMember).check(Schema.isMinLength(1)),
});
export type ThreadGroupCreateInput = typeof ThreadGroupCreateInput.Type;

/** One change to the groups stored on an environment. */
export const ThreadGroupUpdateInput = Schema.Union([
  Schema.TaggedStruct("create", ThreadGroupCreateInput.fields),
  Schema.TaggedStruct("rename", { groupId: ThreadGroupId, title: ThreadGroupTitle }),
  Schema.TaggedStruct("add-members", {
    groupId: ThreadGroupId,
    members: Schema.Array(ThreadGroupMember),
  }),
  Schema.TaggedStruct("remove-members", {
    groupId: ThreadGroupId,
    members: Schema.Array(ThreadGroupMember),
  }),
  Schema.TaggedStruct("delete", { groupId: ThreadGroupId }),
]);
export type ThreadGroupUpdateInput = typeof ThreadGroupUpdateInput.Type;

/**
 * The group as stored after the change, or null once it is gone: deleted, or
 * emptied by removing its last member. Deleting a missing group succeeds.
 */
export const ThreadGroupUpdateResult = Schema.Struct({ group: Schema.NullOr(ThreadGroup) });
export type ThreadGroupUpdateResult = typeof ThreadGroupUpdateResult.Type;

export class ThreadGroupNotFoundError extends Schema.TaggedError<ThreadGroupNotFoundError>()(
  "ThreadGroupNotFoundError",
  { groupId: ThreadGroupId },
) {
  override get message(): string {
    return `Thread group ${this.groupId} was not found.`;
  }
}

export class ThreadGroupStorageError extends Schema.TaggedError<ThreadGroupStorageError>()(
  "ThreadGroupStorageError",
  {
    operation: Schema.Literals([
      "list",
      "get",
      "create",
      "rename",
      "add-members",
      "remove-members",
      "delete",
      "forget-thread",
      "set-session",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread groups could not be saved or read (${this.operation}).`;
  }
}

export const ThreadGroupOpenSessionInput = Schema.Struct({ groupId: ThreadGroupId });
export type ThreadGroupOpenSessionInput = typeof ThreadGroupOpenSessionInput.Type;

export const ThreadGroupOpenSessionResult = Schema.Struct({ threadId: ThreadId });
export type ThreadGroupOpenSessionResult = typeof ThreadGroupOpenSessionResult.Type;

/** Why a group session thread could not be started. */
export class ThreadGroupSessionError extends Schema.TaggedError<ThreadGroupSessionError>()(
  "ThreadGroupSessionError",
  {
    groupId: ThreadGroupId,
    reason: Schema.Literals(["no-model", "no-scratch-project", "provider-disabled", "launch"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-model":
        return "No model to start the group session with: no member thread here, and no default model in settings.";
      case "no-scratch-project":
        return "This environment has no scratch folder and no member thread for the group session.";
      case "provider-disabled":
        return "The group session's provider is turned off here. Turn it on, or pick a default model in settings.";
      case "launch":
        return "The group session thread could not be started.";
    }
  }
}

export const ThreadGroupError = Schema.Union([
  ThreadGroupNotFoundError,
  ThreadGroupStorageError,
  ThreadGroupSessionError,
]);
export type ThreadGroupError = typeof ThreadGroupError.Type;
