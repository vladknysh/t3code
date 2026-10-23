import type { EnvironmentId, ProjectId, ThreadGroup, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { EnvironmentThreadGroup } from "../state/threadGroups";

/** Where a group row sits: with working threads while any member works. */
export type SidebarThreadGroupSection = "active" | "working" | "settled";

export interface SidebarThreadGroupView<T> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly group: ThreadGroup;
  /** Members this client can show, in the group's order. */
  readonly members: readonly T[];
  readonly section: SidebarThreadGroupSection;
  readonly working: boolean;
}

/**
 * Matches groups to the thread shells this client knows and rolls each one up:
 * working if any member works, settled once every shown member that can be
 * settled (its environment supports it) is, active otherwise. Members on an environment that is not connected, or
 * outside the project filter, are left out, and a group with none left is
 * hidden. A thread grouped on two environments shows under the first group.
 */
export function resolveSidebarThreadGroups<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly groups: readonly EnvironmentThreadGroup[];
  readonly threads: readonly T[];
  readonly isWorking: (thread: T) => boolean;
  readonly isSettled: (thread: T) => boolean;
  readonly canSettle: (thread: T) => boolean;
  readonly workingShelfEnabled: boolean;
}): {
  readonly views: readonly SidebarThreadGroupView<T>[];
  readonly groupKeyByThreadKey: ReadonlyMap<string, string>;
} {
  const threadByKey = new Map(
    input.threads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const groupKeyByThreadKey = new Map<string, string>();
  const views: SidebarThreadGroupView<T>[] = [];
  for (const entry of input.groups) {
    const members: T[] = [];
    for (const member of entry.group.members) {
      const threadKey = scopedThreadKey(scopeThreadRef(member.environmentId, member.threadId));
      const thread = threadByKey.get(threadKey);
      if (thread === undefined || groupKeyByThreadKey.has(threadKey)) continue;
      groupKeyByThreadKey.set(threadKey, entry.key);
      members.push(thread);
    }
    if (members.length === 0) continue;
    const working = members.some(input.isWorking);
    const section: SidebarThreadGroupSection =
      working && input.workingShelfEnabled
        ? "working"
        : !working && settledAll(members.filter(input.canSettle), input.isSettled)
          ? "settled"
          : "active";
    views.push({
      key: entry.key,
      environmentId: entry.environmentId,
      group: entry.group,
      members,
      section,
      working,
    });
  }
  return { views, groupKeyByThreadKey };
}

const settledAll = <T>(members: readonly T[], isSettled: (thread: T) => boolean) =>
  members.length > 0 && members.every(isSettled);

const TITLE_SEPARATORS = /[\s\-_/:.·]+$/;

/**
 * A name for a new group from its threads' titles: their shared start when
 * there is a meaningful one ("rate-limit-research-api" and
 * "rate-limit-research-web" make "rate-limit-research"), else the first title.
 */
export function defaultThreadGroupTitle(titles: readonly string[]): string {
  const [first, ...rest] = titles.map((title) => title.trim()).filter(Boolean);
  if (first === undefined) return "New group";
  let prefix = first;
  for (const title of rest) {
    let length = 0;
    while (length < prefix.length && length < title.length && prefix[length] === title[length]) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
  }
  const shared = prefix.replace(TITLE_SEPARATORS, "");
  const title = rest.length > 0 && shared.length >= 3 ? shared : first;
  return title.length > 64 ? `${title.slice(0, 63)}…` : title;
}

/** How a group lays out its members: C1 lanes or C3 folder tabs. */
export type SidebarThreadGroupLayout = "lanes" | "folder";

/** A group's colour, one of the tones index.css defines, steady for its id. */
export function threadGroupTone(groupId: string): number {
  let hash = 0;
  for (const char of groupId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % THREAD_GROUP_TONES;
}
const THREAD_GROUP_TONES = 5;

/** environmentId:projectId, the key the sidebar's project maps use. */
export type SidebarProjectKey = `${EnvironmentId}:${ProjectId}`;

export interface SidebarThreadGroupLane<T> {
  /** One lane per repo on one machine. */
  readonly key: SidebarProjectKey;
  readonly members: readonly T[];
}

/**
 * Members by project, lanes in the order their first member appears. Two
 * checkouts of one repo on two machines are two lanes: they are separate work.
 */
export function threadGroupLanes<
  T extends { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
>(members: readonly T[]): readonly SidebarThreadGroupLane<T>[] {
  const lanes = new Map<SidebarProjectKey, T[]>();
  for (const member of members) {
    const key: SidebarProjectKey = `${member.environmentId}:${member.projectId}`;
    const lane = lanes.get(key);
    if (lane) lane.push(member);
    else lanes.set(key, [member]);
  }
  return [...lanes].map(([key, laneMembers]) => ({ key, members: laneMembers }));
}
