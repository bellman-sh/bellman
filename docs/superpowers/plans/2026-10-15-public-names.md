# Public Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public room's link can be `dash.bellman.sh/r/<name>`, a name its creator chooses, checked and set by one tool and held while the room is public and open.

**Architecture:** The room's record holds the name (`Session.publicName`); the registry keeps a name → session index that is only a hint, claimed by compare-and-set and checked against the record wherever it is read, so nothing runs at close, unpublish or rename. `bellman_start` takes `public_name` beside the manifest, `bellman_public_name` checks or sets one, and `GET /public/rooms/:key` reads a room by name or id. Dash's copy link follows in its own PR.

**Tech Stack:** TypeScript, zod, the MCP SDK, Cloudflare Durable Objects, vitest (Node and Workers pools); dash: React, vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-public-names-design.md`

## Global Constraints

- The name rule (D2), exactly: `^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$`. A name outside it is refused with the rule in words, never rewritten.
- One new tool, `bellman_public_name` (D3). `bellman_start` gains `public_name` as an argument beside `manifest`, never a manifest field (D4).
- A room holds a name only while its record names it and it is public and open (`holdsName`); the registry's index is a hint, and a claim writes it only if the entry is still what the claimer read (D5).
- Every `BellmanStore` method is async, and `MemoryStore` and `DurableObjectStore` pass the store contract identically (CLAUDE.md).
- A new tool means editing `extension/manifest.json`; `tests/extension.test.ts` enforces it (CLAUDE.md).
- `src/ui/assets.ts` is generated: never edit it (CLAUDE.md).
- Never describe Bellman as a thing for "two sessions"; say members, the room, peers (CLAUDE.md).
- Commits are signed; stage files by name; `main` moves only through a PR.
- The listing's cost is re-measured and recorded in `docs/ARCHITECTURE.md` §11 (D8).

## Review Focus

1. A taken name on a hosted public room: the refusal must not keep one of its creator's hosted slots, so the claim runs before `reserveHostedRoom`. Test in Task 3.
2. Renaming a room back to a name it held before (A → B → A): the index entry still points at the room and the claim must succeed, freeing B. Test in Task 4.
3. A closed room's name is free at once, while the room stays readable at its session id (D6 against the public rooms spec's D7). Tests in Tasks 4 and 5.
4. A name with capitals, `_`, spaces or accents is refused with the rule, never lowercased or rewritten into a different name. Test in Task 1.
5. A public read of a name nobody holds is answered from the index alone, without reading any room (no Durable Object started for a made-up key). Test in Task 5.

---

### Task 1: The name rule and the room's record

**Files:**
- Create: `src/public-names.ts`
- Modify: `src/types.ts` (`Session`, beside `unpublishedAt`)
- Modify: `src/stored-session.ts` (`hydrateStoredSession`, and its doc list of defaults)
- Modify: `src/tools/start.ts` (the `NewSession` literal)
- Modify: `tests/helpers/fixtures.ts` (`session`)
- Test: `tests/public-names.test.ts` (new)

**Interfaces:**
- Consumes: `isPublic` from `src/store.ts`; `StoredSession` from `src/stored-session.ts`.
- Produces: `src/public-names.ts` exports `PUBLIC_NAME: RegExp`, `publicNameRefusal(name: string): string | null`, `holdsName(session: Holder | undefined, name: string): boolean`, `heldName(session: Holder): string | null`, where `Holder = Pick<StoredSession, "publicName" | "manifest" | "unpublishedAt" | "closed">`. `Session` gains `publicName: string | null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/public-names.test.ts`:

```ts
/**
 * Public names (public names spec): the rule a name keeps, whether a room holds one, claiming
 * one through the index, bellman_start's public_name and the tool that checks and sets one.
 * The route is tests/http-public.test.ts; the store methods are the store contract's.
 */
import { describe, expect, it } from "vitest";
import { PUBLIC_NAME, heldName, holdsName, publicNameRefusal } from "../src/public-names.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { roomManifest, session } from "./helpers/fixtures.js";

describe("the name rule (D2)", () => {
  it("takes 3 to 40 lowercase letters, digits and single hyphens, a letter or digit at each end", () => {
    for (const good of ["bellman-dev", "abc", "a1b", "a-b", "room-2026-10", "x".repeat(40)]) {
      expect(PUBLIC_NAME.test(good), good).toBe(true);
    }
    // Review Focus 4: nothing here is lowercased or rewritten into a name that would pass.
    for (const bad of ["ab", "x".repeat(41), "Bellman-Dev", "bellman_dev", "-dev", "dev-", "bel--dev", "bellman dev", "dév", "qs_3f0c", ""]) {
      expect(PUBLIC_NAME.test(bad), bad).toBe(false);
    }
  });

  it("refuses a name outside it in the rule's words", () => {
    expect(publicNameRefusal("Bellman-Dev")).toBe(
      'public name "Bellman-Dev": use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit',
    );
    expect(publicNameRefusal("bellman-dev")).toBeNull();
  });
});

describe("holding a name (D5)", () => {
  const room = (over: Parameters<typeof session>[0] = {}) =>
    session({ manifest: roomManifest({ public: true }), publicName: "bellman-dev", ...over });

  it("is the room whose record names it, while public and open", () => {
    expect(holdsName(room(), "bellman-dev")).toBe(true);
    expect(heldName(room())).toBe("bellman-dev");
  });

  it("ends with a rename, a close or being made private, and a room that is not there holds nothing", () => {
    expect(holdsName(room({ publicName: "other-name" }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ closed: true, closedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ unpublishedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ manifest: roomManifest({ public: false }) }), "bellman-dev")).toBe(false);
    expect(holdsName(undefined, "bellman-dev")).toBe(false);
    expect(heldName(room({ closed: true, closedAt: 1 }))).toBeNull();
    expect(heldName(room({ publicName: null }))).toBeNull();
  });

  it("reads null on a room stored before names", () => {
    const old = structuredClone(session()) as unknown as { publicName?: string | null };
    delete old.publicName;
    expect(hydrateStoredSession(old)!.publicName).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/public-names.test.ts`
Expected: FAIL, the module `../src/public-names.js` cannot be resolved.

- [ ] **Step 3: Write the module and the field**

Create `src/public-names.ts`:

```ts
/**
 * Public names (public names spec): the rule a name keeps (D2) and whether a room holds one (D5).
 * Runtime-free, like projections.ts, so the routes, the tools and both test programs import it.
 */
import { isPublic } from "./store.js";
import type { StoredSession } from "./stored-session.js";

/** D2. No `_`, so a name can never be read as a session id, which always has one. */
export const PUBLIC_NAME = /^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The refusal for a name outside D2's rule, in its words, or null. Never rewritten: the name checked is the name set. */
export function publicNameRefusal(name: string): string | null {
  return PUBLIC_NAME.test(name)
    ? null
    : `public name ${JSON.stringify(name)}: use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit`;
}

type Holder = Pick<StoredSession, "publicName" | "manifest" | "unpublishedAt" | "closed">;

/** Whether `session` holds `name` (D5): its record names it, and it is public and open. The index is only a hint. */
export const holdsName = (session: Holder | undefined, name: string): boolean =>
  session !== undefined && session.publicName === name && isPublic(session) && !session.closed;

/** The name `session` holds, or null: one its record still names after a close or unpublish holds nothing. */
export const heldName = (session: Holder): string | null =>
  session.publicName !== null && holdsName(session, session.publicName) ? session.publicName : null;
```

In `src/types.ts`, in `Session`, directly after `unpublishedAt: number | null;`:

```ts
  /**
   * The public name this room's record gives it (public names spec, D5), or null. It holds the
   * name only while public and open (`holdsName`). Read as null for a row written before it.
   */
  publicName: string | null;
```

In `src/stored-session.ts`, `hydrateStoredSession`, directly after the `unpublishedAt:` line:

```ts
    publicName: (row as { publicName?: string | null }).publicName ?? null,
```

and in the doc comment's list of defaults, after the **unpublishedAt** entry:

```ts
 * - **publicName** (public names) defaults to `null`: a room written before it was never named.
```

In `src/tools/start.ts`, in the `NewSession` literal, directly after `unpublishedAt: null,`:

```ts
        // Set below from public_name (public names spec, D4); null until then.
        publicName: null,
```

In `tests/helpers/fixtures.ts`, `session`, directly after `unpublishedAt: null,`:

```ts
    publicName: null,
```

Every other object literal that builds a whole `Session` or `NewSession` (the predicate: it sets `unpublishedAt:` as a field) needs `publicName` too; the typecheck below names any.

- [ ] **Step 4: Run the tests and both typechecks**

Run: `npx vitest run tests/public-names.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: 5 tests PASS; both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add src/public-names.ts src/types.ts src/stored-session.ts src/tools/start.ts tests/helpers/fixtures.ts tests/public-names.test.ts
git commit -m "A room's record can name it publicly, and a name keeps one rule: what a room holds is its record's name while it is public and open"
```

---

### Task 2: The index, in both stores

**Files:**
- Modify: `src/store.ts` (`BellmanStore`, after `unpublishSession`; `MemoryStore`)
- Modify: `src/store-do.ts` (`RegistryDO`, after `dropJoinCode`; `SessionDO`, after `unpublishSession`; `DurableObjectStore`, after `unpublishSession`)
- Modify: `src/public-names.ts` (adds `roomNamed`, `claimName`)
- Test: `tests/helpers/store-contract.ts` (a new `describe`, after the public rooms case "makes a room private once…"), `tests/public-names.test.ts`

**Interfaces:**
- Consumes: Task 1's `holdsName`, `Session.publicName`.
- Produces: `BellmanStore.publicNameEntry(name: string): Promise<string | null>`, `BellmanStore.claimPublicName(name: string, sessionId: string, expected: string | null): Promise<boolean>`, `BellmanStore.setPublicName(sessionId: string, name: string): Promise<void>`; `roomNamed(store: BellmanStore, name: string): Promise<StoredSession | undefined>` and `claimName(store: BellmanStore, name: string, sessionId: string): Promise<boolean>` from `src/public-names.ts`.

- [ ] **Step 1: Write the failing contract cases**

In `tests/helpers/store-contract.ts`, directly after the case `it("makes a room private once, open or closed: …")`:

```ts
    describe("the public name index (public names spec, D5)", () => {
      it("holds no entry for a name never claimed", async () => {
        expect(await store.publicNameEntry("bellman-dev")).toBeNull();
      });

      it("claims a name only while its entry is still what the claimer read", async () => {
        expect(await store.claimPublicName("bellman-dev", "qs_a", null)).toBe(true);
        expect(await store.publicNameEntry("bellman-dev")).toBe("qs_a");
        expect(await store.claimPublicName("bellman-dev", "qs_b", null)).toBe(false);
        expect(await store.claimPublicName("bellman-dev", "qs_b", "qs_a")).toBe(true);
        expect(await store.publicNameEntry("bellman-dev")).toBe("qs_b");
      });

      it("lets exactly one of two claims on one name win", async () => {
        const won = await Promise.all([
          store.claimPublicName("race", "qs_a", null),
          store.claimPublicName("race", "qs_b", null),
        ]);
        expect(won.filter(Boolean)).toHaveLength(1);
        expect(await store.publicNameEntry("race")).toBe(won[0] ? "qs_a" : "qs_b");
      });

      it("writes the name on the room's record, keeps one a room is created with, and leaves a room that is not there not there", async () => {
        const s = session({ id: "qs_named", manifest: roomManifest({ public: true }) });
        await store.createSession(s);
        expect((await store.getSession(s.id))?.publicName).toBeNull();
        await store.setPublicName(s.id, "bellman-dev");
        expect((await store.getSession(s.id))?.publicName).toBe("bellman-dev");
        const born = session({ id: "qs_born_named", manifest: roomManifest({ public: true }), publicName: "born-named" });
        await store.createSession(born);
        expect((await store.getSession(born.id))?.publicName).toBe("born-named");
        await store.setPublicName("qs_nope", "bellman-dev");
        expect(await store.getSession("qs_nope")).toBeUndefined();
      });
    });
```

Append to `tests/public-names.test.ts` (and add `MemoryStore` from `../src/store.js` and `claimName, roomNamed` from `../src/public-names.js` to its imports):

```ts
describe("claiming a name through the index (D5)", () => {
  const named = (id: string, name: string) => session({ id, manifest: roomManifest({ public: true }), publicName: name });

  it("finds the room that holds a name, and nothing once it holds another", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    await store.claimPublicName("bellman-dev", "qs_a", null);
    expect((await roomNamed(store, "bellman-dev"))?.id).toBe("qs_a");
    await store.setPublicName("qs_a", "renamed");
    expect(await roomNamed(store, "bellman-dev")).toBeUndefined();
  });

  it("takes a free name, refuses a held one, and takes over one its room no longer holds", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    expect(await claimName(store, "bellman-dev", "qs_a")).toBe(true);
    expect(await claimName(store, "bellman-dev", "qs_b")).toBe(false);
    await store.unpublishSession("qs_a", Date.now());
    expect(await claimName(store, "bellman-dev", "qs_b")).toBe(true);
    expect(await store.publicNameEntry("bellman-dev")).toBe("qs_b");
  });

  it("answers yes to the room the entry already points at, and frees a name whose room was never created", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    await store.claimPublicName("bellman-dev", "qs_a", null);
    expect(await claimName(store, "bellman-dev", "qs_a")).toBe(true);
    await store.claimPublicName("orphan", "qs_never", null);
    expect(await roomNamed(store, "orphan")).toBeUndefined();
    expect(await claimName(store, "orphan", "qs_b")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/store.test.ts tests/public-names.test.ts`
Expected: FAIL, `store.publicNameEntry is not a function` (and `claimName`/`roomNamed` are not exported).

- [ ] **Step 3: Write the methods**

In `src/store.ts`, `BellmanStore`, directly after `unpublishSession(sessionId: string, at: number): Promise<void>;`:

```ts
  /**
   * The session id the public name index holds for `name`, or null (public names spec, D5). A hint:
   * whoever reads it checks the room's record (`holdsName`), which is the truth.
   */
  publicNameEntry(name: string): Promise<string | null>;
  /**
   * Point `name` at `sessionId` if the index still holds `expected` for it (null for no entry), in
   * one step, so of two claims that read the same entry exactly one wins. True when this one did.
   */
  claimPublicName(name: string, sessionId: string, expected: string | null): Promise<boolean>;
  /** Write `name` on the room's record, which is what holds a name (D5). A room that is not there stays not there. */
  setPublicName(sessionId: string, name: string): Promise<void>;
```

In `MemoryStore`, beside the other maps:

```ts
  private byPublicName = new Map<string, string>(); // public name -> session id, a hint (public names spec, D5)
```

and directly after its `unpublishSession`:

```ts
  async publicNameEntry(name: string): Promise<string | null> {
    return this.byPublicName.get(name) ?? null;
  }

  async claimPublicName(name: string, sessionId: string, expected: string | null): Promise<boolean> {
    if ((this.byPublicName.get(name) ?? null) !== expected) return false;
    this.byPublicName.set(name, sessionId);
    return true;
  }

  async setPublicName(sessionId: string, name: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.publicName = name;
  }
```

In `src/store-do.ts`, `RegistryDO`, directly after `dropJoinCode`:

```ts
  async lookupPublicName(name: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`pn:${name}`);
  }

  /** `BellmanStore.claimPublicName`, in one transaction (public names spec, D5). */
  async claimPublicName(name: string, sessionId: string, expected: string | null): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (((await txn.get<string>(`pn:${name}`)) ?? null) !== expected) return false;
      await txn.put(`pn:${name}`, sessionId);
      return true;
    });
  }
```

In `SessionDO`, directly after `unpublishSession`:

```ts
  /** `BellmanStore.setPublicName`, for this room (public names spec, D5). An empty object is left empty. */
  async setPublicName(name: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return;
      await putRows(txn, memberRows(s, { ...s, publicName: name }));
    });
  }
```

In `DurableObjectStore`, directly after its `unpublishSession`:

```ts
  async publicNameEntry(name: string): Promise<string | null> {
    return (await this.registry.lookupPublicName(name)) ?? null;
  }

  async claimPublicName(name: string, sessionId: string, expected: string | null): Promise<boolean> {
    return this.registry.claimPublicName(name, sessionId, expected);
  }

  async setPublicName(sessionId: string, name: string): Promise<void> {
    await this.session(sessionId).setPublicName(name);
  }
```

Append to `src/public-names.ts` (and add `import type { BellmanStore } from "./store.js";`):

```ts
/** The room that holds `name`, if one does (D5, D6): the index's entry, checked against that room's record. */
export async function roomNamed(store: BellmanStore, name: string): Promise<StoredSession | undefined> {
  const id = await store.publicNameEntry(name);
  if (id === null) return undefined;
  const session = await store.getSession(id);
  return holdsName(session, name) ? session : undefined;
}

/**
 * Point the index's `name` at `sessionId` unless another room holds it (D5). True when the entry
 * is this room's afterwards. An entry no room holds is taken over only if it is still what was read,
 * so of two claims one wins. The caller writes the room's record after: until it does, the entry
 * names a room that does not hold the name, which is free.
 */
export async function claimName(store: BellmanStore, name: string, sessionId: string): Promise<boolean> {
  const id = await store.publicNameEntry(name);
  if (id === sessionId) return true;
  if (id !== null && holdsName(await store.getSession(id), name)) return false;
  return store.claimPublicName(name, sessionId, id);
}
```

- [ ] **Step 4: Run the tests, both typechecks and the Worker contract**

Run: `npx vitest run tests/store.test.ts tests/public-names.test.ts && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS, the contract's four new cases on `MemoryStore` and on `DurableObjectStore` (worker-tests/store-contract.test.ts) alike.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store-do.ts src/public-names.ts tests/helpers/store-contract.ts tests/public-names.test.ts
git commit -m "The registry indexes public names as a hint: a claim wins only if the entry is unchanged, and a room's record is what holds its name"
```

---

### Task 3: bellman_start's public_name, the room's link and its preview

**Files:**
- Modify: `src/codes.ts` (`publicRoomUrl`)
- Modify: `src/tools/start.ts` (description, `inputSchema`, handler, the `NewSession` literal, the return)
- Modify: `src/tools/connect.ts` (the `Returns:` line's room block)
- Modify: `src/projections.ts` (`roomPreview`)
- Test: `tests/public-names.test.ts`, `tests/tools/surface.test.ts`

**Interfaces:**
- Consumes: Task 1's `publicNameRefusal`, `heldName`; Task 2's `claimName`, `roomNamed`.
- Produces: `publicRoomUrl(s: Pick<StoredSession, "id" | "publicName" | "manifest" | "unpublishedAt" | "closed">): string`; `roomPreview(...)` gains `public_name: string | null`; `bellman_start` accepts `public_name`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/public-names.test.ts` (imports: `afterEach, beforeEach` from vitest, `Harness, DEV_KEY` and `type Peer` from `./helpers/harness.js`, `brief` from `./helpers/fixtures.js`, `roomPreview` from `../src/projections.js`):

```ts
describe("bellman_start's public_name (D4)", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });
  const OPEN = { room: "Dev", preset: "pair", public: true };

  it("gives a public room the name, its link and its preview's public_name", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_start", { manifest: OPEN, public_name: "bellman-dev", brief: brief() });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.public_url).toBe("https://dash.bellman.sh/r/bellman-dev");
    expect((out.data.room as { public_name: string | null }).public_name).toBe("bellman-dev");
    expect((await roomNamed(h.store, "bellman-dev"))?.id).toBe(out.data.session_id);
  });

  it("keeps the session id's link for a public room with no name", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_start", { manifest: OPEN, brief: brief() });
    expect(out.data.public_url).toBe(`https://dash.bellman.sh/r/${String(out.data.session_id)}`);
    expect((out.data.room as { public_name: string | null }).public_name).toBeNull();
  });

  it("refuses a taken name before anything is created or counted", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_start", { manifest: OPEN, public_name: "bellman-dev", brief: brief() });
    const used = await h.store.countCreatesThisMonth("u_jesse");
    const again = await jesse.call("bellman_start", { manifest: { ...OPEN, room: "Dev 2" }, public_name: "bellman-dev", brief: brief() });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('public name "bellman-dev" is taken: choose another, or start without one and set it later with bellman_public_name.');
    expect(await h.store.countCreatesThisMonth("u_jesse")).toBe(used);
    expect(await h.store.sessionsCreatedBy("u_jesse", 10)).toHaveLength(1);
  });

  it("refuses a name for a private room, and one outside the rule, creating nothing", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const shut = await jesse.call("bellman_start", { manifest: { room: "Dev", preset: "pair" }, public_name: "bellman-dev", brief: brief() });
    expect(shut.text).toContain("public_name needs a public room: add public: true, or leave public_name out.");
    const bad = await jesse.call("bellman_start", { manifest: OPEN, public_name: "Bellman_Dev", brief: brief() });
    expect(bad.text).toContain('public name "Bellman_Dev": use 3 to 40 lowercase letters');
    expect(await h.store.sessionsCreatedBy("u_jesse", 10)).toHaveLength(0);
  });

  // Review Focus 1: the claim comes before the hosted slot, so refusing it holds no slot.
  it("refuses a taken name for a hosted room without keeping one of its creator's hosted slots", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_start", { manifest: OPEN, public_name: "social-hour", brief: brief() });
    const hosted = await jesse.call("bellman_start", { manifest: { room: "Social", preset: "social", public: true }, public_name: "social-hour", brief: brief() });
    expect(hosted.text).toContain('public name "social-hour" is taken');
    expect((await h.store.reserveHostedRoom("u_jesse", "qs_probe", 1)).ok).toBe(true);
  });

  it("shows no public_name in the preview of a room that no longer holds its name", () => {
    const closed = session({ manifest: roomManifest({ public: true }), publicName: "bellman-dev", closed: true, closedAt: 1 });
    expect(roomPreview(closed, null).public_name).toBeNull();
  });
});
```

In `tests/tools/surface.test.ts`, in the test "documents bellman_start's rejections…", directly before `const rejections`:

```ts
    await jesse.call("bellman_start", { brief: brief(), manifest: manifestFixture({ public: true }), public_name: "taken-name" });
```

and in `rejections`, after the `"a public room requires"` row:

```ts
      ["public_name needs a public room", jesse, { manifest: manifestFixture(), public_name: "bellman-dev" }],
      ["use 3 to 40 lowercase letters", jesse, { manifest: manifestFixture({ public: true }), public_name: "Bad_Name" }],
      ["is taken: choose another", jesse, { manifest: manifestFixture({ public: true }), public_name: "taken-name" }],
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/public-names.test.ts tests/tools/surface.test.ts`
Expected: FAIL. `public_name` is stripped by the schema, so the first start's `public_url` is the session id's link, every refusal case starts a room, and the surface rows find no refusal.

- [ ] **Step 3: Write the link, the argument and the preview field**

In `src/codes.ts`, replace `publicRoomUrl` (add `import { heldName } from "./public-names.js";` and `import type { StoredSession } from "./stored-session.js";`):

```ts
/** A public room's page (public names spec, D7): its name's link while it holds one, its session id's otherwise. */
export function publicRoomUrl(s: Pick<StoredSession, "id" | "publicName" | "manifest" | "unpublishedAt" | "closed">): string {
  return `${PUBLIC_ROOM_URL_BASE}${heldName(s) ?? s.id}`;
}
```

In `src/projections.ts`, `roomPreview`, directly after the `public: isPublic(session),` line (add `heldName` from `./public-names.js` to the imports):

```ts
    // The name in the room's link while it holds one (public names spec, D7). Chosen by the creator
    // but held to a grammar the server checked, like a role key, so it is spine beside `public`.
    public_name: heldName(session),
```

In `src/tools/start.ts`:

1. Imports: add `claimName, publicNameRefusal` from `../public-names.js`.
2. Description, the `Args:` list, directly after the `org_only` line:

```
  - public_name: the name in a public room's link, dash.bellman.sh/r/<public_name>: 3 to 40 lowercase letters, digits and single hyphens. It needs public: true. Names are first come, first served: a taken name is refused and nothing is created. Check one first, or set one later, with bellman_public_name.
```

3. Description, the `Returns:` line: `public_url (a public room only)` becomes `public_url (a public room only: its name's link when it has one)`, and the room block's `mode, public, your_role` becomes `mode, public, public_name, your_role`.
4. Description, the `Errors:` line: directly after `"a public room requires..." (plan),` add:

```
"public_name needs a public room" (add public: true), "public name "...": use 3 to 40 lowercase letters..." (the rule), "public name "..." is taken: choose another..." (first come, first served; nothing is created or counted),
```

5. `inputSchema`, after `org_only`:

```ts
        public_name: z.string().max(200).optional(),
```

6. The handler's parameters: `async ({ manifest: manifestInput, brief, capabilities, org_only, public_name })`.
7. Directly after the `a public room requires…` refusal:

```ts
      // The room's own, so an argument beside the manifest and never in it: a saved preset is
      // started many times, and a name is held by one room (public names spec, D4).
      if (public_name !== undefined) {
        const bad = publicNameRefusal(public_name);
        if (bad) return fail(`${bad}.`);
        if (!manifest.public) return fail("public_name needs a public room: add public: true, or leave public_name out.");
      }
```

8. Replace the comment above `const sessionId = generateSessionId();` and add the claim before the hosted slot:

```ts
      // The refusals that write come last. A name first: refused, it holds nothing, and claimed for a
      // room that is then not created, it names a room that does not hold it, which is free (public
      // names spec, D5). Then a hosted room's slot, counted and recorded in one call (I7), and given
      // back if the room is not created after all.
      const sessionId = generateSessionId();
      if (public_name !== undefined && !(await claimName(s, public_name, sessionId))) {
        return fail(`public name "${public_name}" is taken: choose another, or start without one and set it later with bellman_public_name.`);
      }
```

9. In the `NewSession` literal, Task 1's `publicName: null,` and its comment become:

```ts
        // The name claimed above, if any (public names spec, D4): the record is what holds it.
        publicName: public_name ?? null,
```

10. In the return, `publicRoomUrl(session.id)` becomes `publicRoomUrl(room)`.

In `src/tools/connect.ts`, the `Returns:` line's room block: `mode, public, your_role` becomes `mode, public, public_name, your_role`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/public-names.test.ts tests/tools/surface.test.ts tests/public-rooms.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codes.ts src/projections.ts src/tools/start.ts src/tools/connect.ts tests/public-names.test.ts tests/tools/surface.test.ts
git commit -m "bellman_start takes public_name beside the manifest: a free name is the room's link, a taken one is refused before anything is created or counted"
```

---

### Task 4: The bellman_public_name tool

**Files:**
- Create: `src/tools/public-name.ts`
- Modify: `src/rooms.ts` (adds `namePublicRoom`)
- Modify: `src/server.ts` (registers it after `registerAudit`)
- Modify: `extension/manifest.json` (appends the tool after `bellman_audit`)
- Modify: `tests/tools/surface.test.ts` (`EXPECTED_TOOLS`)
- Test: `tests/public-names.test.ts`

**Interfaces:**
- Consumes: Task 1's `publicNameRefusal`; Task 2's `claimName`, `roomNamed`, `BellmanStore.setPublicName`; Task 3's `publicRoomUrl(session)`; `handlesOf`, `refuse`, `succeed`, `isPublic` from `src/rooms.ts`; `RoomRefShape`, `roomIdOf`, `ok`, `fail` from `src/tools/kit.ts`.
- Produces: `namePublicRoom(store: BellmanStore, identity: Pick<Identity, "userId">, sessionId: string, name: string): Promise<RoomResult<{ name: string; publicUrl: string }>>`; the tool `bellman_public_name`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/public-names.test.ts` (import `pairUp` from `./helpers/flows.js`):

```ts
describe("bellman_public_name (D3)", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });
  const OPEN = { room: "Dev", preset: "pair", public: true };
  const start = async (peer: Peer, over: Record<string, unknown> = {}) => {
    const out = await peer.call("bellman_start", { manifest: OPEN, brief: brief(), ...over });
    expect(out.isError, out.text).toBe(false);
    return { room: String(out.data.session_id), member: String(out.data.member_id) };
  };

  it("checks a name without a room, and says a held one is not free", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev" })).data).toEqual({ name: "bellman-dev", free: true });
    await start(jesse, { public_name: "bellman-dev" });
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev" })).data).toEqual({ name: "bellman-dev", free: false });
  });

  it("refuses a name outside the rule", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_public_name", { name: "Bellman-Dev" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('public name "Bellman-Dev": use 3 to 40 lowercase letters');
  });

  it("sets a name for the room's creator, frees the one it held at once, and takes it back by room_id", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { room } = await start(jesse, { public_name: "first-name" });
    const set = await jesse.call("bellman_public_name", { name: "second-name", session_id: room });
    expect(set.data).toEqual({ name: "second-name", public_url: "https://dash.bellman.sh/r/second-name" });
    expect((await jesse.call("bellman_public_name", { name: "first-name" })).data.free).toBe(true);
    // Review Focus 2: back to the first name, whose entry still points at the room.
    expect((await jesse.call("bellman_public_name", { name: "first-name", room_id: room })).isError).toBe(false);
    expect((await roomNamed(h.store, "first-name"))?.id).toBe(room);
    expect((await jesse.call("bellman_public_name", { name: "second-name" })).data.free).toBe(true);
  });

  it("returns the name a room already holds unchanged, and refuses one another room holds", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { room } = await start(jesse, { public_name: "bellman-dev" });
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev", session_id: room })).data)
      .toEqual({ name: "bellman-dev", public_url: "https://dash.bellman.sh/r/bellman-dev" });
    const other = await start(jesse);
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev", session_id: other.room })).text)
      .toContain('public name "bellman-dev" is taken: choose another');
  });

  it("names a room only for its creator, and only a public one", async () => {
    const p = await pairUp(h, { manifest: OPEN });
    expect((await p.joiner.call("bellman_public_name", { name: "bellman-dev", session_id: p.sessionId })).text)
      .toContain("only the room's creator may name it");
    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_public_name", { name: "bellman-dev", session_id: p.sessionId })).text)
      .toContain("no such room, or no member of yours in it");
    const shut = await start(p.creator, { manifest: { room: "Shut", preset: "pair" } });
    expect((await p.creator.call("bellman_public_name", { name: "bellman-dev", session_id: shut.room })).text)
      .toContain("only a public room has a public name");
  });

  // Review Focus 3: closed, the name is free at once, and the room cannot be named again.
  it("frees a room's name once it closes or is made private, and refuses to name a closed room", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const closing = await start(jesse, { public_name: "closing-room" });
    await jesse.call("bellman_leave", { session_id: closing.room, member_id: closing.member });
    expect((await jesse.call("bellman_public_name", { name: "closing-room" })).data.free).toBe(true);
    expect((await jesse.call("bellman_public_name", { name: "closing-room", session_id: closing.room })).text)
      .toContain("the room is closed");
    const unpublished = await start(jesse, { public_name: "private-soon" });
    await h.store.unpublishSession(unpublished.room, Date.now());
    expect((await jesse.call("bellman_public_name", { name: "private-soon" })).data.free).toBe(true);
  });
});
```

In `tests/tools/surface.test.ts`, add `"bellman_public_name",` to `EXPECTED_TOOLS`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/public-names.test.ts tests/tools/surface.test.ts`
Expected: FAIL, `bellman_public_name` is not a tool (`Tool bellman_public_name not found`), and the tool list lacks it.

- [ ] **Step 3: Write the operation, the tool and its registrations**

In `src/rooms.ts` (imports: `claimName` from `./public-names.js`, `publicRoomUrl` from `./codes.js` if not already imported), after `handlesOf`:

```ts
/**
 * `bellman_public_name`'s write (public names spec, D3): the room's creator names their public,
 * open room. The index first, then the record: a claim whose record write fails names a room that
 * does not hold it, which is free (D5). The name the room held before is free once the record
 * names another.
 */
export async function namePublicRoom(
  store: BellmanStore, identity: Pick<Identity, "userId">, sessionId: string, name: string,
): Promise<RoomResult<{ name: string; publicUrl: string }>> {
  const session = await store.getSession(sessionId);
  if (!session || (await handlesOf(store, session, identity)).length === 0) {
    return refuse("not_found", "no such room, or no member of yours in it");
  }
  if (session.createdBy !== identity.userId) return refuse("forbidden", "only the room's creator may name it");
  if (session.closed) return refuse("closed", "the room is closed, and a closed room holds no name");
  if (!isPublic(session)) return refuse("invalid", "only a public room has a public name");
  if (!(await claimName(store, name, session.id))) {
    return refuse("conflict", `public name "${name}" is taken: choose another`);
  }
  if (session.publicName !== name) await store.setPublicName(session.id, name);
  return succeed({ name, publicUrl: publicRoomUrl({ ...session, publicName: name }) });
}
```

Create `src/tools/public-name.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RoomRefShape, fail, ok, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { publicNameRefusal, roomNamed } from "../public-names.js";
import { namePublicRoom } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerPublicName(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_public_name",
    {
      title: "Check or set a public room's name",
      description: `A public room's page is dash.bellman.sh/r/<name> once it has a name, and dash.bellman.sh/r/<session_id> until then. Names are first come, first served, and free again when their room closes or is made private.

Args:
  - name: 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.
  - session_id (or room_id): your public room. Without it the name is only checked. With it the name is set: you must be the room's creator, the room must be public and open, and the name it held before is free at once.

Returns: { name, free } when checking; { name, public_url } when setting.
Errors: "public name "...": use 3 to 40 lowercase letters..." (the rule), "public name "..." is taken" (choose another), "no such room, or no member of yours in it", "only the room's creator may name it", "only a public room has a public name", "the room is closed".`,
      inputSchema: { name: z.string().max(200), ...RoomRefShape },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const bad = publicNameRefusal(args.name);
      if (bad) return fail(`${bad}.`);
      const room = roomIdOf(args);
      if (room === undefined) return ok({ name: args.name, free: (await roomNamed(s, args.name)) === undefined });
      const r = await namePublicRoom(s, identity, room, args.name);
      return r.ok ? ok({ name: r.value.name, public_url: r.value.publicUrl }) : fail(r.reason);
    },
  );
}
```

In `src/server.ts`: import `registerPublicName` from `./tools/public-name.js` beside the other tool imports, and call `registerPublicName(server, identity, s);` directly after `registerAudit(server, identity, s);`.

In `extension/manifest.json`, in `tools`, directly after the `bellman_audit` entry:

```json
    { "name": "bellman_public_name", "description": "Check or set the name in a public room's link." }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/public-names.test.ts tests/tools/surface.test.ts tests/extension.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rooms.ts src/tools/public-name.ts src/server.ts extension/manifest.json tests/public-names.test.ts tests/tools/surface.test.ts
git commit -m "bellman_public_name checks a name, or sets it for the room's creator on a public, open room, freeing the one it held"
```

---

### Task 5: The public route reads a room by its name

**Files:**
- Modify: `src/http/public.ts` (`publicRoutes`)
- Test: `tests/http-public.test.ts`, `worker-tests/public-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's `PUBLIC_NAME`; Task 2's `roomNamed`, `claimPublicName`, `setPublicName`.
- Produces: `GET /public/rooms/:key` (and `/surface`, `/events`, `/blobs/:blobId`) takes a name or a session id.

- [ ] **Step 1: Write the failing tests**

In `tests/http-public.test.ts` (add `vi` to the vitest import), append:

```ts
describe("a public room read by its name (public names spec, D6)", () => {
  const name = async (id: string, n: string) => {
    await store.claimPublicName(n, id, null);
    await store.setPublicName(id, n);
  };

  it("reads the room, its surface and its log by its name as by its session id", async () => {
    await name(PUB, "open-review");
    for (const part of ["", "/surface", "/events"]) {
      const byName = await read(`/public/rooms/open-review${part}`);
      expect(byName.status, part).toBe(200);
      expect(await byName.json(), part).toEqual(await (await read(`/public/rooms/${PUB}${part}`)).json());
    }
  });

  // Review Focus 3: a closed room's name is free, and the room is still readable by its id.
  it("answers a name its room no longer holds as no public room, and keeps a closed room readable by its id", async () => {
    await store.createSession(session({
      id: "qs_closed_pub", manifest: roomManifest({ public: true }), members: [member()], closed: true, closedAt: Date.now(), joinCodes: {},
    }));
    await name("qs_closed_pub", "closed-room");
    expect((await read("/public/rooms/closed-room")).status).toBe(404);
    expect((await read("/public/rooms/qs_closed_pub")).status).toBe(200);
    await name(PUB, "open-review");
    await store.unpublishSession(PUB, Date.now());
    const gone = await read("/public/rooms/open-review");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(NOT_PUBLIC);
  });

  // Review Focus 5: a name nobody holds is answered from the index alone.
  it("answers a name nobody claimed without reading any room", async () => {
    const reads = vi.spyOn(store, "getSession");
    expect((await read("/public/rooms/never-claimed")).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });
});
```

In `worker-tests/public-routes.test.ts`, inside `describe("public rooms through the Worker", …)`:

```ts
  it("reads a public room by its name through the registry's index", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member()], publicName: "worker-room" }));
    expect(await store.claimPublicName("worker-room", ROOM, null)).toBe(true);
    const byName = await call("/public/rooms/worker-room");
    expect(byName.status, await byName.clone().text()).toBe(200);
    expect((await call("/public/rooms/no-such-name")).status).toBe(404);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/http-public.test.ts`
Expected: FAIL, `/public/rooms/open-review` answers 404 (read as a session id), and `getSession` is called for `never-claimed`.

- [ ] **Step 3: Resolve the key**

In `src/http/public.ts` (import `PUBLIC_NAME, roomNamed` from `../public-names.js`), replace:

```ts
    const [, id, part, blobId] = m;
    const session = await deps.store.getSession(id);
    if (!session || !isPublic(session)) return notFound("no such public room");
```

with:

```ts
    const [, key, part, blobId] = m;
    // A public name or a session id (public names spec, D6): a name has no `_`, and an id always has one.
    // A name goes through the index and its room's record, so one nobody holds reads no room at all.
    const session = PUBLIC_NAME.test(key) ? await roomNamed(deps.store, key) : await deps.store.getSession(key);
    if (!session || !isPublic(session)) return notFound("no such public room");
    const id = session.id;
```

Every later use of `id` in the handler is now the room's session id, whichever key was given.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/http-public.test.ts && npm run test:worker`
Expected: PASS, the Worker case included.

- [ ] **Step 5: Commit**

```bash
git add src/http/public.ts tests/http-public.test.ts worker-tests/public-routes.test.ts
git commit -m "A public room is read by its name as by its id, and a name nobody holds reads no room"
```

---

### Task 6: Docs, the listing's cost, and the bellman PR

**Files:**
- Modify: `README.md` (the public rooms bullet under "What a plan gates")
- Modify: `docs/ARCHITECTURE.md` (the public room paragraph that begins "**A public room** is the one read with no caller"; §11's table row "Tool definitions" and a new paragraph at the top of its notes)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the docs, the measured figure, and a draft PR.

- [ ] **Step 1: Measure the listing on main and on the branch**

Write a scratch script (outside the repository), `list-tools.mts`:

```ts
const root = process.argv[2];
const { Harness, DEV_KEY } = await import(`${root}/tests/helpers/harness.ts`);
const h = new Harness();
const peer = await h.connect(DEV_KEY.jesse);
const { tools } = await peer.client.listTools();
process.stdout.write(JSON.stringify(tools));
await h.close();
```

and `count-tools.py`:

```python
import json, sys, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
counts = {t["name"]: len(enc.encode(json.dumps(t, separators=(",", ":")))) for t in json.load(open(sys.argv[1]))}
print(json.dumps({**{k: counts[k] for k in ("bellman_start", "bellman_connect", "bellman_public_name") if k in counts}, "total": sum(counts.values())}))
```

Run each against a checkout of `origin/main` (a temporary worktree with `node_modules` symlinked and `npm run build:ui` run) and against the branch: `npx tsx list-tools.mts <root> > tools.json && python3 count-tools.py tools.json`.
Expected: main reads 8,102 (the figure §11 records); the branch is 250–300 over (D8). If not, ledger a ruling with the real figure.

- [ ] **Step 2: Write the docs**

In `README.md`, the bullet that begins "A room started with `public: true` in its manifest", append:

```
A public room can have a name: `public_name` on `bellman_start`, or `bellman_public_name` later, makes its link `dash.bellman.sh/r/<name>`. Names are 3 to 40 lowercase letters, digits and hyphens, first come, first served, and free again when the room closes or is made private, after which an old link can open another room; its `qs_` link keeps working.
```

In `docs/ARCHITECTURE.md`, at the end of the paragraph that begins "**A public room** is the one read with no caller":

```
A public room may also be read by its name (public names spec): the session's `publicName`, set by `bellman_start`'s `public_name` or `bellman_public_name`, and indexed in the registry under `pn:<name>`. The index is a hint, claimed by compare-and-set and checked against the room's record (`holdsName`) wherever it is read, so a name is held only while its room is public and open and nothing runs at close, unpublish or rename.
```

In §11, set the table's "Tool definitions" figure to the branch's total, and add a paragraph above the newest "Re-measured on …" paragraph:

```
Re-measured on <date> for public names, by the method below: <N> tokens over the 8,102 that main (`<sha>`) measures. `bellman_public_name` is new, at <n>; `bellman_start` is up <n>, to <n>, for `public_name` in its Args, Returns and Errors; `bellman_connect` is up <n>, to <n>, for `public_name` in the room block. That is <total>.
```

with every `<…>` filled from Step 1's output before committing.

- [ ] **Step 3: Verify, dry-run the deploy, and commit**

Run: `npm run verify > verify.log 2>&1; echo $?` and read its tail; then `npx wrangler deploy --dry-run --outdir <scratch>`.
Expected: verify exit 0 with every test passing; the dry run prints "--dry-run: exiting now."

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "Say how a public room gets a name, and what the listing costs with bellman_public_name"
```

- [ ] **Step 4: Push and open the draft PR**

Stat the diff against the intended file list first (`git diff --stat origin/main..HEAD`): the spec, this plan, and the files Tasks 1–6 name, nothing else.

```bash
git push -u origin mcfearsome/public-names
gh pr create --draft --base main --head mcfearsome/public-names --title "Public names: a public room's link can be a name its creator chooses"
```

with a body listing D1–D8 in a line each, the measured cost, and the verify figures.

---

### Task 7: Dash copies the link by name

**Files (dash repo, a worktree under `~/.worktrees/` from dash `origin/main`, with its own `npm ci`):**
- Modify: `src/lib/api.ts` (the room preview type, beside `public?: boolean`)
- Modify: `src/components/canvas/public-controls.tsx` (`PublicControls`)
- Modify: `src/components/canvas/canvas.tsx` (where `PublicControls` is rendered)
- Test: `src/components/canvas/canvas.test.tsx` (`describe("a public room's header")`)

**Interfaces:**
- Consumes: the room preview's `public_name` (Task 3), served by `GET /rooms/:id`.
- Produces: the copy link `${origin}/r/<public_name>` when the room has a name.

- [ ] **Step 1: Write the failing test**

In `canvas.test.tsx`, inside `describe("a public room's header", …)`:

```tsx
  it("copies the link by the room's name when it has one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open(roomDetail({ mine: true, preview: { ...roomDetail().preview, public: true, public_name: "bellman-dev" } }));
    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/bellman-dev`);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/canvas/canvas.test.tsx`
Expected: FAIL, the link copied is `${origin}/r/qs_1` (and a type error on `public_name` under `npm run typecheck`).

- [ ] **Step 3: Carry the name to the button**

In `src/lib/api.ts`, in the room preview type, directly after `public?: boolean;`:

```ts
  /** The name in the room's link while it holds one (public names spec, D7); absent from a Worker that predates names. */
  public_name?: string | null;
```

In `public-controls.tsx`, the signature gains `name`, and the link uses it:

```tsx
export function PublicControls({ roomId, name, mine, onMakePrivate }: { roomId: string; name: string | null; mine: boolean; onMakePrivate: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  // The room's name when it holds one (public names spec, D7), its id otherwise; both open the same page.
  const link = `${window.location.origin}/r/${name ?? roomId}`;
```

In `canvas.tsx`, the `PublicControls` element gains `name={detail.preview.public_name ?? null}`.

- [ ] **Step 4: Run the dash checks**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit, push and open the dash PR**

```bash
git add src/lib/api.ts src/components/canvas/public-controls.tsx src/components/canvas/canvas.tsx src/components/canvas/canvas.test.tsx
git commit -m "The canvas header copies a public room's link by its name when it has one"
git push -u origin mcfearsome/public-names
gh pr create --draft --base main --head mcfearsome/public-names --title "Copy a public room's link by its name"
```

Merge order: the bellman PR first (CI deploys it), then this one (dash's CI deploys on merge).
