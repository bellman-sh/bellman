import { describe, it, expect, vi } from "vitest";
import { MemoryBlobStore, blobBytesUsed } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import type { Session } from "../src/types.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { describeStoreContract } from "./helpers/store-contract.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

// A fresh blob store for each case, handed both to the store, which purges from it, and to the cases,
// which put objects in it: a purge that missed the bucket the store was built over is seen.
let blobs = new MemoryBlobStore();
describeStoreContract(
  "MemoryStore",
  () => { blobs = new MemoryBlobStore(); return new MemoryStore({ blobs }); },
  { blobsFor: () => blobs },
);

/**
 * `closedAt` is the clock of whoever closed the room (#65): an abandonment that `sweep(now)` closes is
 * dated `now`, as its `session_expired` event is, and not the wall clock the call happened to run at. The
 * Durable Object store has no `sweep(now)` to hand a clock to, so this is MemoryStore's alone.
 */
describe("closedAt on MemoryStore's abandonment close", () => {
  it("is the clock the sweep was handed, the one the closing event carries", async () => {
    const store = new MemoryStore();
    const handed = Date.now() + 5_000;
    // Open at the wall clock, a millisecond past the window as of the sweep's.
    const s = session({ members: [member({ lastSeenAt: handed - ABANDONED_AFTER_MS - 1 })] });
    await store.createSession(s);

    await store.sweep(handed);

    expect((await store.getSession(s.id))).toMatchObject({ closed: true, closedAt: handed });
    expect((await store.eventsAfter(s.id, 0)).at(-1)).toMatchObject({ type: "session_expired", at: handed });
  });
});

class RefusingBlobStore extends MemoryBlobStore {
  refusals = 1;
  override async deleteAll(sessionId: string): Promise<number> {
    if (this.refusals-- > 0) throw new Error("bucket unavailable");
    return super.deleteAll(sessionId);
  }
}

/**
 * The purge's order (#65, Review Focus 1) for the store that has no alarm to retry it: the bytes go first, and
 * a bucket that refuses leaves the room whole for the next sweep. Never a room that names bytes that are gone.
 */
describe("a purge whose bucket refuses", () => {
  it("leaves the room, its listings and its audit alone, and the next sweep purges it", async () => {
    const blobs = new RefusingBlobStore();
    const store = new MemoryStore({ blobs });
    // Its sweep has run already: this case is about the purge, and the sweep at close would take an unnamed object.
    const s = session({ id: "qs_refused", retainAfterCloseMs: 60_000, joinCodes: {}, blobsSwept: true });
    await store.createSession(s);
    await blobs.put(s.id, "b_one", new Uint8Array(3).buffer as ArrayBuffer, {
      bytes: 3, type: "text/plain", name: "a.txt", by: "m_creator", at: Date.now(),
    });
    await store.closeSession(s.id);
    const due = (await store.getSession(s.id))!.closedAt! + 60_000;

    await expect(store.sweep(due)).rejects.toThrow("bucket unavailable");

    expect(await store.getSession(s.id), "the room is kept").toMatchObject({ closed: true });
    expect(await store.sessionsJoinedBy("u_jesse", 10), "and listed").toContain(s.id);
    expect(await blobs.list(s.id), "with its bytes").toHaveLength(1);
    expect(await store.auditForOrg("org_codenerd", 50), "and nothing says it is gone").toEqual([]);

    await store.sweep(due);

    expect(await store.getSession(s.id)).toBeUndefined();
    expect(await blobs.list(s.id)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
  });
});

/**
 * The close-time sweep (#65, D3) on the store that has no alarm to run it. MemoryStore sweeps at the close
 * itself, after the room is closed, and `sweep(now)` is what finds a room whose close it did not see: an
 * abandonment, and a close that could not sweep.
 */
describe("the sweep at close, on MemoryStore", () => {
  const put = (blobs: MemoryBlobStore, room: string, id: string, bytes: number) =>
    blobs.put(room, id, new Uint8Array(bytes).buffer as ArrayBuffer, {
      bytes, type: "text/plain", name: `${id}.txt`, by: "m_creator", at: Date.now(),
    });
  /** Created closed, so no close of the store's has swept it, and charged 45 bytes: `Session` carries no `blobBytes`, stored rooms do. */
  const closedAndCharged = (id: string): Session =>
    ({ ...session({ id, closed: true, closedAt: Date.now(), joinCodes: {} }), blobBytes: 45 }) as Session;

  it("answers what it removed and credited, from a room the close has not swept", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(closedAndCharged("qs_counts"));
    await put(blobs, "qs_counts", "b_orphan", 30);
    await put(blobs, "qs_counts", "b_other", 5);

    expect(await store.sweepBlobs("qs_counts")).toEqual({ removed: 2, credited: 35 });
    expect(blobBytesUsed((await store.getSession("qs_counts"))!)).toBe(10);
    expect(await store.sweepBlobs("qs_counts"), "nothing is left to remove").toEqual({ removed: 0, credited: 0 });
  });

  // Both list the same objects before either deletes, so both free the same bytes; the room is credited once.
  it("credits the freed bytes once when two sweeps overlap", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(closedAndCharged("qs_overlap"));
    await put(blobs, "qs_overlap", "b_orphan", 30);
    await put(blobs, "qs_overlap", "b_other", 5);

    await Promise.all([store.sweepBlobs("qs_overlap"), store.sweepBlobs("qs_overlap")]);

    expect(blobBytesUsed((await store.getSession("qs_overlap"))!)).toBe(10);
  });

  it("sweeps as either closer closes the room, without waiting for a sweep", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_by_close", joinCodes: {} }));
    await store.createSession(session({ id: "qs_by_empty", joinCodes: {}, members: [member({ leftAt: Date.now() })] }));
    await put(blobs, "qs_by_close", "b_orphan", 3);
    await put(blobs, "qs_by_empty", "b_orphan", 3);

    await store.closeSession("qs_by_close");
    expect(await store.closeSessionIfEmpty("qs_by_empty")).toBe(true);

    expect(await blobs.list("qs_by_close")).toEqual([]);
    expect(await blobs.list("qs_by_empty")).toEqual([]);
  });

  it("looks at nothing when a room already swept is closed again", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_closed_twice", joinCodes: {} }));
    await store.closeSession("qs_closed_twice");
    await put(blobs, "qs_closed_twice", "b_late", 3);

    await store.closeSession("qs_closed_twice");

    expect(await blobs.list("qs_closed_twice")).toHaveLength(1);
  });

  // The room is closed whether or not its bucket answers, and `blobsSwept` stays false, so a sweep finds it.
  it("does not turn a close into a failure when the bucket refuses, and the next sweep tries again", async () => {
    class DeleteRefusingBlobStore extends MemoryBlobStore {
      refusals = 1;
      override async delete(sessionId: string, id: string): Promise<void> {
        if (this.refusals-- > 0) throw new Error("bucket unavailable");
        return super.delete(sessionId, id);
      }
    }
    const blobs = new DeleteRefusingBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_refused_close", joinCodes: {} }));
    await put(blobs, "qs_refused_close", "b_orphan", 3);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(store.closeSession("qs_refused_close")).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    expect(await store.getSession("qs_refused_close")).toMatchObject({ closed: true, blobsSwept: false });
    expect(await blobs.list("qs_refused_close")).toHaveLength(1);

    await store.sweep(Date.now());

    expect(await blobs.list("qs_refused_close")).toEqual([]);
    expect((await store.getSession("qs_refused_close"))!.blobsSwept).toBe(true);
  });
});

/**
 * A poll registers a promise and a timer, and the timer settles it by looking the waiter up. A purge that
 * dropped the waiter would leave the promise for ever, with nothing left to find it. MemoryStore's alone: a
 * room's poll in the Durable Objects store is that object's own, and it times out there.
 */
describe("a poll waiting on a room that is purged", () => {
  it("settles with nothing, and does not wait out its timeout", async () => {
    const store = new MemoryStore();
    const s = session({ id: "qs_poll", retainAfterCloseMs: 60_000, joinCodes: {} });
    await store.createSession(s);
    await store.closeSession(s.id);
    const waiting = store.waitForEvents(s.id, 0, 120_000);

    await store.sweep(Date.now() + 60_001);

    expect(await store.getSession(s.id)).toBeUndefined();
    expect(await waiting).toEqual([]);
  });
});

describe("manifest persistence", () => {
  it("round-trips a manifest through the store unchanged", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest({ room: "persisted", purpose: "keep me" }) });
    await store.createSession(s);

    const back = await store.getSession(s.id);
    expect(back?.manifest).toEqual(s.manifest);
    expect(back?.manifest.roles.peer_a.can).toContain("revoke");
  });

  it("hands back a detached manifest that callers cannot mutate in place", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest() });
    await store.createSession(s);

    const first = await store.getSession(s.id);
    first!.manifest.roles.peer_b.can.push("revoke");

    const second = await store.getSession(s.id);
    expect(second?.manifest.roles.peer_b.can).not.toContain("revoke");
  });
});

/**
 * What `getSession` copies (#134).
 *
 * #25 stopped `getSession` returning a room's events, and the Durable Object store
 * stopped reading them. `MemoryStore` kept paying for them anyway: it cloned the whole
 * session and dropped the events from the copy, so a call nearly every tool makes cost
 * O(the room's history) on the Node server and in local development, which is the
 * growth #25 exists to remove.
 *
 * Wall-clock cannot pin that without flaking, so this watches the one primitive that
 * does the copying. `detach` is `structuredClone`, and whatever `getSession` hands it
 * is the work it does. The events carry a marker, and none of it may reach the clone.
 * The controls keep the probe honest: it has to see the same events being copied by a
 * read that does copy them, and see `getSession` copying the record, or a `detach`
 * moved off `structuredClone` would leave this passing over a probe that watches nothing.
 */
describe("what MemoryStore.getSession copies (#134)", () => {
  const MARK = "history-body-";

  /** Everything handed to `structuredClone` while `read` runs, as one string. */
  const copiedBy = async (read: () => Promise<unknown>): Promise<string> => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await read();
      return clone.mock.calls.map(([value]) => JSON.stringify(value)).join("\n");
    } finally {
      clone.mockRestore();
    }
  };

  /** One marker per event, so this is how many events a copy carried. */
  const eventsIn = (copy: string): number => copy.split(MARK).length - 1;

  it("copies the session record and none of the room's history", async () => {
    const store = new MemoryStore();
    const s = session({ id: "qs_history" });
    await store.createSession(s);
    const HISTORY = 25;
    for (let i = 0; i < HISTORY; i++) {
      await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: `${MARK}${i}` }, refId: null,
      });
    }

    expect(eventsIn(await copiedBy(() => store.eventsAfter(s.id, 0))),
      "control: a read that returns the events copies all of them").toBe(HISTORY);

    const copied = await copiedBy(() => store.getSession(s.id));
    expect(copied, "control: getSession copies the record").toContain(s.id);
    expect(eventsIn(copied), "events getSession copied").toBe(0);
  });
});

/**
 * Records written before a field existed.
 *
 * Both fields post-date the sessions now in production, and they want opposite
 * treatment: a manifest cannot be invented, so those rows read as gone; a
 * freeze can be defaulted, and must be, or every existing room reports frozen
 * and refuses every write in it.
 */
describe("hydrating a session written before a field existed", () => {
  const stored = (over: Record<string, unknown> = {}) => {
    const { events, ...rest } = session();
    return { ...rest, ...over };
  };

  it("reads a row with no frozenAt as not frozen", () => {
    const { frozenAt, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)?.frozenAt).toBeNull();
  });

  it("leaves a real freeze alone", () => {
    expect(hydrateStoredSession(stored({ frozenAt: 1_790_000_000 }))?.frozenAt)
      .toBe(1_790_000_000);
  });

  /** A manifest is a declaration; inventing one would put words in a mouth. */
  it("treats a row with no manifest as gone rather than defaulting it", () => {
    const { manifest, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)).toBeUndefined();
    expect(hydrateStoredSession(stored({ manifest: { roles: undefined } }))).toBeUndefined();
    expect(hydrateStoredSession(undefined)).toBeUndefined();
  });
});
