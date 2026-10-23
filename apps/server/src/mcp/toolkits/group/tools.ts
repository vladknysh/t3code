import {
  OrchestratorMcpFailure,
  ThreadGroupMcpInfoInput,
  ThreadGroupMcpInfoResult,
  ThreadGroupMcpListInput,
  ThreadGroupMcpListResult,
  ThreadGroupMcpUpdateInput,
  ThreadGroupMcpUpdateResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadGroupMcpService from "../../ThreadGroupMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadGroupMcpService.ThreadGroupMcpService,
];

const GroupListTool = Tool.make("t3_group_list", {
  description:
    "List the thread groups stored in this environment, or in a linked one with environmentId. A group gathers threads about one piece of work, and its members can be threads on other environments: each member names its environmentId and threadId.",
  parameters: ThreadGroupMcpListInput,
  success: ThreadGroupMcpListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List thread groups")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GroupUpdateTool = Tool.make("t3_group_update", {
  description:
    "Create, rename or delete a thread group, or add and remove its members. Members are threads on this environment or on linked ones (pass each member's environmentId from t3_environment_links; omit it for the environment storing the group). A thread is in at most one group per environment, so adding it moves it. Deleting a group only ungroups its threads. To settle or reopen a whole group, call t3_thread_organize for each member with its environmentId.",
  parameters: ThreadGroupMcpUpdateInput,
  success: ThreadGroupMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Change a thread group")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const GroupInfoTool = Tool.make("t3_group_info", {
  description:
    "Describe a thread group: each member's environment, title, status, settled state, model, the task it was started with, its latest request, and its latest reply. Members on linked environments are read there. Omit groupId for the group this thread belongs to. status is working when any member is running.",
  parameters: ThreadGroupMcpInfoInput,
  success: ThreadGroupMcpInfoResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Describe a thread group")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const GroupToolkit = Toolkit.make(GroupListTool, GroupUpdateTool, GroupInfoTool);
