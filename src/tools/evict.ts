import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { evictMember } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerEvict(server: McpServer, identity: Identity, s: BellmanStore): void {
  // -------------------------------------------------------------- bellman_evict
  server.registerTool(
    "bellman_evict",
    {
      title: "Remove a member from a room you created",
      description: `Remove someone from a room you created. Only the room's creator can do this — it is not a manifest verb, so no seat grants it and no role can be given it.

Evicting also retires the join code for that member's seat, if one is live. A code is the door; leaving it open behind someone you removed means they can walk back in. Other roles' codes are unaffected, and so is anyone else already in the room. Removal is not a ban: any live code seats them again.

The history stays readable to the person removed: it was theirs too, and their bellman_sync keeps returning it, including the member_evicted event that removed them. What stops is everything after: new events do not reach them, their next bellman_send is refused, and a room socket is refused too. Rejoining on a live code gives them a fresh handle that reads the room again.

Args: session_id, member_id (THEIRS, not yours)
Returns: { evicted, code_retired (the role whose code was retired, or null), session_status }
Members see a member_evicted event, the person removed too. If the room freezes while the call is in progress, the call is refused and nothing changes — the person is still in the room and their seat's code is untouched — so repeat it once the room thaws. Removing the last active member closes the room.
Errors: only the creator may call it; you cannot evict yourself (use bellman_leave); an unknown or closed session, a member_id not in the room, and a frozen room are refused. Removing someone who already left is not announced twice, but still retires their seat's code if one is live — leaving does not.`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4),
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
      const { member_id } = args;
      // member_id is the TARGET's, not the caller's: every sibling tool takes the
      // caller's own handle in this slot. The creator-only check lives in evictMember.
      const r = await evictMember(s, identity, session_id, member_id);
      return r.ok
        ? ok({
            evicted: r.value.evicted,
            code_retired: r.value.codeRetired,
            session_status: r.value.sessionStatus,
          })
        : fail(r.reason);
    }
  );
}
