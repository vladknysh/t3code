import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadGroupMcpService from "../../ThreadGroupMcpService.ts";
import { readCaller } from "../../threadAccess.ts";
import { GroupToolkit } from "./tools.ts";

// readCaller holds reads to the orchestration capability, as other thread reads are.
const withService = readCaller().pipe(
  Effect.andThen(
    Effect.all([
      McpInvocationContext.McpInvocationContext,
      ThreadGroupMcpService.ThreadGroupMcpService,
    ]),
  ),
);

export const layer = McpToolAccess.toLayer(GroupToolkit, {
  t3_group_list: McpToolAccess.reads(() =>
    withService.pipe(Effect.flatMap(([scope, groups]) => groups.list(scope))),
  ),
  t3_group_update: McpToolAccess.writes((input) =>
    withService.pipe(Effect.flatMap(([scope, groups]) => groups.update(scope, input))),
  ),
  t3_group_info: McpToolAccess.reads((input) =>
    withService.pipe(Effect.flatMap(([scope, groups]) => groups.info(scope, input))),
  ),
});
