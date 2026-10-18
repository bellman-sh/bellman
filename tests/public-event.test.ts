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
import { briefAuthors, publicEvent, readableEvent, readableEvents, seesBrief } from "../src/public-event.js";
import type { Member, SessionEvent } from "../src/types.js";
import { Harness, envelopes } from "./helpers/harness.js";
import { pairUp } from "./helpers/flows.js";
import { brief } from "./helpers/fixtures.js";

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
  it("is exactly the six fields a member is shown, for an interrupting event", () => {
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

  // M4: a hosted room's own tick names nobody, so it reaches members without interrupting them.
  it("marks a heartbeat that asks nobody ambient, and leaves one that asks somebody an interrupt", () => {
    expect(publicEvent({ ...base, type: "heartbeat", payload: { members: [] } })).toMatchObject({ ambient: true });
    expect("ambient" in publicEvent({ ...base, type: "heartbeat", payload: { members: [{ member_id: "m_a" }] } })).toBe(false);
  });

  it("never leaks fromUserId, whatever the posture", () => {
    for (const type of ["message", "progress"] as const) {
      expect(JSON.stringify(publicEvent({ ...base, type }))).not.toContain("u_jesse");
    }
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

/**
 * The rule (read_context spec, section 1): one function over the stored event, the author's row
 * and the reader, a user id or null for a path every member shares.
 */
describe("readableEvent", () => {
  const AUTHOR = "u_quiet";
  const READER = { author: AUTHOR, peer: "u_peer", none: null } as const;
  const GRANT: Record<"on" | "off", Pick<Member, "capabilities">> = {
    on: { capabilities: ["read_context", "receive_messages"] },
    off: { capabilities: ["receive_messages"] },
  };
  const kept = brief({ goal: "kept to myself" });
  const by = { fromMemberId: "m_quiet", fromUserId: AUTHOR, fromLabel: "quiet@codenerd" };
  const update = stored({ ...by, type: "brief_update", payload: kept });
  const newJoin = () => stored({ ...by, type: "member_joined", payload: { member: { member_id: "m_quiet", label: "quiet@codenerd" }, brief: kept } });
  const joined = newJoin();
  const message = stored({ ...by, payload: { text: "hi" } });
  const withoutBrief = { ...joined, payload: { member: { member_id: "m_quiet", label: "quiet@codenerd" }, brief: null } };

  it.each([
    ["a brief_update", "on", "peer", update, update],
    ["a brief_update", "on", "none", update, update],
    ["a brief_update", "on", "author", update, update],
    ["a brief_update", "off", "peer", update, null],
    ["a brief_update", "off", "none", update, null],
    ["a brief_update", "off", "author", update, update],
    ["a member_joined", "on", "peer", joined, joined],
    ["a member_joined", "on", "none", joined, joined],
    ["a member_joined", "on", "author", joined, joined],
    ["a member_joined", "off", "peer", joined, withoutBrief],
    ["a member_joined", "off", "none", joined, withoutBrief],
    ["a member_joined", "off", "author", joined, joined],
    ["a message", "on", "peer", message, message],
    ["a message", "off", "peer", message, message],
    ["a message", "off", "none", message, message],
    ["a message", "off", "author", message, message],
  ] as const)("shows %s, with the grant %s, to a reader who is the %s", (_what, grant, reader, e, expected) => {
    expect(readableEvent(e, GRANT[grant], READER[reader])).toEqual(expected);
  });

  it("reads an author with no row as one who does not grant read_context, except for the author", () => {
    expect(readableEvent(update, undefined, "u_peer")).toBeNull();
    expect(readableEvent(update, undefined, null)).toBeNull();
    expect(readableEvent(update, undefined, AUTHOR)).toEqual(update);
  });

  it("changes nothing in the event it is handed", () => {
    // A join of its own: the table above hands the shared `joined` to readableEvent, so a copy
    // taken from it would already hold a change made in place, and the comparison would pass.
    const own = newJoin();
    const before = structuredClone(own);
    readableEvent(own, GRANT.off, "u_peer");
    expect(own).toEqual(before);
  });

  /** Review Focus 4: a grant is a handle's, so one account's two handles can differ. */
  it("over a list, looks each author up by member id, keeps the order and leaves out what it drops", () => {
    const open = stored({ type: "brief_update", fromMemberId: "m_open", fromUserId: AUTHOR, payload: brief(), cursor: 8 });
    const rows = [{ memberId: "m_quiet", ...GRANT.off }, { memberId: "m_open", ...GRANT.on }];
    expect(readableEvents([update, open, message], rows, "u_peer")).toEqual([open, message]);
    expect(readableEvents([update, open, message], rows, AUTHOR)).toEqual([update, open, message]);
    // The rows in another order than the events: a lookup by position would pair each event with the wrong row.
    expect(readableEvents([update, open, message], [...rows].reverse(), "u_peer")).toEqual([open, message]);
    // m_quiet has no row here, so its update reads as not granting (R11) in a list as it does alone.
    expect(readableEvents([update, open, message], rows.slice(1), "u_peer")).toEqual([open, message]);
  });

  it("names the authors whose rows it needs: those of a brief_update or a member_joined, once each", () => {
    expect(briefAuthors([update, joined, message, stored({ type: "brief_update", fromMemberId: "m_loud" })])).toEqual(["m_quiet", "m_loud"]);
    expect(briefAuthors([message])).toEqual([]);
    // A joiner who wrote no update still needs a row: the list above cannot tell, since m_quiet wrote both.
    expect(briefAuthors([stored({ type: "member_joined", fromMemberId: "m_new" })])).toEqual(["m_new"]);
  });

  it("lets a reader see a brief its author grants, or one of its own account (D3)", () => {
    expect(seesBrief({ userId: AUTHOR, ...GRANT.on }, "u_peer")).toBe(true);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, "u_peer")).toBe(false);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, null)).toBe(false);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, AUTHOR)).toBe(true);
  });
});
