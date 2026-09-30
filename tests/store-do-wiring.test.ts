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
import { describe, it, expect, vi } from "vitest";
import { serialize } from "node:v8";

// store-do.ts imports `cloudflare:workers`, which exists only inside workerd. Here
// a DurableObject is just something that holds its ctx and env.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

// workerd global. The DO returns client and accepts server; a test drives the
// server side, which is the one acceptWebSocket is handed.
vi.stubGlobal("WebSocketPair", class {
  0 = fakeSocket();
  1 = fakeSocket();
});

// workerd answers an upgrade with a Response of status 101 carrying a
// `webSocket`. Node's Response throws a RangeError on any status outside
// 200-599, so SessionDO.fetch, which is written for workerd, cannot return
// here without this. It makes a 101 buildable and reads `status` and
// `webSocket` back as given. That is all it models; the rest is Node's own.
//
// It constrains nothing about the socket, and workerd constrains more. workerd
// throws a RangeError for a 101 with no socket (or a null one) and for a
// socket on a non-101 status; this builds the first and drops the socket in
// the second. workerd does not tell the client half from the server half
// either: sent the accepted one, it builds the 101 and the client's socket
// closes 1006. So nothing here enforces what a 101 carries. That is asserted
// where the response is read: "answers 101 and accepts the socket" requires a
// socket, and requires that it is not the accepted one.
const NodeResponse = Response;
vi.stubGlobal("Response", class extends NodeResponse {
  webSocket?: unknown;
  constructor(body?: BodyInit | null, init: ResponseInit & { webSocket?: unknown } = {}) {
    const upgrade = init.status === 101;
    super(body, upgrade ? { ...init, status: 200 } : init);
    if (upgrade) {
      Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = init.webSocket;
    }
  }
});

import * as storeDo from "../src/store-do.js";
import type { BellmanEnv } from "../src/store-do.js";
import type { Member, Session } from "../src/types.js";
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
  let lists = 0;
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
    /**
     * list() INVOCATIONS. A list is a range scan, so a read that makes one costs
     * O(keys in the range) where a get costs O(1) — which is what #25 was.
     */
    get lists() { return lists; },
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
      lists++;
      let keys = [...rows.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? "") && k >= (opts.start ?? ""))
        .sort();
      if (opts.reverse) keys.reverse();
      if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
      return new Map(keys.map((k) => [k, structuredClone(rows.get(k))]));
    },
  };
}

/**
 * A fake WebSocket pair plus the slice of DurableObjectState the Hibernation
 * API needs. The real runtime persists accepted sockets across eviction and
 * hands them back from getWebSockets(); here a plain array stands in, which is
 * enough for fan-out, replay and attachment logic but NOT for eviction itself.
 * Eviction is verified by npm run smoke against real Durable Objects — see D13.
 *
 * serializeAttachment enforces workerd's 16 KB cap, because the order of attach
 * and accept in fetch exists to survive that throw. It counts as workerd does,
 * V8's serialization: for 1,400 ids it gives 16,833 bytes, the figure workerd
 * reported, and the boundary matches too (1,362 ids fit, 1,363 do not). An
 * attachment never set reads back as null, as it does in workerd.
 */
const MAX_ATTACHMENT_BYTES = 16384;
function fakeSocket() {
  const sent: string[] = [];
  let attachment: unknown = undefined;
  let closed: { code: number; reason: string } | undefined;
  return {
    sent,
    get closed() { return closed; },
    send: (data: string) => { sent.push(data); },
    close: (code: number, reason: string) => { closed = { code, reason }; },
    serializeAttachment: (v: unknown) => {
      const bytes = serialize(v).byteLength;
      if (bytes > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `A WebSocket 'attachment' cannot be larger than ${MAX_ATTACHMENT_BYTES} bytes.` +
          `'attachment' was ${bytes} bytes.`,
        );
      }
      attachment = structuredClone(v);
    },
    deserializeAttachment: () => (attachment === undefined ? null : structuredClone(attachment)),
  };
}

/**
 * The ctx every SessionDO in this file is built over, in place of a bare
 * `{ storage }`. SessionDO is handed the whole DurableObjectState, and a
 * hand-rolled slice of it holds only until some path first reaches a member it
 * left out; the failure then lands in whichever test gets there first. When
 * the object starts using more of the runtime, grow this rather than making
 * the object tolerate a missing member, which would hide a genuinely missing
 * binding in workerd. RegistryDO touches only storage and keeps its own.
 */
function fakeCtx(storage: ReturnType<typeof fakeStorage>) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const autoResponses: unknown[] = [];
  return {
    storage,
    sockets,
    autoResponses,
    acceptWebSocket: (ws: unknown) => { sockets.push(ws as ReturnType<typeof fakeSocket>); },
    getWebSockets: () => [...sockets],
    setWebSocketAutoResponse: (r: unknown) => { autoResponses.push(r); },
  };
}

/**
 * Run `fn` with WebSocketPair wrapped, so a test can see each pair fetch
 * builds. `seen` gets the pair as it is constructed, before fetch has touched
 * it, which is the only moment a hook can see calls that come before the
 * accept. The stub is put back afterwards, whether or not fn throws.
 */
type FakePair = { 0: ReturnType<typeof fakeSocket>; 1: ReturnType<typeof fakeSocket> };
async function withPairs<T>(seen: (pair: FakePair) => void, fn: () => Promise<T>): Promise<T> {
  const RealPair = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class extends RealPair {
    constructor() {
      super();
      seen(this as unknown as FakePair);
    }
  };
  try {
    return await fn();
  } finally {
    globalThis.WebSocketPair = RealPair;
  }
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
    [LEGACY_ID, new SessionDO(fakeCtx(legacyStorage) as never, {} as never)],
  ]);
  const env = {
    SESSION: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!sessions.has(id)) {
          sessions.set(id, new SessionDO(fakeCtx(fakeStorage()) as never, {} as never));
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

  it("SessionDO.membersOf() reads it as an unknown room", async () => {
    // u_jesse owns m_creator in this row. A membersOf that read the raw row
    // would answer { memberIds: ["m_creator"], closed: false }, and /ws would
    // open a socket onto a room every other read path already treats as gone.
    const { legacy } = await worldOn(storeDo);
    expect(await legacy.membersOf("u_jesse")).toEqual({ memberIds: [], closed: true });
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
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
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

/**
 * What a session read COSTS, inside the real SessionDO. The contract suite
 * proves what getSession returns; it cannot see how many storage operations the
 * read made, and the count is this object's own.
 */
describe("SessionDO read cost", () => {
  it("getSession does not list events", async () => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    await doi.appendEvent({
      type: "message", fromMemberId: "m1", fromUserId: "u1",
      fromLabel: "jesse", payload: { n: 1 }, refId: null,
    });

    const before = storage.lists;
    const got = await doi.getSession();

    expect(got?.id).toBe(LEGACY_ID);
    expect(got).not.toHaveProperty("events");
    // The whole point of #25: a session read is O(1) keys, not O(events).
    expect(storage.lists - before).toBe(0);
  });
});

/**
 * SessionDO.membersOf, the /ws upgrade's authorization read. It is a SessionDO
 * method and deliberately not a BellmanStore one (MemoryStore cannot hold a
 * hibernatable socket), so the contract suite never reaches it and the real
 * object over fake storage is where it is pinned.
 */
describe("membersOf", () => {
  const withMembers = (...ms: Partial<Member>[]) =>
    currentRow({ members: ms.map((m) => member(m)) });

  it("returns every member that identity owns", async () => {
    const storage = fakeStorage({
      session: withMembers(
        { memberId: "m1", userId: "u1" },
        { memberId: "m2", userId: "u2" },
        { memberId: "m3", userId: "u1" },
      ),
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    // Review Focus #4: one identity, several members, one socket for all.
    expect(await doi.membersOf("u1")).toEqual({ memberIds: ["m1", "m3"], closed: false });
  });

  it("returns nothing for an identity that owns no member", async () => {
    const storage = fakeStorage({ session: withMembers({ memberId: "m1", userId: "u1" }), cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    expect(await doi.membersOf("u9")).toEqual({ memberIds: [], closed: false });
  });

  it("still returns a member who has left", async () => {
    // Review Focus #3. findMember (src/server.ts) does not exclude
    // leftAt, so bellman_sync still serves them. The two delivery paths
    // must not drift, so /ws must not exclude them either.
    const storage = fakeStorage({
      session: withMembers({ memberId: "m1", userId: "u1", leftAt: Date.now() }),
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    expect((await doi.membersOf("u1")).memberIds).toEqual(["m1"]);
  });

  it("reports a closed room as closed, with the membership intact", async () => {
    // Review Focus #2. A poll onto a closed room lasts 25s; a socket would
    // last forever. The route refuses, but the distinction is made here.
    const storage = fakeStorage({
      session: { ...withMembers({ memberId: "m1", userId: "u1" }), closed: true },
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    expect(await doi.membersOf("u1")).toEqual({ memberIds: ["m1"], closed: true });
  });

  it("reports a room past its TTL as closed, and writes nothing", async () => {
    // getSession closes a room past its TTL on read (expireIfDue), so
    // bellman_sync sees it as closed while its alarm is still pending. /ws
    // must say the same, or the two delivery paths disagree about whether the
    // room is live. membersOf gets there by computing it: authorizing a watch
    // must not mutate the room, and expireIfDue would write the closed flag,
    // clear the join codes and append session_expired.
    const storage = fakeStorage({
      session: { ...withMembers({ memberId: "m1", userId: "u1" }), expiresAt: Date.now() - 1 },
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    const before = storage.writes;
    expect(await doi.membersOf("u1")).toEqual({ memberIds: ["m1"], closed: true });
    expect(storage.writes - before).toBe(0);
    // setAlarm moves alarms and not writes, so scheduling work needs its own
    // check. alarms starts empty because the row is seeded, not created.
    expect(storage.alarms).toEqual([]);
  });

  it("agrees with getSession about a room at its TTL boundary", async () => {
    // The invariant is that membersOf and getSession agree about whether a
    // room is closed, so this compares them instead of asserting a literal per
    // timestamp. A literal would test today's rule and need editing whenever
    // the guard moves; a comparison goes red when the guard moves on one side
    // only. It cannot see both sides wrong together, which is what the TTL
    // case above is for.
    //
    // The clock is pinned because > and >= differ only at now === expiresAt,
    // a millisecond a real clock almost never lands on. Two objects per row,
    // because getSession can expire the room it reads.
    const now = 1_000_000;
    vi.setSystemTime(now);
    try {
      for (const [where, expiresAt] of [
        ["a millisecond past", now - 1],
        ["exactly at", now],
        ["a millisecond short of", now + 1],
      ] as const) {
        const row = { ...withMembers({ memberId: "m1", userId: "u1" }), expiresAt };
        const asked = new storeDo.SessionDO(
          fakeCtx(fakeStorage({ session: row, cursor: 0 })) as never, {} as never);
        const polled = new storeDo.SessionDO(
          fakeCtx(fakeStorage({ session: row, cursor: 0 })) as never, {} as never);
        expect((await asked.membersOf("u1")).closed, `${where} its TTL`).toBe(
          (await polled.getSession())?.closed);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unknown room as closed with no members", async () => {
    const doi = new storeDo.SessionDO(fakeCtx(fakeStorage()) as never, {} as never);
    expect(await doi.membersOf("u1")).toEqual({ memberIds: [], closed: true });
  });

  it("reads no event keys", async () => {
    const storage = fakeStorage({ session: withMembers({ memberId: "m1", userId: "u1" }), cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    // list() is how the log is scanned and get() is how one event is fetched
    // (eventAt). A list counter alone cannot see the second.
    const eventGets: string[] = [];
    const get = storage.get;
    storage.get = async (key: string) => {
      if (key.startsWith("e:")) eventGets.push(key);
      return get(key);
    };
    const before = storage.lists;
    await doi.membersOf("u1");
    expect(storage.lists - before).toBe(0);
    expect(eventGets).toEqual([]);
  });
});

/**
 * SessionDO.fetch, the /ws upgrade. A SessionDO method and deliberately not a
 * BellmanStore one (MemoryStore cannot hold a hibernatable socket), so the
 * contract suite never reaches it. The fake ctx has no input gate, so nothing
 * here can interleave with fetch. These pin what it sends and records and, in
 * the sequence case, that attach, accept and the sends all happen before it
 * next yields, which is what lets the real runtime's input gate make it atomic.
 */
describe("fetch: websocket upgrade", () => {
  const upgrade = (cursor: number, members = "m1") =>
    new Request("https://do/ws?cursor=" + cursor, {
      headers: { upgrade: "websocket", "x-bellman-members": members },
    });

  const world = async (events = 0) => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    for (let n = 1; n <= events; n++) {
      await doi.appendEvent({
        type: "message", fromMemberId: "m9", fromUserId: "u9",
        fromLabel: "peer", payload: { n }, refId: null,
      });
    }
    return { doi, ctx, storage };
  };

  it("answers 101 and accepts the socket", async () => {
    const { doi, ctx } = await world();
    const pairs: FakePair[] = [];
    const res = await withPairs((pair) => pairs.push(pair), () => doi.fetch(upgrade(0)));
    expect(res.status).toBe(101);
    expect(ctx.sockets).toHaveLength(1);
    expect(pairs).toHaveLength(1);
    // The client half goes out on the 101 and the server half is the one
    // accepted: both are identities against the pair fetch built. Weaker
    // checks admit real faults. "Truthy and not the accepted half" passes for
    // the whole pair or for {}. "Is the client half" alone passes when fetch
    // accepts the client half too, so the socket it returns is the accepted
    // one. Neither this fake nor the runtime's API objects to that last fault:
    // handed the accepted half, workerd builds the 101 and fetch returns
    // normally, and it shows only when a connection is used (no frames, close
    // 1006).
    const { webSocket } = res as unknown as { webSocket?: unknown };
    expect(webSocket).toBe(pairs[0][0]);
    expect(ctx.sockets[0]).toBe(pairs[0][1]);
  });

  it("replays exactly what was missed, and nothing already seen", async () => {
    const { doi, ctx } = await world(5);
    await doi.fetch(upgrade(3));
    const got = ctx.sockets[0].sent.map((s) => JSON.parse(s).cursor);
    expect(got).toEqual([4, 5]);
  });

  it("replays nothing when the cursor is current", async () => {
    const { doi, ctx } = await world(2);
    await doi.fetch(upgrade(2));
    expect(ctx.sockets[0].sent).toEqual([]);
  });

  it("stores the members and the replayed cursor on the attachment", async () => {
    const { doi, ctx } = await world(3);
    await doi.fetch(upgrade(1, "m1,m3"));
    expect(ctx.sockets[0].deserializeAttachment())
      .toEqual({ memberIds: ["m1", "m3"], cursor: 3 });
  });

  it("keeps the requested cursor on the attachment when nothing was replayed", async () => {
    const { doi, ctx } = await world(2);
    await doi.fetch(upgrade(2));
    expect(ctx.sockets[0].deserializeAttachment())
      .toEqual({ memberIds: ["m1"], cursor: 2 });
  });

  it("refuses a request that is not an upgrade", async () => {
    const { doi, ctx } = await world();
    const res = await doi.fetch(new Request("https://do/ws?cursor=0"));
    expect(res.status).toBe(426);
    expect(ctx.sockets).toHaveLength(0);
  });

  it("accepts no socket when reading the missed events fails", async () => {
    // Read first, then attach and accept (spec D5). Accepted before the read,
    // a socket outlives a failed read with no attachment, and wake() has no
    // good answer for a socket whose cursor it does not know: send it
    // everything, or silently send it nothing.
    const { doi, ctx, storage } = await world(2);
    storage.list = async () => { throw new Error("storage unavailable"); };

    await expect(doi.fetch(upgrade(0))).rejects.toThrow("storage unavailable");
    expect(ctx.sockets).toHaveLength(0);
  });

  it("reads, then attaches, accepts and sends, without yielding in between", async () => {
    // D5 as one assertion: the read, then attach, accept and send, with
    // nothing yielding between them. The whole sequence is compared, so any
    // reordering shows. The fake has no input gate to interleave, so "yield"
    // stands in for one. It marks the first await fetch reaches after the
    // read returns (or its return, if it reaches none), so what is logged
    // before it ran without yielding, and the sequence ends with it. An await
    // after the last send is allowed: nothing is left to register by then.
    //
    // "yield" is queued when the read SETTLES, not at accept. Queued at
    // accept it cannot see an await anywhere before the accept: between the
    // read and the pair, the pair and the attach, or the attach and the
    // accept. "Simplifying" it to accept time silently drops three of the
    // four windows.
    //
    // It also needs fetch to await the hooked promise itself, with no hop:
    // the marker sits behind fetch's continuation only then. Awaiting a
    // wrapper (the public eventsAfter, D5's name for the read) or chaining
    // `.then(x => x)` adds a hop, the marker overtakes fetch, and this goes
    // red on correct code. A `yield` right after `read` has two causes the
    // log cannot tell apart, a hop or an await added before the attach, so
    // look at how fetch awaits the read first. Hook whatever fetch awaits
    // directly.
    //
    // events() is the one thing fetch awaits, and the server socket does not
    // exist until fetch builds the pair, so the hooks go on events() and on the
    // WebSocketPair constructor (restored after). The attach comes before the
    // accept, so a hook installed at accept would never see it.
    const { doi, ctx } = await world(2);
    const calls: string[] = [];

    const events = doi.events.bind(doi);
    doi.events = (after?: number) => {
      calls.push("read");
      const read = events(after);
      read.then(() => queueMicrotask(() => calls.push("yield")), () => {});
      return read;
    };

    const accept = ctx.acceptWebSocket;
    ctx.acceptWebSocket = (ws) => { calls.push("accept"); accept(ws); };

    await withPairs((pair) => {
      const server = pair[1];
      const { serializeAttachment, send } = server;
      server.serializeAttachment = (v) => { calls.push("attach"); serializeAttachment(v); };
      server.send = (data) => { calls.push("send"); send(data); };
    }, () => doi.fetch(upgrade(0)));

    expect(calls).toEqual(["read", "attach", "accept", "send", "send", "yield"]);
  });

  it("accepts no socket when the attachment is over the runtime's cap", async () => {
    // Attach before accept (spec D5). Attached after, an over-cap attachment
    // throws with the socket already accepted and carrying no cursor. The fake
    // enforces workerd's 16 KB cap, so 1,400 ids reproduces it: workerd threw
    // at exactly this size, and left an accepted socket with no attachment.
    // What the fake cannot show is that an attachment set before the accept
    // persists in workerd. That is the dependency named in fetch, and Task 8's.
    const { doi, ctx } = await world(2);
    const ids = Array.from({ length: 1400 }, (_, i) => "m_" + i.toString(16).padStart(8, "0"));

    await expect(doi.fetch(upgrade(0, ids.join(",")))).rejects.toThrow("cannot be larger than 16384 bytes");
    expect(ctx.sockets).toHaveLength(0);
  });
});

/**
 * The TTL alarm's re-arm. createSession arms the alarm once, and expireIfDue's
 * guard is `now <= expiresAt`, so a firing that lands exactly on the boundary
 * expires nothing. That went unnoticed while bellman_sync called getSession on
 * every poll, which expired the room lazily. A member watching over a socket
 * does not poll, so on a quiet room nothing calls it, and the alarm has to
 * finish the job itself.
 *
 * The clock is pinned with vi.setSystemTime and put back in a finally, as in
 * membersOf's boundary case: a test cannot make a real clock read exactly
 * expiresAt.
 */
describe("SessionDO.alarm: the TTL re-arm", () => {
  it("re-arms the TTL alarm when it fires before the room is due", async () => {
    // The boundary: expireIfDue's guard is `now <= expiresAt`, so an alarm
    // landing exactly on expiresAt expires nothing. Without a re-arm the room
    // is then immortal until something calls getSession, and a room watched
    // over sockets is not polled.
    const at = Date.now() + 10_000;
    const storage = fakeStorage({ session: { ...currentRow(), expiresAt: at }, cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);

    try {
      vi.setSystemTime(at); // fire exactly on the boundary
      await doi.alarm();
    } finally {
      vi.useRealTimers();
    }

    expect((await storage.get("session")) as { closed: boolean }).toMatchObject({ closed: false });
    expect(storage.alarms.at(-1)).toBeGreaterThan(at);
  });

  it("closes the room on the re-armed firing, and arms nothing after it", async () => {
    // Why the re-arm terminates, run rather than argued. It is set for
    // expiresAt + 1, strictly after the boundary, so the firing it buys has
    // now > expiresAt and expireIfDue closes the room. Once the room is
    // closed the re-arm must stop: expiresAt + 1 is at or behind the clock by
    // then, so an alarm set there would be due the moment it was set, and
    // would set the next one the same way.
    const at = Date.now() + 10_000;
    const storage = fakeStorage({ session: { ...currentRow(), expiresAt: at }, cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    try {
      vi.setSystemTime(at);
      await doi.alarm(); // the boundary firing: nothing due, re-armed
      const rearmed = storage.alarms.at(-1)!;
      expect(rearmed).toBeGreaterThan(at);

      vi.setSystemTime(rearmed); // the runtime fires it when it comes due
      await doi.alarm();

      expect((await storage.get("session")) as { closed: boolean }).toMatchObject({ closed: true });
      expect(storage.alarms).toEqual([rearmed]); // the one re-arm, and no second
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm a room that is already closed", async () => {
    // closeSession leaves the TTL alarm pending, so it still fires on a room
    // that is already closed, and expireIfDue returns early on it without
    // writing. Nothing is left to expire, so nothing is re-armed.
    const storage = fakeStorage({
      session: { ...currentRow(), closed: true, expiresAt: Date.now() - 1 }, cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    await doi.alarm();

    expect(storage.alarms).toEqual([]);
  });
});
