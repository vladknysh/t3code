import type { EnvironmentId, ThreadGroup } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";

import { useServerConfigs } from "./entities";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";

/** A group as the sidebar sees it: where it is stored, and the group. */
export interface EnvironmentThreadGroup {
  /** Unique across environments: two environments can mint the same group id. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly group: ThreadGroup;
}

const threadGroupsListAtom = environmentAtomList("web-thread-groups", (environmentId) =>
  serverEnvironment.threadGroupsLive({ environmentId, input: {} }),
);

const threadGroupKey = (environmentId: EnvironmentId, groupId: string) =>
  `${environmentId}:group:${groupId}`;

/**
 * Groups stored on every connected environment that supports them. Members
 * can point at any environment; the sidebar matches them to thread shells.
 */
export function useThreadGroups(): readonly EnvironmentThreadGroup[] {
  const serverConfigs = useServerConfigs();
  const environmentIds = [...serverConfigs]
    .filter(([, config]) => config.environment.capabilities.threadGroups === true)
    .map(([environmentId]) => environmentId)
    .toSorted();
  const results = useAtomValue(threadGroupsListAtom(environmentIdsKey(environmentIds)));
  return results.flatMap((result, index) => {
    const environmentId = environmentIds[index]!;
    const groups = Option.getOrNull(AsyncResult.value(result))?.groups ?? [];
    return groups.map((group) => ({
      key: threadGroupKey(environmentId, group.id),
      environmentId,
      group,
    }));
  });
}

/**
 * Whether any of these threads (newline-joined thread keys) shows as Working.
 * Reads live shells: the quiet ones the sidebar arranges rows from hold still
 * while a run streams. Recomputes on every member tick but changes, and
 * re-renders its reader, only when the answer does.
 */
const groupWorkingAtom = Atom.family((memberKeys: string) =>
  Atom.make((get) =>
    memberKeys.split("\n").some((key) => {
      const ref = parseScopedThreadKey(key);
      const shell = ref === null ? null : get(environmentThreadShells.threadShellAtom(ref));
      return shell !== null && resolveSidebarThreadStatus(shell) === "working";
    }),
  ).pipe(Atom.withLabel(`web-thread-group-working:${memberKeys}`)),
);

export function useThreadGroupWorking(memberKeys: string): boolean {
  return useAtomValue(groupWorkingAtom(memberKeys));
}
