import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, ChevronRightIcon, CircleDashedIcon, LayersIcon, Undo2Icon } from "lucide-react";
import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { animateSidebarLayoutChanges, type SidebarSection } from "../Sidebar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadGroupWorking } from "../../state/threadGroups";
import { SIDEBAR_SORTABLE_DRAG_DISABLED, type SidebarProviderEntry } from "./SidebarThreadRow";

export interface SidebarThreadGroupEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface SidebarThreadGroupRowProps {
  readonly sortableId: string;
  readonly groupKey: string;
  readonly title: string;
  readonly section: SidebarSection;
  readonly memberCount: number;
  /** Member thread keys, newline-joined, for the live Working roll-up. */
  readonly memberKeys: string;
  readonly collapsed: boolean;
  /** The member threads' machines and providers, one icon each. */
  readonly environments: readonly SidebarThreadGroupEnvironment[];
  readonly providers: readonly SidebarProviderEntry[];
  readonly settlementSupported: boolean;
  readonly isActive: boolean;
  readonly isRenaming: boolean;
  readonly renamingTitle: string;
  readonly onToggleCollapsed: (groupKey: string) => void;
  readonly onOpen: (groupKey: string) => void;
  readonly onSettle: (groupKey: string) => void;
  readonly onUnsettle: (groupKey: string) => void;
  readonly onContextMenu: (groupKey: string, position: { x: number; y: number }) => void;
  readonly onRenameTitleChange: (title: string) => void;
  readonly onCommitRename: (groupKey: string, title: string) => void;
  readonly onCancelRename: () => void;
}

/**
 * A group's header in the thread list. It stays where the list puts it (no
 * dragging) and shows what its members add up to: working while any member
 * works, and the machines and providers they run on.
 */
export const SidebarThreadGroupRow = memo(function SidebarThreadGroupRow(
  props: SidebarThreadGroupRowProps,
) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.sortableId,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const settled = props.section === "settled";
  const working = useThreadGroupWorking(props.memberKeys);
  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    props.onContextMenu(props.groupKey, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" && !props.collapsed) {
      props.onToggleCollapsed(props.groupKey);
    } else if (event.key === "ArrowRight" && props.collapsed) {
      props.onToggleCollapsed(props.groupKey);
    }
  };
  // Enter and Escape end the rename; the blur that follows must not commit again.
  const renameEnded = useRef(false);
  useEffect(() => {
    if (props.isRenaming) renameEnded.current = false;
  }, [props.isRenaming]);
  return (
    <li
      ref={setNodeRef}
      data-thread-group={props.groupKey}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        // Hidden while a drag's projection has no slot for it.
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      className="list-none py-0.5"
    >
      <div
        data-testid="sidebar-thread-group"
        onContextMenu={handleContextMenu}
        className={cn(
          "group/sidebar-group relative w-full rounded-md text-left select-none has-[button[data-group-title]:focus-visible]:ring-2 has-[button[data-group-title]:focus-visible]:ring-inset has-[button[data-group-title]:focus-visible]:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          settled && "text-sidebar-muted-foreground/75 hover:text-sidebar-foreground",
        )}
      >
        <div className="px-(--sidebar-row-content-inset) py-1.5">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-expanded={!props.collapsed}
              aria-label={props.collapsed ? "Expand group" : "Collapse group"}
              onClick={() => props.onToggleCollapsed(props.groupKey)}
              className="relative z-10 -ml-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", !props.collapsed && "rotate-90")}
              />
            </button>
            <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {props.isRenaming ? (
              <input
                autoFocus
                aria-label="Group name"
                maxLength={128}
                value={props.renamingTitle}
                onChange={(event) => props.onRenameTitleChange(event.target.value)}
                onBlur={() => {
                  if (!renameEnded.current)
                    props.onCommitRename(props.groupKey, props.renamingTitle);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    renameEnded.current = true;
                    props.onCommitRename(props.groupKey, props.renamingTitle);
                  } else if (event.key === "Escape") {
                    renameEnded.current = true;
                    props.onCancelRename();
                  }
                }}
                className="relative z-10 min-w-0 flex-1 rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-ring"
              />
            ) : (
              // The title button covers the whole card (its ::after), so a click
              // anywhere outside the other buttons opens the group session.
              <button
                type="button"
                data-group-title
                aria-current={props.isActive ? "page" : undefined}
                aria-label={`Open group ${props.title}, ${props.memberCount} threads`}
                onClick={() => props.onOpen(props.groupKey)}
                onKeyDown={handleKeyDown}
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']"
              >
                {props.title}
              </button>
            )}
            <span className="relative ml-auto flex h-5 shrink-0 items-center justify-end text-xs">
              <span
                className={cn(
                  "flex items-center gap-1 tabular-nums transition-opacity group-focus-within/sidebar-group:absolute group-focus-within/sidebar-group:opacity-0 group-hover/sidebar-group:absolute group-hover/sidebar-group:right-0 group-hover/sidebar-group:opacity-0",
                  working ? "font-medium text-info" : "text-secondary-label",
                )}
              >
                {working ? (
                  <>
                    <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                    <span role="status">Working</span>
                  </>
                ) : null}
              </span>
              {props.settlementSupported ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={settled ? "Un-settle group" : "Settle group"}
                        onClick={() => {
                          if (settled) props.onUnsettle(props.groupKey);
                          else props.onSettle(props.groupKey);
                        }}
                        className="pointer-events-none absolute inset-y-0 right-0 z-10 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:static focus-visible:opacity-100 group-hover/sidebar-group:pointer-events-auto group-hover/sidebar-group:static group-hover/sidebar-group:opacity-100"
                      />
                    }
                  >
                    {settled ? (
                      <Undo2Icon className="size-3.5" />
                    ) : (
                      <>
                        <CheckIcon className="size-3.5" />
                        Settle
                      </>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {settled ? "Un-settle every thread" : "Settle every thread"}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-6 text-xs text-secondary-label">
            <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
              {props.memberCount === 1 ? "1 thread" : `${props.memberCount} threads`}
            </span>
            <span className="relative z-10 inline-flex shrink-0 items-center gap-1.5">
              {props.environments.map((environment) => (
                <Tooltip key={environment.environmentId}>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex items-center text-sidebar-muted-foreground/70" />
                    }
                  >
                    <EnvironmentMachineIcon
                      aria-label={environment.label}
                      kind={environment.machine}
                      className="size-3.5"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{environment.label}</TooltipPopup>
                </Tooltip>
              ))}
              {props.providers.map((provider) => (
                <ProviderInstanceIcon
                  key={`${provider.driverKind}:${provider.displayName}`}
                  driverKind={provider.driverKind}
                  displayName={provider.displayName}
                  accentColor={provider.accentColor}
                  acpRegistryAgentId={provider.acpRegistryAgentId}
                  acpRegistryIconUrl={provider.acpRegistryIconUrl}
                  size="compact"
                  iconClassName="opacity-60"
                />
              ))}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
});
