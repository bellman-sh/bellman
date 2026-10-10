import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ActionResponseShape, BriefShape, ProgressShape, SEND_KINDS, SEND_VERB, appendOrFrozen, fail, ok,
} from "./kit.js";
import type { ToolResult } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { Brief, Identity, SessionEvent } from "../types.js";
import { denyVerb } from "../roles.js";
import { FROZEN, activeMembers, audit, findMember, touchMember, writeSurface } from "../rooms.js";
import type { AppendExtras, BellmanStore, EventWrite } from "../store.js";
import type { BlobStore } from "../blobs.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH, PayloadTooDeepError, assertPayloadDepth } from "../payload.js";

export function registerSend(server: McpServer, identity: Identity, s: BellmanStore, blobs: BlobStore): void {
  // --------------------------------------------------------------- bellman_send
  server.registerTool(
    "bellman_send",
    {
      title: "Send to Bellman session members",
      description: `Send a message, artifact, action request, action response, brief update, progress report, or a surface item to the room.

Args:
  - session_id, member_id: your handles from start/confirm
  - type:
      "message"        — free-form text for the room's agents and their humans
      "artifact"       — code/doc/data payload ({ name, content })
      "action_request" — ask the room to do something. Only members that granted request_actions may act on it, and THEIR HUMAN approves, not their agent.
                         It ends in exactly one of three states and cannot sit between them: answered, declined (a human said no), or expired (30 minutes passed and nobody did). Silence and refusal are different answers, and this is what tells them apart. Until it ends it appears in every member's bellman_sync as \`outstanding\`. An answer that arrives after the deadline still lands and still counts.
      "action_response"— answer an action_request; set ref_id to the request's cursor id and include { approved: boolean, result?: string }
      "brief_update"   — replace your brief as things progress (payload = full Brief object)
      "progress"       — answer the room's heartbeat: where you are now ({ note, step?, eta_seconds? }). Peers are not interrupted by it; it reaches them when they next look.
      "surface"        — write or replace a named item on the room's working surface, or remove one. Payload { key, kind, title?, body?, ends?, placement?, blob?, shape? } or { key, remove: true }.
                         Kinds: text (markdown in body), link (an http/https URL in body), diagram (mermaid source in body), connector (ends: { from, to } naming two items on the surface; no placement), file and image (blob: { id } naming a blob uploaded to this room — POST /rooms/:id/blobs, or the bridge's bellman_upload, which uploads and places in one call; no body; the item comes back with the object's bytes, type and name, and an image needs a blob stored as image/png, image/jpeg, image/gif or image/webp), html (a self-contained page: the page inline in body, or blob: { id } naming a blob stored as text/html (uploaded as for a file, or bellman_upload with kind: "html"), never both; the panel renders it only inside a sandboxed frame on another origin, where its inline script and style and data: images work and it gets no cookies, no parent, no navigation, no popups, no downloads, no forms and no network through anything the policy governs (fetch, sockets, beacons; WebRTC is outside it in Chromium, so a page naming a STUN or TURN server reaches that host) — inline any library it needs; the bytes are the artifact, whatever they claim to be), shape (shape: { form: rect, ellipse, diamond, arrow or line, color?: slate, blue, green, amber, red or violet, or a hex such as #3b82f6, flip?: true draws an arrow or a line from the bottom-left to the top-right }; placement { x, y, w, h } required; the label is title; no body). placement is { x, y, w?, h? }: x and y unbounded, w and h positive when given.
                         Needs the write_surface verb. Items replace by key; at most 64 per room, body at most 8,000 characters, title 120. Peers read the surface on join and whenever it changes — keep the plan and decisions there rather than in messages. Every version stays in the room's history.
  - payload: object, ≤ ${MAX_PAYLOAD_CHARS} chars serialized and ≤ ${MAX_PAYLOAD_DEPTH} levels deep. Both bounds matter: a deeply nested payload can be small and still be undeliverable, so flatten rather than nest.
  - ref_id: the cursor of the event you are answering; a room's host answers only replies that carry its question's cursor. Required for action_response.
  - idempotency_key: optional. Names this send. Retrying with the SAME key returns the original result instead of delivering a second copy — use it when a call timed out or the connection dropped and you cannot tell whether it landed. Use a fresh key for a new message; reusing one for different content is an error.

Returns: { room_members, cursor, replayed? }
  - room_members: the OTHER active members this call saw just before appending — your own seat is not in it, and on a replayed send it is who was there at the retry rather than at the original append. It is NOT a read receipt. It does not mean a peer's session has seen this (that happens on its next bellman_sync), that its model acted on it, or — for action_request — that any human has approved it. The store is truth; the channel is transport.
  - replayed: true means this key had already been used and nothing new was sent.
Errors: a verb your role does not hold is refused by name, and nothing is delivered. Capability errors name the member lacking the grant. A surface write names the field or the rule it broke.`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4),
        type: z.enum(SEND_KINDS),
        payload: z.record(z.string(), z.unknown()),
        ref_id: z.string().optional(),
        idempotency_key: z.string().min(8).max(80).optional(),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      const { member_id, type, payload, ref_id, idempotency_key } = args;
      // The whole sequence — guards, shape, rows, append, audit — is one
      // operation in rooms.ts, shared with the HTTP route that piece 3 adds.
      // Handled before the common guards below, which writeSurface runs itself.
      if (type === "surface") {
        const out = await writeSurface(s, blobs, identity, session_id, member_id, payload, idempotency_key);
        if (!out.ok) return fail(out.reason);
        return ok({
          room_members: out.value.roomMembers,
          cursor: out.value.cursor,
          ...(out.value.replayed ? { replayed: true } : {}),
        });
      }

      const session = await s.getSession(session_id);
      if (!session || session.closed) return fail("session not found or closed.");
      if (session.frozenAt !== null) return fail(FROZEN);
      const me = findMember(session, member_id, identity);
      if (!me || me.leftAt !== null) return fail("member_id is not yours or has left the session.");

      // Sending is as good a sign of life as polling. Before the verb check, so
      // a member whose role forbids this kind still counts as present — it is
      // here, and refusing the send does not make it absent.
      await touchMember(s, session, me);

      // Authority first: before the payload, before who is listening. A seat that
      // may not act hears why, rather than being sent off to shorten a message it
      // was never allowed to send or learning who is present by probing. Which verb
      // each kind needs is SEND_VERB's business, at the top of the file.
      const denial = denyVerb(session, me, SEND_VERB[type]);
      if (denial) return fail(denial);

      // Depth before length, because length cannot stand in for it: `{"a":`
      // costs about six characters a level, so a payload can pass the length
      // bound and still nest past where a projected event's own JSON.stringify
      // overflows — one level deeper than this handler's, inside publicEvent's
      // wrapper. Such a row is durable, and SessionDO.fetch projects every
      // missed event with no per-event guard, so one of them makes the room
      // unwatchable over /ws forever: every later connect from before its
      // cursor replays it and fails again (#136). The door is the only place a
      // fix does not have to choose between shipping a partial replay and
      // migrating stored rows.
      //
      // Applied to every send. It used to ride along with the fingerprint,
      // which runs only for a keyed one, and the asymmetry was recorded as a
      // ruling — read as costing the sender a retry, when it cost the room its
      // replay.
      try {
        assertPayloadDepth(payload);
      } catch (err) {
        if (err instanceof PayloadTooDeepError) {
          return fail(
            `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels, which cannot be delivered or replayed. ` +
            `Flatten it — send the deep part as text, or as an artifact that names where it came from.`
          );
        }
        throw err;
      }

      const serialized = JSON.stringify(payload);
      if (serialized.length > MAX_PAYLOAD_CHARS) {
        return fail(`payload too large (${serialized.length} chars, limit ${MAX_PAYLOAD_CHARS}). Send a summary and offer details on request.`);
      }

      // Hoisted past the guard, not moved into it: the capability checks below,
      // and `room_members` in the result, read it on every kind.
      const others = activeMembers(session).filter((m) => m.memberId !== member_id);
      // A progress report answers the SERVER's tick, not a peer. Its readers are the
      // room's log and the next tick's snapshot, both of which exist with nobody
      // else in the room — and the tick asks for it whether or not anyone has
      // joined, because D7 makes the cadence observable rather than conditional on
      // an audience: the startup window is exactly when a human wants to know the
      // lone agent is alive. Refusing it here would interrupt a member every
      // cadence with an instruction this same server then rejects, forever.
      //
      // Type-aware rather than dropped: the other five kinds are addressed TO the
      // room, and a member sending one into an empty room has misunderstood where
      // it is. Only the refusal is conditional.
      if (type !== "progress" && others.length === 0) {
        return fail("no other active members yet — share the join code and wait for a bellman_confirm (watch via bellman_sync).");
      }

      if (type === "message" || type === "artifact") {
        const deaf = others.filter((m) => !m.capabilities.includes("receive_messages"));
        if (deaf.length === others.length) {
          return fail(`no recipient allows receive_messages (${deaf.map((m) => m.label).join(", ")}).`);
        }
      }
      if (type === "action_request") {
        const refusing = others.filter((m) => !m.capabilities.includes("request_actions"));
        if (refusing.length > 0) {
          return fail(`action_request blocked: ${refusing.map((m) => m.label).join(", ")} did not grant request_actions.`);
        }
      }
      if (type === "action_response") {
        if (!ref_id) return fail("action_response requires ref_id (the cursor id of the action_request).");
        // One key, not the whole history (#25). String-compared, not numeric:
        // "007" never matched cursor 7 and must not start to.
        const at = Number(ref_id);
        const req = Number.isSafeInteger(at) && at > 0
          ? await s.eventAt(session_id, at)
          : undefined;
        if (!req || String(req.cursor) !== ref_id || req.type !== "action_request") {
          return fail(`no action_request with cursor id ${ref_id}.`);
        }
        if (req.fromMemberId === member_id) return fail("you cannot respond to your own action_request.");

        // First answer wins, and it has to win HERE and not only in the
        // derivation. `action-state.ts` already ignores a second response, so
        // the STATE was right — but the event was still appended, and
        // `bellman_sync` hands every member the feed, so a requester saw a
        // refusal followed by somebody else's approval with nothing marking the
        // second as ignored. In a swarm the default seat holds `respond_actions`,
        // so that is every joiner.
        //
        // A read from the request's cursor forward, which is the one place a
        // response to it can be. On this path and not the poll's: answering is
        // human-paced and rare, where a poll runs every 25 seconds per member.
        //
        // This NARROWS the race rather than closing it. Two responses in flight
        // can both pass this and both append — the cross-object gap
        // docs/ARCHITECTURE.md section 9 describes, which a conditional append
        // in the store would be the real answer to. The derivation stays the
        // backstop, so the state is right either way; this is what keeps the
        // feed from showing an answer that does not count.
        const answered = (await s.eventsAfter(session_id, req.cursor))
          .find((e) => e.type === "action_response" && e.refId === ref_id);
        if (answered) {
          return fail(
            `action_request ${ref_id} was already answered by ${answered.fromLabel}. The first answer is the one that counts, so this one would be ignored.`
          );
        }
      }
      // Validated here so an invalid brief never appends an event; applied
      // after the append, because a send the store refuses must not leave a
      // brief written. The frozen guard above catches the common case, but a
      // reused key does not reach the store until the append, and neither does
      // a freeze that lands after that guard's read.
      let updatedBrief: Brief | undefined;
      if (type === "brief_update") {
        const parsed = BriefShape.safeParse(payload);
        if (!parsed.success) return fail(`brief_update payload must be a full Brief object: ${parsed.error.issues[0]?.message}`);
        updatedBrief = parsed.data as Brief;
      }
      // Validated for the same reason, and refused before the append: a payload the
      // shape rejects must leave neither an event nor a stamp behind.
      //
      // `approved` was never checked, and `action-state.ts` has to read it to tell
      // "your human said no" from "nobody was there". A non-boolean reaching the log
      // is a refusal that cannot be told from an approval afterwards, so it is
      // refused here, where the caller can still fix it.
      if (type === "action_response") {
        const parsed = ActionResponseShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`action_response payload must be { approved: boolean, result?: string }: ${parsed.error.issues[0]?.message}`);
        }
      }
      if (type === "progress") {
        const parsed = ProgressShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`progress payload must be { note, step?, eta_seconds? }: ${parsed.error.issues[0]?.message}`);
        }
      }

      const draft = {
        type,
        fromMemberId: member_id,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        payload,
        refId: ref_id ?? null,
      };

      /**
       * A `progress` send credits this member's own `lastReportAt`, in the
       * append's own operation.
       *
       * It was a second `s.updateMember(...)` call after the append, which is two
       * Durable Object RPCs into two transactions — and `appendEvent` wakes
       * listeners before the second one runs, so a due alarm could read the
       * committed progress event while the stale stamp still named this member
       * silent. Worse, the patch sat inside the `if (!replayed)` block below, so
       * an idempotent retry skipped it outright: a stamp the first attempt never
       * landed was lost for good rather than merely late.
       *
       * A flag rather than the store reading `draft.type`: apart from housekeeping's
       * books (#66, `noteAppend`), nothing in either store branches on an event's
       * kind, and this is the one write that would have made it. The decision stays
       * here, beside the verb check and the payload validation that already
       * established what this send is.
       */
      // `stampActionRequest` rides the append for `creditReport`'s reason: it is
      // a write on the session record that has to land with the event or not at
      // all. The stamp is what lets `bellman_sync` skip reading the log on a
      // room that has no request inside the TTL — which is every room that does
      // not use action requests, and most that do, most of the time (#81).
      const extras: AppendExtras | undefined =
        type === "progress" ? { creditReport: true }
        : type === "action_request" ? { stampActionRequest: true }
        : undefined;

      let event: SessionEvent;
      let replayed = false;
      if (idempotency_key) {
        // No PayloadTooDeepError catch here any more. `appendEventOnce`
        // fingerprints, `canonical` throws that on a payload past the bound,
        // and this used to translate it — which is how the bound came to be
        // enforced only on keyed sends. The door above now refuses every such
        // payload before the append, and tests/payload.test.ts holds the two
        // walks to the same bound, so this branch can no longer see one.
        const write: EventWrite =
          await s.appendEventOnce(session_id, draft, idempotency_key, extras);
        if (write.outcome === "conflict") {
          return fail(
            `idempotency_key "${idempotency_key}" was already used for a different message. ` +
            `Reuse a key only to retry the same send; pick a new one for new content.`
          );
        }
        if (write.outcome === "frozen") return fail(FROZEN);
        event = write.event;
        replayed = write.outcome === "replayed";
      } else {
        event = await appendOrFrozen(s, session_id, draft, extras);
      }

      // Nothing below happens twice. A replay's original call did all of it,
      // and re-running it would grow the audit log on every retry — the bug
      // #68 shipped, one layer down.
      if (!replayed) {
        if (updatedBrief) {
          await s.updateMember(session_id, member_id, { brief: updatedBrief });
        }
        // The report stamp is NOT here. It rides in the append, for the reason
        // `extras` above gives — including that this block is skipped on a
        // replay, which is exactly where it went missing.
        await audit(s, session, identity, `sent_${type}`, {
          chars: serialized.length,
          ...(ref_id ? { ref_id } : {}),
        });
      }

      return ok({
        // The members active NOW, not the ones active when this was first
        // appended, and no history is kept to do better.
        //
        // This was `delivered_to` until #82. The name claimed a delivery the
        // server cannot observe: appending an event is not a peer reading it,
        // and a comment retracting the claim does not outrank the identifier
        // the model reads in every result. The honest predicate is the name.
        //
        // It does NOT answer who can read this either, and used to say it did.
        // A member who left of their own accord goes on reading the room and
        // is not listed here (#113 R3). The two predicates are different on
        // purpose.
        //
        // Nor is it quite "who was in the room when this was appended", which is
        // what the description used to claim. `others` is the roster this call
        // read BEFORE its append, minus the sender, so it is the other active
        // members observed just before the attempt — and on a replay it is the
        // roster at the retry, not at the original append (the comment above
        // says so and the description now does too). Making it literally
        // append-time would mean the store returning the roster it committed
        // against, which is a change to the append's contract and not to this
        // line.
        room_members: others.map((m) => m.label),
        cursor: event.cursor,
        ...(replayed ? { replayed: true } : {}),
        note: type === "action_request"
          ? "The peer's HUMAN must approve this — expect an action_response event, possibly after a delay."
          : undefined,
      });
    }
  );
}
