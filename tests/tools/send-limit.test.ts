import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief } from "../helpers/fixtures.js";
import { joinWith, pairUp, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
import { MAX_PAYLOAD_CHARS } from "../../src/payload.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

describe("who is a stranger (spec \u{A7}2)", () => {
  it("records a seat taken through the permanent code as a stranger's, and one through a code that expires as not", async () => {
    const room = await publicRoom(h);
    const stranger = await joinWith(await h.connect(DEV_KEY.peer), room.code);
    const observer = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "observer" });
    const regular = await joinWith(await h.connect(DEV_KEY.outsider), String(observer.data.join_code));
    expect((await h.store.getMember(room.sessionId, String(stranger.data.member_id)))?.via).toBe("permanent");
    expect((await h.store.getMember(room.sessionId, String(regular.data.member_id)))?.via).toBeUndefined();
    expect((await h.store.getMember(room.sessionId, room.memberId))?.via, "the creator").toBeUndefined();
  });

  // The creator is never a stranger, by the first seat or by any later one: the permanent code is the link
  // everyone else uses, and the creator can redeem it for another handle like anyone.
  it("does not mark the creator's own handle a stranger when the creator redeems their room's permanent code", async () => {
    const room = await publicRoom(h);
    const joined = await joinWith(room.creator, room.code);
    expect(joined.isError, joined.text).toBe(false);
    const handle = String(joined.data.member_id);
    expect(handle, "the premise: a second handle").not.toBe(room.memberId);
    expect((await h.store.getMember(room.sessionId, handle))?.via, "the creator's second handle").toBeUndefined();
    for (let i = 0; i < 7; i++) {
      const r = await room.creator.call("bellman_send", { session_id: room.sessionId, member_id: handle, type: "message", payload: { text: `m${i}` } });
      expect(r.isError, `send ${i + 1}: ${r.text}`).toBe(false);
    }
  });
});

describe("the send limit (spec \u{A7}2)", () => {
  it("refuses a member's 31st send in a minute as rate_limited with retry_after, and logs nothing for it", async () => {
    const s = await pairUp(h);
    const send = (i: number) => s.joiner.call("bellman_send", { session_id: s.sessionId, member_id: s.joinerMemberId, type: "message", payload: { text: `m${i}` } });
    for (let i = 0; i < 30; i++) expect((await send(i)).isError, `send ${i + 1}`).toBe(false);
    const before = (await h.store.eventsAfter(s.sessionId, 0)).length;
    const refused = await send(30);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("rate_limited");
    expect(refused.data).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
    expect(refused.data.retry_after as number).toBeGreaterThanOrEqual(1);
    expect(refused.data.retry_after as number).toBeLessThanOrEqual(60);
    expect((await h.store.eventsAfter(s.sessionId, 0)).length).toBe(before);
  });

  it("refuses a stranger's 7th send, counting every kind", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const kinds = [
      { type: "message", payload: { text: "hi" } },
      { type: "artifact", payload: { name: "a.md", content: "b" } },
      { type: "progress", payload: { note: "working" } },
      { type: "brief_update", payload: brief() },
      { type: "message", payload: { text: "five" } },
      { type: "message", payload: { text: "six" } },
    ];
    for (const [i, k] of kinds.entries()) {
      const r = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, ...k });
      expect(r.isError, `${k.type}, send ${i + 1}: ${r.text}`).toBe(false);
    }
    const seventh = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: "seven" } });
    expect(seventh.data).toMatchObject({ error: "rate_limited" });
  });

  it("gives a member who joined the same public room with a code that expires a member's 30", async () => {
    const room = await publicRoom(h);
    const lead = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "lead" });
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, String(lead.data.join_code))).data.member_id);
    for (let i = 0; i < 7; i++) {
      const r = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: `m${i}` } });
      expect(r.isError, `send ${i + 1}: ${r.text}`).toBe(false);
    }
  });

  /** Review Focus 3. */
  it("counts a keyed retry as a send, and once the minute passes the retry replays instead of sending twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const send = (key: string) => peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: key }, idempotency_key: key });
    for (let i = 0; i < 6; i++) expect((await send(`key-${i}-padded`)).isError).toBe(false);
    expect((await send("key-5-padded")).data).toMatchObject({ error: "rate_limited" });
    const count = (await h.store.eventsAfter(room.sessionId, 0)).length;
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send("key-5-padded")).data).toMatchObject({ replayed: true });
    expect((await h.store.eventsAfter(room.sessionId, 0)).length).toBe(count);
  });

  it("counts each member's sends on their own, the creator's against the creator and a stranger's against the stranger", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const send = (who: { call: typeof peer.call }, id: string, text: string) =>
      who.call("bellman_send", { session_id: room.sessionId, member_id: id, type: "message", payload: { text } });
    for (let i = 0; i < 6; i++) expect((await send(room.creator, room.memberId, `c${i}`)).isError, `creator send ${i + 1}`).toBe(false);
    for (let i = 0; i < 6; i++) expect((await send(peer, memberId, `p${i}`)).isError, `stranger send ${i + 1}`).toBe(false);
    expect((await send(peer, memberId, "seven")).data).toMatchObject({ error: "rate_limited" });
    const creator = await send(room.creator, room.memberId, "c6");
    expect(creator.isError, creator.text).toBe(false);
  });

  it("rounds retry_after up to whole seconds, and the text says the limit and the wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const send = (text: string) => peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text } });
    for (let i = 0; i < 6; i++) expect((await send(`m${i}`)).isError).toBe(false);
    vi.setSystemTime(Date.now() + 59_500);
    const refused = await send("seven");
    expect(refused.data).toEqual({ error: "rate_limited", retry_after: 1 });
    expect(refused.text).toMatch(/rate_limited: .*\b6 sends\b.*\b1 second\b/);
  });

  it("counts a surface write as a send, and one refused for its shape spends no place", async () => {
    const p = await pairUp(h);
    const write = (payload: Record<string, unknown>) =>
      p.creator.call("bellman_send", { session_id: p.sessionId, member_id: p.creatorMemberId, type: "surface", payload });
    for (let i = 0; i < 5; i++) {
      const bad = await write({ key: "bad", kind: "nonsense" });
      expect(bad.isError, `refused write ${i + 1}`).toBe(true);
      expect(bad.text, `refused write ${i + 1}`).not.toContain("rate_limited");
    }
    for (let i = 0; i < 30; i++) expect((await write({ key: `k${i}`, kind: "text", body: "x" })).isError, `write ${i + 1}`).toBe(false);
    const refused = await write({ key: "k30", kind: "text", body: "x" });
    expect(refused.data).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
    expect((await h.store.surfaceOf(p.sessionId)).map((r) => r.key)).not.toContain("k30");
  });

  it("spends no place on a send refused for another reason", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const send = (type: string, payload: Record<string, unknown>) =>
      peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type, payload });
    const refusals = [
      await send("action_request", { ask: "run it" }),
      await send("message", { text: "x".repeat(MAX_PAYLOAD_CHARS + 1) }),
      await send("action_response", { approved: true }),
      await send("brief_update", { goal: "only a goal" }),
      await send("progress", { status: "fine" }),
    ];
    for (const [i, r] of refusals.entries()) {
      expect(r.isError, `refusal ${i + 1}`).toBe(true);
      expect(r.text, `refusal ${i + 1}`).not.toContain("rate_limited");
    }
    for (let i = 0; i < 6; i++) expect((await send("message", { text: `m${i}` })).isError, `send ${i + 1}`).toBe(false);
    expect((await send("message", { text: "seven" })).data).toMatchObject({ error: "rate_limited" });
  });
});

// Whose minute a send is counted in. A stranger's belongs to the account within the room: every confirm mints a
// handle, and a script that joins the permanent code again and again would start each one at zero. A member's
// belongs to the seat, so one account's several agents in a busy swarm do not share a single 30.
describe("whose minute a send is counted in (spec \u{A7}2)", () => {
  const sender = (peer: Peer, sessionId: string) => (memberId: string, text: string) =>
    peer.call("bellman_send", { session_id: sessionId, member_id: memberId, type: "message", payload: { text } });

  it("counts a stranger's sends per account: a second handle taken through the permanent code shares the first's 6", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const first = String((await joinWith(peer, room.code)).data.member_id);
    const second = String((await joinWith(peer, room.code)).data.member_id);
    expect(second, "the premise: a second handle").not.toBe(first);
    const send = sender(peer, room.sessionId);
    for (let i = 0; i < 4; i++) expect((await send(first, `a${i}`)).isError, `first handle, send ${i + 1}`).toBe(false);
    for (let i = 0; i < 2; i++) expect((await send(second, `b${i}`)).isError, `second handle, send ${i + 5}`).toBe(false);
    expect((await send(second, "seven")).data, "the account's 7th, on the second handle").toMatchObject({ error: "rate_limited" });
    expect((await send(first, "eight")).data, "and on the first").toMatchObject({ error: "rate_limited" });
  });

  // What the agent is told is the artifact: the two limits and what a refusal is. How the count is kept, in memory
  // or stored, is nothing an agent acts on, and every word of the description costs tokens on every request.
  it("tells the agent the two limits and the refusal, and not how the count is kept", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const doc = tools.find((t) => t.name === "bellman_send")!.description!;
    const limits = doc.slice(doc.indexOf("A member sends at most"));
    expect(limits).toContain("A member sends at most 30 times a minute, and one who joined through a public room's permanent code 6;");
    expect(limits).toContain("past that the send is refused as rate_limited with retry_after in seconds, and nothing is sent.");
    expect(limits).not.toMatch(/in memory|stored|counted per/);
  });

  it("counts two strangers' accounts apart: one account's 6 leave the other's untouched", async () => {
    const room = await publicRoom(h);
    const [a, b] = [await h.connect(DEV_KEY.peer), await h.connect(DEV_KEY.outsider)];
    const aId = String((await joinWith(a, room.code)).data.member_id);
    const bId = String((await joinWith(b, room.code)).data.member_id);
    const fromA = sender(a, room.sessionId);
    for (let i = 0; i < 6; i++) expect((await fromA(aId, `a${i}`)).isError, `first account, send ${i + 1}`).toBe(false);
    expect((await fromA(aId, "seven")).data, "the premise: the first account is full").toMatchObject({ error: "rate_limited" });
    const other = await sender(b, room.sessionId)(bId, "mine");
    expect(other.isError, other.text).toBe(false);
  });

  it("keeps a stranger's count when they leave and rejoin through the permanent code inside the minute", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const first = String((await joinWith(peer, room.code)).data.member_id);
    const send = sender(peer, room.sessionId);
    for (let i = 0; i < 6; i++) expect((await send(first, `m${i}`)).isError, `send ${i + 1}`).toBe(false);
    const left = await peer.call("bellman_leave", { session_id: room.sessionId, member_id: first });
    expect(left.isError, left.text).toBe(false);
    const again = await joinWith(peer, room.code);
    expect(again.isError, again.text).toBe(false);
    expect((await send(String(again.data.member_id), "back")).data).toMatchObject({ error: "rate_limited" });
  });

  // The key's direction: the first handle is filled to its 30, the larger limit, and the second handle then
  // acts. Keyed by account the second would find the first's 30 and be refused.
  it("counts a member's sends per seat: an account's second handle on a code that expires keeps its own 30", async () => {
    const room = await publicRoom(h);
    const lead = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "lead" });
    const joined = await joinWith(room.creator, String(lead.data.join_code));
    expect(joined.isError, joined.text).toBe(false);
    const second = String(joined.data.member_id);
    const send = sender(room.creator, room.sessionId);
    for (let i = 0; i < 30; i++) expect((await send(room.memberId, `c${i}`)).isError, `first handle, send ${i + 1}`).toBe(false);
    expect((await send(room.memberId, "31st")).data, "the premise: the first handle is full").toMatchObject({ error: "rate_limited" });
    const own = await send(second, "own");
    expect(own.isError, own.text).toBe(false);
  });
});
