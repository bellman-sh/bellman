/**
 * A room's decisions, the pure rules (ADR 0040, #402): the content hash a vote is bound to, the state every
 * decision is in, the tally, and what a store does with a vote, a supersession and a close.
 *
 * Runtime-free, as proposal.ts is: no store, no MCP SDK, no `cloudflare:workers`, because both stores and both test
 * programs import it, and handing both stores the same decide functions is what keeps them from deciding
 * differently. The hash uses `node:crypto`'s synchronous `createHash`, as `AuditDO` does (ADR 0035): an async
 * digest would let another append land between the read and the write that stores it.
 *
 * The rule engine (#404) fills in `evaluate`; until then it closes nothing, so a decision ends only by a
 * supersession or by `closeDecision`. Quotas, voiding on eviction and the `vote` verb are #407 and #403.
 */
import { createHash } from "node:crypto";
import { ACTION_REQUEST_TTL_MS, PROPOSAL_TTL_MS } from "./action-state.js";
import type { EventType, SessionEvent } from "./types.js";

/** The four decision event types. Only the server writes them: none is a `bellman_send` kind. */
export const DECISION_EVENTS = [
  "decision_opened", "decision_vote", "decision_closed", "decision_voter_removed",
] as const satisfies readonly EventType[];

/** The bounds on a rule's `expires` (ADR 0040, decision 4): five minutes to a topic room's seven days. */
export const MIN_DECISION_TTL_MS = 5 * 60_000;
export const MAX_DECISION_TTL_MS = PROPOSAL_TTL_MS;

/** Derived, never stored, as `ActionState` is. `expired` is the clock's, until a closing event says it. */
export type DecisionState = "open" | "passed" | "failed" | "expired";
export type ClosedState = Exclude<DecisionState, "open">;
export type FailReason = "rejected" | "vetoed" | "superseded" | "stale" | "blocked" | "no_quorum";
export type Choice = "approve" | "reject" | "abstain";
export type Capacity = "binding" | "advisory";
export type VoteVia = "action_response" | "dash_session";

/** What a passed decision would apply. Its fields beyond `kind` are the effect's own (#408 to #410). */
export interface DecisionEffect { kind: string; [field: string]: unknown }
/** The manifest's rule for the effect's kind, as #403 writes it: a short string or the object form. */
export type DecisionRule = string | { [field: string]: unknown };

/** What a store is handed to open a decision. It adds `expires_at`, `electorate` and `hash`. */
export interface DecisionDraft {
  key: string;
  effect: DecisionEffect;
  rule: DecisionRule;
  /** The open decision this one replaces; it closes `failed: superseded` in the same write. */
  supersedes?: number;
  /** The rule's `expires`, from `MIN_DECISION_TTL_MS` to `MAX_DECISION_TTL_MS`; absent takes the room's default. */
  expires_ms?: number;
}

/** A `decision_opened` payload. */
export interface DecisionOpened {
  key: string;
  effect: DecisionEffect;
  rule: DecisionRule;
  /** ms epoch, the server's clock. */
  expires_at: number;
  /** The seats that may vote, fixed at open (decision 5). */
  electorate: string[];
  hash: string;
  supersedes?: number;
}

/** A vote as its caller hands it to the store. `via` is the server's to set: the tool path says `action_response`. */
export interface VoteInput {
  decision: number;
  hash: string;
  choice: Choice;
  reason?: string;
  via: VoteVia;
  /** The agent's statement that its human decided (decision 8). */
  human_approved: boolean;
  response_cursor?: number;
}

/** A `decision_vote` payload: the input and the capacity the server derived from it. */
export interface DecisionVote extends VoteInput { capacity: Capacity }

export interface Counts { approve: number; reject: number; abstain: number }
/** Binding counts at the top, advisory ones beside them; each account counted once (decision 3). */
export interface Tally extends Counts { advisory: Counts }

/** A `decision_closed` payload. A closed decision's tally is stored so no reader recomputes it (decision 13). */
export interface DecisionClosed {
  decision: number;
  state: ClosedState;
  reason?: FailReason;
  tally: Tally;
}

/** A `decision_voter_removed` payload (decision 12). The voided votes stay in the log and leave the tally. */
export interface VoterRemoved {
  decision: number;
  member: string;
  by: string;
  reason: "evicted" | "left";
  voided: number[];
}

/** One vote as the tally reads it. */
export interface Ballot { cursor: number; memberId: string; userId: string; vote: DecisionVote }

/** Everything the log says about one decision. */
export interface DecisionView {
  cursor: number;
  opened: SessionEvent;
  payload: DecisionOpened;
  state: DecisionState;
  reason: FailReason | null;
  /** Every vote cast while it was open, in cursor order, the voided and the revised included. */
  ballots: Ballot[];
  voided: number[];
  tally: Tally;
  closed: SessionEvent | null;
}

/** JSON with every object's keys sorted, so two payloads that differ only in key order hash alike. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** What a vote is bound to (decision 2): sha256 over the canonical `{ v, kind, effect, rule, key }`, hex. */
export function decisionHash(d: Pick<DecisionDraft, "effect" | "rule" | "key">): string {
  return createHash("sha256")
    .update(canonical({ v: 1, kind: d.effect.kind, effect: d.effect, rule: d.rule, key: d.key }))
    .digest("hex");
}

/** Binding when cast in a dash session, or relayed with the human's approval; otherwise advisory (decision 3). */
export const capacityOfVote = (v: Pick<VoteInput, "via" | "human_approved">): Capacity =>
  v.via === "dash_session" || (v.via === "action_response" && v.human_approved === true) ? "binding" : "advisory";

/** When a decision opened at `at` expires: the rule's `expires`, else seven days in a topic room and thirty minutes elsewhere. */
export function decisionExpiry(at: number, draft: Pick<DecisionDraft, "expires_ms">, topic: boolean): number {
  const ttl = draft.expires_ms ?? (topic ? PROPOSAL_TTL_MS : ACTION_REQUEST_TTL_MS);
  if (!(ttl >= MIN_DECISION_TTL_MS && ttl <= MAX_DECISION_TTL_MS)) {
    throw new RangeError(`a decision's expiry must be from 5 minutes to 7 days, not ${ttl} ms`);
  }
  return at + ttl;
}

const noCounts = (): Counts => ({ approve: 0, reject: 0, abstain: 0 });

/**
 * The tally of `ballots` (decision 3): the latest vote of each account counts, so a revision replaces the vote
 * before it and one account's several seats count once. A voided vote and a seat outside the electorate are
 * left out. Advisory votes are counted beside the binding ones and never in them.
 */
export function tally(ballots: readonly Ballot[], electorate: readonly string[], voided: readonly number[] = []): Tally {
  const latest = new Map<string, Ballot>();
  for (const b of ballots) {
    if (voided.includes(b.cursor) || !electorate.includes(b.memberId)) continue;
    const prior = latest.get(b.userId);
    if (prior === undefined || prior.cursor < b.cursor) latest.set(b.userId, b);
  }
  const t: Tally = { ...noCounts(), advisory: noCounts() };
  for (const { vote } of latest.values()) (vote.capacity === "binding" ? t : t.advisory)[vote.choice] += 1;
  return t;
}

/**
 * The rule engine's entry point (#404): the close `opened`'s rule calls for at tally `t`, or null to stay open.
 * A stub that closes nothing until #404 fills it in.
 */
export function evaluate(_opened: DecisionOpened, _t: Tally): { state: "passed" | "failed"; reason?: FailReason } | null {
  return null;
}

const ballotOf = (e: SessionEvent): Ballot =>
  ({ cursor: e.cursor, memberId: e.fromMemberId, userId: e.fromUserId, vote: e.payload as DecisionVote });

const decisionOf = (e: SessionEvent): number | undefined => (e.payload as { decision?: number } | null)?.decision;

/**
 * Every decision in `events`, keyed by its opening cursor, read as of `now`. The first closing event wins, and
 * a vote or a voiding that lands after it is not read: the stores refuse both, and a closed decision's tally is
 * the one its closing event stored. Payloads are read as the store wrote them, since no member writes these types.
 */
export function decisionsOf(events: readonly SessionEvent[], now: number): Map<number, DecisionView> {
  const views = new Map<number, DecisionView>();
  for (const e of events) {
    if (e.type === "decision_opened") {
      const payload = e.payload as DecisionOpened;
      views.set(e.cursor, {
        cursor: e.cursor, opened: e, payload, state: "open", reason: null,
        ballots: [], voided: [], tally: { ...noCounts(), advisory: noCounts() }, closed: null,
      });
      continue;
    }
    const v = views.get(decisionOf(e) ?? -1);
    if (v === undefined || v.closed !== null) continue;
    if (e.type === "decision_vote") v.ballots.push(ballotOf(e));
    else if (e.type === "decision_voter_removed") v.voided.push(...(e.payload as VoterRemoved).voided);
    else if (e.type === "decision_closed") v.closed = e;
  }
  for (const v of views.values()) {
    if (v.closed !== null) {
      const c = v.closed.payload as DecisionClosed;
      Object.assign(v, { state: c.state, reason: c.reason ?? null, tally: c.tally });
    } else {
      v.tally = tally(v.ballots, v.payload.electorate, v.voided);
      if (now > v.payload.expires_at) v.state = "expired";
    }
  }
  return views;
}

/** The state of every decision in `events`, keyed by cursor, as `actionStates` gives a request's. */
export function decisionStates(events: readonly SessionEvent[], now: number): Map<number, DecisionState> {
  return new Map([...decisionsOf(events, now)].map(([cursor, v]) => [cursor, v.state]));
}

/** What a store does with a draft that names `supersedes`: replace it, or refuse because it is not open. */
export function decideSupersede(old: DecisionView | undefined): { kind: "replace" } | { kind: "not_open"; state: DecisionState | null } {
  if (old === undefined) return { kind: "not_open", state: null };
  return old.state === "open" ? { kind: "replace" } : { kind: "not_open", state: old.state };
}

/** What a store does with a vote, decided from the decision as it read it in the transaction that writes. */
export type VoteDecision =
  | { kind: "closed"; state: DecisionState }    // a closing event exists: no vote lands after it
  | { kind: "not_electorate" }                  // the seat is not in the snapshot taken at open
  | { kind: "stale"; hash: string }             // the vote names another hash; `hash` is the current one
  | { kind: "record"; close: { state: "passed" | "failed"; reason?: FailReason } | null };

/**
 * `applyVote` decides a vote by `voter` against `view` (decision 3). In this order: a closed decision refuses it,
 * so a superseded decision's vote reads `closed` and not `stale`; then a seat outside the electorate; then a hash
 * that is not the decision's. A vote past the deadline on a decision nobody has closed still lands (decision 4).
 * A recorded vote carries the close `evaluate` calls for with the vote counted in.
 */
export function applyVote(view: DecisionView, voter: { memberId: string; userId: string }, vote: DecisionVote): VoteDecision {
  if (view.closed !== null) return { kind: "closed", state: view.state };
  if (!view.payload.electorate.includes(voter.memberId)) return { kind: "not_electorate" };
  if (vote.hash !== view.payload.hash) return { kind: "stale", hash: view.payload.hash };
  const next = [...view.ballots, { cursor: Number.MAX_SAFE_INTEGER, ...voter, vote }];
  return { kind: "record", close: evaluate(view.payload, tally(next, view.payload.electorate, view.voided)) };
}

/** What a store does with a close: write it, or refuse a decision already closed or one not yet due to expire. */
export function decideClose(
  view: DecisionView,
  state: ClosedState,
  now: number,
): { kind: "close" } | { kind: "closed"; state: DecisionState } | { kind: "not_due" } {
  if (view.closed !== null) return { kind: "closed", state: view.state };
  if (state === "expired" && now <= view.payload.expires_at) return { kind: "not_due" };
  return { kind: "close" };
}

/** A `decision_opened` payload for `draft`, opened at `at`: its expiry, the electorate snapshot and the hash. Throws on an expiry out of bounds. */
export function openedPayload(draft: DecisionDraft, at: number, topic: boolean, electorate: string[]): DecisionOpened {
  return {
    key: draft.key, effect: draft.effect, rule: draft.rule, expires_at: decisionExpiry(at, draft, topic), electorate,
    hash: decisionHash(draft), ...(draft.supersedes === undefined ? {} : { supersedes: draft.supersedes }),
  };
}

/** The `decision_closed` event that closes `view`, the server's, carrying the tally of the votes it read. */
export function closingEvent(view: DecisionView, close: { state: ClosedState; reason?: FailReason }): Omit<SessionEvent, "cursor" | "at"> {
  const payload: DecisionClosed = { decision: view.cursor, state: close.state, ...(close.reason === undefined ? {} : { reason: close.reason }), tally: view.tally };
  return { type: "decision_closed", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload, refId: null };
}
