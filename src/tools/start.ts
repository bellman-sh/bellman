import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { roomPreview } from "../projections.js";
import type { Brief, Capability, Identity, Member, RoomManifest, Session } from "../types.js";
import { entitlementsFor } from "../auth.js";
import { generateSessionId, joinUrl, renderJoinCode } from "../codes.js";
import { ManifestError, ManifestShape, resolveManifest } from "../manifest.js";
import { audit } from "../rooms.js";
import { JOIN_CODE_TTL } from "../store.js";
import type { BellmanStore } from "../store.js";

export function registerStart(server: McpServer, identity: Identity, s: BellmanStore): void {
  // -------------------------------------------------------------- bellman_start
  server.registerTool(
    "bellman_start",
    {
      title: "Start a Bellman session",
      description: `Create a collaboration room and get a join code to share with the sessions you want in it.

The join code (e.g. BELL-7F3K-92-PEER-B) is human-relayable: paste it into another Claude/ChatGPT/Cursor/Gemini session that has Bellman connected, and that session runs bellman_connect with it. The last group is the seat the code grants. Works across users, machines, surfaces, and model providers.

Args:
  - manifest: the room's declaration. Either cite a preset —
    { room, purpose?, preset: "pair" | "swarm" | "review" } — or author roles:
    { room, purpose?, mode, roles: { <role>: { can: [verbs] } }, default_role, creator_role }.
    Verbs: send, invite, revoke, request_actions, respond_actions, write_surface.
    Verbs are enforced by the server: a role's list is what each seat may actually do, and a call outside it is refused; reading the room and leaving it are never gated.
    invite reaches outside its own seat: holding it lets you mint a join code for ANY role this manifest declares, not only your own or the default, so you can seat someone — including yourself, by leaving and rejoining — in the most capable role the room has. revoke is likewise not self-scoped: a seat holding it may retire any role's code, not only its own. Give invite only to a seat you would trust with every seat's authority.
    The manifest sets the room's mode; there is no separate mode argument. A "pair"
    room holds exactly 2 members; a "swarm" room holds as many as you invite, up to
    100 — Bellman's ceiling for one room, the same on every plan.
    The pair and review presets make pair rooms; the swarm preset makes a swarm room.
  - brief: your structured context summary (goal, state, constraints, open_questions, agent). This is what a joiner PREVIEWS before committing — write it for outside eyes.
  - capabilities: what you allow peers to do to you (default: read_context, receive_messages). Grant request_actions only if you want peers to be able to ask your session to do things.
  - org_only (boolean): restrict joining to members of your org (team plan)

Returns: { session_id, member_id, join_code, join_url, join_code_expires_at, plan, room: {preset, mode, your_role, your_verbs, heartbeat_on_seconds, you_report, creator_role, roles, reports (per role, whether that seat is asked to report), text (untrusted envelope)} }
Keep member_id — every subsequent call needs it. The room has no lifetime: it ends when its last member leaves, or after 90 days in which nobody in it was seen. room is the manifest as the server recorded it: a preset comes back expanded, and your_role / your_verbs are yours. Read it back to check it says what you meant.

Plan gating applies to CREATING sessions only; joining is free on every plan.
Errors: "invalid manifest — ..." (a default_role or creator_role that names no role, or a verb repeated within a role) or an input validation error naming the field (a malformed manifest) — either way nothing is created and no quota is spent; "swarm mode requires..." (plan), "org_only sessions require..." (plan), "org_only was set but..." (no org), "monthly session limit..." (quota).`,
      inputSchema: {
        manifest: ManifestShape,
        brief: BriefShape,
        capabilities: CapabilitiesShape,
        org_only: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async ({ manifest: manifestInput, brief, capabilities, org_only }): Promise<ToolResult> => {
      // Resolve FIRST. A malformed manifest must not reach the store, and the
      // plan check below reads the mode the manifest declares.
      let manifest: RoomManifest;
      try {
        manifest = resolveManifest(manifestInput);
      } catch (e) {
        if (e instanceof ManifestError) return fail(`invalid manifest — ${e.message}`);
        throw e;
      }

      const ent = entitlementsFor(identity);
      if (!ent.modes.includes(manifest.mode)) {
        return fail(`swarm mode requires the pro, max or team plan (you are on "${identity.plan}"). Start a pair session instead, or upgrade.`);
      }
      if (org_only && !ent.orgScoping) {
        return fail(`org_only sessions require the team plan (you are on "${identity.plan}").`);
      }
      if (org_only && !identity.orgId) {
        return fail("org_only was set but your identity has no org.");
      }
      const used = await s.countCreatesThisMonth(identity.userId);
      if (used >= ent.monthlyCreates) {
        return fail(`monthly session limit reached (${ent.monthlyCreates} on the "${identity.plan}" plan).`);
      }

      const now = Date.now();
      const memberId = `m_${randomUUID().slice(0, 8)}`;
      const creator: Member = {
        memberId,
        userId: identity.userId,
        label: identity.label,
        orgId: identity.orgId,
        capabilities: capabilities as Capability[],
        roomRole: manifest.creatorRole,
        brief: brief as Brief,
        joinedAt: now,
        lastSeenAt: now,
        leftAt: null,
      };
      const defaultCode = {
        code: renderJoinCode(manifest.defaultRole),
        expiresAt: now + JOIN_CODE_TTL,
      };
      const session: Session = {
        id: generateSessionId(),
        manifest,
        createdBy: identity.userId,
        orgId: identity.orgId,
        orgOnly: org_only,
        joinCodes: { [manifest.defaultRole]: defaultCode },
        // The room's own byte ceiling (#183), from the plan creating it. Nothing
        // downstream asks a plan again.
        blobBytesCeiling: ent.blobBytesPerRoom,
        // The window a closed room is kept for (#65, D1), stamped as the ceiling above is: a plan
        // change after the fact never shortens a room that was promised one.
        retainAfterCloseMs: ent.retainAfterCloseMs,
        closedAt: null,
        purgeAt: null,
        blobsSwept: false,
        members: [creator],
        events: [],
        closed: false,
        frozenAt: null,
      };
      await s.createSession(session);
      await s.recordCreate(identity.userId);
      await audit(s, session, identity, "session_created", { mode: manifest.mode, org_only, preset: manifest.preset });

      return ok({
        session_id: session.id,
        member_id: memberId,
        join_code: defaultCode.code,
        // The same code, as a link: clickable in chat, and it tells the person
        // who opens it what to say to their agent. The page is rendered from
        // the URL alone, so sharing the link reveals nothing the code does not.
        join_url: joinUrl(defaultCode.code),
        join_code_expires_at: new Date(defaultCode.expiresAt).toISOString(),
        plan: identity.plan,
        // What the server recorded, seen from the creator's seat. Without it the
        // author of a manifest, especially one parsed from .bellman/room.yaml,
        // cannot see a preset or role that validated but is not what they meant.
        room: roomPreview(session, manifest.creatorRole),
        share_instructions:
          `Give the join code to whoever you want in the room. In their session (any MCP client — Claude, ChatGPT, Cursor, Gemini), they run bellman_connect with the code, review your brief, then bellman_confirm with their own. A swarm room holds as many members as you invite, up to 100; reissue a code with bellman_invite to add members later.`,
      });
    }
  );
}
