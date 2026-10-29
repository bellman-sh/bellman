import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { banAsker, evictMember } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerEvict(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_evict",
    {
      title: "Remove a member from a room you created",
      description: `Remove a member from a room you created. Only the creator may; no role can be granted it.

Evicting retires the live join code for that member's seat, except a public room's permanent code: use ban to keep that person out. Other roles' codes and other members are unaffected. Without ban, any live code seats them again. With ban, their account cannot rejoin through any code: "room" at this room, "all" at every room you own, now and later, which also removes them from your other rooms they sit in now. A ban also removes that account's other handles here. Nothing is removed from the log. They are told only that they can't join.

The removed member's bellman_sync still returns the history through the member_evicted event that removed them; after it, no new events reach them, and their bellman_send and room socket are refused. Rejoining on a live code gives a fresh handle.

To ban an outside asker in a public room, pass the question's cursor as question_cursor instead of member_id, with ban. Their account cannot ask again; you are told only the origin the room shows for them.

Args: session_id, member_id (THEIRS, not yours) or question_cursor (an outside question's cursor), ban ("room" or "all"; required with question_cursor)
Returns, for member_id: { evicted, code_retired (the role whose code was retired, or null), session_status, banned ("room", "all" or null), also_removed_from (how many other rooms of yours "all" removed them from) }; for question_cursor: { origin, banned }
Members, the removed one included, see a member_evicted event. If the room freezes mid-call, the call is refused and nothing changes (the person is still in the room): repeat it once the room thaws. Removing the last active member closes the room.
Errors: only the creator may call it; not on yourself (use bellman_leave); an unknown or closed room, a member_id not in the room, and a frozen room are refused. Evicting someone who already left is not announced again, but still retires their seat's code if one is live and not permanent.`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4).optional(),
        question_cursor: z.number().int().positive().optional()
          .describe("The cursor of an outside question, to ban whoever asked it. Use this or member_id, not both."),
        ban: z.enum(["room", "all"]).optional()
          .describe('Also ban their account: "room" from this room, "all" from every room you own, now and later.'),
      },
      // idempotentHint is false. MCP defines it by effect — calling again with the same
      // arguments has no additional effect on the environment — and eviction can have
      // one: a code minted for the evicted seat between two calls is live, so the second
      // call retires it, announces that and audits it. The hint is a claim about effect
      // and not about retry-safety, and a claim that needs an exception written beside it
      // is false as stated.
      //
      // Whether to retry is a separate question, and the answer is yes. A repeat finishes
      // an eviction that died partway. For an active member only the closing can be left
      // undone now, because the door and the removal commit together, and after a
      // completed one it announces and audits nothing unless a code was minted since.
      // That extra effect leans toward over-revoking, and minting again recovers it.
      //
      // bellman_leave keeps idempotentHint: true, for a real reason: once a leave has
      // completed, a repeat announces and audits nothing, and the closing it may still
      // finish is of a room that is already empty.
      annotations: {
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      const { member_id, question_cursor, ban } = args;
      if (member_id === undefined ? question_cursor === undefined : question_cursor !== undefined) {
        return fail("name the member with member_id or the question with question_cursor, not both and not neither.");
      }
      if (member_id === undefined) {
        if (!ban) return fail('question_cursor needs ban: "room" or "all".');
        const b = await banAsker(s, identity, session_id, question_cursor!, ban);
        return b.ok ? ok({ origin: b.value.origin, banned: b.value.banned }) : fail(b.reason);
      }
      // member_id is the TARGET's, not the caller's: every sibling tool takes the
      // caller's own handle in this slot. The creator-only check lives in evictMember.
      const r = await evictMember(s, identity, session_id, member_id, ban);
      return r.ok
        ? ok({
            evicted: r.value.evicted,
            code_retired: r.value.codeRetired,
            session_status: r.value.sessionStatus,
            banned: r.value.banned,
            also_removed_from: r.value.alsoRemovedFrom,
          })
        : fail(r.reason);
    }
  );
}
