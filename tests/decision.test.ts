/**
 * A room's decisions (ADR 0040, #402): the content hash, the tally, the derived state and what a store does with a
 * vote. Pure; the stores' half is the "decisions" block of tests/helpers/store-contract.ts.
 */
import { describe, expect, it } from "vitest";
import {
  applyVote, capacityOfVote, decideClose, decideOpenQuota, decideSupersede, decisionAudit, decisionExpiry, decisionHash,
  decisionStates, decisionsOf, dueToExpire, evaluate, noteDecisions, removalEvents, ruleOf, tally, DECISION_EVENTS,
  MAX_DECISION_TTL_MS, MAX_OPEN_DECISIONS, MAX_OPEN_PER_SEAT, MAX_REVISIONS, MIN_DECISION_TTL_MS,
  type Ballot, type DecisionClosed, type DecisionOpened, type DecisionRule, type FailReason, type DecisionView, type DecisionVote,
  type OpenDecisions, type VoterRemoved,
} from "../src/decision.js";
import { ACTION_REQUEST_TTL_MS, PROPOSAL_TTL_MS } from "../src/action-state.js";
import type { EventType, SessionEvent } from "../src/types.js";

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

/** The part of a decision `tally` and `evaluate` read, with `u_<seat>` as each seat's account unless `accounts` says. */
type Counted = Pick<DecisionView, "payload" | "ballots" | "voided" | "removed">;
const counted = (
  rule: DecisionRule, electorate: string[], ballots: Ballot[] = [],
  over: { veto?: string[]; accounts?: Record<string, string>; voided?: number[]; removed?: string[] } = {},
): Counted => ({
  payload: {
    ...draft(), rule, expires_at: 0, hash: HASH, electorate,
    accounts: { ...Object.fromEntries(electorate.map((m) => [m, `u_${m}`])), ...over.accounts },
    ...(over.veto === undefined ? {} : { veto: over.veto }),
  },
  ballots, voided: over.voided ?? [], removed: over.removed ?? [],
});
/** Ballots from `"<seat>:<choice>"`, `"<seat>:<choice>?"` for an advisory one, cursors from 2 in order. */
const cast = (...votes: string[]): Ballot[] => votes.map((v, i) => {
  const [seat, rest] = v.split(":");
  const choice = rest.replace("?", "") as DecisionVote["choice"];
  return ballot(i + 2, seat, `u_${seat}`, vote(choice, !rest.endsWith("?")));
});

describe("tally", () => {
  const electorate = ["m_a", "m_b", "m_c", "m_a2"];
  const accounts = { m_a2: "u_m_a" };

  it("counts the latest vote of each account, binding and advisory apart, and accounts not seats", () => {
    const t = tally(counted("majority", electorate, [
      ballot(2, "m_a", "u_m_a", vote("reject")),
      ballot(3, "m_b", "u_m_b", vote("approve")),
      ballot(4, "m_a", "u_m_a", vote("approve")),           // a revision replaces the reject
      ballot(5, "m_c", "u_m_c", vote("reject", false)),     // advisory
      ballot(6, "m_a2", "u_m_a", vote("abstain")),          // the same account's second seat: latest wins
    ], { accounts }));
    expect(t).toEqual({
      approve: 1, reject: 0, abstain: 1, advisory: { approve: 0, reject: 1, abstain: 0 },
      electorate: 3, unreachable: 0, turnout: 2, quorum: null,
    });
  });

  it("leaves out a voided vote, a removed seat's every vote, and a seat outside the electorate", () => {
    const t = tally(counted("majority", electorate, [
      ballot(2, "m_a", "u_m_a", vote("approve")),
      ballot(3, "m_b", "u_m_b", vote("approve")),
      ballot(4, "m_x", "u_m_x", vote("approve")),
      ballot(5, "m_c", "u_m_c", vote("approve")),
    ], { accounts, voided: [3], removed: ["m_c"] }));
    expect(t).toMatchObject({ approve: 1, reject: 0, abstain: 0, electorate: 3, unreachable: 1, turnout: 1 });
  });

  it("counts an account unreachable only once every seat it held is removed", () => {
    expect(tally(counted("majority", electorate, [], { accounts, removed: ["m_a"] })).unreachable).toBe(0);
    expect(tally(counted("majority", electorate, [], { accounts, removed: ["m_a", "m_a2"] })).unreachable).toBe(1);
  });

  it("states the quorum as the turnout needed, rounded up", () => {
    expect(tally(counted({ rule: "majority", quorum: 60 }, ["a", "b", "c", "d", "e"])).quorum).toBe(3);
    expect(tally(counted({ rule: "majority", quorum: 60 }, ["a", "b", "c"])).quorum).toBe(2);
    expect(tally(counted({ rule: "majority", quorum: 34 }, ["a", "b", "c"])).quorum).toBe(2);
    expect(tally(counted({ rule: "majority", quorum: null }, ["a", "b", "c"])).quorum).toBeNull();
  });
});

describe("ruleOf", () => {
  it("reads a rule's name alone or with the quorum the manifest resolved, and nothing outside the set", () => {
    expect(ruleOf("unanimous")).toEqual({ rule: "unanimous", quorum: null });
    expect(ruleOf({ rule: "majority", quorum: 60 })).toEqual({ rule: "majority", quorum: 60 });
    expect(ruleOf({ rule: "plurality" })).toEqual({ rule: null, quorum: null });
  });
});

describe("evaluate", () => {
  const SEATS = ["a", "b", "c"];
  const PASSED = { state: "passed" } as const;
  const failed = (reason: FailReason) => ({ state: "failed", reason }) as const;

  // Three seats, no veto, no quorum. Each row is a sequence of votes and the close it calls for.
  const rules: [DecisionRule, string[], ReturnType<typeof evaluate>][] = [
    ["majority", [], null],
    ["majority", ["a:approve"], null],                                    // the other two could reject
    ["majority", ["a:approve", "b:approve"], PASSED],                     // 2 against at worst 1
    ["majority", ["a:approve", "b:reject"], null],
    ["majority", ["a:approve", "b:reject", "c:abstain"], failed("rejected")], // a tie is no majority
    ["majority", ["a:reject", "b:reject"], failed("rejected")],
    ["majority", ["a:approve", "b:abstain"], null],                       // c could still reject
    ["majority", ["a:approve", "b:abstain", "c:abstain"], PASSED],        // abstain is not a no
    ["majority", ["a:abstain", "b:abstain", "c:abstain"], failed("rejected")],
    ["majority", ["a:reject", "a:approve", "b:approve"], PASSED],         // a revision counts in place of the vote before
    ["supermajority", ["a:approve", "b:approve"], PASSED],                // 2 of 3 at worst
    ["supermajority", ["a:approve", "b:reject"], null],                   // c approving makes 2 of 3
    ["supermajority", ["a:approve", "b:reject", "c:approve"], PASSED],
    ["supermajority", ["a:approve", "b:reject", "c:reject"], failed("rejected")],
    ["supermajority", ["a:approve", "b:reject", "c:abstain"], failed("rejected")], // 1 of 2 is short of two thirds
    ["unanimous", ["a:approve", "b:approve"], null],                      // c could reject
    ["unanimous", ["a:approve", "b:approve", "c:approve"], PASSED],
    ["unanimous", ["a:approve", "b:abstain", "c:abstain"], PASSED],       // every seat that did not abstain approved
    ["unanimous", ["a:approve", "b:reject"], failed("rejected")],
    ["unanimous", ["a:abstain", "b:abstain", "c:abstain"], failed("rejected")],
    ["single", ["a:approve", "b:approve", "c:approve"], null],            // the action_request flow, never closed here
    ["plurality", ["a:approve", "b:approve", "c:approve"], null],
  ];
  it.each(rules)("%s after %j closes %j", (rule, votes, want) => {
    expect(evaluate(counted(rule, SEATS, cast(...votes)))).toEqual(want);
  });

  it("an electorate of one passes alone", () => {
    expect(evaluate(counted("unanimous", ["a"], cast("a:approve")))).toEqual(PASSED);
  });

  it("an advisory vote neither counts, nor stands for its account, nor replaces the account's binding vote", () => {
    expect(evaluate(counted("majority", SEATS, cast("a:approve?", "b:approve?", "c:approve?")))).toBeNull();
    expect(evaluate(counted("majority", SEATS, cast("a:approve", "b:approve", "b:reject?")))).toEqual(PASSED);
    expect(tally(counted("majority", SEATS, cast("a:approve", "a:reject?")))).toMatchObject({ approve: 1, advisory: { reject: 1 } });
  });

  // c holds the veto. A veto seat's binding reject fails it; until it has voted, nothing passes.
  const vetoes: [string[], string[], ReturnType<typeof evaluate>][] = [
    [["c"], ["a:approve", "b:approve"], null],                            // would pass, but c has yet to vote
    [["c"], ["a:approve", "b:approve", "c:reject"], failed("vetoed")],
    [["c"], ["c:reject"], failed("vetoed")],
    [["c"], ["a:approve", "b:approve", "c:abstain"], PASSED],             // a veto holder's abstain does not block
    [["c"], ["a:approve", "b:approve", "c:approve"], PASSED],
    [["c"], ["a:approve", "b:approve", "c:reject?"], null],               // an advisory reject is no veto
    [["c"], ["a:reject", "b:reject"], failed("rejected")],
    [["b", "c"], ["a:approve", "b:approve", "c:abstain"], PASSED],
    [["b", "c"], ["a:approve", "b:approve"], null],
    [[], ["a:approve"], failed("blocked")],                               // a role vetoes the kind and nobody holding it was seated
  ];
  it.each(vetoes)("majority with veto %j after %j closes %j", (veto, votes, want) => {
    expect(evaluate(counted("majority", SEATS, cast(...votes), { veto }))).toEqual(want);
  });

  it("counts an unreachable seat as a possible reject when passing, and as no approver when failing", () => {
    expect(evaluate(counted("majority", SEATS, cast("a:approve", "b:abstain")))).toBeNull();
    expect(evaluate(counted("majority", SEATS, cast("a:approve", "b:abstain"), { removed: ["c"] }))).toBeNull();
    expect(evaluate(counted("majority", SEATS, cast("a:reject", "b:abstain"), { removed: ["c"] }))).toEqual(failed("rejected"));
  });

  it("fails blocked once no veto seat is reachable, the veto seat's approval voided with it", () => {
    const ballots = cast("a:approve", "b:approve", "c:approve");
    expect(evaluate(counted("majority", SEATS, ballots, { veto: ["c"], removed: ["c"], voided: [4] }))).toEqual(failed("blocked"));
  });

  // Five seats, quorum 80%: a turnout of 4. Each row's close under majority, supermajority and unanimous.
  type Close = ReturnType<typeof evaluate>;
  const quorums: [string, string[], string[], [Close, Close, Close]][] = [
    ["not yet met, though a majority holds", ["a:approve", "b:approve", "c:approve"], [], [null, null, null]],
    ["met, an abstain counting as presence", ["a:approve", "b:approve", "c:approve", "d:abstain"], [], [PASSED, PASSED, null]],
    ["met by four approvals, e still able to reject", ["a:approve", "b:approve", "c:approve", "d:approve"], [], [PASSED, PASSED, null]],
    ["met by five approvals", ["a:approve", "b:approve", "c:approve", "d:approve", "e:approve"], [], [PASSED, PASSED, PASSED]],
    ["not met by an advisory vote", ["a:approve", "b:approve", "c:approve", "d:approve?"], [], [null, null, null]],
    ["out of reach once two seats are unreachable", ["a:approve"], ["d", "e"], [failed("no_quorum"), failed("no_quorum"), failed("no_quorum")]],
    ["still in reach with one unreachable", ["a:approve"], ["e"], [null, null, null]],
  ];
  (["majority", "supermajority", "unanimous"] as const).forEach((rule, i) => {
    it.each(quorums)(`${rule}, quorum 80%%: %s`, (_, votes, removed, want) => {
      expect(evaluate(counted({ rule, quorum: 80 }, ["a", "b", "c", "d", "e"], cast(...votes), { removed }))).toEqual(want[i]);
    });
  });

  it("a single rule takes no quorum, and one written anyway closes nothing", () => {
    expect(evaluate(counted({ rule: "single", quorum: 10 }, SEATS, cast("a:approve", "b:approve", "c:approve")))).toBeNull();
  });

  /** A random decision: one to five seats, two sharing an account sometimes, a random rule, quorum and veto. */
  function randomDecision(next: () => number): Counted {
    const seats = ["a", "b", "c", "d", "e"].slice(0, 1 + Math.floor(next() * 5));
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const rule = pick(["majority", "supermajority", "unanimous"]);
    const quorum = pick([null, 34, 50, 80, 100]);
    const veto = pick([undefined, [], seats.filter(() => next() < 0.4)]);
    const accounts = seats.length > 1 && next() < 0.3 ? { [seats[1]]: `u_${seats[0]}` } : {};
    return counted({ rule, quorum }, seats, [], { veto, accounts });
  }
  const choices = ["approve", "reject", "abstain"] as const;

  it("no leave, eviction or join turns a decision that has not passed into passed (property, 3000 seeds)", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const next = rng(seed);
      let d = randomDecision(next);
      const seats = d.payload.electorate;
      for (let step = 0, cursor = 2; step < 12 && evaluate(d) === null; step++, cursor++) {
        const seat = seats[Math.floor(next() * seats.length)];
        const roll = next();
        if (roll < 0.25) {
          // A leave or an eviction: the seat's votes are voided and the seat stays in the snapshot.
          const voided = d.ballots.filter((b) => b.memberId === seat).map((b) => b.cursor);
          d = { ...d, removed: [...d.removed, seat], voided: [...d.voided, ...voided] };
          expect(evaluate(d)?.state, `seed ${seed}, step ${step}: removing ${seat}`).not.toBe("passed");
        } else if (roll < 0.4) {
          // A join: a newcomer, or the removed seat back, and its vote.
          const who = d.removed.includes(seat) && next() < 0.5 ? seat : `new${cursor}`;
          const view = { ...d, cursor: 1, closed: null } as unknown as DecisionView;
          const out = applyVote(view, { memberId: who, userId: d.payload.accounts[who] ?? `u_${who}` }, vote(choices[cursor % 3]));
          expect(out, `seed ${seed}, step ${step}: ${who} joining`).toEqual({ kind: "not_electorate" });
        } else if (!d.removed.includes(seat)) {
          const userId = d.payload.accounts[seat];
          d = { ...d, ballots: [...d.ballots, ballot(cursor, seat, userId, vote(choices[Math.floor(next() * 3)], next() < 0.8))] };
        }
      }
    }
  });

  it("fails blocked once one of several veto seats is removed, though every veto seat left approves (T5, #407)", () => {
    const d = counted("majority", SEATS, cast("a:approve", "b:approve", "c:approve"), { veto: ["b", "c"], removed: ["c"], voided: [4] });
    expect(evaluate(d)).toEqual(failed("blocked"));
    // Not when the account it shared keeps a veto seat: that account can still veto.
    const shared = counted("majority", ["a", "b", "c"], cast("a:approve", "b:approve"), { veto: ["b", "c"], accounts: { c: "u_b" }, removed: ["c"] });
    expect(evaluate(shared)).toEqual(PASSED);
  });

  it("a decision that has lost a veto seat never passes, whatever votes follow (property, 1000 seeds)", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const next = rng(seed);
      const base = randomDecision(next);
      const seats = base.payload.electorate;
      const veto = base.payload.veto ?? [];
      if (veto.length === 0) continue;
      const gone = veto[Math.floor(next() * veto.length)];
      if (seats.some((m) => m !== gone && veto.includes(m) && base.payload.accounts[m] === base.payload.accounts[gone])) continue;
      let d: Counted = { ...base, removed: [gone] };
      for (let cursor = 2; cursor < 14; cursor++) {
        const seat = seats[Math.floor(next() * seats.length)];
        if (seat === gone) continue;
        d = { ...d, ballots: [...d.ballots, ballot(cursor, seat, d.payload.accounts[seat], vote(choices[Math.floor(next() * 3)], next() < 0.8))] };
        expect(evaluate(d)?.state, `seed ${seed}, vote ${cursor}`).not.toBe("passed");
      }
    }
  });

  it("removing a seat brings back no vote its account's other seat cast before it", () => {
    // u_a holds a and b: b's reject replaced a's approve, and voiding it leaves u_a with no vote, not the approve.
    const ballots = [ballot(2, "a", "u_a", vote("approve")), ballot(3, "b", "u_a", vote("reject")), ballot(4, "c", "u_c", vote("approve"))];
    const d = counted("supermajority", ["a", "b", "c", "d"], ballots, { accounts: { a: "u_a", b: "u_a" }, removed: ["b"], voided: [3] });
    expect(tally(d)).toMatchObject({ approve: 1, reject: 0, electorate: 3, unreachable: 0 });
    expect(evaluate(d)).toBeNull();
  });

  it("voiding gives what the vote never cast would, with the seat unreachable (property, 300 seeds, one seat per account)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed);
      const d = randomDecision(next);
      if (new Set(Object.values(d.payload.accounts)).size < d.payload.electorate.length) continue;
      const seats = d.payload.electorate;
      const ballots = Array.from({ length: Math.floor(next() * 8) }, (_, i) => {
        const seat = seats[Math.floor(next() * seats.length)];
        return ballot(i + 2, seat, d.payload.accounts[seat], vote(choices[Math.floor(next() * 3)], next() < 0.8));
      });
      const gone = seats[Math.floor(next() * seats.length)];
      const voided = ballots.filter((b) => b.memberId === gone).map((b) => b.cursor);
      const withVoid = { ...d, ballots, voided, removed: [gone] };
      const neverCast = { ...d, ballots: ballots.filter((b) => b.memberId !== gone), removed: [gone] };
      expect(tally(withVoid), `seed ${seed}`).toEqual(tally(neverCast));
      expect(evaluate(withVoid), `seed ${seed}`).toEqual(evaluate(neverCast));
    }
  });

  it("advisory votes never change the binding tally, the turnout or the close (property, 300 seeds)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed);
      const d = randomDecision(next);
      const seats = d.payload.electorate;
      const binding: Ballot[] = [];
      const all: Ballot[] = [];
      for (let i = 0; i < 10; i++) {
        const seat = seats[Math.floor(next() * seats.length)];
        const b = ballot(i + 2, seat, d.payload.accounts[seat], vote(choices[Math.floor(next() * 3)], next() < 0.5));
        all.push(b);
        if (b.vote.capacity === "binding") binding.push(b);
      }
      const { advisory: _a, ...withAdvisory } = tally({ ...d, ballots: all });
      const { advisory: _b, ...without } = tally({ ...d, ballots: binding });
      expect(withAdvisory, `seed ${seed}`).toEqual(without);
      expect(evaluate({ ...d, ballots: all }), `seed ${seed}`).toEqual(evaluate({ ...d, ballots: binding }));
    }
  });
});

describe("decisionsOf", () => {
  const AT = 1_000_000;
  const opened = (cursor: number, over: Partial<DecisionOpened> = {}): SessionEvent => ({
    cursor, type: "decision_opened", fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a", refId: null, at: AT,
    payload: {
      ...draft(), expires_at: AT + ACTION_REQUEST_TTL_MS, electorate: ["m_a", "m_b"], accounts: { m_a: "u_a", m_b: "u_b" }, hash: HASH, ...over,
    } satisfies DecisionOpened,
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
    expect(v.removed).toEqual(["m_b"]);
    expect(v.tally).toMatchObject({ approve: 1, unreachable: 1 });
  });

  it("reads only decision events: any other event, shaped like a vote or a judge's signal, changes nothing (property, #424)", () => {
    const others = (["message", "progress", "surface", "housekeeping", "action_response", "brief_update"] as EventType[]);
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const pure: SessionEvent[] = [opened(1, { rule: { rule: "majority", quorum: 50 } }), opened(2, { rule: "unanimous" })];
      const mixed = [...pure];
      for (let cursor = 3; cursor < 30; cursor++) {
        const decision = 1 + Math.floor(next() * 2);
        const choice = (["approve", "reject", "abstain"] as const)[Math.floor(next() * 3)];
        if (next() < 0.5) {
          const e = voted(cursor, next() < 0.5 ? "m_a" : "m_b", vote(choice, next() < 0.7), decision);
          pure.push(e);
          mixed.push(e);
        } else {
          // A signal: no seat, any non-decision type, a payload naming the decision with a vote's fields and a judge's.
          const type = others[Math.floor(next() * others.length)];
          mixed.push(system(cursor, type, { decision, hash: HASH, choice, capacity: "binding", signal_id: `s${cursor}`, bands: ["high"] }));
        }
      }
      expect(mixed.some((e) => !(DECISION_EVENTS as readonly string[]).includes(e.type)), `seed ${seed}`).toBe(true);
      const strip = (m: Map<number, DecisionView>) => [...m.values()].map(({ opened: _, closed: __, ...v }) => v);
      expect(strip(decisionsOf(mixed, AT)), `seed ${seed}`).toEqual(strip(decisionsOf(pure, AT)));
      for (const v of decisionsOf(mixed, AT).values()) {
        const agentVotes = v.ballots.filter((b) => b.vote.capacity === "advisory");
        const advisory = v.tally.advisory.approve + v.tally.advisory.reject + v.tally.advisory.abstain;
        expect(advisory, `seed ${seed}: tally.advisory counts seats' advisory votes only`).toBeLessThanOrEqual(new Set(agentVotes.map((b) => b.userId)).size);
      }
    }
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

    it("records a vote from the electorate on the current hash, with the close it calls for", () => {
      expect(applyVote(view(), A, vote("approve"))).toEqual({ kind: "record", close: null });
      const majority = view([opened(1, { rule: "majority" }), voted(2, "m_b", vote("approve"))]);
      expect(applyVote(majority, A, vote("approve"))).toEqual({ kind: "record", close: { state: "passed" } });
      expect(applyVote(majority, A, vote("reject"))).toEqual({ kind: "record", close: { state: "failed", reason: "rejected" } });
    });

    it("refuses a vote on another hash as stale, naming the current hash", () => {
      expect(applyVote(view(), A, vote("approve", true, "f".repeat(64)))).toEqual({ kind: "stale", hash: HASH });
    });

    it("refuses a seat outside the electorate, and a removed seat back in the room", () => {
      expect(applyVote(view(), { memberId: "m_late", userId: "u_late" }, vote("approve"))).toEqual({ kind: "not_electorate" });
      const removed = view([opened(1), system(2, "decision_voter_removed", { decision: 1, member: "m_a", by: "m_b", reason: "left", voided: [] })]);
      expect(applyVote(removed, A, vote("approve"))).toEqual({ kind: "not_electorate" });
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

describe("removals, quotas and audit rows (#407)", () => {
  const AT = 1_000_000;
  const opened = (cursor: number, over: Partial<DecisionOpened> = {}, by = "m_a"): SessionEvent => ({
    cursor, type: "decision_opened", fromMemberId: by, fromUserId: `u_${by.slice(2)}`, fromLabel: by, refId: null, at: AT,
    payload: {
      ...draft(), rule: "majority", expires_at: AT + ACTION_REQUEST_TTL_MS, electorate: ["m_a", "m_b", "m_c"],
      accounts: { m_a: "u_a", m_b: "u_b", m_c: "u_c" }, hash: HASH, ...over,
    } satisfies DecisionOpened,
  });
  const voted = (cursor: number, memberId: string, v: DecisionVote, decision = 1): SessionEvent => ({
    cursor, type: "decision_vote", fromMemberId: memberId, fromUserId: `u_${memberId.slice(2)}`, fromLabel: memberId,
    refId: null, at: AT, payload: { ...v, decision },
  });
  const closedBy = (cursor: number, decision = 1): SessionEvent => ({
    cursor, type: "decision_closed", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null, at: AT,
    payload: { decision, state: "failed", reason: "rejected", tally: tally({ ...decisionsOf([opened(decision)], AT).get(decision)! }) },
  });
  const evicted = { type: "member_evicted" as const, fromMemberId: "system", fromUserId: "u_creator", fromLabel: "creator@x", payload: {}, refId: null };
  const left = (m: string) => ({ type: "member_left" as const, fromMemberId: m, fromUserId: `u_${m.slice(2)}`, fromLabel: m, payload: {}, refId: null });
  const views = (events: SessionEvent[]) => decisionsOf(events, AT).values();

  it("voids the seat's votes on every unclosed decision it is in, naming them, and leaves a closed one alone", () => {
    const events = [
      opened(1), voted(2, "m_b", vote("approve")), voted(3, "m_b", vote("reject")), voted(4, "m_a", vote("approve")),
      opened(5, { electorate: ["m_a", "m_c"] }), opened(6), closedBy(7, 6),
    ];
    expect(removalEvents(views(events), "m_b", evicted)).toEqual([{
      type: "decision_voter_removed", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null,
      payload: { decision: 1, member: "m_b", by: "creator@x", reason: "evicted", voided: [2, 3] } satisfies VoterRemoved,
    }]);
    // m_c leaving decision 1 with a for and an against leaves no seat to break the tie, so it closes it rejected.
    expect(removalEvents(views(events), "m_c", left("m_c")).map((e) => [e.type, e.payload])).toEqual([
      ["decision_voter_removed", { decision: 1, member: "m_c", by: "m_c", reason: "left", voided: [] }],
      ["decision_closed", expect.objectContaining({ decision: 1, state: "failed", reason: "rejected" })],
      ["decision_voter_removed", { decision: 5, member: "m_c", by: "m_c", reason: "left", voided: [] }],
    ]);
  });

  it("writes nothing for a seat already removed, and nothing for a seat outside every electorate", () => {
    const removed = { ...opened(2), cursor: 2, type: "decision_voter_removed" as const, fromMemberId: "system",
      payload: { decision: 1, member: "m_b", by: "x", reason: "left", voided: [] } };
    expect(removalEvents(views([opened(1), removed]), "m_b", evicted)).toEqual([]);
    expect(removalEvents(views([opened(1)]), "m_late", evicted)).toEqual([]);
  });

  it("closes the decision the removal settles, with the tally after the voiding: blocked for the only veto seat", () => {
    const out = removalEvents(views([opened(1, { veto: ["m_c"] }), voted(2, "m_c", vote("approve"))]), "m_c", left("m_c"));
    expect(out.map((e) => e.type)).toEqual(["decision_voter_removed", "decision_closed"]);
    expect(out[1].payload).toMatchObject({ decision: 1, state: "failed", reason: "blocked", tally: { approve: 0, unreachable: 1 } });
  });

  it("never closes a decision passed (property, 2000 seeds)", () => {
    const seats = ["m_a", "m_b", "m_c", "m_d"];
    for (let seed = 1; seed <= 2000; seed++) {
      const next = rng(seed);
      const rule = (["majority", "supermajority", "unanimous", { rule: "majority", quorum: 50 }] as DecisionRule[])[seed % 4];
      const events: SessionEvent[] = [opened(1, {
        rule, electorate: seats, accounts: Object.fromEntries(seats.map((m) => [m, `u_${m.slice(2)}`])),
        ...(next() < 0.5 ? { veto: seats.filter(() => next() < 0.4) } : {}),
      })];
      for (let cursor = 2; cursor < 2 + Math.floor(next() * 4); cursor++) {
        const by = seats[Math.floor(next() * seats.length)];
        events.push(voted(cursor, by, vote((["approve", "reject", "abstain"] as const)[Math.floor(next() * 3)], next() < 0.8)));
      }
      if (decisionsOf(events, AT).get(1)!.state !== "open" || evaluate(decisionsOf(events, AT).get(1)!) !== null) continue;
      const out = removalEvents(views(events), seats[Math.floor(next() * seats.length)], evicted);
      expect(out.some((e) => (e.payload as DecisionClosed).state === "passed"), `seed ${seed}`).toBe(false);
    }
  });

  it("keeps a book of unclosed decisions: an opening adds one, its closing event removes it, anything else is the same book", () => {
    const book = noteDecisions({}, [opened(1), opened(5, {}, "m_b"), voted(6, "m_a", vote("approve"), 1)]);
    expect(book).toEqual({ 1: { expires_at: AT + ACTION_REQUEST_TTL_MS, by: "m_a" }, 5: { expires_at: AT + ACTION_REQUEST_TTL_MS, by: "m_b" } });
    expect(noteDecisions(book, [closedBy(7, 5)])).toEqual({ 1: book[1] });
    expect(noteDecisions(book, [voted(8, "m_a", vote("approve"))])).toBe(book);
  });

  it("refuses an open at exactly 20 in the room and 3 for the seat, counting no expired decision and not the one superseded", () => {
    const of = (n: number, by: (i: number) => string, expires = AT + 1): OpenDecisions =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { expires_at: expires, by: by(i) }]));
    expect(MAX_OPEN_DECISIONS).toBe(20);
    expect(MAX_OPEN_PER_SEAT).toBe(3);
    expect(decideOpenQuota(of(19, (i) => `m_${i % 7}`), "m_x", AT)).toEqual({ kind: "ok" });
    expect(decideOpenQuota(of(20, (i) => `m_${i % 7}`), "m_x", AT)).toEqual({ kind: "quota", scope: "room", limit: 20 });
    expect(decideOpenQuota(of(20, (i) => `m_${i % 7}`), "m_x", AT + 2), "all past due").toEqual({ kind: "ok" });
    expect(decideOpenQuota(of(2, () => "m_a"), "m_a", AT)).toEqual({ kind: "ok" });
    expect(decideOpenQuota(of(3, () => "m_a"), "m_a", AT)).toEqual({ kind: "quota", scope: "seat", limit: 3 });
    expect(decideOpenQuota(of(3, () => "m_a"), "m_b", AT)).toEqual({ kind: "ok" });
    expect(decideOpenQuota(of(3, () => "m_a"), "m_a", AT, 2), "superseding one of the three").toEqual({ kind: "ok" });
    expect(dueToExpire(of(3, () => "m_a"), AT + 1)).toEqual([]);
    expect(dueToExpire(of(3, () => "m_a"), AT + 2)).toEqual([1, 2, 3]);
  });

  it("lands a seat's first vote and five revisions, and refuses the sixth revision", () => {
    expect(MAX_REVISIONS).toBe(5);
    const events: SessionEvent[] = [opened(1)];
    for (let i = 0; i <= MAX_REVISIONS; i++) {
      expect(applyVote(decisionsOf(events, AT).get(1)!, { memberId: "m_a", userId: "u_a" }, vote("abstain")).kind, `vote ${i + 1}`).toBe("record");
      events.push(voted(2 + i, "m_a", vote("abstain")));
    }
    expect(applyVote(decisionsOf(events, AT).get(1)!, { memberId: "m_a", userId: "u_a" }, vote("approve"))).toEqual({ kind: "quota", limit: 5 });
    expect(applyVote(decisionsOf(events, AT).get(1)!, { memberId: "m_b", userId: "u_b" }, vote("approve")).kind, "another seat").toBe("record");
  });

  it("files one row per org for each opening, close and removal, with ids, hashes and counts and never the proposal", () => {
    const template = ["org_a", "org_b"].map((orgId) => ({
      at: AT, orgId, sessionId: "qs_1", actorUserId: "u_a", action: "decision_vote", detail: { anything: true },
    }));
    const removal: SessionEvent = { ...removalEvents(views([opened(1), voted(2, "m_b", vote("approve"))]), "m_b", evicted)[0], cursor: 3, at: AT };
    const close: SessionEvent = {
      cursor: 5, at: AT, type: "decision_closed", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null,
      payload: { decision: 1, state: "failed", reason: "rejected", tally: tally(decisionsOf([opened(1)], AT).get(1)!) },
    };
    const vote4 = { ...voted(4, "m_a", vote("reject")), payload: { ...vote("reject"), decision: 1, response_cursor: 9 } };
    const events = [opened(1), voted(2, "m_b", vote("approve")), removal, vote4, close];
    const rows = decisionAudit(template, events, decisionsOf(events, AT));
    expect(rows.map((r) => [r.orgId, r.action])).toEqual([
      ["org_a", "decision_opened"], ["org_b", "decision_opened"],
      ["org_a", "decision_voter_removed"], ["org_b", "decision_voter_removed"],
      ["org_a", "decision_closed"], ["org_b", "decision_closed"],
    ]);
    expect(rows[0].detail).toEqual({
      decision: 1, kind: "surface_proposal", key: "tools", hash: HASH, rule: "majority", quorum: null, electorate: 3,
      expires_at: AT + ACTION_REQUEST_TTL_MS,
    });
    expect(rows[2].detail).toEqual({ decision: 1, member_id: "m_b", user_id: "u_b", reason: "evicted", voided: [2] });
    expect(rows[4].detail).toMatchObject({
      decision: 1, kind: "surface_proposal", hash: HASH, state: "failed", reason: "rejected",
      votes: [{ cursor: 4, member_id: "m_a", user_id: "u_a", choice: "reject", via: "action_response", human_approved: true, response_cursor: 9 }],
    });
    expect(JSON.stringify(rows), "no effect content").not.toContain("example.com");
  });
});
