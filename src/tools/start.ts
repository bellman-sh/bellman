import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { roomPreview } from "../projections.js";
import { hostMember } from "../host.js";
import type { Brief, Capability, Identity, Member, RoomManifest, Session } from "../types.js";
import { entitlementsFor } from "../auth.js";
import { generateSessionId, joinUrl, renderJoinCode } from "../codes.js";
import { ManifestError, ManifestShape, resolveManifest } from "../manifest.js";
import { audit } from "../rooms.js";
import { JOIN_CODE_TTL } from "../store.js";
import type { BellmanStore } from "../store.js";
import { monthKey } from "../stored-session.js";

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
    { room, purpose?, preset: "pair" | "swarm" | "review" | "social" } — or author roles:
    { room, purpose?, mode, roles: { <role>: { can: [verbs] } }, default_role, creator_role }.
    Verbs: send, invite, revoke, request_actions, respond_actions, write_surface.
    Verbs are enforced by the server: a role's list is what each seat may actually do, and a call outside it is refused; reading the room and leaving it are never gated.
    invite reaches outside its own seat: holding it lets you mint a join code for ANY role this manifest declares, not only your own or the default, so you can seat someone — including yourself, by leaving and rejoining — in the most capable role the room has. revoke is likewise not self-scoped: a seat holding it may retire any role's code, not only its own. Give invite only to a seat you would trust with every seat's authority.
    The manifest sets the room's mode; there is no separate mode argument. A "pair"
    room holds exactly 2 members; a "swarm" room holds as many as you invite, up to
    100 — Bellman's ceiling for one room, the same on every plan.
    The pair and review presets make pair rooms; the swarm and social presets make swarm rooms.
    A manifest may declare a \`host\`, a seat Bellman runs that asks the room a question on each heartbeat and answers replies; it needs the max or team plan, a \`heartbeat_on\` of at least 1h, and a swarm room. The social preset declares one. The host never keeps a room open.
  - brief: your structured context summary (goal, state, constraints, open_questions, agent). This is what a joiner PREVIEWS before committing — write it for outside eyes.
  - capabilities: what you allow peers to do to you (default: read_context, receive_messages). Grant request_actions only if you want peers to be able to ask your session to do things.
  - org_only (boolean): restrict joining to members of your org (team plan)

Returns: { session_id, member_id, join_code, join_url, join_code_expires_at, plan, room: {preset, mode, your_role, your_verbs, heartbeat_on_seconds, you_report, creator_role, roles, reports (per role, whether that seat is asked to report), host ({ role, model } of the hosted seat, or null), text (untrusted envelope)} }
Keep member_id — every subsequent call needs it. The room has no lifetime: it ends when its last member leaves, or after 90 days in which nobody in it was seen. room is the manifest as the server recorded it: a preset comes back expanded, and your_role / your_verbs are yours. Read it back to check it says what you meant.

Plan gating applies to CREATING sessions only; joining is free on every plan.
Errors: "invalid manifest — ..." (a default_role or creator_role that names no role, or a verb repeated within a role) or an input validation error naming the field (a malformed manifest) — either way nothing is created and no quota is spent; "a hosted seat requires..." (plan), "swarm mode requires..." (plan), "org_only sessions require..." (plan), "org_only was set but..." (no org), "hosted room limit reached: ... open" (your plan's hosted rooms are all open; one that closes frees its slot), "monthly session limit..." (quota).`,
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
      // Before the mode check: a hosted room is always a swarm room, and on free the
      // swarm refusal would point at pro, which has no hosted seat either.
      if (manifest.host !== null && ent.hostedRooms === 0) {
        return fail(`a hosted seat requires the max or team plan (you are on "${identity.plan}").`);
      }
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

      // Last of the refusals, because it is the only one that writes: a hosted room takes
      // one of the creator's slots, counted and recorded in one call (I7), and gives it
      // back if the room is not created after all.
      const sessionId = generateSessionId();
      if (manifest.host !== null) {
        const slot = await s.reserveHostedRoom(identity.userId, sessionId, ent.hostedRooms);
        if (!slot.ok) {
          return fail(`hosted room limit reached: ${slot.open} hosted rooms open, the most the "${identity.plan}" plan allows. A hosted room that closes frees its slot.`);
        }
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
        id: sessionId,
        manifest,
        createdBy: identity.userId,
        orgId: identity.orgId,
        orgOnly: org_only,
        joinCodes: { [manifest.defaultRole]: defaultCode },
        // The room's own byte ceiling (#183), from the plan creating it. Nothing
        // downstream asks a plan again.
        blobBytesCeiling: ent.blobBytesPerRoom,
        // The hosted seat's allowance for this month (hosted seat spec, D2), from the plan
        // creating the room. Each later month's is read from the creator's plan then (I7).
        hostUnitsPerMonth: manifest.host === null ? 0 : ent.hostUnitsPerRoom,
        hostUnits: { month: monthKey(now), used: 0, wakes: [] },
        // The window a closed room is kept for (#65, D1), stamped as the ceiling above is: a plan
        // change after the fact never shortens a room that was promised one.
        retainAfterCloseMs: ent.retainAfterCloseMs,
        closedAt: null,
        purgeAt: null,
        blobsSwept: false,
        // The host is seated here, beside the creator, and never joins by code.
        members: manifest.host === null ? [creator] : [creator, hostMember(manifest, now)],
        events: [],
        closed: false,
        frozenAt: null,
      };
      try {
        await s.createSession(session);
      } catch (err) {
        if (manifest.host !== null) await s.releaseHostedRoom(identity.userId, sessionId);
        throw err;
      }
      await s.recordCreate(identity.userId);
      await audit(s, session, identity, "session_created", {
        mode: manifest.mode, org_only, preset: manifest.preset, hosted: manifest.host !== null,
      });

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
