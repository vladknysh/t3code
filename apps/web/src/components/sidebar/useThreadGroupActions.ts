import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadGroupId,
  type ThreadGroupMember,
  type ThreadGroupUpdateInput,
} from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";

import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { defaultThreadGroupTitle } from "../Sidebar.groups";

interface GroupedThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadGroupMember["threadId"];
  readonly title: string;
}

const memberOf = (thread: GroupedThread): ThreadGroupMember => ({
  environmentId: thread.environmentId,
  threadId: thread.id,
});

/**
 * Sidebar commands on thread groups. Each change goes to the environment that
 * stores the group; a new group is stored on the primary environment when it
 * supports groups, else on the first thread's own environment.
 */
export function useThreadGroupActions(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  /** The group a thread is shown under now, wherever it is stored. */
  readonly groupOf: (
    thread: GroupedThread,
  ) => { readonly environmentId: EnvironmentId; readonly groupId: ThreadGroupId } | null;
}) {
  const update = useAtomCommand(serverEnvironment.updateThreadGroup, {
    label: "thread group update",
  });
  const supportsGroups = (environmentId: EnvironmentId) =>
    input.serverConfigs.get(environmentId)?.environment.capabilities.threadGroups === true;

  const run = async (environmentId: EnvironmentId, change: ThreadGroupUpdateInput) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add({
        type: "error",
        title: "Group action unavailable",
        description: "This connection cannot change thread groups.",
      });
      return null;
    }
    const result = await update({ environmentId, input: change });
    return result._tag === "Success" ? result.value : null;
  };

  /**
   * An environment moves a thread between its own groups by itself; a group
   * stored elsewhere has to let go of it first, or the thread shows in both.
   */
  const leaveGroupsElsewhere = (home: EnvironmentId, threads: readonly GroupedThread[]) =>
    Promise.all(
      threads.flatMap((thread) => {
        const current = input.groupOf(thread);
        return current === null || current.environmentId === home
          ? []
          : [
              run(current.environmentId, {
                _tag: "remove-members",
                groupId: current.groupId,
                members: [memberOf(thread)],
              }),
            ];
      }),
    );

  /** Where a new group for these threads is stored, or null when nowhere can. */
  const homeFor = (threads: readonly GroupedThread[]): EnvironmentId | null => {
    if (input.primaryEnvironmentId !== null && supportsGroups(input.primaryEnvironmentId)) {
      return input.primaryEnvironmentId;
    }
    return threads.find((thread) => supportsGroups(thread.environmentId))?.environmentId ?? null;
  };

  return {
    canCreate: (threads: readonly GroupedThread[]) => homeFor(threads) !== null,
    create: (threads: readonly GroupedThread[]) => {
      const home = homeFor(threads);
      if (home === null || threads.length === 0) return Promise.resolve(null);
      return leaveGroupsElsewhere(home, threads).then(() =>
        run(home, {
          _tag: "create",
          title: defaultThreadGroupTitle(threads.map((thread) => thread.title)),
          members: threads.map(memberOf),
        }),
      );
    },
    add: (home: EnvironmentId, groupId: ThreadGroupId, thread: GroupedThread) =>
      leaveGroupsElsewhere(home, [thread]).then(() =>
        run(home, { _tag: "add-members", groupId, members: [memberOf(thread)] }),
      ),
    remove: (home: EnvironmentId, groupId: ThreadGroupId, thread: GroupedThread) =>
      run(home, { _tag: "remove-members", groupId, members: [memberOf(thread)] }),
    rename: (home: EnvironmentId, groupId: ThreadGroupId, title: string) =>
      run(home, { _tag: "rename", groupId, title }),
    ungroup: (home: EnvironmentId, groupId: ThreadGroupId) =>
      run(home, { _tag: "delete", groupId }),
  };
}
