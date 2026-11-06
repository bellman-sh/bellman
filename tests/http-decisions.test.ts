/**
 * GET /rooms/:id/decisions (#411): the room's decisions for the panel, open ones always and every closed one on some
 * page, with a body-hash ETag. Driven over MemoryStore with no listener, as http-rooms.test.ts drives the other routes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { DECISION_PAGE, decisionHash, type DecisionDraft } from "../src/decision.js";
import { roomRoutes, type RoomCaller } from "../src/http/rooms.js";
import { decisionShown } from "../src/projections.js";
import { MemoryStore } from "../src/store.js";
import type { Member } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

const ROOM = "qs_decisions";
const PANEL = "https://dash.example.test";

let store: MemoryStore;
let blobs: MemoryBlobStore;

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
  return identity ? { identity, via: "bearer" } : null;
};

const JESSE = member();
const PEER = member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  const pair = roomManifest();
  const voting = roomManifest({
    roles: Object.fromEntries(Object.entries(pair.roles).map(([name, r]) => [name, { ...r, can: [...r.can, "vote"] }])),
  });
  await store.createSession(session({ id: ROOM, members: [JESSE, PEER], manifest: voting }));
});

const call = (key: string | null, path: string, headers: Record<string, string> = {}) =>
  roomRoutes(new Request(`https://mcp.example.test${path}`, {
    headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  }), { store, blobs, caller, panelOrigins: [PANEL] });

interface Shown {
  decision: number;
  state: string;
  tally: { approve: number; advisory: { approve: number } };
  electorate: { member_id: string; label: string | null; voted: boolean }[];
  votes: { cursor: number; label: string | null; capacity: string }[];
  advisory_votes: { cursor: number; capacity: string }[];
}
interface Page { open: Shown[]; decisions: Shown[]; next: number | null }
const read = async (key: string, query = "") => {
  const res = (await call(key, `/rooms/${ROOM}/decisions${query}`))!;
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};

const draft = (key = "tools"): DecisionDraft => ({
  key, effect: { kind: "surface_proposal", item: { key, kind: "text", body: "ship" }, base: 0 }, rule: "unanimous",
});
const open = async (key = "tools", by: Member = JESSE) => {
  const out = await store.openDecision(ROOM, {
    type: "decision_opened", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label, payload: draft(key), refId: null,
  }, null);
  if (out.outcome !== "appended") throw new Error(out.outcome);
  return out.event.cursor;
};
const vote = async (decision: number, by: Member, humanApproved = true, key = "tools") => {
  const out = await store.castVote(ROOM, {
    type: "decision_vote", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label, refId: null,
    payload: { decision, hash: decisionHash(draft(key)), choice: "approve", via: "action_response", human_approved: humanApproved },
  }, null);
  if (out.outcome !== "appended") throw new Error(out.outcome);
  return out.event.cursor;
};
/** Opens a decision and passes it, so it is closed. */
const passed = async (key: string) => {
  const d = await open(key);
  await vote(d, JESSE, true, key);
  await vote(d, PEER, true, key);
  return d;
};

describe("GET /rooms/:id/decisions", () => {
  it("refuses without a credential, hides the room from a stranger, and takes GET alone", async () => {
    expect((await call(null, `/rooms/${ROOM}/decisions`))!.status).toBe(401);
    const stranger = (await call(DEV_KEY.outsider, `/rooms/${ROOM}/decisions`))!;
    const unknown = (await call(DEV_KEY.jesse, "/rooms/qs_nowhere/decisions"))!;
    expect([stranger.status, unknown.status]).toEqual([404, 404]);
    const post = (await roomRoutes(new Request(`https://mcp.example.test/rooms/${ROOM}/decisions`, { method: "POST" }), {
      store, blobs, caller, panelOrigins: [PANEL],
    }))!;
    expect(post.status).toBe(405);
  });

  it("shows binding and advisory votes apart, counts only the binding, and names who has voted", async () => {
    const d = await open();
    const bound = await vote(d, JESSE);
    const advised = await vote(d, PEER, false);
    const body = await read(DEV_KEY.peer);
    expect(body.open.map((v) => v.decision)).toEqual([d]);
    expect(body.decisions.map((v) => v.decision)).toEqual([d]);
    const [shown] = body.open;
    expect(shown.votes.map((v) => [v.cursor, v.capacity])).toEqual([[bound, "binding"]]);
    expect(shown.advisory_votes.map((v) => [v.cursor, v.capacity])).toEqual([[advised, "advisory"]]);
    expect(shown.tally).toMatchObject({ approve: 1, advisory: { approve: 1 } });
    expect(shown.electorate).toEqual([
      expect.objectContaining({ member_id: "m_creator", voted: true }),
      expect.objectContaining({ member_id: "m_peer", voted: false }),
    ]);
    expect(JSON.stringify(body), "an account reaches peers as its alias").not.toMatch(/u_jesse|u_peer/);
  });

  it("answers 304 to its own ETag until a vote changes what it shows", async () => {
    const d = await open();
    const first = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/decisions`, { origin: PANEL }))!;
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("access-control-expose-headers")).toBe("etag");
    expect(first.headers.get("access-control-allow-origin")).toBe(PANEL);
    const again = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/decisions`, { "if-none-match": tag }))!;
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    await vote(d, JESSE);
    const moved = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/decisions`, { "if-none-match": tag }))!;
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(tag);
  });

  it("pages every decision newest first, and lists an open one whichever page it is on", async () => {
    const old = await open("old");
    const closed = [await passed("a"), await passed("b"), await passed("c")];
    const first = await read(DEV_KEY.jesse, "?limit=2");
    expect(first.decisions.map((v) => v.decision)).toEqual([closed[2], closed[1]]);
    expect(first.open.map((v) => v.decision)).toEqual([old]);
    expect(first.next).toBe(closed[1]);
    const second = await read(DEV_KEY.jesse, `?limit=2&before=${first.next}`);
    expect(second.decisions.map((v) => [v.decision, v.state])).toEqual([[closed[0], "passed"], [old, "open"]]);
    expect(second.next).toBeNull();
  });

  it("keeps a closed decision readable past the socket's 1,000-event replay", async () => {
    const d = await passed("tools");
    for (let i = 0; i < 1_001; i++) {
      await store.appendEvent(ROOM, {
        type: "message", fromMemberId: JESSE.memberId, fromUserId: JESSE.userId, fromLabel: JESSE.label, payload: { text: `n${i}` }, refId: null,
      });
    }
    const body = await read(DEV_KEY.peer);
    expect(body.decisions.map((v) => [v.decision, v.state, v.votes.length])).toEqual([[d, "passed", 2]]);
    expect(body.open).toEqual([]);
  });

  it("reads a removed member's decisions to its cut, with nothing open", async () => {
    const before = await open("before");
    const h = new Harness(store, blobs);
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_evict", { session_id: ROOM, member_id: "m_peer" });
    await h.close();
    expect(out.isError, out.text).toBe(false);
    await open("after");
    const body = await read(DEV_KEY.peer);
    expect(body.decisions.map((v) => v.decision)).toEqual([before]);
    expect(body.open).toEqual([]);
  });

  it("labels a seat that has left, in the route and in bellman_decide read alike", async () => {
    const d = await open();
    await vote(d, PEER);
    const h = new Harness(store, blobs);
    const jesse = await h.connect(DEV_KEY.jesse);
    expect((await jesse.call("bellman_evict", { session_id: ROOM, member_id: "m_peer" })).isError).toBe(false);
    const told = await jesse.call("bellman_decide", { session_id: ROOM, member_id: "m_creator", action: "read", decision: d });
    await h.close();
    const [shown] = (await read(DEV_KEY.jesse)).decisions;
    expect(told.isError, told.text).toBe(false);
    const tool = JSON.parse(told.text.slice(told.text.indexOf("{"))) as Shown;
    for (const v of [shown, tool]) {
      expect(v.electorate.find((e) => e.member_id === "m_peer")?.label).toBe("peer@codenerd");
      expect(v.votes.map((b) => b.label)).toEqual(["peer@codenerd"]);
    }
  });

  it("refuses a before or limit that is not a whole number in range", async () => {
    for (const q of ["?before=0", "?before=x", "?limit=0", `?limit=101`, "?limit=1.5"]) {
      expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/decisions${q}`))!.status, q).toBe(400);
    }
    expect((await read(DEV_KEY.jesse, `?limit=${DECISION_PAGE}`)).decisions).toEqual([]);
  });
});

describe("decisionShown on a secret ballot (release 1)", () => {
  const secret = (key = "secret"): DecisionDraft => ({ ...draft(key), rule: { rule: "unanimous", ballot: "secret" } });
  const openSecret = async () => {
    const out = await store.openDecision(ROOM, {
      type: "decision_opened", fromMemberId: JESSE.memberId, fromUserId: JESSE.userId, fromLabel: JESSE.label, payload: secret(), refId: null,
    }, null);
    if (out.outcome !== "appended") throw new Error(out.outcome);
    return out.event.cursor;
  };
  const castSecret = (decision: number, by: Member) => store.castVote(ROOM, {
    type: "decision_vote", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label, refId: null,
    payload: { decision, hash: decisionHash(secret()), choice: "approve", via: "action_response", human_approved: true },
  }, null);

  it("lists no votes, and shows voted only on the reader's own rows while open", async () => {
    const d = await openSecret();
    await castSecret(d, JESSE);
    const view = (await store.decision(ROOM, d, Date.now()))!;
    const shown = decisionShown(view, [JESSE, PEER], true, JESSE.userId, true);
    expect(shown).toMatchObject({ votes: [], advisory_votes: [] });
    expect(shown.electorate).toEqual([
      expect.objectContaining({ member_id: "m_creator", voted: true }),
      expect.not.objectContaining({ voted: expect.anything() }),
    ]);
    const peers = decisionShown(view, [JESSE, PEER], true, PEER.userId, false);
    expect(peers.electorate![0]).not.toHaveProperty("voted");
    expect(peers.electorate![1]).toMatchObject({ member_id: "m_peer", voted: false });
    expect(decisionShown(view, [JESSE, PEER], true).electorate!.every((row) => !("voted" in row)), "no reader, no voted").toBe(true);
  });

  it("gives a member who has voted and one who has not different ETags", async () => {
    const d = await openSecret();
    await castSecret(d, JESSE);
    const tag = async (key: string) => (await call(key, `/rooms/${ROOM}/decisions`))!.headers.get("etag");
    expect(await tag(DEV_KEY.jesse)).not.toBe(await tag(DEV_KEY.peer));
    const body = await read(DEV_KEY.jesse);
    expect(body.open[0]!.electorate.find((r) => r.member_id === "m_creator")).toMatchObject({ voted: true });
    expect(body.open[0]!.electorate.find((r) => r.member_id === "m_peer")).not.toHaveProperty("voted");
  });

  it("tells a removed voter nothing false about their own vote: a read to the cut carries no voted", async () => {
    const d = await openSecret();
    await castSecret(d, PEER);
    const h = new Harness(store, blobs);
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_evict", { session_id: ROOM, member_id: "m_peer" });
    await h.close();
    expect(out.isError, out.text).toBe(false);
    const opened = (await store.decision(ROOM, d, Date.now()))!;
    await store.closeDecision(ROOM, d, { state: "expired" }, opened.payload.expires_at + 1);
    const body = await read(DEV_KEY.peer);
    const row = body.decisions.find((v) => v.decision === d)!.electorate.find((r) => r.member_id === "m_peer");
    expect(row).not.toHaveProperty("voted");
  });

  it("shows every seat's voted from the closing payload once closed", async () => {
    const d = await openSecret();
    await castSecret(d, JESSE);
    await castSecret(d, PEER);
    const view = (await store.decision(ROOM, d, Date.now()))!;
    expect(view.state).toBe("passed");
    const shown = decisionShown(view, [JESSE, PEER], true, null, null);
    expect(shown.electorate!.map((row) => [row.member_id, row.voted])).toEqual([["m_creator", true], ["m_peer", true]]);
    expect(shown.votes).toEqual([]);
  });
});
