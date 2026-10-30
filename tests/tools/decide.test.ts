/**
 * `bellman_decide` (ADR 0040, #405): open, vote and read a decision, the `action_response` that answers one as a
 * vote, and the open decisions a seat's `bellman_sync` lists as `outstanding`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/store.js";
import { Harness, envelopes, type Outcome } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { decisionHash } from "../../src/decision.js";

let h: Harness;
let p: PairedSession;

const roles = (peer: string[]) => ({
  lead: { can: ["send", "request_actions", "respond_actions", "invite", "vote"] },
  peer: { can: peer },
});
const manifest = (over: Record<string, unknown> = {}) => ({
  room: "decisions", mode: "pair", default_role: "peer", creator_role: "lead",
  roles: roles(["send", "respond_actions", "vote"]), decide: { surface_proposal: "majority" }, ...over,
});

beforeEach(async () => {
  h = new Harness(new MemoryStore());
  p = await pairUp(h, { manifest: manifest() });
});
afterEach(async () => { await h.close(); });

const room = () => ({ session_id: p.sessionId });
const open = (over: Record<string, unknown> = {}) => p.creator.call("bellman_decide", {
  ...room(), member_id: p.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: { title: "Plan" }, base: 0, ...over,
});
const hashOf = (key = "plan") => decisionHash({ key, effect: { title: "Plan", kind: "surface_proposal", base: 0 }, rule: "majority" });
const vote = (who: "creator" | "joiner", decision: unknown, over: Record<string, unknown> = {}) => p[who].call("bellman_decide", {
  ...room(), member_id: who === "creator" ? p.creatorMemberId : p.joinerMemberId,
  action: "vote", decision, hash: hashOf(), choice: "approve", human_approved: true, ...over,
});
const read = (who: "creator" | "joiner", decision?: unknown) => p[who].call("bellman_decide", {
  ...room(), member_id: who === "creator" ? p.creatorMemberId : p.joinerMemberId, action: "read",
  ...(decision === undefined ? {} : { decision }),
});
const answer = (decision: unknown, payload: Record<string, unknown>) => p.joiner.call("bellman_send", {
  ...room(), member_id: p.joinerMemberId, type: "action_response", ref_id: String(decision), payload,
});
const sync = () => p.joiner.call("bellman_sync", { ...room(), member_id: p.joinerMemberId, since_cursor: p.joinerCursor });
const ok = (out: Outcome) => { expect(out.isError, out.text).toBe(false); return out.data; };

describe("bellman_decide open", () => {
  it("opens a decision under the manifest's rule, hashed as the store hashes it, with both seats in its electorate", async () => {
    const out = ok(await open());
    expect(out).toMatchObject({ hash: hashOf(), rule: "majority", electorate: 2 });
    expect(typeof out.decision).toBe("number");
  });

  it("refuses a room with no decide block, a kind it does not declare, and a kind it decides by one approval", async () => {
    const plain = await pairUp(h, { manifest: manifest({ decide: undefined, roles: roles(["send"]) }) });
    const none = await plain.creator.call("bellman_decide", {
      session_id: plain.sessionId, member_id: plain.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {},
    });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/declares no decide block/);

    const single = await pairUp(h, { manifest: manifest({ decide: { surface_proposal: "single" } }) });
    const one = await single.creator.call("bellman_decide", {
      session_id: single.sessionId, member_id: single.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {},
    });
    expect(one.isError).toBe(true);
    expect(one.text).toMatch(/single approval.*action_request/);
  });

  it("refuses a seat without request_actions by the verb's name", async () => {
    const out = await p.joiner.call("bellman_decide", {
      ...room(), member_id: p.joinerMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {},
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('"request_actions"');
  });

  it("lets only the decision's opener supersede it", async () => {
    p = await pairUp(h, { manifest: manifest({ roles: roles(["send", "request_actions", "vote"]) }) });
    const first = ok(await open());
    const theirs = await p.joiner.call("bellman_decide", {
      ...room(), member_id: p.joinerMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {}, supersedes: first.decision,
    });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toMatch(/only the member who opened/);
    const mine = ok(await open({ effect: { title: "Plan v2" }, supersedes: first.decision }));
    expect(mine.superseded).toBe(first.decision);
    expect(ok(await read("creator", first.decision))).toMatchObject({ state: "failed", reason: "superseded" });
  });
});

describe("bellman_decide vote", () => {
  it("counts a vote its human approved and closes the decision on the vote that settles it", async () => {
    const { decision } = ok(await open());
    expect(ok(await vote("creator", decision))).toMatchObject({ capacity: "binding", state: "open" });
    expect(ok(await vote("joiner", decision))).toMatchObject({ capacity: "binding", state: "passed" });
  });

  it("records an agent's own vote as advisory, says so, and leaves it out of the tally", async () => {
    const { decision } = ok(await open());
    const out = ok(await vote("joiner", decision, { choice: "reject", human_approved: false, reason: "too early" }));
    expect(out).toMatchObject({ capacity: "advisory", state: "open" });
    expect(String(out.note)).toMatch(/human/);
    expect(ok(await read("creator", decision)).tally).toMatchObject({ approve: 0, reject: 0, advisory: { reject: 1 } });
  });

  it("refuses a seat without vote by the verb's name", async () => {
    const mute = await pairUp(h, { manifest: manifest({ roles: roles(["send", "respond_actions"]) }) });
    const opened = await mute.creator.call("bellman_decide", {
      session_id: mute.sessionId, member_id: mute.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {},
    });
    const out = await mute.joiner.call("bellman_decide", {
      session_id: mute.sessionId, member_id: mute.joinerMemberId, action: "vote", decision: opened.data.decision,
      hash: opened.data.hash, choice: "approve", human_approved: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('"vote"');
  });

  it("refuses a stale hash with the current one, and a vote after the close by its state", async () => {
    const { decision, hash } = ok(await open());
    const stale = await vote("joiner", decision, { hash: "0".repeat(64) });
    expect(stale.isError).toBe(true);
    expect(stale.data).toEqual({ error: "stale", hash });
    ok(await vote("creator", decision));
    ok(await vote("joiner", decision));
    const late = await vote("joiner", decision, { choice: "reject" });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/already passed/);
  });

  it("replays a vote retried under its key, and refuses a vote that names no decision", async () => {
    const { decision } = ok(await open());
    const first = ok(await vote("joiner", decision, { idempotency_key: "vote-key-1" }));
    const again = ok(await vote("joiner", decision, { idempotency_key: "vote-key-1" }));
    expect(again).toMatchObject({ cursor: first.cursor, replayed: true });
    const none = await vote("joiner", 99_999);
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/no decision/);
  });
});

describe("an action_response that answers a decision", () => {
  it("is a binding vote when its human approved, and closes the decision", async () => {
    const { decision, hash } = ok(await open());
    ok(await vote("creator", decision));
    const out = ok(await answer(decision, { approved: true, hash, human_approved: true }));
    expect(out).toMatchObject({ capacity: "binding", state: "passed" });
  });

  it("is advisory and uncounted when it was the agent's own call", async () => {
    const { decision, hash } = ok(await open());
    expect(ok(await answer(decision, { approved: false, hash, human_approved: false, result: "not yet" })))
      .toMatchObject({ capacity: "advisory", state: "open" });
    expect(ok(await read("creator", decision)).tally).toMatchObject({ reject: 0, advisory: { reject: 1 } });
  });

  it("needs the hash and human_approved, and the vote verb rather than respond_actions", async () => {
    const { decision, hash } = ok(await open());
    const bare = await answer(decision, { approved: true });
    expect(bare.isError).toBe(true);
    expect(bare.text).toMatch(/hash.*human_approved/);

    const mute = await pairUp(h, { manifest: manifest({ roles: roles(["send", "respond_actions"]) }) });
    const opened = await mute.creator.call("bellman_decide", {
      session_id: mute.sessionId, member_id: mute.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: {},
    });
    const out = await mute.joiner.call("bellman_send", {
      session_id: mute.sessionId, member_id: mute.joinerMemberId, type: "action_response", ref_id: String(opened.data.decision),
      payload: { approved: true, hash, human_approved: true },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('"vote"');
  });
});

describe("bellman_decide read", () => {
  it("shows each vote's seat, account, via, human_approved and cursor, and no upstream account id", async () => {
    const { decision, hash } = ok(await open());
    const cast = ok(await answer(decision, { approved: true, hash, human_approved: true, result: "my human said yes" }));
    const out = await read("creator", decision);
    const view = ok(out);
    expect(view).toMatchObject({ decision, state: "open", kind: "surface_proposal", hash });
    const votes = view.votes as Record<string, unknown>[];
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({
      cursor: cast.cursor, member_id: p.joinerMemberId, via: "action_response", human_approved: true, capacity: "binding", choice: "approve",
    });
    expect(votes[0].reason).toMatchObject({ trust: "untrusted", data: "my human said yes" });
    const seats = view.electorate as { member_id: string; account: string }[];
    expect(seats.find((m) => m.member_id === p.joinerMemberId)?.account).toBe(votes[0].account);
    expect(out.text).not.toContain(p.joiner.identity.userId);
    expect(out.text).not.toContain(p.creator.identity.userId);
  });

  it("lists the room's decisions, newest first, without votes", async () => {
    const a = ok(await open());
    const b = ok(await open({ key: "other" }));
    const list = ok(await read("joiner")).decisions as Record<string, unknown>[];
    expect(list.map((d) => d.decision)).toEqual([b.decision, a.decision]);
    expect(list[0].votes).toBeUndefined();
  });
});

describe("outstanding in bellman_sync", () => {
  it("lists an open decision to a seat in its electorate until that seat's human has voted", async () => {
    const { decision, hash } = ok(await open());
    const before = ok(await sync()).outstanding as Record<string, unknown>[];
    expect(before).toEqual([expect.objectContaining({
      cursor: decision, from_member_id: p.creatorMemberId, mine: false, decision: { kind: "surface_proposal", key: "plan", hash },
    })]);
    ok(await answer(decision, { approved: true, hash, human_approved: false }));
    expect(ok(await sync()).outstanding).toHaveLength(1); // an advisory vote is not the human's
    ok(await answer(decision, { approved: true, hash, human_approved: true }));
    expect(ok(await sync()).outstanding).toBeUndefined();
  });

  it("lists at most three open decisions from one opener", async () => {
    for (const key of ["a", "b", "c", "d"]) ok(await open({ key }));
    expect(ok(await sync()).outstanding).toHaveLength(3);
  });

  it("shows peers an alias for each seat's account, never the upstream id", async () => {
    ok(await open());
    const out = await sync();
    const opened = envelopes(ok(out).events).map((e) => e.data as { type: string; payload: { accounts?: Record<string, string> } })
      .find((e) => e.type === "decision_opened");
    expect(Object.values(opened?.payload.accounts ?? {})).toEqual(expect.arrayContaining(["a1", "a2"]));
    expect(out.text).not.toContain(p.creator.identity.userId);
  });
});
