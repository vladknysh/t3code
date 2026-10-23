import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ArrowRightIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "../../state/environments";
import { useThreadGroups } from "../../state/threadGroups";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  THREAD_GROUP_LAYOUT_KEY,
  threadGroupLanes,
  ThreadGroupLayoutSchema,
  threadGroupTone,
} from "../Sidebar.groups";
import type { EnvironmentThreadGroup } from "../../state/threadGroups";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

const STATUS_LABEL = {
  approval: "Needs approval",
  input: "Needs input",
  waiting: "Waiting",
  working: "Working",
  ready: null,
  failed: "Failed",
  limited: "Usage limit",
} satisfies Record<SidebarThreadStatus, string | null>;

const STATUS_DOT = {
  approval: "bg-warning",
  input: "bg-warning",
  waiting: "bg-muted-foreground",
  working: "bg-info",
  ready: "bg-success",
  failed: "bg-destructive",
  limited: "bg-destructive",
} satisfies Record<SidebarThreadStatus, string>;

/**
 * Above a group session's chat, in the lanes layout: one column per project
 * the group spans, each member's live status, and which
 * thread brought which in. The folder layout keeps the session a plain chat,
 * so the two can be compared.
 */
export function GroupSessionBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [layout] = useLocalStorage(THREAD_GROUP_LAYOUT_KEY, "lanes", ThreadGroupLayoutSchema);
  const group = useThreadGroups().find(
    (entry) =>
      entry.environmentId === props.environmentId && entry.group.sessionThreadId === props.threadId,
  );
  // Every chat mounts this; only a group session subscribes to the thread list.
  if (group === undefined || layout !== "lanes") return null;
  return <GroupSessionLanes group={group} />;
}

function GroupSessionLanes(props: { readonly group: EnvironmentThreadGroup }) {
  const { group } = props;
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const machines = useEnvironmentMachines();

  const shellByKey = new Map(
    shells.map((shell) => [scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell]),
  );
  const members = group.group.members.flatMap((member) => {
    const shell = shellByKey.get(
      scopedThreadKey(scopeThreadRef(member.environmentId, member.threadId)),
    );
    return shell === undefined ? [] : [{ shell, from: member.from }];
  });
  if (members.length === 0) return null;
  const lanes = threadGroupLanes(members.map(({ shell }) => shell));
  const handoffs = members.flatMap(({ shell, from }) => {
    const source =
      from === null
        ? undefined
        : shellByKey.get(scopedThreadKey(scopeThreadRef(from.environmentId, from.threadId)));
    return source === undefined ? [] : [{ source, target: shell }];
  });
  const projectName = (shell: EnvironmentThreadShell) =>
    projects.find(
      (project) => project.environmentId === shell.environmentId && project.id === shell.projectId,
    )?.title ?? "Project";

  return (
    <div className="chat-content-lane px-4 pt-3" data-group-tone={threadGroupTone(group.group.id)}>
      <div className="flex flex-wrap gap-2">
        {lanes.map((lane) => {
          const first = lane.members[0]!;
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === first.environmentId && candidate.id === first.projectId,
          );
          const environmentLabel = environments.find(
            (environment) => environment.environmentId === first.environmentId,
          )?.label;
          return (
            <section
              key={lane.key}
              aria-label={`${projectName(first)} threads`}
              className="min-w-56 flex-1 rounded-xl border border-border bg-card px-3 py-2.5"
            >
              <header className="mb-1.5 flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
                <span className="truncate">{projectName(first)}</span>
                {environmentLabel ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={machines.get(first.environmentId) ?? "server"}
                      className="size-3.5"
                    />
                    {environmentLabel}
                  </span>
                ) : null}
              </header>
              <ul className="flex flex-col gap-1.5">
                {lane.members.map((shell) => (
                  <GroupSessionMember key={shell.id} shell={shell} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {handoffs.map(({ source, target }) => (
        <p
          key={`${source.id}>${target.id}`}
          className="mt-1.5 flex min-w-0 items-center justify-center gap-1.5 text-xs text-muted-foreground"
        >
          <span className="truncate">{projectName(source)}</span>
          <span className="inline-flex min-w-0 items-center gap-1 font-medium text-(--group)">
            <span className="truncate">from {source.title}</span>
            <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
          </span>
          <span className="truncate">{projectName(target)}</span>
        </p>
      ))}
    </div>
  );
}

/** One member line; reads the live shell so its status moves while it streams. */
function GroupSessionMember(props: { readonly shell: EnvironmentThreadShell }) {
  const shell =
    useThreadShell(scopeThreadRef(props.shell.environmentId, props.shell.id)) ?? props.shell;
  const status = resolveSidebarThreadStatus(shell);
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
      <span className="truncate font-medium text-foreground">{shell.title}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">{STATUS_LABEL[status]}</span>
    </li>
  );
}
