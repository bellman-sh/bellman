import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "../src/store.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { describeStoreContract } from "./helpers/store-contract.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

describeStoreContract("MemoryStore", () => new MemoryStore());

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
