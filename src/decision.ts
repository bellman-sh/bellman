/**
 * A room's decisions, the pure rules (ADR 0040, #402): the content hash a vote is bound to, the state every
 * decision is in, the tally, and what a store does with a vote, a supersession and a close.
 *
 * Runtime-free, as proposal.ts is: no store, no MCP SDK, no `cloudflare:workers`, because both stores and both test
 * programs import it, and handing both stores the same decide functions is what keeps them from deciding
 * differently. The hash uses `node:crypto`'s synchronous `createHash`, as `AuditDO` does (ADR 0035): an async
 * digest would let another append land between the read and the write that stores it.
 *
 * `evaluate` is the rule engine (#404): after each vote it closes a decision the moment the worst case for the seats yet
 * to vote decides it. Quotas and writing `decision_voter_removed` are #407.
 */
import { createHash } from "node:crypto";
import { ACTION_REQUEST_TTL_MS, PROPOSAL_TTL_MS } from "./action-state.js";
import type { DecisionRuleName, EventType, SessionEvent } from "./types.js";

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
  /** Each electorate seat's account, fixed with it: one account counts once however many seats it holds. */
  accounts: Record<string, string>;
  /**
   * The electorate seats whose role vetoes the effect's kind (decision 6). Present whenever a role vetoes the kind,
   * even empty: a veto nobody seated can cast is not waived, and the decision closes `failed: blocked`.
   */
  veto?: string[];
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
/**
 * Binding counts at the top, advisory ones beside them; each account counted once (decision 3). `electorate` and
 * `unreachable` count accounts: an account is unreachable once every seat it held in the snapshot was removed.
 * `turnout` is the binding votes of any choice; `quorum` the turnout the rule needs, null for none (decision 20).
 */
export interface Tally extends Counts {
  advisory: Counts;
  electorate: number;
  unreachable: number;
  turnout: number;
  quorum: number | null;
}

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
  /** The seats `decision_voter_removed` named: unreachable for the decision's life, a rejoin included (decision 12). */
  removed: string[];
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

/** A rule as the server writes it into a draft, the name alone or `{ rule, quorum }`; null for a name outside the set. */
export function ruleOf(rule: DecisionRule): { rule: DecisionRuleName | null; quorum: number | null } {
  const o = typeof rule === "string" ? { rule } : rule;
  const name = (["single", "majority", "supermajority", "unanimous"] as const).find((n) => n === o.rule) ?? null;
  return { rule: name, quorum: typeof o.quorum === "number" ? o.quorum : null };
}

type Counted = Pick<DecisionView, "payload" | "ballots" | "voided" | "removed">;

/**
 * The count `tally` and `evaluate` share. The latest vote of each account counts, so a revision replaces the vote
 * before it and one account's several seats count once. Binding and advisory are kept apart, so an advisory vote
 * never replaces a binding one (decision 9). A seat outside the electorate is left out. A voided vote and a removed
 * seat's every vote are left out after the latest is found, never before: one account's other seat then has no vote
 * until it casts one, and the vote the voided one replaced does not come back, which could ease a pass (decision 12).
 * `pending` is the reachable accounts with no binding vote; `veto` what the veto seats have done, null when no role
 * vetoes the kind.
 */
function count(v: Counted) {
  const { electorate, accounts } = v.payload;
  const live = (m: string) => electorate.includes(m) && !v.removed.includes(m);
  const latest = { binding: new Map<string, Ballot>(), advisory: new Map<string, Ballot>() };
  for (const b of v.ballots) {
    if (!electorate.includes(b.memberId)) continue;
    const of = latest[b.vote.capacity];
    const prior = of.get(accounts[b.memberId]);
    if (prior === undefined || prior.cursor < b.cursor) of.set(accounts[b.memberId], b);
  }
  for (const of of Object.values(latest)) {
    for (const [account, b] of of) if (v.voided.includes(b.cursor) || !live(b.memberId)) of.delete(account);
  }
  const t: Tally = { ...noCounts(), advisory: noCounts(), electorate: 0, unreachable: 0, turnout: 0, quorum: null };
  for (const { vote } of latest.binding.values()) t[vote.choice] += 1;
  for (const { vote } of latest.advisory.values()) t.advisory[vote.choice] += 1;
  const all = new Set(electorate.map((m) => accounts[m]));
  const reachable = new Set(electorate.filter(live).map((m) => accounts[m]));
  const bound = (account: string) => latest.binding.has(account);
  const { quorum } = ruleOf(v.payload.rule);
  Object.assign(t, {
    electorate: all.size, unreachable: all.size - reachable.size, turnout: t.approve + t.reject + t.abstain,
    quorum: quorum === null ? null : Math.ceil((quorum * all.size) / 100),
  });
  const seats = v.payload.veto?.filter(live);
  const veto = seats === undefined ? null : {
    cast: [...latest.binding.values()].some((b) => b.vote.choice === "reject" && seats.includes(b.memberId)),
    blocked: seats.length === 0,
    pending: seats.some((m) => !bound(accounts[m])),
  };
  return { tally: t, pending: [...reachable].filter((a) => !bound(a)).length, veto };
}

/** The tally of a decision's votes (decision 3), with its electorate, unreachable seats, turnout and quorum. */
export const tally = (v: Counted): Tally => count(v).tally;

/** Whether `rule` holds at `approve` against `reject`; abstain is in neither (decision 6). */
function holds(rule: Exclude<DecisionRuleName, "single">, approve: number, reject: number): boolean {
  if (rule === "majority") return approve > reject;
  if (rule === "supermajority") return approve > 0 && 3 * approve >= 2 * (approve + reject);
  return approve > 0 && reject === 0;
}

/**
 * The rule engine (decisions 6, 12 and 20): the close a decision's votes call for, or null to stay open. A veto
 * seat's binding reject fails it `vetoed`, and no veto seat left reachable fails it `blocked`. It fails `rejected`
 * when the rule cannot hold even if every reachable account yet to vote approved, and `no_quorum` when turnout
 * cannot be met even if they all voted. It passes when turnout is met, no veto seat has yet to vote, and the rule
 * holds even if every account yet to vote and every unreachable one rejected. `single` is the `action_request`
 * flow and never closes here; neither does a rule outside the set.
 */
export function evaluate(v: Counted): { state: "passed" | "failed"; reason?: FailReason } | null {
  const { rule } = ruleOf(v.payload.rule);
  if (rule === null || rule === "single") return null;
  const { tally: t, pending, veto } = count(v);
  if (veto?.cast) return { state: "failed", reason: "vetoed" };
  if (veto?.blocked) return { state: "failed", reason: "blocked" };
  if (!holds(rule, t.approve + pending, t.reject)) return { state: "failed", reason: "rejected" };
  if (t.quorum !== null && t.turnout + pending < t.quorum) return { state: "failed", reason: "no_quorum" };
  const turnoutMet = t.quorum === null || t.turnout >= t.quorum;
  if (turnoutMet && !veto?.pending && holds(rule, t.approve, t.reject + pending + t.unreachable)) return { state: "passed" };
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
        cursor: e.cursor, opened: e, payload, state: "open", reason: null, ballots: [], voided: [], removed: [], closed: null,
        tally: { ...noCounts(), advisory: noCounts(), electorate: 0, unreachable: 0, turnout: 0, quorum: null },
      });
      continue;
    }
    const v = views.get(decisionOf(e) ?? -1);
    if (v === undefined || v.closed !== null) continue;
    if (e.type === "decision_vote") v.ballots.push(ballotOf(e));
    else if (e.type === "decision_voter_removed") {
      const r = e.payload as VoterRemoved;
      v.voided.push(...r.voided);
      v.removed.push(r.member);
    }
    else if (e.type === "decision_closed") v.closed = e;
  }
  for (const v of views.values()) {
    if (v.closed !== null) {
      const c = v.closed.payload as DecisionClosed;
      Object.assign(v, { state: c.state, reason: c.reason ?? null, tally: c.tally });
    } else {
      v.tally = tally(v);
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
  | { kind: "not_electorate" }                  // the seat is not in the snapshot taken at open, or was removed from it
  | { kind: "stale"; hash: string }             // the vote names another hash; `hash` is the current one
  | { kind: "record"; close: { state: "passed" | "failed"; reason?: FailReason } | null };

/**
 * `applyVote` decides a vote by `voter` against `view` (decision 3). In this order: a closed decision refuses it,
 * so a superseded decision's vote reads `closed` and not `stale`; then a seat outside the electorate, or one
 * `decision_voter_removed` named, since a rejoin restores neither the seat nor its vote (decision 12); then a hash
 * that is not the decision's. A vote past the deadline on a decision nobody has closed still lands (decision 4).
 * A recorded vote carries the close `evaluate` calls for with the vote counted in.
 */
export function applyVote(view: DecisionView, voter: { memberId: string; userId: string }, vote: DecisionVote): VoteDecision {
  if (view.closed !== null) return { kind: "closed", state: view.state };
  if (!view.payload.electorate.includes(voter.memberId) || view.removed.includes(voter.memberId)) return { kind: "not_electorate" };
  if (vote.hash !== view.payload.hash) return { kind: "stale", hash: view.payload.hash };
  const ballots = [...view.ballots, { cursor: Number.MAX_SAFE_INTEGER, ...voter, vote }];
  return { kind: "record", close: evaluate({ ...view, ballots }) };
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

/** The snapshot a store takes of the room at open (decision 5): who may vote, as which account, and who may veto. */
export type Electorate = Pick<DecisionOpened, "electorate" | "accounts" | "veto">;

/** A `decision_opened` payload for `draft`, opened at `at`: its expiry, the electorate snapshot and the hash. Throws on an expiry out of bounds. */
export function openedPayload(draft: DecisionDraft, at: number, topic: boolean, snapshot: Electorate): DecisionOpened {
  return {
    key: draft.key, effect: draft.effect, rule: draft.rule, expires_at: decisionExpiry(at, draft, topic), ...snapshot,
    hash: decisionHash(draft), ...(draft.supersedes === undefined ? {} : { supersedes: draft.supersedes }),
  };
}

/** The `decision_closed` event that closes `view`, the server's, carrying the tally of the votes it read. */
export function closingEvent(view: DecisionView, close: { state: ClosedState; reason?: FailReason }): Omit<SessionEvent, "cursor" | "at"> {
  const payload: DecisionClosed = { decision: view.cursor, state: close.state, ...(close.reason === undefined ? {} : { reason: close.reason }), tally: view.tally };
  return { type: "decision_closed", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload, refId: null };
}
