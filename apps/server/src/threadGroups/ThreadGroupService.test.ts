import { EnvironmentId, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { NodeServices } from "@effect/platform-node";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadGroups from "./ThreadGroupService.ts";

const layer = ThreadGroups.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const here = EnvironmentId.make("env-mini");
const there = EnvironmentId.make("env-laptop");
const member = (environmentId: EnvironmentId, threadId: string) => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});

const create = (title: string, members: ReadonlyArray<ReturnType<typeof member>>) =>
  ThreadGroups.ThreadGroupService.pipe(
    Effect.flatMap((groups) => groups.update({ _tag: "create", title, members })),
    Effect.map(({ group }) => group!),
  );

it.layer(layer)("ThreadGroupService", (it) => {
  it.effect("keeps members from other environments in the order they joined", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const group = yield* create("rate limits", [member(here, "api"), member(there, "web")]);
      const { group: grown } = yield* groups.update({
        _tag: "add-members",
        groupId: group.id,
        members: [member(here, "docs")],
      });
      assert.deepStrictEqual(
        grown?.members.map((entry) => `${entry.environmentId}/${entry.threadId}`),
        ["env-mini/api", "env-laptop/web", "env-mini/docs"],
      );
    }),
  );

  it.effect("moves a thread out of its old group when another group takes it", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const first = yield* create("first", [member(here, "shared"), member(here, "stays")]);
      const second = yield* create("second", [member(here, "shared")]);
      const stored = yield* groups.get(first.id);
      assert.deepStrictEqual(
        stored.members.map((entry) => entry.threadId),
        ["stays"],
      );
      assert.deepStrictEqual(
        second.members.map((entry) => entry.threadId),
        ["shared"],
      );
    }),
  );

  it.effect("renames, removes members, and ungroups without touching other groups", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const kept = yield* create("kept", [member(here, "k")]);
      const group = yield* create("draft", [member(here, "a"), member(there, "b")]);
      yield* groups.update({ _tag: "rename", groupId: group.id, title: "final" });
      const { group: smaller } = yield* groups.update({
        _tag: "remove-members",
        groupId: group.id,
        members: [member(there, "b")],
      });
      assert.strictEqual(smaller?.title, "final");
      assert.deepStrictEqual(
        smaller?.members.map((entry) => entry.threadId),
        ["a"],
      );

      assert.deepStrictEqual(yield* groups.update({ _tag: "delete", groupId: group.id }), {
        group: null,
      });
      const { groups: remaining } = yield* groups.list;
      assert.isTrue(remaining.some((entry) => entry.id === kept.id));
      assert.isFalse(remaining.some((entry) => entry.id === group.id));
      // The ungrouped thread can join a new group.
      const regrouped = yield* create("again", [member(here, "a")]);
      assert.strictEqual(regrouped.members.length, 1);
    }),
  );

  it.effect("refuses changes to a group that does not exist", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const missing = ThreadGroupId.make("missing");
      const error = yield* groups
        .update({ _tag: "add-members", groupId: missing, members: [member(here, "x")] })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadGroupNotFoundError");
      // Nothing was written for the missing group.
      const { groups: all } = yield* groups.list;
      assert.isFalse(all.some((group) => group.members.some((entry) => entry.threadId === "x")));
    }),
  );

  it.effect("puts moved members after existing ones, in the order given", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      yield* create("source", [member(here, "moved"), member(here, "left")]);
      const target = yield* create("target", [member(here, "first")]);
      const { group } = yield* groups.update({
        _tag: "add-members",
        groupId: target.id,
        members: [member(there, "fresh"), member(here, "moved")],
      });
      assert.deepStrictEqual(
        group?.members.map((entry) => entry.threadId),
        ["first", "fresh", "moved"],
      );
    }),
  );

  it.effect("deletes a group once it has no members left", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const emptiedByMove = yield* create("emptied by move", [member(here, "solo")]);
      yield* create("takes it", [member(here, "solo")]);
      const emptiedByRemove = yield* create("emptied by remove", [member(there, "last")]);
      const { group } = yield* groups.update({
        _tag: "remove-members",
        groupId: emptiedByRemove.id,
        members: [member(there, "last")],
      });
      assert.isNull(group);
      const { groups: all } = yield* groups.list;
      const ids = all.map((entry) => entry.id);
      assert.notInclude(ids, emptiedByMove.id);
      assert.notInclude(ids, emptiedByRemove.id);
    }),
  );

  it.effect("forgets a deleted thread, and its group when it was the last member", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const pair = yield* create("pair", [member(here, "gone"), member(here, "kept")]);
      const single = yield* create("single", [member(here, "alone")]);
      yield* groups.forgetThread(member(here, "gone"));
      yield* groups.forgetThread(member(here, "alone"));
      assert.deepStrictEqual(
        (yield* groups.get(pair.id)).members.map((entry) => entry.threadId),
        ["kept"],
      );
      const missing = yield* groups.get(single.id).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "ThreadGroupNotFoundError");
    }),
  );

  it.effect("records who brought members in, but not on that thread itself", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const caller = member(here, "spawner");
      const { group } = yield* groups.update({
        _tag: "create",
        title: "cross-project",
        members: [caller, member(there, "spawned")],
        from: caller,
      });
      assert.deepStrictEqual(
        group?.members.map((entry) => [entry.threadId, entry.from?.threadId ?? null]),
        [
          ["spawner", null],
          ["spawned", "spawner"],
        ],
      );
      // A person adding a thread leaves no origin.
      const { group: grown } = yield* groups.update({
        _tag: "add-members",
        groupId: group!.id,
        members: [member(here, "by-hand")],
      });
      assert.isNull(grown?.members.at(-1)?.from);
    }),
  );

  it.effect("subscribers get the list again after each change", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroups.ThreadGroupService;
      const sizes = yield* Queue.unbounded<number>();
      yield* groups.subscribe.pipe(
        Stream.runForEach((result) => Queue.offer(sizes, result.groups.length)),
        Effect.forkScoped,
      );
      // The snapshot arrives after the subscription is live.
      const before = yield* Queue.take(sizes);
      yield* create("watched", [member(here, "w")]);
      assert.strictEqual(yield* Queue.take(sizes), before + 1);
    }).pipe(Effect.scoped),
  );
});
