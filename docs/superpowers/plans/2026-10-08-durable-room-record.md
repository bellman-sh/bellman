# The Durable Room Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A closed room is kept for the window its plan promised and then purged, bytes first; its orphaned objects are swept and credited when it closes; an org admin can read it after close, by id and by org; its creator or such an admin can delete it on demand.

**Architecture:** Two more derived handlers on `SessionDO`'s one alarm beside `outbox`, `abandoned` and `heartbeat`: `sweep`, due the moment a room closes, and `purge`, due at `closedAt + retainAfterCloseMs` or at `purgeAt` when a delete asked for it sooner. Both are computed from the record by a runtime-free module, `src/retention.ts`, that `MemoryStore` runs from `sweep(now)` and the three close paths, so the two stores answer the contract identically. The purge deletes the R2 prefix, tells the registry and the audit log directly, and only then empties the object. The admin read is a fallback in the two room routes behind the four conditions the spec names, with one new registry index per org and one new route, `DELETE /rooms/:id`.

**Tech Stack:** TypeScript, zod, vitest; Durable Objects, R2 (`list`, `delete` by batches), the outbox driver; the room routes.

**Spec:** `docs/superpowers/specs/2026-10-08-durable-room-record-design.md` (D1 to D7). Issue #65.

## Global Constraints

- Retention values: free 7 days, pro 365 days, max and team `null`; stamped on the room at creation as `retainAfterCloseMs`; a row from before this shipped hydrates to `null` (kept) and `closedAt: null`.
- The purge order is bytes, then the registry and the audit log, then the record; never the record first. The handlers are `PURGE_HANDLER = "purge"` and `SWEEP_HANDLER = "sweep"`, derived, never stored as `due:` rows.
- A purged room is gone to every reader: both listings, the org index, `getSession`, every route (404), `bellman_connect` on its codes.
- The admin read admits a caller only when all four hold: `identity.role === "admin"`, `entitlementsFor(identity).audit`, `identity.orgId` set, and the room's roster has a member whose `orgId` equals it; and only for a closed room. Membership stays the tenant boundary for an open one.
- Every `BellmanStore` method stays async; the new ones are in `tests/helpers/store-contract.ts` for both stores.
- Writing: a room holds many members; never "two sessions", "the other session", "counterpart", "the other side"; never "load-bearing" or "worth saying plainly". Commits signed (`git -c commit.gpgsign=true commit -S`), subjects in sentence case.
- `npm run verify` green before every commit.

## Review Focus

1. A purge whose R2 deletion fails midway (a thrown `delete`): the record must survive, and the next wake must purge again from the start; nothing may empty the record while objects remain. (Task 2 worker test with a bucket stub that throws once.)
2. A room closed, deleted on demand, and then its object woken by a late poll before the alarm: the reader gets a closed room (not a crash), and the purge still happens at the alarm. (Task 4 route test plus Task 2's handler order.)
3. An admin of an org whose only member of the room was removed by the creator (`removedAtCursor` set): the org still "touched" the room and the admin may read it after close; the cut applies to the member, not the admin. (Task 4 test.)
4. The sweep on a room whose surface names a blob that no longer exists in the bucket: nothing is credited for it and nothing throws; the item keeps its reference and the download answers 404 as today. (Task 3 test.)
5. A legacy row (`closed: true`, no `closedAt`, no window) read after deploy: no alarm is armed for it, nothing is purged, and `DELETE /rooms/:id` by its creator still purges it. (Task 2 worker test, Task 4 route test.)

---

### Task 1: Retention as an entitlement, stamped at creation, and `closedAt` on every close

**Files:**
- Modify: `src/types.ts` (`Entitlements.retainAfterCloseMs`; `Session.closedAt`, `Session.retainAfterCloseMs`, `Session.purgeAt`, `Session.blobsSwept`), `src/auth.ts` (`ENTITLEMENTS`), `src/tools/start.ts` (the stamp beside `blobBytesCeiling`), `src/stored-session.ts` (`hydrateStoredSession` defaults), `src/store.ts` (`MemoryStore.closeNow`), `src/store-do.ts` (`closeSession`, `closeSessionIfEmpty`, `#closeIfAbandoned`), `tests/helpers/fixtures.ts` (`session()`)
- Test: `tests/helpers/store-contract.ts`, `tests/tools/working-surface.test.ts` (beside "a room's byte ceiling"), `tests/stored-session.test.ts` (or the file that tests `hydrateStoredSession`: `grep -rln hydrateStoredSession tests/`)

**Interfaces:**
- Consumes: `ENTITLEMENTS`, `entitlementsFor`, the three close sites.
- Produces: `Session.closedAt: number | null`, `Session.retainAfterCloseMs: number | null`, `Session.purgeAt: number | null`, `Session.blobsSwept: boolean`; `Entitlements.retainAfterCloseMs: number | null`.

- [ ] **Step 1: Failing tests.** In `tests/helpers/store-contract.ts`, under the sessions group:

```ts
    it("stamps closedAt when a room closes, once, by every close path", async () => {
      const a = session({ id: "qs_close_a" });
      await store.createSession(a);
      await store.closeSession(a.id);
      const closedAt = (await store.getSession(a.id))!.closedAt;
      expect(closedAt).toBe(Date.now());
      vi.advanceTimersByTime(60_000);
      await store.closeSession(a.id);
      expect((await store.getSession(a.id))!.closedAt).toBe(closedAt);

      const b = session({ id: "qs_close_b", members: [member({ leftAt: Date.now() })] });
      await store.createSession(b);
      expect(await store.closeSessionIfEmpty(b.id)).toBe(true);
      expect((await store.getSession(b.id))!.closedAt).toBe(Date.now());
    });
```

In `tests/tools/working-surface.test.ts`, beside the ceiling case, the same `it.each` shape asserting `room.retainAfterCloseMs` equals `ENTITLEMENTS[plan].retainAfterCloseMs` for the team and free keys (team `null`, free `7 * 24 * 60 * 60 * 1000`). In the hydrate test file: a raw row with `closed: true` and no `closedAt`, `retainAfterCloseMs`, `purgeAt` or `blobsSwept` hydrates to `closedAt: null`, `retainAfterCloseMs: null`, `purgeAt: null`, `blobsSwept: false`. Run the three files; expected: red on the missing fields.

- [ ] **Step 2: The fields.** `src/types.ts`:

```ts
// Entitlements
  /**
   * How long a closed room's record and bytes are kept before the purge (#65,
   * D1): null keeps them until a creator or an org admin deletes the room.
   */
  retainAfterCloseMs: number | null;

// Session, beside `closed`
  /** When `closed` was set (#65). null while open, and on rows closed before #65. */
  closedAt: number | null;
  /** The window stamped at creation from the creator's plan (#65, D1); null keeps the room until deleted. */
  retainAfterCloseMs: number | null;
  /** A purge asked for by DELETE /rooms/:id (#65, D6): due at this time instead of the window's end. */
  purgeAt: number | null;
  /** Whether the close-time sweep of unnamed objects has run (#65, D3). */
  blobsSwept: boolean;
```

`src/auth.ts`: `retainAfterCloseMs: 7 * 24 * 60 * 60 * 1000` on free, `365 * 24 * 60 * 60 * 1000` on pro, `null` on max and team. `src/tools/start.ts`: `retainAfterCloseMs: ent.retainAfterCloseMs, closedAt: null, purgeAt: null, blobsSwept: false,` beside `blobBytesCeiling`. `src/stored-session.ts`, in the returned object: `closedAt: row.closedAt ?? null, retainAfterCloseMs: (row as { retainAfterCloseMs?: number | null }).retainAfterCloseMs ?? null, purgeAt: row.purgeAt ?? null, blobsSwept: row.blobsSwept ?? false,` with the same cast comment the ceiling has. `tests/helpers/fixtures.ts` `session()`: `closedAt: null, retainAfterCloseMs: null, purgeAt: null, blobsSwept: false,`. Fix every other literal `Session` the typecheck now flags (`npm run typecheck` lists them; `grep -rn "blobBytesCeiling:" src tests worker-tests` finds the literals).

- [ ] **Step 3: The close sites.** `MemoryStore.closeNow(s)`: set `s.closedAt ??= Date.now()` with `s.closed = true`. `SessionDO.closeSession`: `{ ...s, closed: true, closedAt: s.closedAt ?? Date.now() }`; `closeSessionIfEmpty`: the same inside its transaction; `#closeIfAbandoned`: `session: { ...s, closed: true, closedAt: s.closedAt ?? now, joinCodes: {} }`. Run the three test files green; `npm run verify`.

- [ ] **Step 4: Controls.** Remove `closedAt ??= Date.now()` from `closeNow`: the contract case goes red for MemoryStore; restore. Set `retainAfterCloseMs: null` on free in `ENTITLEMENTS`: the stamp case goes red; restore. Quote both.

- [ ] **Step 5: Commit.**

```bash
git add src/types.ts src/auth.ts src/tools/start.ts src/stored-session.ts src/store.ts src/store-do.ts tests/helpers/fixtures.ts tests/helpers/store-contract.ts tests/tools/working-surface.test.ts <hydrate test file>
git -c commit.gpgsign=true commit -S -m "Stamp a room with the window its plan keeps it after close, and record when it closed"
```

---

### Task 2: The purge: bytes, then the indexes and the audit log, then the record

**Files:**
- Create: `src/retention.ts`
- Modify: `src/blobs.ts` (`BlobStore.list`, `BlobStore.deleteAll`; `MemoryBlobStore`), `src/blobs-r2.ts` (`R2BlobStore.list`, `deleteAll`), `src/store.ts` (`BellmanStore.schedulePurge`, `MemoryStore` purge in `sweep` and `schedulePurge`, a `blobs` option), `src/store-do.ts` (`PURGE_HANDLER`, `#derivedDue`, `alarm`, `#purgeIfDue`, `schedulePurge`; `RegistryDO.dropMembershipIndex`; the facade), `src/index.ts` (hand the Node server's blob store to `MemoryStore`)
- Test: `tests/retention.test.ts`, `tests/helpers/store-contract.ts`, `tests/blobs.test.ts` (the blob-store contract, if one exists: `grep -rn describeBlobStoreContract tests worker-tests`), `worker-tests/purge.test.ts`

**Interfaces:**
- Consumes: Task 1's fields; `OutboxDriver.dueNow`/`reArm`; `RegistryDO.dropCreatedIndex`; `AuditDO.append`; `auditIntent`'s entry shape.
- Produces: `purgeDueAt(s: Pick<StoredSession, "closed" | "closedAt" | "retainAfterCloseMs" | "purgeAt">): number | null`; `BlobStore.list(sessionId): Promise<{ id: string; bytes: number }[]>` and `BlobStore.deleteAll(sessionId): Promise<number>`; `BellmanStore.schedulePurge(sessionId: string, at: number, by: string | null): Promise<"scheduled" | "open" | "missing">`; `RegistryDO.dropMembershipIndex(userId, sessionId)`; the audit action `"room_purged"` with detail `{ session_id, room }`.

- [ ] **Step 1: The runtime-free rule, test first.** `tests/retention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { purgeDueAt } from "../src/retention.js";

const base = { closed: true, closedAt: 1_000, retainAfterCloseMs: 500, purgeAt: null };
describe("purgeDueAt", () => {
  it("is the window's end for a closed room with a window", () => expect(purgeDueAt(base)).toBe(1_500));
  it("is null for an open room, whatever else it carries", () => expect(purgeDueAt({ ...base, closed: false, purgeAt: 1 })).toBeNull());
  it("is null for a closed room kept until deleted", () => expect(purgeDueAt({ ...base, retainAfterCloseMs: null })).toBeNull());
  it("is null for a row closed before the window existed", () => expect(purgeDueAt({ ...base, closedAt: null })).toBeNull());
  it("is the asked-for time when a delete set one, even sooner than the window", () => expect(purgeDueAt({ ...base, purgeAt: 1_200 })).toBe(1_200));
  it("is the asked-for time for a kept room and for a legacy row", () => {
    expect(purgeDueAt({ ...base, retainAfterCloseMs: null, purgeAt: 1_200 })).toBe(1_200);
    expect(purgeDueAt({ ...base, closedAt: null, retainAfterCloseMs: null, purgeAt: 1_200 })).toBe(1_200);
  });
});
```

`src/retention.ts`:

```ts
import type { StoredSession } from "./stored-session.js";

export const PURGE_HANDLER = "purge";
export const SWEEP_HANDLER = "sweep";

/**
 * When a closed room's record and bytes go (#65, D2, D6): the time a delete
 * asked for, else the end of the window stamped at creation, else never. An
 * open room is never due, whatever it carries. A row closed before the window
 * existed has no closedAt and is kept; only a delete reaches it.
 */
export function purgeDueAt(s: Pick<StoredSession, "closed" | "closedAt" | "retainAfterCloseMs" | "purgeAt">): number | null {
  if (!s.closed) return null;
  if (s.purgeAt !== null) return s.purgeAt;
  if (s.retainAfterCloseMs === null || s.closedAt === null) return null;
  return s.closedAt + s.retainAfterCloseMs;
}

/** The close-time sweep of unnamed objects (#65, D3) is due once, at the close. */
export function sweepDueAt(s: Pick<StoredSession, "closed" | "closedAt" | "blobsSwept">): number | null {
  if (!s.closed || s.blobsSwept || s.closedAt === null) return null;
  return s.closedAt;
}
```

(`sweepDueAt` is Task 3's; it is written here so the module is complete and the handler names are defined once.) Run: red, then green.

- [ ] **Step 2: The blob store's list and deleteAll.** In `src/blobs.ts`, on `BlobStore`:

```ts
  /** Every object under this room's prefix, ids and sizes, for the sweep and the purge (#65). */
  list(sessionId: string): Promise<{ id: string; bytes: number }[]>;
  /** Delete every object under this room's prefix; the count removed. Idempotent. */
  deleteAll(sessionId: string): Promise<number>;
```

`MemoryBlobStore`: filter `this.objects` by `blobKey(sessionId, "")` as the prefix (`rooms/<id>/`), map to `{ id: key.slice(prefix.length), bytes: meta.bytes }`; `deleteAll` deletes those keys and returns the count. `R2BlobStore`:

```ts
  async list(sessionId: string): Promise<{ id: string; bytes: number }[]> {
    const prefix = blobKey(sessionId, "");
    const out: { id: string; bytes: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) out.push({ id: o.key.slice(prefix.length), bytes: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async deleteAll(sessionId: string): Promise<number> {
    const prefix = blobKey(sessionId, "");
    let removed = 0;
    for (;;) {
      const page = await this.bucket.list({ prefix, limit: 1000 });
      if (page.objects.length === 0) return removed;
      await this.bucket.delete(page.objects.map((o) => o.key));
      removed += page.objects.length;
    }
  }
```

Confirm `blobKey(sessionId, "")` yields exactly `rooms/<id>/` (read `blobKey`); if it does not, define `const roomPrefix = (sessionId: string) => blobKey(sessionId, "")` beside it with the right shape. Add to the blob-store contract (both stores): put three objects in one room and one in another; `list` answers the three with their sizes; `deleteAll` removes exactly the three, returns 3, and a second call returns 0. Control: make `deleteAll` ignore the prefix (delete everything): the other room's object goes missing and the test goes red; restore.

- [ ] **Step 3: The store contract for the purge.** In `tests/helpers/store-contract.ts` (the harness needs a blob store: `makeStore` already builds a `MemoryStore`; add `const blobs = new MemoryBlobStore()` in the harness and construct `new MemoryStore({ blobs })` in `tests/store-memory.test.ts` or wherever `describeStoreContract("memory", ...)` is called, passing the same instance through a third harness argument `blobsFor: () => BlobStore`):

```ts
    describe("the purge (#65)", () => {
      it("purges a closed room at its window: record, listings and objects gone", async () => {
        const s = session({ id: "qs_purge", retainAfterCloseMs: 60_000 });
        await store.createSession(s);
        await blobs.put(s.id, "b_one", new Uint8Array(3).buffer, { bytes: 3, type: "text/plain", name: "a.txt", by: "m_creator", at: Date.now() });
        await store.closeSession(s.id);
        await store.sweep(Date.now());
        expect(await store.getSession(s.id)).toBeDefined();
        vi.advanceTimersByTime(60_001);
        await store.sweep(Date.now());
        expect(await store.getSession(s.id)).toBeUndefined();
        expect(await store.sessionsCreatedBy("u_jesse", 10)).not.toContain(s.id);
        expect(await store.sessionsJoinedBy("u_jesse", 10)).not.toContain(s.id);
        expect(await blobs.list(s.id)).toEqual([]);
        const audit = await store.auditForOrg("org_codenerd", 50);
        expect(audit.at(-1)).toMatchObject({ sessionId: s.id, action: "room_purged" });
      });

      it("keeps a closed room with no window, and a legacy row, until a delete asks", async () => {
        const kept = session({ id: "qs_kept", retainAfterCloseMs: null });
        await store.createSession(kept);
        await store.closeSession(kept.id);
        vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
        await store.sweep(Date.now());
        expect(await store.getSession(kept.id)).toBeDefined();
        expect(await store.schedulePurge(kept.id, Date.now(), "u_jesse")).toBe("scheduled");
        await store.sweep(Date.now());
        expect(await store.getSession(kept.id)).toBeUndefined();
      });

      it("refuses to schedule a purge of an open room, and says so for a missing one", async () => {
        const open = session({ id: "qs_open" });
        await store.createSession(open);
        expect(await store.schedulePurge(open.id, Date.now(), "u_jesse")).toBe("open");
        expect(await store.schedulePurge("qs_nope", Date.now(), "u_jesse")).toBe("missing");
      });
    });
```

For `DurableObjectStore` the same cases run in `worker-tests/store-contract.test.ts` through the harness, where `sweep` is a no-op; there, drive the purge by `runDurableObjectAlarm` on the room's stub between the two reads (the harness's divergence hook: pass `advance: async (id) => { await runDurableObjectAlarm(stub(id)) }` as a harness option, called after `sweep`). Read how `worker-tests/store-contract.test.ts` builds the harness and the stub before writing this.

- [ ] **Step 4: MemoryStore.** Constructor option `{ blobs?: BlobStore }` (default a fresh `MemoryBlobStore`; `src/index.ts` passes the one it hands the routes). `schedulePurge(id, at, by)`: missing → `"missing"`; open → `"open"`; else set `purgeAt = at`, append an audit entry `{ at: Date.now(), orgId, sessionId, actorUserId: by ?? "system", action: "room_deleted", detail: { session_id, room: s.manifest.room } }` for every distinct non-null `orgId` on the roster, return `"scheduled"`. `sweep(now)`: after the abandonment pass, for each session with `purgeDueAt(s) !== null && now >= purgeDueAt(s)`: `await this.purgeNow(s)`: `await this.blobs.deleteAll(s.id)`; push `room_purged` audit entries per org; delete the id from `byCreator`, `byMember` (every user's set) and `sessions`; drop its waiters. Also run the purge pass at the end of `closeSession` and `closeSessionIfEmpty` (a `purgeAt` already in the past is possible only through `schedulePurge`, which is enough: keep it to `sweep`).

- [ ] **Step 5: SessionDO.** Constants from `src/retention.ts`. `#derivedDue()`:

```ts
    const s = await this.stored();
    if (!s) return new Map();
    const due = new Map<string, number>();
    if (s.closed) {
      // A closed room owes two things and nothing else (#65): the sweep of its
      // unnamed objects, once, and the purge at its window or when a delete asked.
      const sweep = sweepDueAt(s);
      if (sweep !== null) due.set(SWEEP_HANDLER, sweep);
      const purge = purgeDueAt(s);
      if (purge !== null) due.set(PURGE_HANDLER, purge);
      return due;
    }
    ... (the existing abandoned and heartbeat lines)
```

`alarm()` gains `if (name === PURGE_HANDLER) await this.#purgeIfDue(now);` (and Task 3's sweep branch). The handler:

```ts
  /**
   * The purge (#65, D2). Bytes first, then what other objects hold about this
   * room, then the record: a crash between leaves a record whose next wake does
   * it all again, and never a record that names bytes that are gone. Direct
   * calls rather than the outbox, because the outbox rows live in the storage
   * the last step empties.
   */
  async #purgeIfDue(now: number): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const due = purgeDueAt(s);
    if (due === null || now < due) return;
    await new R2BlobStore(this.env.BLOBS).deleteAll(s.id);
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    await registry.dropCreatedIndex(s.createdBy, s.id);
    for (const userId of new Set(s.members.map((m) => m.userId))) await registry.dropMembershipIndex(userId, s.id);
    for (const orgId of new Set(s.members.map((m) => m.orgId).filter((o): o is string => Boolean(o)))) {
      await this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId)).append({
        at: now, orgId, sessionId: s.id, actorUserId: "system", action: "room_purged",
        detail: { session_id: s.id, room: s.manifest.room },
      }, `purge:${s.id}:${orgId}`);
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
```

(`append(entry, intentId)` deduplicates on the id, which is what makes a retried purge write one entry per org; read `AuditDO.append` to confirm the id is the dedupe key.) `schedulePurge(at, by)` on `SessionDO`: in a transaction, read; missing → `"missing"`; `!closed` → `"open"`; else put `{ ...s, purgeAt: at }`, enqueue `auditIntent` rows for `room_deleted` per org (the record still exists, so the outbox is right here), return `"scheduled"`; then `reArm()` and `deliverNow()`. The facade: `schedulePurge(id, at, by)` calls it. `RegistryDO.dropMembershipIndex(userId, sessionId)`: `delete(\`um:${userId}:${sessionId}\`)`, with the doc comment on `um:` amended: history keeps its rows until the room is purged. Note that `reArm()` after `deleteAll()` must not re-create anything: `#derivedDue` on a missing record returns an empty map, and `alarm()`'s closing `reArm()` then arms nothing; pin that in the worker test (`getAlarm()` is null after the purge).

- [ ] **Step 6: Worker tests.** `worker-tests/purge.test.ts`, in the style of `worker-tests/alarms.test.ts`: (a) a closed room with a 60 s window: `getAlarm()` is `closedAt + 60_000`; `vi.setSystemTime` past it, `runDurableObjectAlarm`; the stub's storage is empty (`runInDurableObject` and `ctx.storage.list()` size 0), `getAlarm()` null, the registry has no `us:`/`um:` rows for it, the org's `AuditDO.recent(10)` holds one `room_purged`; a second alarm run changes nothing. (b) Review Focus 1: a bucket whose `delete` throws once (wrap `env.BLOBS` in a stub object passed through a test seam, or make the first object's delete fail by putting it then making `list` return it twice: pick the simplest seam and say which): the first alarm throws out of `#purgeIfDue`, the record is still there, the next alarm purges. (c) Review Focus 5: a legacy row written directly into storage with `closed: true` and no new fields: `getAlarm()` is null after a `reArm`, `getSession` still answers it, and `schedulePurge` then purges it. (d) `schedulePurge` on an open room answers `"open"` and arms nothing.

- [ ] **Step 7: Verify, controls, commit.** Controls, quoted: swap the order in `#purgeIfDue` to `deleteAll()` first and the Review Focus 1 test goes red (the record is gone with objects left); drop `deleteAlarm()` and the `getAlarm()` assertion goes red. `npm run verify`. Then:

```bash
git add src/retention.ts src/blobs.ts src/blobs-r2.ts src/store.ts src/store-do.ts src/index.ts tests/retention.test.ts tests/helpers/store-contract.ts <blob contract test> worker-tests/purge.test.ts <memory store test file>
git -c commit.gpgsign=true commit -S -m "Purge a closed room at the end of its window, bytes first and the record last, and let a delete ask for it sooner"
```

---

### Task 3: The sweep of unnamed objects at close, with its credit

**Files:**
- Modify: `src/store.ts` (`BellmanStore.sweepBlobs`, `MemoryStore`), `src/store-do.ts` (`SWEEP_HANDLER` in `alarm`, `#sweepIfDue`, the facade), `src/blobs.ts` (nothing new; `list` from Task 2)
- Test: `tests/helpers/store-contract.ts`, `worker-tests/purge.test.ts`

**Interfaces:**
- Consumes: `sweepDueAt`, `BlobStore.list`, `BlobStore.delete`, the surface rows (`surfaceOf`).
- Produces: `BellmanStore.sweepBlobs(sessionId): Promise<{ removed: number; credited: number }>`; `Session.blobsSwept` set true after it runs.

- [ ] **Step 1: Contract test first.**

```ts
    describe("the sweep at close (#65, D3)", () => {
      it("removes the objects no item names, credits their bytes, and leaves named ones", async () => {
        const s = session({ id: "qs_sweep", blobBytesCeiling: 1_000 });
        await store.createSession(s);
        const meta = (bytes: number, name: string) => ({ bytes, type: "text/plain", name, by: "m_creator", at: Date.now() });
        await blobs.put(s.id, "b_named", new Uint8Array(10).buffer, meta(10, "named.txt"));
        await blobs.put(s.id, "b_orphan", new Uint8Array(30).buffer, meta(30, "orphan.txt"));
        await blobs.put(s.id, "b_other", new Uint8Array(5).buffer, meta(5, "other.txt"));
        await store.chargeBlobBytes(s.id, 45);
        await store.appendEvent(s.id, surfaceEventNaming("b_named"));   // see the helper note below
        await store.closeSession(s.id);
        await store.sweep(Date.now());
        expect((await blobs.list(s.id)).map((o) => o.id).sort()).toEqual(["b_named"]);
        const after = (await store.getSession(s.id))!;
        expect(after.blobBytes).toBe(10);
        expect(after.blobsSwept).toBe(true);
      });

      it("credits nothing for a named object that is already gone, and does not throw", async () => { /* a surface row naming b_gone with no object; close; sweep; blobBytes unchanged; blobsSwept true */ });
    });
```

Write `surfaceEventNaming(blobId)` in the harness as the `appendEvent` call the surface write makes with a `file` item carrying `blob: { id, bytes, type, name }` (copy the shape from an existing surface write test; the surface row is what `surfaceOf` returns). Red first.

- [ ] **Step 2: The sweep.** `MemoryStore.sweepBlobs(id)`: named = the set of `blob.id` over `surfaceOf(id)`; for each object in `blobs.list(id)` not in named: `delete` it and add its bytes; `s.blobBytes = Math.max(0, s.blobBytes - credited)`; `s.blobsSwept = true`; return counts. Run it from `sweep(now)` for every session with `sweepDueAt(s) !== null && now >= sweepDueAt(s)`, and at the end of `closeSession`/`closeSessionIfEmpty` (after the close). `SessionDO.#sweepIfDue(now)`: read the record, `sweepDueAt`, list the bucket and the `surface:` rows, delete unnamed objects (outside any transaction), then a transaction that re-reads the record and puts `{ ...s, blobBytes: Math.max(0, s.blobBytes - credited), blobsSwept: true }`. `alarm()`: `if (name === SWEEP_HANDLER) await this.#sweepIfDue(now);`. Order in `alarm()` when both `sweep` and `purge` are due at once (a zero window): `dueNow` returns names; handle `sweep` before `purge` by sorting the names with `SWEEP_HANDLER` first, or simply let the purge's `deleteAll` make the sweep moot: the simplest is to skip the sweep when `purgeDueAt(s) !== null && now >= purgeDueAt(s)`. Say which you did.

- [ ] **Step 3: Worker test, controls, commit.** In `worker-tests/purge.test.ts`: a closed room with one named and one unnamed object: after the alarm, the unnamed is gone, `blobBytes` credited, `blobsSwept` true, and a second alarm lists nothing to do (the alarm is armed at the purge, or null for a kept room). Controls, quoted: make the sweep treat every object as unnamed: the named object vanishes and the test goes red; drop the credit: `blobBytes` stays 45 and the test goes red. `npm run verify`. Then:

```bash
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts worker-tests/purge.test.ts
git -c commit.gpgsign=true commit -S -m "Sweep the objects no item names when a room closes, and credit the room their bytes"
```

---

### Task 4: An org admin's read of a closed room, the org index and list, and delete on demand

**Files:**
- Modify: `src/http/rooms.ts` (`roomDetail`, `readSurfaceRoute`, `listRooms`, a `deleteRoom` route, the dispatch), `src/projections.ts` (`roomPreview` with no seat), `src/store.ts` (`BellmanStore.sessionsForOrg`, `MemoryStore.byOrg`), `src/store-do.ts` (`RegistryDO.indexOrg`, `sessionsForOrg`, `dropOrgIndex`; the facade's `writeIndex("uo", …)` at `createSession`, `addMember`, `seatMember`; the purge drops it)
- Test: `tests/http-rooms.test.ts`, `tests/helpers/store-contract.ts`, `tests/projections.test.ts`

**Interfaces:**
- Consumes: `entitlementsFor`, `Identity.role`/`orgId`, `handlesOf`, `csrfRefusal`, `schedulePurge`.
- Produces: `BellmanStore.sessionsForOrg(orgId, limit): Promise<string[]>`; `roomPreview(session, viewerRole: string | null)`; `GET /rooms/:id` and the surface read with `viewer: "member" | "admin"`; `GET /rooms?as=admin`; `DELETE /rooms/:id`.

- [ ] **Step 1: The admit rule, in one place.** In `src/http/rooms.ts`:

```ts
/**
 * Whether this caller may read a closed room it never sat in (#65, D4): the
 * audit log's three conditions, plus the org tie on the roster. Never an open
 * room: that is its members', and the audit log is the admin's window into it.
 */
const admitsAdmin = (session: StoredSession, identity: Identity): boolean =>
  session.closed &&
  identity.role === "admin" &&
  entitlementsFor(identity).audit &&
  identity.orgId !== null &&
  session.members.some((m) => m.orgId === identity.orgId);
```

`roomDetail`: when `mine.length === 0`, if `session && admitsAdmin(session, who.identity)` answer `{ id, session_status, viewer: "admin", preview: roomPreview(session, null), members: await liveRoster(...), my_handles: [] }`; the member answer gains `viewer: "member"`. `readSurfaceRoute`: the same fallback, the whole surface with no cut, the ETag as for a member. `writeSurfaceRoute`: unchanged (no handle, 403 as today; add one test). `roomPreview(session, viewerRole: string | null)`: with `null`, `your_role: null`, `your_verbs: []`, `you_report: false`, everything else as before; `tests/projections.test.ts` pins it.

- [ ] **Step 2: Tests first, in `tests/http-rooms.test.ts`.** A new describe "an org admin's read (#65)": with the harness's dev keys, find one whose identity is `role: "admin"` on the team plan with an org (read `tests/helpers/harness.ts` `DEV_KEY`; if none is an admin, add one to the dev keys in `src/auth.ts`'s `DEV_KEYS` following the existing entries and say so). Cases: a closed room with a member of that org → 200 with `viewer: "admin"`, `my_handles: []`, `preview.your_role` null, the roster present; the same room open → 404; a closed room with no member of that org → 404; an admin on the free plan → 404; a non-admin of the org → 404; a removed member of the org (Review Focus 3) → 200; `PUT` to the surface as the admin → 403; `GET /rooms/:id/surface` as the admin → the items with an `etag`. Red first (the fallback does not exist), then green after Step 1.

- [ ] **Step 3: The org index and the list.** `RegistryDO`: `indexOrg(orgId, sessionId)` puts `uo:${orgId}:${sessionId}`, `sessionsForOrg(orgId, limit)` lists the prefix, `dropOrgIndex(orgId, sessionId)` deletes; the facade writes it through `writeIndex("uo", …)` at `createSession` (the creator's org and each initial member's), `addMember` and `seatMember` (the member's org when set), and the purge (Task 2's handler) drops it for every distinct org on the roster. `MemoryStore`: `byOrg: Map<string, Set<string>>` maintained at the same points and cleared by the purge; `sessionsForOrg` slices it. Contract case: a room created by an org member is listed for the org; a member of another org joining adds the room to that org too; a purge removes it from both. In `listRooms`: when `url.searchParams.get("as") === "admin"`: if the caller's identity lacks the admin role, the audit entitlement or an org → 403 `forbidden` "the admin list requires the team plan, the admin role and an org"; else `ids = await deps.store.sessionsForOrg(identity.orgId, MAX_ROOMS_LISTED)`, resolve each, keep `s.closed && admitsAdmin(s, identity)`, newest-closed first (`closedAt` descending, nulls last), `truncated` as the member list computes it, each entry `roomListEntry(s, userId, "closed")`, and `viewer: "admin"` on the envelope; the member list gains `viewer: "member"`. Route tests: the admin list shows only that org's closed rooms; `?as=admin` by a non-admin is 403; the member list is unchanged.

- [ ] **Step 4: Delete on demand.** Dispatch: `DETAIL` with method `DELETE` → `deleteRoom(request, id, origin, deps)`: caller or 401; `csrfRefusal(request, who.via, origin)` for a cookie; the room or 404 (a stranger and a missing room are one 404); allowed when `session.createdBy === identity.userId` or `admitsAdmin(session, identity)`, else 403 "only the room's creator or an admin of an org in it may delete it"; then `schedulePurge(id, Date.now(), identity.userId)`: `"open"` → 409 `conflict` "a room is deleted after it closes", `"scheduled"` → 202 with `{ id, purge_at }`. Update `methodNotAllowed("GET", …)` on the detail path to `"GET, DELETE"`, and the preflight's allowed methods in `src/oauth/browser.ts` if `DELETE` is not already there (it is, for the surface item; confirm). Route tests: the creator deletes a closed room → 202 and, after `store.sweep(Date.now())`, 404 on the detail and absence from the list; a member who is not the creator → 403; an admitted admin → 202; an open room → 409; a cookie caller with no `Origin` → the CSRF 403; Review Focus 2: schedule, then a `GET` before the sweep answers the closed room (200 for a member, with `session_status: "closed"`); Review Focus 5: a legacy row (`closed: true`, `closedAt: null`, `retainAfterCloseMs: null`) is deleted by its creator.

- [ ] **Step 5: Verify, controls, commit.** Controls, quoted: drop `session.closed &&` from `admitsAdmin` and the "open room → 404" case goes red; drop the org tie and the "no member of that org" case goes red; let `deleteRoom` skip the creator/admin check and the 403 case goes red. `npm run verify`. Then:

```bash
git add src/http/rooms.ts src/projections.ts src/store.ts src/store-do.ts src/auth.ts src/oauth/browser.ts tests/http-rooms.test.ts tests/helpers/store-contract.ts tests/projections.test.ts
git -c commit.gpgsign=true commit -S -m "Let an org admin read a closed room their org sat in, list those rooms, and let the creator or such an admin delete one"
```

---

### Task 5: The docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§4: the two handlers beside `outbox`, `abandoned`, `heartbeat`, and the purge order; §7: the admin read as a boundary the audit precedent bounds; §8: B2 shipped; the frontmatter's `last-verified-against-source`), `README.md` (the surface or rooms section: retention per plan, the delete, the admin read)
- Test: none beyond `npm run verify` and the writing sweep

- [ ] **Step 1: ARCHITECTURE.** In the section that lists `SessionDO`'s alarm handlers (grep `"abandoned" closes a room` or `derivedDue`), add:

```
`sweep` runs once when a room closes and deletes the objects under its R2
prefix that no surface item names, crediting the room their bytes (#65, D3).
`purge` fires at `closedAt + retainAfterCloseMs`, the window the creator's plan
stamped on the room, or at `purgeAt` when a delete asked for it sooner: bytes
first, then the registry's rows and an audit entry per org, then the record,
so a crash between leaves a record whose next wake purges again and never a
record naming bytes that are gone. Both are derived from the record, like
`abandoned`, and a closed row from before #65 carries no window and is kept.
```

In §7 add one paragraph: an org admin's read of a closed room is bounded by the audit log's three conditions plus the org tie on the roster, and never reaches an open room. In §8 mark B2 shipped. Bump `last-verified-against-source` to Task 4's commit.

- [ ] **Step 2: README.** Where plans are compared (grep `blobBytesPerRoom` or the plan table), one row: retention after close: free 7 days, pro 1 year, max and team until deleted. In the panel routes section: `DELETE /rooms/:id` by the creator or an admitted admin, 202, the purge follows; `GET /rooms?as=admin`; the admin read of a closed room. Writing sweep over the branch: `git diff origin/main..HEAD | grep -E '^\+' | grep -niE 'load-bearing|worth saying plainly|two sessions|other session|counterpart|other side'` prints nothing.

- [ ] **Step 3: Verify and commit.**

```bash
git add docs/ARCHITECTURE.md README.md
git -c commit.gpgsign=true commit -S -m "Record retention, the purge and the admin read in ARCHITECTURE and the README"
```
