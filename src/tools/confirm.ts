import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, appendOrFrozen, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { UNTRUSTED_PREAMBLE, publicMember, roomPreview, storedMember, untrusted } from "../projections.js";
import type { Brief, Capability, Identity, Member } from "../types.js";
import { FROZEN, announceReclaimed, audit, fullMessage, readSurface } from "../rooms.js";
import { STALE_AFTER_MS } from "../presence.js";
import type { BellmanStore } from "../store.js";

export function registerConfirm(server: McpServer, identity: Identity, s: BellmanStore): void {
  // ------------------------------------------------------------ bellman_confirm
  server.registerTool(
    "bellman_confirm",
    {
      title: "Confirm joining a Bellman session",
      description: `Phase 2 of joining: after your human has reviewed the preview from bellman_connect, ship your brief and become a session member.

Args:
  - connect_token: from bellman_connect (single-use, 10 minute TTL)
  - brief: YOUR structured context summary — this is what crosses to the peer
  - capabilities: what you allow peers to do to you (default: read_context, receive_messages)

You are seated in the role the code you previewed carried. That seat was fixed when you ran bellman_connect: a code revoked in between does not change it, and the connect token's 10-minute TTL bounds the window.

Returns: { session_id, member_id, members[] (each with room_role), room (the same block the preview showed), briefs (untrusted envelopes), surface: { cursor, items (untrusted envelopes) }, cursor }
surface is the room's working surface in full; a later bellman_sync carries each change as a surface event, and surface: true on it returns everything again.
The room's verbs are enforced by the server: a call outside your_verbs is refused, naming the verb you lack. Reading the room and leaving it are never gated.
Keep member_id and cursor — bellman_sync and bellman_send need them.
Errors: "connect token invalid or expired" — re-run bellman_connect.`,
      inputSchema: {
        connect_token: z.string().min(8).max(60),
        brief: BriefShape,
        capabilities: CapabilitiesShape,
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async ({ connect_token, brief, capabilities }): Promise<ToolResult> => {
      const pending = await s.takePendingConnect(connect_token);
      if (!pending || pending.userId !== identity.userId) {
        return fail("connect token invalid or expired. Re-run bellman_connect with the join code.");
      }
      const session = await s.getSession(pending.sessionId);
      if (!session || session.closed) return fail("session no longer exists.");
      if (session.frozenAt !== null) return fail(FROZEN);
      // No capacity check here. It used to be one, and a read-then-write
      // capacity check is the bug: `seatMember` below decides and writes inside
      // the object, so there is no gap for a second confirm to agree on the same
      // seat in, for a sync to make a member live again after it was chosen as a
      // victim, or for a freeze to land on a room that is meant to cost nobody
      // their place.

      // ?? handles a pending row written before roomRole existed (predates
      // commit 62608a9): default to the room's default seat rather than
      // leaving the member permanently stuck holding no role at all, the
      // same legacy-lift rule commit 7d19453 applies to joinCode on read.
      // Hoisted rather than repeated at each use — the seat this member is
      // given and the seat the confirm response shows them must be the same
      // computation, or a legacy row can seat someone correctly and still
      // preview them as "undefined" with no verbs.
      const roomRole = pending.roomRole ?? session.manifest.defaultRole;

      const memberId = `m_${randomUUID().slice(0, 8)}`;
      const member: Member = {
        memberId,
        userId: identity.userId,
        label: identity.label,
        orgId: identity.orgId,
        capabilities: capabilities as Capability[],
        roomRole,
        brief: brief as Brief,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        leftAt: null,
      };
      // The one operation that seats anybody, and the only place a stale seat is
      // reclaimed. Reached only by a caller holding a valid connect token who is
      // about to take the seat — the authority the preview and the `invite` verb
      // do not carry — and every guard that matters is inside it, where there is
      // no gap to land in. It frees one seat, longest-quiet first, or refuses
      // and frees none. When the seat it takes fills the room it retires every
      // role's code in the same transaction (#116), so nothing here follows it to
      // do that: a call after the seat could fail with the member already in.
      const seated = await s.seatMember(
        session.id, member, member.joinedAt - STALE_AFTER_MS, member.joinedAt
      );
      if (seated.refused !== null) {
        // Closed wins over frozen, as it does for a leaver in rooms.ts: telling
        // someone their room is frozen when it is over points them at paying to
        // fix something payment will not.
        if (seated.refused === "not_found" || seated.refused === "closed") {
          return fail("session no longer exists.");
        }
        if (seated.refused === "frozen") return fail(FROZEN);
        return fail(`session filled while you were confirming. ${fullMessage(session.manifest)}`);
      }

      // Announced from what the store actually did, not from what this handler
      // predicted. Nobody is told a member timed out unless that member's seat
      // really was taken, by this joiner, in the write above.
      await announceReclaimed(s, session, identity, seated.reclaimed);

      // Re-read: the store hands back detached copies, so `session` is now stale.
      const joined = (await s.getSession(session.id)) ?? session;
      // Who is on a socket, for the roster's presence below. Advisory: the reclaim,
      // and the retiring of a filled room's codes, were decided inside seatMember,
      // against the sockets then.
      const connected = await s.connectedMembers(joined.id);

      const joinEvent = await appendOrFrozen(s, session.id, {
        type: "member_joined",
        fromMemberId: memberId,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        // `presence` is deliberately not in here. publicMember computes it from
        // the clock, and this event is durable and replayed: a stored
        // "present" would still read as present hours after the member was
        // reaped. Presence is derived, never stored (ARCHITECTURE.md rule 7),
        // so it belongs on live roster responses only.
        payload: { member: storedMember(member), brief },
        refId: null,
      });
      await audit(s, session, identity, "brief_exchanged", {
        joiner: identity.userId,
        agent: brief.agent,
      });

      return ok(
        {
          session_id: session.id,
          member_id: memberId,
          cursor: joinEvent.cursor,
          members: joined.members.map((m) => publicMember(m, connected)),
          room: roomPreview(joined, roomRole),
          briefs: joined.members
            .filter((m) => m.memberId !== memberId)
            .map((m) => untrusted({ memberId: m.memberId, label: m.label }, m.brief)),
          // Every item, in the writer's envelope (#129): the joiner is a member
          // now, as `briefs` already treats them.
          surface: await readSurface(s, joined),
        },
        UNTRUSTED_PREAMBLE
      );
    }
  );
}
