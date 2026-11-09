import { MAX_ADDRESSEES, resolveAddressees } from "../room/member-names.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BriefShape, DecisionAnswerShape, OutsideAnswerShape, ProgressShape, SEND_KINDS, isReport, SEND_VERB, appendOrFrozen, fail, ok, refusal,
} from "./kit.js";
import type { ToolResult } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { Brief, Identity, SessionEvent } from "../types.js";
import { denyVerb, verbsOfRole } from "../room/roles.js";
import {
  FROZEN, NO_ANSWERER, activeMembers, admitSend, audit, checkProposal, findMember,
  touchMember, writeSurface, writeSurfaceBatch,
} from "../room/rooms.js";
import { isProposalPayload } from "../room/action-state.js";
import { answerQuestion, type AnswerError } from "../outside.js";
import { isTopicRoom } from "../room/manifest.js";
import { answerAction } from "../room/answer.js";
import { voteOn } from "./decide.js";
import type { StoredSession } from "../storage/stored-session.js";
import type { AppendExtras, BellmanStore, EventWrite } from "../storage/store.js";
import { isBatchPayload } from "../surface/surface.js";
import type { BlobStore } from "../files/blobs.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH, PayloadTooDeepError, assertPayloadDepth } from "../room/payload.js";
import { SEND_LIMIT, STRANGER_SEND_LIMIT } from "../room/send-limit.js";

/** What each refusal of an outside answer says. */
const OUTSIDE_ANSWER_ERROR = (error: AnswerError, refId: string): string => ({
  not_a_question: `no outside_question with cursor id ${refId}.`,
  not_the_voice: "Only the room's voice answers outside questions.",
  already_answered: "This question was already answered.",
  task_closed: "This question's task is closed.",
})[error];

/**
 * An approval the card's key has moved past (plan R16): the refusal names the cursor of the change and what to do next,
 * and carries it as `structuredContent`, so a client that acts on it need not read the sentence. Nothing was written.
 */
function staleApproval(key: string, cursor: number, base: number): ToolResult {
  return {
    ...fail(
      `stale: "${key}" changed at cursor ${cursor}, after cursor ${base}, which this proposal was written against. ` +
      "Nothing was written and the proposal is still open. Decline it (approved: false); its proposer can read the surface again and propose again."
    ),
    structuredContent: { error: "stale", cursor },
  };
}

export function registerSend(server: McpServer, identity: Identity, s: BellmanStore, blobs: BlobStore): void {
  server.registerTool(
    "bellman_send",
    {
      title: "Send to Bellman session members",
      description: `Send to the room: a message, artifact, action request or response, brief update, progress report, outside answer, or surface item.

Args:
  - session_id, member_id: your handles from start/confirm
  - type:
      "message"        — free-form text for the room's agents and their humans
      "artifact"       — code/doc/data ({ name, content })
      "action_request" — ask the room to do something. Only members that granted request_actions may act on it, and THEIR HUMAN approves, not their agent.
                         It ends in exactly one state: answered, declined (a human said no), or expired (30 minutes with no answer). Until then it is in every member's bellman_sync \`outstanding\`. An answer after the deadline still lands and counts. In a topic room, payload { kind: "surface_proposal", item, base } proposes a card: item is a surface payload or { key, remove: true }, base the surface_cursor you read. A text or diagram item needs an http or https link in its body; a member holds at most 3 open proposals, each lives 7 days. A maintainer's human approves with an action_response of approved: true, which writes the card; if the key changed after base, the approval is refused as stale (error "stale", with the cursor) and nothing is written.
      "action_response"— answer an action_request: ref_id is the request's cursor, payload { approved: boolean, result?: string }. Answering an open decision is a vote (see bellman_decide): add hash and human_approved; it returns the vote's { cursor, capacity, state }, or on a secret ballot { ballot, capacity, state } and no result field.
      "brief_update"   — replace your brief (payload = the full Brief)
      "progress"       — answer the room's heartbeat: { note?, step?, eta_seconds?, status? }, a note or a status or both. status: working, idle or needs_you (waiting on your human); a status without a note does not answer the heartbeat. Does not interrupt peers.
      "outside_answer" — reply to an outside A2A caller's question: ref_id is the outside_question's cursor, payload { text, needs_input? }; needs_input: true asks the caller for more and leaves the task waiting on them. Only the room's voice may: members whose role holds \`answer\` (no built-in preset grants it), or the creator while no role does.
      "surface"        — write, replace or remove a named item on the room's working surface. Needs write_surface. Payload { key, kind, title?, body?, ends?, placement?, frame?, blob?, shape?, locked? }, { key, remove: true }, or { key, restore: <cursor> }, which re-applies that key's version written at that cursor, author kept.
                         Kinds: text (markdown body), link (http/https URL body), diagram (mermaid body), connector (ends: { from, to } naming two items; no placement), file and image (blob: { id } of a blob uploaded to this room by POST /rooms/:id/blobs or the bridge's bellman_upload; no body; the item carries the blob's bytes, type and name; an image needs image/png, image/jpeg, image/gif or image/webp), html (a self-contained page, inline in body or blob: { id } stored as text/html (or bellman_upload with kind: "html"), never both; rendered only in a sandboxed frame on another origin: inline script, style and data: images work; no cookies, parent, navigation, popups, downloads, forms, or network the policy governs (fetch, sockets, beacons); WebRTC escapes it in Chromium, so a page naming a STUN or TURN server reaches that host. Inline any library it needs. The bytes are the artifact, whatever they claim to be), shape (shape: { form: rect | ellipse | diamond | arrow | line, color?: slate | blue | green | amber | red | violet or a hex like #3b82f6, flip?: true draws an arrow or line bottom-left to top-right }; placement { x, y, w, h } required; title is the label; no body), frame (a numbered rectangle: title and placement { x, y, w, h }; locked, the default, carries its items when moved; frames cannot overlap; at most 100), widget (widget: { plugin, locality: shared | credential_bound | local_with_remote_input | proximity_collaborative, owner: a member id of yours, seat? }; body, if any, is its JSON config; a client such as Colony Nerve runs it, viewers draw a card).
                         placement is { x, y, w?, h? }: x and y unbounded, w and h positive. frame: <n> instead of placement puts the item in frame n's first free slot.
                         Items replace by key; at most 1,000 per room, body 8,000 characters, title 120. Peers read the surface on join and on each change: keep plans and decisions there. Every version stays in the room's history.
                         { items: [...] } writes up to 100 items or removals in one call: all land or none, as one send; each key once, no restores; a refusal names items[i].
  - payload: object, ≤ ${MAX_PAYLOAD_CHARS} chars serialized and ≤ ${MAX_PAYLOAD_DEPTH} levels deep. Flatten rather than nest.
  - ref_id: the cursor of the event you answer. Required for action_response. A room's host answers only replies carrying its question's cursor.
  - to: optional, message and artifact only: up to 20 seat names ("coder-2"). Wakes only those seats; not private, every member can read it.
  - idempotency_key: optional. Retrying with the SAME key returns the original result without delivering again; use it when you cannot tell whether a call landed. Use a fresh key per new message; reusing one for different content is an error.

Returns: { room_members, cursor, count?, replayed?, applied? }
  - room_members: the OTHER active members this call read just before appending (on a replay, at the retry). NOT a read receipt: it does not mean a peer has seen this (that happens on its next bellman_sync), that its model acted, or that any human approved an action_request.
  - replayed: true: the key was already used and nothing new was sent.
  - count: a surface batch's number of items; cursor is then its last event's.
  - applied: { key, cursor } of the card an approval wrote; absent when none.
Errors: a verb your role lacks is refused by name; nothing is delivered. Capability errors name the member lacking the grant. A surface write names the field or rule it broke. A member sends at most ${SEND_LIMIT} times a minute, and one who joined through a public room's permanent code ${STRANGER_SEND_LIMIT}; past that the send is refused as rate_limited with retry_after in seconds, and nothing is sent. An approval is refused as stale when its card changed after base, and as already answered when another answer landed first; nothing is written.`,
      inputSchema: {
        ...RoomRefShape,
        member_id: z.string().min(4),
        type: z.enum(SEND_KINDS),
        payload: z.record(z.string(), z.unknown()),
        ref_id: z.string().optional(),
        idempotency_key: z.string().min(8).max(80).optional(),
        to: z.array(z.string().min(1).max(64)).min(1).max(MAX_ADDRESSEES).optional(),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const session_id = roomIdOf(args);
      if (!session_id) return fail(NEED_ROOM);
      const { member_id, type, payload, ref_id, idempotency_key, to } = args;
      // Seat names spec: only a message or an artifact is addressed.
      if (to !== undefined && type !== "message" && type !== "artifact") return fail("to is only for message and artifact.");
      // The whole sequence — guards, shape, rows, append, audit — is one
      // operation in rooms.ts, shared with the HTTP route that piece 3 adds.
      // Handled before the common guards below, which writeSurface runs itself.
      if (type === "surface") {
        // Counted here and not on the HTTP routes, which run the same writeSurface (R6).
        const out = isBatchPayload(payload)
          ? await writeSurfaceBatch(s, blobs, identity, session_id, member_id, payload, idempotency_key, true)
          : await writeSurface(s, blobs, identity, session_id, member_id, payload, idempotency_key, true);
        if (!out.ok) return refusal(out);
        return ok({
          room_members: out.value.roomMembers,
          cursor: out.value.cursor,
          ...("count" in out.value ? { count: out.value.count } : {}),
          ...(out.value.replayed ? { replayed: true } : {}),
        });
      }

      const session = await s.getSession(session_id);
      if (!session || session.closed) return fail("session not found or closed.");
      if (session.frozenAt !== null) return fail(FROZEN);
      const me = await findMember(s, session, member_id, identity);
      if (!me || me.leftAt !== null) return fail("member_id is not yours or has left the session.");

      // Sending is as good a sign of life as polling. Before the verb check, so
      // a member whose role forbids this kind still counts as present — it is
      // here, and refusing the send does not make it absent.
      await touchMember(s, session, me);

      // An outside answer is the voice's, which `isVoice` decides in the store with the state of the task; no verb check
      // stands in for it, and nobody else has to be in the room (a creator may answer alone).
      if (type === "outside_answer") {
        if (!ref_id) return fail("outside_answer requires ref_id (the cursor id of the outside_question).");
        const parsed = OutsideAnswerShape.safeParse(payload);
        if (!parsed.success) return fail(`outside_answer payload must be { text: string, needs_input?: boolean }: ${parsed.error.issues[0]?.message}`);
        const at = Number(ref_id);
        const answered = Number.isSafeInteger(at) && at > 0 && String(at) === ref_id
          ? await answerQuestion(s, session_id, me, { refId: at, text: parsed.data.text, needsInput: parsed.data.needs_input })
          : { ok: false as const, error: "not_a_question" as const };
        if (!answered.ok) return fail(OUTSIDE_ANSWER_ERROR(answered.error, ref_id));
        await audit(s, session, identity, "sent_outside_answer", { chars: parsed.data.text.length, ref_id });
        return ok({ task_id: answered.task.id, state: answered.task.state, cursor: answered.task.answers.at(-1)?.cursor });
      }

      // The event an answer names, read once. An answer to a decision is a vote (ADR 0040, decision 8), which `vote`
      // gates and not `respond_actions`, so it is told apart before the verb check below. String-compared, not
      // numeric: "007" never matched cursor 7 and must not start to.
      const refAt = Number(ref_id);
      const named = type === "action_response" && ref_id !== undefined && Number.isSafeInteger(refAt) && refAt > 0
        ? await s.eventAt(session_id, refAt)
        : undefined;
      if (named?.type === "decision_opened" && String(named.cursor) === ref_id) {
        const parsed = DecisionAnswerShape.safeParse(payload);
        if (!parsed.success) {
          return fail(
            "an answer to a decision must be { approved: boolean, hash: string, human_approved: boolean, result?: string }: " +
            parsed.error.issues[0]?.message,
          );
        }
        const { approved, hash, human_approved, result } = parsed.data;
        return voteOn(s, session_id, session, me, identity, {
          decision: refAt, hash, choice: approved ? "approve" : "reject", ...(result !== undefined ? { reason: result } : {}), human_approved,
        }, idempotency_key, "result");
      }

      // An answer to a request: one operation in room/answer.ts, shared with the dash's answer route.
      if (type === "action_response") {
        if (!ref_id) return fail("action_response requires ref_id (the cursor id of the action_request).");
        const out = await answerAction(s, blobs, identity, session, me, ref_id, named, payload, idempotency_key);
        if (!out.ok) {
          const st = out.state as { key: string; cursor: number; base: number } | undefined;
          return out.code === "stale" && st ? staleApproval(st.key, st.cursor, st.base) : refusal(out);
        }
        return ok({
          room_members: out.value.roomMembers,
          cursor: out.value.cursor,
          ...(out.value.replayed ? { replayed: true } : {}),
          ...(out.value.applied !== null ? { applied: out.value.applied } : {}),
        });
      }

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

      // The key, read once and before the checks below that depend on what the room has become: the proposal's
      // checks and the look for an earlier answer. A record means this call is the retry of a send that landed, so
      // neither is asked again: the cap would count the original against its own retry, and the look for an answer
      // would find the retry's own first response. The append below then replays it, or reports `conflict` for a key
      // reused for other content. A key with no record is a fresh send, or a retry of a refused one: both are checked
      // in full. What the call alone decides (the verb, the depth, the length, the shape) is checked whatever the key,
      // and so is the minute's count, which ADR 0022 (R6) charges a retry.
      const known = idempotency_key
        ? await s.idempotencyRecord(session_id, member_id, idempotency_key)
        : null;

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

      // The seats an addressed message names, resolved here and never from the payload (seat names spec). Each must
      // allow receive_messages, which stands in for the room-wide check below: the addressees are who it is for.
      let toMemberIds: string[] | undefined;
      if (to !== undefined) {
        const addressed = resolveAddressees(session, me, to);
        if (!addressed.ok) return refusal(addressed);
        toMemberIds = addressed.value.map((m) => m.memberId);
      } else if (type === "message" || type === "artifact") {
        const deaf = others.filter((m) => !m.capabilities.includes("receive_messages"));
        if (deaf.length === others.length) {
          return fail(`no recipient allows receive_messages (${deaf.map((m) => m.label).join(", ")}).`);
        }
      }
      if (type === "action_request") {
        // A proposal in a topic room is addressed to the seats that can answer it, not to every other member
        // (topic rooms plan, R6). Asking each of them for the `request_actions` grant would let one contributor
        // who granted nothing, which is a contributor's default, refuse every proposal in a public room. A
        // maintainer's agent has to grant it, and the refusal names the maintainer who did not. A request that
        // is not a proposal, or any request in a room that is not a topic room, keeps the rule it always had.
        const proposing = isTopicRoom(session.manifest) && isProposalPayload(payload);
        const audience = proposing
          ? others.filter((m) => verbsOfRole(session.manifest, m.roomRole).includes("respond_actions"))
          : others;
        if (proposing && audience.length === 0) return fail(NO_ANSWERER);
        const refusing = audience.filter((m) => !m.capabilities.includes("request_actions"));
        if (refusing.length > 0) {
          return fail(`action_request blocked: ${refusing.map((m) => m.label).join(", ")} did not grant request_actions.`);
        }
        // The proposal's own checks sit before the minute's count below, so a proposal refused for its shape,
        // its source, its base, its blob or the cap spends no place under the send limit.
        if (proposing && known === null) {
          const checked = await checkProposal(s, blobs, session, me, payload);
          if (!checked.ok) return refusal(checked);
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
      if (type === "progress") {
        const parsed = ProgressShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`progress payload must be { note?, step?, eta_seconds?, status? }: ${parsed.error.issues[0]?.message}`);
        }
      }

      // The minute's count (ADR 0022): after the last check that can refuse this send, so one refused anyway
      // spends no place, and before the first write, so a refusal leaves the log as it was. The surface kind
      // counts inside writeSurface, at the same point in its own sequence.
      //
      // Asked of a keyed retry too, record or not (ADR 0022, R6): a retry is a call, and one that replayed free would
      // be an unbounded loop of reads through the room's object.
      const admitted = await admitSend(s, session_id, me);
      if (!admitted.ok) return refusal(admitted);

      const draft = {
        type,
        fromMemberId: member_id,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        payload,
        refId: ref_id ?? null,
        ...(toMemberIds !== undefined ? { toMemberIds } : {}),
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
        type === "progress" ? (isReport(payload) ? { creditReport: true } : undefined)
        : type === "action_request" ? { stampActionRequest: true }
        : undefined;

      // Said by the keyed append and by the keyed approval alike, so the two cannot come to read differently.
      const keyReused = () => fail(
        `idempotency_key "${idempotency_key}" was already used for a different message. ` +
        `Reuse a key only to retry the same send; pick a new one for new content.`
      );

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
        if (write.outcome === "conflict") return keyReused();
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
