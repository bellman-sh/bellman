/**
 * Secret ballot release 1 (spec G1): every exit a room's decisions leave by, read by a member who has not voted, by
 * one who has, and by a public-link reader, open and closed. None may carry a choice, a vote event naming its voter,
 * a vote's cursor, or (while open) whether another account has voted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { decisionHash, type DecisionDraft } from "../src/decision.js";
import { publicRoutes } from "../src/http/public.js";
import { roomRoutes, type RoomCaller } from "../src/http/rooms.js";
import { liveRooms } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { RoomManifest } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY, Harness, type Peer } from "./helpers/harness.js";

const ROOM = "qs_secret_leak";
const ISSUER = "https://mcp.example.test";
const JESSE = member();
const PEER = member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
const OUT = member({ memberId: "m_out", userId: "u_outsider", label: "outsider", roomRole: "peer_b" });
/** What a vote event may never be seen beside: a voter's seat, label or account. */
const VOTERS = ["m_creator", "m_peer", "jesse@codenerd", "peer@codenerd", "u_jesse", "u_peer"];

const draft: DecisionDraft = {
  key: "plan", effect: { kind: "surface_proposal", item: { key: "plan", kind: "text", body: "ship" }, base: 0 },
  rule: { rule: "majority", ballot: "secret" },
};

let store: MemoryStore;
let blobs: MemoryBlobStore;
let h: Harness;
let decision: number;
const voteResults: unknown[] = [];

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
  return identity ? { identity, via: "bearer" } : null;
};
const get = async (key: string, path: string) => {
  const res = await roomRoutes(new Request(`${ISSUER}${path}`, { headers: { authorization: `Bearer ${key}` } }), { store, blobs, caller, panelOrigins: [] });
  expect(res!.status, path).toBe(200);
  return res!.json();
};
const getPublic = async (path: string) => (await publicRoutes(new Request(`${ISSUER}${path}`, { headers: { origin: "https://anywhere.example.test" } }), { store, blobs }))!.json();

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  const base = roomManifest({ public: true, room: "Civic poll", purpose: "Vote" });
  const manifest: RoomManifest = {
    ...base,
    roles: Object.fromEntries(Object.entries(base.roles).map(([name, r]) => [name, { ...r, can: [...r.can, "vote", "request_actions"] }])),
    decide: { rules: { surface_proposal: { rule: "majority", quorum: null, ballot: "secret" } }, expiresMs: null },
  };
  await store.createSession(session({ id: ROOM, manifest, members: [JESSE, PEER, OUT] }));
  const out = await store.openDecision(ROOM, {
    type: "decision_opened", fromMemberId: JESSE.memberId, fromUserId: JESSE.userId, fromLabel: JESSE.label, payload: draft, refId: null,
  }, null);
  if (out.outcome !== "appended") throw new Error(out.outcome);
  decision = out.event.cursor;
  h = new Harness(store);
  voteResults.length = 0;
  const vote = async (peer: Peer, memberId: string, choice: string, key: string) =>
    (await peer.call("bellman_decide", {
      session_id: ROOM, member_id: memberId, action: "vote", decision, hash: decisionHash(draft), choice, human_approved: true, idempotency_key: key,
    })).data;
  const jesse = await h.connect(DEV_KEY.jesse);
  const peer = await h.connect(DEV_KEY.peer);
  voteResults.push(await vote(jesse, JESSE.memberId, "approve", "leak-jesse"), await vote(peer, PEER.memberId, "reject", "leak-peer"));
  voteResults.push(await vote(jesse, JESSE.memberId, "reject", "leak-jesse"));
});

afterEach(async () => { await h.close(); });

/** Every value an exit returned, as text, with each decision_vote's surroundings and each electorate row checked. */
function clean(label: string, value: unknown, open: boolean, reader: string | null) {
  const text = JSON.stringify(value);
  expect(text, `${label}: a choice`).not.toMatch(/choice\\*"\s*:/);
  for (let at = text.indexOf("decision_vote"); at !== -1; at = text.indexOf("decision_vote", at + 1)) {
    const near = text.slice(Math.max(0, at - 160), at + 200);
    for (const who of VOTERS) expect(near, `${label}: a vote beside ${who}`).not.toContain(who);
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (open && Array.isArray(o.electorate)) {
      for (const row of o.electorate as Record<string, unknown>[]) {
        if (row.member_id !== reader) expect(row, `${label}: another seat's voted while open`).not.toHaveProperty("voted");
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(value);
}

async function everyExit(open: boolean) {
  const readers: [string, Peer, string][] = [
    ["non-voter", await h.connect(DEV_KEY.outsider), OUT.memberId],
    ["voter", await h.connect(DEV_KEY.peer), PEER.memberId],
  ];
  for (const [who, peer, memberId] of readers) {
    const key = who === "voter" ? DEV_KEY.peer : DEV_KEY.outsider;
    clean(`${who} bellman_sync`, (await peer.call("bellman_sync", { session_id: ROOM, member_id: memberId, since_cursor: 0 })).data, open, memberId);
    clean(`${who} bellman_decide read`, (await peer.call("bellman_decide", { session_id: ROOM, member_id: memberId, action: "read", decision })).data, open, memberId);
    clean(`${who} bellman_decide list`, (await peer.call("bellman_decide", { session_id: ROOM, member_id: memberId, action: "read" })).data, open, memberId);
    clean(`${who} GET events`, await get(key, `/rooms/${ROOM}/events`), open, memberId);
    clean(`${who} GET decisions`, await get(key, `/rooms/${ROOM}/decisions`), open, memberId);
    clean(`${who} liveRooms`, await liveRooms(store, resolveIdentity(`Bearer ${key}`)!), open, memberId);
  }
  clean("public events", await getPublic(`/public/rooms/${ROOM}/events`), open, null);
  clean("org audit", await store.auditForOrg("org_codenerd", 100), open, null);
}

describe("a secret ballot leaves by no exit (secret ballot spec, G1)", () => {
  it("vote results and retries carry no cursor and no choice", () => {
    expect(voteResults).toEqual([
      { ballot: "secret", capacity: "binding", state: "open" },
      { ballot: "secret", capacity: "binding", state: "open" },
      { ballot: "secret", recorded: true, note: "Recorded under this key. To change your vote, vote again with a new key." },
    ]);
  });

  it("every exit while the decision is open", async () => {
    await everyExit(true);
  });

  it("every exit once the decision is closed, and the closing audit row is the system's", async () => {
    const opened = (await store.decision(ROOM, decision, Date.now()))!;
    expect(await store.closeDecision(ROOM, decision, { state: "expired" }, opened.payload.expires_at + 1)).toMatchObject({ outcome: "appended" });
    await everyExit(false);
    const closes = (await store.auditForOrg("org_codenerd", 100)).filter((a) => a.action === "decision_closed");
    expect(closes.map((a) => a.actorUserId)).toEqual(["system"]);
  });
});
