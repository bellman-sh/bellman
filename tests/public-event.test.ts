/**
 * publicEvent: the one shape an event leaves the server in, over a poll and
 * over a socket alike (spec D1a).
 *
 * It lives in src/public-event.ts, with no Cloudflare imports, so this file and
 * both programs can reach it. tests/store-do-wiring.test.ts pins that the
 * Durable Object sends it on a socket; the last case here pins that
 * bellman_sync returns it, which is what makes "the poll's shape" a fact about
 * the real tool and not about a copy of it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publicEvent } from "../src/public-event.js";
import type { SessionEvent } from "../src/types.js";
import { Harness, envelopes } from "./helpers/harness.js";
import { pairUp } from "./helpers/flows.js";

const stored = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  cursor: 7,
  type: "message",
  fromMemberId: "m_peer",
  fromUserId: "u_github_4242",
  fromLabel: "peer@laptop",
  payload: { text: "hi" },
  refId: null,
  at: Date.UTC(2026, 8, 29, 20, 0, 0),
  ...over,
});

describe("publicEvent", () => {
  it("is exactly the six fields a member is shown", () => {
    expect(Object.keys(publicEvent(stored())).sort())
      .toEqual(["at", "cursor", "from", "payload", "ref_id", "type"]);
  });

  it("names the sender by member id and label, and by no user id", () => {
    const shown = publicEvent(stored());
    expect(shown.from).toEqual({ member_id: "m_peer", label: "peer@laptop" });
    // The sender's upstream identity is what the stored event carries and a
    // peer must not receive. Checked on the serialized text, so a field added
    // under any name that carries it still fails here.
    expect(JSON.stringify(shown)).not.toContain("4242");
    expect(JSON.stringify(shown)).not.toContain("fromUserId");
  });

  it("carries the time as ISO 8601 and the reference under its wire name", () => {
    const shown = publicEvent(stored({ refId: "3" }));
    expect(shown.at).toBe("2026-09-29T20:00:00.000Z");
    expect(shown.ref_id).toBe("3");
  });

  it("shows a server-originated event as from the system", () => {
    const shown = publicEvent(stored({
      type: "session_expired", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
    }));
    expect(shown.from).toEqual({ member_id: "system", label: "bellman" });
    expect(shown.type).toBe("session_expired");
  });

  const base = {
    cursor: 7,
    fromMemberId: "m_a",
    fromUserId: "u_jesse",
    fromLabel: "jesse@codenerd",
    payload: { note: "ran migration 0042" },
    refId: null,
    at: 1_773_000_000_000,
  };

  it("omits ambient for an interrupting event", () => {
    const out = publicEvent({ ...base, type: "message" });
    expect("ambient" in out).toBe(false);
  });

  it("marks an ambient event, so a client need not know the type list", () => {
    expect(publicEvent({ ...base, type: "progress" })).toMatchObject({ ambient: true });
  });

  it("never leaks fromUserId", () => {
    expect("fromUserId" in publicEvent({ ...base, type: "progress" })).toBe(false);
  });
});

describe("the poll and the socket share one shape", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });

  it("bellman_sync returns publicEvent(event) as the data of every event it wraps", async () => {
    const p = await pairUp(h);
    const sent = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "hello" },
    });
    expect(sent.isError, sent.text).toBe(false);

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    // The poll leaves out the caller's own events; everything else it returns
    // is one publicEvent per stored event, inside the untrusted envelope.
    const theirs = (await h.store.eventsAfter(p.sessionId, 0))
      .filter((e) => e.fromMemberId !== p.creatorMemberId);
    expect(theirs.length, "the comparison must not be vacuous").toBeGreaterThan(0);
    expect(envelopes(sync.data.events).map((e) => e.data)).toEqual(theirs.map(publicEvent));
  });
});
