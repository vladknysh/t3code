import { EnvironmentId, IsoDateTime, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultThreadGroupTitle, resolveSidebarThreadGroups } from "./Sidebar.groups";

const mini = EnvironmentId.make("env-mini");
const laptop = EnvironmentId.make("env-laptop");
const at = IsoDateTime.make("2026-10-23T10:00:00.000Z");

interface Thread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly working?: boolean;
  readonly settled?: boolean;
  readonly cannotSettle?: boolean;
}

const thread = (environmentId: EnvironmentId, id: string, state: Partial<Thread> = {}): Thread => ({
  environmentId,
  id: ThreadId.make(id),
  ...state,
});

const group = (key: string, members: ReadonlyArray<Thread>, environmentId = mini) => ({
  key,
  environmentId,
  group: {
    id: ThreadGroupId.make(key),
    title: key,
    members: members.map((member) => ({
      environmentId: member.environmentId,
      threadId: member.id,
    })),
    createdAt: at,
    updatedAt: at,
  },
});

const resolve = (
  groups: ReturnType<typeof group>[],
  threads: Thread[],
  options: { workingShelfEnabled?: boolean } = {},
) =>
  resolveSidebarThreadGroups({
    groups,
    threads,
    isWorking: (candidate) => candidate.working === true,
    isSettled: (candidate) => candidate.settled === true,
    canSettle: (candidate) => candidate.cannotSettle !== true,
    workingShelfEnabled: options.workingShelfEnabled ?? true,
  });

describe("resolveSidebarThreadGroups", () => {
  it("sits with working threads while any member, on any environment, works", () => {
    const api = thread(mini, "api", { settled: true });
    const web = thread(laptop, "web", { working: true });
    const { views, groupKeyByThreadKey } = resolve([group("research", [api, web])], [api, web]);
    expect(views.map((view) => [view.section, view.members.map((member) => member.id)])).toEqual([
      ["working", ["api", "web"]],
    ]);
    expect([...groupKeyByThreadKey.values()]).toEqual(["research", "research"]);

    const inbox = resolve([group("research", [api, web])], [api, web], {
      workingShelfEnabled: false,
    });
    expect(inbox.views[0]?.section).toBe("active");
    expect(inbox.views[0]?.working).toBe(true);
  });

  it("settles only when every shown member is settled", () => {
    const api = thread(mini, "api", { settled: true });
    const web = thread(laptop, "web");
    expect(resolve([group("g", [api, web])], [api, web]).views[0]?.section).toBe("active");
    const settledWeb = { ...web, settled: true };
    expect(resolve([group("g", [api, settledWeb])], [api, settledWeb]).views[0]?.section).toBe(
      "settled",
    );
  });

  it("ignores members whose environment cannot settle, unless no member can", () => {
    const api = thread(mini, "api", { settled: true });
    const old = thread(laptop, "old-server", { cannotSettle: true });
    expect(resolve([group("g", [api, old])], [api, old]).views[0]?.section).toBe("settled");
    expect(resolve([group("g", [old])], [old]).views[0]?.section).toBe("active");
  });

  it("leaves out members it cannot show and hides groups left empty", () => {
    const api = thread(mini, "api");
    const offline = thread(laptop, "offline");
    const { views } = resolve([group("partial", [api, offline]), group("gone", [offline])], [api]);
    expect(views.map((view) => [view.key, view.members.length])).toEqual([["partial", 1]]);
  });

  it("shows a thread grouped on two environments under the first group only", () => {
    const api = thread(mini, "api");
    const { views } = resolve([group("first", [api]), group("second", [api], laptop)], [api]);
    expect(views.map((view) => view.key)).toEqual(["first"]);
  });
});

describe("defaultThreadGroupTitle", () => {
  it("uses the titles' shared start without trailing separators", () => {
    expect(defaultThreadGroupTitle(["rate-limit-research-api", "rate-limit-research-web"])).toBe(
      "rate-limit-research",
    );
  });

  it("falls back to the first title when the shared start is too short", () => {
    expect(defaultThreadGroupTitle(["Fix login", "Add billing"])).toBe("Fix login");
    expect(defaultThreadGroupTitle([])).toBe("New group");
  });
});
