import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { leaveRoom } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerLeave(server: McpServer, identity: Identity, s: BellmanStore): void {
  // -------------------------------------------------------------- bellman_leave
  server.registerTool(
    "bellman_leave",
    {
      title: "Leave a Bellman session",
      description: `Leave the session, broadcasting a departure event so peers aren't talking into a void. The session closes when the last member leaves.

Args: session_id, member_id
Returns: { left: true, session_status }`,
      inputSchema: { ...RoomRefShape, member_id: z.string().min(4) },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      const { member_id } = args;
      const r = await leaveRoom(s, identity, session_id, member_id);
      return r.ok ? ok({ left: true, session_status: r.value.sessionStatus }) : fail(r.reason);
    }
  );
}
