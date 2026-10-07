import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_SECONDS, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { UNTRUSTED_PREAMBLE, untrusted } from "../projections.js";
import type { Identity } from "../types.js";
import { findMember, readSurface, sessionStatus, touchMember } from "../rooms.js";
import { surfaceCursor } from "../surface.js";
import { isActiveMember } from "../store.js";
import type { BellmanStore } from "../store.js";
import { publicEvent } from "../public-event.js";
import { ACTION_REQUEST_TTL_MS, outstandingFor } from "../action-state.js";

export function registerSync(server: McpServer, identity: Identity, s: BellmanStore): void {
  // --------------------------------------------------------------- bellman_sync
  server.registerTool(
    "bellman_sync",
    {
      title: "Sync Bellman session events",
      description: `Fetch events since your cursor. This is how peer messages reach you — MCP has no push, so call this when you finish a thought, after sending something that expects a reply, or when your human goes quiet.

Args:
  - session_id, member_id: your handles
  - since_cursor: last cursor you processed (0 on first call after start; the cursor from bellman_confirm after joining)
  - wait_seconds (0-${MAX_WAIT_SECONDS}): long-poll — the server holds the request until an event arrives or the wait elapses. Use 15-20 when expecting a reply; some MCP clients time out slow tool calls, so stay conservative.
  - surface (boolean, default false): also return the room's working surface in full — every item in an untrusted envelope. Use it after a restart, or when you want the current state without replaying the log.

Returns: { events[] (untrusted envelopes, your own events excluded), cursor, session_status, surface_cursor?, surface?, removed?, outstanding? }
surface_cursor: the cursor of the last change to the working surface, present once it has ever changed. cursor minus surface_cursor is how many events have landed since. A surface event in events[] carries the item that changed; ask for surface: true for all of them.
A member a creator removed sees only items changed at or before its cut, and surface_cursor is the last of those.
outstanding: action requests still waiting, present only when there are any. Each is { cursor, from_member_id, from_label, mine, age_seconds, expires_at }. \`mine: true\` is one YOU sent and the room has not answered; \`mine: false\` is one the room is waiting on YOUR human for — surface it to them. An entry leaves this list when it is answered, declined, or expires 30 minutes after it was sent. It is not re-announced as an event: the request interrupted once when it arrived, and this is what you read when you look.
removed: true means a creator removed you from this room. Your history stays readable, nothing after it will arrive, and there is no point polling again — stop watching this room.
Always pass the returned cursor next time — even an empty events list can advance it.
If a room's creator has removed you, you still get the history up to and including the member_evicted event that removed you, and nothing after it. wait_seconds does not hold the request then: there is nothing to wait for, so stop polling.`,
      inputSchema: {
        session_id: z.string().min(4),
        member_id: z.string().min(4),
        since_cursor: z.number().int().min(0).default(0),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
        surface: z.boolean().default(false),
      },
      annotations: {
        // `readOnlyHint` stays true although this now writes `lastSeenAt`, and
        // the write is shaped so that stays honest. Hosts use this hint to call
        // a tool without asking the human, and this is the poll loop: a hint
        // that made every sync prompt would make the product unusable. The
        // write is a member stamping its own record, it is refused for a
        // closed room, a frozen one and a member that has left, and the only
        // thing it can do is keep that member present — it can never remove
        // anybody or change what any caller reads. Removal lives on
        // bellman_confirm, which is marked as the write it is.
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async ({ session_id, member_id, since_cursor, wait_seconds, surface }): Promise<ToolResult> => {
      const session = await s.getSession(session_id);
      if (!session) return fail("session not found.");
      const me = findMember(session, member_id, identity);
      if (!me) return fail("member_id is not yours.");

      // This is the liveness signal, and the reason #103 needs no heartbeat
      // tool: a watching member long-polls here every ~25 seconds already. It
      // goes BEFORE the wait — the member is alive now, not in 25 seconds — and
      // before `waitForEvents`, so nothing awaits between that call reading the
      // event list and registering its waiter.
      //
      // Guarded, because this tool is otherwise free of guards on purpose:
      // reads stay open to a closed room, a frozen one, and a member who has
      // left. A member a creator REMOVED reads its history and nothing after it
      // (#113), which is still a read: this tool cannot remove anybody or change
      // what any other caller sees. Writing on those paths would have a
      // departed member's watcher rewriting a closed room's record every 25
      // seconds forever.
      await touchMember(s, session, me);

      // A member a creator removed reads its history and nothing after it
      // (#113). The cut is the cursor of the `member_evicted` event that
      // removed them, and the comparison is `<=` so that event is the last
      // thing they receive: the feed says why it stopped.
      //
      // Only an eviction cuts. A member who left of their own accord, and one
      // whose seat timed out, both read on — the first chose to go, and the
      // second is the server guessing, not a decision that they should be out.
      //
      // `wait_seconds` is ignored on this arm, and that is not an
      // optimisation. A cut member that still long-polled would wake on every
      // append it then hides, turning a 25-second poll into a busy loop
      // against a room it cannot read. There is nothing coming: its feed has a
      // last event and that event is in the past.
      const cut = me.removedAtCursor;
      const read = cut === undefined
        ? await s.waitForEvents(session_id, since_cursor, wait_seconds * 1000)
        : (await s.eventsAfter(session_id, since_cursor)).filter((e) => e.cursor <= cut);

      // The status is the room's as it is when this poll answers, not as it was when the
      // call began (#74). `session` is from before the wait, which is up to `wait_seconds`
      // ago, and a room that froze or closed meanwhile would still read `active` here. A
      // freeze appends nothing, so it does not even end the poll, and the first the agent
      // learned of it was a refused `bellman_send`. Read after the events, so the status
      // is never older than they are: a poll woken by `session_expired` cannot report an
      // open room beside it.
      //
      // Only when the poll could have waited. A removed member's arm does not (the cut
      // ignores `wait_seconds`, above) and neither does a poll that asked for none, so for
      // them `session` is milliseconds old and a read would be a round trip on every poll
      // to repair nothing. `closeIfEmpty` takes its status from a read after its work too,
      // and not from the record it was handed. This record is used for the status alone:
      // the removal's cap and the `removed` flag below keep the record the call began
      // with, and say why in their own comments.
      //
      // Captured rather than consumed inline, because the action-request stamp
      // below wants the same thing for the same reason and must not pay for a
      // second read to get it.
      const answering = cut === undefined && wait_seconds > 0
        ? (await s.getSession(session_id)) ?? session
        : session;
      const status = sessionStatus(answering);

      // A removal that committed after `me` was read is not on `me`. The record,
      // `touchMember` and the event read above are separate calls, and on Workers
      // each is an RPC, so a creator's `bellman_evict` can land between the first
      // and the last and leave this poll on the arm that has no cap. A poll that
      // waits is not exposed: it is resolved with the event that woke it and
      // never reads again. This one finds the removal already stored, so the read
      // returns everything past `since_cursor` and registers no waiter, and the
      // member is handed the room past the cut, peer content included.
      //
      // The slice says so itself. Every cursor this member holds predates the
      // removal, and the removal's event is numbered after all of them, so a poll
      // that can leak has `since_cursor` below the cut and the slice holds this
      // member's own `member_evicted`. That event carries the cursor the record
      // would have. It is the event and not a second `getSession`: read before
      // the events, a second record leaves the same window one call later, and
      // read after them it closes it but costs a round trip on every poll to
      // guard a gap of milliseconds. The event is already in hand. Only the
      // server writes `member_evicted` (a peer cannot send one; see SEND_KINDS),
      // so what is read off its payload is the server's.
      //
      // Only for a member `me` shows still IN the room. A cut member is never
      // active, since the cut sets `leftAt` in the same write, so the arm above
      // has already answered for them. One who left of their own accord, or whose
      // seat timed out, keeps the open feed (R2), and the event does not prove a
      // cut for them: `markRemoved` declines a member who has left, so a leave
      // landing between `evictMember` reading the roster and appending leaves a
      // `member_evicted` in the log naming someone with no `removedAtCursor`
      // (spec D3). No handler clears `leftAt` once it is set, so a record that
      // shows it set cannot belong to a member cut after it, and skipping those
      // costs the leak nothing.
      const removal = isActiveMember(me)
        ? read.find(
            (e) =>
              e.type === "member_evicted" &&
              (e.payload as { member_id?: string } | null)?.member_id === member_id
          )
        : undefined;
      const all = removal === undefined ? read : read.filter((e) => e.cursor <= removal.cursor);
      // `since_cursor` and not the cut when the slice is empty: a caller that
      // asked from past its cut gets its own cursor back, so round-tripping it
      // stays put instead of re-requesting the same empty range forever.
      const cursor = all.length > 0 ? all[all.length - 1].cursor : since_cursor;
      const foreign = all.filter((e) => e.fromMemberId !== member_id);

      // Every event, not the slice. A request made before `since_cursor` is
      // still outstanding, and the point of this list is what the caller is
      // WAITING ON rather than what just happened — a slice would show a
      // request once, on the poll that carried it, and never again.
      //
      // Capped at the cut for the same reason the slice is: a removed member
      // reads its history and nothing after it (#113), and a request that
      // arrived after they were cut is not theirs to answer or to wait on.
      //
      // The cost is a full read of the log on every poll. That is bounded by
      // the room's TTL rather than by anything here, and the fix if it stops
      // being enough is a stored cursor for the last `action_request`, which
      // turns this into a bounded tail read.
      // The guard that keeps this off the common path. `lastActionRequestAt` is
      // the only thing read from the record here, and it decides whether the log
      // is worth reading at all — never what any request's state is, which stays
      // derived.
      //
      // Absent: no `action_request` has ever been appended, so nothing can be
      // outstanding. Older than the TTL: the NEWEST request has expired, so all
      // of them have. Either way the answer is the empty list, and a full read
      // of the log would produce it the expensive way — on every poll, from
      // every watcher, for the whole life of a room that may never use the
      // feature at all.
      //
      // What is left unbounded is a room with a request inside the last half
      // hour, which still reads its whole log. That is the set actually using
      // the feature, and bounding it further needs a floor cursor this stamp
      // cannot give: a response may sit far behind the newest request, so there
      // is no single cursor to start from without tracking the oldest OPEN one.
      // From the record this poll ANSWERS with, not the one it began with. A long
      // poll holds for up to `wait_seconds`, and the append that wakes it may be
      // the very `action_request` this is deciding about: read off the pre-wait
      // snapshot the stamp was absent, so the read was skipped and the response
      // carried the request event with no `outstanding` entry beside it — the
      // one case the field exists for, missing it.
      const stampedAt = (answering as { lastActionRequestAt?: number }).lastActionRequestAt;

      // Or the slice itself carries one. The stamp is a separate write from the
      // event, so between this poll's record read and its event read a request
      // can land that the record does not know about yet. The events are the
      // truth here as everywhere; the stamp is only the cheap way to skip them.
      // Within the TTL, not merely present: a request older than that is expired
      // and cannot be outstanding, so an old one sitting in the slice of a poll
      // that asked from cursor 0 must not drag the whole log back in.
      const askedInSlice = read.some(
        (e) => e.type === "action_request" && Date.now() <= e.at + ACTION_REQUEST_TTL_MS
      );

      const mayHaveOutstanding =
        askedInSlice
        || (stampedAt !== undefined && Date.now() <= stampedAt + ACTION_REQUEST_TTL_MS);

      const everything = mayHaveOutstanding ? await s.eventsAfter(session_id, 0) : [];
      // BOTH caps, not just the recorded one. `cut` is the removal as the record
      // shows it; `removal` is the `member_evicted` found in the slice, and it
      // exists because an eviction that committed after `me` was read leaves
      // `cut === undefined` on a record that is already stale — the race line 148
      // caps `all` for. Testing only `cut` here handed a member the room past
      // their own removal through this field: every action_request appended after
      // they were cut, with its sender's member id, label and cursor.
      const stopAt = cut ?? removal?.cursor;
      const visible = stopAt === undefined ? everything : everything.filter((e) => e.cursor <= stopAt);
      // A member who has left or been removed is told nothing is waiting on
      // them, because nothing can be: `bellman_send` refuses their handle, so an
      // `action_response` is not a thing they can produce. `mine: false` says
      // "the room is waiting on your human", and saying that to someone who
      // cannot answer is the same class of untruth as the rest of this branch.
      //
      // Their OWN requests still show. Those are what they were waiting on when
      // they went, and reading the room is something a departed member may still
      // do — the eviction cut above already bounds how much.
      const outstanding = outstandingFor(visible, member_id, Date.now())
        .filter((o) => o.mine || isActiveMember(me));

      // The surface's cursor, and the surface when it was asked for, capped by
      // `stopAt` above: a removed member reads its history and nothing after it.
      //
      // A member still in the room gets the record's number, off the record the
      // poll ANSWERS with for the reason `status` is read off it: never older
      // than the events beside it.
      //
      // A removed member gets one derived from what it is shown, never the
      // record's. The record's number, capped at the cut, claims a change AT the
      // cut when nothing had changed by then, and tells a member removed from a
      // still-empty room that the surface changed after it was out. Derived
      // means `readSurface`'s, so a poll that asked for no surface has none to
      // send: it reads no rows, and that member has been told `removed: true`
      // and its feed has ended.
      const surfaceBlock = surface ? await readSurface(s, answering, stopAt) : undefined;
      const sfCursor = stopAt === undefined ? surfaceCursor(answering) : (surfaceBlock?.cursor ?? 0);

      return ok(
        {
          events: foreign.map((e) =>
            untrusted({ memberId: e.fromMemberId, label: e.fromLabel }, publicEvent(e))
          ),
          cursor,
          session_status: status,
          // Only when nonzero, as `outstanding` and `removed` are: a room with
          // no surface does not grow a field, and a client that has never
          // heard of it keeps working.
          ...(sfCursor > 0 ? { surface_cursor: sfCursor } : {}),
          ...(surfaceBlock !== undefined ? { surface: surfaceBlock } : {}),
          // Only when there are any, as `replayed` and `ambient` are: a client
          // that has never heard of it keeps working, and a quiet room's poll
          // does not grow a field saying nothing is pending.
          //
          // It rides the poll rather than arriving as an event, deliberately.
          // An `action_request` already interrupts once (src/attention.ts); a
          // second event re-raising it would interrupt a working member again
          // for something it is not being asked to do now. This is here for
          // when it looks, which is what looking is for.
          ...(outstanding.length > 0 ? { outstanding } : {}),
          // Only when true, as `replayed` and `ambient` are: a client that has
          // never heard of it keeps working, and the twelve-field shape every
          // other poll returns does not change.
          //
          // It exists because the cut is otherwise INVISIBLE to the caller. A
          // member polling from past it gets an empty slice and
          // `session_status: "active"`, which reads exactly like a quiet room.
          // The `member_evicted` event is the other signal, and a client that
          // restarted after the removal can never see it — its cursor is already
          // past it — so it would poll forever. The socket cannot tell it either:
          // Node's undici collapses a /ws 403 into the same bare `error` event as
          // a 503 (room-socket.ts says so), so the status is unreadable there.
          // This flag is the one signal that survives both, and it is on every
          // poll rather than once, because "once" is what the event already was.
          //
          // From the RECORDED cut only, and deliberately not from `removal`.
          //
          // The cap may be read off the event in the slice, because a wrong cap
          // costs one poll: the next one reads a fresh record and the feed
          // reopens. This flag cannot. A client reads it as "stop asking" and
          // marks the handle departed for the life of the process
          // (`markDeparted` in src/bridge.ts), so emitting it wrongly ends a
          // feed for good, and nothing self-heals.
          //
          // Wrongly is reachable: `me` read before a leave shows the member
          // active, the leave commits, the eviction appends, and `markRemoved`
          // declines the cut (spec D3) — leaving a `member_evicted` in the slice
          // naming a member R2 gives the open feed. The event is evidence that
          // an eviction was ATTEMPTED, not that a cut was recorded, and only the
          // record can say the second. A genuine eviction loses nothing by the
          // wait: this poll is still capped by the event, and the next poll
          // reads the committed cursor and sets the flag.
          ...(cut !== undefined ? { removed: true as const } : {}),
        },
        foreign.length > 0 ? UNTRUSTED_PREAMBLE : undefined
      );
    }
  );
}
