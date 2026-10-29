/**
 * A room's decisions (ADR 0040, #402): the content hash, the tally, the derived state and what a store does with a
 * vote. Pure; the stores' half is the "decisions" block of tests/helpers/store-contract.ts.
 */
import { describe, expect, it } from "vitest";
import {
  applyVote, capacityOfVote, decideClose, decideSupersede, decisionExpiry, decisionHash, decisionStates, decisionsOf, tally,
  MAX_DECISION_TTL_MS, MIN_DECISION_TTL_MS,
  type Ballot, type DecisionOpened, type DecisionVote,
} from "../src/decision.js";
import { ACTION_REQUEST_TTL_MS, PROPOSAL_TTL_MS } from "../src/action-state.js";
import type { SessionEvent } from "../src/types.js";

const draft = () => ({
  key: "tools",
  effect: { kind: "surface_proposal", item: { key: "tools", kind: "text", body: "https://example.com", placement: { x: 0, y: 1 } }, base: 4 },
  rule: { rule: "majority", quorum: "60%" },
});

/** A small seeded generator, so a failure names a seed that reproduces it. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** `v` rebuilt with every object's keys in a shuffled order, values unchanged. */
function shuffled(v: unknown, next: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffled(x, next));
  if (v === null || typeof v !== "object") return v;
  const keys = Object.keys(v);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return Object.fromEntries(keys.map((k) => [k, shuffled((v as Record<string, unknown>)[k], next)]));
}

/** Every leaf path in `v`, as key lists. */
function leaves(v: unknown, at: string[] = []): string[][] {
  if (v === null || typeof v !== "object") return [at];
  return Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, k]));
}

function withLeaf(v: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  return { ...(v as object), [head]: withLeaf((v as Record<string, unknown>)[head], rest, value) };
}

describe("decisionHash", () => {
  it("is stable under key order, at every depth (property, 200 seeds)", () => {
    const want = decisionHash(draft());
    for (let seed = 1; seed <= 200; seed++) {
      const d = shuffled(draft(), rng(seed)) as ReturnType<typeof draft>;
      expect(decisionHash(d), `seed ${seed}`).toBe(want);
    }
  });

  it("changes when any one field changes (property: every leaf, three replacement values)", () => {
    const base = draft();
    const want = decisionHash(base);
    for (const path of leaves(base)) {
      for (const value of ["changed", 99, null]) {
        const old = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], base);
        if (old === value) continue;
        const d = withLeaf(base, path, value) as ReturnType<typeof draft>;
        expect(decisionHash(d), `${path.join(".")} = ${String(value)}`).not.toBe(want);
      }
    }
  });

  it("changes when a field is added, and reads an undefined field as absent", () => {
    const base = draft();
    expect(decisionHash({ ...base, effect: { ...base.effect, extra: 1 } })).not.toBe(decisionHash(base));
    expect(decisionHash({ ...base, effect: { ...base.effect, extra: undefined } })).toBe(decisionHash(base));
  });

  it("tells a string rule from the same word in the object form", () => {
    expect(decisionHash({ ...draft(), rule: "majority" })).not.toBe(decisionHash({ ...draft(), rule: { rule: "majority" } }));
  });

  it("is sha256 hex", () => {
    expect(decisionHash(draft())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("capacityOfVote", () => {
  it("binds a dash vote, and a relayed vote only when the human approved; never on a truthy non-boolean", () => {
    expect(capacityOfVote({ via: "dash_session", human_approved: false })).toBe("binding");
    expect(capacityOfVote({ via: "action_response", human_approved: true })).toBe("binding");
    expect(capacityOfVote({ via: "action_response", human_approved: false })).toBe("advisory");
    expect(capacityOfVote({ via: "action_response", human_approved: "true" as unknown as boolean })).toBe("advisory");
    expect(capacityOfVote({ via: "agent" as unknown as "dash_session", human_approved: true })).toBe("advisory");
  });
});

describe("decisionExpiry", () => {
  it("defaults to thirty minutes, a week in a topic room, and takes a rule's expires within bounds", () => {
    expect(decisionExpiry(1000, {}, false)).toBe(1000 + ACTION_REQUEST_TTL_MS);
    expect(decisionExpiry(1000, {}, true)).toBe(1000 + PROPOSAL_TTL_MS);
    expect(decisionExpiry(1000, { expires_ms: MIN_DECISION_TTL_MS }, false)).toBe(1000 + MIN_DECISION_TTL_MS);
    expect(decisionExpiry(1000, { expires_ms: MAX_DECISION_TTL_MS }, false)).toBe(1000 + MAX_DECISION_TTL_MS);
  });

  it("refuses an expires outside five minutes to seven days", () => {
    for (const ms of [MIN_DECISION_TTL_MS - 1, MAX_DECISION_TTL_MS + 1, Number.NaN]) {
      expect(() => decisionExpiry(0, { expires_ms: ms }, false)).toThrow(RangeError);
    }
  });
});

const HASH = decisionHash(draft());
const vote = (choice: DecisionVote["choice"], human_approved = true, hash = HASH): DecisionVote =>
  ({ decision: 1, hash, choice, via: "action_response", human_approved, capacity: capacityOfVote({ via: "action_response", human_approved }) });
const ballot = (cursor: number, memberId: string, userId: string, v: DecisionVote): Ballot => ({ cursor, memberId, userId, vote: v });

describe("tally", () => {
  const electorate = ["m_a", "m_b", "m_c", "m_a2"];

  it("counts the latest vote of each account, binding and advisory apart", () => {
    const t = tally([
      ballot(2, "m_a", "u_a", vote("reject")),
      ballot(3, "m_b", "u_b", vote("approve")),
      ballot(4, "m_a", "u_a", vote("approve")),           // a revision replaces the reject
      ballot(5, "m_c", "u_c", vote("reject", false)),     // advisory
      ballot(6, "m_a2", "u_a", vote("abstain")),          // the same account's second seat: latest wins
    ], electorate);
    expect(t).toEqual({ approve: 1, reject: 0, abstain: 1, advisory: { approve: 0, reject: 1, abstain: 0 } });
  });

  it("leaves out a voided vote and a seat outside the electorate", () => {
    const t = tally([
      ballot(2, "m_a", "u_a", vote("approve")),
      ballot(3, "m_b", "u_b", vote("approve")),
      ballot(4, "m_x", "u_x", vote("approve")),
    ], electorate, [3]);
    expect(t).toMatchObject({ approve: 1, reject: 0, abstain: 0 });
  });
});

describe("decisionsOf", () => {
  const AT = 1_000_000;
  const opened = (cursor: number, over: Partial<DecisionOpened> = {}): SessionEvent => ({
    cursor, type: "decision_opened", fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a", refId: null, at: AT,
    payload: { ...draft(), expires_at: AT + ACTION_REQUEST_TTL_MS, electorate: ["m_a", "m_b"], hash: HASH, ...over } satisfies DecisionOpened,
  });
  const voted = (cursor: number, memberId: string, v: DecisionVote, decision = 1): SessionEvent => ({
    cursor, type: "decision_vote", fromMemberId: memberId, fromUserId: `u_${memberId.slice(2)}`, fromLabel: memberId,
    refId: null, at: AT, payload: { ...v, decision },
  });
  const system = (cursor: number, type: SessionEvent["type"], payload: object): SessionEvent => ({
    cursor, type, fromMemberId: "system", fromUserId: "system", fromLabel: "system", refId: null, at: AT, payload,
  });
  const closed = (cursor: number, state: "passed" | "failed" | "expired", decision = 1) =>
    system(cursor, "decision_closed", { decision, state, tally: { approve: 9, reject: 0, abstain: 0, advisory: { approve: 0, reject: 0, abstain: 0 } } });

  it("is open until its deadline and expired after it, with the clock injected", () => {
    const events = [opened(1)];
    expect(decisionStates(events, AT + ACTION_REQUEST_TTL_MS).get(1)).toBe("open");
    expect(decisionStates(events, AT + ACTION_REQUEST_TTL_MS + 1).get(1)).toBe("expired");
  });

  it("takes the first closing event, its stored tally, and reads no vote after it", () => {
    const v = decisionsOf([opened(1), voted(2, "m_a", vote("approve")), closed(3, "passed"), voted(4, "m_b", vote("reject")), closed(5, "failed")], AT).get(1)!;
    expect(v.state).toBe("passed");
    expect(v.closed!.cursor).toBe(3);
    expect(v.tally.approve).toBe(9);
    expect(v.ballots.map((b) => b.cursor)).toEqual([2]);
  });

  it("a closed decision does not expire", () => {
    expect(decisionStates([opened(1), closed(2, "failed")], AT + PROPOSAL_TTL_MS).get(1)).toBe("failed");
  });

  it("a voided vote stays in the log and leaves the tally", () => {
    const events = [
      opened(1), voted(2, "m_a", vote("approve")), voted(3, "m_b", vote("approve")),
      system(4, "decision_voter_removed", { decision: 1, member: "m_b", by: "m_a", reason: "evicted", voided: [3] }),
    ];
    const v = decisionsOf(events, AT).get(1)!;
    expect(v.ballots.map((b) => b.cursor)).toEqual([2, 3]);
    expect(v.voided).toEqual([3]);
    expect(v.tally.approve).toBe(1);
  });

  it("keeps two decisions apart", () => {
    const events = [opened(1), opened(2), voted(3, "m_a", vote("approve"), 2), closed(4, "failed", 1)];
    const views = decisionsOf(events, AT);
    expect(views.get(1)!.state).toBe("failed");
    expect(views.get(2)!).toMatchObject({ state: "open", tally: { approve: 1 } });
  });

  describe("applyVote", () => {
    const view = (events: SessionEvent[] = [opened(1)]) => decisionsOf(events, AT).get(1)!;
    const A = { memberId: "m_a", userId: "u_a" };

    it("records a vote from the electorate on the current hash, and the stub rule closes nothing", () => {
      expect(applyVote(view(), A, vote("approve"))).toEqual({ kind: "record", close: null });
    });

    it("refuses a vote on another hash as stale, naming the current hash", () => {
      expect(applyVote(view(), A, vote("approve", true, "f".repeat(64)))).toEqual({ kind: "stale", hash: HASH });
    });

    it("refuses a seat outside the electorate", () => {
      expect(applyVote(view(), { memberId: "m_late", userId: "u_late" }, vote("approve"))).toEqual({ kind: "not_electorate" });
    });

    it("refuses any vote once a closing event exists, before the hash is read", () => {
      expect(applyVote(view([opened(1), closed(2, "failed")]), A, vote("approve", true, "0".repeat(64))))
        .toEqual({ kind: "closed", state: "failed" });
    });

    it("lets a late vote land on a decision nobody has closed (decision 4)", () => {
      const late = decisionsOf([opened(1)], AT + PROPOSAL_TTL_MS).get(1)!;
      expect(late.state).toBe("expired");
      expect(applyVote(late, A, vote("approve")).kind).toBe("record");
    });
  });

  it("decideSupersede replaces only an open decision", () => {
    expect(decideSupersede(decisionsOf([opened(1)], AT).get(1))).toEqual({ kind: "replace" });
    expect(decideSupersede(decisionsOf([opened(1), closed(2, "passed")], AT).get(1))).toEqual({ kind: "not_open", state: "passed" });
    expect(decideSupersede(decisionsOf([opened(1)], AT + PROPOSAL_TTL_MS).get(1))).toEqual({ kind: "not_open", state: "expired" });
    expect(decideSupersede(undefined)).toEqual({ kind: "not_open", state: null });
  });

  it("decideClose refuses a closed decision and an expiry not yet due", () => {
    const open = decisionsOf([opened(1)], AT).get(1)!;
    expect(decideClose(open, "expired", AT + ACTION_REQUEST_TTL_MS)).toEqual({ kind: "not_due" });
    expect(decideClose(open, "expired", AT + ACTION_REQUEST_TTL_MS + 1)).toEqual({ kind: "close" });
    expect(decideClose(open, "failed", AT)).toEqual({ kind: "close" });
    expect(decideClose(decisionsOf([opened(1), closed(2, "passed")], AT).get(1)!, "failed", AT)).toEqual({ kind: "closed", state: "passed" });
  });
});
