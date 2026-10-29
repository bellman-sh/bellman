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
      description: `Mint a join code for any role the manifest declares, at any time while the room lives. Needs the \`invite\` verb.

A code expires 15 minutes after issue, and a pair room consumes it once full. Mint a new one to add a member later.

\`permanent: true\`, for a public room's default seat only: a code with no expiry, for a link on a page. It lasts until revoked, the room is made private, or the room closes; a full room keeps it. Evicting a member of its seat does not end it: \`bellman_evict\` with \`ban\` keeps a person out.

Each role has at most one live code. Minting for a role with no live code opens it. Minting over a live code retires the code someone may hold, so it needs \`revoke\` as well as \`invite\`; without \`revoke\` the call is refused and the live code stands. An expired code is not live.

Omitting \`role\` issues for the default seat, but with revoke retires EVERY code. Pass a role to revoke one.

Args: session_id, member_id (yours), role (optional), revoke (default false), permanent (default false)
Returns: { join_code, join_url, join_code_expires_at (null when permanent), permanent, role, replaced_previous, share_instructions } or { revoked: true, roles }
Members see an invite_issued / invite_revoked event, unless the room freezes at that instant: the change stands, unannounced. Revoking a role with no live code does nothing (no event, no audit row) and roles comes back empty.
Errors: issuing needs \`invite\`, revoking \`revoke\`, replacing a live code both; if no role holds \`invite\`, nobody can reopen the room. A \`role\` the manifest does not declare is refused, listing those it does. A full room refuses.`,
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
