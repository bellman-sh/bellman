/**
 * Pins the WIRING of the legacy-row guard: that SessionDO.stored() really calls
 * hydrateStoredSession, so every path that reads the session row inherits it.
 *
 * tests/store-do.test.ts proves the predicate on its own. It cannot prove this:
 * delete the call in stored() and that file still passes. These tests load the
 * real SessionDO, RegistryDO and DurableObjectStore over a fake storage, so
 * deleting the call turns them red.
 *
 * Which row a test uses matters. alarm() acts only on a row that is past its TTL:
 * expireIfDue returns early on any other, with or without the guard. A test that calls
 * alarm() on a row that is not due proves nothing about the guard, so the alarm tests
 * here use due rows. When you add a SessionDO method that reads the row, add a test
 * that goes red if the guard is bypassed in that method alone, and bypass it by hand
 * once to check.
 *
 * EXCLUDED FROM `npm run typecheck`; see the comment beside the entry in
 * tsconfig.test.json. Vitest is unaffected: it does not typecheck, and the
 * vi.mock below lets it load a module that imports `cloudflare:workers`. Issue
 * #12's Worker-side tsconfig project should absorb this file and drop the
 * exclusion.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// store-do.ts imports `cloudflare:workers`, which exists only inside workerd. Here
// a DurableObject is just something that holds its ctx and env.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

import * as storeDo from "../src/store-do.js";
import type { BellmanEnv } from "../src/store-do.js";
import type { Session } from "../src/types.js";
import { MAX_PAYLOAD_DEPTH, PayloadTooDeepError } from "../src/idempotency.js";
import { member, oneCode, roomManifest, session } from "./helpers/fixtures.js";

type StoreDo = typeof storeDo;

const LEGACY_ID = "qs_legacy";
const LEGACY_CODE = "BELL-OLD-01";

/**
 * The slice of DurableObjectStorage that SessionDO and RegistryDO use. Like the
 * real thing it serializes on the way in and out, so nothing is shared by
 * reference. `writes` and `alarms` let a test assert that a path wrote nothing.
 */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(
    Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]),
  );
  let writes = 0;
  let puts = 0;
  const alarms: number[] = [];
  return {
    get writes() { return writes; },
    /**
     * put() INVOCATIONS, where `writes` counts keys. The difference is the
     * whole point: three keys written in one call and the same three split
     * across two calls both move `writes` by 3, so only this can tell a
     * batched commit from separate ones.
     */
    get puts() { return puts; },
    alarms,
    snapshot: (): Record<string, unknown> => structuredClone(Object.fromEntries(rows)),
    get: async (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    /**
     * Both shapes the real DurableObjectStorage offers: put(key, value) and the
     * batched put(entries). createSession uses the batched one so the session,
     * its seed events and the cursor commit together.
     *
     * Anything else THROWS rather than being quietly absorbed. An earlier
     * version accepted only put(key, value); when the batched call arrived it
     * stored the entries object as a key and lost every row, and the tests
     * failed far away with an undefined session instead of here.
     */
    put: async (keyOrEntries: unknown, value?: unknown) => {
      puts++;
      if (typeof keyOrEntries === "string") {
        writes++;
        rows.set(keyOrEntries, structuredClone(value));
        return;
      }
      if (keyOrEntries && typeof keyOrEntries === "object" && value === undefined) {
        for (const [k, v] of Object.entries(keyOrEntries as Record<string, unknown>)) {
          writes++;
          rows.set(k, structuredClone(v));
        }
        return;
      }
      throw new TypeError(
        `fakeStorage.put: unsupported call shape (${typeof keyOrEntries}, ${typeof value}). ` +
        "Mirror the real DurableObjectStorage API here rather than letting a call be absorbed.",
      );
    },
    delete: async (key: string) => { writes++; return rows.delete(key); },
    setAlarm: async (at: number) => { alarms.push(at); },
    list: async (opts: { prefix?: string; start?: string; reverse?: boolean; limit?: number } = {}) => {
      let keys = [...rows.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? "") && k >= (opts.start ?? ""))
        .sort();
      if (opts.reverse) keys.reverse();
      if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
      return new Map(keys.map((k) => [k, structuredClone(rows.get(k))]));
    },
  };
}

/** The event rows in a storage snapshot. */
function eventsIn(rows: Record<string, unknown>): unknown[] {
  return Object.entries(rows).filter(([k]) => k.startsWith("e:")).map(([, e]) => e);
}

/**
 * A session as Durable Object storage held it before Session.manifest existed: a
 * top-level `mode`, no `manifest`, members with no `roomRole`, and no `events`
 * (those live under their own keys).
 */
function legacyRow(over: Partial<Session> = {}): Record<string, unknown> {
  const { manifest, events, joinCodes, ...rest } = session({ id: LEGACY_ID, ...over });
  return {
    ...rest,
    joinCode: LEGACY_CODE,
    joinCodeExpiresAt: Date.now() + 15 * 60 * 1000,
    mode: manifest.mode,
    members: rest.members.map(({ roomRole, ...m }) => m),
  };
}

/**
 * A session row as it is written today: a manifest, roomRole on members, and
 * events under their own keys. legacyRow deliberately lacks the manifest, so
 * hydrateStoredSession reads it as gone — which is right for the guard tests
 * and useless for anything that needs the session to exist.
 */
function currentRow(over: Partial<Session> = {}): Record<string, unknown> {
  const { events, ...rest } = session({ id: LEGACY_ID, joinCode: LEGACY_CODE, ...over });
  return rest;
}

/**
 * A DurableObjectStore over real SessionDO and RegistryDO instances on fake
 * storage, with the legacy session already stored and its join code already
 * registered, as a session created just before manifests shipped would be.
 */
async function worldOn(
  { DurableObjectStore, RegistryDO, SessionDO }: StoreDo,
  row: Record<string, unknown> = legacyRow(),
) {
  const legacyStorage = fakeStorage({ session: row, cursor: 0 });
  const registryStorage = fakeStorage();
  const registry = new RegistryDO({ storage: registryStorage } as never, {} as never);
  const sessions = new Map<string, InstanceType<typeof SessionDO>>([
    [LEGACY_ID, new SessionDO({ storage: legacyStorage } as never, {} as never)],
  ]);
  const env = {
    SESSION: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!sessions.has(id)) {
          sessions.set(id, new SessionDO({ storage: fakeStorage() } as never, {} as never));
        }
        return sessions.get(id)!;
      },
    },
    REGISTRY: { idFromName: (name: string) => name, get: () => registry },
  } as unknown as BellmanEnv;

  await registry.putJoinCode(LEGACY_CODE, LEGACY_ID);
  return {
    store: new DurableObjectStore(env),
    legacy: sessions.get(LEGACY_ID)!,
    legacyStorage,
    registryStorage,
  };
}

/**
 * store-do.ts loaded with hydrateStoredSession replaced by the identity function:
 * what production would run if stored() lost its call. Reloads the module graph so
 * the real, guarded import above is untouched.
 */
async function loadStoreDoWithoutGuard(): Promise<StoreDo> {
  vi.resetModules();
  vi.doMock("../src/stored-session.js", () => ({ hydrateStoredSession: (raw: unknown) => raw }));
  try {
    return await import("../src/store-do.js");
  } finally {
    vi.doUnmock("../src/stored-session.js");
    vi.resetModules();
  }
}

describe("a pre-manifest row is dropped at the single Durable Object read", () => {
  it("SessionDO.getSession() reads it as gone", async () => {
    const { legacy } = await worldOn(storeDo);
    expect(await legacy.getSession()).toBeUndefined();
  });

  it("the store facade's getSession and getSessionByJoinCode read it as gone too", async () => {
    const { store } = await worldOn(storeDo);
    expect(await store.getSession(LEGACY_ID)).toBeUndefined();
    // The join code is still registered and still unexpired, so only the guard stops this.
    expect(await store.getSessionByJoinCode(LEGACY_CODE)).toBeUndefined();
  });

  it("no mutator rewrites it, and appendEvent refuses it", async () => {
    const { legacy, legacyStorage } = await worldOn(storeDo);
    const before = legacyStorage.snapshot();

    await legacy.consumeJoinCode("peer_b");
    // false, not null: #71 gave this a third outcome, where null means "set, and
    // there was no previous code" and false means refused — here, because the row
    // reads as gone.
    expect(await legacy.setJoinCode("peer_b", "BELL-NEW-02", Date.now() + 60_000)).toBe(false);
    await legacy.addMember(member({ memberId: "m_joiner", userId: "u_peer" }));
    await legacy.updateMember("m_creator", { leftAt: Date.now() });
    await legacy.closeSession();
    await expect(
      legacy.appendEvent({
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "hi" }, refId: null,
      }),
    ).rejects.toThrow("Unknown session");

    // Not rewritten and not half-migrated. alarm() has its own test below: this row is
    // not due, so calling it here would tell us nothing about the guard.
    expect(legacyStorage.writes).toBe(0);
    expect(legacyStorage.snapshot()).toEqual(before);
  });

  it("alarm() leaves it alone even when it is past its TTL", async () => {
    // expireIfDue changes only a row that is past its TTL and returns early on any other.
    // A row that is not due passes through alarm() untouched with or without the guard,
    // so it would prove nothing.
    const { legacy, legacyStorage } = await worldOn(
      storeDo,
      legacyRow({ expiresAt: Date.now() - 1 }),
    );
    const before = legacyStorage.snapshot();

    await legacy.alarm();

    // Not closed, no session_expired appended, and the alarm did not reschedule itself.
    expect(legacyStorage.writes).toBe(0);
    expect(legacyStorage.alarms).toEqual([]);
    expect(legacyStorage.snapshot()).toEqual(before);
  });

  it("closeSessionIfEmpty reads it as gone, so it closes nothing and writes nothing", async () => {
    // An EMPTY room, on purpose. With someone still in it the method declines to
    // close whether or not it read through the guard, and a bypass of the guard
    // would leave this test green.
    const { legacy, legacyStorage } = await worldOn(
      storeDo,
      legacyRow({ members: [member({ leftAt: Date.now() })] }),
    );
    const before = legacyStorage.snapshot();

    expect(await legacy.closeSessionIfEmpty()).toBe(false);

    expect(legacyStorage.writes).toBe(0);
    expect(legacyStorage.snapshot()).toEqual(before);
  });
});

describe("a current row is untouched by the guard", () => {
  it("keeps its manifest through createSession, on both read paths", async () => {
    const { store } = await worldOn(storeDo);
    const s = session({
      id: "qs_current",
      joinCodes: oneCode("BELL-NEW-01"),
      manifest: roomManifest({ room: "kept", purpose: "keep me" }),
    });
    await store.createSession(s);

    expect((await store.getSession(s.id))?.manifest).toEqual(s.manifest);
    expect((await store.getSessionByJoinCode("BELL-NEW-01"))?.session.manifest).toEqual(s.manifest);
  });

  it("still expires when its alarm fires", async () => {
    const storage = fakeStorage();
    const doi = new storeDo.SessionDO({ storage } as never, {} as never);
    await doi.createSession(session({ id: "qs_expired", expiresAt: Date.now() - 1 }));

    await doi.alarm();

    // Read the raw rows: getSession() would expire it lazily and hide the alarm's part.
    const rows = storage.snapshot();
    expect(rows.session).toMatchObject({ closed: true });
    // toMatchObject is a subset match: { joinCodes: {} } would match ANY joinCodes value,
    // so the clear itself needs its own exact assertion or this line guards nothing.
    expect((rows.session as { joinCodes: unknown }).joinCodes).toEqual({});
    expect(eventsIn(rows)).toEqual([expect.objectContaining({ type: "session_expired" })]);
  });
});

describe("closing a session drops its registry rows", () => {
  /**
   * Pins the wiring D7 added (commit 007eec1): DurableObjectStore.closeSession
   * calling clearJoinCodes at the boundary where it holds the registry handle.
   * The store-contract suite's "closing a session clears every code" test looks
   * like coverage of this but runs only against MemoryStore, a separate
   * closeSession implementation that cannot exercise this path at all.
   *
   * The registry assertion is the one that carries the weight, not the map
   * assertion above it: getSessionByJoinCode's closed guard already makes the
   * codes stop resolving even if the registry rows are never dropped, so a
   * behavioural assertion alone proves nothing about whether the rows
   * themselves were cleared — only the raw registry snapshot can tell "the
   * codes stopped working" apart from "the rows were dropped", which is the
   * entire content of D7.
   */
  it("closeSession drops every role's registry row, not just the session's map", async () => {
    const { store, registryStorage } = await worldOn(storeDo);
    const s = session({ id: "qs_closing", joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
    await store.createSession(s);
    await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + 60_000);

    await store.closeSession(s.id);

    // The map cleared — this much MemoryStore already proves.
    expect((await store.getSession(s.id))?.joinCodes).toEqual({});
    // The registry rows went too — this is the part only the DO store can fail.
    // Checked by name rather than "no jc: rows at all": worldOn()'s own setup
    // unconditionally registers LEGACY_CODE under the unrelated legacy session,
    // so the registry is never empty of jc: rows even when this one closes clean.
    const keys = Object.keys(registryStorage.snapshot());
    expect(keys).not.toContain("jc:BELL-AAAA-01");
    expect(keys).not.toContain("jc:BELL-CCCC-03");
  });
});

describe("closing an empty room drops its registry rows, and only when it closes", () => {
  /**
   * The registry half of closeSessionIfEmpty, which only this store has. The
   * decision is made inside SessionDO and the rows are dropped at the facade,
   * the one place holding the registry handle. As above, only the raw registry
   * can tell "the codes stopped working" from "the rows were dropped": a closed
   * room's codes stop resolving whether or not anything cleared them.
   */
  it("drops every role's registry row when it closes the room", async () => {
    const { store, registryStorage } = await worldOn(storeDo);
    const s = session({
      id: "qs_emptied",
      members: [member({ leftAt: Date.now() })],
      joinCodes: oneCode("BELL-AAAA-01", "peer_b"),
    });
    await store.createSession(s);
    await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + 60_000);
    expect(Object.keys(registryStorage.snapshot()), "setup: the rows are there to drop")
      .toEqual(expect.arrayContaining(["jc:BELL-AAAA-01", "jc:BELL-CCCC-03"]));

    expect(await store.closeSessionIfEmpty(s.id)).toBe(true);

    const keys = Object.keys(registryStorage.snapshot());
    expect(keys).not.toContain("jc:BELL-AAAA-01");
    expect(keys).not.toContain("jc:BELL-CCCC-03");
  });

  // The other direction, and the one that costs most when it is wrong: a room
  // that stays open has to keep its door. The creator is still in this one.
  it("leaves every registry row alone when someone is still in the room", async () => {
    const { store, registryStorage } = await worldOn(storeDo);
    const s = session({ id: "qs_occupied", joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
    await store.createSession(s);
    await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + 60_000);

    expect(await store.closeSessionIfEmpty(s.id)).toBe(false);

    const keys = Object.keys(registryStorage.snapshot());
    expect(keys).toContain("jc:BELL-AAAA-01");
    expect(keys).toContain("jc:BELL-CCCC-03");
    expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
  });

  // What a close leaves behind if it dies between SessionDO and the registry:
  // the room closed, its rows standing. The retry has to read the room as
  // closed AND still drop the rows. A call that answered "nothing to do" for an
  // already-closed room would leave them for good, since no later call has any
  // reason to look.
  it("finishes a close whose registry rows were never dropped", async () => {
    const { store, legacy, registryStorage } = await worldOn(
      storeDo,
      currentRow({ members: [member({ leftAt: Date.now() })] }),
    );
    await store.setJoinCode(LEGACY_ID, "peer_b", "BELL-AAAA-01", Date.now() + 60_000);
    expect(await legacy.closeSessionIfEmpty(), "setup: closed inside the object only").toBe(true);
    expect(Object.keys(registryStorage.snapshot()), "setup: the row outlived the close")
      .toContain("jc:BELL-AAAA-01");

    expect(await store.closeSessionIfEmpty(LEGACY_ID)).toBe(true);

    expect(Object.keys(registryStorage.snapshot())).not.toContain("jc:BELL-AAAA-01");
  });
});

describe("negative control: the same calls with the guard removed", () => {
  /**
   * Without this, every "reads as gone" above could be a broken harness returning
   * undefined for its own reasons. Here the same world hands the legacy row to all
   * three read paths, so the undefined above is the guard's doing, and the crash
   * the guard prevents is shown to be real.
   */
  it("hands the legacy row to every read path, and manifest.mode throws", async () => {
    const unguarded = await loadStoreDoWithoutGuard();
    const { store, legacy } = await worldOn(unguarded);

    const leaked = [
      await legacy.getSession(),
      await store.getSession(LEGACY_ID),
    ];

    for (const s of leaked) {
      expect(s).toBeDefined();
      expect(() => s!.manifest.mode).toThrow(TypeError);
    }

    // The third read path now crashes inside the lookup itself: resolving a code
    // per role dereferences joinCodes, which a pre-manifest row has never had.
    await expect(store.getSessionByJoinCode(LEGACY_CODE)).rejects.toThrow(TypeError);
  });

  /**
   * The same again for the two "leaves it alone" tests above, which could otherwise pass
   * because the harness never gave the row to a mutator or to alarm(). Without the guard
   * the same calls do reach it and do change it.
   */
  it("lets a mutator rewrite it and a due alarm expire it", async () => {
    const unguarded = await loadStoreDoWithoutGuard();

    const viaMutator = await worldOn(unguarded);
    await viaMutator.legacy.closeSession();
    expect(viaMutator.legacyStorage.snapshot().session).toMatchObject({ closed: true });

    const viaAlarm = await worldOn(unguarded, legacyRow({ expiresAt: Date.now() - 1 }));
    await viaAlarm.legacy.alarm();
    const rows = viaAlarm.legacyStorage.snapshot();
    expect(rows.session).toMatchObject({ closed: true });
    // Same subset-match pitfall as the test above: assert the clear itself, exactly.
    expect((rows.session as { joinCodes: unknown }).joinCodes).toEqual({});
    expect(eventsIn(rows)).toEqual([expect.objectContaining({ type: "session_expired" })]);
  });

  /**
   * The same again for closeSessionIfEmpty's own guard test above, which could
   * otherwise pass because the harness never gave the row to the method. The room
   * is empty, so that with the guard gone the method has something to close.
   */
  it("lets closeSessionIfEmpty close it", async () => {
    const unguarded = await loadStoreDoWithoutGuard();
    const { legacy, legacyStorage } = await worldOn(
      unguarded,
      legacyRow({ members: [member({ leftAt: Date.now() })] }),
    );

    expect(await legacy.closeSessionIfEmpty()).toBe(true);

    expect(legacyStorage.snapshot().session).toMatchObject({ closed: true });
  });
});

/**
 * appendEventOnce inside the real SessionDO. The contract suite proves these
 * semantics for MemoryStore only (#12 is the work to point it here), so the
 * parts that are this object's own — the key row, and its landing in the same
 * put as the event — are pinned here.
 */
describe("SessionDO.appendEventOnce", () => {
  const keyed = (over: Record<string, unknown> = {}) => ({
    type: "message" as const, fromMemberId: "m_creator", fromUserId: "u_jesse",
    fromLabel: "jesse", payload: { text: "once" }, refId: null, ...over,
  });

  it("appends once and replays the same cursor", async () => {
    const { store } = await worldOn(storeDo, currentRow());

    const first = await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    const again = await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    expect(first.outcome).toBe("appended");
    expect(again.outcome).toBe("replayed");
    expect(again.outcome === "replayed" && again.event.cursor).toBe(1);
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(1);
  });

  it("refuses a key reused for different content", async () => {
    const { store } = await worldOn(storeDo, currentRow());
    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    const clash = await store.appendEventOnce(
      LEGACY_ID, keyed({ payload: { text: "different" } }), "send-0001",
    );

    expect(clash.outcome).toBe("conflict");
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(1);
  });

  it("returns frozen for a fresh key and replays a written one", async () => {
    const { store } = await worldOn(storeDo, currentRow());
    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    await store.freezeSession(LEGACY_ID, Date.now());

    expect((await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001")).outcome)
      .toBe("replayed");
    expect((await store.appendEventOnce(LEGACY_ID, keyed({ payload: { text: "new" } }), "send-0002")).outcome)
      .toBe("frozen");
  });

  /**
   * The key row, the event and the cursor commit together. Committed
   * separately, an interruption between them leaves the event stored with no
   * key naming it, and the retry that follows appends a second one — the
   * duplicate this method exists to prevent. writeEvent already makes this
   * argument for the event and the cursor; the key joins them for the same
   * reason, so one `put` is the assertion.
   */
  it("writes the key row in the same put as the event", async () => {
    const { store, legacyStorage } = await worldOn(storeDo, currentRow());

    const before = legacyStorage.writes;
    const putsBefore = legacyStorage.puts;
    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    // Three keys, in ONE call. The key count alone cannot tell a batched
    // commit from separate ones — 2 keys then 1 key also totals 3 — so the
    // invocation count is what actually pins the atomicity here.
    expect(legacyStorage.writes - before).toBe(3);
    expect(legacyStorage.puts - putsBefore).toBe(1);
    const rows = legacyStorage.snapshot();
    const ik = Object.keys(rows).filter((k) => k.startsWith("ik:"));
    expect(ik).toHaveLength(1);
    expect(rows[ik[0]]).toMatchObject({ cursor: 1 });
  });

  it("namespaces the key row per member", async () => {
    const { store, legacyStorage } = await worldOn(storeDo, currentRow());

    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    await store.appendEventOnce(
      LEGACY_ID, keyed({ fromMemberId: "m_joiner", payload: { text: "mine" } }), "send-0001",
    );

    expect(Object.keys(legacyStorage.snapshot()).filter((k) => k.startsWith("ik:")))
      .toHaveLength(2);
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(2);
  });

  /**
   * The contract suite pins this for MemoryStore; the suite does not run here
   * yet (#12), so the production store's ordering needs its own witness.
   *
   * fingerprint() throws before anything is written, so the throw must leave
   * the object untouched: no event row, no cursor bump, no key row — and the
   * key still free, which is the part a row count cannot show.
   */
  it("throws on a payload too deep to fingerprint, writing nothing", async () => {
    const { store, legacyStorage } = await worldOn(storeDo, currentRow());

    let deep: unknown = { leaf: true };
    for (let i = 0; i <= MAX_PAYLOAD_DEPTH; i++) deep = { a: deep };

    const putsBefore = legacyStorage.puts;
    await expect(
      store.appendEventOnce(LEGACY_ID, keyed({ payload: deep }), "send-0001"),
    ).rejects.toThrow(PayloadTooDeepError);

    expect(legacyStorage.puts - putsBefore).toBe(0);
    expect(Object.keys(legacyStorage.snapshot()).filter((k) => k.startsWith("ik:"))).toHaveLength(0);
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(0);

    // The key must still be free. A failed call that recorded it would make
    // this "replayed" or "conflict" rather than a fresh append.
    const after = await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    expect(after.outcome).toBe("appended");
  });
});

describe("a failed index write does not fail the operation it indexes", () => {
  /**
   * By the time DurableObjectStore writes an index, SessionDO has committed the
   * room or the seat. An index write that threw would abort the caller after the
   * effect had landed: a seat with no member_joined event and no audit row, for
   * a joiner who is told it failed. The index is derived and SessionDO is
   * authoritative, so the write is logged and swallowed, and the cost is a room
   * missing from one listing.
   *
   * The failure is injected by making the registry refuse the index prefixes.
   * Every other registry write, the join code above all, still goes through.
   */
  const refuse = (registryStorage: ReturnType<typeof fakeStorage>, prefixes: string[]) => {
    const realPut = registryStorage.put;
    registryStorage.put = async (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "string" && prefixes.some((p) => keyOrEntries.startsWith(p))) {
        throw new Error("registry unavailable");
      }
      return realPut(keyOrEntries, value);
    };
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it("createSession still creates the room, and its join code still resolves", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, registryStorage } = await worldOn(storeDo);
    refuse(registryStorage, ["us:", "um:"]);

    // Distinct creator and seated ids, so the log can be checked for naming the
    // right person on each index rather than the same one twice.
    await store.createSession(session({
      id: "qs_idx",
      createdBy: "u_creator",
      members: [member({ userId: "u_seated" })],
      joinCodes: oneCode("BELL-IDX-01", "peer_b"),
    }));

    expect((await store.getSession("qs_idx"))?.members).toHaveLength(1);
    expect((await store.getSessionByJoinCode("BELL-IDX-01"))?.session.id).toBe("qs_idx");
    // Neither index took its write, and each failure was said out loud. A lost
    // row is identified by the pair (user, room), so the log names both: it is
    // the only record of what to restore.
    expect(Object.keys(registryStorage.snapshot()).filter((k) => /^(us|um):/.test(k))).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("us index write failed for u_creator in qs_idx"), expect.any(Error),
    );
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("um index write failed for u_seated in qs_idx"), expect.any(Error),
    );
  });

  it("addMember still seats the member, and still says it did", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, registryStorage } = await worldOn(storeDo);
    await store.createSession(session({ id: "qs_idx", members: [] }));
    refuse(registryStorage, ["um:"]);

    expect(await store.addMember("qs_idx", member({ memberId: "m_joiner", userId: "u_peer" })))
      .toBe(true);

    expect((await store.getSession("qs_idx"))?.members.map((m) => m.memberId))
      .toEqual(["m_joiner"]);
    // The whole cost: one row missing from one listing.
    expect(await store.sessionsJoinedBy("u_peer", 10)).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("um index write failed for u_peer in qs_idx"), expect.any(Error),
    );
  });

  it("but a join code that cannot be registered still fails createSession", async () => {
    // The contrast that keeps the rule about indexes. A join code is
    // authoritative: one that does not resolve is a real failure, not a missing
    // listing row, so it is neither swallowed nor logged here.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, registryStorage } = await worldOn(storeDo);
    refuse(registryStorage, ["jc:"]);

    await expect(
      store.createSession(session({ id: "qs_nocode", joinCodes: oneCode("BELL-NOPE-01", "peer_b") })),
    ).rejects.toThrow("registry unavailable");
    expect(logged).not.toHaveBeenCalled();
  });
});
