/**
 * #411 in the real SessionDO: the index a page of decisions is read from, which page reads write and appends never do,
 * and a vote reaching a room socket as an ordinary frame the panel refetches on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, SELF, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { decisionHash, type DecisionDraft } from "../src/decision.js";
import { DurableObjectStore } from "../src/workerd/store-do.js";
import { DECISION_INDEX_BATCH, type SessionDO } from "../src/workerd/session-do.js";
import type { EventBody } from "../src/types.js";
import { roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** The key vitest.config.ts binds; its identity is the creator `session()` seats, m_creator. */
const KEY = "qk_ws_test";

async function room() {
  const store = new DurableObjectStore(env as never);
  const pair = roomManifest();
  const manifest = roomManifest({ roles: { ...pair.roles, peer_a: { ...pair.roles.peer_a, can: [...pair.roles.peer_a.can, "vote"] } } });
  const s = session({ manifest });
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

const draft = (key: string): DecisionDraft => ({ key, effect: { kind: "surface_proposal", item: { key, kind: "text", body: "x" }, base: 0 }, rule: "unanimous" });
const opening = (key: string): EventBody =>
  ({ type: "decision_opened", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: draft(key), refId: null });
const ballot = (decision: number, key: string): EventBody => ({
  type: "decision_vote", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", refId: null,
  payload: { decision, hash: decisionHash(draft(key)), choice: "approve", via: "action_response", human_approved: true },
});

describe("decision pages in SessionDO (#411)", () => {
  // A thousand appends in sequence: under a full workerd run it takes about ten seconds of the default fifteen, so it
  // has its own budget rather than failing on whatever else the run is doing.
  it("indexes nothing on append, and on a page read each decision and its own events, a batch at a time", { timeout: 30_000 }, async () => {
    const { id, store, stub } = await room();
    const closed = await store.openDecision(id, opening("a"), null);
    if (closed.outcome !== "appended") throw new Error(closed.outcome);
    await store.castVote(id, ballot(closed.event.cursor, "a"), null);
    const open = await store.openDecision(id, opening("b"), null);
    if (open.outcome !== "appended") throw new Error(open.outcome);
    for (let i = 0; i < DECISION_INDEX_BATCH; i++) {
      await store.appendEvent(id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: `n${i}` }, refId: null });
    }
    const late = await store.castVote(id, ballot(open.event.cursor, "b"), null);
    if (late.outcome !== "appended") throw new Error(late.outcome);
    const rows = () => runInDurableObject(stub, async (_i: SessionDO, ctx) =>
      [...(await ctx.storage.list({ prefix: "d" })).entries()].map(([k, v]) => [k, typeof v === "object" && v !== null ? (v as { cursor: number }).cursor : v]));
    expect(await rows(), "no append writes the index").toEqual([]);

    const page = await store.decisions(id, { limit: 10 }, Date.now());
    expect(page.decisions.map((v) => [v.cursor, v.state])).toEqual([[open.event.cursor, "passed"], [closed.event.cursor, "passed"]]);
    const pad = (c: number) => String(c).padStart(12, "0");
    expect(await rows(), "a decision's rows hold its own events and not the messages between them").toEqual([
      ["dv:" + pad(closed.event.cursor) + ":" + pad(closed.event.cursor), closed.event.cursor],
      ["dv:" + pad(closed.event.cursor) + ":" + pad(closed.event.cursor + 1), closed.event.cursor + 1],
      ["dv:" + pad(closed.event.cursor) + ":" + pad(closed.event.cursor + 2), closed.event.cursor + 2],
      ["dv:" + pad(open.event.cursor) + ":" + pad(open.event.cursor), open.event.cursor],
      ["dv:" + pad(open.event.cursor) + ":" + pad(late.event.cursor), late.event.cursor],
      ["dv:" + pad(open.event.cursor) + ":" + pad(late.event.cursor + 1), late.event.cursor + 1],
      ["dx-at", late.event.cursor + 1],
      ["dx:" + pad(closed.event.cursor), true],
      ["dx:" + pad(open.event.cursor), true],
    ]);
  });

  it("sends a vote and the close it causes to a room socket as ordinary frames", async () => {
    const { id, store } = await room();
    const res = await SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(101);
    const frames: string[] = [];
    res.webSocket!.accept();
    res.webSocket!.addEventListener("message", (e) => frames.push(String(e.data)));

    const opened = await store.openDecision(id, opening("a"), null);
    if (opened.outcome !== "appended") throw new Error(opened.outcome);
    await store.castVote(id, ballot(opened.event.cursor, "a"), null);
    const decisionFrames = () => frames.map((f) => JSON.parse(f)).filter((f) => String(f.type).startsWith("decision_"));
    await vi.waitFor(() => expect(decisionFrames()).toHaveLength(3), { timeout: 3000 });
    expect(decisionFrames().map((f) => f.type)).toEqual(["decision_opened", "decision_vote", "decision_closed"]);
    expect(frames.join(""), "an account reaches a socket as its alias").not.toContain("u_jesse");
  });
});
