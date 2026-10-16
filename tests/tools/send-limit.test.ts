import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief } from "../helpers/fixtures.js";
import { joinWith, pairUp, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
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
