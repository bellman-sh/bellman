import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NEED_ROOM, RoomRefShape, fail, ok, refusal, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { MAX_REPORT_NOTE_CHARS, REPORT_REASONS, type ReportMailer } from "../reports.js";
import { fileRoomReport } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerReport(server: McpServer, identity: Identity, s: BellmanStore, mail: ReportMailer): void {
  server.registerTool(
    "bellman_report",
    {
      title: "Report a room, a member or a message",
      description: `Report a room, a member or a message to Bellman's operators. Give member_id (theirs) to report a member, cursor to report a message, or neither to report the room. A report about a member or a message also reaches the room's creator, who never sees who filed it. The person reported is not told.

Args: session_id, member_id or cursor, reason (spam, harassment, impersonation, illegal, other), note (optional, at most 500 characters)
Returns: { report_id, folded } — folded: true when you reported this already and it is still open; nothing new was filed.
Errors: an account files at most 10 reports a day (rate_limited, with retry_after); you must hold or have held a seat in the room, unless it is public.`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4).optional(),
        cursor: z.number().int().positive().optional(),
        reason: z.enum(REPORT_REASONS),
        note: z.string().max(MAX_REPORT_NOTE_CHARS).optional(),
      },
      // Not idempotent: a repeat of an open report folds into the first and writes nothing, but one made after
      // the first was resolved files a new report and sends a new email (R9).
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      // member_id is the TARGET's, as in bellman_evict: the caller names no handle of its own, because a report
      // needs no seat.
      const r = await fileRoomReport(
        s, identity, session_id,
        { memberId: args.member_id, cursor: args.cursor, reason: args.reason, note: args.note },
        mail,
      );
      return r.ok ? ok({ report_id: r.value.reportId, folded: r.value.folded }) : refusal(r);
    },
  );
}
