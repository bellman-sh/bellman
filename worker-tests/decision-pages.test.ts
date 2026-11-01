/**
 * #411 in the real SessionDO: the `dx:` index a page of decisions is read from, written for decisions opened before
 * it by the first page read, and a vote reaching a room socket as an ordinary frame the panel refetches on.
 * Decisions from before the deploy are made here by opening them and then deleting their `dx:` rows and the marker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, SELF, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { decisionHash, type DecisionDraft } from "../src/decision.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
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
  it("writes the index for decisions opened before it on the first page read, once", async () => {
    const { id, store, stub } = await room();
    const closed = await store.openDecision(id, opening("a"), null);
    if (closed.outcome !== "appended") throw new Error(closed.outcome);
    await store.castVote(id, ballot(closed.event.cursor, "a"), null);
    const open = await store.openDecision(id, opening("b"), null);
    if (open.outcome !== "appended") throw new Error(open.outcome);
    const rows = () => runInDurableObject(stub, async (_i: SessionDO, ctx) => [...(await ctx.storage.list({ prefix: "dx" })).entries()]);
    expect(await rows()).toEqual([
      [`dx:${String(closed.event.cursor).padStart(12, "0")}`, { closed: closed.event.cursor + 2 }],
      [`dx:${String(open.event.cursor).padStart(12, "0")}`, { closed: null }],
    ]);

    await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
      await ctx.storage.delete([...(await ctx.storage.list({ prefix: "dx" })).keys()]);
    });
    expect(await rows()).toEqual([]);

    const page = await store.decisions(id, { limit: 10 }, Date.now());
    expect(page.decisions.map((v) => [v.cursor, v.state])).toEqual([[open.event.cursor, "open"], [closed.event.cursor, "passed"]]);
    expect(page.open.map((v) => v.cursor)).toEqual([open.event.cursor]);
    expect((await rows()).map(([k]) => k)).toEqual([
      `dx-built`, `dx:${String(closed.event.cursor).padStart(12, "0")}`, `dx:${String(open.event.cursor).padStart(12, "0")}`,
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
