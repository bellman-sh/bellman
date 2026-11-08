/**
 * Answering an `action_request`: `bellman_send type: "action_response"` and the dash's
 * `POST /rooms/:id/requests/:cursor/answer` both run this one sequence (the verb, the request, the first-answer
 * check, the shape, a topic room's approval, the minute's count, the append and the audit row), as `writeSurface` is
 * one sequence for the surface. An answer to a decision is a vote and never reaches here: `voteOn` takes it.
 */
import { z } from "zod";
import type { Identity, Member, SessionEvent } from "../types.js";
import type { StoredSession } from "../storage/stored-session.js";
import type { BellmanStore, ProposalApproval } from "../storage/store.js";
import type { BlobStore } from "../files/blobs.js";
import type { SurfaceWrite } from "../surface/surface.js";
import { readProposal } from "../surface/proposal.js";
import { isTopicRoom } from "./manifest.js";
import { denyVerb } from "./roles.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH, PayloadTooDeepError, assertPayloadDepth } from "./payload.js";
import { FROZEN, activeMembers, admitSend, audit, refuse, resolveSurfaceWrite, succeed, surfaceAuditDetail, type RoomResult } from "./rooms.js";

/**
 * An answer to an `action_request`. `approved` is a REQUIRED boolean, and that
 * is the whole point of the shape: the field was unvalidated, so a client could
 * send `{ approved: "false" }` and have a human's refusal read as an approval
 * on the way back out (see `verdictOf` in src/room/action-state.ts). `result` is the
 * sentence the requester is shown.
 *
 * Not strict, unlike `ProgressShape` below: an `action_response` payload is also
 * carried to the room's members as content, and a build that adds a field to it should
 * not have the whole answer refused.
 */
export const ActionResponseShape = z.object({
  approved: z.boolean(),
  result: z.string().max(2_000).optional(),
});

/** The refusal of a second answer, said for the look at the log and for the store's `answered` outcome alike, so the two cannot read differently. */
export const alreadyAnswered = (refId: string, by: string): string =>
  `action_request ${refId} was already answered by ${by}. The first answer is the one that counts, so this one would be ignored.`;

/** Said by the keyed append and by the keyed approval alike, so the two cannot come to read differently. */
const keyReused = (key: string): string =>
  `idempotency_key "${key}" was already used for a different message. Reuse a key only to retry the same send; pick a new one for new content.`;

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

export interface Answered {
  /** The other active members the call read just before appending (on a replay, at the retry). Not a read receipt. */
  roomMembers: string[];
  cursor: number;
  replayed: boolean;
  /** The card an approval wrote, at the cursor it was written at; null when none. */
  applied: { key: string; cursor: number } | null;
}

/**
 * `me` answers the request at `refId` with `payload` (`{ approved, result? }`). `request` is the event at that cursor
 * as the caller read it, or undefined. The caller has loaded `session` and found `me` active in it, and has sent a
 * decision's answer to `voteOn`.
 *
 * Refusals: `forbidden` (no `respond_actions`), `not_found` (no request at that cursor), `invalid` (the payload's
 * depth or shape, nobody else in the room, or your own request), `too_large`, `conflict` (already answered, or a key
 * reused for other content), `stale` (an approval whose card moved past the proposal's base: `state` carries `key`,
 * `cursor` and `base`), `frozen`, `rate_limited`, and whatever resolving an approved card refuses.
 */
export async function answerAction(
  s: BellmanStore,
  blobs: BlobStore,
  identity: Identity,
  session: StoredSession,
  me: Member,
  refId: string,
  request: SessionEvent | undefined,
  payload: Record<string, unknown>,
  idempotencyKey: string | undefined,
): Promise<RoomResult<Answered>> {
  // Authority first: before the payload, before who is listening. A seat that may not act hears why, rather than
  // learning who is present by probing.
  const denial = denyVerb(session, me, "respond_actions");
  if (denial) return refuse("forbidden", denial);

  // Depth before length, because length cannot stand in for it (#136): a payload can pass the length bound and still
  // nest past where a projected event's JSON.stringify overflows, and such a row makes the room unwatchable over /ws.
  try {
    assertPayloadDepth(payload);
  } catch (err) {
    if (err instanceof PayloadTooDeepError) {
      return refuse("invalid",
        `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels, which cannot be delivered or replayed. ` +
        `Flatten it — send the deep part as text, or as an artifact that names where it came from.`);
    }
    throw err;
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    return refuse("too_large", `payload too large (${serialized.length} chars, limit ${MAX_PAYLOAD_CHARS}). Send a summary and offer details on request.`);
  }

  // The key, read once and before the checks that depend on what the room has become. A record means this call is
  // the retry of a send that landed, so the look for an earlier answer is not asked again: it would find the retry's
  // own first response. The append below replays it, or refuses a key reused for other content.
  const known = idempotencyKey ? await s.idempotencyRecord(session.id, me.memberId, idempotencyKey) : null;

  const others = activeMembers(session).filter((m) => m.memberId !== me.memberId);
  if (others.length === 0) {
    return refuse("invalid", "no other active members yet — share the join code and wait for a bellman_confirm (watch via bellman_sync).");
  }

  // String-compared, not numeric: "007" never matched cursor 7 and must not start to.
  if (!request || String(request.cursor) !== refId || request.type !== "action_request") {
    return refuse("not_found", `no action_request with cursor id ${refId}.`);
  }
  if (request.fromMemberId === me.memberId) return refuse("invalid", "you cannot respond to your own action_request.");
  const proposal = approvedProposal(session, request, payload);

  // First answer wins, and it has to win here and not only in `action-state.ts`'s derivation, or every member's feed
  // shows a second answer that does not count. A read from the request's cursor forward, the one place a response to
  // it can be. This narrows the race rather than closing it (docs/ARCHITECTURE.md §9); the derivation is the backstop.
  // Skipped for a key with a record: that answer is this call's own first response.
  if (known === null) {
    const answered = (await s.eventsAfter(session.id, request.cursor))
      .find((e) => e.type === "action_response" && e.refId === refId);
    if (answered) return refuse("conflict", alreadyAnswered(refId, answered.fromLabel));
  }
  // A retry of an approval settles no card again: the store answers it from its key, however the room has changed.
  const retrying = known !== null && proposal !== null;

  // `approved` has to be a boolean: `action-state.ts` reads it to tell "your human said no" from "nobody was there".
  const parsed = ActionResponseShape.safeParse(payload);
  if (!parsed.success) {
    return refuse("invalid", `action_response payload must be { approved: boolean, result?: string }: ${parsed.error.issues[0]?.message}`);
  }

  // An approval (topic rooms spec, D2), built after every check above and ahead of the minute's count, so a card that
  // cannot be written is refused with the log and the count as they were (plan R14). `write` is null for a seat
  // without `write_surface`, whose answer the store records and applies nothing (R13), and for a retry (R21).
  let approval: ProposalApproval | undefined;
  if (proposal !== null) {
    let write: SurfaceWrite | null = null;
    if (!retrying && denyVerb(session, me, "write_surface") === null) {
      const resolved = await resolveSurfaceWrite(s, blobs, session.id, proposal.item);
      if (!resolved.ok) return resolved;
      write = resolved.value.write;
    }
    approval = { requestCursor: proposal.requestCursor, base: proposal.base, write };
  }

  // The minute's count (ADR 0022): after the last check that can refuse, before the first write. Asked of a keyed
  // retry too (R6): a retry is a call.
  const admitted = await admitSend(s, session.id, me);
  if (!admitted.ok) return admitted;

  const draft = {
    type: "action_response" as const,
    fromMemberId: me.memberId,
    fromUserId: identity.userId,
    fromLabel: identity.label,
    payload,
    refId,
  };

  let event: SessionEvent;
  let applied: { key: string; cursor: number } | null = null;
  // The card an approval wrote, for the audit row, which only the call that wrote it files.
  let written: { write: SurfaceWrite; approved: number } | null = null;
  let replayed = false;
  if (approval) {
    // One call writes the response and the card, or neither (plan R12).
    const outcome = await s.approveProposal(session.id, draft, idempotencyKey ?? null, approval);
    if (outcome.outcome === "stale") {
      // Decided only for a write, so there is a card to name.
      const key = approval.write!.key;
      return refuse("stale",
        `stale: "${key}" changed at cursor ${outcome.cursor}, after cursor ${approval.base}, which this proposal was written against. ` +
        "Nothing was written and the proposal is still open. Decline it (approved: false); its proposer can read the surface again and propose again.",
        { state: { key, cursor: outcome.cursor, base: approval.base } });
    }
    if (outcome.outcome === "answered") return refuse("conflict", alreadyAnswered(String(approval.requestCursor), outcome.by));
    if (outcome.outcome === "conflict") return refuse("conflict", keyReused(idempotencyKey ?? ""));
    if (outcome.outcome === "frozen") return refuse("frozen", FROZEN);
    if (outcome.outcome === "refused") return refuse("invalid", outcome.reason);
    event = outcome.event;
    replayed = outcome.outcome === "replayed";
    if (outcome.written !== null) {
      // A replay names the card its first call wrote. A retry settles no write of its own, so the key is the card
      // event's, whose payload is the item or the removal.
      const key = approval.write?.key ?? String((outcome.written.payload as { key?: unknown }).key);
      applied = { key, cursor: outcome.written.cursor };
      if (outcome.outcome === "appended" && approval.write !== null) written = { write: approval.write, approved: approval.requestCursor };
    }
  } else if (idempotencyKey) {
    const write = await s.appendEventOnce(session.id, draft, idempotencyKey);
    if (write.outcome === "conflict") return refuse("conflict", keyReused(idempotencyKey));
    if (write.outcome === "frozen") return refuse("frozen", FROZEN);
    event = write.event;
    replayed = write.outcome === "replayed";
  } else {
    const appended = await s.appendEvent(session.id, draft);
    if (!appended) return refuse("frozen", FROZEN);
    event = appended;
  }

  // Nothing below happens twice: a replay's original call did it (#68).
  if (!replayed) {
    await audit(s, session, identity, "sent_action_response", { chars: serialized.length, ref_id: refId });
    // The card an approval wrote files the row a maintainer's own write would, under the approver, and names the
    // proposal it came from (plan R18).
    if (written !== null) await audit(s, session, identity, "sent_surface", { ...surfaceAuditDetail(written.write), approved: written.approved });
  }
  return succeed({ roomMembers: others.map((m) => m.label), cursor: event.cursor, replayed, applied });
}
