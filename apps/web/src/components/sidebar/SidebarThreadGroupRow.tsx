import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, ChevronRightIcon, CircleDashedIcon, Undo2Icon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import type { SidebarThreadGroupLayout } from "../Sidebar.groups";
import { ProjectFavicon } from "../ProjectFavicon";
import { animateSidebarLayoutChanges, type SidebarSection } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadGroupWorking } from "../../state/threadGroups";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

/** One project lane of a group: a repo on one machine. */
export interface SidebarThreadGroupLaneSummary {
  readonly key: string;
  readonly name: string;
  readonly project: EnvironmentProject | null;
  readonly machineLabel: string | null;
}

export interface SidebarThreadGroupRowProps {
  readonly sortableId: string;
  readonly layout: SidebarThreadGroupLayout;
  /** data-group-tone: the group's colour, shared with its member rows. */
  readonly tone: number;
  readonly lanes: readonly SidebarThreadGroupLaneSummary[];
  /** Folder layout: the project tab shown, or null for All. */
  readonly activeLane: string | null;
  readonly onSelectLane: (groupKey: string, laneKey: string | null) => void;
  readonly groupKey: string;
  readonly title: string;
  readonly section: SidebarSection;
  readonly memberCount: number;
  /** Member thread keys, newline-joined, for the live Working roll-up. */
  readonly memberKeys: string;
  readonly collapsed: boolean;
  readonly settlementSupported: boolean;
  readonly isActive: boolean;
  readonly isRenaming: boolean;
  readonly renamingTitle: string;
  readonly onToggleCollapsed: (groupKey: string) => void;
  /** Opens the group session: a thread for talking about the whole group. */
  readonly onOpen: (groupKey: string) => void;
  readonly onSettle: (groupKey: string) => void;
  readonly onUnsettle: (groupKey: string) => void;
  readonly onContextMenu: (groupKey: string, position: { x: number; y: number }) => void;
  readonly onRenameTitleChange: (title: string) => void;
  readonly onCommitRename: (groupKey: string, title: string) => void;
  readonly onCancelRename: () => void;
}

/**
 * A group's header in the thread list, in one of two layouts to compare:
 * lanes (a pill; members follow under one heading per project and machine)
 * or folder (a tinted folder with a tab per project). It stays where the list
 * puts it (no dragging) and says Working while any member works.
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
  const chevron = (
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
  );
  const title = props.isRenaming ? (
    <input
      autoFocus
      aria-label="Group name"
      maxLength={128}
      value={props.renamingTitle}
      onChange={(event) => props.onRenameTitleChange(event.target.value)}
      onBlur={() => {
        if (!renameEnded.current) props.onCommitRename(props.groupKey, props.renamingTitle);
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
    // The title button covers the whole header (its ::after), so a click
    // anywhere outside the other buttons opens the group session.
    <button
      type="button"
      data-group-title
      aria-current={props.isActive ? "page" : undefined}
      aria-label={`Open group ${props.title}, ${props.memberCount} threads`}
      onClick={() => props.onOpen(props.groupKey)}
      onKeyDown={handleKeyDown}
      className="min-w-0 cursor-pointer truncate text-left text-sm font-semibold outline-none after:absolute after:inset-0 after:content-['']"
    >
      {props.title}
    </button>
  );
  const status = (
    <span className="relative ml-auto flex h-5 shrink-0 items-center justify-end text-xs">
      <span
        className={cn(
          "flex items-center gap-1 tabular-nums transition-opacity group-has-[:focus-visible]/sidebar-group:absolute group-has-[:focus-visible]/sidebar-group:right-0 group-has-[:focus-visible]/sidebar-group:opacity-0 group-hover/sidebar-group:absolute group-hover/sidebar-group:right-0 group-hover/sidebar-group:opacity-0",
          working ? "font-medium text-info" : "text-secondary-label",
        )}
      >
        {working ? (
          <>
            <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
            <span role="status">Working</span>
          </>
        ) : props.collapsed ? (
          <span className="inline-flex items-center gap-1">
            <LaneFavicons lanes={props.lanes} />
            <span className="text-muted-foreground/70">{props.memberCount}</span>
          </span>
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
          <TooltipPopup>{settled ? "Un-settle every thread" : "Settle every thread"}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
  const shellProps = {
    ref: setNodeRef,
    "data-thread-group": props.groupKey,
    "data-group-tone": props.tone,
    style: {
      transform: CSS.Translate.toString(transform),
      transition,
      // Hidden while a drag's projection has no slot for it.
      visibility: transform?.scaleY === 0 ? ("hidden" as const) : undefined,
    },
  };
  const headerClassName = cn(
    "group/sidebar-group relative text-left select-none has-[button[data-group-title]:focus-visible]:ring-2 has-[button[data-group-title]:focus-visible]:ring-inset has-[button[data-group-title]:focus-visible]:ring-ring",
    settled && "text-sidebar-muted-foreground/75 hover:text-sidebar-foreground",
  );

  if (props.layout === "folder") {
    // C3: a folder in the group's colour, one tab per project on top.
    return (
      <li {...shellProps} className="list-none pt-1">
        <div
          role="tablist"
          aria-label={`${props.title} projects`}
          className="flex items-end gap-0.5 px-3"
        >
          <FolderTab
            selected={props.activeLane === null}
            onSelect={() => props.onSelectLane(props.groupKey, null)}
          >
            All
          </FolderTab>
          {props.lanes.map((lane) => (
            <FolderTab
              key={lane.key}
              selected={props.activeLane === lane.key}
              onSelect={() => props.onSelectLane(props.groupKey, lane.key)}
              tooltip={
                lane.machineLabel === null ? lane.name : `${lane.name} · ${lane.machineLabel}`
              }
            >
              {lane.project ? (
                <ProjectFavicon project={lane.project} className="size-3 shrink-0" />
              ) : null}
              <span className="truncate">{lane.name}</span>
            </FolderTab>
          ))}
        </div>
        <div
          data-testid="sidebar-thread-group"
          onContextMenu={handleContextMenu}
          className={cn(
            headerClassName,
            "mx-1 rounded-tr-xl text-sidebar-foreground",
            props.isActive ? "bg-(--group)/25" : "bg-(--group)/12",
            props.collapsed && "rounded-b-xl",
          )}
        >
          {props.collapsed ? (
            // Folded, the folder reads as a small stack of cards.
            <span
              aria-hidden
              className="absolute inset-x-2 -bottom-1 -z-10 h-3 rounded-b-xl bg-(--group)/8"
            />
          ) : null}
          <div className="flex h-9 min-w-0 items-center gap-1.5 px-(--sidebar-row-content-inset)">
            {chevron}
            {title}
            {status}
          </div>
        </div>
      </li>
    );
  }

  // C1: a small pill in the group's colour; members follow in project lanes.
  return (
    <li {...shellProps} className="list-none pt-1.5 pb-0.5">
      <div
        data-testid="sidebar-thread-group"
        onContextMenu={handleContextMenu}
        className={cn(headerClassName, "rounded-md text-sidebar-foreground")}
      >
        <div className="flex h-7 min-w-0 items-center gap-1.5 px-(--sidebar-row-content-inset)">
          {chevron}
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5",
              props.isActive ? "bg-(--group)/30" : "bg-(--group)/15 hover:bg-(--group)/22",
            )}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--group)" />
            {title}
          </span>
          {status}
        </div>
      </div>
    </li>
  );
});

function LaneFavicons(props: { lanes: readonly SidebarThreadGroupLaneSummary[] }) {
  return (
    <span className="inline-flex items-center">
      {props.lanes.map((lane) =>
        lane.project ? (
          <ProjectFavicon
            key={lane.key}
            project={lane.project}
            className="-ml-0.5 size-3.5 rounded-sm ring-1 ring-(--sidebar) first:ml-0"
          />
        ) : null,
      )}
    </span>
  );
}

function FolderTab(props: {
  selected: boolean;
  onSelect: () => void;
  tooltip?: string;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      onClick={props.onSelect}
      className={cn(
        "inline-flex max-w-28 min-w-0 cursor-pointer items-center gap-1 rounded-t-lg px-2 pt-1 pb-1 text-2xs transition-colors",
        props.selected
          ? "bg-(--group)/12 font-semibold text-sidebar-foreground"
          : "bg-(--group)/5 text-muted-foreground hover:bg-(--group)/10 hover:text-sidebar-foreground",
      )}
    >
      {props.children}
    </button>
  );
  if (props.tooltip === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
