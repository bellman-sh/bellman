import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ActionResponseShape, BriefShape, OutsideAnswerShape, ProgressShape, SEND_KINDS, SEND_VERB, appendOrFrozen, fail, ok, refusal,
} from "./kit.js";
import type { ToolResult } from "./kit.js";
import { NEED_ROOM, RoomRefShape, roomIdOf } from "./kit.js";
import type { Brief, Identity, SessionEvent } from "../types.js";
import { denyVerb, verbsOfRole } from "../roles.js";
import {
  FROZEN, NO_ANSWERER, activeMembers, admitSend, audit, checkProposal, findMember, resolveSurfaceWrite, surfaceAuditDetail,
  touchMember, writeSurface,
} from "../rooms.js";
import { isProposalPayload } from "../action-state.js";
import { answerQuestion, type AnswerError } from "../outside.js";
import { isTopicRoom } from "../manifest.js";
import { readProposal } from "../proposal.js";
import type { StoredSession } from "../stored-session.js";
import type { AppendExtras, BellmanStore, EventWrite, ProposalApproval } from "../store.js";
import type { SurfaceWrite } from "../surface.js";
import type { BlobStore } from "../blobs.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH, PayloadTooDeepError, assertPayloadDepth } from "../payload.js";
import { SEND_LIMIT, STRANGER_SEND_LIMIT } from "../send-limit.js";

/**
 * The proposal an answer approves (topic rooms plan, R1): the request's payload read as one, when the answer is
 * `approved: true` and the room is a topic room. Null for a decline, for any answer in a room that is not a topic
 * room, and for a request that is not a proposal: each is an ordinary answer, and nothing is applied.
 */
function approvedProposal(
  session: StoredSession,
  request: SessionEvent,
  payload: Record<string, unknown>,
): { requestCursor: number; item: unknown; base: number } | null {
  if (payload.approved !== true || !isTopicRoom(session.manifest)) return null;
  const read = readProposal(request.payload);
  return read.ok ? { requestCursor: request.cursor, item: read.item, base: read.base } : null;
}

/** The refusal of a second answer, said once for the tool's own look at the log and for the store's `answered` outcome, so the two cannot read differently. */
const alreadyAnswered = (refId: string, by: string): string =>
  `action_request ${refId} was already answered by ${by}. The first answer is the one that counts, so this one would be ignored.`;

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
      description: `Send a message, artifact, action request, action response, brief update, progress report, or a surface item to the room.

Args:
  - session_id, member_id: your handles from start/confirm
  - type:
      "message"        — free-form text for the room's agents and their humans
      "artifact"       — code/doc/data payload ({ name, content })
      "action_request" — ask the room to do something. Only members that granted request_actions may act on it, and THEIR HUMAN approves, not their agent.
                         It ends in exactly one of three states and cannot sit between them: answered, declined (a human said no), or expired (30 minutes passed and nobody did). Silence and refusal are different answers, and this is what tells them apart. Until it ends it appears in every member's bellman_sync as \`outstanding\`. An answer that arrives after the deadline still lands and still counts. In a topic room, payload { kind: "surface_proposal", item, base } proposes a card: item is a surface payload or { key, remove: true }, base is the surface_cursor you read. A text or diagram item needs an http or https link in its body, a member holds at most 3 open proposals, and each lives 7 days. A maintainer's human approves it with an action_response of approved: true, which writes the card; if the card's key changed after base the approval is refused as stale (error "stale", with the cursor) and nothing is written.
      "action_response"— answer an action_request; set ref_id to the request's cursor id and include { approved: boolean, result?: string }
      "brief_update"   — replace your brief as things progress (payload = full Brief object)
      "progress"       — answer the room's heartbeat: where you are now ({ note, step?, eta_seconds?, status? }); status is working, idle or needs_you (waiting on your human). Peers are not interrupted by it; it reaches them when they next look.
      "outside_answer" — a member's reply to an outside A2A caller's question. Set ref_id to the outside_question's cursor id and send { text, needs_input? }; needs_input: true asks the caller for more and leaves the task waiting on them. Only the room's voice may: the members whose role holds the answer verb (no built-in preset grants it), or, while no member's role does, the room's creator.
      "surface"        — write or replace a named item on the room's working surface, or remove one. Payload { key, kind, title?, body?, ends?, placement?, frame?, blob?, shape?, locked? } or { key, remove: true }. { key, restore: <cursor> } re-applies the version of that key written at that cursor, with its author kept (needs write_surface).
                         Kinds: text (markdown in body), link (an http/https URL in body), diagram (mermaid source in body), connector (ends: { from, to } naming two items on the surface; no placement), file and image (blob: { id } naming a blob uploaded to this room — POST /rooms/:id/blobs, or the bridge's bellman_upload, which uploads and places in one call; no body; the item comes back with the object's bytes, type and name, and an image needs a blob stored as image/png, image/jpeg, image/gif or image/webp), html (a self-contained page: the page inline in body, or blob: { id } naming a blob stored as text/html (uploaded as for a file, or bellman_upload with kind: "html"), never both; the panel renders it only inside a sandboxed frame on another origin, where its inline script and style and data: images work and it gets no cookies, no parent, no navigation, no popups, no downloads, no forms and no network through anything the policy governs (fetch, sockets, beacons; WebRTC is outside it in Chromium, so a page naming a STUN or TURN server reaches that host) — inline any library it needs; the bytes are the artifact, whatever they claim to be), shape (shape: { form: rect, ellipse, diamond, arrow or line, color?: slate, blue, green, amber, red or violet, or a hex such as #3b82f6, flip?: true draws an arrow or a line from the bottom-left to the top-right }; placement { x, y, w, h } required; the label is title; no body), frame (a numbered rectangle: a title and placement { x, y, w, h }; locked, the default, carries its items when it moves; frames cannot overlap; at most 100). placement is { x, y, w?, h? }: x and y unbounded, w and h positive when given. frame: <n> in place of placement puts the item in frame n's first free slot.
                         Needs the write_surface verb. Items replace by key; at most 1,000 per room, body at most 8,000 characters, title 120. Peers read the surface on join and whenever it changes — keep the plan and decisions there rather than in messages. Every version stays in the room's history.
  - payload: object, ≤ ${MAX_PAYLOAD_CHARS} chars serialized and ≤ ${MAX_PAYLOAD_DEPTH} levels deep. Both bounds matter: a deeply nested payload can be small and still be undeliverable, so flatten rather than nest.
  - ref_id: the cursor of the event you are answering; a room's host answers only replies that carry its question's cursor. Required for action_response.
  - idempotency_key: optional. Names this send. Retrying with the SAME key returns the original result instead of delivering a second copy — use it when a call timed out or the connection dropped and you cannot tell whether it landed. Use a fresh key for a new message; reusing one for different content is an error.

Returns: { room_members, cursor, replayed?, applied? }
  - room_members: the OTHER active members this call saw just before appending — your own seat is not in it, and on a replayed send it is who was there at the retry rather than at the original append. It is NOT a read receipt. It does not mean a peer's session has seen this (that happens on its next bellman_sync), that its model acted on it, or — for action_request — that any human has approved it. The store is truth; the channel is transport.
  - replayed: true means this key had already been used and nothing new was sent.
  - applied: the card an approval wrote, { key, cursor }; absent when the approval wrote none.
Errors: a verb your role does not hold is refused by name, and nothing is delivered. Capability errors name the member lacking the grant. A surface write names the field or the rule it broke. A member sends at most ${SEND_LIMIT} times a minute, and one who joined through a public room's permanent code ${STRANGER_SEND_LIMIT}; past that the send is refused as rate_limited with retry_after in seconds, and nothing is sent. An approval is refused as stale when its card changed after the proposal's base, and as already answered when another answer landed first; nothing is written either way.`,
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
        // Counted here and not on the HTTP routes, which run the same writeSurface (R6).
        const out = await writeSurface(s, blobs, identity, session_id, member_id, payload, idempotency_key, true);
        if (!out.ok) return refusal(out);
        return ok({
          room_members: out.value.roomMembers,
          cursor: out.value.cursor,
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

      if (type === "message" || type === "artifact") {
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
      // What the checks of an answer learn for the approval below: the proposal it approves, if it approves one, and
      // whether it is the retry of an approval already given.
      let proposal: ReturnType<typeof approvedProposal> = null;
      let retrying = false;
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
        proposal = approvedProposal(session, req, payload);

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
        //
        // Skipped for a key that has a record (`known`, read above): that answer is this call's own first
        // response, and refusing on it would answer every retry with "already answered by you" when the key is
        // there to say it is the same send. The append replays the response the key names and refuses a key used
        // for another answer, an approval's included (plan R21). Keyed or not, an answer with no record keeps this
        // check as its only one.
        if (known === null) {
          const answered = (await s.eventsAfter(session_id, req.cursor))
            .find((e) => e.type === "action_response" && e.refId === ref_id);
          if (answered) return fail(alreadyAnswered(ref_id, answered.fromLabel));
        }
        // A retry of an approval settles no card again: the store answers it from its key, however the room has
        // changed since.
        retrying = known !== null && proposal !== null;
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
      // What an approval hands the store, set below.
      let approval: ProposalApproval | undefined;
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
        // An approval (topic rooms spec, D2), built here: after every check above and ahead of the minute's count, so
        // a card that cannot be written is refused with the log and the count as they were (plan R14).
        // `write` is what the store applies. It is null for a seat without `write_surface`, whose answer the store
        // records and applies nothing (R13), and for a retry, which settles nothing again because the store answers
        // it from its key, however the room has changed since (R21).
        if (proposal !== null) {
          let write: SurfaceWrite | null = null;
          if (!retrying && denyVerb(session, me, "write_surface") === null) {
            const resolved = await resolveSurfaceWrite(s, blobs, session_id, proposal.item);
            if (!resolved.ok) return refusal(resolved);
            write = resolved.value.write;
          }
          approval = { requestCursor: proposal.requestCursor, base: proposal.base, write };
        }
      }
      if (type === "progress") {
        const parsed = ProgressShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`progress payload must be { note, step?, eta_seconds?, status? }: ${parsed.error.issues[0]?.message}`);
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

      // Said by the keyed append and by the keyed approval alike, so the two cannot come to read differently.
      const keyReused = () => fail(
        `idempotency_key "${idempotency_key}" was already used for a different message. ` +
        `Reuse a key only to retry the same send; pick a new one for new content.`
      );

      let event: SessionEvent;
      // The card an approval wrote, as the result names it: the first call's and a retry's alike.
      let applied: { key: string; cursor: number } | null = null;
      // The same card, for the audit row, which only the call that wrote it files.
      let written: { write: SurfaceWrite; approved: number } | null = null;
      let replayed = false;
      if (approval) {
        // One call writes the response and the card, or neither (plan R12). Five of its outcomes refuse and write
        // nothing, and the other two read as an ordinary send's do. A seat that cannot apply is not a refusal: its
        // response is recorded alone and `written` stays null.
        const outcome = await s.approveProposal(session_id, draft, idempotency_key ?? null, approval);
        if (outcome.outcome === "stale") {
          // Decided only for a write, so there is a card to name.
          return staleApproval(approval.write!.key, outcome.cursor, approval.base);
        }
        if (outcome.outcome === "answered") return fail(alreadyAnswered(String(approval.requestCursor), outcome.by));
        if (outcome.outcome === "conflict") return keyReused();
        if (outcome.outcome === "frozen") return fail(FROZEN);
        if (outcome.outcome === "refused") return fail(outcome.reason);
        event = outcome.event;
        replayed = outcome.outcome === "replayed";
        if (outcome.written !== null) {
          // A replay names the card its first call wrote, as that call did. A retry settles no write of its own
          // (`approval.write` is null for it), so the key is the card event's, whose payload is the item or the removal.
          const key = approval.write?.key ?? String((outcome.written.payload as { key?: unknown }).key);
          applied = { key, cursor: outcome.written.cursor };
          if (outcome.outcome === "appended" && approval.write !== null) {
            written = { write: approval.write, approved: approval.requestCursor };
          }
        }
      } else if (idempotency_key) {
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
        // The card an approval wrote files the row a maintainer's own write would, under the approver, and names the
        // proposal it came from (plan R18). The org's trail then shows who put the words on the surface, and on
        // whose word.
        if (written !== null) {
          await audit(s, session, identity, "sent_surface", { ...surfaceAuditDetail(written.write), approved: written.approved });
        }
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
        // The card an approval wrote, at the cursor it was written at: the response's `cursor` is the one before it.
        ...(applied !== null ? { applied } : {}),
        note: type === "action_request"
          ? "The peer's HUMAN must approve this — expect an action_response event, possibly after a delay."
          : undefined,
      });
    }
  );
}
