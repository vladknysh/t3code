import {
  EnvironmentId,
  IsoDateTime,
  type ThreadGroup,
  ThreadGroupId,
  type ThreadGroupListResult,
  type ThreadGroupMember,
  ThreadGroupNotFoundError,
  ThreadGroupStorageError,
  type ThreadGroupUpdateInput,
  type ThreadGroupUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

type StorageOperation = ThreadGroupStorageError["operation"];

/**
 * Thread groups stored on this environment. A group only records its title
 * and members; members may be threads on other environments, so nothing here
 * reads thread state. Clients and agents roll status up from the members.
 */
export class ThreadGroupService extends Context.Service<
  ThreadGroupService,
  {
    readonly list: Effect.Effect<ThreadGroupListResult, ThreadGroupStorageError>;
    /** The current groups, then the whole list again after every change. */
    readonly subscribe: Stream.Stream<ThreadGroupListResult, ThreadGroupStorageError>;
    readonly get: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<ThreadGroup, ThreadGroupNotFoundError | ThreadGroupStorageError>;
    /**
     * Applies one change. A thread belongs to at most one group here, so
     * adding a member that is in another group moves it. A group left without
     * members is deleted. Deleting ungroups: the member threads stay as they are.
     */
    readonly update: (
      input: ThreadGroupUpdateInput,
    ) => Effect.Effect<ThreadGroupUpdateResult, ThreadGroupNotFoundError | ThreadGroupStorageError>;
    /** Drops a thread that no longer exists from whichever group holds it. */
    readonly forgetThread: (
      member: ThreadGroupMember,
    ) => Effect.Effect<void, ThreadGroupStorageError>;
  }
>()("t3/threadGroups/ThreadGroupService") {}

interface MembersChange {
  readonly groupId: ThreadGroupId;
  readonly members: ReadonlyArray<ThreadGroupMember>;
}

interface GroupRow {
  readonly group_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly group_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<void>(1);

  const storage = (operation: StorageOperation) =>
    Effect.mapError((cause: unknown) => new ThreadGroupStorageError({ operation, cause }));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toGroups = (
    groups: ReadonlyArray<GroupRow>,
    members: ReadonlyArray<MemberRow>,
  ): ReadonlyArray<ThreadGroup> =>
    groups.map((row) => ({
      id: ThreadGroupId.make(row.group_id),
      title: row.title,
      createdAt: IsoDateTime.make(row.created_at),
      updatedAt: IsoDateTime.make(row.updated_at),
      members: members
        .filter((member) => member.group_id === row.group_id)
        .map((member) => ({
          environmentId: EnvironmentId.make(member.environment_id),
          threadId: ThreadId.make(member.thread_id),
        })),
    }));

  // Each list is read in one transaction, so a change committing between the
  // two queries cannot pair a group with another moment's members.
  const readAll = sql.withTransaction(
    Effect.gen(function* () {
      const groups = yield* sql<GroupRow>`
        SELECT group_id, title, created_at, updated_at FROM thread_groups
        ORDER BY created_at, group_id
      `;
      const members = yield* sql<MemberRow>`
        SELECT group_id, environment_id, thread_id FROM thread_group_members
        ORDER BY added_at, rowid
      `;
      return toGroups(groups, members);
    }),
  );

  // Helpers below run inside an operation's own span, so they add none.
  const readOne = Effect.fnUntraced(function* (groupId: ThreadGroupId) {
    const groups = yield* sql<GroupRow>`
      SELECT group_id, title, created_at, updated_at FROM thread_groups
      WHERE group_id = ${groupId}
    `;
    const members = yield* sql<MemberRow>`
      SELECT group_id, environment_id, thread_id FROM thread_group_members
      WHERE group_id = ${groupId}
      ORDER BY added_at, rowid
    `;
    return toGroups(groups, members)[0];
  });

  const groupExists = (groupId: ThreadGroupId) =>
    sql<{ readonly group_id: string }>`
      SELECT group_id FROM thread_groups WHERE group_id = ${groupId}
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** Takes the thread out of any other group, which then counts as changed. */
  const leaveOtherGroups = Effect.fnUntraced(function* (
    member: ThreadGroupMember,
    groupId: ThreadGroupId | null,
    at: string,
  ) {
    yield* sql`
      UPDATE thread_groups SET updated_at = ${at}
      WHERE group_id IN (
        SELECT group_id FROM thread_group_members
        WHERE environment_id = ${member.environmentId} AND thread_id = ${member.threadId}
      ) AND group_id IS NOT ${groupId}
    `;
    yield* sql`
      DELETE FROM thread_group_members
      WHERE environment_id = ${member.environmentId} AND thread_id = ${member.threadId}
        AND group_id IS NOT ${groupId}
    `;
  });

  // A moved member is deleted and inserted again rather than updated, so its
  // new rowid puts it after the members already there, in the order given.
  const addMembers = Effect.fnUntraced(function* (
    groupId: ThreadGroupId,
    members: ReadonlyArray<ThreadGroupMember>,
    at: string,
  ) {
    for (const member of members) {
      yield* leaveOtherGroups(member, groupId, at);
      yield* sql`
        INSERT INTO thread_group_members (group_id, environment_id, thread_id, added_at)
        VALUES (${groupId}, ${member.environmentId}, ${member.threadId}, ${at})
        ON CONFLICT (environment_id, thread_id) DO NOTHING
      `;
    }
  });

  const dropEmptyGroups = sql`
    DELETE FROM thread_groups
    WHERE NOT EXISTS (
      SELECT 1 FROM thread_group_members WHERE group_id = thread_groups.group_id
    )
  `;

  /**
   * Runs `change` on an existing group in one transaction, tells subscribers,
   * and returns the group as stored, or null when the change emptied it.
   */
  const mutate = Effect.fnUntraced(function* <R>(
    operation: StorageOperation,
    groupId: ThreadGroupId,
    change: (at: string) => Effect.Effect<unknown, SqlError.SqlError, R>,
  ) {
    const at = yield* now;
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* groupExists(groupId))) return { found: false as const };
          yield* change(at);
          yield* sql`UPDATE thread_groups SET updated_at = ${at} WHERE group_id = ${groupId}`;
          yield* dropEmptyGroups;
          return { found: true as const, group: (yield* readOne(groupId)) ?? null };
        }),
      )
      .pipe(storage(operation));
    if (!outcome.found) return yield* new ThreadGroupNotFoundError({ groupId });
    yield* PubSub.publish(changes, undefined);
    return outcome.group;
  });

  const list: ThreadGroupService["Service"]["list"] = readAll.pipe(
    Effect.map((groups) => ({ groups })),
    storage("list"),
    Effect.withSpan("ThreadGroupService.list"),
  );

  const subscribe: ThreadGroupService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first read so a change between the two is not lost.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  const get: ThreadGroupService["Service"]["get"] = Effect.fn("ThreadGroupService.get")(
    function* (groupId) {
      const group = yield* readOne(groupId).pipe(storage("get"));
      if (group === undefined) return yield* new ThreadGroupNotFoundError({ groupId });
      return group;
    },
  );

  const create = Effect.fn("ThreadGroupService.create")(function* (input: {
    readonly title: string;
    readonly members: ReadonlyArray<ThreadGroupMember>;
  }) {
    const groupId = ThreadGroupId.make(yield* crypto.randomUUIDv4().pipe(storage("create")));
    const at = yield* now;
    const group = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO thread_groups (group_id, title, created_at, updated_at)
            VALUES (${groupId}, ${input.title}, ${at}, ${at})
          `;
          yield* addMembers(groupId, input.members, at);
          yield* dropEmptyGroups;
          return (yield* readOne(groupId)) ?? null;
        }),
      )
      .pipe(storage("create"));
    yield* PubSub.publish(changes, undefined);
    return group;
  });

  const rename = Effect.fn("ThreadGroupService.rename")(function* (input: {
    readonly groupId: ThreadGroupId;
    readonly title: string;
  }) {
    return yield* mutate(
      "rename",
      input.groupId,
      () => sql`UPDATE thread_groups SET title = ${input.title} WHERE group_id = ${input.groupId}`,
    );
  });

  const add = Effect.fn("ThreadGroupService.addMembers")(function* (input: MembersChange) {
    return yield* mutate("add-members", input.groupId, (at) =>
      addMembers(input.groupId, input.members, at),
    );
  });

  const remove = Effect.fn("ThreadGroupService.removeMembers")(function* (input: MembersChange) {
    return yield* mutate("remove-members", input.groupId, () =>
      Effect.forEach(
        input.members,
        (member) => sql`
          DELETE FROM thread_group_members
          WHERE group_id = ${input.groupId}
            AND environment_id = ${member.environmentId}
            AND thread_id = ${member.threadId}
        `,
        { discard: true },
      ),
    );
  });

  const deleteGroup = Effect.fn("ThreadGroupService.delete")(function* (groupId: ThreadGroupId) {
    const deleted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* groupExists(groupId))) return false;
          yield* sql`DELETE FROM thread_group_members WHERE group_id = ${groupId}`;
          yield* sql`DELETE FROM thread_groups WHERE group_id = ${groupId}`;
          return true;
        }),
      )
      .pipe(storage("delete"));
    if (deleted) yield* PubSub.publish(changes, undefined);
  });

  const update: ThreadGroupService["Service"]["update"] = (input) => {
    switch (input._tag) {
      case "create":
        return create(input).pipe(Effect.map((group) => ({ group })));
      case "rename":
        return rename(input).pipe(Effect.map((group) => ({ group })));
      case "add-members":
        return add(input).pipe(Effect.map((group) => ({ group })));
      case "remove-members":
        return remove(input).pipe(Effect.map((group) => ({ group })));
      case "delete":
        return deleteGroup(input.groupId).pipe(Effect.as({ group: null }));
    }
  };

  const forgetThread: ThreadGroupService["Service"]["forgetThread"] = Effect.fn(
    "ThreadGroupService.forgetThread",
  )(function* (member) {
    const at = yield* now;
    const removed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const held = yield* sql<{ readonly group_id: string }>`
            SELECT group_id FROM thread_group_members
            WHERE environment_id = ${member.environmentId} AND thread_id = ${member.threadId}
          `;
          if (held.length === 0) return false;
          yield* leaveOtherGroups(member, null, at);
          yield* dropEmptyGroups;
          return true;
        }),
      )
      .pipe(storage("forget-thread"));
    if (removed) yield* PubSub.publish(changes, undefined);
  });

  return ThreadGroupService.of({ list, subscribe, get, update, forgetThread });
});

export const layer = Layer.effect(ThreadGroupService, make);

/**
 * Drops threads deleted here from their groups. Threads on other environments
 * cannot be watched from here; clients and agents skip members they cannot
 * find, and removing one cleans it up.
 */
export const layerForgetDeletedThreads = Layer.effectDiscard(
  Effect.gen(function* () {
    const groups = yield* ThreadGroupService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    yield* engine.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "thread.deleted"),
      Stream.runForEach((event) =>
        groups
          .forgetThread({ environmentId, threadId: event.threadId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not drop a deleted thread from its group", cause),
            ),
          ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Thread group deletion watch stopped", cause)),
      Effect.forkScoped,
    );
  }),
);
