/**
 * `POST /rooms/:id/requests/:cursor/answer` (src/http/answer.ts): a person signed in to the dash answers an action
 * request as one of their seats, through `answerAction`, the operation `bellman_send type: "action_response"` runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { pairUp, propose, topicRoom, type PairedSession } from "./helpers/flows.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

let h: Harness;
let deps: RoomRouteDeps;
let p: PairedSession;
beforeEach(async () => {
  h = new Harness();
  deps = { store: h.store, blobs: h.blobs, caller, panelOrigins: [PANEL] };
  p = await pairUp(h);
});
afterEach(async () => { await h.close(); });

interface Over { key?: string; cookie?: string | null; origin?: string | null; method?: string; body?: unknown }

/** The dash's answer as `memberId` (the creator's seat by default), signed in as jesse with the panel's Origin. */
async function answer(sessionId: string, cursor: unknown, memberId: string, over: Over = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (over.key) headers.authorization = `Bearer ${over.key}`;
  const cookie = over.cookie === undefined ? DEV_KEY.jesse : over.cookie;
  if (cookie) headers.cookie = `__Host-bellman_session=${cookie}`;
  const origin = over.origin === undefined ? PANEL : over.origin;
  if (origin) headers.origin = origin;
  const body = JSON.stringify(over.body === undefined ? { approved: true, result: "done" } : over.body);
  const url = `${ISSUER}/rooms/${sessionId}/requests/${String(cursor)}/answer?member_id=${memberId}`;
  return (await roomRoutes(new Request(url, { method: over.method ?? "POST", headers, body }), deps))!;
}
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** The joiner asks the room to act; the creator's human answers in the dash. */
const ask = async () => {
  const out = await p.joiner.call("bellman_send", {
    session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request", payload: { ask: "run the tests" },
  });
  expect(out.isError, out.text).toBe(false);
  return Number(out.data.cursor);
};
const responses = async () => (await h.store.eventsAfter(p.sessionId, 0)).filter((e) => e.type === "action_response");

describe("POST /rooms/:id/requests/:cursor/answer", () => {
  it("appends the creator seat's action_response with only approved and result, and the requester's sync shows it answered", async () => {
    const cursor = await ask();
    const res = await answer(p.sessionId, cursor, p.creatorMemberId, { body: { approved: true, result: "done", extra: "dropped" } });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const [response] = await responses();
    expect(response).toMatchObject({ fromMemberId: p.creatorMemberId, refId: String(cursor), payload: { approved: true, result: "done" } });
    expect(response.payload).not.toHaveProperty("extra");
    expect(body).toEqual({ cursor: response.cursor, room_members: [expect.any(String)] });
    const sync = await p.joiner.call("bellman_sync", { session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: cursor });
    expect(sync.data.outstanding, "an answered request leaves outstanding").toBeUndefined();
  });

  it("records a decline, and refuses a second answer from the dash or the tool, so the first one counts", async () => {
    const cursor = await ask();
    expect((await answer(p.sessionId, cursor, p.creatorMemberId, { body: { approved: false } })).status).toBe(200);
    const again = await answer(p.sessionId, cursor, p.creatorMemberId);
    expect([again.status, (await bodyOf(again)).error]).toEqual([409, "conflict"]);
    const tool = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response", ref_id: String(cursor), payload: { approved: true },
    });
    expect(tool.text).toMatch(/already answered/);
    expect((await responses()).map((e) => e.payload)).toEqual([{ approved: false }]);
  });

  it("approves a topic room's proposal and writes its card, as the tool's approval does", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const res = await answer(r.sessionId, asked.data.cursor, r.maintainerId);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.applied).toMatchObject({ key: "tools" });
    expect((await h.store.surfaceOf(r.sessionId)).map((row) => row.key)).toEqual(["tools"]);
  });

  it("refuses a bearer, a cookie without the panel's Origin, and no credential, and appends nothing", async () => {
    const cursor = await ask();
    const bearer = await answer(p.sessionId, cursor, p.creatorMemberId, { key: DEV_KEY.jesse, cookie: null });
    expect([bearer.status, (await bodyOf(bearer)).error]).toEqual([403, "dash_session_required"]);
    expect((await answer(p.sessionId, cursor, p.creatorMemberId, { origin: null })).status).toBe(403);
    expect((await answer(p.sessionId, cursor, p.creatorMemberId, { cookie: null })).status).toBe(401);
    expect(await responses()).toEqual([]);
  });

  it("refuses another account's seat as an unknown room, your own request, a bad body, a non-request, and a decision", async () => {
    const cursor = await ask();
    const stranger = await answer(p.sessionId, cursor, p.joinerMemberId);
    expect(stranger.status, "jesse holds no such seat").toBe(404);
    const own = await answer(p.sessionId, cursor, p.joinerMemberId, { cookie: DEV_KEY.peer });
    expect([own.status, (await bodyOf(own)).error]).toEqual([400, "invalid"]);
    for (const body of [{ approved: "yes" }, {}, [true], null]) {
      expect((await answer(p.sessionId, cursor, p.creatorMemberId, { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await answer(p.sessionId, 1, p.creatorMemberId)).status, "cursor 1 is not a request").toBe(404);
    expect((await answer(p.sessionId, "007", p.creatorMemberId)).status).toBe(404);
    expect((await answer(p.sessionId, cursor, p.creatorMemberId, { method: "PUT" })).headers.get("allow")).toBe("POST");
    expect(await responses()).toEqual([]);
  });
});

describe("POST /rooms/:id/requests/:cursor/answer on a decision", () => {
  it("refuses to answer a decision, which is voted on", async () => {
    const d = await pairUp(h, {
      manifest: {
        room: "decisions", mode: "pair", default_role: "peer", creator_role: "lead",
        roles: { lead: { can: ["send", "request_actions", "respond_actions", "vote"] }, peer: { can: ["send", "respond_actions", "vote"] } },
        decide: { surface_proposal: "majority" },
      },
    });
    const opened = await d.creator.call("bellman_decide", {
      session_id: d.sessionId, member_id: d.creatorMemberId, action: "open", kind: "surface_proposal", key: "plan", effect: { title: "Plan" }, base: 0,
    });
    expect(opened.isError, opened.text).toBe(false);
    const res = await answer(d.sessionId, opened.data.decision, d.joinerMemberId, { cookie: DEV_KEY.peer });
    expect([res.status, (await bodyOf(res)).error]).toEqual([400, "invalid_request"]);
  });
});
