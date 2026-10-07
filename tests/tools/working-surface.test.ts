/**
 * `bellman_send type: "surface"` (#129): the one write to a room's working
 * surface. A seat holding `write_surface` writes or replaces an item by key,
 * or removes one; the write is an event, the row commits with it, and a
 * refusal leaves nothing behind. The pair preset gives the verb to `peer_a`
 * (the creator) and not `peer_b` (the joiner), which is the asymmetry most
 * cases lean on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, envelopes } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { MemoryStore } from "../../src/store.js";
import {
  MAX_SURFACE_BODY_CHARS, MAX_SURFACE_ITEMS, MAX_SURFACE_LINK_CHARS, MAX_SURFACE_TITLE_CHARS,
} from "../../src/surface.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const plan = (over: Record<string, unknown> = {}) =>
  ({ key: "plan", kind: "text", title: "Plan", body: "1. read\n2. write", ...over });

const write = (p: PairedSession, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  p.creator.call("bellman_send", {
    session_id: p.sessionId, member_id: p.creatorMemberId, type: "surface", payload, ...extra,
  });

const rows = (p: PairedSession) => h.store.surfaceOf(p.sessionId);
const eventCount = async (p: PairedSession) => (await h.store.eventsAfter(p.sessionId, 0)).length;

describe("writing an item", () => {
  it("appends a surface event carrying the normalised item, and the row commits with it", async () => {
    const p = await pairUp(h);
    const out = await write(p, plan());
    expect(out.isError, out.text).toBe(false);

    const events = await h.store.eventsAfter(p.sessionId, 0);
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      type: "surface", fromMemberId: p.creatorMemberId,
      payload: { key: "plan", kind: "text", title: "Plan", body: "1. read\n2. write", ends: null, placement: null },
    });
    expect(out.data.cursor).toBe(last.cursor);
    expect(out.data.room_members).toEqual([p.joiner.identity.label]);

    expect(await rows(p)).toEqual([{
      key: "plan", kind: "text", title: "Plan", body: "1. read\n2. write", ends: null, placement: null,
      cursor: last.cursor, at: last.at, byMemberId: p.creatorMemberId, byLabel: p.creator.identity.label,
    }]);
  });

  it("writes an audit row naming the key and the kind", async () => {
    const p = await pairUp(h);
    const org = p.creator.identity.orgId!;
    await write(p, plan());
    const row = (await h.store.auditForOrg(org, 50)).at(-1)!;
    expect(row).toMatchObject({
      action: "sent_surface", detail: { key: "plan", kind: "text", chars: "1. read\n2. write".length },
    });
  });

  it("replaces by key, and removes with { key, remove: true }", async () => {
    const p = await pairUp(h);
    await write(p, plan());
    const replaced = await write(p, plan({ body: "revised" }));
    expect(replaced.isError, replaced.text).toBe(false);
    expect((await rows(p)).map((r) => r.body)).toEqual(["revised"]);

    const removed = await write(p, { key: "plan", remove: true });
    expect(removed.isError, removed.text).toBe(false);
    expect(await rows(p)).toEqual([]);
    expect((await h.store.eventsAfter(p.sessionId, 0)).at(-1)!.payload).toEqual({ key: "plan", remove: true });

    const org = p.creator.identity.orgId!;
    expect((await h.store.auditForOrg(org, 50)).at(-1)!.detail).toEqual({ key: "plan", removed: true });
  });

  it("round-trips a placement, and every kind", async () => {
    const p = await pairUp(h);
    const items = [
      plan({ placement: { x: -40.5, y: 1e6, w: 320, h: 180 } }),
      { key: "pr", kind: "link", title: "The PR", body: "https://github.com/bellman-sh/bellman/pull/1" },
      { key: "arch", kind: "diagram", body: "flowchart LR\n  A --> B" },
      { key: "c1", kind: "connector", ends: { from: "plan", to: "arch" }, body: "informs" },
    ];
    for (const item of items) {
      const out = await write(p, item);
      expect(out.isError, out.text).toBe(false);
    }
    const stored = await rows(p);
    expect(stored.map((r) => r.key)).toEqual(["arch", "c1", "plan", "pr"]);
    expect(stored.find((r) => r.key === "plan")!.placement).toEqual({ x: -40.5, y: 1e6, w: 320, h: 180 });
    expect(stored.find((r) => r.key === "c1")!.ends).toEqual({ from: "plan", to: "arch" });
  });

  it("lets the creator write before anyone has joined", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const out = await jesse.call("bellman_send", {
      session_id: String(started.data.session_id), member_id: String(started.data.member_id),
      type: "surface", payload: plan(),
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.room_members).toEqual([]);
  });

  // D3's second exemption: a surface is addressed to the room, not delivered as
  // a message, so a joiner that grants no `receive_messages` does not block it.
  it("writes even when no peer accepts messages", async () => {
    const p = await pairUp(h, { joinerCapabilities: ["read_context"] });
    const out = await write(p, plan());
    expect(out.isError, out.text).toBe(false);
  });

  it("replays an idempotency key, and refuses the key for different content", async () => {
    const p = await pairUp(h);
    const before = await eventCount(p);
    const first = await write(p, plan(), { idempotency_key: "sf-retry-01" });
    const retry = await write(p, plan(), { idempotency_key: "sf-retry-01" });
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data.replayed).toBe(true);
    expect(retry.data.cursor).toBe(first.data.cursor);
    expect(await eventCount(p), "one surface event after a replay").toBe(before + 1);
    expect(await rows(p)).toHaveLength(1);

    const conflict = await write(p, plan({ body: "other" }), { idempotency_key: "sf-retry-01" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("already used for a different message");
  });
});

describe("what is refused, and that a refusal leaves nothing behind", () => {
  const refused = async (p: PairedSession, payload: Record<string, unknown>, words: string) => {
    const before = await eventCount(p);
    const out = await write(p, payload);
    expect(out.isError, JSON.stringify(payload).slice(0, 80)).toBe(true);
    expect(out.text, JSON.stringify(payload).slice(0, 80)).toContain(words);
    expect(await eventCount(p)).toBe(before);
  };

  it("refuses a seat without write_surface, naming the verb, and appends nothing", async () => {
    const p = await pairUp(h);
    const before = await eventCount(p);
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "surface", payload: plan(),
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('your role "peer_b" does not hold the verb "write_surface"');
    expect(await eventCount(p)).toBe(before);
    expect(await rows(p)).toEqual([]);
  });

  it("refuses a malformed payload by naming the field", async () => {
    const p = await pairUp(h);
    await refused(p, { kind: "text", body: "x" }, "key");
    await refused(p, plan({ key: "Plan" }), "surface keys");
    await refused(p, plan({ key: "__proto__" }), "surface keys");
    await refused(p, plan({ kind: "sticky" }), "kind");
    await refused(p, plan({ colour: "red" }), "colour");
    await refused(p, plan({ title: "" }), "title");
    await refused(p, plan({ title: "t".repeat(MAX_SURFACE_TITLE_CHARS + 1) }), "title");
    await refused(p, plan({ body: "b".repeat(MAX_SURFACE_BODY_CHARS + 1) }), "body");
    await refused(p, { key: "plan", remove: false }, "remove");
  });

  it("accepts the bounds at their edge", async () => {
    const p = await pairUp(h);
    for (const payload of [
      plan({ title: "t".repeat(MAX_SURFACE_TITLE_CHARS) }),
      plan({ body: "b".repeat(MAX_SURFACE_BODY_CHARS) }),
      // Review Focus 2: code units, not characters. 4,000 astral characters is
      // 8,000 units and accepted; one more astral character is refused.
      plan({ body: "𝄞".repeat(MAX_SURFACE_BODY_CHARS / 2) }),
    ]) {
      const out = await write(p, payload);
      expect(out.isError, out.text).toBe(false);
    }
    await refused(p, plan({ body: "𝄞".repeat(MAX_SURFACE_BODY_CHARS / 2 + 1) }), "body");
  });

  it("holds each kind to its rule", async () => {
    const p = await pairUp(h);
    await write(p, plan());
    await write(p, { key: "arch", kind: "diagram", body: "flowchart LR" });
    await refused(p, { key: "t", kind: "text" }, "needs a body");
    await refused(p, { key: "d", kind: "diagram", title: "only a title" }, "needs a body");
    await refused(p, { key: "t2", kind: "text", body: "x", ends: { from: "plan", to: "arch" } }, "only a connector has ends");
    await refused(p, { key: "c", kind: "connector" }, "needs ends");
    await refused(p, { key: "c", kind: "connector", ends: { from: "plan", to: "plan" } }, "must differ");
    await refused(p, { key: "c", kind: "connector", ends: { from: "plan", to: "arch" }, placement: { x: 0, y: 0 } }, "no placement");
    await refused(p, { key: "c", kind: "connector", ends: { from: "plan", to: "ghost" } }, "not on the surface");
    const c1 = await write(p, { key: "c1", kind: "connector", ends: { from: "plan", to: "arch" } });
    expect(c1.isError, c1.text).toBe(false);
    await refused(p, { key: "c2", kind: "connector", ends: { from: "c1", to: "plan" } }, "is a connector");
  });

  // Review Focus 4: the scheme, case and shape of a link.
  it("holds a link to http and https", async () => {
    const p = await pairUp(h);
    const upper = await write(p, { key: "l1", kind: "link", body: "HTTPS://EXAMPLE.COM/x" });
    expect(upper.isError, upper.text).toBe(false);
    for (const body of ["javascript:alert(1)", "data:text/html,hi", "//example.com/x", "not a url", "ftp://example.com/f"]) {
      await refused(p, { key: "l2", kind: "link", body }, "http");
    }
    await refused(p, { key: "l3", kind: "link", body: "https://example.com/" + "a".repeat(MAX_SURFACE_LINK_CHARS) }, "2,048");
  });

  it("caps the room at 64 items, and a replace or a removal frees the way", async () => {
    const p = await pairUp(h);
    for (let i = 0; i < MAX_SURFACE_ITEMS; i++) {
      const out = await write(p, { key: `k_${i}`, kind: "text", body: "x" });
      expect(out.isError, out.text).toBe(false);
    }
    await refused(p, { key: "one_more", kind: "text", body: "x" }, "64 items");
    const replace = await write(p, { key: "k_0", kind: "text", body: "still fits" });
    expect(replace.isError, replace.text).toBe(false);
    await write(p, { key: "k_1", remove: true });
    const added = await write(p, { key: "one_more", kind: "text", body: "x" });
    expect(added.isError, added.text).toBe(false);
  });

  it("refuses a frozen room and a closed one", async () => {
    const p = await pairUp(h);
    await h.store.freezeSession(p.sessionId, Date.now());
    await refused(p, plan(), "frozen");
    await h.store.freezeSession(p.sessionId, null);
    await h.store.closeSession(p.sessionId);
    await refused(p, plan(), "closed");
    expect(await rows(p)).toEqual([]);
  });
});

describe("how the write reaches a peer", () => {
  it("arrives in the joiner's poll as an ambient event with the item as its payload", async () => {
    const p = await pairUp(h);
    await write(p, plan());
    const poll = await p.joiner.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: p.joinerCursor,
    });
    expect(poll.isError, poll.text).toBe(false);
    const [event] = envelopes(poll.data.events) as { data: { type: string; ambient?: boolean; payload: unknown } }[];
    expect(event.data.type).toBe("surface");
    expect(event.data.ambient).toBe(true);
    expect(event.data.payload).toMatchObject({ key: "plan", body: "1. read\n2. write" });
  });
});
