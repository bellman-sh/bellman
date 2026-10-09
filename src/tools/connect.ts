import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { UNTRUSTED_PREAMBLE, roomPreview, surfaceIndex, untrusted } from "../projections.js";
import type { Identity } from "../types.js";
import { surfaceCursor } from "../surface.js";
import { MAX_JOIN_CODE_LENGTH, generateConnectToken, normalizeJoinCode } from "../codes.js";
import { activeMembers, audit, fullMessage, seatedMembers } from "../rooms.js";
import { CONNECT_TOKEN_TTL, capacityOf } from "../store.js";
import type { BellmanStore } from "../store.js";
import { APP_UI_META } from "../ui/resource.js";

export function registerConnect(server: McpServer, identity: Identity, s: BellmanStore): void {
  // ------------------------------------------------------------ bellman_connect
  server.registerTool(
    "bellman_connect",
    {
      title: "Preview a Bellman session by join code",
      description: `Phase 1 of joining: look up a join code and PREVIEW the creator's brief WITHOUT sharing any of your own context yet.

Show the returned preview to your human. If they want to proceed, call bellman_confirm with the connect_token and your own brief. Nothing about your session crosses the wire until bellman_confirm.

Args:
  - join_code (string): e.g. "BELL-7F3K-92-REVIEWER" (case, whitespace and _/- insensitive)

Returns: { connect_token, connect_token_expires_at, session: {mode, active_members, max_members, org_only}, room: {preset, mode, public, your_role, your_verbs, heartbeat_on_seconds, you_report, creator_role, roles, reports (per role, whether that seat is asked to report), host ({ role, model } of the hosted seat, or null), housekeeping ({ quiet_after_seconds, answer_within_seconds, idle_after_seconds, repeat_after_seconds }, each null when off, or null when the room names no one), text (untrusted envelope)}, creator_brief (untrusted envelope), surface: { cursor, items: [{ key, kind, chars, cursor, at, by }] } }
max_members is the room's capacity: 2 for a pair room, 100 for a swarm room — Bellman's ceiling for one room, the same on every plan, not a plan limit.
surface lists what the room's working surface holds — keys, kinds and sizes, no content. The items themselves come with bellman_confirm.
public: true means anyone with the room's link can read its surface and its log, though never a brief: tell your human before they accept.
The code's last group names the seat it grants, and your_role/your_verbs in the preview are that seat — not the room's default. A code with a hand-edited role group is not a code that was issued, and does not resolve.
The room's verbs are enforced by the server, so your_verbs is what your seat may actually do — not the creator's intent, and a peer may still withhold the capability to receive it. A call outside it is refused with an error naming the verb you lack; reading the room and leaving it are never gated.
Errors: "join code not found or expired" — codes are single-use and expire 15 minutes after creation if unused. "session is org-restricted" — creator limited joining to their org.`,
      inputSchema: { join_code: z.string().min(4).max(MAX_JOIN_CODE_LENGTH) },
      annotations: {
        // `readOnlyHint` is FALSE, and this tool previews rather than joins (#119).
        // It writes twice: a pending-connect record, which is what carries the seat
        // the code named until bellman_confirm claims it, and a `connect_previewed`
        // audit row. MCP defines the hint as "the tool does not modify its
        // environment", and a durable token plus a row another caller reads are
        // modifications. #112 settled how this repo resolves that: a documented
        // exception to a boolean claim means the boolean is wrong.
        //
        // The cost is accepted, not overlooked. A host may put a confirmation in
        // front of a preview that discloses nothing of the caller's, which is the
        // opposite of what two-phase joining is for. It is tolerable because this
        // is a ONE-SHOT the human already initiated — they were handed a join code
        // out of band and asked for it to be used — so a prompt lands where the
        // human is already present.
        //
        // That is also why bellman_sync's exception does not extend here. Sync
        // keeps `readOnlyHint: true` over its own `lastSeenAt` write because it is
        // an unattended poll called every few seconds, where a prompt would make
        // the product unusable, and because its write can only keep the caller
        // present. This one's audit row is read by somebody else: an org seeing who
        // previewed its rooms is the point of per-org audit, so the write is
        // visible by design and the claim cannot be rescued.
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
      // Rendered as the join screen by a host that supports MCP Apps; the text
      // result is unchanged for every other host (#28).
      _meta: APP_UI_META,
    },
    async ({ join_code }): Promise<ToolResult> => {
      const hit = await s.getSessionByJoinCode(normalizeJoinCode(join_code));
      if (!hit) {
        return fail("join code not found or expired. Codes expire 15 minutes after creation if unused, and are consumed when a pair session fills. Ask the creator to start a new session.");
      }
      const { session, role } = hit;
      if (session.orgOnly && session.orgId !== identity.orgId) {
        return fail("session is org-restricted and your identity is not in the creator's org.");
      }
      // Seated, not active: a room held full by a session that died is
      // previewable rather than refused here and at every retry for good
      // (#103). This only counts. The stale seat is reclaimed by the
      // bellman_confirm that follows, so a preview removes nobody — which is the
      // rule whether or not the annotation claims read-only (it no longer does,
      // see #119 above): ANY holder of a join code can call this, repeatedly, and
      // reaching a seat is bellman_confirm's authority and not a previewer's. A
      // member on a socket is counted, because the confirm that follows will not
      // reclaim it either.
      const connected = await s.connectedMembers(session.id);
      if (seatedMembers(session, Date.now(), connected).length >= capacityOf(session.manifest)) {
        return fail(fullMessage(session.manifest));
      }
      const creator = session.members[0];
      const token = generateConnectToken();
      await s.putPendingConnect({
        token,
        sessionId: session.id,
        userId: identity.userId,
        roomRole: role,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      });
      await audit(s, session, identity, "connect_previewed", {});

      // The index, not the items (#129, D7/D9): a code holder who never joins
      // is shown that the room keeps a plan and a diagram, not their contents —
      // the line that keeps joiners' briefs out of this preview.
      const index = surfaceIndex(await s.surfaceOf(session.id));

      return ok(
        {
          connect_token: token,
          connect_token_expires_at: new Date(Date.now() + CONNECT_TOKEN_TTL).toISOString(),
          session: {
            mode: session.manifest.mode,
            active_members: activeMembers(session).length,
            max_members: capacityOf(session.manifest),
            org_only: session.orgOnly,
          },
          room: roomPreview(session, role),
          creator_brief: untrusted(
            { memberId: creator.memberId, label: creator.label },
            creator.brief
          ),
          surface: { cursor: surfaceCursor(session), items: index },
        },
        UNTRUSTED_PREAMBLE +
          "\n\nShow this preview to your human before calling bellman_confirm — confirming ships YOUR brief to the peer."
      );
    }
  );
}
