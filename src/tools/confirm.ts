import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, appendOrFrozen, fail, ok, renderedLength, roomInstructionsField, type ToolResult } from "./kit.js";
import { UNTRUSTED_PREAMBLE, publicMember, roomPreview, storedMember, untrusted } from "../projections.js";
import { BANNED } from "../bans.js";
import { homeTitles } from "../memory.js";
import { forbiddenCapabilityRefusal, joinRefusal } from "../orgs.js";
import { seesBrief } from "../public-event.js";
import type { ArrivingMember, Brief, Capability, Identity } from "../types.js";
import { FROZEN, announceReclaimed, audit, fullMessage, mostThatFits, readSurfaceWithin } from "../rooms.js";
import { STALE_AFTER_MS, type Presence } from "../presence.js";
import { isActiveMember, lastSeen, rosterHasOrgless } from "../members.js";
import type { BellmanStore } from "../storage/store.js";
import { APP_UI_META } from "../ui/resource.js";

/**
 * How many briefs a joiner is handed: those of the members heard from most recently
 * (ADR 0018). A room seats thousands, and a joiner's agent reads all it is handed.
 */
export const BRIEFS_ON_JOIN = 25;

/**
 * The whole reply's ceiling in characters as `ok` renders it, and `recall`'s own inside it (ADR 0047 decision 9). A
 * join to a busy room once returned 72,450 characters, 63,274 of them the surface, and the client saved it to a file
 * instead of reading it.
 */
export const CONFIRM_REPLY_CHARS = 24_000;
export const RECALL_CHARS = 4_000;

const PRESENCE_RANK: Record<Presence, number> = { present: 0, stale: 1, departed: 2 };

export function registerConfirm(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_confirm",
    {
      title: "Confirm joining a Bellman session",
      description: `Join, step 2: after your human reviews bellman_connect's preview, send your brief and take your seat.

Args:
  - connect_token: from bellman_connect (single-use, expires in 10 minutes)
  - brief: YOUR context summary; this crosses to the room
  - capabilities: what peers may do to you (default read_context, receive_messages). read_context lets peers read your brief; without it only you see it.

Your seat is the role the previewed code carried, fixed at bellman_connect: revoking the code since does not change it.

Returns: { session_id, member_id, members[] (present first, each with room_role), room (as previewed), recall: { home (your home-note paths, newest first; read one with bellman_memory), home_omitted }, briefs (untrusted envelopes, from the ${BRIEFS_ON_JOIN} members heard from most recently), briefs_omitted (how many other present members' briefs were left out), surface: { cursor, items (untrusted envelopes), frames, window, next }, room_instructions? (as in bellman_connect), cursor }
surface is the front window. The whole reply is at most 24,000 characters: surface items are cut first (next pages the rest), briefs second. bellman_sync carries each later change as a surface event and returns the front window with surface: true; bellman_surface pages with next or reads a frame.
Verbs are enforced by the server: a call outside your_verbs is refused, naming the verb you lack. Reading the room and leaving it are never gated.
Keep member_id and cursor: bellman_sync and bellman_send need them.
Errors: "connect token invalid or expired": re-run bellman_connect. "your org's policy does not allow rooms with org ..." / "org ...'s policy does not allow members of your org" (policy, either side of the join, checked again here), "your org's policy forbids granting ... to peers".`,
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

      // One budget for the whole reply (ADR 0047 decision 9), filled in its order: the handles, the cursor, the room
      // and the instructions are never cut; recall has its own ceiling inside it; members ride whole, present first;
      // then briefs and the surface, of which the surface is cut first and briefs second. Surface items and briefs
      // ride in their writers' envelopes (#129): the joiner is a member now.
      const fits = (output: Record<string, unknown>) => renderedLength(output, UNTRUSTED_PREAMBLE) <= CONFIRM_REPLY_CHARS;
      const head: Record<string, unknown> = {
        session_id: session.id,
        member_id: memberId,
        cursor: joinEvent.cursor,
        room: roomPreview(joined, roomRole, identity.userId),
        ...(await roomInstructionsField(s, joined.id)),
      };
      const titles = await homeTitles(s, identity);
      const recallOf = (k: number) => ({ home: titles.slice(0, k), home_omitted: titles.length - k });
      head.recall = mostThatFits(titles.length, recallOf, (r) => renderedLength(r) <= RECALL_CHARS && fits({ ...head, recall: r })).value;
      head.members = joined.members.map((m) => publicMember(m, connected)).sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]);
      const withBriefs = (k: number) => ({
        ...head,
        briefs: shown.slice(0, k).map((m) => untrusted({ memberId: m.memberId, label: m.label }, shownBriefs[m.memberId])),
        briefs_omitted: peers.length - k,
      });
      const surface = await readSurfaceWithin(s, joined, (block) => fits({ ...withBriefs(shown.length), surface: block }));
      return ok({ ...mostThatFits(shown.length, withBriefs, (o) => fits({ ...o, surface })).value, surface }, UNTRUSTED_PREAMBLE);
    }
  );
}
