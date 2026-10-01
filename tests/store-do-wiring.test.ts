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

// workerd global too. SessionDO registers one with the ctx; the fake ctx keeps
// whatever it is handed, so a test reads the pair back as `request` and `response`.
vi.stubGlobal("WebSocketRequestResponsePair", class {
  constructor(public request: string, public response: string) {}
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
import { publicEvent } from "../src/public-event.js";
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
 *
 * close() and send() model what workerd measurably does (1.20260926.1, compat
 * date 2026-09-01). close() THROWS for a code it refuses (below 1000, 5000 and
 * up, and 1004, 1005, 1006 and 1015, which RFC 6455 reserves) and for a reason
 * over 123 bytes of UTF-8, and a throw inside webSocketMessage leaves the
 * socket open. A close the runtime would refuse therefore fails here too, with
 * the runtime's own message, instead of passing. send() THROWS after close(),
 * while the runtime goes on listing the socket until its peer acknowledges the
 * close, and readyState reads CLOSING for that whole time.
 */
const MAX_ATTACHMENT_BYTES = 16384;
const MAX_CLOSE_REASON_BYTES = 123;
function fakeSocket() {
  const sent: string[] = [];
  let attachment: unknown = undefined;
  let closed: { code: number; reason: string } | undefined;
  return {
    sent,
    get closed() { return closed; },
    // OPEN (1) until close(), CLOSING (2) after it. That is what workerd reads on
    // a socket whose peer has not acknowledged a close: from the close until the
    // ack, on the instance that closed it and on one revived after eviction
    // (measured, 1.20260926.1). The fake has no peer to acknowledge, so it never
    // reaches CLOSED (3); a test that needs 3 defines the property.
    get readyState() { return closed ? 2 : 1; },
    send: (data: string) => {
      if (closed) throw new Error("Can't call WebSocket send() after close().");
      sent.push(data);
    },
    close: (code: number, reason: string) => {
      if (code < 1000 || code >= 5000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
        throw new Error(`Invalid WebSocket close code: ${code}.`);
      }
      if (new TextEncoder().encode(reason).byteLength > MAX_CLOSE_REASON_BYTES) {
        throw new Error(
          `WebSocket close reason must not be longer than ${MAX_CLOSE_REASON_BYTES} bytes when UTF-8 encoded.`,
        );
      }
      closed = { code, reason };
    },
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

  it("replays the public event, not the stored one", async () => {
    // Spec D1a, on the replay path: the same projection wake() sends. A member
    // who reconnects must not be told by the replay what a live member is not.
    const { doi, ctx } = await world(2);
    await doi.fetch(upgrade(0));

    const stored = await doi.eventsAfter(0);
    expect(stored).toHaveLength(2);
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s))).toEqual(stored.map(publicEvent));
    for (const frame of ctx.sockets[0].sent) expect(frame).not.toContain("fromUserId");
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

  it("accepts no socket when a frame cannot be built", async () => {
    // fetch builds the frames straight after the read, before the attach and
    // the accept, so a failure there accepts nothing, as the read's and the
    // attach's do. An event whose time cannot be formatted is such a failure:
    // publicEvent throws on it. Build the frames after the accept and the
    // request still fails, but with a socket left accepted.
    const { doi, ctx } = await world();
    doi.events = async () => [{
      cursor: 1, at: Number.NaN, type: "message", fromMemberId: "m9",
      fromUserId: "u9", fromLabel: "peer", payload: {}, refId: null,
    }];

    await expect(doi.fetch(upgrade(0))).rejects.toThrow(/Invalid time value/);
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
 * wake()'s socket arm. wake() is private and reached through its three callers,
 * appendEvent, appendEventOnce and the TTL alarm (by way of expireIfDue), so
 * these drive those. The waiter arm is the long poll that remote MCP clients
 * keep using, and it stays: "still resolves a long-poll waiter" pins that both
 * arms serve one event.
 */
describe("wake: socket delivery", () => {
  const world = async () => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    const post = (n: number) => doi.appendEvent({
      type: "message", fromMemberId: "m9", fromUserId: "u9",
      fromLabel: "peer", payload: { n }, refId: null,
    });
    return { doi, ctx, post };
  };
  const open = (ctx: ReturnType<typeof fakeCtx>, cursor: number, members = "m1") =>
    new Request("https://do/ws?cursor=" + cursor, {
      headers: { upgrade: "websocket", "x-bellman-members": members },
    });

  it("sends an appended event to a watching socket", async () => {
    const { doi, ctx, post } = await world();
    await doi.fetch(open(ctx, 0));
    await post(1);
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).payload)).toEqual([{ n: 1 }]);
  });

  it("fans out to every socket", async () => {
    const { doi, ctx, post } = await world();
    await doi.fetch(open(ctx, 0, "m1"));
    await doi.fetch(open(ctx, 0, "m2"));
    await post(1);
    expect(ctx.sockets).toHaveLength(2);
    for (const ws of ctx.sockets) expect(ws.sent).toHaveLength(1);
  });

  it("advances each socket's attachment as it sends", async () => {
    const { doi, ctx, post } = await world();
    await doi.fetch(open(ctx, 0));
    await post(1);
    await post(2);
    expect((ctx.sockets[0].deserializeAttachment() as { cursor: number }).cursor).toBe(2);
  });

  it("skips a socket already past the event", async () => {
    const { doi, ctx, post } = await world();
    await post(1);
    // Connects at cursor 1: it has already seen event 1 and must not get it.
    await doi.fetch(open(ctx, 1));
    const ws = ctx.sockets[0];
    expect(ws.sent).toEqual([]);
    await post(2);
    expect(ws.sent.map((s) => JSON.parse(s).cursor)).toEqual([2]);
  });

  it("sends nothing to a socket that claimed a cursor ahead of the room", async () => {
    // The guard's ONLY real trigger, and the reason the test above cannot
    // prove it. A socket's attachment starts at the cursor the client named
    // and cursors only rise, so in ordinary flow event.cursor is always
    // above att.cursor and the guard never fires — remove it and the test
    // above still passes. It fires when a client names a cursor the room
    // has not reached, and then it must: that client has claimed to have
    // seen through 10, so 1 and 2 are not news to it.
    const { doi, ctx, post } = await world();
    await doi.fetch(open(ctx, 10));
    await post(1);
    await post(2);
    expect(ctx.sockets[0].sent).toEqual([]);

    // ...and it starts receiving once the room passes what it claimed.
    for (let n = 3; n <= 11; n++) await post(n);
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).cursor)).toEqual([11]);
  });

  it("still resolves a long-poll waiter", async () => {
    const { doi, ctx, post } = await world();
    await doi.fetch(open(ctx, 0));
    const polling = doi.waitForEvents(0, 5_000);
    await post(1);
    expect((await polling).map((e) => e.cursor)).toEqual([1]);
    // Both arms, one event. The long poll is permanent for remote clients.
    expect(ctx.sockets[0].sent).toHaveLength(1);
  });

  it("delivers session_expired over the socket too", async () => {
    const storage = fakeStorage({
      session: { ...currentRow(), expiresAt: Date.now() - 1 }, cursor: 0,
    });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    await doi.fetch(open(ctx, 0));
    await doi.alarm();
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).type)).toEqual(["session_expired"]);
  });

  // The cases below pin what the seven above leave open.

  it("sends an event appended with a key, and does not resend it on a replay", async () => {
    // appendEventOnce is the second of wake()'s three callers: it is what
    // bellman_send calls when it carries an idempotency_key. A retry finds the
    // stored event and returns it without appending, so nothing wakes and the
    // socket must not see it a second time.
    const { doi, ctx } = await world();
    await doi.fetch(open(ctx, 0));
    const send = () => doi.appendEventOnce({
      type: "message", fromMemberId: "m9", fromUserId: "u9",
      fromLabel: "peer", payload: { n: 1 }, refId: null,
    }, "send-0001");

    expect((await send()).outcome).toBe("appended");
    expect((await send()).outcome).toBe("replayed");
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).payload)).toEqual([{ n: 1 }]);
  });

  it("sends nothing to a socket that has no attachment", async () => {
    // Fail closed. fetch attaches before it accepts, so a socket it accepts
    // always carries one; a socket without one is a symptom that something is
    // wrong, and the DEPENDENCY paragraph on fetch names one way. Its cursor is
    // unknown, so it gets nothing rather than every event. fakeSocket reads an
    // attachment that was never set back as null, as workerd does.
    const { doi, ctx, post } = await world();
    ctx.acceptWebSocket(fakeSocket());
    await post(1);
    expect(ctx.sockets[0].sent).toEqual([]);
  });

  it("has delivered by the time wake() returns", async () => {
    // wake() is synchronous: getWebSockets, deserializeAttachment, send and
    // serializeAttachment all are, and an await between reading a socket's
    // cursor and sending would reopen the gap that read-and-register exists to
    // close. So nothing here awaits, and the frame is on the socket when the
    // call returns. wake() is private, so this reaches it by name; the cases
    // above reach it through its callers.
    const { doi, ctx } = await world();
    await doi.fetch(open(ctx, 0));
    (doi as unknown as { wake(e: unknown): void }).wake({
      cursor: 1, at: 0, type: "message", fromMemberId: "m9", fromUserId: "u9",
      fromLabel: "peer", payload: { n: 1 }, refId: null,
    });
    expect(ctx.sockets[0].sent).toHaveLength(1);
  });

  it("sends the public event, not the stored one", async () => {
    // Spec D1a. The stored event carries fromUserId, the sender's upstream
    // identity (u_github_4242 and the like), and every member of a room
    // receives every other member's events. So the frame is publicEvent(event):
    // the projection the poll returns, one shape for both transports.
    const { doi, ctx } = await world();
    await doi.fetch(open(ctx, 0));
    const event = await doi.appendEvent({
      type: "message", fromMemberId: "m9", fromUserId: "u_github_4242",
      fromLabel: "peer", payload: { n: 1 }, refId: null,
    });

    const frame = ctx.sockets[0].sent[0];
    expect(frame).not.toContain("4242");
    expect(Object.keys(JSON.parse(frame)).sort())
      .toEqual(["at", "cursor", "from", "payload", "ref_id", "type"]);
    expect(JSON.parse(frame)).toEqual(publicEvent(event!));
  });

  it("does not let a socket that throws starve the others, or fail the append", async () => {
    // A send can throw in workerd: to a socket that closed between wake()'s
    // readyState check and its send, which "wake() and a socket that
    // webSocketMessage has closed" under "receive-only" drives. This one throws
    // from the fake on a socket that reads OPEN, so it holds whatever the cause.
    // If a throw ended the loop, getWebSockets() returns a list and every later
    // socket would miss the event, after the waiter arm had run and the event
    // was stored, and the append would fail for a sender whose message is safe.
    const { doi, ctx, post } = await world();
    for (const member of ["m1", "m2", "m3"]) await doi.fetch(open(ctx, 0, member));
    const boom = new Error("send failed");
    ctx.sockets[1].send = () => { throw boom; };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(post(1)).resolves.toMatchObject({ cursor: 1 });

      // Both neighbours got it. The one that threw did not, and keeps its old
      // cursor: the cursor moves only after a send that returned.
      expect(ctx.sockets[0].sent).toHaveLength(1);
      expect(ctx.sockets[2].sent).toHaveLength(1);
      const cursorOf = (i: number) =>
        (ctx.sockets[i].deserializeAttachment() as { cursor: number }).cursor;
      expect([cursorOf(0), cursorOf(1), cursorOf(2)]).toEqual([1, 0, 1]);

      // Logged once, with the error itself.
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]).toContain(boom);
    } finally {
      log.mockRestore();
    }
  });

  // An event whose time publicEvent cannot format. It is the detector for the
  // two cases below: wherever a frame is built for it, publicEvent throws.
  const unformattable = {
    cursor: 1, at: Number.NaN, type: "message", fromMemberId: "m9",
    fromUserId: "u9", fromLabel: "peer", payload: {}, refId: null,
  };
  // wake() is private, so these reach it by name.
  const wakeOf = (doi: unknown) =>
    (doi as { wake(e: unknown): void }).wake.bind(doi);

  it("builds no frame for a socket that is not due the event", async () => {
    // The frame is built on the first socket that is due the event, not on
    // every append: a poll-only room has no sockets and pays nothing per
    // append, and a room whose sockets are all past the event pays nothing
    // either. Built eagerly, the unformattable event throws out of wake() with
    // no socket to blame. Built for a socket that is not due it, the failure is
    // caught by the per-socket try and logged. Built lazily, nothing is built,
    // so nothing throws and nothing is logged.
    const { doi, ctx } = await world();
    const wake = wakeOf(doi);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => wake(unformattable)).not.toThrow(); // no sockets at all

      await doi.fetch(open(ctx, 5)); // a socket already past cursor 1
      expect(() => wake(unformattable)).not.toThrow();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    expect(ctx.sockets[0].sent).toEqual([]);
  });

  it("contains a frame that cannot be built, so it cannot fail the append", async () => {
    // The frame is built inside the per-socket try, after the guard, so a
    // projection failure is one more thing that try contains: it does not fail
    // an append whose event is already stored. Nothing is sent, and the socket
    // keeps its cursor.
    const { doi, ctx } = await world();
    await doi.fetch(open(ctx, 0));
    const wake = wakeOf(doi);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => wake(unformattable)).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][1])).toMatch(/Invalid time value/);
    } finally {
      log.mockRestore();
    }
    expect(ctx.sockets[0].sent).toEqual([]);
    expect((ctx.sockets[0].deserializeAttachment() as { cursor: number }).cursor).toBe(0);
  });
});

/**
 * The socket's other half: what a client may not do over it, and the lifecycle
 * the runtime delivers to SessionDO. fetch and wake() are tested above; these
 * are webSocketMessage, webSocketClose, webSocketError and the auto-response the
 * constructor registers.
 *
 * Where a handler does something, an assertion that something did NOT happen
 * (nothing appended, nothing written) sits in one toEqual with the thing that
 * did: a socket closed 1003, or acknowledged with 1000. Alone, "nothing written"
 * is satisfied by a handler that does nothing at all. webSocketError does
 * nothing by design, so its test can only show that it returns and writes
 * nothing, and the throwing and writing versions of it are what turn that red.
 *
 * The auto-response itself cannot be exercised here. The runtime answers a
 * matching frame without running any JavaScript, so there is no handler to call,
 * and no test in this file can see an object not being woken. What it can pin is
 * the registration: that it exists, at construction, with the right strings.
 * That it works, and what it does and does not cover, was measured against real
 * workerd; the constructor's comment says how.
 */
describe("receive-only", () => {
  const upgrade = (members = "m1") =>
    new Request("https://do/ws?cursor=0", {
      headers: { upgrade: "websocket", "x-bellman-members": members },
    });

  const world = async () => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    await doi.fetch(upgrade());
    return { doi, ctx, storage, ws: ctx.sockets[0] };
  };

  it.each([
    ["a text frame", "anything"],
    ["a message shaped like a bellman_send", JSON.stringify({ type: "message", payload: {} })],
    ["a binary frame", new ArrayBuffer(8)],
  ])("closes a socket that sends %s", async (_what, frame) => {
    const { doi, ws } = await world();
    await doi.webSocketMessage(ws as never, frame);
    expect(ws.closed?.code).toBe(1003);
  });

  it("says where to send instead, within the close reason's size limit", async () => {
    const { doi, ws } = await world();
    await doi.webSocketMessage(ws as never, "anything");
    expect(ws.closed).toMatchObject({ code: 1003, reason: expect.stringContaining("bellman_send") });
    // The fake throws above this size, as workerd does, so a longer reason fails
    // the close itself first; this puts the number where a reader looks.
    expect(new TextEncoder().encode(ws.closed!.reason).byteLength).toBeLessThanOrEqual(123);
  });

  it("appends nothing when a client sends", async () => {
    const { doi, storage, ws } = await world();
    const before = {
      writes: storage.writes, puts: storage.puts, alarms: storage.alarms.length,
      events: (await doi.eventsAfter(0)).length,
    };
    await doi.webSocketMessage(ws as never, JSON.stringify({ type: "message", payload: {} }));
    expect({
      closedWith: ws.closed?.code,
      keysWritten: storage.writes - before.writes,
      puts: storage.puts - before.puts,
      alarmsSet: storage.alarms.length - before.alarms,
      eventsAppended: (await doi.eventsAfter(0)).length - before.events,
    }).toEqual({ closedWith: 1003, keysWritten: 0, puts: 0, alarmsSet: 0, eventsAppended: 0 });
  });

  it("registers a ping auto-response when the object is built, so a keepalive never wakes it", () => {
    // Before any fetch: the registration belongs to the object, not to an
    // upgrade. See the constructor for why that placement.
    const ctx = fakeCtx(fakeStorage({ session: currentRow(), cursor: 0 }));
    new storeDo.SessionDO(ctx as never, {} as never);
    expect(ctx.autoResponses).toHaveLength(1);
    expect(ctx.autoResponses[0]).toMatchObject({ request: "ping", response: "pong" });
  });

  describe("wake() and a socket that webSocketMessage has closed", () => {
    // A client sending a frame is the expected case (D1), so a socket closed 1003
    // is a normal path and not an edge. The runtime goes on listing it until its
    // peer acknowledges, reading CLOSING, and a send to it throws (measured in
    // workerd, and modelled by the fake). Left to the per-socket catch, every
    // append in that window logs a failed delivery for it, and a client that
    // reconnects and sends again becomes sustained error noise.
    const post = (doi: InstanceType<typeof storeDo.SessionDO>, n: number) =>
      doi.appendEvent({
        type: "message", fromMemberId: "m9", fromUserId: "u9",
        fromLabel: "peer", payload: { n }, refId: null,
      });

    // Three members' sockets: [0] and [2] open, [1] has sent a frame and been closed.
    const fanOut = async () => {
      const { doi, ctx } = await world();
      await doi.fetch(upgrade("m2"));
      await doi.fetch(upgrade("m3"));
      await doi.webSocketMessage(ctx.sockets[1] as never, "anything");
      return { doi, ctx };
    };

    it.each([
      ["closing", undefined],
      ["closed", 3],
    ])("skips a socket that is %s: no send, no log, and its open peers still get the event", async (_state, forced) => {
      const { doi, ctx } = await fanOut();
      const gone = ctx.sockets[1];
      if (forced !== undefined) Object.defineProperty(gone, "readyState", { value: forced });
      const send = vi.spyOn(gone, "send");
      const read = vi.spyOn(gone, "deserializeAttachment");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(post(doi, 1)).resolves.toMatchObject({ cursor: 1 });
        // One comparison, with the open peers' delivery in it: "no send, no log"
        // alone is satisfied by a wake() that delivers to nobody.
        expect({
          openPeersGot: [ctx.sockets[0].sent.length, ctx.sockets[2].sent.length],
          sendsTried: send.mock.calls.length,
          attachmentsRead: read.mock.calls.length,
          logged: log.mock.calls.length,
        }).toEqual({ openPeersGot: [1, 1], sendsTried: 0, attachmentsRead: 0, logged: 0 });
      } finally {
        log.mockRestore();
      }
    });

    it("still contains a send that fails after the check passed", async () => {
      // A socket can close between the readyState check and the send, and that is
      // what the per-socket catch is for. Forced to read OPEN, the closed fake
      // passes the check and its send throws as workerd's does: the failure is
      // logged once, not swallowed, and nobody else loses the event.
      const { doi, ctx } = await fanOut();
      Object.defineProperty(ctx.sockets[1], "readyState", { value: 1 });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(post(doi, 1)).resolves.toMatchObject({ cursor: 1 });
        expect({
          openPeersGot: [ctx.sockets[0].sent.length, ctx.sockets[2].sent.length],
          logged: log.mock.calls.length,
          error: String(log.mock.calls[0]?.[1]),
        }).toEqual({
          openPeersGot: [1, 1], logged: 1, error: expect.stringMatching(/send\(\) after close\(\)/),
        });
      } finally {
        log.mockRestore();
      }
    });

    it("sends to a socket whose readyState is nothing it recognises", async () => {
      // Skipping rests on positive knowledge that a socket is closing, and only
      // on that. A reading nobody expected must not silently stop delivery.
      const { doi, ctx } = await world();
      Object.defineProperty(ctx.sockets[0], "readyState", { value: undefined });
      await post(doi, 1);
      expect(ctx.sockets[0].sent).toHaveLength(1);
    });
  });

  describe("when the peer closes, or the connection drops or breaks", () => {
    it.each([
      ["a polite close", 1000, "bye", true],
      ["a close with no status code, which arrives as 1005", 1005, "", true],
      ["an application's own code", 4000, "app", true],
      ["a connection that dropped, which arrives as 1006", 1006, "WebSocket disconnected without sending Close frame.", false],
    ])("acknowledges %s, so the peer's close completes", async (_what, code, reason, clean) => {
      const { doi, storage, ws } = await world();
      const before = storage.writes;
      await doi.webSocketClose(ws as never, code, reason, clean);
      expect({ closedWith: ws.closed?.code, keysWritten: storage.writes - before })
        .toEqual({ closedWith: 1000, keysWritten: 0 });
    });

    it("takes an error from the runtime without throwing or writing", async () => {
      const { doi, storage, ws } = await world();
      const before = storage.writes;
      await expect(doi.webSocketError(ws as never, new Error("boom"))).resolves.toBeUndefined();
      expect(storage.writes - before).toBe(0);
    });
  });
});

/**
 * The TTL alarm's re-arm. createSession arms the alarm once, and expireIfDue's
 * guard is `now <= expiresAt`, so a firing that lands exactly on the boundary
 * expires nothing. That would have gone unnoticed while bellman_sync called
 * getSession on every poll, which expires the room lazily. A member watching
 * over a socket does not poll, so on a quiet room nothing calls it, and the
 * alarm has to finish the job itself.
 *
 * The clock is pinned with vi.setSystemTime and put back in a finally, as in
 * membersOf's boundary case: a test cannot make a real clock read exactly
 * expiresAt.
 */
describe("SessionDO.alarm: the TTL re-arm", () => {
  it("re-arms the TTL alarm when it fires exactly on the boundary", async () => {
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

  it("does not re-arm a firing that lands before the room is due", async () => {
    // The re-arm is for the boundary, now === expiresAt, and only for it. An
    // alarm set for expiresAt is expected to run at or after it, so a firing
    // before it points to a handler clock that disagrees with the one that
    // scheduled the alarm, and a re-arm would set an alarm for expiresAt + 1
    // that is already in the past: due at once, and re-armed again, until the
    // object is torn down. The contract suite's frozen fake clock is such a
    // disagreement, and before this gate it printed "failed to invoke drain()"
    // lines in npm run test:worker.
    const at = Date.now() + 10_000;
    const storage = fakeStorage({ session: { ...currentRow(), expiresAt: at }, cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    try {
      vi.setSystemTime(at - 5_000); // early: not due, and not on the boundary
      await doi.alarm();
    } finally {
      vi.useRealTimers();
    }

    expect((await storage.get("session")) as { closed: boolean }).toMatchObject({ closed: false });
    expect(storage.alarms).toEqual([]);
  });
});
