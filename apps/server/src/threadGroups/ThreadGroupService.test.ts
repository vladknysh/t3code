import { EnvironmentId, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
      const exit = yield* groups
        .update({ _tag: "add-members", groupId: missing, members: [member(here, "x")] })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(String(exit.cause), "ThreadGroupNotFoundError");
      }
      // Nothing was written for the missing group.
      const { groups: all } = yield* groups.list;
      assert.isFalse(all.some((group) => group.members.some((entry) => entry.threadId === "x")));
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
