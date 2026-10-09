import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { entitlementsFor } from "../auth.js";
import type { BellmanStore } from "../store.js";

export function registerAudit(server: McpServer, identity: Identity, s: BellmanStore): void {
  // -------------------------------------------------------------- bellman_audit
  server.registerTool(
    "bellman_audit",
    {
      title: "Bellman org audit log",
      description: `Enterprise: list every context crossing that touched your org's boundary — sessions created, briefs exchanged, messages/artifacts/action_requests sent, members joining and leaving, and the end of a room's record: room_deleted when its creator or an org admin asked for it to be deleted, room_purged when it was purged. Cross-org sessions appear in BOTH orgs' logs.

Requires: team plan + admin role. Args: limit (default 50).
Returns: { entries: [{ at, session_id, actor, action, detail }] }`,
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async ({ limit }): Promise<ToolResult> => {
      const ent = entitlementsFor(identity);
      if (!ent.audit) return fail(`the audit log requires the team plan (you are on "${identity.plan}").`);
      if (identity.role !== "admin") return fail("the audit log requires the admin role.");
      if (!identity.orgId) return fail("your identity has no org.");

      const entries = (await s.auditForOrg(identity.orgId, limit)).map((a) => ({
        at: new Date(a.at).toISOString(),
        session_id: a.sessionId,
        actor: a.actorUserId,
        action: a.action,
        detail: a.detail,
      }));
      return ok({ org_id: identity.orgId, count: entries.length, entries });
    }
  );
}
