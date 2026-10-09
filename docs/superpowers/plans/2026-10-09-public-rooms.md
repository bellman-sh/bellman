# Public rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room started with `public: true` is readable by anyone with its link (its surface and its log, never a brief), joinable only with a code, and its creator can make it private for good.

**Architecture:** The manifest gains `public` and the session `unpublishedAt`; `isPublic` reads both. A new runtime-free module, `src/http/public.ts`, answers `GET /public/rooms/:id[/surface|/events|/blobs/:blobId]` with no credential and `*` CORS, through a projection that drops every brief. `POST /rooms/:id/unpublish` is the creator's. The preview's trusted spine says `public`, the MCP App says it at join, and dash gains `/r/<id>` outside sign-in plus the canvas header's controls and the designer's checkbox.

**Tech Stack:** TypeScript, zod 4, vitest (Node and workerd); the MCP App (`ui/`, plain DOM); dash: React 19, TanStack Router, React Flow, vitest with Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-09-public-rooms-design.md`

## Rulings against the spec

- **R1. `RoomManifest.public` is optional in the type** (`public?: boolean`) and read as false on every row by `withHeartbeatDefaults`. 23 manifest literals live in tests; readers test `=== true`, which fails closed. Cost if wrong: none at runtime, a reader that forgets reads private.
- **R2. `Session.unpublishedAt` is required** (`number | null`): only the fixture and `bellman_start` build a session. Read as null for older rows by `hydrateStoredSession`; `isPublic` uses `== null` for the in-memory store, which does not hydrate.
- **R3. `GET /rooms/:id` gains `mine`** (`createdBy` is the caller), on both the member and the admin envelope. D5 gives the creator "Make private" and names no field.
- **R4. The reduced `member_joined` is an allowlist:** three fields, each a string or null, so a payload of an older shape or a later one shows nothing else.
- **R5. Dash asks twice before "Make private"**: nothing makes a room public again. The spec is silent.
- **R6. `bellman_start`'s description names `public` too.** D5 names `bellman_connect`'s; an agent cannot set a key it is never told of.
- **R7. The public routes sit behind the Worker's fail-closed `unconfigured` guard**, like the room routes: a deploy that serves no room serves none in public.

## Global Constraints

- `public` is chosen when a room starts. The only change after is to private, by the creator, once (`unpublishedAt`); nothing makes a room public.
- The public routes read no credential, answer `access-control-allow-origin: *`, and never send `access-control-allow-credentials`.
- Every room a stranger may not read (private, unpublished, unknown, purged) answers 404 with exactly `{"error":"not_found","error_description":"no such public room"}`.
- Briefs never leave a public read: `brief_update` is left out, and `member_joined` is reduced to `{ member: { member_id, label, room_role } }`.
- The join notice reads exactly: "Anyone with this room's link can read its surface and its log."
- Peer and creator prose renders as text on every page, never markup.
- Bellman: `npm run verify` before every commit that touches `src/`. Dash: `npm test && npm run typecheck && npm run lint && npm run build`.
- Plain git, staged by name, signed (`git cat-file commit HEAD | grep -c '^gpgsig'` prints 1). Never edit `CLAUDE.md`.
- Bellman on `mcfearsome/public-rooms` (spec and plan committed). Dash in a new worktree on `mcfearsome/public-rooms` from `origin/main`, in the session scratchpad.

## Review Focus

1. An events page made only of `brief_update` events: the cursor still moves past it, or a public reader's poll re-reads it forever. Test in Task 3.
2. A `member_joined` payload of an older shape, or carrying fields added later: only `member_id`, `label` and `room_role` leave, each a string or null. Test in Task 3.
3. A blob uploaded and never placed, and one whose item was removed: the public download is a 404 for both. Test in Task 3.
4. A member's bearer sent to a public route: it changes nothing, and a private room is the same 404. Test in Task 3.
5. An `html` item on a canvas whose context is rebuilt on every poll: its blob is fetched once, not every four seconds. Test in Task 5.

---

### Task 1: The flag on the manifest, carried by presets

**Files:**
- Modify: `src/types.ts` (`RoomManifest.public`, `SavedPreset.public`)
- Modify: `src/manifest.ts` (`CiteShape`, `AuthorShape`, both arms of `resolveManifest`, `builtinPresets`)
- Modify: `src/presets.ts` (`asManifest`, `checkPreset`)
- Modify: `src/tools/start.ts` (the saved-preset cite)
- Modify: `src/stored-session.ts` (`withHeartbeatDefaults`)
- Test: `tests/public-rooms.test.ts` (new), `tests/tools/start-presets.test.ts`, `tests/presets.test.ts`, `tests/room-yaml-export.test.ts`

**Interfaces:**
- Produces: `RoomManifest.public?: boolean`, always a boolean after `resolveManifest` and `hydrateStoredSession`; `SavedPreset.public?: boolean`; `asManifest(p, room, purpose, heartbeatOn?, citedPublic?: boolean | null)`.

- [ ] **Step 0: The branch**

Run: `git checkout mcfearsome/public-rooms && git fetch -q origin && git log --oneline -1 origin/main && git merge-base --is-ancestor origin/main HEAD && echo up-to-date || git merge --no-edit origin/main`
Expected: `up-to-date`, or a clean merge of main (the branch holds only the spec and this plan). Then `git cat-file commit HEAD | grep -c '^gpgsig'` prints 1 for a merge commit.

- [ ] **Step 1: Write the failing tests**

Create `tests/public-rooms.test.ts`:

```ts
/**
 * Public rooms (public rooms spec): readable by anyone with the room's link, chosen
 * when the room starts. Tasks 1, 2 and 4 of the plan add to this file; the routes
 * are tests/http-public.test.ts.
 */
import { describe, expect, it } from "vitest";
import { builtinPresets, resolveManifest } from "../src/manifest.js";
import { asManifest, checkPreset } from "../src/presets.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import type { SavedPreset } from "../src/types.js";
import { session } from "./helpers/fixtures.js";

const roles = { a: { can: ["send"] }, b: { can: ["send"] } };
const authored = { room: "r", mode: "pair", roles, default_role: "b", creator_role: "a" };

describe("a manifest's public flag", () => {
  it("is taken on both arms", () => {
    expect(resolveManifest({ room: "r", preset: "pair", public: true }).public).toBe(true);
    expect(resolveManifest({ ...authored, public: true }).public).toBe(true);
  });

  it("is false unless given, and the built-ins are private", () => {
    expect(resolveManifest({ room: "r", preset: "pair" }).public).toBe(false);
    expect(resolveManifest(authored).public).toBe(false);
    expect(builtinPresets().map((p) => p.public)).toEqual([false, false, false, false]);
  });

  it("is refused when it is not a boolean", () => {
    expect(() => resolveManifest({ ...authored, public: "yes" })).toThrow(/public/);
  });

  it("reads false on a room stored before it", () => {
    const old = structuredClone(session()) as unknown as { manifest: Record<string, unknown> };
    delete old.manifest.public;
    expect(hydrateStoredSession(old)!.manifest.public).toBe(false);
  });
});

describe("a saved preset's public flag", () => {
  const saved = (pub?: boolean): SavedPreset => ({
    name: "open_review", description: null, mode: "pair", heartbeat_on: null,
    roles: { a: { can: ["send"], description: null, reports: false }, b: { can: ["send"], description: null, reports: false } },
    default_role: "b", creator_role: "a", updated_at: null,
    ...(pub === undefined ? {} : { public: pub }),
  });
  const body = { mode: "pair", roles, default_role: "b", creator_role: "a" };

  it("is saved, and false when the body leaves it out", () => {
    const open = checkPreset("open_review", { ...body, public: true }, 0);
    const shut = checkPreset("open_review", body, 0);
    expect([open.ok && open.preset.public, shut.ok && shut.preset.public]).toEqual([true, false]);
  });

  it("is the default for a room started from it, and the cite's own wins", () => {
    expect(resolveManifest(asManifest(saved(true), "r", null)).public).toBe(true);
    expect(resolveManifest(asManifest(saved(true), "r", null, undefined, false)).public).toBe(false);
    expect(resolveManifest(asManifest(saved(false), "r", null, undefined, true)).public).toBe(true);
    expect(resolveManifest(asManifest(saved(), "r", null)).public).toBe(false);
  });
});
```

In `tests/tools/start-presets.test.ts`, inside `describe("bellman_start citing a saved preset")`, add:

```ts
  it("starts a public room from a public preset, and a private one when the cite says so", async () => {
    await h.store.putPreset("u_jesse", saved("open_review", { public: true }), 20);
    const open = await jesse.call("bellman_start", { manifest: { room: "Open", preset: "open_review" }, brief: brief() });
    const shut = await jesse.call("bellman_start", { manifest: { room: "Shut", preset: "open_review", public: false }, brief: brief() });
    expect([open.isError, shut.isError], `${open.text} ${shut.text}`).toEqual([false, false]);
    expect((await h.store.getSession(String(open.data.session_id)))!.manifest.public).toBe(true);
    expect((await h.store.getSession(String(shut.data.session_id)))!.manifest.public).toBe(false);
  });
```

In `tests/room-yaml-export.test.ts`, the panel's export of a public preset carries the flag (dash's Task 6 writes it): in `EXPORTED`, directly after the line `purpose: "Review where the reviewer may ask too"`, insert the line `public: true`, and add `public: true,` to the object the case passes to `toMatchObject`. `EXPORTED` stays dash's `src/lib/presets.test.ts` fixture byte for byte; Task 6 makes the same change there.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/public-rooms.test.ts tests/tools/start-presets.test.ts tests/room-yaml-export.test.ts`
Expected: FAIL. `Unrecognized key: "public"` from both arms, from `checkPreset` and from the exported room.yaml; `.public` reads `undefined` for the defaults, the built-ins and the old row; the start case refuses the cite's `public`.

- [ ] **Step 3: The types**

In `src/types.ts`, in `RoomManifest` after `host: HostConfig | null;`, add:

```ts
  /**
   * Whether anyone with the room's link may read it (public rooms spec D1): chosen when the
   * room starts, false unless given. Optional in the type because a row written before it has
   * none; `withHeartbeatDefaults` reads it as false, and readers test `=== true` for the
   * in-memory store, which does not hydrate (plan ruling R1). Immutable with the rest: a room
   * made private is marked on the session (`unpublishedAt`), never here.
   */
  public?: boolean;
```

In `SavedPreset`, after the `host?` field, add:

```ts
  /** The default for the rooms started from it (public rooms spec D1). Absent on a preset saved before it, and read as false. */
  public?: boolean;
```

- [ ] **Step 4: The shapes and both arms**

In `src/manifest.ts`, in both `CiteShape` and `AuthorShape`, after the `purpose` line, add:

```ts
  // Who may read the room (public rooms spec D1): on both arms, like `room` and `purpose`.
  public: z.boolean().nullish(),
```

`PresetShape` is `AuthorShape` less `room` and `purpose`, so a saved preset takes `public` with no change there.

In `resolveManifest`, in the cite arm's `manifest` literal after `purpose: v.purpose ?? null,`, and in the author arm's after the same line, add `public: v.public ?? false,`.

In `builtinPresets`, before `updated_at: null,`, add `public: false,`.

- [ ] **Step 5: Presets, the cite, and older rows**

In `src/presets.ts`, change `asManifest`'s signature and body to:

```ts
export function asManifest(
  p: SavedPreset, room: string, purpose: string | null | undefined, heartbeatOn?: string | null, citedPublic?: boolean | null,
): Record<string, unknown> {
  return {
    room,
    purpose: purpose ?? null,
    // The preset's is the default and a cite's own wins (public rooms spec D1).
    public: citedPublic ?? p.public ?? false,
    mode: p.mode,
```

leaving the rest of the literal as it is, and add to its doc comment: "A cite's `public`, when it gives one, replaces the preset's."

In `checkPreset`'s `preset` literal, after the `host:` line, add `public: v.public ?? false,`.

In `src/tools/start.ts`, change `input = asManifest(saved, manifestInput.room, manifestInput.purpose, manifestInput.heartbeat_on);` to `input = asManifest(saved, manifestInput.room, manifestInput.purpose, manifestInput.heartbeat_on, manifestInput.public);`.

In `src/stored-session.ts`, in `withHeartbeatDefaults`'s returned object, after `host: m.host ?? null,`, add `public: m.public ?? false,`, and in its doc comment change "and `reports` a boolean on every role" to "`reports` a boolean on every role, and `public` a boolean (public rooms; a room stored before it is private)".

- [ ] **Step 6: Run the tests, the neighbours, both typechecks**

Run: `npm test -- tests/public-rooms.test.ts tests/tools/start-presets.test.ts tests/room-yaml-export.test.ts tests/presets.test.ts tests/http-presets.test.ts tests/manifest.test.ts tests/stored-session.test.ts tests/room-manifest-skill.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS and clean, after one change the new field forces: a test that pins a whole saved preset or a whole hydrated row with `toEqual` gains `public: false` in its expected object (`tests/presets.test.ts`'s first `checkPreset` case is one).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/manifest.ts src/presets.ts src/tools/start.ts src/stored-session.ts tests/public-rooms.test.ts tests/tools/start-presets.test.ts tests/presets.test.ts tests/room-yaml-export.test.ts
git commit -m "A manifest may be public: on both arms, false unless given, a saved preset's default that a cite overrides, and false for older rooms"
```

---

### Task 2: Unpublishing, and whose room it is

**Files:**
- Modify: `src/types.ts` (`Session.unpublishedAt`)
- Modify: `src/stored-session.ts` (`hydrateStoredSession`)
- Modify: `src/rooms.ts` (`isPublic`)
- Modify: `src/store.ts` (`BellmanStore.unpublishSession`, `MemoryStore.unpublishSession`)
- Modify: `src/store-do.ts` (`SessionDO.unpublishSession`, `DurableObjectStore.unpublishSession`)
- Modify: `src/tools/start.ts` (the new session's `unpublishedAt`)
- Modify: `src/http/rooms.ts` (`UNPUBLISH`, `unpublishRoom`, `mine` in `roomDetail`)
- Modify: `tests/helpers/fixtures.ts` (`session()`)
- Test: `tests/helpers/store-contract.ts`, `tests/public-rooms.test.ts`, `tests/http-rooms.test.ts`

**Interfaces:**
- Consumes: `RoomManifest.public` (Task 1).
- Produces: `Session.unpublishedAt: number | null`; `isPublic(s: Pick<StoredSession, "manifest" | "unpublishedAt">): boolean` from `src/rooms.ts`; `BellmanStore.unpublishSession(sessionId: string, at: number): Promise<void>`; `POST /rooms/:id/unpublish` answering 204; `GET /rooms/:id` carrying `mine: boolean`.

- [ ] **Step 1: Write the failing tests**

In `tests/helpers/fixtures.ts`, in `session()`, after `blobsSwept: false,`, add `unpublishedAt: null,`.

Append to `tests/public-rooms.test.ts` (add `isPublic` from `../src/rooms.js` and `roomManifest` to the fixtures import):

```ts
describe("whether a room is publicly readable", () => {
  it("is public when marked so at the start and not made private since", () => {
    expect(isPublic(session({ manifest: roomManifest({ public: true }) }))).toBe(true);
    expect(isPublic(session({ manifest: roomManifest({ public: true }), unpublishedAt: 1 }))).toBe(false);
    expect(isPublic(session())).toBe(false);
  });

  it("reads a room stored before unpublishing existed as never made private", () => {
    const old = structuredClone(session({ manifest: roomManifest({ public: true }) })) as unknown as Record<string, unknown>;
    delete old.unpublishedAt;
    const hydrated = hydrateStoredSession(old)!;
    expect(hydrated.unpublishedAt).toBeNull();
    expect(isPublic(hydrated)).toBe(true);
  });
});
```

In `tests/helpers/store-contract.ts`, directly after the case `round-trips a created session`, add:

```ts
    // ------------------------------------------------------------- public rooms
    it("makes a room private once, open or closed: the first time stands, and a room that is not there stays not there", async () => {
      const open = session({ id: "qs_pub_open", manifest: roomManifest({ public: true }) });
      const closed = session({ id: "qs_pub_closed", manifest: roomManifest({ public: true }), closed: true, closedAt: Date.now(), joinCodes: {} });
      for (const s of [open, closed]) await store.createSession(s);
      expect((await store.getSession(open.id))?.unpublishedAt).toBeNull();

      const first = Date.now();
      for (const s of [open, closed]) {
        await store.unpublishSession(s.id, first);
        await store.unpublishSession(s.id, first + 60_000);
        expect((await store.getSession(s.id))?.unpublishedAt, s.id).toBe(first);
      }
      await store.unpublishSession("qs_nope", first);
      expect(await store.getSession("qs_nope")).toBeUndefined();
    });
```

In `tests/http-rooms.test.ts` (add `isPublic` from `../src/rooms.js`, and `roomManifest` to the fixtures import), add at the end of the file:

```ts
describe("POST /rooms/:id/unpublish (public rooms)", () => {
  const PUB = "qs_unpub";
  const publicRoom = () => session({ id: PUB, manifest: roomManifest({ public: true }), members: [member(), peer()] });
  const unpublish = (key: string | null, room = PUB, over: CallOptions = {}) =>
    call(key, `/rooms/${room}/unpublish`, { method: "POST", ...over });
  const stillPublic = async () => isPublic((await store.getSession(PUB))!);

  beforeEach(async () => {
    await store.createSession(publicRoom());
  });

  it("lets the creator make the room private: 204, and 204 again, and the first time stands", async () => {
    expect((await unpublish(DEV_KEY.jesse))!.status).toBe(204);
    const at = (await store.getSession(PUB))!.unpublishedAt;
    expect(at).not.toBeNull();
    expect(await stillPublic()).toBe(false);
    expect((await unpublish(DEV_KEY.jesse))!.status).toBe(204);
    expect((await store.getSession(PUB))!.unpublishedAt).toBe(at);
  });

  it("refuses a member who is not the creator with 403, and the room stays public", async () => {
    const res = (await unpublish(DEV_KEY.peer))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "forbidden", error_description: "only the room's creator may make it private" });
    expect(await stillPublic()).toBe(true);
  });

  it("answers a stranger and an unknown room with one 404", async () => {
    const stranger = (await unpublish(DEV_KEY.outsider))!;
    const unknown = (await unpublish(DEV_KEY.jesse, "qs_nope"))!;
    expect([stranger.status, unknown.status]).toEqual([404, 404]);
    expect(await bodyOf(stranger)).toEqual(await bodyOf(unknown));
    expect(await stillPublic()).toBe(true);
  });

  it("refuses no credential, and a cookie with no Origin; takes the panel's", async () => {
    expect((await unpublish(null))!.status).toBe(401);
    expect((await unpublish(null, PUB, { cookie: DEV_KEY.jesse }))!.status).toBe(403);
    expect(await stillPublic()).toBe(true);
    const real = (await unpublish(null, PUB, { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect([real.status, real.headers.get("access-control-allow-origin")]).toEqual([204, PANEL]);
  });

  it("takes POST alone", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${PUB}/unpublish`))!;
    expect([res.status, res.headers.get("allow")]).toEqual([405, "POST"]);
  });
});

describe("GET /rooms/:id says whose room it is", () => {
  it("marks the creator's room mine, and nobody else's", async () => {
    expect(await bodyOf(await call(DEV_KEY.jesse, `/rooms/${ROOM}`))).toMatchObject({ mine: true });
    expect(await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}`))).toMatchObject({ mine: false });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/public-rooms.test.ts tests/http-rooms.test.ts tests/store.test.ts`
Expected: FAIL. `isPublic` is not a function; the old row reads `undefined`; `store.unpublishSession is not a function`; the route answers 404 `no such route`; `mine` is undefined.

- [ ] **Step 3: The field, its default, the predicate**

In `src/types.ts`, in `Session` after `blobsSwept: boolean;`, add:

```ts
  /**
   * When the creator made a public room private (public rooms spec D2), or null. Set once:
   * nothing makes a room public again. Read as null for a row written before it.
   */
  unpublishedAt: number | null;
```

In `src/stored-session.ts`, in `hydrateStoredSession`'s returned object after `blobsSwept: row.blobsSwept ?? false,`, add:

```ts
    unpublishedAt: (row as { unpublishedAt?: number | null }).unpublishedAt ?? null,
```

and to its doc comment's list, before the closing line: "- **unpublishedAt** (public rooms) defaults to `null`: a room written before it was never made private. Whether it is public at all is the manifest's `public`, read false for such a row." Change "All twelve live here" to "All thirteen live here".

In `src/rooms.ts`, after `sessionStatus`, add:

```ts
/**
 * Whether anyone with the room's link may read it (public rooms spec D2): marked public when it
 * started, and not made private since. `=== true` and `== null` because the in-memory store does
 * not hydrate, so a record there may carry neither field.
 */
export const isPublic = (s: Pick<StoredSession, "manifest" | "unpublishedAt">): boolean =>
  s.manifest.public === true && s.unpublishedAt == null;
```

In `src/tools/start.ts`, in the `session` literal after `blobsSwept: false,`, add:

```ts
        // Public or not is the manifest's; this is set only when the creator makes a public room private (public rooms spec D2).
        unpublishedAt: null,
```

- [ ] **Step 4: Both stores**

In `src/store.ts`, in `BellmanStore` after `schedulePurge`, add:

```ts
  /**
   * Make a public room private for good (public rooms spec D2): set `unpublishedAt` to `at`, once.
   * The first time stands, so a retry changes nothing, and a room that is not there is left not
   * there: nothing is written for it. Who may ask is the route's to decide, as for `schedulePurge`.
   * An open room and a closed one alike: a closed public room is readable until its purge (D7).
   */
  unpublishSession(sessionId: string, at: number): Promise<void>;
```

In `MemoryStore`, after its `schedulePurge`, add:

```ts
  async unpublishSession(sessionId: string, at: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.unpublishedAt != null) return;
    s.unpublishedAt = at;
  }
```

In `src/store-do.ts`, in `SessionDO` after its `schedulePurge`, add:

```ts
  /**
   * `BellmanStore.unpublishSession`, for this room. One transaction, so two requests cannot both
   * find the room public: the first time is the one kept. An empty object is left empty.
   */
  async unpublishSession(at: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s || s.unpublishedAt != null) return;
      await txn.put("session", { ...s, unpublishedAt: at });
    });
  }
```

and in `DurableObjectStore`, after its `schedulePurge`, add:

```ts
  async unpublishSession(sessionId: string, at: number): Promise<void> {
    await this.session(sessionId).unpublishSession(at);
  }
```

- [ ] **Step 5: The route, and `mine`**

In `src/http/rooms.ts`, beside the other paths, add `const UNPUBLISH = /^\/rooms\/([^/]+)\/unpublish$/;`. In `roomRoutes`, directly before `return problem(404, "not_found", "no such route", origin);`, add:

```ts
    const unpublish = UNPUBLISH.exec(path);
    if (unpublish) {
      if (request.method !== "POST") return methodNotAllowed("POST", origin);
      return await unpublishRoom(request, unpublish[1], origin, deps);
    }
```

After `deleteRoom`, add:

```ts
/**
 * Make a public room private (public rooms spec D2): its creator's alone, and for good, since its
 * members joined on the preview's word and nothing makes a room public again. 204, and 204 again,
 * since the store keeps the first time; a room that was never public is answered the same, as it is
 * already what was asked.
 *
 * The delete's order of refusals: the CSRF check first for a cookie, one 404 for a person with no
 * handle in the room and for a room that is not there, then a 403 for a member who is not the
 * creator, who knows the room is there.
 */
async function unpublishRoom(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;
  const session = await deps.store.getSession(sessionId);
  if (!session || handlesOf(session, who.identity).length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  if (session.createdBy !== who.identity.userId) {
    return problem(403, "forbidden", "only the room's creator may make it private", origin);
  }
  await deps.store.unpublishSession(sessionId, Date.now());
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
```

In `roomDetail`, in both `json(200, { ... })` bodies, after the `viewer:` line, add `mine: session.createdBy === who.identity.userId,` and say in its doc comment: "`mine` is whether the caller created the room (public rooms plan R3): the creator alone may make a public room private."

- [ ] **Step 6: Run the tests, both stores, both typechecks**

Run: `npm test -- tests/public-rooms.test.ts tests/http-rooms.test.ts tests/store.test.ts tests/stored-session.test.ts && npm run typecheck && npm run typecheck:worker && npm run build:ui && npm --prefix worker-tests run test -- store-contract`
Expected: PASS everywhere, the contract on both stores. A test that pins a whole hydrated row or a whole detail body gains `unpublishedAt: null` or `mine` in its expected object.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/stored-session.ts src/rooms.ts src/store.ts src/store-do.ts src/tools/start.ts src/http/rooms.ts tests/helpers/fixtures.ts tests/helpers/store-contract.ts tests/public-rooms.test.ts tests/http-rooms.test.ts
git commit -m "The creator can make a public room private, once and for good, and the room's detail says whose it is"
```

---

### Task 3: The public reads

**Files:**
- Create: `src/http/public.ts`
- Modify: `src/public-event.ts` (`publicReadEvent`)
- Modify: `src/http/rooms.ts` (export `surfaceTag` and `etagMatches`; `blobResponse` out of `downloadBlob`)
- Modify: `src/worker.ts`, `src/app.ts` (mount `/public`)
- Test: `tests/http-public.test.ts` (new), `tests/projections.test.ts`, `tests/http.test.ts`, `worker-tests/public-routes.test.ts` (new)

**Interfaces:**
- Consumes: `isPublic`, `BellmanStore.unpublishSession` (Task 2).
- Produces: `publicRoutes(request: Request, deps: { store: BellmanStore; blobs: BlobStore }): Promise<Response | undefined>`; `publicReadEvent(e: SessionEvent)`, `publicEvent`'s shape or null; the wire: `GET /public/rooms/:id` is `{ id, status, closed_at, mode, text }` with `text` an untrusted envelope from the creator holding `{ room, purpose }`; `/surface` is `{ surface_cursor, items }` with an `ETag`; `/events[?after=n]` is `{ events, cursor }`; `/blobs/:blobId` is the bytes.

- [ ] **Step 1: Write the failing tests**

Create `tests/http-public.test.ts`:

```ts
/**
 * The public reads (public rooms spec D3, D4): a room marked public, read with no
 * credential by anyone with its link. Driven as tests/http-rooms.test.ts drives the
 * member routes, a web Request in and a Response out over MemoryStore and
 * MemoryBlobStore, with the member routes beside them for the writes a case needs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { publicRoutes } from "../src/http/public.js";
import { MAX_EVENTS_READ, roomRoutes, type RoomRouteDeps } from "../src/http/rooms.js";
import { storedMember } from "../src/projections.js";
import { MemoryStore } from "../src/store.js";
import type { EventType, Member, Session } from "../src/types.js";
import { brief, member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PUB = "qs_public";
const NOT_PUBLIC = { error: "not_found", error_description: "no such public room" };

let store: MemoryStore;
let blobs: MemoryBlobStore;
let members: RoomRouteDeps;

const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
const publicRoom = (over: Partial<Session> = {}) => session({
  id: PUB, manifest: roomManifest({ public: true, room: "Open review", purpose: "Read along" }), members: [member(), peer()], ...over,
});

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  members = {
    store, blobs, panelOrigins: [],
    caller: async (request) => {
      const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
      return identity ? { identity, via: "bearer" as const } : null;
    },
  };
  await store.createSession(publicRoom());
});

/** A public read: no credential unless a case adds one, from an origin nobody listed. */
const read = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  publicRoutes(new Request(`${ISSUER}${path}`, { method, headers: { origin: "https://anywhere.example.test", ...headers } }), { store, blobs });
const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

/** A write as the creator, who holds write_surface, through the member routes. */
const asCreator = (path: string, init: RequestInit = {}) => roomRoutes(new Request(`${ISSUER}${path}`, {
  ...init, headers: { authorization: `Bearer ${DEV_KEY.jesse}`, ...(init.headers as Record<string, string> | undefined) },
}), members);
const placeFile = (key: string, blobId: string) => asCreator(`/rooms/${PUB}/surface/${key}?member_id=m_creator`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "file", blob: { id: blobId } }),
});
const upload = async (name: string) => {
  const res = (await asCreator(`/rooms/${PUB}/blobs?member_id=m_creator&name=${name}`, {
    method: "POST", headers: { "content-type": "text/plain", "content-length": "5" }, body: "hello",
  }))!;
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { blob_id: string }).blob_id;
};
const say = async (from: Member, type: EventType, payload: unknown) => {
  const e = await store.appendEvent(PUB, { type, fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload, refId: null });
  expect(e).not.toBeNull();
  return e!;
};

describe("GET /public/rooms/:id", () => {
  it("answers a public room to anyone with no credential, every origin and no credentials grant", async () => {
    const res = (await read(`/public/rooms/${PUB}`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const body = await bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(["closed_at", "id", "mode", "status", "text"]);
    expect(body).toMatchObject({ id: PUB, status: "active", closed_at: null, mode: "pair" });
    expect(body.text).toEqual({
      trust: "untrusted", origin: { memberId: "m_creator", label: "jesse@codenerd" }, data: { room: "Open review", purpose: "Read along" },
    });
  });

  it("answers a private, an unpublished, an unknown and a purged room, and their sub-routes, with one 404", async () => {
    await store.createSession(session({ id: "qs_private", members: [member()] }));
    await store.createSession(publicRoom({ id: "qs_unpublished" }));
    await store.unpublishSession("qs_unpublished", Date.now());
    await store.createSession(publicRoom({ id: "qs_purged", closed: true, closedAt: Date.now() - 1_000, joinCodes: {} }));
    await store.schedulePurge("qs_purged", Date.now(), "u_jesse");
    await store.sweep(Date.now());
    for (const id of ["qs_private", "qs_unpublished", "qs_nope", "qs_purged"]) {
      for (const sub of ["", "/surface", "/events", `/blobs/${"a".repeat(32)}`]) {
        const res = (await read(`/public/rooms/${id}${sub}`))!;
        expect(res.status, `${id}${sub}`).toBe(404);
        expect(await bodyOf(res), `${id}${sub}`).toEqual(NOT_PUBLIC);
      }
    }
  });

  // Review Focus 4.
  it("opens nothing for a member's credential: a private room is the same 404 with a bearer", async () => {
    await store.createSession(session({ id: "qs_private", members: [member()] }));
    const res = (await read("/public/rooms/qs_private", { authorization: `Bearer ${DEV_KEY.jesse}` }))!;
    expect([res.status, await bodyOf(res)]).toEqual([404, NOT_PUBLIC]);
  });

  it("still reads a closed public room until its purge", async () => {
    const at = Date.parse("2026-10-09T12:00:00Z");
    await store.createSession(publicRoom({ id: "qs_closed_public", closed: true, closedAt: at, joinCodes: {} }));
    expect(await bodyOf(await read("/public/rooms/qs_closed_public"))).toMatchObject({ status: "closed", closed_at: "2026-10-09T12:00:00.000Z" });
  });
});

describe("GET /public/rooms/:id/surface", () => {
  it("answers the items as members read them, the surface cursor as an ETag a page can read, and 304 on a match", async () => {
    const put = (await asCreator(`/rooms/${PUB}/surface/plan?member_id=m_creator`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", title: "The plan", body: "hello" }),
    }))!;
    expect(put.status, await put.clone().text()).toBe(200);
    const res = (await read(`/public/rooms/${PUB}/surface`))!;
    expect([res.status, res.headers.get("access-control-expose-headers")]).toEqual([200, "etag"]);
    const tag = res.headers.get("etag")!;
    const body = (await res.json()) as { surface_cursor: number; items: { origin: unknown; data: { key: string } }[] };
    expect(tag).toBe(`"${body.surface_cursor}"`);
    expect(body.items.map((i) => i.data.key)).toEqual(["plan"]);
    expect(body.items[0].origin).toEqual({ memberId: "m_creator", label: "jesse@codenerd" });
    const again = (await read(`/public/rooms/${PUB}/surface`, { "if-none-match": tag }))!;
    expect([again.status, again.headers.get("etag"), again.headers.get("access-control-allow-origin")]).toEqual([304, tag, "*"]);
  });
});

describe("GET /public/rooms/:id/events", () => {
  interface Read { events: { origin: unknown; data: { cursor: number; type: string; payload: unknown } }[]; cursor: number }
  const events = async (query = "") => (await bodyOf(await read(`/public/rooms/${PUB}/events${query}`))) as unknown as Read;

  it("reads the log as members do, less every brief: no brief_update, and a joiner as its id, label and seat", async () => {
    await say(member(), "message", { text: "hello" });
    await say(peer(), "member_joined", { member: { ...storedMember(peer()), later: "x" }, brief: brief(), extra: "y" });
    await say(peer(), "brief_update", brief());
    const out = await events();
    expect(out.events.map((e) => e.data.type)).toEqual(["message", "member_joined"]);
    expect(out.events[0].origin).toEqual({ memberId: "m_creator", label: "jesse@codenerd" });
    expect(out.events[1].data.payload).toEqual({ member: { member_id: "m_peer", label: "peer@codenerd", room_role: "peer_b" } });
    expect(JSON.stringify(out)).not.toContain(brief().goal);
  });

  // Review Focus 2.
  it("names a joiner's fields null where a payload of another shape has none, and shows nothing else", async () => {
    await say(peer(), "member_joined", { member_id: "m_peer", brief: brief() });
    await say(peer(), "member_joined", { member: { member_id: 7, label: { goal: "x" }, room_role: "peer_b" } });
    expect((await events()).events.map((e) => e.data.payload)).toEqual([
      { member: { member_id: null, label: null, room_role: null } },
      { member: { member_id: null, label: null, room_role: "peer_b" } },
    ]);
  });

  // Review Focus 1.
  it("moves its cursor past a page of nothing but briefs, so a poll is never stuck on one", async () => {
    const first = await say(member(), "message", { text: "before" });
    for (let i = 0; i < 3; i++) await say(peer(), "brief_update", brief());
    const out = await events(`?after=${first.cursor}`);
    expect(out).toEqual({ events: [], cursor: first.cursor + 3 });
  });

  it("reads the newest MAX_EVENTS_READ, the earliest past ?after, and refuses a cursor that is not one", async () => {
    for (let i = 0; i < MAX_EVENTS_READ + 5; i++) await say(member(), "message", { text: `m${i}` });
    const text = (e: Read["events"][number]) => (e.data.payload as { text: string }).text;
    const newest = await events();
    expect([newest.events.length, text(newest.events.at(-1)!)]).toEqual([MAX_EVENTS_READ, `m${MAX_EVENTS_READ + 4}`]);
    const earliest = await events("?after=0");
    expect([earliest.events.length, text(earliest.events[0]), earliest.cursor]).toEqual([MAX_EVENTS_READ, "m0", earliest.events.at(-1)!.data.cursor]);
    expect((await read(`/public/rooms/${PUB}/events?after=-1`))!.status).toBe(400);
  });
});

describe("GET /public/rooms/:id/blobs/:blobId", () => {
  it("serves a blob an item on the surface names, under the member download's headers, to anyone", async () => {
    const id = await upload("notes.txt");
    expect((await placeFile("notes", id))!.status).toBe(200);
    const res = (await read(`/public/rooms/${PUB}/blobs/${id}`))!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const h = (name: string) => res.headers.get(name);
    expect([h("access-control-allow-origin"), h("x-content-type-options"), h("content-security-policy"), h("content-type")])
      .toEqual(["*", "nosniff", "sandbox", "application/octet-stream"]);
    expect(h("content-disposition")).toContain("attachment");
  });

  // Review Focus 3.
  it("keeps a blob no item names the members': one never placed, and one whose item was removed", async () => {
    const never = await upload("draft.txt");
    const gone = await upload("old.txt");
    expect((await placeFile("old", gone))!.status).toBe(200);
    expect((await asCreator(`/rooms/${PUB}/surface/old?member_id=m_creator`, { method: "DELETE" }))!.ok).toBe(true);
    for (const id of [never, gone, "not-a-blob-id"]) {
      const res = (await read(`/public/rooms/${PUB}/blobs/${id}`))!;
      expect([res.status, await bodyOf(res)], id).toEqual([404, { error: "not_found", error_description: "no such blob" }]);
    }
  });
});

describe("the public routes", () => {
  it("answer a preflight from any origin, letting a page send If-None-Match", async () => {
    const res = (await read(`/public/rooms/${PUB}/surface`, { "access-control-request-method": "GET", "access-control-request-headers": "if-none-match" }, "OPTIONS"))!;
    const h = (name: string) => res.headers.get(name);
    expect([res.status, h("access-control-allow-origin"), h("access-control-allow-methods"), h("access-control-allow-headers")])
      .toEqual([204, "*", "GET", "if-none-match"]);
  });

  it("take GET alone, answer a path they do not know, and leave every other path to the next module", async () => {
    const post = (await read(`/public/rooms/${PUB}`, {}, "POST"))!;
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect(await bodyOf(await read("/public/elsewhere"))).toEqual({ error: "not_found", error_description: "no such route" });
    expect(await read(`/rooms/${PUB}`)).toBeUndefined();
    expect(await read("/publicity")).toBeUndefined();
  });
});
```

In `tests/projections.test.ts`, add `["http/public.ts", resolve(SRC, "http/public.ts")],` to the `it.each` list of modules that pull in no runtime, and `reachable(resolve(SRC, "http/public.ts"));` to the case `resolves every local specifier it meets`.

In `tests/http.test.ts` (add `roomManifest` and `session` to the fixtures import), inside `describe("HTTP surface")`, add:

```ts
  it("serves the public reads beside the room routes, with no credential", async () => {
    await store.createSession(session({ id: "qs_http_public", manifest: roomManifest({ public: true }) }));
    const res = await fetch(`${base}/public/rooms/qs_http_public`);
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
  });
```

Create `worker-tests/public-routes.test.ts`:

```ts
/**
 * The Worker serves the public reads and the unpublish (public rooms spec D2, D3) over
 * the real SessionDO: a request with no credential reads a public room, the creator's
 * bearer makes it private through the room routes, and the read is then the 404 a
 * private room gets. Reached as room-routes.test.ts reaches the Worker, with the key
 * vitest.config.ts binds (`qk_ws_test`, u_jesse, the fixture room's creator).
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import worker from "../src/worker.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ROOM = "qs_worker_public";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("public rooms through the Worker", () => {
  it("reads a public room with no credential, and once its creator makes it private, answers the 404 a private room gets", async () => {
    await new DurableObjectStore(env as never).createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member()] }));
    const open = await call(`/public/rooms/${ROOM}`);
    expect(open.status, await open.clone().text()).toBe(200);
    expect(open.headers.get("access-control-allow-origin")).toBe("*");

    const made = await call(`/rooms/${ROOM}/unpublish`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
    expect(made.status, await made.clone().text()).toBe(204);

    expect((await call(`/public/rooms/${ROOM}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/http-public.test.ts tests/projections.test.ts tests/http.test.ts`
Expected: FAIL. `src/http/public.ts` does not exist, so the new file and the projections cases fail to resolve it, and the Node app answers the public path with Express's `Not found` (a 404, not a 200).

- [ ] **Step 3: What a public reader is shown of an event**

In `src/public-event.ts`, after `publicEvent`, add:

```ts
/**
 * An event as anyone with a public room's link is shown it (public rooms spec D4): what a member
 * is shown, less every brief. A `brief_update` is left out, null here. A `member_joined` keeps its
 * joiner's member id, label and seat, each a string or null, and nothing else: the stored payload
 * carries the brief, the org, the agent and the capabilities, and naming the three fields means a
 * field a payload gains later is not shown by default (plan ruling R4).
 */
export function publicReadEvent(e: SessionEvent) {
  if (e.type === "brief_update") return null;
  const shown = publicEvent(e);
  if (e.type !== "member_joined") return shown;
  const joiner = (e.payload as { member?: Record<string, unknown> | null } | null)?.member;
  const text = (key: string) => {
    const v = joiner?.[key];
    return typeof v === "string" ? v : null;
  };
  return { ...shown, payload: { member: { member_id: text("member_id"), label: text("label"), room_role: text("room_role") } } };
}
```

- [ ] **Step 4: What the member routes share**

In `src/http/rooms.ts`: add `export` to `const surfaceTag` and to `const etagMatches`; add `type BlobRead` to the import from `../blobs.js`; after `DOWNLOAD_HEADERS`, add:

```ts
/**
 * A blob's answer once a door has read it (D4): the download headers on a 304 and a 200 alike, the
 * bytes as stored for an image on the allowlist, served inline, and everything else (a PDF,
 * markdown, an SVG, an HTML artifact) an octet-stream download under its label. Nothing from here
 * is ever text/html. The member download and the public one (public rooms spec D3) both answer here.
 */
export function blobResponse(read: Exclude<BlobRead, null>, cors: Record<string, string>): Response {
  const headers: Record<string, string> = { ...DOWNLOAD_HEADERS, ...cors, etag: read.etag };
  if ("unchanged" in read) return new Response(null, { status: 304, headers });
  const image = isImageType(read.type);
  headers["content-type"] = image ? read.type : OCTET_STREAM;
  headers["content-length"] = String(read.bytes);
  if (!image) headers["content-disposition"] = attachmentDisposition(read.name);
  return new Response(read.body, { status: 200, headers });
}
```

and in `downloadBlob`, replace everything from `const headers: Record<string, string> = { ...DOWNLOAD_HEADERS, ...corsHeaders(origin), etag: read.etag };` to the end of the function with `return blobResponse(read, corsHeaders(origin));`. The comment that stood above the type decision now lives on `blobResponse`.

- [ ] **Step 5: The module**

Create `src/http/public.ts`:

```ts
/**
 * The public reads (public rooms spec D3, D4): a room its creator marked public when it started,
 * read by anyone with its link. `GET` under `/public/rooms/:id` and nothing else: the room's name
 * and purpose, its surface with the surface cursor as an ETag, its log, and the bytes of a blob an
 * item on its surface names.
 *
 * No credential is read here, by design. A cookie or a bearer changes nothing, so a member's
 * credential cannot open a private room through these paths, and every origin is answered
 * (`access-control-allow-origin: *`, never with credentials). A room that is not publicly readable
 * (private, made private, unknown or purged) is one 404 with one body, decided before anything else
 * about the room is read. The link is the room's id, a random UUID.
 *
 * What a reader is shown is what a member is, less every brief (`publicReadEvent`). Runtime-free,
 * like rooms.ts beside it: a web Request in, a Response out, for both servers and the tests.
 */
import { isBlobId, type BlobStore } from "../blobs.js";
import { retentionOf, untrusted } from "../projections.js";
import { publicReadEvent } from "../public-event.js";
import { isPublic, readSurface, sessionStatus } from "../rooms.js";
import type { BellmanStore } from "../store.js";
import { surfaceCursor } from "../surface.js";
import { MAX_EVENTS_READ, blobResponse, etagMatches, surfaceTag } from "./rooms.js";

export interface PublicRouteDeps {
  store: BellmanStore;
  blobs: BlobStore;
}

/** `/public/rooms/:id`, then `/surface`, `/events` or `/blobs/:blobId`. */
const PATH = /^\/public\/rooms\/([^/]+)(?:\/(surface|events)|\/blobs\/([^/]+))?$/;

/** Every origin, and no credentials: there is nothing here a credential could grant. */
const OPEN: Record<string, string> = { "access-control-allow-origin": "*" };

const answer = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...OPEN, ...extra },
  });

const notFound = (description: string) => answer(404, { error: "not_found", error_description: description });

/**
 * The public routes. `undefined` for a path outside `/public`, so a server carries on to the next
 * module; everything under it is answered here, a path this module does not know and a throw included.
 */
export async function publicRoutes(request: Request, deps: PublicRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/public" && !path.startsWith("/public/")) return undefined;
  // A page polling the surface sends If-None-Match, which is not a CORS-safelisted header, so the browser asks first.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...OPEN, "access-control-allow-methods": "GET", "access-control-allow-headers": "if-none-match", "access-control-max-age": "600" },
    });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET", ...OPEN } });

  try {
    const m = PATH.exec(path);
    if (!m) return notFound("no such route");
    const [, id, part, blobId] = m;
    const session = await deps.store.getSession(id);
    if (!session || !isPublic(session)) return notFound("no such public room");

    if (blobId !== undefined) {
      // Only a blob an item on the surface names: one uploaded and never placed, or one whose
      // item went, stays the members' (D3).
      const named = isBlobId(blobId) && (await deps.store.surfaceOf(id)).some((r) => r.blob?.id === blobId);
      if (!named) return notFound("no such blob");
      const got = await deps.blobs.get(id, blobId, request.headers.get("if-none-match") ?? undefined);
      return got === null ? notFound("no such blob") : blobResponse(got, OPEN);
    }

    if (part === "surface") {
      // As the member route answers a seat still in the room: from the record alone on a match.
      const exposed = { "access-control-expose-headers": "etag" };
      const tag = surfaceTag(surfaceCursor(session));
      if (etagMatches(request.headers.get("if-none-match"), tag)) {
        return new Response(null, { status: 304, headers: { ...OPEN, ...exposed, "cache-control": "no-store", etag: tag } });
      }
      const block = await readSurface(deps.store, session);
      return answer(200, { surface_cursor: block.cursor, items: block.items }, { ...exposed, etag: surfaceTag(block.cursor) });
    }

    if (part === "events") {
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d{1,15}$/.test(raw)) {
        return answer(400, { error: "invalid_request", error_description: "after is a cursor: a whole number, 0 or more" });
      }
      const after = raw === null ? undefined : Number(raw);
      const read = after === undefined
        ? await deps.store.recentEvents(id, MAX_EVENTS_READ)
        : await deps.store.eventsAfter(id, after, MAX_EVENTS_READ);
      const events = read.flatMap((e) => {
        const shown = publicReadEvent(e);
        return shown ? [untrusted({ memberId: e.fromMemberId, label: e.fromLabel }, shown)] : [];
      });
      // The last event read, a brief left out included, so a page of nothing but briefs still
      // moves the next poll past it.
      return answer(200, { events, cursor: read.at(-1)?.cursor ?? after ?? 0 });
    }

    const creator = session.members[0];
    return answer(200, {
      id: session.id,
      status: sessionStatus(session),
      closed_at: retentionOf(session).closed_at,
      mode: session.manifest.mode,
      text: untrusted(
        { memberId: creator.memberId, label: creator.label },
        { room: session.manifest.room, purpose: session.manifest.purpose },
      ),
    });
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return answer(500, { error: "internal", error_description: "the request failed on the server" });
  }
}
```

- [ ] **Step 6: Mount it in both servers**

In `src/worker.ts`, import `publicRoutes` from `./http/public.js`, and directly before the presets block (`if (url.pathname === "/presets" ...`), add:

```ts
    // The public reads (public rooms spec D3): no credential, so no caller is composed. Behind the
    // fail-closed guard the room routes share (plan ruling R7): a deploy that serves no room serves
    // none in public either.
    if (url.pathname === "/public" || url.pathname.startsWith("/public/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await publicRoutes(request, { store, blobs });
      if (handled) return handled;
    }
```

In `src/app.ts`, import `publicRoutes` from `./http/public.js`, and after the `app.use("/presets", ...)` line, add:

```ts
  app.use("/public", serve((request) => publicRoutes(request, { store, blobs })));
```

- [ ] **Step 7: Run the tests, both typechecks, the Worker's**

Run: `npm test -- tests/http-public.test.ts tests/projections.test.ts tests/http.test.ts tests/http-rooms.test.ts tests/http-blobs.test.ts tests/public-event.test.ts && npm run typecheck && npm run typecheck:worker && npm run build:ui && npm --prefix worker-tests run test -- public-routes blobs-route room-routes`
Expected: PASS everywhere. `tests/http-blobs.test.ts` and `blobs-route` are the member download's own cases, unchanged by `blobResponse`.

- [ ] **Step 8: Commit**

```bash
git add src/http/public.ts src/public-event.ts src/http/rooms.ts src/worker.ts src/app.ts tests/http-public.test.ts tests/projections.test.ts tests/http.test.ts worker-tests/public-routes.test.ts
git commit -m "Anyone with a public room's link reads its name, surface, log and placed files, with no credential and never a brief"
```

---

### Task 4: Joiners are told, the MCP App says so, the docs, and the bellman PR

**Files:**
- Modify: `src/projections.ts` (`roomPreview`)
- Modify: `src/tools/start.ts`, `src/tools/connect.ts` (descriptions)
- Modify: `ui/src/types.ts`, `ui/src/join.ts`, `ui/src/monitor.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `skills/room-manifest/SKILL.md`
- Test: `tests/public-rooms.test.ts`, `tests/tools/handshake.test.ts`, `ui/test/render.test.ts`

**Interfaces:**
- Consumes: `isPublic` (Task 2).
- Produces: `roomPreview(...).public: boolean`, in the trusted spine of every preview (`bellman_start`, `bellman_connect`, `bellman_confirm`, `bellman_rooms`, `bellman_surface`, `GET /rooms/:id`); the MCP App's `RoomBlock.public?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/public-rooms.test.ts` (add `roomPreview` from `../src/projections.js` and `type Session` from `../src/types.js`):

```ts
describe("the preview", () => {
  it("says whether the room is public, in its trusted part, as the room stands", () => {
    const view = (over: Partial<Session>) => roomPreview(session(over), "peer_b");
    expect(view({ manifest: roomManifest({ public: true }) }).public).toBe(true);
    expect(view({ manifest: roomManifest({ public: true }), unpublishedAt: 1 }).public).toBe(false);
    expect(view({}).public).toBe(false);
    expect(view({ manifest: roomManifest({ public: true }) }).text.data).not.toHaveProperty("public");
  });
});
```

In `tests/tools/handshake.test.ts`, both cases that pin the preview's keys list them sorted; add `"public"` between `"preset"` and `"reports"` in each.

In `ui/test/render.test.ts`, inside `describe("renderJoin")`, add:

```ts
  it("tells a joiner a public room is readable by anyone with its link, and says nothing of the kind otherwise", () => {
    const r = connectFixture();
    expect(renderJoin(r, () => {}, NOW).textContent).not.toContain("Anyone with this room's link");
    r.room.public = true;
    expect(renderJoin(r, () => {}, NOW).textContent).toContain("Anyone with this room's link can read its surface and its log.");
  });
```

and in the file's `renderMonitor` cases add:

```ts
  it("marks a public room", () => {
    const r = roomsFixture();
    const chips = () => [...renderMonitor(r, new Map(), () => {}, NOW).querySelectorAll("h2 .chip")].map((c) => c.textContent);
    expect(chips()).not.toContain("public");
    r.rooms[0].room.public = true;
    expect(chips()).toContain("public");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/public-rooms.test.ts tests/tools/handshake.test.ts ui/test/render.test.ts`
Expected: FAIL. The preview has no `public`, so both handshake key lists miss it; the join screen says nothing; the monitor shows no chip. `ui/test` fails to typecheck `r.room.public` until Step 4, so run `npm run typecheck:ui` only after it.

- [ ] **Step 3: The preview**

In `src/projections.ts`, import `isPublic` beside `activeMembers` and `sessionStatus` from `./rooms.js`. In `roomPreview`'s returned object, after `mode: m.mode,`, add:

```ts
    // Whether anyone with the room's link reads it (public rooms spec D5): a boolean the server
    // computed, so it is spine, and the room as it stands, so a room made private says so.
    public: isPublic(session),
```

and in its doc comment, change "(preset, mode, role keys, verbs, cadence, whether this seat reports)" to "(preset, mode, whether the room is public, role keys, verbs, cadence, whether this seat reports)".

- [ ] **Step 4: The MCP App**

In `ui/src/types.ts`, in `RoomBlock` after `mode: string;`, add:

```ts
  /** Whether anyone with the room's link may read it. Absent from a server that predates public rooms. */
  public?: boolean;
```

In `ui/src/join.ts`, in `renderJoin`'s returned section, directly after `el("h1", {}, "Join a Bellman room"),`, add:

```ts
    // The server's fact, not the creator's words: outside the untrusted box, before the seat is chosen (public rooms spec D5).
    r.room.public
      ? el("p", {}, el("strong", {}, "Public room."), " Anyone with this room's link can read its surface and its log.")
      : null,
```

In `ui/src/monitor.ts`, in `roomCard`'s `h2`, after the chip for `room.room.preset ?? room.room.mode`, add `room.room.public ? el("span", { class: "chip" }, "public") : null`.

- [ ] **Step 5: What the tools say**

In `src/tools/start.ts`'s description: change `{ room, purpose?, preset: "pair"` to `{ room, purpose?, public?, preset: "pair"`, and `{ room, purpose?, mode, roles:` to `{ room, purpose?, public?, mode, roles:`; directly after the line that begins ``A manifest may declare a `host` `` (indented four spaces), add the line

```
    public: true lets anyone with the room's link read its surface and its log, never a brief; joining still takes a code, and joiners are told before they accept. False unless given; a saved preset's is the default for its rooms.
```

and change `room: {preset, mode, your_role,` to `room: {preset, mode, public, your_role,`.

In `src/tools/connect.ts`'s description: change `room: {preset, mode, your_role,` to `room: {preset, mode, public, your_role,`, and directly after the line that begins `surface lists what the room's working surface holds`, add the line

```
public: true means anyone with the room's link can read its surface and its log, though never a brief: tell your human before they accept.
```

- [ ] **Step 6: Run the tests and the UI's typecheck**

Run: `npm test -- tests/public-rooms.test.ts tests/tools/handshake.test.ts ui/test/render.test.ts tests/extension.test.ts && npm run typecheck:ui && npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add src/projections.ts src/tools/start.ts src/tools/connect.ts ui/src/types.ts ui/src/join.ts ui/src/monitor.ts tests/public-rooms.test.ts tests/tools/handshake.test.ts ui/test/render.test.ts
git commit -m "Joiners are told a room is public before they accept: the preview's spine, the tools' words, the join screen and the monitor"
```

- [ ] **Step 8: The docs**

`README.md`, directly after the bullet that begins `- On the team plan an org's admin can read any closed room`, add:

```markdown
- A room started with `public: true` in its manifest is readable by anyone with its link, signed in or not: `GET /public/rooms/:id` for its name and purpose, `/surface` for the working surface, `/events` for its log, and `/blobs/:blobId` for a file an item on the surface names. A brief never is: the log leaves out `brief_update`, and a join names only the joiner's id, label and seat. Joining still takes a code, and a joiner sees that the room is public before accepting. Its creator can make it private with `POST /rooms/:id/unpublish` or from the room's page in dash, and nothing makes a room public again. Readers open it at `dash.bellman.sh/r/<id>`.
```

`docs/ARCHITECTURE.md`, directly after the paragraph that begins `**The control panel**`, add:

```markdown
**A public room** is the one read with no caller at all. `src/http/public.ts` answers `GET /public/rooms/:id`, its surface, its log and the blobs its surface names, to any origin and reading no credential, for a room whose manifest set `public: true` and whose creator has not since made it private (`POST /rooms/:id/unpublish`, which sets `unpublishedAt`). Every other room is one 404 there. The log goes through `publicReadEvent`, which drops `brief_update` and cuts `member_joined` to the joiner's id, label and seat. Dash renders it at `/r/<id>`, outside sign-in.
```

and directly before `## 8. Where this is going`, add:

```markdown
**A public room gives up confidentiality, on purpose.** Its surface, its log and the files on its surface are readable by anyone with its link; its briefs, and any blob no item names, are not. Rendering does not change: peer content is text on the public page as on a member's, and the public page has no write path. Joiners consent at the preview, where `public` is part of the trusted spine, before any of their context crosses.
```

`skills/room-manifest/SKILL.md`, directly before `## Step 3 — check it`, add:

```markdown
### A public room

`public: true` on either arm makes the room readable by anyone with its link:
its working surface and its log, never a brief. Joining still takes a code,
and a joiner is shown that the room is public before accepting. It is false
unless given. The creator can make the room private later, from dash; nothing
makes a room public again.
```

- [ ] **Step 9: Measure what connecting costs**

```bash
S=<scratchpad>
BASE=$(git merge-base origin/main HEAD)
git worktree add --detach "$S/public-base" "$BASE"
ln -s "$PWD/node_modules" "$S/public-base/node_modules"
measure() { (cd "$1" && npm run -s build:ui >/dev/null && npx tsx -e 'import("./tests/helpers/harness.ts").then(async ({ Harness, DEV_KEY }) => { const h = new Harness(); const p = await h.connect(DEV_KEY.jesse); console.log(JSON.stringify((await p.listTools()).tools)); await h.close(); process.exit(0); });') > "$2"; }
measure "$S/public-base" "$S/tools-base.json" && measure "$PWD" "$S/tools-head.json"
python3 - "$S/tools-base.json" "$S/tools-head.json" <<'EOF'
import json, sys, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
count = lambda x: len(enc.encode(json.dumps(x, separators=(",", ":"))))
for path in sys.argv[1:]:
    tools = json.load(open(path))
    print(path, count(tools), {t["name"]: count(t) for t in tools})
EOF
rm "$S/public-base/node_modules" && git worktree remove "$S/public-base"
```

Expected: two totals and per-tool counts; `bellman_start` and `bellman_connect` grow, and so does every tool whose input carries a manifest. In `docs/ARCHITECTURE.md` §11, set the table's tool-definitions figure to the new total and add a paragraph above the newest "Re-measured" one: the date, the total, the difference against the merge base by tool, and why (the manifest's `public` on both arms, and one line each in `bellman_start` and `bellman_connect`).

- [ ] **Step 10: Verify, commit, push, PR**

Run: `npm run verify && npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
Expected: green, and the dry run bundles.

```bash
git add README.md docs/ARCHITECTURE.md skills/room-manifest/SKILL.md
git commit -m "Say what a public room is: the routes, the trust it gives up, how a manifest asks for one, and what it costs to connect"
git push -u origin mcfearsome/public-rooms
gh pr create --repo bellman-sh/bellman --base main --head mcfearsome/public-rooms --draft --title "Public rooms: readable by anyone with the link, joined only with a code, and the creator can make one private" --body-file <scratchpad>/public-pr-body.md
```

The body: what it adds; the trust trade, D8 word for word, said out loud because CLAUDE.md asks it of any change that weakens what peer content may reach; rulings R1 to R7; the measured token change; the verify totals; and that dash's half follows and deploys after this one.

---

### Task 5: Dash: the public page

**Files:**
- Modify: `src/lib/api.ts` (`request`'s credentials, the surface and events reads, the public reads)
- Modify: `src/lib/use-surface.ts`, `src/lib/use-events.ts` (an optional `read`)
- Modify: `src/components/canvas/context.ts`, `src/components/canvas/nodes.tsx`, `src/components/canvas/canvas.tsx` (blob URLs from context)
- Create: `src/components/canvas/read-only-canvas.tsx`, `src/routes/public-room.tsx`
- Modify: `src/router.tsx` (`publicRoomRoute`)
- Test: `src/components/canvas/nodes.test.tsx`, `src/router.test.tsx`

**Interfaces:**
- Consumes: Task 3's wire.
- Produces: `getPublicRoom(id): Promise<PublicRoom>`, `getPublicSurface(id, etag?): Promise<SurfacePoll>`, `getPublicEvents(id, after?): Promise<EventsRead>`, `publicBlobUrl(id, blobId): string`; `useSurface(roomId, { onUnauthorized, read? })`, `useEvents(roomId, { onUnauthorized, read? })`; `CanvasContextValue.blobHref: (blobId: string) => string` and `.blobCredentials: RequestCredentials`; the route `/r/$roomId`.

- [ ] **Step 1: The worktree**

```bash
D=/Users/mcfearsome/src/github.com/bellman-sh/dash
DASH=<scratchpad>/dash-public
git -C "$D" fetch -q origin
git -C "$D" worktree add -b mcfearsome/public-rooms "$DASH" origin/main
ln -s "$D/node_modules" "$DASH/node_modules"
```

Every dash step runs in `$DASH`.

- [ ] **Step 2: Write the failing tests**

In `src/components/canvas/nodes.test.tsx`: import `publicBlobUrl` beside `blobUrl`; give `tree`'s `over` two more optional fields, `blobHref?: (blobId: string) => string` and `blobCredentials?: RequestCredentials`; and in its `CanvasProvider` value add `blobHref: over.blobHref ?? ((b: string) => blobUrl("qs_1", b)), blobCredentials: over.blobCredentials ?? "include"`. In the describe that holds `answer` and `blob` (the blob-backed html cases), add:

```tsx
  it("reads a blob where the page's context says, with the credentials it says: the public route and no cookie", async () => {
    const stub = answer(200);
    mount(env({ key: "h", kind: "html", blob }), { blobHref: (b) => publicBlobUrl("qs_1", b), blobCredentials: "omit" });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(stub).toHaveBeenCalledWith(publicBlobUrl("qs_1", blob.id), { credentials: "omit" });
  });

  // Review Focus 5.
  it("fetches a blob once, though the context is rebuilt with every poll", async () => {
    const stub = answer(200);
    const view = mount(env({ key: "h", kind: "html", blob }), { now: 1 });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    view.rerender(tree(env({ key: "h", kind: "html", blob }), { now: 2, blobHref: (b) => blobUrl("qs_1", b) }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("draws an image from where the page's context says", () => {
    const image = { id: "ab".repeat(16), bytes: 3, type: "image/png", name: "a.png" };
    mount(env({ key: "pic", kind: "image", blob: image }), { blobHref: (b) => publicBlobUrl("qs_1", b) });
    expect(screen.getByRole("img")).toHaveAttribute("src", publicBlobUrl("qs_1", image.id));
  });
```

In `src/router.test.tsx`: in the `fetch` stub, directly before `if (mode === "ok") return await answer(url);`, add the line below, so the public routes answer whoever is or is not signed in:

```ts
    if (url.startsWith(`${API}/public/`)) return await answer(url);
```

In `answer`, directly after `const path = url.replace(API, "");`, add:

```ts
  const pub = /^\/public\/rooms\/(qs_pub|qs_private)(\/surface|\/events)?(\?.*)?$/.exec(path);
  if (pub?.[1] === "qs_private") return Response.json({ error: "not_found", error_description: "no such public room" }, { status: 404 });
  if (pub?.[2] === "/surface") return Response.json({ surface_cursor: 1, items: rooms.qs_1!.items }, { headers: { etag: '"1"' } });
  if (pub?.[2] === "/events") return Response.json({ events: [], cursor: 0 });
  if (pub) {
    return Response.json({
      id: "qs_pub", status: "active", closed_at: null, mode: "pair",
      text: { trust: "untrusted", origin: { memberId: "m_creator", label: "jesse@codenerd" }, data: { room: "Open review", purpose: "Read along" } },
    });
  }
```

and add at the end of the file:

```tsx
describe("a public room's page", () => {
  it("shows the room's name, purpose and canvas to a visitor who is not signed in, with no cookie and no sign-in check", async () => {
    mode = "401";
    await boot("/r/qs_pub");
    expect(await screen.findByRole("heading", { name: "Open review" })).toBeInTheDocument();
    expect(screen.getByText("Read along")).toBeInTheDocument();
    expect(await screen.findByTestId("rf__node-plan")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/r/qs_pub");
    expect(sessionCalls()).toBe(0);
    expect(calls).toContainEqual({ url: `${API}/public/rooms/qs_pub`, method: "GET", credentials: "omit" });
    expect(calls).toContainEqual({ url: `${API}/public/rooms/qs_pub/surface`, method: "GET", credentials: "omit" });
    expect(calls.filter((c) => c.url.startsWith(`${API}/public/`)).every((c) => c.credentials === "omit")).toBe(true);
  });

  it("shows its log from the public route", async () => {
    await boot("/r/qs_pub?view=log");
    expect(await screen.findByText("Nothing in this room's log yet.")).toBeInTheDocument();
    expect(calls).toContainEqual({ url: `${API}/public/rooms/qs_pub/events`, method: "GET", credentials: "omit" });
  });

  it("answers a room that is not public with the not-found screen", async () => {
    await boot("/r/qs_private");
    expect(await screen.findByText("No such page")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/components/canvas/nodes.test.tsx src/router.test.tsx`
Expected: FAIL. `publicBlobUrl` is not exported; the nodes read `blobUrl` and not the context; `/r/qs_pub` is the not-found screen.

- [ ] **Step 4: The client**

In `src/lib/api.ts`: in `request`, change `{ ...init, credentials: "include" }` to `{ credentials: "include", ...init }` and say above it: "The cookie unless the call says otherwise: the public reads say `omit` (public rooms spec D6)." Replace `getSurface` and `getEvents` with:

```ts
async function surfaceAt(path: string, etag: string | undefined, init: RequestInit = {}): Promise<SurfacePoll> {
  const r = await request<SurfaceRead>(path, { ...init, headers: etag ? { "if-none-match": etag } : {} });
  if (r.status === 304) return { changed: false };
  return { changed: true, etag: r.headers.get("etag") ?? `"${r.body.surface_cursor}"`, surface: r.body };
}

/** The poll (spec D2): with the last ETag, a 304 means nothing moved. */
export const getSurface = (id: string, etag?: string): Promise<SurfacePoll> => surfaceAt(`/rooms/${enc(id)}/surface`, etag);
```

(moving `SurfacePoll` above it if needed), and:

```ts
const eventsAt = (path: string, after: number | undefined, init?: RequestInit): Promise<EventsRead> =>
  request<EventsRead>(`${path}${after === undefined ? "" : `?after=${after}`}`, init).then((r) => r.body);

/** The room's log: the newest without `after`, then only what is past it. */
export const getEvents = (id: string, after?: number): Promise<EventsRead> => eventsAt(`/rooms/${enc(id)}/events`, after);
```

and add, after `blobUrl`:

```ts
/** Mirrors `GET /public/rooms/:id` (the Worker's src/http/public.ts): a public room's name and purpose, as its creator's words. */
export interface PublicRoom {
  id: string;
  status: "active" | "frozen" | "closed";
  closed_at: string | null;
  mode: string;
  text: Envelope<{ room: string; purpose: string | null }>;
}

/** The public reads send no cookie: there is nothing a credential could add (public rooms spec D6). */
const OMIT: RequestInit = { credentials: "omit" };

export const getPublicRoom = (id: string): Promise<PublicRoom> => request<PublicRoom>(`/public/rooms/${enc(id)}`, OMIT).then((r) => r.body);
export const getPublicSurface = (id: string, etag?: string): Promise<SurfacePoll> => surfaceAt(`/public/rooms/${enc(id)}/surface`, etag, OMIT);
export const getPublicEvents = (id: string, after?: number): Promise<EventsRead> => eventsAt(`/public/rooms/${enc(id)}/events`, after, OMIT);
/** A file a public room's surface names, for anyone: the Worker serves no other. */
export const publicBlobUrl = (id: string, blobId: string): string => `${API_ORIGIN}/public/rooms/${enc(id)}/blobs/${enc(blobId)}`;
```

- [ ] **Step 5: The polls read through what they are handed**

In `src/lib/use-surface.ts`, change the signature to `export function useSurface(roomId: string, opts: { onUnauthorized: () => void; read?: typeof getSurface })`, add `const read = opts.read ?? getSurface;` after the refs with the comment "A module-level function: a new one each render would restart the poll.", call `read(roomId, etagRef.current)` in `poll`, and make `poll`'s dependencies `[roomId, read]`. In `src/lib/use-events.ts`, the same with `read?: typeof getEvents`, `const read = opts.read ?? getEvents;` and `read(roomId, cursor.current)`.

- [ ] **Step 6: Blob URLs from the context**

In `src/components/canvas/context.ts`, add to `CanvasContextValue`:

```ts
  /** Where a blob's bytes are read: the member route, or a public room's (public rooms spec D6). */
  blobHref: (blobId: string) => string;
  /** Whether that read carries the cookie: "include" for a member, "omit" on the public page. */
  blobCredentials: RequestCredentials;
```

In `src/components/canvas/nodes.tsx`, drop `blobUrl` from the api import. `ImageNode` and `FileNode` take `const { blobHref } = useCanvas();` and use `blobHref(blob.id)` where they used `blobUrl(roomId, blob.id)`. `HtmlNode` takes `const { blobHref, blobCredentials } = useCanvas();`, computes `const href = blobId ? blobHref(blobId) : undefined;` beside `blobId`, and its effect becomes:

```tsx
  useEffect(() => {
    // A build that names no sandbox shows the note and fetches nothing.
    if (body !== null || !blobId || !href || !FRAME_URL) return;
    let gone = false;
    fetch(href, { credentials: blobCredentials })
      .then(async (res) => (res.ok ? { html: await res.text() } : { error: `The artifact could not be read (${res.status}).` }))
      .catch(() => ({ error: "The artifact could not be read." }))
      .then((result) => { if (!gone) setFetched({ id: blobId, result }); });
    return () => { gone = true; };
  // The URL as a string, not the function that made it: a context rebuilt with every poll would otherwise fetch every poll.
  }, [href, blobCredentials, body, blobId]);
```

In `src/components/canvas/canvas.tsx`, import `blobUrl` from `@/lib/api`, and replace the `ctx` line with:

```tsx
  const blobHref = useCallback((blobId: string) => blobUrl(roomId, blobId), [roomId]);
  const ctx = useMemo(() => ({ roomId, writer, onRemove, now, blobHref, blobCredentials: "include" as const }), [roomId, writer, onRemove, now, blobHref]);
```

- [ ] **Step 7: The read-only canvas, the page, the route**

Create `src/components/canvas/read-only-canvas.tsx`:

```tsx
/**
 * A public room's canvas (public rooms spec D6): the surface as members see it, polled from the
 * public routes with no cookie, and nothing to write with. The member canvas's nodes, handed the
 * public blob route and no credentials through the context.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, applyNodeChanges, type NodeChange } from "@xyflow/react";
import { getPublicSurface, publicBlobUrl } from "@/lib/api";
import { toFlow, type CanvasNode } from "@/lib/canvas";
import { useSurface } from "@/lib/use-surface";
import { CanvasProvider } from "@/components/canvas/context";
import { nodeTypes } from "@/components/canvas/nodes";

const nothing = () => undefined;

export function ReadOnlyCanvas({ roomId }: { roomId: string }) {
  // A public read has no session to lose, so a 401 never comes back and there is nowhere to send one.
  const { items, now, error } = useSurface(roomId, { onUnauthorized: nothing, read: getPublicSurface });
  const derived = useMemo(() => toFlow(items), [items]);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  // oxlint-disable-next-line react/set-state-in-effect -- React Flow's controlled nodes, held as the member canvas holds them: the derived nodes copied in, its measurements applied by onNodesChange
  useEffect(() => setNodes(derived.nodes), [derived.nodes]);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const blobHref = useCallback((blobId: string) => publicBlobUrl(roomId, blobId), [roomId]);
  const ctx = useMemo(() => ({ roomId, writer: undefined, onRemove: nothing, now, blobHref, blobCredentials: "omit" as const }), [roomId, now, blobHref]);
  return (
    <CanvasProvider value={ctx}>
      {error ? <p className="px-3 py-1 text-xs text-destructive">poll: {error}</p> : null}
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={derived.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
            nodesDraggable={false} nodesConnectable={false} fitView minZoom={0.1}>
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </CanvasProvider>
  );
}
```

Create `src/routes/public-room.tsx`, with the imports `room-detail.tsx` uses for `Link` and `cn`:

```tsx
/**
 * A public room (public rooms spec D6): dash.bellman.sh/r/<id>, for anyone with the link and no
 * account. The room's name and purpose as its creator's words, then its canvas or its log, each
 * polling the public routes with no cookie. Outside the shell: nothing here asks who is signed in.
 */
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { ReadOnlyCanvas } from "@/components/canvas/read-only-canvas"
import { LogList } from "@/components/room/room-log"
import { getPublicEvents } from "@/lib/api"
import { useEvents } from "@/lib/use-events"
import { publicRoomRoute } from "@/router"

const nothing = () => undefined

function PublicLog({ roomId }: { roomId: string }) {
  const { events, error } = useEvents(roomId, { onUnauthorized: nothing, read: getPublicEvents })
  return <LogList events={events} error={error} />
}

export function PublicRoom() {
  const { roomId } = publicRoomRoute.useParams()
  const { view } = publicRoomRoute.useSearch()
  const room = publicRoomRoute.useLoaderData()
  const log = view === "log"
  const tab = (active: boolean) =>
    cn(
      "rounded-t-lg px-3 py-1.5 text-sm",
      active ? "bg-secondary font-medium text-secondary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
    )
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="border-b border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          A public Bellman room, {room.status}. Written by {room.text.origin.label}; not verified by Bellman.
        </p>
        <h1 className="font-heading text-lg font-semibold">{room.text.data.room}</h1>
        {room.text.data.purpose ? <p className="text-sm text-muted-foreground">{room.text.data.purpose}</p> : null}
      </header>
      <nav aria-label="Room views" className="flex gap-1 border-b border-border px-3 pt-2">
        <Link to="/r/$roomId" params={{ roomId }} search={{}} className={tab(!log)} aria-current={log ? undefined : "page"}>
          Canvas
        </Link>
        <Link to="/r/$roomId" params={{ roomId }} search={{ view: "log" }} className={tab(log)} aria-current={log ? "page" : undefined}>
          Log
        </Link>
      </nav>
      {log ? <PublicLog key={roomId} roomId={roomId} /> : <ReadOnlyCanvas key={roomId} roomId={roomId} />}
    </div>
  )
}
```

In `src/router.tsx`, import `getPublicRoom` beside `getRoom`, add after `signInRoute`:

```tsx
/**
 * A public room (public rooms spec D6), outside the shell: no sign-in, so nothing here asks who
 * is signed in, and a room that is not public is the not-found screen.
 */
export const publicRoomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$roomId",
  component: lazyRouteComponent(() => import("@/routes/public-room"), "PublicRoom"),
  validateSearch: (search: Record<string, unknown>): { view?: "log" } =>
    search.view === "log" ? { view: "log" } : {},
  loader: async ({ params }) => {
    try {
      return await getPublicRoom(params.roomId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound()
      throw err
    }
  },
})
```

and add `publicRoomRoute` to `rootRoute.addChildren([...])` after `signInRoute`.

- [ ] **Step 8: The whole suite, typecheck, lint, build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: green; the build emits a chunk for the public page.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api.ts src/lib/use-surface.ts src/lib/use-events.ts src/components/canvas/context.ts src/components/canvas/nodes.tsx src/components/canvas/canvas.tsx src/components/canvas/read-only-canvas.tsx src/routes/public-room.tsx src/router.tsx src/components/canvas/nodes.test.tsx src/router.test.tsx
git commit -m "A public room's page at /r/<id>: its name, its canvas and its log, read with no cookie and no sign-in"
```

---

### Task 6: Dash: the canvas header, the designer, and the dash PR

**Files:**
- Modify: `src/lib/api.ts` (`RoomPreview.public`, `RoomDetail.mine`, `Preset.public`, `unpublishRoom`)
- Create: `src/components/canvas/public-controls.tsx`
- Modify: `src/components/canvas/canvas.tsx` (the header)
- Modify: `src/lib/presets.ts` (`Draft.public`, `draftFrom`, `emptyDraft`, `bodyOf`, `toYaml`)
- Modify: `src/components/presets/preset-editor.tsx`, `src/test-fixtures.ts`
- Test: `src/components/canvas/canvas.test.tsx`, `src/lib/presets.test.ts`, `src/components/presets/preset-editor.test.tsx`

**Interfaces:**
- Consumes: `GET /rooms/:id`'s `preview.public` (Task 4) and `mine` (Task 2); `POST /rooms/:id/unpublish` (Task 2); a preset's `public` (Task 1); Task 1's `EXPORTED`.
- Produces: `unpublishRoom(id): Promise<void>`; `PublicControls`; `Draft.public: boolean`; `toYaml` writing `public: true` after `purpose`.

- [ ] **Step 1: Write the failing tests**

In `src/test-fixtures.ts`, in `preset()`, add `public: true,` after `creator_role: "author",`.

In `src/lib/presets.test.ts`, in `EXPORTED`, directly after the `purpose:` line, insert `public: true`, so it matches bellman's `tests/room-yaml-export.test.ts` byte for byte; add `public: true` to the first `draftFrom` case's expected draft; and add:

```ts
describe("a preset's public flag", () => {
  it("is drafted from the preset, false where it has none, and sent back as the draft says", () => {
    expect(draftFrom(preset()).public).toBe(true);
    expect(draftFrom(preset({ public: undefined })).public).toBe(false);
    expect(emptyDraft().public).toBe(false);
    expect(bodyOf({ ...draftFrom(preset()), public: false }).public).toBe(false);
  });

  it("is written to the room.yaml only when the preset is public", () => {
    expect(toYaml(preset())).toContain("\npublic: true\n");
    expect(toYaml(preset({ public: false }))).not.toContain("public");
  });
});
```

In `src/components/presets/preset-editor.test.tsx`, add:

```tsx
  it("makes the preset's rooms public, and shows the joiner's view what that means", () => {
    const { last } = setup({ draft: { ...draftFrom(preset()), public: false } });
    expect(screen.queryByText("Anyone with this room's link can read its surface and its log.")).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Public/));
    expect(last().public).toBe(true);
  });

  it("tells the joiner's view a public preset's rooms are readable by anyone with the link", () => {
    setup();
    expect(screen.getByText("Anyone with this room's link can read its surface and its log.")).toBeInTheDocument();
  });
```

In `src/components/canvas/canvas.test.tsx`, add:

```tsx
describe("a public room's header", () => {
  const publicDetail = (mine: boolean) => roomDetail({ mine, preview: { ...roomDetail().preview, public: true } });

  it("marks the room public, copies its public link, and makes it private for its creator only once asked twice", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const unpublish = vi.spyOn(api, "unpublishRoom").mockResolvedValue(undefined);
    await open(publicDetail(true));
    expect(screen.getByText("Public")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/qs_1`);
    fireEvent.click(screen.getByRole("button", { name: "Make private" }));
    expect(unpublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make private for good" }));
    await flush();
    expect(unpublish).toHaveBeenCalledWith("qs_1");
    expect(screen.queryByText("Public")).toBeNull();
  });

  it("offers a member who is not the creator the link, and no way to make the room private", async () => {
    await open(publicDetail(false));
    expect(screen.getByRole("button", { name: "Copy public link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
  });

  it("says nothing of the kind for a private room", async () => {
    await open();
    expect(screen.queryByText("Public")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy public link" })).toBeNull();
  });

  it("says why when the Worker refuses, and the room still shows public", async () => {
    vi.spyOn(api, "unpublishRoom").mockRejectedValue(new api.ApiError(403, "forbidden", "only the room's creator may make it private"));
    await open(publicDetail(true));
    fireEvent.click(screen.getByRole("button", { name: "Make private" }));
    fireEvent.click(screen.getByRole("button", { name: "Make private for good" }));
    await flush();
    expect(screen.getByText("only the room's creator may make it private")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/presets.test.ts src/components/presets src/components/canvas/canvas.test.tsx`
Expected: FAIL. Drafts have no `public`, the export has no `public: true` line, the editor has no checkbox, and the canvas header shows nothing (`api.unpublishRoom` does not exist to spy on).

- [ ] **Step 3: The client and the rules**

In `src/lib/api.ts`: `RoomPreview` gains `/** Whether anyone with the room's link may read it; absent from a Worker that predates public rooms. */ public?: boolean;`, `RoomDetail` gains `/** Whether the signed-in person created the room: its creator alone may make it private. */ mine?: boolean;`, `Preset` gains `/** The default for the rooms started from it; absent on a preset saved before public rooms. */ public?: boolean;`, and add after `getRoom`:

```ts
/** Make a public room private, for good (public rooms spec D2): its creator's alone, 204 again on a retry. */
export const unpublishRoom = (id: string): Promise<void> =>
  request<void>(`/rooms/${enc(id)}/unpublish`, { method: "POST" }).then(() => undefined);
```

In `src/lib/presets.ts`: `Draft` gains `public: boolean;`; `draftFrom` sets `public: p.public ?? false,`; `emptyDraft` sets `public: false,`; `bodyOf`'s returned object gains `public: d.public,`; `toYaml`'s parameter type adds `"public"` to its `Pick`, and directly after the `purpose` line it adds `if (p.public) lines.push("public: true");`.

- [ ] **Step 4: The controls, and the header**

Create `src/components/canvas/public-controls.tsx`:

```tsx
/**
 * A public room's line in the canvas header (public rooms spec D5): that it is public, its public
 * link to copy, and, for its creator, the way to make it private, asked twice because nothing makes
 * a room public again (plan ruling R5).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function PublicControls({ roomId, mine, onMakePrivate }: { roomId: string; mine: boolean; onMakePrivate: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const link = `${window.location.origin}/r/${roomId}`;
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium" title="Anyone with this room's link can read its surface and its log.">Public</span>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy public link"}
      </Button>
      {mine && !asking ? <Button size="sm" variant="outline" onClick={() => setAsking(true)}>Make private</Button> : null}
      {mine && asking ? (
        <>
          <span className="text-xs text-muted-foreground">It cannot be made public again.</span>
          <Button size="sm" variant="destructive" onClick={() => void onMakePrivate().then(() => setAsking(false))}>Make private for good</Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
        </>
      ) : null}
    </div>
  );
}
```

In `src/components/canvas/canvas.tsx`, import `unpublishRoom` with the other api functions and `PublicControls` from `@/components/canvas/public-controls`; in `Inner`, after `writeError`'s state, add:

```tsx
  // Made private here: the loader's detail still says public until the next visit reads it again.
  const [madePrivate, setMadePrivate] = useState(false);
  const makePrivate = useCallback(async () => {
    setWriteError(null);
    try {
      await unpublishRoom(roomId);
      setMadePrivate(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    }
  }, [roomId]);
```

and in the header's right-hand group, before `<CanvasToolbar`, add:

```tsx
              {detail.preview.public && !madePrivate ? <PublicControls roomId={roomId} mine={detail.mine === true} onMakePrivate={makePrivate} /> : null}
```

- [ ] **Step 5: The designer**

In `src/components/presets/preset-editor.tsx`, directly after the `data-field="mode"` block, add:

```tsx
        <div data-field="public" className="flex items-center gap-2 self-end">
          <input id="preset-public" type="checkbox" checked={draft.public} onChange={(e) => onChange({ ...draft, public: e.target.checked })} />
          <Label htmlFor="preset-public">Public: anyone with a room's link reads its surface and its log</Label>
        </div>
```

and in "What a joiner sees", directly after its `h2`, add `{draft.public ? <p className="text-sm">Anyone with this room's link can read its surface and its log.</p> : null}`.

- [ ] **Step 6: The whole suite, typecheck, lint, build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: green.

- [ ] **Step 7: Commit, push, PR**

```bash
git add src/lib/api.ts src/components/canvas/public-controls.tsx src/components/canvas/canvas.tsx src/lib/presets.ts src/components/presets/preset-editor.tsx src/test-fixtures.ts src/components/canvas/canvas.test.tsx src/lib/presets.test.ts src/components/presets/preset-editor.test.tsx
git commit -m "The canvas marks a public room, copies its link and lets its creator make it private; the designer makes a preset's rooms public"
git push -u origin mcfearsome/public-rooms
gh pr create --repo bellman-sh/dash --base main --head mcfearsome/public-rooms --draft --title "Public rooms: the page at /r/<id>, the canvas header's controls, and the designer's checkbox" --body-file <scratchpad>/dash-public-pr-body.md
```

The body: what it adds, that the bellman PR deploys first (the page reads routes only it serves), the tests, and that dash deploys by hand once the user says so.
