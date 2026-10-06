import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { MAX_ROLE_KEY_LENGTH } from "../manifest.js";
import { issueInvite, revokeInvite } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerInvite(server: McpServer, identity: Identity, s: BellmanStore): void {
  // ------------------------------------------------------------- bellman_invite
  server.registerTool(
    "bellman_invite",
    {
      title: "Issue a new Bellman join code",
      description: `Mint a fresh join code for a room whose seat gives you the \`invite\` verb — at any time, for as long as the session lives. This mints for any role the manifest declares, not only your own seat.

A code expires 15 minutes after it is issued, and a pair session consumes its code once full. That is deliberate: a code is a short-lived invitation, not a room address. Issuing a new one is how you add a member later, so a long-running swarm room does not have to gather everyone in the first 15 minutes.

A room mints one live code per role. Issuing for a role RETIRES that role's previous code immediately and leaves every other role's code alone — so you can hand a reviewer code and a contributor code to different people.

Omitting \`role\` issues for the room's default seat. Omitting it when revoking retires EVERY code: over-revoking is recoverable by minting again, while under-revoking leaves a door open behind someone who believes they shut it. Pass a role to revoke exactly one.

So \`invite\` already invalidates an outstanding code, because issuing retires it. \`revoke\` is the narrower authority: close the door and leave it closed. A seat holding \`invite\` but not \`revoke\` can still cut off a code someone is holding, by minting a new one.

Args: session_id, member_id (yours), role (optional), revoke (default false)
Returns: { join_code, join_code_expires_at, role, replaced_previous } or { revoked: true, roles }
Members see an invite_issued / invite_revoked event, unless the room freezes at that instant: the change still stands, unannounced. Revoking a role with no live code to retire is a silent no-op instead — no event, no audit row — and roles comes back empty.
Errors: issuing needs the \`invite\` verb and revoking needs \`revoke\`; a room whose manifest gives nobody \`invite\` cannot be reopened by anyone. A \`role\` naming none the manifest declares is refused, listing the ones it does. A full session refuses (the code could not be used).`,
      inputSchema: {
        session_id: z.string().min(4),
        member_id: z.string().min(4),
        role: z.string().min(1).max(MAX_ROLE_KEY_LENGTH).optional(),
        revoke: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async ({ session_id, member_id, role, revoke }): Promise<ToolResult> => {
      if (revoke) {
        const r = await revokeInvite(s, identity, session_id, member_id, role);
        return r.ok ? ok({ revoked: true, roles: r.value.roles, join_code: null }) : fail(r.reason);
      }
      const r = await issueInvite(s, identity, session_id, member_id, role);
      if (!r.ok) return fail(r.reason);
      return ok({
        join_code: r.value.code,
        join_code_expires_at: new Date(r.value.expiresAt).toISOString(),
        role: r.value.role,
        replaced_previous: r.value.replacedPrevious,
        share_instructions:
          `Give this code to the joining session. It seats them as "${r.value.role}". Any code issued earlier for that role has stopped working; other roles' codes are unaffected.`,
      });
    }
  );
}
