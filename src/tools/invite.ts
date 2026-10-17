import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { joinUrl } from "../codes.js";
import type { Identity } from "../types.js";
import { MAX_ROLE_KEY_LENGTH } from "../manifest.js";
import { issueInvite, revokeInvite } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerInvite(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_invite",
    {
      title: "Issue a new Bellman join code",
      description: `Mint a fresh join code for a room whose seat gives you the \`invite\` verb — at any time, for as long as the session lives. This mints for any role the manifest declares, not only your own seat.

A code expires 15 minutes after it is issued, and a pair session consumes its code once full. That is deliberate: a code is a short-lived invitation, not a room address. Issuing a new one is how you add a member later, so a long-running swarm room does not have to gather everyone in the first 15 minutes.

\`permanent: true\` is the exception, for a public room's default seat and no other: a code with no expiry, for a link put on a page. It works until it is revoked, the room is made private, or the room closes, and a full room keeps it for when a seat frees. Evicting a member of its seat does not end it: \`bellman_evict\` with \`ban\` is what keeps that person out.

A room mints one live code per role, and roles are independent — you can hand a reviewer code and a contributor code to different people. Issuing for a role with NO live code opens that door. Issuing for one that has a live code retires the code someone may be holding, so that needs the \`revoke\` verb as well as \`invite\`; without it the call is refused and the live code stands. An expired code is not live, so minting over one is only ever opening.

Omitting \`role\` issues for the room's default seat. Omitting it when revoking retires EVERY code: over-revoking is recoverable by minting again, while under-revoking leaves a door open behind someone who believes they shut it. Pass a role to revoke exactly one.

\`invite\` opens a door that is shut. \`revoke\` shuts one that is open and leaves it shut. Replacing a live code is both at once, so it takes both. A seat holding \`invite\` and not \`revoke\` cannot cut off a code someone is holding — the connect preview has always implied that, and it is now also true.

Args: session_id, member_id (yours), role (optional), revoke (default false), permanent (default false)
Returns: { join_code, join_url, join_code_expires_at (null when permanent), permanent, role, replaced_previous, share_instructions } or { revoked: true, roles }
Members see an invite_issued / invite_revoked event, unless the room freezes at that instant: the change still stands, unannounced. Revoking a role with no live code to retire is a silent no-op instead — no event, no audit row — and roles comes back empty.
Errors: issuing needs the \`invite\` verb, revoking needs \`revoke\`, and replacing a live code needs both; a room whose manifest gives nobody \`invite\` cannot be reopened by anyone. A \`role\` naming none the manifest declares is refused, listing the ones it does. A full session refuses (the code could not be used).`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4),
        role: z.string().min(1).max(MAX_ROLE_KEY_LENGTH).optional(),
        revoke: z.boolean().default(false),
        permanent: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      const { member_id, role, revoke } = args;
      if (revoke) {
        const r = await revokeInvite(s, identity, session_id, member_id, role);
        return r.ok ? ok({ revoked: true, roles: r.value.roles, join_code: null }) : fail(r.reason);
      }
      const r = await issueInvite(s, identity, session_id, member_id, role, args.permanent);
      if (!r.ok) return fail(r.reason);
      const url = joinUrl(r.value.code);
      const { expiresAt } = r.value;
      return ok({
        join_code: r.value.code,
        join_url: url,
        join_code_expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        permanent: expiresAt === null,
        role: r.value.role,
        replaced_previous: r.value.replacedPrevious,
        share_instructions:
          (expiresAt === null
            ? `Put this link where newcomers will find it: ${url} — the page tells each of them what to say to their agent. `
            : `Share this link with the joining session's human: ${url} — the page tells them what to say to their agent. `) +
          `The code in it, ${r.value.code}, seats them as "${r.value.role}". ` +
          (expiresAt === null
            ? `It does not expire: it works until it is revoked, the room is made private, or the room closes, and while the room is full it seats no one. Evicting a member of its seat does not end it; banning the account is what keeps that person out. `
            : "") +
          `Any code issued earlier for that role has stopped working; other roles' codes are unaffected.`,
      });
    }
  );
}
