# Idempotent Event Append Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bellman_send` accepts an `idempotency_key`, so a retried send returns the original event instead of appending a second one the peer reads twice.

**Architecture:** A new store method `appendEventOnce(sessionId, e, key)` sits beside `appendEvent`, which keeps its signature and its five existing callers. The key layout and the content fingerprint live in a runtime-free `src/idempotency.ts` that both stores and the test suite import. Each store grows a private append primitive both public appenders share, so the key check and the write happen without yielding.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, Cloudflare Durable Objects, `@modelcontextprotocol/sdk`, zod.

**Spec:** `docs/superpowers/specs/2026-09-26-idempotent-event-append-design.md` — read it alongside this plan; every task below cites the decision it implements.

## Refinements to the approved spec

Two places where this plan is more specific than the spec. Both are stated here rather than applied quietly, and either can be vetoed before Task 1.

1. **`EventWrite` is a discriminated union, not an interface with an optional field.** The spec writes `{ outcome: ...; event?: SessionEvent }`. A union makes `event` required on exactly the two outcomes that have one, so the `bellman_send` call site needs no non-null assertion to reach `event.cursor`. The spec's own D1 argument — that the caller has four outcomes to tell apart — is the argument for letting the compiler enforce it. The cost is that `GrantWrite` and `GrantDelete` next door use the optional-field shape, so the file gains two idioms for one idea.

2. **`MemoryStore` keeps its key map in a side map, not on the `Session` record.** D6 says "on the session record." `Session` is the shared type `SessionDO` also persists and `hydrateStoredSession` validates, so a field there would need a hydration rule it does not need. A `Map<sessionId, Map<storageKey, IdempotencyRecord>>` beside `waiters` has the same lifetime — MemoryStore never deletes a session — and touches no persisted type. Behaviour is identical.

## Global Constraints

- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly (`src/store.ts` doc comment).
- **Read methods return detached copies.** Nothing handed to a caller may be reachable from stored state. `MemoryStore` uses `detach()` (`structuredClone`).
- **Read and write in the same turn.** No `await` between a guard's read and the write it guards. `MemoryStore` gets atomicity from not yielding; `SessionDO` from the Durable Object input gate covering one invocation.
- **Workers-only files are excluded from the Node build**: `src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`. Anything importing `cloudflare:workers` cannot be imported by a vitest test — put the shape in a runtime-free module beside it.
- **`npm run verify`** (typecheck + typecheck:worker + build + test) runs before every commit.
- **`main` moves only through merges.** Work stays on `mcfearsome/idempotency-keys-on-writes-so-a-retry-is-not-a-d`. This worktree has no jj repo; use `git` here.
- **Peer content is untrusted.** Nothing in this change alters wrapping or escaping.
- Key bounds, verbatim from the spec: `z.string().min(8).max(80).optional()`.
- Storage key layout, verbatim: `ik:<memberId>:<key>`.

## Review Focus

Five things the spec implies that no task's listed tests would otherwise exercise, most likely to bite first. Each has its test added to the task that owns the code.

1. **Two concurrent `appendEventOnce` calls with the same key** — the race the private append primitive exists to prevent. Every other test awaits between calls and would pass against an implementation that yields. Test in Task 2.
2. **A payload that is not a plain object** (`null`, a string, a number). `SessionEvent.payload` is `unknown`; `fingerprint` throwing here would break the send path. Test in Task 1.
3. **Arrays inside a payload** — element order is content and must survive canonicalization, or an honest retry of a list reads as `conflict`. Test in Task 1.
4. **`idempotency_key` at the zod boundaries** — 7 rejected, 8 accepted, 80 accepted, 81 rejected. Test in Task 4.
5. **A replay whose peers have all left.** The `others.length === 0` guard runs before the append, so a retry fails where the original succeeded. Expected and acceptable — a room with nobody in it cannot take a send — but it must be pinned so it is a decision rather than an accident. Test in Task 4.

---

### Task 1: `src/idempotency.ts` — key layout and fingerprint

Implements D2 (per-member namespace), D4 (recursive key sort), D6 (`IdempotencyRecord`).

**Files:**
- Create: `src/idempotency.ts`
- Test: `tests/idempotency.test.ts`

**Interfaces:**
- Consumes: `SessionEvent` from `src/types.ts`.
- Produces:
  - `idempotencyKey(memberId: string, key: string): string`
  - `fingerprint(e: Omit<SessionEvent, "cursor" | "at">): string`
  - `interface IdempotencyRecord { cursor: number; print: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/idempotency.test.ts`:

```ts
/**
 * The key layout and the fingerprint rule, tested where store-do.ts cannot be
 * reached — it imports `cloudflare:workers`. Same reason grant-index.ts exists.
 */
import { describe, it, expect } from "vitest";
import { fingerprint, idempotencyKey } from "../src/idempotency.js";
import type { SessionEvent } from "../src/types.js";

const draft = (over: Partial<Omit<SessionEvent, "cursor" | "at">> = {}) => ({
  type: "message" as SessionEvent["type"],
  fromMemberId: "m_creator",
  fromUserId: "u_jesse",
  fromLabel: "jesse",
  payload: { text: "hello" } as unknown,
  refId: null as string | null,
  ...over,
});

describe("idempotencyKey", () => {
  it("namespaces by member, so two members can use the same key", () => {
    expect(idempotencyKey("m_aaaa1111", "send-1"))
      .not.toBe(idempotencyKey("m_bbbb2222", "send-1"));
  });

  /**
   * The client-supplied key may contain a colon; the member segment must not,
   * or the encoding is not injective and one member's retry resolves to
   * another member's event.
   */
  it("keeps a colon in the member id out of the encoding", () => {
    expect(idempotencyKey("m_a:b", "x")).not.toBe(idempotencyKey("m_a", "b:x"));
  });

  it("is stable for the same pair", () => {
    expect(idempotencyKey("m_aaaa1111", "send-1"))
      .toBe(idempotencyKey("m_aaaa1111", "send-1"));
  });
});

describe("fingerprint", () => {
  it("matches for the same content", () => {
    expect(fingerprint(draft())).toBe(fingerprint(draft()));
  });

  /**
   * A retrying client may rebuild its payload rather than hold the original.
   * Same content, different insertion order. Unsorted this reads as a
   * conflict, which is the one outcome telling a client to stop retrying.
   */
  it("ignores object key order, at every depth", () => {
    const a = draft({ payload: { a: 1, b: { x: 1, y: 2 } } });
    const b = draft({ payload: { b: { y: 2, x: 1 }, a: 1 } });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  /** REVIEW FOCUS 3: array order is content, not layout. */
  it("does not ignore array order", () => {
    expect(fingerprint(draft({ payload: { steps: ["a", "b"] } })))
      .not.toBe(fingerprint(draft({ payload: { steps: ["b", "a"] } })));
  });

  it("sorts object keys inside arrays", () => {
    expect(fingerprint(draft({ payload: { rows: [{ a: 1, b: 2 }] } })))
      .toBe(fingerprint(draft({ payload: { rows: [{ b: 2, a: 1 }] } })));
  });

  /** REVIEW FOCUS 2: payload is `unknown`. A throw here breaks every send. */
  it("handles a payload that is not a plain object", () => {
    for (const payload of [null, "text", 42, true, [1, 2]]) {
      expect(() => fingerprint(draft({ payload }))).not.toThrow();
    }
    expect(fingerprint(draft({ payload: null })))
      .not.toBe(fingerprint(draft({ payload: "text" })));
  });

  it("differs when type, refId or payload differ", () => {
    const base = fingerprint(draft());
    expect(fingerprint(draft({ type: "artifact" as SessionEvent["type"] }))).not.toBe(base);
    expect(fingerprint(draft({ refId: "7" }))).not.toBe(base);
    expect(fingerprint(draft({ payload: { text: "other" } }))).not.toBe(base);
  });

  /**
   * fromUserId and fromLabel come from the authenticated identity, not the
   * caller's arguments. Including them would make a relabelled identity read
   * as a conflict on an otherwise identical retry.
   */
  it("ignores the fields the caller does not choose", () => {
    expect(fingerprint(draft({ fromUserId: "u_other", fromLabel: "other" })))
      .toBe(fingerprint(draft()));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/idempotency.test.ts`
Expected: FAIL — `Cannot find module '../src/idempotency.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/idempotency.ts`:

```ts
import type { SessionEvent } from "./types.js";

/**
 * Key layout and content fingerprint for idempotent event appends.
 *
 * Runtime-free and in its own module for the reason grant-index.ts gives:
 * store-do.ts imports `cloudflare:workers`, so no vitest test can reach inside
 * it. The parts worth testing are not the storage calls, they are this key
 * layout and the fingerprint rule — so those live here, where the suite can
 * hold them to account.
 */

/** What a remembered key resolves to. Both implementations store this. */
export interface IdempotencyRecord {
  cursor: number;
  print: string;
}

/**
 * `ik:<memberId>:<key>`, with the member segment encoded.
 *
 * The client supplies `key` and it may contain anything, a colon included.
 * That is harmless only while the member segment cannot contain one: otherwise
 * the encoding is not injective and two (member, key) pairs collide, letting
 * one member's retry resolve to another member's event — the cross-talk that
 * per-member scoping exists to prevent.
 *
 * Member ids are server-generated (`m_` plus 8 hex) or the literal "system",
 * so none of them contains a colon today. Encoded anyway, for the reason
 * grant-index.ts encodes its org segment: the alternative is a grammar every
 * future caller has to remember to honour.
 */
export const idempotencyKey = (memberId: string, key: string): string =>
  `ik:${encodeURIComponent(memberId)}:${key}`;

/**
 * A canonical print of the parts of an event a retry must reproduce.
 *
 * `fromUserId` and `fromLabel` are left out deliberately: they come from the
 * authenticated identity rather than the caller's arguments, so including them
 * would make a relabelled identity read as a conflict on an identical retry.
 */
export function fingerprint(e: Omit<SessionEvent, "cursor" | "at">): string {
  return JSON.stringify([e.type, e.fromMemberId, e.refId, canonical(e.payload)]);
}

/**
 * Sorts object keys at every depth; leaves arrays and primitives alone.
 *
 * Sorting is not cosmetic. JSON.stringify preserves insertion order, and a
 * retrying client may rebuild its payload rather than hold the original — same
 * content, different order. Unsorted, an honest retry reads as a conflict,
 * which is the one outcome that tells a client to stop retrying.
 *
 * Array order survives, because there it is content rather than layout.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(source).sort()) out[k] = canonical(source[k]);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/idempotency.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the sort assertion can fail**

Temporarily change `Object.keys(source).sort()` to `Object.keys(source)` and re-run. Expected: "ignores object key order, at every depth" and "sorts object keys inside arrays" both FAIL. Restore the `.sort()`.

An assertion that has never been seen to fail is not evidence. Do the same for the `encodeURIComponent` call: drop it and confirm the colon test goes red.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add src/idempotency.ts tests/idempotency.test.ts
git commit -m "feat: key layout and content fingerprint for idempotent appends

Per-member namespace, because clients pick keys without coordinating and a
shared one turns two peers both counting from 1 into a lost message. The
fingerprint sorts object keys at every depth: a retrying client may rebuild
its payload, and unsorted that honest retry would read as a conflict.

Runtime-free and separate for grant-index.ts's reason — store-do.ts imports
cloudflare:workers, so no vitest test can reach inside it.

Refs #79"
```

---

### Task 2: `appendEventOnce` on `BellmanStore` and `MemoryStore`

Implements D1 (new method), D3 (conflict), D5 (check order), D6 (retention), D7 (key off the event).

**Files:**
- Modify: `src/store.ts` — add `EventWrite`, the interface method, `MemoryStore.appendEventOnce`, the private `appendNow`, the `keys` side map
- Modify: `tests/helpers/store-contract.ts` — new `appendEventOnce` block after the existing events block (around line 290, after "throws when appending to an unknown session")

**Interfaces:**
- Consumes: `idempotencyKey`, `fingerprint`, `IdempotencyRecord` from `src/idempotency.js` (Task 1).
- Produces:
  - `export type EventWrite = { outcome: "appended"; event: SessionEvent } | { outcome: "replayed"; event: SessionEvent } | { outcome: "frozen" } | { outcome: "conflict" }`
  - `BellmanStore.appendEventOnce(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">, key: string): Promise<EventWrite>`

- [ ] **Step 1: Write the failing contract tests**

In `tests/helpers/store-contract.ts`, after the `it("throws when appending to an unknown session", ...)` block, insert:

```ts
    // ------------------------------------------------- idempotent appends
    const keyed = (over: Record<string, unknown> = {}) => ({
      type: "message" as const, fromMemberId: "m_creator", fromUserId: "u_jesse",
      fromLabel: "jesse", payload: { text: "once" }, refId: null, ...over,
    });

    it("appends the first time it sees a key", async () => {
      const s = session();
      (await store.createSession(s));

      const write = await store.appendEventOnce(s.id, keyed(), "send-0001");

      expect(write.outcome).toBe("appended");
      expect(write.outcome === "appended" && write.event.cursor).toBe(1);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** The whole point: a retry is a no-op that returns the original. */
    it("replays the original event for a repeated key, appending nothing", async () => {
      const s = session();
      (await store.createSession(s));

      const first = await store.appendEventOnce(s.id, keyed(), "send-0001");
      const again = await store.appendEventOnce(s.id, keyed(), "send-0001");

      if (first.outcome !== "appended") throw new Error(`first send said ${first.outcome}`);
      if (again.outcome !== "replayed") throw new Error(`retry said ${again.outcome}`);
      expect(again.event.cursor).toBe(first.event.cursor);
      expect(again.event).toEqual(first.event);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /**
     * A key reused for different content is a client bug. Returning the stored
     * event would tell the caller message B was delivered when A was.
     */
    it("refuses a key reused for different content, and appends nothing", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const clash = await store.appendEventOnce(
        s.id, keyed({ payload: { text: "different" } }), "send-0001",
      );

      expect(clash.outcome).toBe("conflict");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** Object key order is not different content. */
    it("treats a reordered payload as the same send", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed({ payload: { a: 1, b: 2 } }), "send-0001"));

      const retry = await store.appendEventOnce(
        s.id, keyed({ payload: { b: 2, a: 1 } }), "send-0001",
      );

      expect(retry.outcome).toBe("replayed");
    });

    /**
     * Clients pick keys with no coordination between them. A shared namespace
     * makes two peers that both count from 1 collide on their first message,
     * and the failure presents as a lost message rather than as an error.
     */
    it("namespaces keys per member", async () => {
      const s = session();
      (await store.createSession(s));

      const mine = await store.appendEventOnce(s.id, keyed(), "send-0001");
      const theirs = await store.appendEventOnce(
        s.id, keyed({ fromMemberId: "m_joiner", payload: { text: "mine" } }), "send-0001",
      );

      expect(mine.outcome).toBe("appended");
      expect(theirs.outcome).toBe("appended");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(2);
    });

    /**
     * A write that already succeeded keeps reporting its result even if the
     * room froze afterwards. The replay appends nothing, so nothing new enters
     * a frozen room — and a retry across a freeze can otherwise never learn
     * that its first attempt landed, which is why it is retrying.
     */
    it("still replays a successful write after the session freezes", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));
      (await store.freezeSession(s.id, Date.now()));

      const retry = await store.appendEventOnce(s.id, keyed(), "send-0001");

      expect(retry.outcome).toBe("replayed");
      expect(retry.outcome === "replayed" && retry.event.cursor).toBe(1);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    it("refuses a fresh key while frozen", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.freezeSession(s.id, Date.now()));

      expect((await store.appendEventOnce(s.id, keyed(), "send-0001")).outcome).toBe("frozen");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(0);
    });

    /** Conflict outranks frozen: a client bug should say so, not be masked. */
    it("reports a reused key as a conflict even while frozen", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));
      (await store.freezeSession(s.id, Date.now()));

      const clash = await store.appendEventOnce(
        s.id, keyed({ payload: { text: "different" } }), "send-0001",
      );

      expect(clash.outcome).toBe("conflict");
    });

    it("throws when appending to an unknown session, as appendEvent does", async () => {
      await expect(
        store.appendEventOnce("qs_nope", keyed(), "send-0001"),
      ).rejects.toThrow();
    });

    /**
     * REVIEW FOCUS 1: the race the private append primitive exists to prevent.
     * Both calls are issued before either is awaited, so an implementation
     * that yields between reading the key and writing the event appends twice.
     * Every other test here awaits in between and would pass regardless.
     */
    it("appends once when two calls with the same key race", async () => {
      const s = session();
      (await store.createSession(s));

      const [a, b] = await Promise.all([
        store.appendEventOnce(s.id, keyed(), "send-0001"),
        store.appendEventOnce(s.id, keyed(), "send-0001"),
      ]);

      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["appended", "replayed"]);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** INVARIANT 5 again: the replayed event must not be stored state. */
    it("hands back a detached event on replay", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const retry = await store.appendEventOnce(s.id, keyed(), "send-0001");
      if (retry.outcome === "replayed") retry.event.cursor = 999;

      expect((await store.eventsAfter(s.id, 0))[0].cursor).toBe(1);
    });

    /** D7: the key is an index, not content. It must not reach the peer. */
    it("does not write the key onto the event", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const [event] = await store.eventsAfter(s.id, 0);
      expect(JSON.stringify(event)).not.toContain("send-0001");
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `store.appendEventOnce is not a function`, 13 failures.

- [ ] **Step 3: Add `EventWrite` and the interface method**

In `src/store.ts`, add the import at the top:

```ts
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
```

Add beside `GrantWrite` / `GrantDelete`:

```ts
/**
 * What an idempotent append did.
 *
 * A union rather than an optional `event` field, because the caller must tell
 * four cases apart and two of them have no event: letting the compiler carry
 * that removes a non-null assertion at the one call site that reads the cursor.
 */
export type EventWrite =
  | { outcome: "appended"; event: SessionEvent }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "frozen" }
  | { outcome: "conflict" };
```

Add to `interface BellmanStore`, directly below `appendEvent`:

```ts
  /**
   * Append an event unless this member has already used this key.
   *
   * A separate method rather than a parameter on appendEvent: `null` there
   * already means frozen, and a caller now has four outcomes to tell apart.
   * Same shape as the guarded grant writes — the guarantee is in the name, and
   * a caller that does not want it calls the other method.
   *
   * The key check and the append are one operation, and cannot be two: a
   * caller that read the key and then wrote would leave a window for its own
   * retry to read the same empty slot and append a second event, which is the
   * entire thing this prevents.
   *
   * The key check precedes the frozen check. A write that already succeeded
   * keeps reporting its result even after the room freezes — the replay
   * appends nothing, so nothing new enters a frozen room, and a retry across a
   * freeze can otherwise never learn whether its first attempt landed.
   */
  appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite>;
```

The parameter is `key`, not `idempotencyKey`: this file imports a function by
that name, and a parameter shadowing it is how someone later calls the wrong
thing. Same reason the two implementations name it `key`.

- [ ] **Step 4: Implement it in `MemoryStore`**

Add the side map beside `waiters`:

```ts
  /**
   * Idempotency keys, by session. Beside `waiters` rather than on the Session
   * record: that type is the one SessionDO persists and hydrateStoredSession
   * validates, and a field there would need a hydration rule it does not need.
   * Same lifetime either way — a session is never deleted from this store.
   */
  private keys = new Map<string, Map<string, IdempotencyRecord>>();
```

Replace `appendEvent` with the pair below, extracting the shared primitive:

```ts
  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null) return null;
    return detach(this.appendNow(s, e));
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Everything from here to appendNow is synchronous, deliberately. An await
    // in this stretch yields, and this method's own retry can read the same
    // empty slot in the gap and append a second event.
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const seen = this.keys.get(sessionId);
    const record = seen?.get(storageKey);
    const print = fingerprint(e);

    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      // A record naming a cursor with no event is a store bug, not a replay.
      // Returning "replayed" without one would crash the caller a frame later,
      // where nothing says why.
      if (!original) {
        throw new Error(
          `Idempotency record for ${sessionId} names missing cursor ${record.cursor}`
        );
      }
      return { outcome: "replayed", event: detach(original) };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    const event = this.appendNow(s, e);
    const map = seen ?? new Map<string, IdempotencyRecord>();
    map.set(storageKey, { cursor: event.cursor, print });
    this.keys.set(sessionId, map);
    return { outcome: "appended", event: detach(event) };
  }

  /**
   * The append itself, with no awaits in it, so both public appenders can call
   * it without yielding between their guard and their write. Same rule, and
   * the same reason, as liveGrant and waitForEvents.
   */
  private appendNow(s: Session, e: Omit<SessionEvent, "cursor" | "at">): SessionEvent {
    const event: SessionEvent = {
      ...detach(e), cursor: s.events.length + 1, at: Date.now(),
    };
    s.events.push(event);
    this.wake(s);
    return event;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, including all 13 new cases.

- [ ] **Step 6: Prove the race assertion can fail**

Insert `await Promise.resolve();` immediately before `if (s.frozenAt !== null) return { outcome: "frozen" };` in `appendEventOnce` and re-run.

Expected: "appends once when two calls with the same key race" FAILS with `["appended", "appended"]` and two events. Every other test still passes — which is the point of having it.

Remove the line. Then do the same for the check order: move the `frozenAt` check above the `record` block and confirm "still replays a successful write after the session freezes" goes red. Restore it.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add src/store.ts tests/helpers/store-contract.ts
git commit -m "feat: appendEventOnce, so a retried append is not a duplicate

A new method rather than a parameter on appendEvent: null there already
means frozen, and the caller now has four outcomes to tell apart. Both
appenders share a private synchronous primitive, because an await between
the key check and the write lets this method's own retry read the same
empty slot and append twice. There is a contract test that fires both
calls before awaiting either.

The key check precedes the frozen check, so a retry across a freeze can
still learn that its first attempt landed.

Refs #79"
```

---

### Task 3: `appendEventOnce` in `SessionDO` and the store facade

Implements D1 and D6 for the implementation that serves production.

**Files:**
- Modify: `src/store-do.ts` — `SessionDO.appendEventOnce`, generalize the private `writeEvent`, `DurableObjectStore.appendEventOnce`
- Modify: `tests/store-do-wiring.test.ts` — a `currentRow` helper and an `appendEventOnce` describe block

**Interfaces:**
- Consumes: `EventWrite` from `src/store.js` (Task 2); `idempotencyKey`, `fingerprint`, `IdempotencyRecord` from `src/idempotency.js` (Task 1).
- Produces: `SessionDO.appendEventOnce(e, key)` and the facade method of the same name; no new exported types.

- [ ] **Step 1: Write the failing test**

In `tests/store-do-wiring.test.ts`, add beside `legacyRow`:

```ts
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
```

Add at the end of the file:

```ts
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
    const storeDo = await import("../src/store-do.js");
    const { store } = await worldOn(storeDo, currentRow());

    const first = await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    const again = await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    expect(first.outcome).toBe("appended");
    expect(again.outcome).toBe("replayed");
    expect(again.outcome === "replayed" && again.event.cursor).toBe(1);
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(1);
  });

  it("refuses a key reused for different content", async () => {
    const storeDo = await import("../src/store-do.js");
    const { store } = await worldOn(storeDo, currentRow());
    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    const clash = await store.appendEventOnce(
      LEGACY_ID, keyed({ payload: { text: "different" } }), "send-0001",
    );

    expect(clash.outcome).toBe("conflict");
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(1);
  });

  it("returns frozen for a fresh key and replays a written one", async () => {
    const storeDo = await import("../src/store-do.js");
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
    const storeDo = await import("../src/store-do.js");
    const { store, legacyStorage } = await worldOn(storeDo, currentRow());

    const before = legacyStorage.writes;
    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");

    // One batched put of three entries: the event, the cursor and the key.
    expect(legacyStorage.writes - before).toBe(3);
    const rows = legacyStorage.snapshot();
    const ik = Object.keys(rows).filter((k) => k.startsWith("ik:"));
    expect(ik).toHaveLength(1);
    expect(rows[ik[0]]).toMatchObject({ cursor: 1 });
  });

  it("namespaces the key row per member", async () => {
    const storeDo = await import("../src/store-do.js");
    const { store, legacyStorage } = await worldOn(storeDo, currentRow());

    await store.appendEventOnce(LEGACY_ID, keyed(), "send-0001");
    await store.appendEventOnce(
      LEGACY_ID, keyed({ fromMemberId: "m_joiner", payload: { text: "mine" } }), "send-0001",
    );

    expect(Object.keys(legacyStorage.snapshot()).filter((k) => k.startsWith("ik:")))
      .toHaveLength(2);
    expect(await store.eventsAfter(LEGACY_ID, 0)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store-do-wiring.test.ts`
Expected: FAIL — `store.appendEventOnce is not a function`, 5 failures.

- [ ] **Step 3: Implement it in `SessionDO`**

`src/store-do.ts` imports from `./store.js` twice: `GrantDelete, GrantWrite` on
line 1 and `BellmanStore, MemberPatch` a few lines down. Add `EventWrite` to the
second one, so it reads:

```ts
import type { BellmanStore, EventWrite, MemberPatch } from "./store.js";
```

Then add a new import beside it:

```ts
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
```

Generalize the private `writeEvent` so a caller can commit rows alongside it:

```ts
  private async writeEvent(
    e: SessionEvent,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await this.ctx.storage.put<unknown>({
      [eventKey(e.cursor)]: e, cursor: e.cursor, ...extra,
    });
  }
```

Add after `appendEvent`:

```ts
  /**
   * Atomic without a transaction: the input gate holds every other request to
   * this object for the duration of one invocation, which is the property #71
   * relied on for the frozen guard. The awaits below are inside that gate.
   */
  async appendEventOnce(
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite> {
    const s = await this.stored();
    if (!s) throw new Error("Unknown session");

    const storageKey = idempotencyKey(e.fromMemberId, key);
    const record = await this.ctx.storage.get<IdempotencyRecord>(storageKey);
    const print = fingerprint(e);

    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = await this.ctx.storage.get<SessionEvent>(eventKey(record.cursor));
      // A key naming a cursor with no event is a storage bug, not a replay.
      if (!original) {
        throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
      }
      return { outcome: "replayed", event: original };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    const event: SessionEvent = { ...e, cursor: await this.nextCursor(), at: Date.now() };
    // The key row joins the event and the cursor in one put, for the reason
    // writeEvent gives carried one step further: committed separately, an
    // interruption leaves the event stored with no key naming it, and the
    // retry that follows appends the duplicate this method exists to prevent.
    const stored: IdempotencyRecord = { cursor: event.cursor, print };
    await this.writeEvent(event, { [storageKey]: stored });
    this.wake(event);
    return { outcome: "appended", event };
  }
```

- [ ] **Step 4: Add the facade method**

In `DurableObjectStore`, directly after `appendEvent`:

```ts
  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite> {
    return this.session(sessionId).appendEventOnce(e, key);
  }
```

The parameter is `key`, not `idempotencyKey`: this module imports a function by that name, and shadowing it here is how someone later calls the wrong thing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/store-do-wiring.test.ts`
Expected: PASS, 5 new cases.

- [ ] **Step 6: Prove the one-put assertion can fail**

Replace the single `writeEvent` call with two separate writes:

```ts
    await this.writeEvent(event);
    await this.ctx.storage.put(storageKey, stored);
```

Re-run. Expected: "writes the key row in the same put as the event" FAILS with 4 writes rather than 3. Restore the single call.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add src/store-do.ts tests/store-do-wiring.test.ts
git commit -m "feat: appendEventOnce in SessionDO, key row committed with the event

The input gate makes this atomic without a transaction — one invocation
covers the key read and the append, the property #71 relied on for the
frozen guard.

The key row lands in the same put as the event and the cursor, for the
reason writeEvent already gives: committed separately, an interruption
between them leaves an event no key names, and the retry that follows
appends the duplicate this method exists to prevent. The wiring test
asserts one put of three entries and goes red if they are split.

Refs #79"
```

---

### Task 4: `idempotency_key` on `bellman_send`

Implements D8 (audit only on append), D9 (brief write moves after the append), D10 (`idempotentHint` unchanged), and the tool surface.

**Files:**
- Modify: `src/server.ts` — the `bellman_send` description, `inputSchema`, and handler (the tool block starting near line 610)
- Create: `tests/tools/idempotency.test.ts`

**Interfaces:**
- Consumes: `BellmanStore.appendEventOnce` and `EventWrite` from `src/store.js` (Task 2).
- Produces: no new exports. `bellman_send` gains an optional `idempotency_key` argument and may return `replayed: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/idempotency.test.ts`:

```ts
/**
 * A retried bellman_send is a no-op that returns the original result.
 *
 * The store contract proves the append semantics. What is proved here is the
 * tool's part: that a replay writes no second audit line, applies no second
 * brief, and tells the caller it is not a fresh delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const KEY = "send-0001";

describe("bellman_send with an idempotency_key", () => {
  it("delivers one event for two identical sends", async () => {
    const p = await pairUp(h);
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "only once" }, idempotency_key: KEY,
    });

    const first = await send();
    const second = await send();

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.data.cursor).toBe(first.data.cursor);
    expect(first.data.replayed).toBeUndefined();
    expect(second.data.replayed).toBe(true);

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    const messages = (sync.data.events as { type: string }[])
      .filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
  });

  /**
   * D8. Auditing a replay is the bug #68 shipped, moved one layer down: a
   * redelivered write appending a line for something that did not happen.
   */
  it("writes one audit line, not two", async () => {
    const p = await pairUp(h);
    for (let i = 0; i < 3; i++) {
      await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type: "message", payload: { text: "only once" }, idempotency_key: KEY,
      });
    }

    const entries = await h.store.auditForOrg("org_codenerd", 50);
    expect(entries.filter((e) => e.action === "sent_message")).toHaveLength(1);
  });

  it("fails when the key is reused for different content", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "first" }, idempotency_key: KEY,
    });

    const clash = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "second" }, idempotency_key: KEY,
    });

    expect(clash.isError).toBe(true);
    expect(clash.text).toContain(KEY);
    // Relative, not absolute: how many events the handshake leaves behind is
    // not this test's business, and hard-coding it makes the test fail for the
    // wrong reason the next time the handshake changes.
    const after = await h.store.eventsAfter(p.sessionId, 0);
    expect(after.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("still appends when no key is given", async () => {
    const p = await pairUp(h);
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "twice" },
    });

    const first = await send();
    const second = await send();

    expect(second.data.cursor).not.toBe(first.data.cursor);
  });

  /**
   * D9. The brief write used to precede the append, so a frozen room wrote the
   * brief and then refused the event. A replay must not re-apply it either.
   */
  it("applies a replayed brief_update once", async () => {
    const p = await pairUp(h);
    const updated = brief({ goal: "the new goal" });
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: updated, idempotency_key: KEY,
    });

    await send();
    const again = await send();

    expect(again.data.replayed).toBe(true);
    const s = await h.store.getSession(p.sessionId);
    const me = s!.members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(me.brief.goal).toBe("the new goal");
    const events = await h.store.eventsAfter(p.sessionId, 0);
    expect(events.filter((e) => e.type === "brief_update")).toHaveLength(1);
  });

  /** D9: an append the room refuses must not leave the brief written. */
  it("leaves the brief alone when the room is frozen", async () => {
    const p = await pairUp(h);
    const before = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!.brief.goal;
    await h.store.freezeSession(p.sessionId, Date.now());

    const refused = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "should not land" }),
    });

    expect(refused.isError).toBe(true);
    const after = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!.brief.goal;
    expect(after).toBe(before);
  });

  /** REVIEW FOCUS 4: the zod bounds, which no other test reaches. */
  it("enforces the key length bounds", async () => {
    const p = await pairUp(h);
    const withKey = (idempotency_key: string) => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "bounds" }, idempotency_key,
    });

    expect((await withKey("a".repeat(7))).isError).toBe(true);
    expect((await withKey("a".repeat(8))).isError).toBe(false);
    expect((await withKey("b".repeat(80))).isError).toBe(false);
    expect((await withKey("c".repeat(81))).isError).toBe(true);
  });

  /**
   * REVIEW FOCUS 5: the guards run before the append, so a retry into an empty
   * room is refused rather than replayed. Correct — a room with nobody in it
   * cannot take a send — and pinned here so it stays a decision.
   */
  it("refuses a retry once every peer has left", async () => {
    const p = await pairUp(h);
    const first = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "before they left" }, idempotency_key: KEY,
    });
    expect(first.isError).toBe(false);

    await p.creator.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
    });

    const retry = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "before they left" }, idempotency_key: KEY,
    });

    expect(retry.isError).toBe(true);
    expect(retry.text).toContain("no other active members");
  });

  /** Two members may use the same key without colliding. */
  it("keeps one member's key out of another's way", async () => {
    const p = await pairUp(h);

    const theirs = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "from the joiner" }, idempotency_key: KEY,
    });
    const mine = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "message", payload: { text: "from the creator" }, idempotency_key: KEY,
    });

    expect(theirs.data.replayed).toBeUndefined();
    expect(mine.data.replayed).toBeUndefined();
    expect(mine.data.cursor).not.toBe(theirs.data.cursor);
  });

  /** D10: only idempotent when a key is supplied, which the hint cannot say. */
  it("does not advertise itself as idempotent", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const tools = await jesse.listTools();
    const send = tools.tools.find((t) => t.name === "bellman_send")!;

    expect(send.annotations?.idempotentHint).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/idempotency.test.ts`
Expected: FAIL — the `idempotency_key` argument is rejected by the schema, so the first sends error and `replayed` is never set.

- [ ] **Step 3: Add the argument and its documentation**

In `src/server.ts`, in the `bellman_send` description, after the `ref_id` line:

```
  - idempotency_key: optional. Names this send. Retrying with the SAME key returns the original result instead of delivering a second copy — use it when a call timed out or the connection dropped and you cannot tell whether it landed. Use a fresh key for a new message; reusing one for different content is an error.
```

And after `Returns: { delivered_to, cursor }`:

```
Returns: { delivered_to, cursor, replayed? } — replayed: true means this key had already been used and nothing new was sent.
```

Add to `inputSchema`, after `ref_id`:

```ts
        idempotency_key: z.string().min(8).max(80).optional(),
```

Leave `annotations` untouched: `bellman_send` is idempotent only when a key is supplied, and the hint is a static boolean that cannot say so.

- [ ] **Step 4: Rewrite the handler's append and after-effects**

Change the handler signature to destructure the new argument:

```ts
    async ({ session_id, member_id, type, payload, ref_id, idempotency_key }): Promise<ToolResult> => {
```

Keep every guard above unchanged. Replace the `brief_update` block with validation only — the write moves below:

```ts
      // Validated here so an invalid brief never appends an event; applied
      // after the append, because a refused or replayed send must not leave a
      // brief written. Before this, a frozen room wrote the brief and then
      // threw FrozenError.
      let updatedBrief: Brief | undefined;
      if (type === "brief_update") {
        const parsed = BriefShape.safeParse(payload);
        if (!parsed.success) return fail(`brief_update payload must be a full Brief object: ${parsed.error.issues[0]?.message}`);
        updatedBrief = parsed.data as Brief;
      }
```

Replace the append, audit and return with:

```ts
      const draft = {
        type,
        fromMemberId: member_id,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        payload,
        refId: ref_id ?? null,
      };

      let event: SessionEvent;
      let replayed = false;
      if (idempotency_key) {
        const write = await s.appendEventOnce(session_id, draft, idempotency_key);
        if (write.outcome === "conflict") {
          return fail(
            `idempotency_key "${idempotency_key}" was already used for a different message. ` +
            `Reuse a key only to retry the same send; pick a new one for new content.`
          );
        }
        if (write.outcome === "frozen") return fail(FROZEN);
        event = write.event;
        replayed = write.outcome === "replayed";
      } else {
        event = await appendOrFrozen(s, session_id, draft);
      }

      // Nothing below happens twice. A replay's original call did all of it,
      // and re-running it would grow the audit log on every retry — the bug
      // #68 shipped, one layer down.
      if (!replayed) {
        if (updatedBrief) {
          await s.updateMember(session_id, member_id, { brief: updatedBrief });
        }
        await audit(s, session, identity, `sent_${type}`, {
          chars: serialized.length,
          ...(ref_id ? { ref_id } : {}),
        });
      }

      return ok({
        // The members active NOW, not the ones active when this was first
        // appended. No history is kept to do better, and the field answers who
        // can read it, which is the question either way.
        delivered_to: others.map((m) => m.label),
        cursor: event.cursor,
        ...(replayed ? { replayed: true } : {}),
        note: type === "action_request"
          ? "The peer's HUMAN must approve this — expect an action_response event, possibly after a delay."
          : undefined,
      });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/tools/idempotency.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `tests/tools/exchange.test.ts`, `freeze.test.ts`, `audit.test.ts`, `handshake.test.ts` and `surface.test.ts` all drive `bellman_send`; if any of them asserts on a brief written before a refused append, that assertion was pinning the bug D9 fixes — read it, and update it with a comment saying so rather than reverting the fix.

- [ ] **Step 7: Prove the audit assertion can fail**

Move the `audit(...)` call outside the `if (!replayed)` block and re-run `npx vitest run tests/tools/idempotency.test.ts`.
Expected: "writes one audit line, not two" FAILS with 3 lines. Restore it.

Then delete the `if (!replayed)` guard around the brief write and confirm "applies a replayed brief_update once" still passes — it will, because writing the same brief twice is the same state. That test does not pin the guard; the reason for the guard is the needless write, not a wrong value. Note this in the commit rather than pretending the test proves more than it does.

- [ ] **Step 8: Commit**

```bash
npm run verify
git add src/server.ts tests/tools/idempotency.test.ts
git commit -m "feat: idempotency_key on bellman_send

A retried send returns the original cursor with replayed: true, and writes
no second event, audit line or brief. Retrying is what a client does when a
call timed out and it cannot tell whether the send landed; until now that
appended a second event and the peer's human read the message twice.

Auditing a replay would be the bug #68 shipped one layer down, so the audit
line is written only on a real append. The brief write moves below the
append with it: before, a frozen room wrote the brief and then refused the
event.

idempotentHint stays false — the tool is idempotent only when a key is
given, and the annotation cannot say that.

Closes #79 for bellman_send; the putGrant half is filed separately."
```

---

### Task 5: File the follow-up and close out

**Files:**
- Modify: `CONTEXT.md` — Next Steps

- [ ] **Step 1: Open the follow-up issue for the billing half**

```bash
gh issue create \
  --title "Idempotent putGrant, keyed by the Stripe event id" \
  --label enhancement \
  --body "$(cat <<'BODY'
Split from #79, which shipped the `bellman_send` half.

`RegistryDO.putGrant` has the hole #79 describes: Stripe redelivers events, and
the key we would name the write with is the `event.id` we already read for log
lines in `src/billing/stripe.ts` and then throw away.

Once a grant write carries it, the `samePlan` comparison in
`reconcilePurchase` (`src/billing/grants.ts`) becomes redundant — that check is
the call-site-specific fix #68 shipped for exactly this, and an idempotency key
generalises it.

Shape follows #79's: `docs/superpowers/specs/2026-09-26-idempotent-event-append-design.md`,
which has the reasoning for the key check preceding other guards and for the
key row committing in the same write as the record.
BODY
)"
```

- [ ] **Step 2: Update `CONTEXT.md`**

Replace the `#12` bullet under **Next Steps** with:

```markdown
- #12: run the store contract suite against `DurableObjectStore`. It is the only
  store serving production and is verified solely by the smoke run plus
  `tests/store-do-wiring.test.ts`. #79 added 13 contract cases that MemoryStore
  alone proves.
```

Keep the file under 20 lines: drop the Claude Desktop connector bullet, which the OAuth work has since answered.

- [ ] **Step 3: Commit**

```bash
npm run verify
git add CONTEXT.md
git commit -m "docs: note the contract cases #79 leaves unproven on the DO

13 of them. MemoryStore passes them; DurableObjectStore is covered only by
the wiring test until #12 points the suite at it.

Refs #79"
```

- [ ] **Step 4: Open the pull request**

```bash
git push -u origin mcfearsome/idempotency-keys-on-writes-so-a-retry-is-not-a-d
gh pr create --fill --base main
```

The PR body must say out loud that nothing here weakens the untrusted-content
rules: the idempotency key is never written onto an event, so it never crosses
to a peer, and no escaping or wrapping changed.
