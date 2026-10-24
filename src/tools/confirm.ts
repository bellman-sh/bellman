import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, appendOrFrozen, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { UNTRUSTED_PREAMBLE, publicMember, roomPreview, storedMember, untrusted } from "../projections.js";
import { BANNED } from "../bans.js";
import { forbiddenCapabilityRefusal, joinRefusal } from "../orgs.js";
import { seesBrief } from "../public-event.js";
import type { ArrivingMember, Brief, Capability, Identity } from "../types.js";
import { FROZEN, announceReclaimed, audit, fullMessage, readSurface } from "../rooms.js";
import { STALE_AFTER_MS } from "../presence.js";
import { isActiveMember, lastSeen, rosterHasOrgless } from "../store.js";
import type { BellmanStore } from "../store.js";
import { APP_UI_META } from "../ui/resource.js";

/**
 * How many briefs a joiner is handed: those of the members heard from most recently
 * (ADR 0018). A room seats thousands, and a joiner's agent reads all it is handed.
 */
export const BRIEFS_ON_JOIN = 25;

export function registerConfirm(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_confirm",
    {
      title: "Confirm joining a Bellman session",
      description: `Phase 2 of joining: after your human has reviewed the preview from bellman_connect, ship your brief and become a session member.

Args:
  - connect_token: from bellman_connect (single-use, 10 minute TTL)
  - brief: YOUR structured context summary — this is what crosses to the room
  - capabilities: what you allow peers to do to you (default: read_context, receive_messages). read_context lets peers read your brief; it is on by default, and without it only you see your brief.

You are seated in the role the code you previewed carried. That seat was fixed when you ran bellman_connect: a code revoked in between does not change it, and the connect token's 10-minute TTL bounds the window.

Returns: { session_id, member_id, members[] (each with room_role), room (the same block the preview showed), briefs (untrusted envelopes, from the ${BRIEFS_ON_JOIN} members heard from most recently), briefs_omitted (how many other present members' briefs were left out), surface: { cursor, items (untrusted envelopes), frames, window, next }, cursor }
surface is the room's working surface's front window; a later bellman_sync carries each change as a surface event, and surface: true on it returns everything again.
The room's verbs are enforced by the server: a call outside your_verbs is refused, naming the verb you lack. Reading the room and leaving it are never gated.
Keep member_id and cursor — bellman_sync and bellman_send need them.
Errors: "connect token invalid or expired" — re-run bellman_connect. "your org's policy does not allow rooms with org ..." / "org ...'s policy does not allow members of your org" (policy, both sides of the join, read again here so a policy tightened since the preview still binds), "your org's policy forbids granting ... to peers" (policy).`,
      inputSchema: {
        connect_token: z.string().min(8).max(60),
        brief: BriefShape,
        capabilities: CapabilitiesShape,
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
      // Rendered as the room's canvas by a host that supports MCP Apps: the
      // result already carries session_id, room and surface (canvas spec D3).
      _meta: APP_UI_META,
    },
    async ({ connect_token, brief, capabilities }): Promise<ToolResult> => {
      // The joiner's own org's rule on what it may grant, read before the token is taken: the token
      // is single-use, and the refusal says "call again without it" (ADR 0006, every refusal before
      // any write). The checks that need the room follow the take, since they read the room as it is now.
      const joinerOrg = identity.orgId ? await s.getOrg(identity.orgId) : undefined;
      const forbidden = joinerOrg ? forbiddenCapabilityRefusal(joinerOrg.policy, capabilities) : null;
      if (forbidden) return fail(forbidden);
      const pending = await s.takePendingConnect(connect_token);
      if (!pending || pending.userId !== identity.userId) {
        return fail("connect token invalid or expired. Re-run bellman_connect with the join code.");
      }
      const session = await s.getSession(pending.sessionId);
      if (!session || session.closed) return fail("session no longer exists.");
      if (session.frozenAt !== null) return fail(FROZEN);
      // A preview holds its token for ten minutes, so a creator-wide ban made since is read again
      // here, from the registry, as the preview read it. A ban on this room alone is the seating's,
      // below, where the room's own record cannot move under the read.
      if (await s.isBannedByCreator(session.createdBy, identity.userId)) return fail(BANNED);
      // The policies the preview checked, read again over the room as it is now (ADR 0031): the
      // orgs in it may have grown since, and a policy may have tightened.
      const barred = await joinRefusal((id) => s.getOrg(id), identity.orgId, session.orgs, rosterHasOrgless(session));
      if (barred) return fail(barred);
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
      const member: ArrivingMember = {
        memberId,
        userId: identity.userId,
        label: identity.label,
        orgId: identity.orgId,
        capabilities: capabilities as Capability[],
        roomRole,
        // How the seat was taken, as the preview recorded it: a seat through a permanent code is a stranger's.
        ...(pending.via ? { via: pending.via } : {}),
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
        // Named, and before the message below: that one is what every refusal left unnamed
        // reads as, and a banned account is never told the room is full.
        if (seated.refused === "banned") return fail(BANNED);
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
        payload: { member: storedMember({ ...member, agent: member.brief.agent }), brief },
        refId: null,
      });
      // The roster after the seat, not the one read before it: a member this seat displaced
      // is out of the room, and was never shown the joiner's brief.
      await audit(s, session, identity, "brief_exchanged", {
        joiner: identity.userId,
        agent: brief.agent,
      }, [], joined.members);

      // The briefs of the members heard from most recently, not everyone's (ADR 0018): a room
      // seats thousands, and a joiner's agent reads all it is handed. A member who has left
      // is not among them, and `briefs_omitted` counts the present members not shown.
      //
      // A brief its author keeps (no `read_context`) is not handed, unless it is this joiner's own
      // account's (read_context design, D3). That is decided before the cut, so a brief kept back does
      // not take one of the places from a brief that could be read (plan ruling R7). `briefs_omitted`
      // counts it as it counts any brief not handed: the roster above shows each member's capabilities,
      // so the count tells the joiner nothing the roster did not.
      const peers = joined.members
        .filter((m) => m.memberId !== memberId && isActiveMember(m))
        .sort((a, b) => lastSeen(b) - lastSeen(a));
      const readable = peers.filter((m) => seesBrief(m, identity.userId)).slice(0, BRIEFS_ON_JOIN);
      const shownBriefs = await s.getBriefs(joined.id, readable.map((m) => m.memberId));
      const shown = readable.filter((m) => shownBriefs[m.memberId] !== undefined);

      return ok(
        {
          session_id: session.id,
          member_id: memberId,
          cursor: joinEvent.cursor,
          members: joined.members.map((m) => publicMember(m, connected)),
          room: roomPreview(joined, roomRole, identity.userId),
          briefs: shown.map((m) => untrusted({ memberId: m.memberId, label: m.label }, shownBriefs[m.memberId])),
          briefs_omitted: peers.length - shown.length,
          // Every item, in the writer's envelope (#129): the joiner is a member
          // now, as `briefs` already treats them.
          surface: await readSurface(s, joined),
        },
        UNTRUSTED_PREAMBLE
      );
    }
  );
}
