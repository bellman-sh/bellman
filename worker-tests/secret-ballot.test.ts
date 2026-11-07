/**
 * Secret ballot release 1 in the real SessionDO: a secret vote reaches a room socket as the system with no choice,
 * live and on replay, and the deadline alarm erases an expired secret decision's ballot rows and keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, SELF, reset, runInDurableObject } from "cloudflare:test";
import { decisionHash, type DecisionDraft } from "../src/decision.js";
import { DurableObjectStore } from "../src/workerd/store-do.js";
import type { SessionDO } from "../src/workerd/session-do.js";
import type { EventBody, SessionEvent } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";
import { editRoom } from "../tests/helpers/rows.js";

afterEach(async () => {
  await reset();
});

/** The key vitest.config.ts binds; its identity is the creator `session()` seats, m_creator. */
const KEY = "qk_ws_test";

let rooms = 0;
/** A room under its own id where the creator and one more seat may vote, so one vote leaves a decision open. */
async function room() {
  const store = new DurableObjectStore(env as never);
  const pair = roomManifest();
  const manifest = roomManifest({ roles: { ...pair.roles, peer_a: { ...pair.roles.peer_a, can: [...pair.roles.peer_a.can, "vote"] } } });
  const base = session({ id: `qs_secret_${++rooms}`, manifest, joinCodes: {} });
  const s = { ...base, members: [...base.members, member({ memberId: "m_ben", userId: "u_ben", label: "ben@codenerd", roomRole: base.members[0]!.roomRole })] };
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

const draft: DecisionDraft = {
  key: "a", effect: { kind: "surface_proposal", item: { key: "a", kind: "text", body: "x" }, base: 0 }, rule: { rule: "majority", ballot: "secret" },
};
const opening: EventBody = { type: "decision_opened", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: draft, refId: null };
const ballot = (decision: number): EventBody => ({
  type: "decision_vote", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", refId: null,
  payload: { decision, hash: decisionHash(draft), choice: "approve", via: "action_response", human_approved: true },
});

async function socket(id: string) {
  const res = await SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });
  expect(res.status).toBe(101);
  const frames: string[] = [];
  res.webSocket!.accept();
  res.webSocket!.addEventListener("message", (e) => frames.push(String(e.data)));
  return frames;
}
const votes = (frames: string[]) => frames.map((f) => JSON.parse(f)).filter((f) => f.type === "decision_vote");

describe("secret ballots in SessionDO (release 1)", () => {
  it("a secret vote reaches a room socket with the system author and no choice, live and on replay", async () => {
    const { id, store } = await room();
    const live = await socket(id);
    const opened = await store.openDecision(id, opening, null);
    if (opened.outcome !== "appended") throw new Error(opened.outcome);
    expect(await store.castVote(id, ballot(opened.event.cursor), null)).toMatchObject({ outcome: "appended" });
    await vi.waitFor(() => expect(votes(live)).toHaveLength(1), { timeout: 3000 });
    const replay = await socket(id);
    await vi.waitFor(() => expect(votes(replay)).toHaveLength(1), { timeout: 3000 });
    for (const frame of [...votes(live), ...votes(replay)]) {
      expect(frame.from.member_id).toBe("system");
      expect(frame.payload).not.toHaveProperty("choice");
    }
    expect([...live, ...replay].join(""), "the voter's account never crosses").not.toContain("u_jesse");
  });

  it("the deadline alarm erases an expired secret decision's ballot rows and keys", async () => {
    const { id, store, stub } = await room();
    const opened = await store.openDecision(id, opening, null);
    if (opened.outcome !== "appended") throw new Error(opened.outcome);
    const cursor = opened.event.cursor;
    expect(await store.castVote(id, ballot(cursor), "k-1")).toMatchObject({ outcome: "appended", closed: null });
    const rows = () => runInDurableObject(stub, async (_i: SessionDO, ctx) => [...(await ctx.storage.list()).keys()]);
    expect((await rows()).some((k) => k.startsWith(`bv:${cursor}:`)), "the ballot row exists while open").toBe(true);
    const at = Date.now() - 1;
    await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
      await editRoom(ctx.storage, {
        record: (r) => {
          const book = r.openDecisions as Record<string, { expires_at: number; by: string }>;
          return { ...r, openDecisions: { ...book, [cursor]: { ...book[String(cursor)]!, expires_at: at } } };
        },
      });
      for (const [key, e] of await ctx.storage.list<SessionEvent>({ prefix: "e:" })) {
        if (e.cursor === cursor) await ctx.storage.put(key, { ...e, payload: { ...(e.payload as object), expires_at: at } });
      }
    });
    await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());
    const after = await rows();
    expect(after.filter((k) => k.startsWith("bv:")), "no ballot row").toEqual([]);
    expect(after.filter((k) => k.endsWith(":k-1")), "no idempotency record").toEqual([]);
    expect((await store.decision(id, cursor, Date.now()))!.state).toBe("expired");
  });

  it("erases a secret ballot with more ballot rows and keys than one storage call takes", async () => {
    const store = new DurableObjectStore(env as never);
    const pair = roomManifest();
    const manifest = roomManifest({ roles: { ...pair.roles, peer_a: { ...pair.roles.peer_a, can: [...pair.roles.peer_a.can, "vote"] } } });
    const base = session({ id: `qs_secret_${++rooms}`, manifest, joinCodes: {} });
    const role = base.members[0]!.roomRole;
    const voters = Array.from({ length: 70 }, (_, i) => member({ memberId: `m_v${i}`, userId: `u_v${i}`, label: `v${i}@codenerd`, roomRole: role }));
    await store.createSession({ ...base, members: [...base.members, ...voters] });
    const stub = env.SESSION.get(env.SESSION.idFromName(base.id));
    const opened = await store.openDecision(base.id, { ...opening, payload: { ...draft, rule: { rule: "unanimous", ballot: "secret" } } }, null);
    if (opened.outcome !== "appended") throw new Error(opened.outcome);
    const cursor = opened.event.cursor;
    const hash = (opened.event.payload as { hash: string }).hash;
    for (const v of voters) {
      const out = await store.castVote(base.id, {
        type: "decision_vote", fromMemberId: v.memberId, fromUserId: v.userId, fromLabel: v.label, refId: null,
        payload: { decision: cursor, hash, choice: "approve", via: "action_response", human_approved: true },
      }, `big-${v.memberId}`);
      expect(out, v.memberId).toMatchObject({ outcome: "appended", closed: null });
    }
    const keys = () => runInDurableObject(stub, async (_i: SessionDO, ctx) => [...(await ctx.storage.list()).keys()]);
    expect((await keys()).filter((k) => k.startsWith(`bv:${cursor}:`) || k.includes(":big-")).length).toBe(140);
    const deadline = (opened.event.payload as { expires_at: number }).expires_at;
    expect(await store.closeDecision(base.id, cursor, { state: "expired" }, deadline + 1)).toMatchObject({ outcome: "appended" });
    expect((await keys()).filter((k) => k.startsWith("bv:") || k.includes(":big-"))).toEqual([]);
  });
});
