# Cross-Object Atomicity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three filed bugs caused by a Durable Object's input gate covering one invocation and nothing spanning two — #59 (audit entries lost after a durable grant change), #62 (a join code nothing can resolve), #69 (an older subscription state landing after a cancellation).

**Architecture:** Two mechanisms, one shared module. `src/outbox.ts` holds named-alarm arithmetic and a durable outbox — rows enqueued inside the mutation's own transaction, delivered inline right after it commits, drained by alarm if that fails. `AuthDO` gains a `reconcile` that runs the whole purchase reconcile inside the ledger's per-user queue, so ordering is fixed by a lock rather than by delivery.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, vitest (two programs: plain Node at the repo root, `@cloudflare/vitest-pool-workers` in `worker-tests/`).

**Spec:** `docs/superpowers/specs/2026-09-29-cross-object-atomicity-design.md`

## Global Constraints

- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly.
- **`main` moves only through merges.** Feature work on a branch, landed by PR. This repo is colocated jj, but orca worktrees under `~/orca/workspaces/` are plain git worktrees — use ordinary git there.
- **Commits must be signed.** The repo-local git config sets `commit.gpgsign = false`, which overrides the global `true`, and `main`'s ruleset requires signatures. Every commit in this plan uses `git -c commit.gpgsign=true commit -S`. Verify with `git cat-file commit HEAD | grep gpgsig` — `git log --show-signature` cannot verify here.
- **Never `git add -A` or `git commit -a`.** Stage the exact paths each step names.
- **Workers-only files are excluded from the Node build**: `src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`. They import `cloudflare:workers`. Anything a vitest test must reach goes in a runtime-free module beside them — `src/outbox.ts` and `src/grant-audit.ts` in this plan, following `src/grant-index.ts` and `src/oauth/storage.ts`.
- **A room holds many members, not two.** In comments, commit messages and PR bodies say *members*, *the room*, or *peers* — never "two sessions" or "the other session".
- **Banned phrases** anywhere, including comments and commit messages: "load-bearing", "worth saying/stating/noting/knowing/recording", "structural"/"structurally". Name the consequence instead.
- `npm run verify` runs typecheck + `typecheck:worker` + build + test + `test:worker`. Run it before every PR.
- **A `// path/to/file.ts` first line in a code block labels the block, not the file.** No tracked `.ts` file in this repo opens with a path comment, so do not copy those lines into the files you write. Every other byte of a code block is verbatim.
- **Expected failure text is a hint, not a contract.** Where a step predicts a specific error string, judge whether the red is for the stated reason; vitest's wording drifts between versions. Say so in your report if it differs, and carry on.

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A grant with `orgId: null` must enqueue nothing.** `appendAudit` returns early for a null org (`store-do.ts:751`), so a row enqueued for one could never be delivered and would block the head of the queue forever. Pro purchases are the common case. → Task 7.
2. **A guarded write returning `conflict` or `missing` must enqueue nothing.** A rejected write leaving an audit trace is the bug #44 fixed on the admin path, reintroduced through a different door. → Task 7.
3. **An org move emits two rows; a delivery failure between them must lose neither and reorder neither.** FIFO plus head-of-line blocking is what guarantees it, and nothing else does. → Task 3.
4. **`setJoinCode` on a frozen session returns `false` and must enqueue nothing.** Otherwise a frozen room's rotated code gets registered anyway. → Task 10.
5. **Caller `detail` colliding with a store-filled field.** The spec's rule is caller-wins-except-`key`; the current code is `{ key, ...detail }`, which is the opposite for `key`. → Task 6.

---

## PR 1 — The mechanism

Nothing adopts the outbox in this PR. The only behaviour change is `SessionDO`'s TTL moving to a computed due set, which ships alone so its regression test is the whole point of the diff.

### Task 1: Probe — does `setAlarm` commit with the transaction?

The design rests on the outbox row and the alarm arming together. This is a throwaway probe, deleted in Step 4. Its answer changes Task 4.

**Files:**
- Create: `worker-tests/probe-alarm.test.ts` (deleted at the end of this task)

**Interfaces:**
- Consumes: nothing
- Produces: a decision recorded in this plan — `setAlarm` is transactional, or Task 4 adds opportunistic re-arming

- [ ] **Step 1: Write the probe**

```ts
// worker-tests/probe-alarm.test.ts
/** THROWAWAY (#59/#62/#69 plan, Task 1). Delete once the answer is recorded. */
import { it, expect } from "vitest";
import { env, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { RegistryDO } from "../src/store-do.js";

it("arms an alarm set inside a transaction, and keeps it across an abort", async () => {
  const id = env.REGISTRY.idFromName("probe");
  const at = Date.now() + 60_000;

  await runInDurableObject(env.REGISTRY.get(id), async (_instance: RegistryDO, ctx) => {
    await ctx.storage.transaction(async (txn) => {
      await txn.put("probe:row", { hello: "world" });
      await ctx.storage.setAlarm(at);
    });
  });

  // Tear the instance down, so what survives is what actually committed.
  await abortAllDurableObjects();

  await runInDurableObject(env.REGISTRY.get(id), async (_instance: RegistryDO, ctx) => {
    expect(await ctx.storage.get("probe:row")).toEqual({ hello: "world" });
    expect(await ctx.storage.getAlarm()).toBe(at);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:worker -- probe-alarm`

(`npm run test:worker` installs `worker-tests`' own dependency tree first, then runs vitest with `worker-tests/vitest.config.ts`. Do not reach for `npm --prefix worker-tests exec vitest` — `npm exec` keeps the caller's working directory, so vitest loads the ROOT config, whose `include` never matches a file under `worker-tests/`, and it reports "No test files found".)

Two outcomes, both fine:
- **PASS** — `setAlarm` commits with the transaction. Task 4 needs no fallback.
- **FAIL** on the `getAlarm()` line — it does not. Task 4 gains the fallback in its Step 6.

- [ ] **Step 3: Record the answer in this plan**

Edit this file. Under Task 4, Step 6, replace `PROBE RESULT: unrecorded` with `PROBE RESULT: transactional` or `PROBE RESULT: not transactional — opportunistic re-arm required`.

- [ ] **Step 4: Delete the probe**

```bash
rm worker-tests/probe-alarm.test.ts
```

- [ ] **Step 5: Commit the recorded answer**

```bash
git add docs/superpowers/plans/2026-09-29-cross-object-atomicity.md
git -c commit.gpgsign=true commit -S -m "docs: record whether setAlarm commits with its transaction"
```

---

### Task 2: Named alarm arithmetic

Pure functions, no storage. A Durable Object has exactly one alarm, and `SessionDO` already spends it on the session TTL (`store-do.ts:263`). Everything that wants an alarm from here on goes through a name.

**Files:**
- Create: `src/outbox.ts`
- Test: `tests/outbox.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `DUE_PREFIX`, `dueKey(name): string`, `earliestDue(times: Iterable<number>): number | null`, `dueNames(due: Map<string, number>, now: number): string[]`, `mergeDue(rows: Map<string, number>, derived: Map<string, number>): Map<string, number>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/outbox.test.ts
import { describe, it, expect } from "vitest";
import { DUE_PREFIX, dueKey, dueNames, earliestDue, mergeDue } from "../src/outbox.js";

describe("named alarms", () => {
  /**
   * Storage keys outlive a deploy, so a changed prefix orphans every stored
   * `due:` row. The first expectation is built from DUE_PREFIX and cannot
   * notice a change; the literal can.
   */
  it("names a due row under its own prefix", () => {
    expect(dueKey("outbox")).toBe(`${DUE_PREFIX}outbox`);
    expect(dueKey("outbox")).toBe("due:outbox");
  });

  it("picks the earliest due time, and null when nothing is scheduled", () => {
    expect(earliestDue([500, 100, 900])).toBe(100);
    // A fake clock starts at 0. That is a due time, not "nothing scheduled".
    expect(earliestDue([5, 0, 9])).toBe(0);
    // Any iterable works, including `Map.values()`, which can only be read once.
    expect(earliestDue(new Map([["a", 500], ["b", 100]]).values())).toBe(100);
    expect(earliestDue([])).toBeNull();
  });

  /**
   * The boundary is the case that bites: an alarm fires AT its due time, not
   * after it. `<` here would skip the handler at that instant and re-arm the
   * alarm to the same instant, so it spins until the clock moves on.
   */
  it("treats a handler due exactly now as due", () => {
    const due = new Map([["ttl", 1_000], ["outbox", 1_001]]);
    expect(dueNames(due, 1_000)).toEqual(["ttl"]);
    expect(dueNames(due, 1_001)).toEqual(["outbox", "ttl"]);
    expect(dueNames(due, 999)).toEqual([]);
    // Name order, whatever order the map was built in.
    expect(dueNames(new Map([["b", 0], ["c", 0], ["a", 0]]), 0)).toEqual(["a", "b", "c"]);
  });

  /**
   * Derived entries are ones an object computes rather than stores — SessionDO's
   * TTL comes from the session record. A stored row of the same name wins,
   * earlier or later than the derived time, so a handler can reschedule itself
   * past its default. A derived entry with no stored row (`gc`) survives: a
   * session written before named alarms has a derived `ttl` and nothing stored
   * to shadow it. Neither input is changed.
   */
  it("merges stored rows over derived ones, stripping the prefix", () => {
    const rows = new Map([
      [`${DUE_PREFIX}outbox`, 700],
      [`${DUE_PREFIX}ttl`, 50],
      [`${DUE_PREFIX}retry`, 900],
    ]);
    const derived = new Map([["ttl", 999], ["retry", 100], ["gc", 5]]);
    const rowsBefore = [...rows];
    const derivedBefore = [...derived];

    expect(mergeDue(rows, derived)).toEqual(
      new Map([["outbox", 700], ["ttl", 50], ["retry", 900], ["gc", 5]])
    );
    expect([...rows]).toEqual(rowsBefore);
    expect([...derived]).toEqual(derivedBefore);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/outbox.test.ts`
Expected: FAIL — `Failed to resolve import "../src/outbox.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/outbox.ts
/**
 * Durable delivery between Durable Objects, and the named alarms it needs.
 *
 * A Durable Object's input gate covers one invocation; nothing spans two. An
 * operation that mutates one object and must write to another therefore has a
 * window in the middle, and losing the second write loses it permanently —
 * there is no record anywhere that it was owed. The fix is to persist the
 * intent in the SAME transaction as the mutation, then deliver it.
 *
 * Runtime-free on purpose, for the reason CLAUDE.md gives: store-do.ts imports
 * `cloudflare:workers`, so no vitest test can reach inside it. The key layout,
 * FIFO order and backoff are the parts worth testing, so they live here.
 */

export const DUE_PREFIX = "due:";

/** One alarm per object, so every handler that wants one takes a name. */
export const dueKey = (name: string): string => `${DUE_PREFIX}${name}`;

/** The earliest of a set of due times, or null when nothing is scheduled. */
export function earliestDue(times: Iterable<number>): number | null {
  let best: number | null = null;
  for (const at of times) if (best === null || at < best) best = at;
  return best;
}

/**
 * Which handlers are due at `now`, in name order so a drain is deterministic.
 *
 * Inclusive: an alarm fires AT its due time. An exclusive comparison would
 * skip the handler at that instant, and re-arming to `earliestDue` would set
 * the alarm to the same instant again, so it spins until the clock moves on.
 */
export function dueNames(due: Map<string, number>, now: number): string[] {
  return [...due]
    .filter(([, at]) => at <= now)
    .map(([name]) => name)
    .sort();
}

/**
 * Every due time an object knows: the `due:` rows it stored, over the ones it
 * derives from state it already holds.
 *
 * Stored wins so a handler can reschedule itself past a derived default.
 */
export function mergeDue(
  rows: Map<string, number>,
  derived: Map<string, number>
): Map<string, number> {
  const out = new Map(derived);
  for (const [key, at] of rows) out.set(key.slice(DUE_PREFIX.length), at);
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/outbox.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Break it on purpose, and quote the failure**

An assertion you have not seen fail is not evidence. Change `at <= now` to `at < now` in `dueNames`, run the test, and confirm the boundary case fails with something like:

```
AssertionError: expected [] to deeply equal [ 'ttl' ]
```

Put `<=` back and re-run. Do not skip this: `<` for `<=` is the mistake most likely to survive a reading of the code, and the boundary test is the only one of the four that catches it.

- [ ] **Step 6: Commit**

```bash
git add src/outbox.ts tests/outbox.test.ts
git -c commit.gpgsign=true commit -S -m "feat: named alarm arithmetic

A Durable Object has one alarm and SessionDO already spends it on the
session TTL. Names let a second handler share it."
```

---

### Task 3: The outbox — enqueue rows and drain them

**Files:**
- Modify: `src/outbox.ts`
- Test: `tests/outbox.test.ts`

**Interfaces:**
- Consumes: Task 2's exports from `src/outbox.ts`
- Produces: `OUTBOX_PREFIX`, `OUTBOX_SEQ`, `outboxKey(seq): string`, `OutboxRow`, `OutboxIntent`, `OutboxStorage`, `enqueueRows(nextSeq, intents): Record<string, unknown>`, `backoffMs(attempts): number`, `BACKOFF_CAP_MS`, `NOISY_AFTER`, `drain(storage, deliver, now): Promise<number | null>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/outbox.test.ts`:

```ts
import {
  OUTBOX_PREFIX, OUTBOX_SEQ, backoffMs, drain, enqueueRows, outboxKey,
  type OutboxRow, type OutboxStorage,
} from "../src/outbox.js";

/** The storage a Durable Object would supply, as a plain Map. */
function fakeStorage(): OutboxStorage & { map: Map<string, unknown>; alarm: number | null } {
  const map = new Map<string, unknown>();
  const self = {
    map,
    alarm: null as number | null,
    async get<T>(key: string) { return map.get(key) as T | undefined; },
    async put<T>(entries: Record<string, T>) {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    async delete(key: string) { return map.delete(key); },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map(
        [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
      ) as Map<string, T>;
    },
    async setAlarm(at: number) { self.alarm = at; },
  };
  return self;
}

describe("outbox", () => {
  it("numbers rows from the counter and parks the counter outside the prefix", () => {
    const rows = enqueueRows(0, [
      { id: "i1", kind: "audit", payload: { a: 1 } },
      { id: "i2", kind: "audit", payload: { a: 2 } },
    ]);
    expect(Object.keys(rows).sort()).toEqual([OUTBOX_SEQ, outboxKey(0), outboxKey(1)].sort());
    expect(rows[OUTBOX_SEQ]).toBe(1);
    expect(rows[outboxKey(0)]).toEqual({ id: "i1", kind: "audit", payload: { a: 1 }, attempts: 0 });
    // The counter must not be listed by the drain that reads `ob:`, or the
    // drain hands a bare number to deliver() and can set the counter to itself.
    expect(OUTBOX_SEQ.startsWith(OUTBOX_PREFIX)).toBe(false);
  });

  it("enqueues nothing for an empty intent list", () => {
    expect(enqueueRows(7, [])).toEqual({});
  });

  it("delivers in key order and deletes each row once it lands", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "i1", kind: "audit", payload: 1 },
      { id: "i2", kind: "audit", payload: 2 },
    ]));

    const seen: unknown[] = [];
    const next = await drain(storage, async (row) => { seen.push(row.payload); }, 1_000);

    expect(seen).toEqual([1, 2]);
    expect(next).toBeNull();
    expect([...storage.map.keys()]).toEqual([OUTBOX_SEQ]);
  });

  /**
   * Review Focus 3. An org move emits two rows. If the head fails, the one
   * behind it must still be there AND must not have been delivered ahead of it.
   * An audit stream that reorders around a stuck entry is worse than one that
   * stalls, so a failing head blocks everything behind it.
   */
  it("stops at a failing row, keeps it, and leaves the ones behind it untouched", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "revoked", kind: "audit", payload: "old-org" },
      { id: "granted", kind: "audit", payload: "new-org" },
    ]));

    const seen: unknown[] = [];
    const next = await drain(storage, async (row) => {
      if (row.id === "revoked") throw new Error("AuditDO is down");
      seen.push(row.payload);
    }, 1_000);

    // Nothing delivered, because the head never landed.
    expect(seen).toEqual([]);
    // Both rows still queued, in order, with the head's attempt counted.
    expect(await storage.get<OutboxRow>(outboxKey(0)))
      .toEqual({ id: "revoked", kind: "audit", payload: "old-org", attempts: 1 });
    expect(await storage.get<OutboxRow>(outboxKey(1)))
      .toEqual({ id: "granted", kind: "audit", payload: "new-org", attempts: 0 });
    // And it asked to be woken again.
    expect(next).toBe(1_000 + backoffMs(1));
  });

  it("backs off by doubling to a five-minute cap", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(99)).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/outbox.test.ts`
Expected: FAIL. Under vitest 5 a missing named export is `undefined` at the point of use rather than an import error, so the first assertion to touch one fails — whichever assertion touches one first decides the message: a constant check gives `AssertionError: expected undefined to be 'ob:'`, and a call gives `TypeError: drain is not a function`. Either is the right reason — the export does not exist yet.

- [ ] **Step 3: Write the implementation**

Append to `src/outbox.ts`:

```ts
export const OUTBOX_PREFIX = "ob:";
/**
 * Deliberately outside OUTBOX_PREFIX. A counter inside the prefix it tracks is
 * listed by its own drain, which hands a bare number to deliver() as though it
 * were a row. The same trap is commented for the OAuth purge cursor in
 * src/oauth/store.ts.
 */
export const OUTBOX_SEQ = "ob_seq";

const SEQ_PAD = 12;
export const outboxKey = (seq: number): string =>
  `${OUTBOX_PREFIX}${String(seq).padStart(SEQ_PAD, "0")}`;

/** What a caller asks to have delivered. */
export interface OutboxIntent {
  /** Stable for this row, so a redelivery can be recognised downstream. */
  id: string;
  kind: string;
  payload: unknown;
}

/** An intent as stored, with its delivery attempts. */
export interface OutboxRow extends OutboxIntent {
  attempts: number;
}

/** The slice of Durable Object storage the outbox needs. */
export interface OutboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(at: number): Promise<void>;
}

/**
 * The storage rows one enqueue adds, for the caller to fold into its OWN
 * transaction alongside the mutation.
 *
 * Returning rows rather than writing them is the whole design: the mutation and
 * the intent to follow it up commit together or neither does. A separate write
 * here would reopen the window this module exists to close.
 */
export function enqueueRows(
  nextSeq: number,
  intents: OutboxIntent[]
): Record<string, unknown> {
  if (intents.length === 0) return {};
  const rows: Record<string, unknown> = {};
  intents.forEach((intent, i) => {
    rows[outboxKey(nextSeq + i)] = { ...intent, attempts: 0 } satisfies OutboxRow;
  });
  rows[OUTBOX_SEQ] = nextSeq + intents.length - 1;
  return rows;
}

/** 1s doubling to a five-minute cap. */
export const BACKOFF_CAP_MS = 300_000;
export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/** From this attempt on, every failure is logged. */
export const NOISY_AFTER = 5;

/**
 * Deliver queued rows in key order, head first.
 *
 * Returns when to wake again, or null when the queue is empty. A failing head
 * blocks the rows behind it on purpose: these carry an audit stream and a join
 * code index, and reordering around a stuck entry is worse than stalling.
 * Nothing is ever dropped — a permanently failing downstream object is an
 * outage, and it gets logged rather than discarded.
 */
export async function drain(
  storage: OutboxStorage,
  deliver: (row: OutboxRow) => Promise<void>,
  now: number
): Promise<number | null> {
  const rows = await storage.list<OutboxRow>({ prefix: OUTBOX_PREFIX });
  for (const [key, row] of rows) {
    try {
      await deliver(row);
      await storage.delete(key);
    } catch (err) {
      const attempts = row.attempts + 1;
      await storage.put({ [key]: { ...row, attempts } });
      if (attempts >= NOISY_AFTER) {
        console.error(`outbox: ${row.kind} ${row.id} failed ${attempts} times`, err);
      }
      return now + backoffMs(attempts);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/outbox.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Break it on purpose, and quote the failure**

The head-of-line test is an absence assertion in disguise — `expect(seen).toEqual([])` passes for free if `drain` delivers nothing at all. Prove it is real by making `drain` `continue` instead of `return` on failure, running it, and confirming the failure names the reorder:

```
AssertionError: expected [ 'new-org' ] to deeply equal []
```

Restore the `return`, re-run, confirm green. The other half of that same case — the two `storage.get` assertions on exact row contents — is what makes the absence meaningful: a positive fact sits inside the same test.

- [ ] **Step 6: Commit**

```bash
git add src/outbox.ts tests/outbox.test.ts
git -c commit.gpgsign=true commit -S -m "feat: durable outbox rows and drain

Rows are returned for the caller to fold into its own transaction, so the
mutation and the intent to follow it up commit together. A failing head
blocks the queue rather than letting delivery reorder."
```

---

### Task 4: `SessionDO` moves its TTL onto a named alarm

The one behaviour change in PR 1. Sessions deployed before this have no `due:` rows, so re-arming purely from stored rows would drop the TTL for every live session — and nothing reads an alarm back, so it would surface weeks later as rooms that never expire. The TTL is therefore derived from the session record it already lives in.

**Files:**
- Modify: `src/store-do.ts` (SessionDO: `createSession` around line 98, `alarm()` at line 263)
- Test: `worker-tests/alarms.test.ts` (create)

**Interfaces:**
- Consumes: `DUE_PREFIX`, `dueNames`, `earliestDue`, `mergeDue` from `src/outbox.ts`
- Produces: `SessionDO.alarm()` dispatching named handlers; private `derivedDue()`, `allDue()`, `reArm()` on `SessionDO`

- [ ] **Step 1: Write the failing test**

```ts
// worker-tests/alarms.test.ts
/**
 * SessionDO's TTL used to own the object's single alarm outright. It now shares
 * it by name, and this file is the proof that sharing did not lose it — for
 * sessions created before the change as well as after.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { DUE_PREFIX } from "../src/outbox.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const session = (id: string, expiresAt: number) => ({
  id, mode: "pair" as const, createdAt: Date.now(), expiresAt, closed: false,
  frozenAt: null, ownerUserId: "u_github_1", orgId: null, manifest: null,
  joinCodes: {}, members: [], events: [],
});

it("arms the session TTL through the named-alarm path", async () => {
  const store = new DurableObjectStore(env as never);
  const at = Date.now() + 3_600_000;
  await store.createSession(session("qs_ttl", at) as never);

  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_ttl")),
    async (_i: SessionDO, ctx) => {
      expect(await ctx.storage.getAlarm()).toBe(at);
    }
  );
});

/**
 * The migration case. A session written before named alarms has no `due:` row,
 * only its expiresAt. Re-arming from stored rows alone would leave it with no
 * alarm at all and it would never expire — silently, because nothing reads an
 * alarm back.
 */
it("still expires a session that has no stored due row", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session("qs_legacy", Date.now() + 3_600_000) as never);

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_legacy"));
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    // Forge the pre-migration shape: expired, and not one `due:` row anywhere.
    const stored = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...stored, expiresAt: Date.now() - 1 });
    for (const key of (await ctx.storage.list({ prefix: DUE_PREFIX })).keys()) {
      await ctx.storage.delete(key);
    }
    expect([...(await ctx.storage.list({ prefix: DUE_PREFIX })).keys()]).toEqual([]);
  });

  await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

  const after = await store.getSession("qs_legacy");
  expect(after?.closed).toBe(true);
  expect(after?.events.at(-1)).toMatchObject({ type: "session_expired" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:worker -- alarms`

The first test may pass against today's bare `setAlarm`. The second must fail once Step 3 replaces it — so confirm at least one test fails before implementing, and if both pass, temporarily delete the `setAlarm` line in `createSession` to see the first one fail, then restore it.

- [ ] **Step 3: Implement named alarms in `SessionDO`**

In `src/store-do.ts`, add to the import block:

```ts
import { DUE_PREFIX, dueNames, earliestDue, mergeDue } from "./outbox.js";
```

Replace `await this.ctx.storage.setAlarm(s.expiresAt);` in `createSession` (line 99) with:

```ts
    // TTL is enforced by an alarm rather than a global sweep. It is DERIVED
    // from the session record rather than stored as a due row: sessions written
    // before named alarms have no due row, and re-arming from stored rows alone
    // would leave every one of them with no alarm and no expiry.
    await this.reArm();
```

Add three private methods to `SessionDO`, beside `alarm()`:

```ts
  /** Due times this object computes rather than stores. */
  private async derivedDue(): Promise<Map<string, number>> {
    const s = await this.stored();
    return s && !s.closed ? new Map([["ttl", s.expiresAt]]) : new Map();
  }

  private async allDue(): Promise<Map<string, number>> {
    return mergeDue(
      await this.ctx.storage.list<number>({ prefix: DUE_PREFIX }),
      await this.derivedDue()
    );
  }

  /** Point the object's single alarm at whichever handler is soonest. */
  private async reArm(): Promise<void> {
    const next = earliestDue((await this.allDue()).values());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
```

Replace `alarm()` (line 263):

```ts
  /**
   * The object's single alarm, shared by name. Each handler decides its own
   * next due time rather than this method clearing the row, so one that throws
   * is retried instead of forgotten — which means every handler here has to be
   * idempotent, and both are.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const name of dueNames(await this.allDue(), now)) {
      if (name === "ttl") {
        const s = await this.stored();
        if (s) await this.expireIfDue(s, now);
      }
    }
    await this.reArm();
  }
```

- [ ] **Step 4: Run to verify both pass**

Run: `npm run test:worker -- alarms`
Expected: PASS, 2 tests

- [ ] **Step 5: Break it on purpose, and quote the failure**

Change `derivedDue()` to `return new Map();` — the exact mistake the migration hazard describes. Run `npm run test:worker -- alarms` and confirm the second test fails:

```
AssertionError: expected undefined to be true  // after?.closed
```

Restore and re-run.

- [ ] **Step 6: Act on the probe result, then run the full suite**

PROBE RESULT: transactional

If Task 1 recorded *not transactional*, a row can outlive the alarm that was meant to drain it. Add an opportunistic re-arm to the top of `getSession()`:

```ts
    // The arm did not commit with the transaction that scheduled it, so a queued
    // row can outlive its alarm. Re-arming on a read closes that without a
    // second storage write on the write path.
    if ((await this.ctx.storage.getAlarm()) === null) await this.reArm();
```

Run: `npm run verify`
Expected: everything green.

- [ ] **Step 7: Commit and open PR 1**

```bash
git add src/store-do.ts worker-tests/alarms.test.ts
git -c commit.gpgsign=true commit -S -m "refactor: SessionDO shares its alarm by name

The TTL is derived from the session record, not stored as a due row:
sessions written before this have no due row, and re-arming from stored
rows alone would leave every one of them unable to expire."
git push -u origin HEAD
gh pr create --fill
```

Check the commits are signed before asking for a merge:

```bash
gh api repos/bellman-sh/bellman/pulls/<n>/commits --jq '.[].commit.verification.verified'
```

---

## PR 2 — #59, the audit outbox

### Task 5: `AuditDO` deduplicates by intent id

**Files:**
- Modify: `src/store-do.ts` (AuditDO, line 547)
- Test: `worker-tests/audit-dedupe.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `AuditDO.append(entry: AuditEntry, intentId?: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// worker-tests/audit-dedupe.test.ts
import { it, expect, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import type { AuditEntry } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const entry = (action: string): AuditEntry => ({
  at: 1_000, orgId: "org_mine", sessionId: "grant:github:4242",
  actorUserId: "stripe", action, detail: { key: "github:4242" },
});

it("applies an entry once however many times it is delivered", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");

  // Exact match, not a count: a length check alone would also pass against an
  // append that silently wrote nothing at all.
  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

it("keeps entries that carry different intent ids", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");

  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});

it("still appends when no intent id is given", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"));
  await audit.append(entry("plan_granted"));

  expect(await audit.recent(10)).toEqual([entry("plan_granted"), entry("plan_granted")]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:worker -- audit-dedupe`
Expected: the first test FAILS — three identical entries come back instead of one.

- [ ] **Step 3: Implement**

In `src/store-do.ts`, add beside `auditKey` (line 36):

```ts
/** Delivered intent ids, so a redelivered audit entry is applied once. */
const deliveredKey = (intentId: string) => `d:${intentId}`;
```

Replace `AuditDO.append` (line 548):

```ts
  /**
   * Append an audit entry, at most once per intent.
   *
   * The outbox that feeds this delivers at least once — a row is deleted only
   * after this call returns, so an acknowledgement lost in flight redelivers.
   * The `d:` row is what makes that safe.
   */
  async append(entry: AuditEntry, intentId?: string): Promise<void> {
    if (intentId !== undefined && (await this.ctx.storage.get(deliveredKey(intentId)))) return;
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
    // Entry, sequence and delivery marker in one write: committed separately,
    // an interruption between them means the next entry reuses this sequence
    // number and overwrites it, or the entry lands with nothing recording that
    // its intent was delivered. An audit log that can quietly drop the record
    // of a privilege change is not an audit log.
    await this.ctx.storage.put<unknown>({
      [auditKey(seq)]: entry,
      seq,
      ...(intentId !== undefined ? { [deliveredKey(intentId)]: seq } : {}),
    });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:worker -- audit-dedupe`
Expected: PASS, 3 tests

- [ ] **Step 5: Break it on purpose, and quote the failure**

Make `append` return early unconditionally (`if (intentId !== undefined) return;`). Run the tests and confirm the first fails on its *positive* half rather than passing vacuously:

```
AssertionError: expected [] to deeply equal [ { at: 1000, ... } ]
```

That is why it is an exact match — `toHaveLength(1)` would have gone green here. Restore and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/store-do.ts worker-tests/audit-dedupe.test.ts
git -c commit.gpgsign=true commit -S -m "feat: AuditDO applies an entry once per intent id

The outbox delivers at least once; the delivery marker is what makes a
redelivery safe. It lands in the same write as the entry and the sequence."
```

---

### Task 6: The grant-audit rule, in one runtime-free place

`routes.ts` and `grants.ts` each build grant-audit entries today, and the two have already diverged once — #68 found a redelivered Stripe event appending a `plan_granted` line for a change that had not happened. `RegistryDO` is the only thing that knows `previous` and `removed` at commit time, so the rule moves next to the mutation. This task is the rule as pure functions; Task 7 wires it in.

**Files:**
- Create: `src/grant-audit.ts`
- Test: `tests/grant-audit.test.ts`

**Interfaces:**
- Consumes: `PlanGrant`, `AuditEntry` from `src/types.js`
- Produces: `AuditIntent`, `grantAuditEntries(previous, next, intent, now): AuditEntry[]`, `revokeAuditEntries(removed, intent, now): AuditEntry[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/grant-audit.test.ts
import { describe, it, expect } from "vitest";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "../src/grant-audit.js";
import type { PlanGrant } from "../src/types.js";

const NOW = 1_700_000_000_000;
const admin: AuditIntent = { actorUserId: "u_admin" };

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242", plan: "team", role: "admin", orgId: "org_mine",
  source: "operator", grantedAt: NOW, grantedBy: "u_admin", expiresAt: null, ...over,
});

describe("grantAuditEntries", () => {
  it("records a new grant against the org it lands in", () => {
    expect(grantAuditEntries(undefined, grant(), admin, NOW)).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "u_admin",
      action: "plan_granted",
      detail: {
        plan: "team", role: "admin", org_id: "org_mine", source: "operator",
        key: "github:4242",
      },
    }]);
  });

  /**
   * Stripe delivers the same event twice and delivers events for changes that
   * do not move the plan. Auditing every write would fill the org stream with
   * lines saying nothing happened.
   */
  it("records nothing when plan, role and org all match", () => {
    expect(grantAuditEntries(grant(), grant({ grantedAt: NOW + 5 }), admin, NOW)).toEqual([]);
  });

  it("records a change when any of plan, role or org moved", () => {
    expect(grantAuditEntries(grant(), grant({ plan: "pro" }), admin, NOW)).toHaveLength(1);
    expect(grantAuditEntries(grant(), grant({ role: "member" }), admin, NOW)).toHaveLength(1);
  });

  /**
   * Leaving an org is a revocation for that org, and it is the only place it
   * will ever be recorded: the grant is re-homed rather than deleted, so the
   * plan_granted goes to the new org and the old one would otherwise hear
   * nothing. A team subscription ending while a pro one continues does this.
   */
  it("revokes from the old org and grants to the new one when the org moves", () => {
    const entries = grantAuditEntries(
      grant({ orgId: "org_old" }), grant({ orgId: "org_new" }), admin, NOW
    );
    expect(entries.map((e) => [e.orgId, e.action])).toEqual([
      ["org_old", "plan_revoked"],
      ["org_new", "plan_granted"],
    ]);
    expect(entries[0].detail).toMatchObject({ moved_to: "org_new", plan: "team" });
    expect(entries[1].detail).toMatchObject({ replaced_plan: "team" });
  });

  /**
   * Review Focus 1. The audit log is org-scoped, so an org-less grant — every
   * pro purchase — has nowhere to be recorded. Emitting a row for one would
   * queue something that can never be delivered, and it sits at the head of a
   * FIFO queue blocking everything behind it.
   */
  it("records nothing for an org-less grant", () => {
    expect(grantAuditEntries(
      undefined, grant({ orgId: null, plan: "pro", role: "member" }), admin, NOW
    )).toEqual([]);
  });

  /**
   * Review Focus 5. Billing needs to say WHY on a revocation, and needs its
   * Stripe customer on a grant. The caller's detail wins over the store's so it
   * can annotate — but never over `key`, which names the record itself.
   */
  it("merges caller detail over store-filled fields, except key", () => {
    const intent: AuditIntent = {
      actorUserId: "stripe",
      detail: { stripe_customer: "cus_1", source: "purchase", key: "github:evil" },
    };
    const [entry] = grantAuditEntries(undefined, grant({ source: "purchase" }), intent, NOW);
    expect(entry.detail).toMatchObject({ stripe_customer: "cus_1", source: "purchase" });
    expect(entry.detail.key).toBe("github:4242");
  });
});

describe("revokeAuditEntries", () => {
  it("records a revocation against the org the grant was in", () => {
    const intent: AuditIntent = { actorUserId: "stripe", detail: { reason: "no longer paying" } };
    expect(revokeAuditEntries(grant(), intent, NOW)).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "stripe",
      action: "plan_revoked",
      detail: { plan: "team", reason: "no longer paying", key: "github:4242" },
    }]);
  });

  it("records nothing when the removed grant had no org", () => {
    expect(revokeAuditEntries(grant({ orgId: null }), admin, NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/grant-audit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/grant-audit.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/grant-audit.ts
import type { AuditEntry, PlanGrant } from "./types.js";

/**
 * What a grant change becomes in the audit log.
 *
 * This rule used to exist twice — once in the admin route and once in billing —
 * and the two diverged: #68 found a redelivered Stripe event appending a
 * plan_granted line for a change that had not happened. RegistryDO is the only
 * thing that knows the previous grant at commit time, so the rule lives beside
 * the mutation now and both callers stopped auditing.
 *
 * Runtime-free for the reason CLAUDE.md gives, same as grant-index.ts.
 */

/** What a caller contributes: who is acting, and anything extra to record. */
export interface AuditIntent {
  actorUserId: string;
  detail?: Record<string, unknown>;
}

/** Whether a write changed anything a reader would notice. */
function samePlan(a: PlanGrant | undefined, b: PlanGrant): boolean {
  return a !== undefined && a.plan === b.plan && a.role === b.role && a.orgId === b.orgId;
}

/**
 * One entry.
 *
 * The caller's detail is merged over the store's so billing can say why a plan
 * was revoked, or which Stripe customer paid. `key` goes last regardless: it
 * names the record this entry is about, and a caller that could rename it could
 * file an entry against a grant it does not hold.
 */
function entry(
  orgId: string,
  key: string,
  action: "plan_granted" | "plan_revoked",
  intent: AuditIntent,
  detail: Record<string, unknown>,
  now: number
): AuditEntry {
  return {
    at: now,
    orgId,
    sessionId: `grant:${key}`,
    actorUserId: intent.actorUserId,
    action,
    detail: { ...detail, ...intent.detail, key },
  };
}

/**
 * What a guarded grant WRITE should record.
 *
 * Nothing when no field a reader sees has moved. When the org moved, the old
 * org gets a revocation — that is the only place it will ever be recorded,
 * since the grant is re-homed rather than deleted.
 *
 * An org-less grant records nothing at all: the audit log is org-scoped and a
 * pro purchase has no stream to be written to. Queuing one would park a row
 * that can never be delivered at the head of a FIFO queue.
 */
export function grantAuditEntries(
  previous: PlanGrant | undefined,
  next: PlanGrant,
  intent: AuditIntent,
  now: number
): AuditEntry[] {
  if (samePlan(previous, next)) return [];
  const entries: AuditEntry[] = [];
  if (previous && previous.orgId !== null && previous.orgId !== next.orgId) {
    entries.push(entry(previous.orgId, next.key, "plan_revoked", intent, {
      plan: previous.plan, reason: "moved to another plan", moved_to: next.orgId,
    }, now));
  }
  if (next.orgId !== null) {
    entries.push(entry(next.orgId, next.key, "plan_granted", intent, {
      plan: next.plan, role: next.role, org_id: next.orgId, source: next.source,
      ...(previous ? { replaced_plan: previous.plan } : {}),
    }, now));
  }
  return entries;
}

/** What a guarded grant DELETE should record. Nothing, for an org-less grant. */
export function revokeAuditEntries(
  removed: PlanGrant,
  intent: AuditIntent,
  now: number
): AuditEntry[] {
  if (removed.orgId === null) return [];
  return [entry(removed.orgId, removed.key, "plan_revoked", intent, { plan: removed.plan }, now)];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/grant-audit.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Break it on purpose, and quote both failures**

Two of these are absence assertions a no-op satisfies. Prove both:

1. Make `grantAuditEntries` `return []` unconditionally. The "records a new grant" case must fail with `expected [] to deeply equal [ {...} ]`. Restore.
2. Drop the `next.orgId !== null` guard. The org-less case must fail with `expected [ {...orgId: null...} ] to deeply equal []`. Restore.

Quote both. If either passes, the test is not testing what it claims.

- [ ] **Step 6: Commit**

```bash
git add src/grant-audit.ts tests/grant-audit.test.ts
git -c commit.gpgsign=true commit -S -m "feat: one rule for what a grant change records

The admin route and billing each built these entries, and the two had
already diverged. Runtime-free so the rule is testable without workerd."
```

---

### Task 7: `RegistryDO` audits its own guarded writes

**Files:**
- Modify: `src/store.ts` (the `BellmanStore` interface, lines 149-175)
- Modify: `src/store-do.ts` (RegistryDO guarded writes, lines 366-428; `DurableObjectStore` delegations, lines 720-740)
- Test: `worker-tests/grant-audit-outbox.test.ts` (create)

**Interfaces:**
- Consumes: `AuditIntent`, `grantAuditEntries`, `revokeAuditEntries` from `src/grant-audit.js`; `drain`, `dueKey`, `enqueueRows`, `OUTBOX_SEQ`, `OutboxIntent`, `OutboxRow` from `src/outbox.js`
- Produces: the four guarded writes taking a third `audit: AuditIntent` argument, return types unchanged; `RegistryDO.enqueueOnly(grant, audit)` as a test seam

- [ ] **Step 1: Write the failing test**

```ts
// worker-tests/grant-audit-outbox.test.ts
import { it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type RegistryDO } from "../src/store-do.js";
import { OUTBOX_PREFIX } from "../src/outbox.js";
import type { PlanGrant } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242", plan: "team", role: "admin", orgId: "org_mine",
  source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null, ...over,
});

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const queued = async () => {
  let keys: string[] = [];
  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    keys = [...(await ctx.storage.list({ prefix: OUTBOX_PREFIX })).keys()];
  });
  return keys;
};

it("audits a guarded write, and the entry is there before the caller returns", async () => {
  const store = new DurableObjectStore(env as never);

  expect(await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }))
    .toBe("written");

  expect((await store.auditForOrg("org_mine", 10)).map((e) => [e.action, e.actorUserId, e.detail.key]))
    .toEqual([["plan_granted", "u_admin", "github:4242"]]);
});

/**
 * The bug. The grant change commits, the audit write never happens, and there
 * is no record anywhere that it was owed. Aborting the object between the
 * commit and the inline delivery is the closest reachable analogue of the
 * isolate going away mid-request.
 */
it("delivers an audit entry whose inline attempt never ran", async () => {
  const store = new DurableObjectStore(env as never);

  await runInDurableObject(registry(), async (instance: RegistryDO) => {
    await instance.enqueueOnly(grant(), { actorUserId: "u_admin" });
  });
  await abortAllDurableObjects();

  // Nothing delivered yet, and the row is still queued.
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  expect(await queued()).toHaveLength(1);

  // The alarm is the backstop, and it clears the queue.
  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect((await store.auditForOrg("org_mine", 10)).map((e) => e.action)).toEqual(["plan_granted"]);
  expect(await queued()).toEqual([]);
});

/**
 * Review Focus 2. A rejected write leaving an audit trace is the bug #44 fixed
 * on the admin path, reintroduced through a different door.
 */
it("queues and records nothing when a guarded write is refused", async () => {
  const store = new DurableObjectStore(env as never);
  await store.putGrant(grant({ orgId: "org_theirs" }));

  expect(await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }))
    .toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_admin" }))
    .toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:nobody", "org_mine", { actorUserId: "u_admin" }))
    .toBe("missing");

  // Both orgs, so a misfiled entry cannot hide in the one we did not check.
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
  expect(await queued()).toEqual([]);
  // And the grant is untouched, so the emptiness above is about the audit
  // rather than about the whole call having done nothing.
  expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
});

/**
 * Review Focus 1. Every pro purchase is org-less. A row queued for one could
 * never be delivered, and it would sit at the head of a FIFO queue blocking
 * every audit entry behind it.
 */
it("queues nothing for an org-less grant", async () => {
  const store = new DurableObjectStore(env as never);

  const written = await store.putGrantIfSource(
    grant({ orgId: null, plan: "pro", role: "member", source: "purchase" }),
    "purchase",
    { actorUserId: "stripe" }
  );
  expect(written.outcome).toBe("written");

  expect(await queued()).toEqual([]);
  expect(await store.getGrant("github:4242")).toMatchObject({ plan: "pro", orgId: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:worker -- grant-audit-outbox`
Expected: FAIL — `putGrantIfOwned` takes two arguments, and `enqueueOnly` does not exist.

- [ ] **Step 3: Update the `BellmanStore` interface**

In `src/store.ts`, add:

```ts
import type { AuditIntent } from "./grant-audit.js";
export type { AuditIntent } from "./grant-audit.js";
```

Replace the four guarded-write signatures (lines 149-175):

```ts
  /**
   * Write a grant only if the key is unowned or already belongs to
   * `expectedOrgId`, and record what changed.
   *
   * The check, the write and the audit intent are one operation. A caller that
   * reads with getGrant and then writes has given the object a window to serve
   * another org's write in between; a caller that writes and then audits has
   * given it a window to lose the record of a change that already happened.
   * `audit` carries only what the store cannot see — who is acting, and any
   * detail to annotate the entry with. See grant-audit.ts for the rule.
   */
  putGrantIfOwned(
    grant: PlanGrant, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"written" | "conflict">;
  /** Delete a grant only if it belongs to `expectedOrgId`, and say what happened. */
  deleteGrantIfOwned(
    key: string, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict">;
  /**
   * Write a grant only if the key is unowned or already carries
   * `expectedSource`.
   *
   * The second writer. An admin claims a key by org, which is what
   * putGrantIfOwned checks; billing claims by having written it, because a
   * lapsing subscription must not revoke a plan an operator granted by hand.
   * Same atomicity argument either way.
   */
  putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite>;
  /** Delete a grant only if it carries `expectedSource`, and say what happened. */
  deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete>;
```

- [ ] **Step 4: Implement in `RegistryDO`**

In `src/store-do.ts`, extend the imports:

```ts
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
import {
  DUE_PREFIX, drain, dueKey, dueNames, earliestDue, enqueueRows, mergeDue,
  OUTBOX_SEQ, type OutboxIntent, type OutboxRow,
} from "./outbox.js";
```

Change the class declaration so `RegistryDO` can reach the audit objects (the `BellmanEnv` interface is declared later in the same file, which is fine — interfaces hoist):

```ts
export class RegistryDO extends DurableObject<BellmanEnv> {
```

Add these members to `RegistryDO`:

```ts
  /** The queue of writes this object owes other objects. */
  private get outboxStorage() {
    return {
      get: <T>(key: string) => this.ctx.storage.get<T>(key),
      put: <T>(entries: Record<string, T>) => this.ctx.storage.put<T>(entries),
      delete: (key: string) => this.ctx.storage.delete(key),
      list: <T>(options: { prefix: string }) => this.ctx.storage.list<T>(options),
      setAlarm: (at: number) => this.ctx.storage.setAlarm(at),
    };
  }

  /**
   * Rows for the audit entries an operation owes, to fold into ITS transaction.
   *
   * Returned rather than written, because the point is that the grant change and
   * the record of it commit together. Empty for an org-less grant: the audit log
   * is org-scoped, and a row that could never be delivered would sit at the head
   * of a FIFO queue blocking everything behind it.
   */
  private async auditRows(
    txn: { get<T>(key: string): Promise<T | undefined> },
    entries: AuditEntry[]
  ): Promise<Record<string, unknown>> {
    if (entries.length === 0) return {};
    const nextSeq = ((await txn.get<number>(OUTBOX_SEQ)) ?? -1) + 1;
    const intents: OutboxIntent[] = entries.map((entry) => ({
      id: crypto.randomUUID(),
      kind: "audit",
      payload: entry,
    }));
    return { ...enqueueRows(nextSeq, intents), [dueKey("outbox")]: Date.now() };
  }

  /** Try to clear the queue now; the alarm covers it if this never runs. */
  private async deliverNow(): Promise<void> {
    const next = await drain(this.outboxStorage, (row) => this.deliver(row), Date.now());
    if (next === null) {
      await this.ctx.storage.delete(dueKey("outbox"));
      return;
    }
    await this.ctx.storage.put({ [dueKey("outbox")]: next });
    await this.reArm();
  }

  private async deliver(row: OutboxRow): Promise<void> {
    if (row.kind !== "audit") throw new Error(`outbox: unknown kind ${row.kind}`);
    const entry = row.payload as AuditEntry;
    if (entry.orgId === null) return; // no stream to deliver it to; drop the row
    await this.env.AUDIT.get(this.env.AUDIT.idFromName(entry.orgId)).append(entry, row.id);
  }

  private async allDue(): Promise<Map<string, number>> {
    return mergeDue(await this.ctx.storage.list<number>({ prefix: DUE_PREFIX }), new Map());
  }

  private async reArm(): Promise<void> {
    const next = earliestDue((await this.allDue()).values());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    for (const name of dueNames(await this.allDue(), Date.now())) {
      if (name === "outbox") await this.deliverNow();
    }
    await this.reArm();
  }

  /**
   * TEST SEAM. Commit a guarded write and its audit intent WITHOUT the inline
   * delivery, so a test can reproduce an isolate dying in that gap. Nothing in
   * production calls this.
   */
  async enqueueOnly(grant: PlanGrant, audit: AuditIntent): Promise<void> {
    await this.putGrantIfOwnedTxn(grant, grant.orgId, audit);
  }
```

Split `putGrantIfOwned` (line 366) into a transaction half and a delivering wrapper:

```ts
  /** The transaction half: check, write, and queue the record of it. */
  private async putGrantIfOwnedTxn(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      // A lapsed grant is not a grant — the same rule getGrant applies. Letting
      // an expired record from another org answer this check would block the
      // key indefinitely, because nothing sweeps it until someone reads it.
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.orgId !== expectedOrgId) return "conflict" as const;
      // The stale entry to clear is the one actually in storage, expired or not.
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.auditRows(
        txn, grantAuditEntries(previous, grant, audit, Date.now())
      );
      // Grant, index and the intent to record it, in one commit. A refused
      // write reaches none of this, so it queues nothing.
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return "written" as const;
    });
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict"> {
    const outcome = await this.putGrantIfOwnedTxn(grant, expectedOrgId, audit);
    if (outcome === "written") await this.deliverNow();
    return outcome;
  }
```

Now the other three, same shape. Note where `auditRows` sits in each: after every guard, so a refused write reaches it and queues nothing.

```ts
  private async deleteGrantIfOwnedTxn(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return "missing" as const;
      if (lapsed(existing)) {
        // Already gone as far as every reader is concerned; tidy it away and
        // say so, rather than reporting a revocation of something inert — and
        // record nothing, for the same reason.
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return "missing" as const;
      }
      if (existing.orgId !== expectedOrgId) return "conflict" as const;
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.auditRows(txn, revokeAuditEntries(existing, audit, Date.now()))
      );
      return "deleted" as const;
    });
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const outcome = await this.deleteGrantIfOwnedTxn(key, expectedOrgId, audit);
    if (outcome === "deleted") await this.deliverNow();
    return outcome;
  }

  private async putGrantIfSourceTxn(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.source !== expectedSource) return { outcome: "conflict" as const };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.auditRows(
        txn, grantAuditEntries(previous, grant, audit, Date.now())
      );
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return { outcome: "written" as const, previous };
    });
  }

  async putGrantIfSource(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    const result = await this.putGrantIfSourceTxn(grant, expectedSource, audit);
    if (result.outcome === "written") await this.deliverNow();
    return result;
  }

  private async deleteGrantIfSourceTxn(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return { outcome: "missing" as const };
      if (lapsed(existing)) {
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return { outcome: "missing" as const };
      }
      if (existing.source !== expectedSource) return { outcome: "conflict" as const };
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.auditRows(txn, revokeAuditEntries(existing, audit, Date.now()))
      );
      return { outcome: "deleted" as const, removed: existing };
    });
  }

  async deleteGrantIfSource(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    const result = await this.deleteGrantIfSourceTxn(key, expectedSource, audit);
    if (result.outcome === "deleted") await this.deliverNow();
    return result;
  }
```

A `txn.put({})` with no keys is a no-op, so the two delete paths need no `if` around their `auditRows` result — an org-less grant simply writes nothing.

Update the four `DurableObjectStore` delegations (lines 720-740) to pass the third argument:

```ts
  async putGrantIfOwned(
    grant: PlanGrant, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"written" | "conflict"> {
    return this.registry.putGrantIfOwned(grant, expectedOrgId, audit);
  }
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm run test:worker -- grant-audit-outbox`
Expected: PASS, 4 tests

- [ ] **Step 6: Break it on purpose, and quote all three failures**

Three of these assert emptiness and would go green against a store that never audits at all:

1. Make `auditRows` `return {}` unconditionally. The first test must fail with `expected [] to deeply equal [ [ 'plan_granted', 'u_admin', 'github:4242' ] ]`, and the second on its `toHaveLength(1)`.
2. Move the `auditRows` call *above* the `conflict` return in `putGrantIfOwnedTxn`. The refused-write test must fail with a queued row.
3. Drop the `next.orgId !== null` guard in `grantAuditEntries` (Task 6). The org-less test must fail with a queued row.

Restore after each. Quote all three.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/store-do.ts worker-tests/grant-audit-outbox.test.ts
git -c commit.gpgsign=true commit -S -m "feat: RegistryDO audits its own guarded grant writes

The grant change and the intent to record it commit in one transaction,
so a lost audit write is recoverable rather than gone. Delivery is tried
inline; the alarm is the backstop."
```

---

### Task 8: `MemoryStore` matches, and the contract suite holds both to it

**Files:**
- Modify: `src/store.ts` (MemoryStore, lines 476-516)
- Modify: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: the interface from Task 7; `grantAuditEntries`, `revokeAuditEntries` from `src/grant-audit.js`
- Produces: `MemoryStore` conforming to the new signatures

- [ ] **Step 1: Write the failing contract cases**

Add to `tests/helpers/store-contract.ts`, in the same `describe` as the existing grant cases:

```ts
    /**
     * A grant change and the record of it are one operation. Every caller used
     * to write the grant and then audit it, and losing the second write lost the
     * record permanently — the retry returns "missing" and cannot tell that the
     * change already happened.
     */
    it("records a guarded grant write in the affected org", async () => {
      const grant = {
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };

      expect(await store.putGrantIfOwned(grant, "org_mine", { actorUserId: "u_admin" }))
        .toBe("written");

      expect((await store.auditForOrg("org_mine", 10)).map((e) => [e.action, e.actorUserId]))
        .toEqual([["plan_granted", "u_admin"]]);
    });

    it("records nothing when a guarded write changes nothing a reader sees", async () => {
      const grant = {
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      await store.putGrantIfOwned(grant, "org_mine", { actorUserId: "u_admin" });
      await store.putGrantIfOwned(
        { ...grant, grantedAt: Date.now() + 10 }, "org_mine", { actorUserId: "u_admin" }
      );

      // Exactly one, and it is the first: a length check alone would also pass
      // against a store that recorded nothing at all.
      expect((await store.auditForOrg("org_mine", 10)).map((e) => e.action))
        .toEqual(["plan_granted"]);
    });

    it("records a revocation against the org the grant was in", async () => {
      await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      });

      expect(await store.deleteGrantIfOwned("github:4242", "org_mine",
        { actorUserId: "u_admin", detail: { reason: "left the team" } })).toBe("deleted");

      const [entry] = await store.auditForOrg("org_mine", 10);
      expect(entry).toMatchObject({
        action: "plan_revoked", actorUserId: "u_admin",
        detail: { key: "github:4242", plan: "team", reason: "left the team" },
      });
    });

    /**
     * The grant is re-homed rather than deleted, so without this the org it left
     * would never hear that it lost an admin. A team subscription ending while a
     * pro one continues does exactly this.
     */
    it("records both halves when a grant moves between orgs", async () => {
      const base = {
        key: "github:4242", plan: "team" as const, role: "admin" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      await store.putGrantIfSource({ ...base, orgId: "org_old" }, "purchase",
        { actorUserId: "stripe" });
      await store.putGrantIfSource({ ...base, orgId: "org_new" }, "purchase",
        { actorUserId: "stripe" });

      expect((await store.auditForOrg("org_old", 10)).map((e) => e.action))
        .toEqual(["plan_granted", "plan_revoked"]);
      expect((await store.auditForOrg("org_new", 10)).map((e) => e.action))
        .toEqual(["plan_granted"]);
    });

    it("records nothing for a refused guarded write, in either org", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      await store.putGrant({ ...base, orgId: "org_theirs" });

      expect(await store.putGrantIfOwned({ ...base, orgId: "org_mine" }, "org_mine",
        { actorUserId: "u_admin" })).toBe("conflict");

      expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
      expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
      // The grant is untouched, so the emptiness above is about the audit
      // rather than about the whole call having done nothing.
      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
    });
```

Then update the existing guarded-write calls in this file (around lines 869, 880, 895-899, 917, 935, 951-953, 963-976, 1001-1002) to pass a third argument `{ actorUserId: "u_test" }`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `putGrantIfOwned` takes two arguments in `MemoryStore`.

- [ ] **Step 3: Implement in `MemoryStore`**

In `src/store.ts`, add:

```ts
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
```

Replace the four `MemoryStore` guarded writes:

```ts
  /**
   * No outbox here. There is one process and one array, so the audit write
   * cannot fail independently of the grant write and there is no gap to
   * protect. The Durable Object store needs one because its audit lives in a
   * different object; both owe the same observable result, which is what the
   * contract suite checks.
   */
  private recordAudit(entries: AuditEntry[]): void {
    for (const entry of entries) this.audit.push(detach(entry));
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict"> {
    // liveGrant, not the raw map: a lapsed grant is defined as absent
    // everywhere else, and reading past that here would let a dead record from
    // another org hold a key hostage until some unrelated read swept it.
    const existing = this.liveGrant(grant.key);
    if (existing && existing.orgId !== expectedOrgId) return "conflict";
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(grantAuditEntries(existing, grant, audit, Date.now()));
    return "written";
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const existing = this.liveGrant(key);
    if (!existing) return "missing";
    if (existing.orgId !== expectedOrgId) return "conflict";
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(existing, audit, Date.now()));
    return "deleted";
  }

  async putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite> {
    const previous = this.liveGrant(grant.key);
    if (previous && previous.source !== expectedSource) return { outcome: "conflict" };
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(grantAuditEntries(previous, grant, audit, Date.now()));
    // Detached after the write, because the caller is handed this and the
    // stored object must not be reachable through it.
    return { outcome: "written", previous: previous && detach(previous) };
  }

  async deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete> {
    const removed = this.liveGrant(key);
    if (!removed) return { outcome: "missing" };
    if (removed.source !== expectedSource) return { outcome: "conflict" };
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(removed, audit, Date.now()));
    return { outcome: "deleted", removed: detach(removed) };
  }
```

Note `putGrantIfSource` reads `previous` before the write and passes the same value to both `grantAuditEntries` and the return, so the audit and the reported `previous` can never disagree.

- [ ] **Step 4: Run both programs**

Run: `npx vitest run tests/store.test.ts && npm run test:worker`
Expected: PASS in both. The new cases run against `DurableObjectStore` too, which is what makes the interface a seam rather than a comment.

- [ ] **Step 5: Break it on purpose, and quote the failure**

Make `recordAudit` a no-op. Run `npx vitest run tests/store.test.ts` and confirm the "records nothing when a guarded write changes nothing" case fails — not only the positive ones:

```
AssertionError: expected [] to deeply equal [ 'plan_granted' ]
```

That case is the one most at risk of being vacuous, and this is the proof it is not. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "feat: MemoryStore audits its guarded grant writes

Delivered inline: one process, one array, no gap to protect. The contract
suite holds both stores to the same observable result."
```

---

### Task 9: Both callers stop auditing on the grant path

**Files:**
- Modify: `src/oauth/routes.ts` (lines 893-917; delete `recordGrantAudit` at 941-965)
- Modify: `src/billing/grants.ts` (delete `auditPurchase` and `samePlan`; rewrite `PurchaseGrantStore` and `reconcilePurchase`)
- Test: `tests/billing-grants.test.ts`, `tests/oauth-flow.test.ts`

**Interfaces:**
- Consumes: the guarded writes from Tasks 7-8
- Produces: `PurchaseGrantStore` without `appendAudit`; `reconcilePurchase(userId, billing, plans)` with its return type unchanged

- [ ] **Step 1: Update the admin route**

In `src/oauth/routes.ts`, replace the POST branch's write plus audit (lines 893-898):

```ts
      // The org check above validates what the caller CLAIMS. This checks what
      // is stored, and does it in the same operation as the write and the audit
      // record: read-then-write let another org's admin land a grant for the
      // same key in the gap, and write-then-audit let the record of a change
      // that already happened be lost with no way to retry it.
      if ((await config.plans.putGrantIfOwned(grant, identity.orgId,
        { actorUserId: identity.userId })) === "conflict") {
        return oauthError("insufficient_scope", "that key already has a grant in another org", 403);
      }
      return json({ granted: grant }, 201);
```

And the DELETE branch (lines 910-916):

```ts
      const outcome = await config.plans.deleteGrantIfOwned(key, identity.orgId,
        { actorUserId: identity.userId });
      if (outcome !== "deleted") {
        return oauthError("insufficient_scope", "no such grant in your org", 403);
      }
      return json({ revoked: key });
```

Delete `recordGrantAudit` and its doc comment (lines 941-965), plus any import left unused.

- [ ] **Step 2: Rewrite `reconcilePurchase`**

In `src/billing/grants.ts`, delete `auditPurchase` and `samePlan` — both live in `grant-audit.ts` now — and replace:

```ts
/** The slice of the store billing writes through. The store audits, not us. */
export interface PurchaseGrantStore {
  putGrantIfSource(grant: PlanGrant, expectedSource: string, audit: AuditIntent): Promise<GrantWrite>;
  deleteGrantIfSource(key: string, expectedSource: string, audit: AuditIntent): Promise<GrantDelete>;
}

/**
 * Make the stored grant match what this user is currently paying for.
 *
 * Called after anything that can change the answer. It reads the ledger rather
 * than the event, because a user may have several subscriptions and several
 * Stripe customers, and the plan is the best of them — an event tells you one
 * subscription changed, not what the total comes to.
 *
 * A grant an operator wrote by hand is never touched: a lapsing subscription is
 * not a reason to revoke a plan somebody was comped. Those come back as
 * "conflict", which is reported, not retried — a human has to decide.
 *
 * The audit record is the store's job now, written in the same transaction as
 * the grant change. Auditing here meant a failed append after a durable delete
 * was lost for good: Stripe retried, the delete returned "missing", and the
 * revocation never reached the org's stream.
 */
export async function reconcilePurchase(
  userId: string,
  billing: BillingStorage,
  plans: PurchaseGrantStore
): Promise<"written" | "deleted" | "missing" | "conflict" | "unkeyable"> {
  const key = grantKeyForUser(userId);
  // canPurchaseAs, not just a recoverable key: a user id that would produce an
  // org too long for the store is one whose team grant would be refused after
  // the money was taken. /upgrade turns those away before Stripe, and this is
  // the same rule on the write side for anything that got past it.
  if (!key || !canPurchaseAs(userId)) return "unkeyable";

  const paid = await billing.paidPlan(userId);

  if (!paid) {
    const { outcome } = await plans.deleteGrantIfSource(key, PURCHASE, {
      actorUserId: "stripe",
      detail: { reason: "subscription no longer paying" },
    });
    return outcome;
  }

  const grant = purchaseGrant(key, paid.plan, userId);
  const { outcome } = await plans.putGrantIfSource(grant, PURCHASE, {
    actorUserId: "stripe",
    detail: { stripe_customer: paid.customerId },
  });
  return outcome;
}
```

Add `import type { AuditIntent } from "../grant-audit.js";` and drop the now-unused `AuditEntry` import.

- [ ] **Step 3: Run the suites to see what moved**

Run: `npx vitest run tests/billing-grants.test.ts tests/oauth-flow.test.ts`
Expected: several FAIL — the cases asserting audit entry shape now assert behaviour owned by `grant-audit.ts` and the contract suite.

Read each failure before editing it. A test that fails after a change knows something the source does not say, and on this repo that has twice turned out to be the test being right.

- [ ] **Step 4: Update the moved assertions**

In `tests/billing-grants.test.ts`, keep only the cases asserting that `reconcilePurchase` reaches the right store call with the right intent; entry *shape* is covered by `tests/grant-audit.test.ts`. For example:

```ts
  it("tells the store who is acting and why, on a revocation", async () => {
    const plans = new MemoryStore();
    const billing = new MemoryBillingStore();
    await plans.putGrant(purchaseGrant("github:4242", "team", user));

    expect(await reconcilePurchase(user, billing, plans)).toBe("deleted");

    expect((await plans.auditForOrg(orgForUser(user), 10)).map((e) => [e.actorUserId, e.action]))
      .toEqual([["stripe", "plan_revoked"]]);
  });
```

- [ ] **Step 5: Run everything**

Run: `npm run verify`
Expected: all green.

- [ ] **Step 6: Commit and open PR 2**

```bash
git add src/oauth/routes.ts src/billing/grants.ts tests/billing-grants.test.ts tests/oauth-flow.test.ts
git -c commit.gpgsign=true commit -S -m "fix: a grant change and its audit record commit together (#59)

Both callers audited after a durable mutation. If the audit write failed
the change had already happened, and the retry returned missing — so the
record was lost with nothing indicating it. The store records it now,
inside the transaction that makes the change.

Closes #59"
git push -u origin HEAD
gh pr create --fill
```

---

## PR 3 — #62 and #69

Both adopt a mechanism already merged and reviewed, and they touch disjoint files.

### Task 10: `SessionDO` owns join-code registration

**Files:**
- Modify: `src/store-do.ts` (`SessionDO.createSession`, `setJoinCode`, `consumeJoinCode`, `clearJoinCodes`; `DurableObjectStore` lines 595, 621-638)
- Test: `worker-tests/join-code-outbox.test.ts` (create)

**Interfaces:**
- Consumes: `drain`, `dueKey`, `enqueueRows`, `OUTBOX_SEQ`, `OutboxRow` from `src/outbox.js`
- Produces: `SessionDO extends DurableObject<BellmanEnv>`; `SessionDO.setJoinCode` returning `Promise<boolean>`; `SessionDO.enqueueOnly(s)` as a test seam

- [ ] **Step 1: Write the failing test**

```ts
// worker-tests/join-code-outbox.test.ts
/**
 * A stale registry row is already inert: getSessionByJoinCode re-reads the
 * session and requires the code to still match a live joinCodes entry. The
 * direction that was open is the opposite one — a session holding a code the
 * registry never learned about, which nobody can join and no scan can find,
 * because a Durable Object namespace cannot be enumerated.
 */
import { it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { OUTBOX_PREFIX } from "../src/outbox.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const session = (id: string, code: string) => ({
  id, mode: "pair" as const, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
  closed: false, frozenAt: null, ownerUserId: "u_github_1", orgId: null, manifest: null,
  joinCodes: { member: { code, expiresAt: Date.now() + 3_600_000 } },
  members: [], events: [],
});

const queued = async (id: string) => {
  let keys: string[] = [];
  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName(id)),
    async (_i: SessionDO, ctx) => {
      keys = [...(await ctx.storage.list({ prefix: OUTBOX_PREFIX })).keys()];
    }
  );
  return keys;
};

it("registers a join code, so the room can be joined immediately", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session("qs_join", "BELL-AAA-01") as never);

  // Inline delivery, not the alarm: handing someone a code straight after
  // creating a room has to work.
  expect((await store.getSessionByJoinCode("BELL-AAA-01"))?.role).toBe("member");
});

it("recovers a registration whose inline attempt never ran", async () => {
  const store = new DurableObjectStore(env as never);
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_lost"));

  await runInDurableObject(stub, async (instance: SessionDO) => {
    await instance.enqueueOnly(session("qs_lost", "BELL-BBB-02") as never);
  });
  await abortAllDurableObjects();

  // Unjoinable, and the intent is still queued.
  expect(await store.getSessionByJoinCode("BELL-BBB-02")).toBeUndefined();
  expect(await queued("qs_lost")).toHaveLength(1);

  expect(await runDurableObjectAlarm(env.SESSION.get(env.SESSION.idFromName("qs_lost")))).toBe(true);

  expect((await store.getSessionByJoinCode("BELL-BBB-02"))?.session.id).toBe("qs_lost");
  expect(await queued("qs_lost")).toEqual([]);
});

/**
 * Review Focus 4. setJoinCode returns false for a frozen session and writes
 * nothing. Queuing the registration anyway would register a code for a room
 * that refused to issue it.
 */
it("queues nothing when setJoinCode is refused", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session("qs_frozen", "BELL-CCC-03") as never);
  await store.freezeSession("qs_frozen", Date.now());
  const before = await queued("qs_frozen");

  expect(await store.setJoinCode("qs_frozen", "member", "BELL-DDD-04", Date.now() + 1_000))
    .toBe(false);

  expect(await store.getSessionByJoinCode("BELL-DDD-04")).toBeUndefined();
  expect(await queued("qs_frozen")).toEqual(before);
  // And the original code still resolves, so the emptiness above is about the
  // refused call rather than about registration being broken outright.
  expect((await store.getSessionByJoinCode("BELL-CCC-03"))?.role).toBe("member");
});
```

`freezeSession(sessionId, frozenAt)` is the facade method at `store-do.ts:657`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:worker -- join-code-outbox`
Expected: FAIL — `enqueueOnly` does not exist on `SessionDO`.

- [ ] **Step 3: Implement**

In `src/store-do.ts`, change the class declaration:

```ts
export class SessionDO extends DurableObject<BellmanEnv> {
```

Add the same `outboxStorage`, `deliverNow` and `reArm` members `RegistryDO` gained in Task 7, with this `deliver` and an `alarm()` that dispatches both names:

```ts
  private async deliver(row: OutboxRow): Promise<void> {
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    const { code, sessionId } = row.payload as { code: string; sessionId?: string };
    if (row.kind === "join_code_put") await registry.putJoinCode(code, sessionId!);
    else if (row.kind === "join_code_drop") await registry.dropJoinCode(code);
    else throw new Error(`outbox: unknown kind ${row.kind}`);
  }
```

In `alarm()` from Task 4, add the second handler beside the `ttl` branch:

```ts
      if (name === "outbox") await this.deliverNow();
```

Add a helper that builds registration rows, so all four mutators agree:

```ts
  /**
   * Rows for the registry writes a join-code change owes, to fold into the
   * session write's own transaction. A refused mutation never calls this, so it
   * queues nothing.
   */
  private async joinCodeRows(
    codes: Array<{ kind: "join_code_put" | "join_code_drop"; code: string; sessionId?: string }>
  ): Promise<Record<string, unknown>> {
    if (codes.length === 0) return {};
    const nextSeq = ((await this.ctx.storage.get<number>(OUTBOX_SEQ)) ?? -1) + 1;
    return {
      ...enqueueRows(nextSeq, codes.map(({ kind, code, sessionId }) => ({
        id: crypto.randomUUID(), kind, payload: { code, sessionId },
      }))),
      [dueKey("outbox")]: Date.now(),
    };
  }
```

Split `createSession` so the commit and the delivery are separate methods — that gives the test seam for free rather than duplicating a body:

```ts
  /**
   * Commit the session, its seed events, its cursor and the intent to register
   * its join codes. One write, for the reason the seed already gave: separately
   * committed, an interruption leaves a session whose code nothing can resolve.
   *
   * Public only so a test can reproduce an isolate dying between this and the
   * delivery below. Production goes through createSession.
   */
  async enqueueOnly(s: Session): Promise<void> {
    const { events, ...rest } = s;
    const seeded: Record<string, unknown> = { session: rest, cursor: 0 };
    for (const e of events) seeded[eventKey(e.cursor)] = e;
    if (events.length > 0) seeded.cursor = events[events.length - 1].cursor;
    Object.assign(seeded, await this.joinCodeRows(
      Object.values(rest.joinCodes).map((rec) => ({
        kind: "join_code_put" as const, code: rec.code, sessionId: s.id,
      }))
    ));
    await this.ctx.storage.put<unknown>(seeded);
    await this.reArm();
  }

  async createSession(s: Session): Promise<void> {
    await this.enqueueOnly(s);
    await this.deliverNow();
  }
```

Then the other three. Each keeps its existing guards, and `joinCodeRows` sits after them so a refused call queues nothing:

```ts
  /** No longer returns the retired code — it drops it itself. */
  async consumeJoinCode(role: string): Promise<void> {
    const s = await this.stored();
    const rec = s?.joinCodes[role];
    if (!s || !rec) return;
    const { [role]: _retired, ...rest } = s.joinCodes;
    await this.ctx.storage.put<unknown>({
      session: { ...s, joinCodes: rest },
      ...(await this.joinCodeRows([{ kind: "join_code_drop", code: rec.code }])),
    });
    await this.reArm();
    await this.deliverNow();
  }

  async clearJoinCodes(): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const codes = Object.values(s.joinCodes).map((rec) => rec.code);
    if (codes.length === 0) return;
    await this.ctx.storage.put<unknown>({
      session: { ...s, joinCodes: {} },
      ...(await this.joinCodeRows(
        codes.map((code) => ({ kind: "join_code_drop" as const, code }))
      )),
    });
    await this.reArm();
    await this.deliverNow();
  }

  /** `false` means frozen or missing, and queues nothing. */
  async setJoinCode(role: string, code: string, expiresAt: number): Promise<boolean> {
    const s = await this.stored();
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    const previous = s.joinCodes[role]?.code ?? null;
    await this.ctx.storage.put<unknown>({
      session: { ...s, joinCodes: { ...s.joinCodes, [role]: { code, expiresAt } } },
      ...(await this.joinCodeRows([
        ...(previous ? [{ kind: "join_code_drop" as const, code: previous }] : []),
        { kind: "join_code_put" as const, code, sessionId: s.id },
      ])),
    });
    await this.reArm();
    await this.deliverNow();
    return true;
  }
```

The drop is queued ahead of the put in `setJoinCode`, and FIFO keeps them in that order — so the rotated-out code stops resolving before the new one starts, never the reverse.

One more place clears codes directly: `expireIfDue` (line 268, the TTL handler) sets `joinCodes: {}` in its own write at line 270. It needs the same `join_code_drop` rows folded into that `put`, or an expired room's codes stay in the registry index forever. `getSessionByJoinCode` already rejects an expired-and-closed session, so this is about not leaking rows rather than about correctness — but it is the same write, and `expireIfDue` is reached from the alarm, so the drain has to be triggered there too.

The facade's `closeSession` (line 650) already routes through `clearJoinCodes`, so it needs nothing beyond the change above.

Then simplify the facade in `DurableObjectStore` — the registry calls live inside the object now:

```ts
  async createSession(s: Session): Promise<void> {
    await this.session(s.id).createSession(s);
    // Join codes register themselves from inside SessionDO, in the same
    // transaction as the session write. See #62.
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    await this.session(sessionId).consumeJoinCode(role);
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    await this.session(sessionId).clearJoinCodes();
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number
  ): Promise<boolean> {
    return this.session(sessionId).setJoinCode(role, code, expiresAt);
  }
```

Leave the second cross-object write at `store-do.ts:598` alone — the spec puts it out of scope.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:worker -- join-code-outbox`
Expected: PASS, 3 tests

- [ ] **Step 5: Break it on purpose, and quote the failure**

Move the `setJoinCode` enqueue above the `frozenAt` guard. The third test must fail with a queued row:

```
AssertionError: expected [ 'ob:000000000001' ] to deeply equal []
```

Restore, then run `npm run verify` — this task changed a method every session path uses, and the contract suite is what will catch a behaviour change in the facade.

- [ ] **Step 6: Commit**

```bash
git add src/store-do.ts worker-tests/join-code-outbox.test.ts
git -c commit.gpgsign=true commit -S -m "fix: a join code registers in the session's own transaction (#62)

The session committed first and the registry call followed. Lose it and
the room holds a code nothing can resolve, with no scan that could find
it. A stale row was already inert; this closes the other direction.

Closes #62"
```

---

### Task 11: `AuthDO` runs the whole reconcile under one lock

**Files:**
- Modify: `src/billing/ledger.ts` (`BillingStorage` at line 45, `serial` at line 97)
- Modify: `src/oauth/store.ts` (`AuthDO` at line 34, `AuthStore` at line 304)
- Modify: `src/billing/stripe.ts` (`StripeWebhookConfig` at line 152, `settle` at line 172)
- Modify: `src/worker.ts` (line 114, the only place the webhook is wired — `src/app.ts` has no billing routes, so the Node server needs no change)
- Test: `worker-tests/reconcile-race.test.ts` (create), `tests/billing.test.ts`

**Interfaces:**
- Consumes: `reconcilePurchase`, `PurchaseGrantStore` from `src/billing/grants.js`; `BellmanEnv` from `src/store-do.js`
- Produces: `BillingLedger.serializeUser(userId, work)`, `AuthDO.reconcile(userId)`, `AuthStore.reconcile(userId)`, `AuthDO.recordSubscription(...)`

- [ ] **Step 1: Write the failing test**

```ts
// worker-tests/reconcile-race.test.ts
/**
 * The ledger serializes per customer, but that queue is released when
 * syncSubscription returns. Two webhook deliveries could then both read
 * paidPlan and race their separate grant writes, so an older "active" result
 * landed after a cancellation had deleted the grant — leaving paid access for a
 * plan nobody is paying for. Stripe sends the deletion once, so nothing
 * corrected it.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { AuthStore } from "../src/oauth/store.js";
import { DurableObjectStore } from "../src/store-do.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const USER = "u_github_4242";

it("settles on the later ledger state when two reconciles overlap", async () => {
  const auth = new AuthStore(env.AUTH as never);
  const store = new DurableObjectStore(env as never);
  await auth.linkCustomer("cus_1", USER);

  // Paying, then cancelled, with both reconciles in flight at once.
  await auth.recordSubscription("cus_1", "sub_1",
    { plan: "pro", status: "active", eventAt: 1_000 });
  const first = auth.reconcile(USER);
  await auth.recordSubscription("cus_1", "sub_1",
    { plan: "pro", status: "canceled", eventAt: 2_000 });
  const second = auth.reconcile(USER);

  await Promise.all([first, second]);

  // The cancellation is the later state, so no grant may survive.
  expect(await store.getGrant("github:4242")).toBeUndefined();
});

it("writes the grant when the ledger says the user is paying", async () => {
  const auth = new AuthStore(env.AUTH as never);
  const store = new DurableObjectStore(env as never);
  await auth.linkCustomer("cus_1", USER);
  await auth.recordSubscription("cus_1", "sub_1",
    { plan: "pro", status: "active", eventAt: 1_000 });

  expect(await auth.reconcile(USER)).toBe("written");
  expect(await store.getGrant("github:4242")).toMatchObject({ plan: "pro", source: "purchase" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:worker -- reconcile-race`
Expected: FAIL — `auth.reconcile is not a function`.

- [ ] **Step 3: Expose the user queue**

In `src/billing/ledger.ts`, keep `serial` private and add:

```ts
  /**
   * Run `work` in this user's queue.
   *
   * The purchase reconcile needs it: reading the ledger and writing the grant
   * are one decision, and between them another delivery could read a state that
   * is about to be replaced. The queue is in memory, which only serializes
   * anything because there is exactly one ledger — one Durable Object in
   * production, one process in tests.
   */
  serializeUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    return this.serial(`${USER}${userId}`, work);
  }
```

Add `serializeUser` to the `BillingStorage` interface (line 45).

- [ ] **Step 4: Add `reconcile` to `AuthDO`**

In `src/oauth/store.ts`:

```ts
import type { BellmanEnv } from "../store-do.js";
import { reconcilePurchase, type PurchaseGrantStore } from "../billing/grants.js";
import type { SubscriptionState } from "../billing/ledger.js";
```

Change the declaration to `export class AuthDO extends DurableObject<BellmanEnv> {` and add:

```ts
  /** The grant store, reached from inside this object rather than the Worker. */
  private get grants(): PurchaseGrantStore {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  /**
   * Make the stored grant match what this user is currently paying for, with
   * the whole decision inside the user's queue.
   *
   * It has to run here rather than in the Worker: the queue is in memory inside
   * this object and the grant lives in RegistryDO, so holding it across two
   * RPCs from outside is not something the Worker can do. The object that owns
   * the serialisation performs the whole operation and calls the other itself.
   *
   * Lock ordering stays acyclic — linkCustomer takes customer then user, this
   * takes user only, and nothing in RegistryDO calls back into this object.
   */
  reconcile(userId: string): ReturnType<typeof reconcilePurchase> {
    return this.ledger.serializeUser(userId, () =>
      reconcilePurchase(userId, this.ledger, this.grants)
    );
  }

  /** Record a subscription state directly. For tests and repair. */
  recordSubscription(
    customerId: string, subscriptionId: string, state: SubscriptionState
  ): Promise<void> {
    return this.ledger.recordSubscription(customerId, subscriptionId, state);
  }
```

Add the matching delegations to `AuthStore`:

```ts
  reconcile(userId: string): ReturnType<typeof reconcilePurchase> {
    return this.object.reconcile(userId);
  }

  recordSubscription(
    customerId: string, subscriptionId: string, state: SubscriptionState
  ): Promise<void> {
    return this.object.recordSubscription(customerId, subscriptionId, state);
  }
```

- [ ] **Step 5: Point the webhook at it**

In `src/billing/stripe.ts`, replace `plans: PurchaseGrantStore` in `StripeWebhookConfig` with:

```ts
  /**
   * Reconciling is one call now rather than a ledger read plus a grant write:
   * those two together are a decision, and split across two objects the Worker
   * could not hold a lock over them. See #69.
   */
  reconcile(userId: string): Promise<"written" | "deleted" | "missing" | "conflict" | "unkeyable">;
```

Replace `settle`'s first line:

```ts
  const outcome = await config.reconcile(userId);
```

In `src/worker.ts`, the webhook block at line 114 currently passes `billing: new AuthStore(env.AUTH)` and `plans`. Replace `plans` with a `reconcile` that goes through the same store:

```ts
      const auth = new AuthStore(env.AUTH);
      return handleStripeWebhook(request, {
        secret: webhookSecret,
        billing: auth,
        reconcile: (userId) => auth.reconcile(userId),
        apiKey,
      });
```

This is the only place the webhook is wired. `src/app.ts` serves the Node program and has no billing routes, so it needs no change — which also means the `reconcile` port has exactly one production implementation and one in `tests/billing.test.ts`.

- [ ] **Step 6: Run everything**

Run: `npm run verify`
Expected: all green. Update `tests/billing.test.ts` wherever it builds a `StripeWebhookConfig`.

- [ ] **Step 7: Break it on purpose, and quote the failure**

Change `reconcile` to drop the lock:

```ts
  reconcile(userId: string) { return reconcilePurchase(userId, this.ledger, this.grants); }
```

Run `npm run test:worker -- reconcile-race`. The race test must fail with a surviving grant:

```
AssertionError: expected { key: 'github:4242', ... } to be undefined
```

If it passes without the lock, the test is not reproducing the race — interleave the two `recordSubscription` calls more tightly until it fails, then restore the lock. A race test that cannot fail proves nothing, and this is the one assertion in the plan whose whole value is that it fails without the fix.

- [ ] **Step 8: Commit and open PR 3**

```bash
git add src/billing/ledger.ts src/billing/stripe.ts src/oauth/store.ts src/worker.ts tests/billing.test.ts worker-tests/reconcile-race.test.ts
git -c commit.gpgsign=true commit -S -m "fix: reconcile a purchase inside the user's queue (#69)

Reading the ledger and writing the grant are one decision, and the Worker
released the queue between them. An older active state could land after a
cancellation, and Stripe sends that deletion once, so nothing corrected it.

Closes #69"
git push -u origin HEAD
gh pr create --fill
```

---

### Task 12: Update the architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§9, lines 380-405)
- Modify: `CLAUDE.md` Layout section, only if it lists modules at that granularity

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Rewrite §9**

Keep the heading — it is still true and still the thing to check a change against. Replace the three-row table of open bugs with one describing where each mechanism is used:

- `src/outbox.ts` — rows enqueued in the mutation's transaction, delivered inline, drained by a named alarm. Used `SessionDO → RegistryDO` for join codes and `RegistryDO → AuditDO` for audit entries.
- `AuthDO.reconcile` — the ordering half, where a lock rather than delivery is what was needed.

Leave the two related classes at the end of §9 unchanged. Add `src/outbox.ts` and `src/grant-audit.ts` to `CLAUDE.md`'s Layout list only if that list already names modules of this size — check first rather than assuming.

- [ ] **Step 2: Verify the doc's claims against the code**

Open every file path and line number the new §9 cites and confirm each. A documentation claim that is not pinned to the code it describes waits to be noticed rather than failing; this repo already pins three of `bellman_start`'s description lines for that reason.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git -c commit.gpgsign=true commit -S -m "docs: ARCHITECTURE section 9 describes the pattern, not three open bugs"
```

---

## Done when

- `npm run verify` is green, both vitest programs included.
- #59, #62 and #69 are closed by merged PRs.
- Every commit on all three branches reports `verified: true` from
  `gh api repos/bellman-sh/bellman/pulls/<n>/commits --jq '.[].commit.verification.verified'`.
- Every "break it on purpose" step has a quoted failure. A step without one leaves
  an assertion nobody has seen fail, which is not evidence.
