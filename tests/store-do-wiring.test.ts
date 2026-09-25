/**
 * Pins the WIRING of the legacy-row guard: that SessionDO.stored() really calls
 * hydrateStoredSession, so every read path in store-do.ts inherits it.
 *
 * tests/store-do.test.ts proves the predicate on its own. It cannot prove this:
 * delete the call in stored() and that file still passes. These tests load the
 * real SessionDO, RegistryDO and DurableObjectStore over a fake storage, so
 * deleting the call turns them red.
 *
 * EXCLUDED FROM `npm run typecheck`; see the comment beside the entry in
 * tsconfig.test.json. Vitest is unaffected: it does not typecheck, and the
 * vi.mock below lets it load a module that imports `cloudflare:workers`. Issue
 * #12's Worker-side tsconfig project should absorb this file and drop the
 * exclusion.
 */
import { describe, it, expect, vi } from "vitest";

// store-do.ts imports `cloudflare:workers`, which exists only inside workerd. Here
// a DurableObject is just something that holds its ctx and env.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

import * as storeDo from "../src/store-do.js";
import type { BellmanEnv } from "../src/store-do.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

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
  const alarms: number[] = [];
  return {
    get writes() { return writes; },
    alarms,
    snapshot: (): Record<string, unknown> => structuredClone(Object.fromEntries(rows)),
    get: async (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key: string, value: unknown) => { writes++; rows.set(key, structuredClone(value)); },
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

/**
 * A session as Durable Object storage held it before Session.manifest existed: a
 * top-level `mode`, no `manifest`, members with no `roomRole`, and no `events`
 * (those live under their own keys).
 */
function legacyRow(): Record<string, unknown> {
  const { manifest, events, ...rest } = session({ id: LEGACY_ID, joinCode: LEGACY_CODE });
  return {
    ...rest,
    mode: manifest.mode,
    members: rest.members.map(({ roomRole, ...m }) => m),
  };
}

/**
 * A DurableObjectStore over real SessionDO and RegistryDO instances on fake
 * storage, with the legacy session already stored and its join code already
 * registered: the state production is in on the day this ships.
 */
async function worldOn({ DurableObjectStore, RegistryDO, SessionDO }: StoreDo) {
  const legacyStorage = fakeStorage({ session: legacyRow(), cursor: 0 });
  const registry = new RegistryDO({ storage: fakeStorage() } as never, {} as never);
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

  it("no mutator and no alarm rewrites it, and appendEvent refuses it", async () => {
    const { legacy, legacyStorage } = await worldOn(storeDo);
    const before = legacyStorage.snapshot();

    await legacy.consumeJoinCode();
    expect(await legacy.setJoinCode("BELL-NEW-02", Date.now() + 60_000)).toBeNull();
    await legacy.addMember(member({ memberId: "m_joiner", userId: "u_peer" }));
    await legacy.updateMember("m_creator", { leftAt: Date.now() });
    await legacy.closeSession();
    await legacy.alarm();
    await expect(
      legacy.appendEvent({
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "hi" }, refId: null,
      }),
    ).rejects.toThrow("Unknown session");

    // Not rewritten, not half-migrated, and the alarm did not reschedule itself.
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
      joinCode: "BELL-NEW-01",
      manifest: roomManifest({ room: "kept", purpose: "keep me" }),
    });
    await store.createSession(s);

    expect((await store.getSession(s.id))?.manifest).toEqual(s.manifest);
    expect((await store.getSessionByJoinCode("BELL-NEW-01"))?.manifest).toEqual(s.manifest);
  });

  it("still expires when its alarm fires", async () => {
    const storage = fakeStorage();
    const doi = new storeDo.SessionDO({ storage } as never, {} as never);
    await doi.createSession(session({ id: "qs_expired", expiresAt: Date.now() - 1 }));

    await doi.alarm();

    // Read the raw rows: getSession() would expire it lazily and hide the alarm's part.
    const rows = storage.snapshot();
    expect(rows.session).toMatchObject({ closed: true, joinCode: null });
    const events = Object.entries(rows).filter(([k]) => k.startsWith("e:")).map(([, e]) => e);
    expect(events).toEqual([expect.objectContaining({ type: "session_expired" })]);
  });
});

describe("negative control: the same reads with the guard removed", () => {
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
      await store.getSessionByJoinCode(LEGACY_CODE),
    ];

    for (const s of leaked) {
      expect(s).toBeDefined();
      expect(() => s!.manifest.mode).toThrow(TypeError);
    }
  });
});
