/**
 * Restore (topic rooms spec, D5, R22, R23): { key, restore: <cursor> } re-applies the version of a key written at that
 * cursor, as a new write, with the version's author kept and the restoring seat as its approver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { card, joinWith, pairUp, propose, topicRoom, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { newBlobId } from "../../src/blobs.js";
import { text } from "../helpers/blob-bytes.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

interface Seat { peer: Peer; memberId: string }
const write = (s: Seat, r: { sessionId: string }, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  s.peer.call("bellman_send", { session_id: r.sessionId, member_id: s.memberId, type: "surface", payload, ...extra });
const maintainer = (r: TopicRoom): Seat => ({ peer: r.maintainer, memberId: r.maintainerId });
const rows = (r: { sessionId: string }) => h.store.surfaceOf(r.sessionId);
const events = (r: { sessionId: string }) => h.store.eventsAfter(r.sessionId, 0);

/** A second maintainer, seated through a code for the role. */
async function secondMaintainer(r: TopicRoom): Promise<Seat> {
  const peer = await h.connect(DEV_KEY.peer);
  const door = await r.maintainer.call("bellman_invite", { session_id: r.sessionId, member_id: r.maintainerId, role: "maintainer" });
  const joined = await joinWith(peer, String(door.data.join_code), ["read_context", "receive_messages", "request_actions"]);
  expect(joined.isError, joined.text).toBe(false);
  return { peer, memberId: String(joined.data.member_id) };
}

describe("restoring a version", () => {
  it("re-applies it as a new write: the version's author kept, the restoring seat as approver, the older versions still in the log", async () => {
    const r = await topicRoom(h);
    const m2 = await secondMaintainer(r);
    const v1 = await write(maintainer(r), r, card({ body: "First. https://example.com/1" }));
    const v2 = await write(m2, r, card({ body: "Second. https://example.com/2" }));
    expect(v2.isError, v2.text).toBe(false);

    const back = await write(m2, r, { key: "tools", restore: v1.data.cursor });
    expect(back.isError, back.text).toBe(false);

    const [row] = await rows(r);
    expect(row).toMatchObject({
      body: "First. https://example.com/1", byMemberId: r.maintainerId,
      approvedBy: { memberId: m2.memberId, label: m2.peer.identity.label },
    });
    expect(row.cursor).toBeGreaterThan(Number(v2.data.cursor));
    expect((await events(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.maintainerId, payload: { body: "First. https://example.com/1" } });
    expect((await events(r)).filter((e) => e.type === "surface")).toHaveLength(3);
  });

  it("keeps a contributor as the author of a version an approval put there, across a restore", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r, { item: card({ body: "Contributed. https://example.com/c" }) });
    const approved = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    const version = (approved.data.applied as { cursor: number }).cursor;
    await write(maintainer(r), r, card({ body: "Edited by the maintainer. https://example.com/e" }));

    const back = await write(maintainer(r), r, { key: "tools", restore: version });

    expect(back.isError, back.text).toBe(false);
    expect((await rows(r))[0]).toMatchObject({
      body: "Contributed. https://example.com/c", byMemberId: r.contributorId, approvedBy: { memberId: r.maintainerId },
    });
  });

  // R22: a removal is restored as a removal, and it is the restorer's act.
  it("restores a removal as a removal now", async () => {
    const r = await topicRoom(h);
    await write(maintainer(r), r, card());
    const removed = await write(maintainer(r), r, { key: "tools", remove: true });
    await write(maintainer(r), r, card({ body: "Back again. https://example.com/b" }));
    expect((await rows(r))).toHaveLength(1);

    const back = await write(maintainer(r), r, { key: "tools", restore: removed.data.cursor });

    expect(back.isError, back.text).toBe(false);
    expect(await rows(r)).toEqual([]);
    expect((await events(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.maintainerId, payload: { key: "tools", remove: true } });
  });

  // Review Focus 4.
  it("refuses a cursor that names no event, another key's write or another kind of event, naming what it is", async () => {
    const r = await topicRoom(h);
    await write(maintainer(r), r, card());
    const other = await write(maintainer(r), r, card({ key: "other" }));
    const said = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: { text: "hello" },
    });
    const before = (await events(r)).length;

    const cases: [unknown, string][] = [
      [other.data.cursor, 'wrote "other", not "tools"'],
      [said.data.cursor, "is a message event, not a surface write"],
      [9999, "no event at cursor 9999"],
    ];
    for (const [cursor, words] of cases) {
      const out = await write(maintainer(r), r, { key: "tools", restore: cursor });
      expect(out.isError, String(cursor)).toBe(true);
      expect(out.text, String(cursor)).toContain(words);
    }
    expect((await events(r)).length).toBe(before);
  });

  it.each([
    ["a cursor of zero", { key: "tools", restore: 0 }],
    ["a cursor that is text", { key: "tools", restore: "3" }],
    ["a field beside the cursor", { key: "tools", restore: 3, kind: "text" }],
  ])("refuses %s", async (_why, payload) => {
    const r = await topicRoom(h);
    const out = await write(maintainer(r), r, payload);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("surface restore must be { key, restore: <cursor> }");
  });

  it("is refused when the version's blob has gone, and when the seat does not hold write_surface", async () => {
    const r = await topicRoom(h);
    const id = newBlobId();
    const bytes = text("notes");
    await h.blobs.put(r.sessionId, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, {
      bytes: bytes.byteLength, type: "text/markdown", name: "notes.md", by: r.maintainerId, at: 1_700_000_000_000,
    });
    const v1 = await write(maintainer(r), r, { key: "notes", kind: "file", blob: { id } });
    expect(v1.isError, v1.text).toBe(false);
    await write(maintainer(r), r, { key: "notes", kind: "text", title: "Notes", body: "Now prose. https://example.com/n" });
    await h.blobs.delete(r.sessionId, id);
    const gone = await write(maintainer(r), r, { key: "notes", restore: v1.data.cursor });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain(`no blob ${id} has been uploaded to this room`);

    const contributor: Seat = { peer: r.contributor, memberId: r.contributorId };
    const denied = await write(contributor, r, { key: "notes", restore: v1.data.cursor });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('does not hold the verb "write_surface"');
  });

  it("works in a room that is not a topic room", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const lead: Seat = { peer: p.creator, memberId: p.creatorMemberId };
    const v1 = await write(lead, p, { key: "plan", kind: "text", body: "first" });
    await write(lead, p, { key: "plan", kind: "text", body: "second" });
    const back = await write(lead, p, { key: "plan", restore: v1.data.cursor });
    expect(back.isError, back.text).toBe(false);
    expect((await rows(p))[0]).toMatchObject({ body: "first", approvedBy: { memberId: p.creatorMemberId } });
  });

  it("files an audit row naming the cursor restored", async () => {
    const r = await topicRoom(h);
    const v1 = await write(maintainer(r), r, card());
    await write(maintainer(r), r, { key: "tools", restore: v1.data.cursor });
    const last = (await h.store.auditForOrg(r.maintainer.identity.orgId!, 50)).at(-1)!;
    expect(last).toMatchObject({ action: "sent_surface", detail: { key: "tools", restored: Number(v1.data.cursor) } });
  });

  // The verb comes first: a seat that cannot restore learns nothing of the log by probing cursors.
  it("tells a seat without write_surface so, whatever cursor it names, before it learns what the cursor holds", async () => {
    const r = await topicRoom(h);
    await write(maintainer(r), r, card());
    const said = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: { text: "hello" },
    });
    const contributor: Seat = { peer: r.contributor, memberId: r.contributorId };

    for (const cursor of [9999, said.data.cursor]) {
      const out = await write(contributor, r, { key: "tools", restore: cursor });
      expect(out.isError, String(cursor)).toBe(true);
      expect(out.text, String(cursor)).toContain('does not hold the verb "write_surface"');
      expect(out.text, String(cursor)).not.toContain("restore:");
    }
  });

  // read_context spec, section 3: a brief_update whose author keeps their brief is no event to any other account, and
  // the refusal that names an event's type must not be the way to learn that one was sent.
  it("reads a brief_update its author keeps as no event, to every account but the author's", async () => {
    const p = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }), joinAs: "lead", joinerCapabilities: ["receive_messages"],
    });
    const creator: Seat = { peer: p.creator, memberId: p.creatorMemberId };
    const joiner: Seat = { peer: p.joiner, memberId: p.joinerMemberId };
    const update = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "brief_update", payload: brief(),
    });
    expect(update.isError, update.text).toBe(false);

    const other = await write(creator, p, { key: "plan", restore: update.data.cursor });
    expect(other.isError).toBe(true);
    expect(other.text).toContain(`no event at cursor ${update.data.cursor}`);
    expect(other.text).not.toContain("brief_update");

    const author = await write(joiner, p, { key: "plan", restore: update.data.cursor });
    expect(author.isError).toBe(true);
    expect(author.text).toContain("is a brief_update event, not a surface write");
  });

  // What a reader of the page sees: the version's author on its origin, the restoring seat as its approver.
  it("names the version's author on the event and on every read, and the restoring seat as approver", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r, { item: card({ body: "Contributed. https://example.com/c" }) });
    const approved = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    const version = (approved.data.applied as { cursor: number }).cursor;
    await write(maintainer(r), r, card({ body: "Edited by the maintainer. https://example.com/e" }));

    await write(maintainer(r), r, { key: "tools", restore: version });

    expect((await events(r)).at(-1)).toMatchObject({
      fromMemberId: r.contributorId, fromUserId: r.contributor.identity.userId, fromLabel: r.contributor.identity.label,
    });
    const read = await r.maintainer.call("bellman_surface", { session_id: r.sessionId });
    const [item] = (read.data.surface as { items: { origin: { label: string }; data: { approved_by: unknown } }[] }).items;
    expect(item.origin.label).toBe(r.contributor.identity.label);
    expect(item.data.approved_by).toEqual({ member_id: r.maintainerId, label: r.maintainer.identity.label });
  });

  it("restores a file version whose object is still in the room, naming the object as it is stored", async () => {
    const r = await topicRoom(h);
    const id = newBlobId();
    const bytes = text("notes");
    const stored = { bytes: bytes.byteLength, type: "text/markdown", name: "notes.md" };
    await h.blobs.put(r.sessionId, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, { ...stored, by: r.maintainerId, at: 1_700_000_000_000 });
    const v1 = await write(maintainer(r), r, { key: "notes", kind: "file", blob: { id } });
    expect(v1.isError, v1.text).toBe(false);
    await write(maintainer(r), r, { key: "notes", kind: "text", title: "Notes", body: "Now prose. https://example.com/n" });

    const back = await write(maintainer(r), r, { key: "notes", restore: v1.data.cursor });

    expect(back.isError, back.text).toBe(false);
    expect((await rows(r))[0]).toMatchObject({ kind: "file", blob: { id, ...stored }, approvedBy: { memberId: r.maintainerId } });
  });

  it("authors a restored removal as the restorer, not as whoever removed the key", async () => {
    const r = await topicRoom(h);
    const m2 = await secondMaintainer(r);
    await write(maintainer(r), r, card());
    const removed = await write(m2, r, { key: "tools", remove: true });
    await write(maintainer(r), r, card({ body: "Back again. https://example.com/b" }));

    const back = await write(maintainer(r), r, { key: "tools", restore: removed.data.cursor });

    expect(back.isError, back.text).toBe(false);
    expect(await rows(r)).toEqual([]);
    expect((await events(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.maintainerId, payload: { key: "tools", remove: true } });
  });

  // A peer's message is free-form, so one can be shaped like a card. Restoring its cursor must not put it on the page.
  it("refuses a message shaped like a card: only a surface event is a version", async () => {
    const r = await topicRoom(h);
    const said = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: card({ body: "Slipped in. https://example.com/s" }),
    });
    expect(said.isError, said.text).toBe(false);

    const out = await write(maintainer(r), r, { key: "tools", restore: said.data.cursor });

    expect(out.isError).toBe(true);
    expect(out.text).toContain("is a message event, not a surface write");
    expect(await rows(r)).toEqual([]);
  });

  it("counts a restore as a send, and one refused for its cursor spends no place", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const lead: Seat = { peer: p.creator, memberId: p.creatorMemberId };
    const v1 = await write(lead, p, { key: "k0", kind: "text", body: "x" });
    for (let i = 0; i < 5; i++) {
      const bad = await write(lead, p, { key: "k0", restore: 9999 });
      expect(bad.isError, `refused restore ${i + 1}`).toBe(true);
      expect(bad.text, `refused restore ${i + 1}`).not.toContain("rate_limited");
    }
    for (let i = 1; i < 29; i++) expect((await write(lead, p, { key: `k${i}`, kind: "text", body: "x" })).isError, `write ${i + 1}`).toBe(false);

    const back = await write(lead, p, { key: "k0", restore: v1.data.cursor });
    expect(back.isError, `the 30th send: ${back.text}`).toBe(false);
    const refused = await write(lead, p, { key: "k30", kind: "text", body: "x" });
    expect(refused.data).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
  });
});

// R23: the restore's event is authored by the version's author, and a key is scoped by the event's author.
describe("a restore's idempotency key", () => {
  it("replays for the seat that used it, and is not shared with another maintainer using the same words", async () => {
    const r = await topicRoom(h);
    const m2 = await secondMaintainer(r);
    const v1 = await write(maintainer(r), r, card({ body: "First. https://example.com/1" }));
    await write(m2, r, card({ body: "Second. https://example.com/2" }));
    const restore = { key: "tools", restore: v1.data.cursor };

    const a = await write(maintainer(r), r, restore, { idempotency_key: "restore-0001" });
    const b = await write(m2, r, restore, { idempotency_key: "restore-0001" });
    expect(a.isError, a.text).toBe(false);
    expect(b.isError, b.text).toBe(false);
    expect(b.data.replayed, "the second seat's write is its own").toBeUndefined();
    expect(b.data.cursor).not.toBe(a.data.cursor);

    const again = await write(maintainer(r), r, restore, { idempotency_key: "restore-0001" });
    expect(again.data).toMatchObject({ replayed: true, cursor: a.data.cursor });
  });
});
