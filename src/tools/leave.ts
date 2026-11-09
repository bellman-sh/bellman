import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { leaveRoom } from "../room/rooms.js";
import type { BellmanStore } from "../storage/store.js";

export function registerLeave(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_leave",
    {
      title: "Leave a Bellman session",
      description: `Leave the room; members get a departure event. The room closes when its last member leaves.

member_id is any seat your account holds in the room, not only this session's: a seat a session that ended left behind is cleared this way (bellman_evict refuses your own seats).

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
