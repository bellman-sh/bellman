# Atomicity Sweep, PR 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #73, #116, #117 and #118 by making a member's removal one transactional store operation, and by folding the join-code clearing into the seating that decides it.

**Architecture:** `SessionDO` gains an `audit` outbox kind, so a room's audit rows can be queued in the transaction that earns them. `BellmanStore` gains `removeMember`, which performs the guard, the `leftAt` write, the removal event, the code retirement and its event, and queues the audit rows — all in one `SessionDO` transaction. `rooms.ts` moves `leaveRoom` and `evictMember` onto it. Separately, `seatMember` clears the room's join codes inside its own transaction when the seat it just took filled the room, so `bellman_confirm` makes no second-object call after the seat commits.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, vitest (two programs: plain Node at the repo root, `@cloudflare/vitest-pool-workers` in `worker-tests/`).

**Spec:** `docs/superpowers/specs/2026-10-04-atomicity-sweep-design.md`

## Global Constraints

- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly.
- **`main` moves only through merges.** Feature work on a branch, landed by PR. This repo is colocated jj, but orca worktrees under `~/orca/workspaces/` are plain git worktrees — use ordinary git there.
- **Commits must be signed.** The repo-local git config sets `commit.gpgsign = false`, which overrides the global `true`, and `main`'s ruleset requires signatures. Every commit in this plan uses `git -c commit.gpgsign=true commit -S`. Verify with `git cat-file commit HEAD | grep gpgsig` — `git log --show-signature` cannot verify here.
- **Never `git add -A` or `git commit -a`.** Stage the exact paths each step names.
- **Workers-only files are excluded from the Node build**: `src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`. They import `cloudflare:workers`. Anything a vitest test must reach goes in a runtime-free module beside them.
- **Two test programs.** Anything importing `cloudflare:workers` cannot be imported by a root vitest test. `npm run test:worker` runs `worker-tests/` with its own config; do not reach for `npm --prefix worker-tests exec vitest`, which loads the root config and reports "No test files found".
- **A room holds many members, not two.** In comments, commit messages and PR bodies say *members*, *the room*, or *peers* — never "two sessions" or "the other session".
- **Banned phrases** anywhere, including comments and commit messages: "load-bearing", "worth saying/stating/noting/knowing/recording", "structural"/"structurally". Name the consequence instead.
- **Never put a cross-object call inside a transaction closure.** ARCHITECTURE.md §9 runtime fact 2: everything awaited in a closure holds every other call to that object until it commits. The closure queues; the wrapper delivers after the commit.
- **`reArm()` and `deliverNow()` go after the transaction has committed, never inside its closure.** `OutboxDriver.enqueue` arming from inside a caller's closure is the one deliberate exception.
- `npm run verify` runs typecheck + `typecheck:worker` + build + test + `test:worker`. Run it before the PR.
- **A `// path/to/file.ts` first line in a code block labels the block, not the file.** No tracked `.ts` file in this repo opens with a path comment. Every other byte of a code block is verbatim.
- **Expected failure text is a hint, not a contract.** Judge whether the red is for the stated reason; vitest's wording drifts between versions. Say so in your report if it differs, and carry on.
- **No new tool is added**, so `extension/manifest.json` does not change and `tests/extension.test.ts` needs no edit. If that test goes red, something added a tool by accident.

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A refused `removeMember` must write nothing and queue nothing.** No `leftAt`, no event, no audit row. A rejected call leaving an audit trace is the bug #44 fixed on the admin path, reintroduced through a different door. → Task 2.
2. **The idempotent path must not restate the departure.** `removed: false` is a member who was already out; re-announcing or re-auditing the departure is #117 with the duplicate moved one call later. It is NOT licence to skip what is still owed: a seat code still live was never retired, so that path shuts the door, writes its event and queues its audit row, and reports `codeRetired`. → Task 2.
3. **An expired code still sitting in `joinCodes` must not be retired or announced.** `evictMember` today computes `live` as `Date.now() <= rec.expiresAt`, and nothing prunes an expired record. A store that retires on presence alone announces a door that was already shut. → Task 2.
4. **An audit entry with a falsy `orgId` must enqueue nothing.** §9 runtime fact 4: a Durable Object namespace accepts `""`, `null` and `undefined` as names, so such a row is *delivered* — into a stream no org reads. A bad id misfiles rather than stalling, which is harder to notice. → Task 1.
5. **A refused seating must clear no codes.** `seatMember`'s new branch runs inside the same closure as its guards; a `full`, `frozen` or `closed` refusal must leave the room's codes alone. → Task 4.

---

## Task 1: An `audit` outbox kind on `SessionDO`

`DurableObjectStore.appendAudit` calls `AuditDO.append` from the Worker, so a room's audit row is a second-object write with no transaction spanning it. `RegistryDO` already solved this for grants. This gives `SessionDO` the same branch, with no behaviour change to any existing path — nothing queues an audit intent yet.

**Files:**
- Modify: `src/store-do.ts` — the module-level intent constructors beside `putCodeIntent`/`dropCodeIntent`, `SessionDO`'s `#deliver`, and `RegistryDO`'s `#auditIntents`
- Test: `worker-tests/session-audit-outbox.test.ts` (create)

**Interfaces:**
- Consumes: `OutboxIntent`, `OutboxRow` from `src/outbox.ts`; `AuditEntry` from `src/types.ts`; `AuditDO.append(entry, intentId?)`
- Produces: `auditIntent(entry: AuditEntry): OutboxIntent` at module scope in `src/store-do.ts`, used by Task 2 and by `RegistryDO`

- [ ] **Step 1: Write the failing test**

Create `worker-tests/session-audit-outbox.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { SessionDO, AuditDO } from "../src/store-do.js";
import { outboxKey, OUTBOX_SEQ, dueKey, OUTBOX_HANDLER } from "../src/outbox.js";

// Storage is not isolated between tests in this pool (worker-tests/README.md), and
// the first and third cases both file rows under org_codenerd. Without this the
// redelivery case counts the first case's row and fails with a length of 2.
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/**
 * The rows are planted directly rather than earned by an operation. Nothing
 * queues an audit intent until Task 2, and the branch that delivers one is what
 * this task adds — so the drain is driven from storage the way the alarm would
 * find it.
 */
async function plant(id: DurableObjectId, row: Record<string, unknown>): Promise<void> {
  await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
    await ctx.storage.put<unknown>({
      [outboxKey(0)]: row,
      [OUTBOX_SEQ]: 0,
      [dueKey(OUTBOX_HANDLER)]: Date.now(),
    });
  });
}

const entry = (over: Record<string, unknown> = {}) => ({
  at: 1_700_000_000_000,
  orgId: "org_codenerd",
  sessionId: "qs_test",
  actorUserId: "u_jesse",
  action: "member_left",
  detail: {},
  ...over,
});

/** An entry with no `orgId` property at all, rather than a null or an empty one. */
const entryWithoutOrg = (): Record<string, unknown> => {
  const e: Record<string, unknown> = entry();
  delete e.orgId;
  return e;
};

/**
 * One case per shape of "no org". Each shape reaches a DIFFERENT Durable Object
 * stream, and a row that cannot reach a stream is no control for it: with only
 * `null` planted, the checks on "" and "undefined" can never fail, and a guard
 * reduced to `entry.orgId === null` — the form `appendAudit` uses — goes unnoticed.
 */
const NO_ORG = [
  { shape: "null", session: "qs_audit_null", payload: () => entry({ orgId: null }) },
  { shape: "empty", session: "qs_audit_empty", payload: () => entry({ orgId: "" }) },
  { shape: "absent", session: "qs_audit_absent", payload: entryWithoutOrg },
];

describe("SessionDO delivers audit intents", () => {
  it("delivers an audit row to the entry's own org", async () => {
    const id = env.SESSION.idFromName("qs_audit_one");
    await plant(id, { id: "intent-one", kind: "audit", payload: entry(), attempts: 0 });

    await runInDurableObject(env.SESSION.get(id), async (instance: SessionDO) => {
      await instance.alarm();
    });

    const auditId = env.AUDIT.idFromName("org_codenerd");
    await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
      const rows = await audit.recent(10);
      expect(rows.map((r) => r.action)).toEqual(["member_left"]);
    });
  });

  /**
   * Review Focus 4. A namespace accepts null as a name, so a falsy org is
   * DELIVERED — into a stream no org reads, or one called "null". The guard is
   * what stops the misfile; the row still counts as delivered either way.
   */
  it.each(NO_ORG)(
    "delivers nothing for an entry whose org is $shape, and clears the row",
    async ({ session, payload }) => {
    const id = env.SESSION.idFromName(session);
    await plant(id, {
      id: "intent-none", kind: "audit", payload: payload(), attempts: 0,
    });

    await runInDurableObject(env.SESSION.get(id), async (instance: SessionDO) => {
      await instance.alarm();
    });

    for (const name of ["null", "undefined", ""]) {
      const auditId = env.AUDIT.idFromName(name);
      await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
        // The message names the stream, so a red run says which one took the entry.
        expect(await audit.recent(10), `the stream named "${name}"`).toEqual([]);
      });
    }

    // The row is gone: a delivery that is correctly a no-op still counts as
    // delivered, or the queue stalls behind it for good.
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      expect(await ctx.storage.get(outboxKey(0))).toBeUndefined();
    });
  });

  it("does not append the same intent twice when it is redelivered", async () => {
    const id = env.SESSION.idFromName("qs_audit_twice");
    const row = { id: "intent-dupe", kind: "audit", payload: entry(), attempts: 0 };

    await plant(id, row);
    await runInDurableObject(env.SESSION.get(id), async (i: SessionDO) => { await i.alarm(); });
    await plant(id, row);
    await runInDurableObject(env.SESSION.get(id), async (i: SessionDO) => { await i.alarm(); });

    const auditId = env.AUDIT.idFromName("org_codenerd");
    await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
      expect(await audit.recent(10)).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:worker -- session-audit-outbox`

Expected: FAIL. `SessionDO.#deliver` throws `outbox: unknown kind audit` on the first two cases, so the queue never clears and no audit row appears.

- [ ] **Step 3: Add the intent constructor**

In `src/store-do.ts`, directly after `dropCodeIntent`, add:

```ts
/**
 * An audit entry as an outbox intent, for an object that earns the entry in a
 * transaction and must not then write it from outside one. Shared by SessionDO
 * and RegistryDO so the two cannot disagree about the row's shape.
 */
const auditIntent = (entry: AuditEntry): OutboxIntent => ({
  id: crypto.randomUUID(), kind: "audit", payload: entry,
});
```

Confirm `AuditEntry` is already imported in this file's type import from `./types.js`; it is, for `appendAudit`.

- [ ] **Step 4: Add the branch to `SessionDO.#deliver`**

Replace the body of `SessionDO`'s `#deliver` with:

```ts
  async #deliver(row: OutboxRow): Promise<void> {
    const registry = () => this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    if (row.kind === "join_code_put") {
      const { code, sessionId } = row.payload as { code: string; sessionId: string };
      await registry().putJoinCode(code, sessionId);
    } else if (row.kind === "join_code_drop") {
      await registry().dropJoinCode((row.payload as { code: string }).code);
    } else if (row.kind === "audit") {
      const entry = row.payload as AuditEntry;
      // A falsy org is not a stall, it is a misfile: a namespace accepts null
      // and "" as names, so this row WOULD be delivered, into a stream nobody
      // reads. Dropped here instead, and the row still counts as delivered.
      // ARCHITECTURE.md section 9, runtime fact 4.
      if (!entry.orgId) return;
      await this.env.AUDIT.get(this.env.AUDIT.idFromName(entry.orgId)).append(entry, row.id);
    } else {
      throw new Error(`outbox: unknown kind ${row.kind}`);
    }
  }
```

- [ ] **Step 5: Point `RegistryDO.#auditIntents` at the shared constructor**

Replace `RegistryDO`'s `#auditIntents` body with:

```ts
  #auditIntents(entries: AuditEntry[]): OutboxIntent[] {
    return entries.map(auditIntent);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:worker -- session-audit-outbox`
Expected: PASS, 5 tests — the no-org case runs once per shape.

- [ ] **Step 7: Confirm nothing else moved**

Run: `npm run test:worker`
Expected: PASS. `RegistryDO`'s grant audit tests exercise the constructor you just rerouted; if `worker-tests/grant-audit-outbox.test.ts` goes red, the reroute changed the row shape.

- [ ] **Step 8: Break it on purpose, and quote the failure**

Delete the `if (!entry.orgId) return;` line, run `npm run test:worker -- session-audit-outbox`, and confirm the no-org case fails with something like:

```
AssertionError: expected [ { at: 1700000000000, … } ] to deeply equal []
```

Put the line back and re-run. An assertion you have not seen fail is not evidence, and this guard is the one most likely to read as redundant to someone tidying the branch.

- [ ] **Step 9: Commit**

```bash
git add src/store-do.ts worker-tests/session-audit-outbox.test.ts
git -c commit.gpgsign=true commit -S -m "Give SessionDO an audit outbox kind, so a room can queue its own rows

RegistryDO already queues grant audit entries in the transaction that
earns them. SessionDO could not: its audit rows went out from the Worker
after the object had committed. Nothing queues one yet."
```

---

## Task 2: `removeMember` on both stores

One transactional operation for a member leaving a room, by their own hand or someone else's. The handler passes the event bodies in, so the store writes a record it was given rather than learning what an event means.

**Files:**
- Modify: `src/store.ts` — the `BellmanStore` interface and `MemoryStore`
- Modify: `src/store-do.ts` — `SessionDO.removeMember` and `DurableObjectStore.removeMember`
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `auditIntent` from Task 1; `Member`, `SessionEvent`, `AuditEntry`, `MemberPatch`
- Produces: `RemovalOutcome`, `EventBody`, and `removeMember(sessionId, memberId, opts)` on `BellmanStore`

- [ ] **Step 1: Add the types to `src/store.ts`**

Directly above `export interface SeatOutcome`, add:

```ts
/** What `appendEvent` already takes: an event without the fields the store fills. */
export type EventBody = Omit<SessionEvent, "cursor" | "at">;

/** What a removal did, reported from inside the transaction that did it. */
export interface RemovalOutcome {
  refused: "not_found" | "closed" | "frozen" | "forbidden" | null;
  /** True only when THIS call recorded the member out. */
  removed: boolean;
  /** The role whose code this call retired, or null. */
  codeRetired: string | null;
}

/** The guard and the writes a removal performs, handed in by its caller. */
export interface RemovalRequest {
  now: number;
  /** Leaving a frozen room is never refused; eviction from one is. */
  frozen: "allow" | "refuse";
  /** When set, the call is refused unless it matches `session.createdBy`. */
  byUserId?: string;
  /** Written only if this call did the removing. */
  event: EventBody;
  /** Retire this role's code, and write this event, if the code is still live. */
  retire?: { role: string; event: EventBody };
  /** Queued in the same transaction and delivered by the outbox. */
  audit: readonly AuditEntry[];
}
```

- [ ] **Step 2: Add the method to the `BellmanStore` interface**

In `src/store.ts`, directly after `seatMember`'s declaration, add:

```ts
  /**
   * Record a member out of a room, say so, and retire their seat's code — as ONE
   * operation.
   *
   * It cannot be four calls, and it was. `leaveRoom` read `leftAt` and wrote it
   * with an await between, so two calls on one handle both saw null and both
   * announced (#117). `evictMember` checked `closed` and `frozenAt` against a
   * snapshot and mutated afterwards, so a freeze landing in the window either
   * wrote to a room whose writes had stopped or swallowed the event the bridge
   * disarms its watcher on (#118). And a leave from a frozen room lost its event
   * outright, because the public append refuses while frozen (#73).
   *
   * The caller hands the event bodies in. The store writes the record it was
   * given and never asks what an event means — the constraint #147 set. The
   * frozen refusal stays on `appendEvent`, which is a different operation: this
   * one declares its own policy through `frozen`, so a leave records its
   * departure in a frozen room without the store learning that `member_left` is
   * special.
   *
   * `removed: false` with `refused: null` is the idempotent path: the member was
   * already out. Nothing is written and nothing is queued, so a retry announces
   * no second departure. Closing the room if it has emptied is NOT part of this —
   * `closeSessionIfEmpty` makes that decision atomically on its own, and folding
   * it in here would close over a member who joined in the gap.
   */
  removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome>;
```

- [ ] **Step 3: Write the failing contract cases**

Append inside `describeStoreContract`'s `describe` block in `tests/helpers/store-contract.ts`:

```ts
    const leaveEvent = (memberId: string) => ({
      type: "member_left",
      fromMemberId: memberId,
      fromUserId: "u_jesse",
      fromLabel: "jesse@codenerd",
      payload: { label: "jesse@codenerd" },
      refId: null,
    });

    const auditRow = (action: string) => ({
      at: Date.now(),
      orgId: "org_codenerd",
      sessionId: "qs_test",
      actorUserId: "u_jesse",
      action,
      detail: {},
    });

    it("removeMember records the member out, writes its event and queues its audit row", async () => {
      const s = session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_left")],
      });

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: null });
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt).toBe(9_000_000);
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action)).toEqual(["member_left"]);
    });

    it("removeMember announces a departure from a frozen room, where appendEvent would not", async () => {
      // #73. Freezing refuses sending, joining and inviting; it must never trap
      // a member inside a room they want to leave, and the departure peers see
      // is part of the leaving.
      const s = session({
        frozenAt: Date.now(),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        event: leaveEvent("m_peer"),
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
      // The public append still refuses, because that is what stops a freeze
      // landing between a tool's read and its write and letting a room grow.
      expect(await store.appendEvent(s.id, leaveEvent("m_creator"))).toBeNull();
    });

    it("removeMember refuses a frozen room when the caller asked it to", async () => {
      const s = session({
        frozenAt: Date.now(),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "refuse",
        byUserId: "u_jesse",
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_evicted")],
      });

      expect(outcome).toEqual({ refused: "frozen", removed: false, codeRetired: null });
    });

    it("removeMember refuses a closed room even when frozen is allowed", async () => {
      // "allow" is about the freeze and nothing else. A closed room is over, and
      // writing a departure into it would reopen the question of what closed means.
      const s = session({
        closed: true,
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      expect(await store.removeMember(s.id, "m_peer", {
        now: 9_000_000, frozen: "allow", event: leaveEvent("m_peer"), audit: [],
      })).toEqual({ refused: "closed", removed: false, codeRetired: null });
    });

    it("removeMember refuses a caller who did not create the room", async () => {
      const s = session({
        createdBy: "u_jesse",
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      expect(await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "refuse",
        byUserId: "u_someone_else",
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_evicted")],
      })).toEqual({ refused: "forbidden", removed: false, codeRetired: null });
    });

    it("removeMember answers not_found for an unknown room and an unknown member", async () => {
      const s = session({ members: [member({ memberId: "m_creator" })] });
      await store.createSession(s);

      expect(await store.removeMember("qs_nope", "m_creator", {
        now: 1, frozen: "allow", event: leaveEvent("m_creator"), audit: [],
      })).toEqual({ refused: "not_found", removed: false, codeRetired: null });

      expect(await store.removeMember(s.id, "m_ghost", {
        now: 1, frozen: "allow", event: leaveEvent("m_ghost"), audit: [],
      })).toEqual({ refused: "not_found", removed: false, codeRetired: null });
    });

    /** Review Focus 2. */
    it("removeMember writes and queues nothing for a member who is already out", async () => {
      const s = session({
        members: [
          member({ memberId: "m_creator" }),
          member({ memberId: "m_peer", userId: "u_peer", leftAt: 5_000 }),
        ],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_left")],
      });

      expect(outcome).toEqual({ refused: null, removed: false, codeRetired: null });
      // The original stamp stands: a retry must not restate when they went.
      expect((await store.getSession(s.id))!.members.find((m) => m.memberId === "m_peer")?.leftAt)
        .toBe(5_000);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    /** Review Focus 1. */
    it("removeMember writes and queues nothing when it refuses", async () => {
      const s = session({
        closed: true,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        event: leaveEvent("m_peer"),
        retire: { role: "peer_b", event: leaveEvent("m_peer") },
        audit: [auditRow("member_left")],
      });

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
      expect(fresh.joinCodes["peer_b"]?.code).toBe("BELL-LIVE-01");
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember retires a live code and writes its event, in the member's order", async () => {
      const s = session({
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "refuse",
        byUserId: "u_jesse",
        event: { ...leaveEvent("m_peer"), type: "member_evicted" },
        retire: { role: "peer_b", event: { ...leaveEvent("m_peer"), type: "invite_revoked" } },
        audit: [auditRow("member_evicted")],
      });

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
      expect((await store.getSession(s.id))!.joinCodes["peer_b"]).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
      // The member went, then the door shut — the order a person would tell it.
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
        .toEqual(["member_evicted", "invite_revoked"]);
    });

    /** Review Focus 3. */
    it("removeMember does not retire a code that has already expired", async () => {
      // Nothing prunes an expired record, so presence in joinCodes is not the
      // same as a door being open. Retiring on presence alone announces a
      // closing that already happened.
      const s = session({
        joinCodes: { peer_b: { code: "BELL-STALE-1", expiresAt: Date.now() - 1 } },
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: Date.now(),
        frozen: "refuse",
        byUserId: "u_jesse",
        event: { ...leaveEvent("m_peer"), type: "member_evicted" },
        retire: { role: "peer_b", event: { ...leaveEvent("m_peer"), type: "invite_revoked" } },
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      expect(outcome.codeRetired).toBeNull();
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_evicted"]);
    });
```

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run tests/store.test.ts -t removeMember`
Expected: FAIL — `store.removeMember is not a function`.

- [ ] **Step 5: Implement `MemoryStore.removeMember`**

In `src/store.ts`, directly after `MemoryStore.seatMember`, add:

```ts
  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    // No await from here to the last write, deliberately — the same rule, and
    // the same reason, as seatMember and closeSessionIfEmpty. The Durable
    // Objects store gets it from a transaction instead.
    const none = { removed: false, codeRetired: null };
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", ...none };
    if (s.closed) return { refused: "closed", ...none };
    if (req.frozen === "refuse" && s.frozenAt !== null) return { refused: "frozen", ...none };
    if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
      return { refused: "forbidden", ...none };
    }
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return { refused: "not_found", ...none };
    // Already out: the departure is not restated. Not licence to skip what is
    // still owed, though — a live door is shut below.
    if (m.leftAt !== null) return { refused: null, ...none };

    // One value for "there is a live door to shut", so nothing downstream has to
    // re-derive it. Nothing prunes an expired record, so a code's presence in
    // joinCodes is not the same as a door being open.
    const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
    const retiring = req.retire && rec && req.now <= rec.expiresAt
      ? { role: req.retire.role, code: rec.code, event: req.retire.event }
      : null;

    m.leftAt = req.now;
    this.appendNow(s, req.event);
    if (retiring) {
      this.byJoinCode.delete(retiring.code);
      delete s.joinCodes[retiring.role];
      this.appendNow(s, retiring.event);
    }
    for (const entry of req.audit) if (entry.orgId) this.audit.push(detach(entry));

    return { refused: null, removed: true, codeRetired: retiring?.role ?? null };
  }
```

Add `RemovalOutcome` and `RemovalRequest` to this file's own type usage; they are declared above in the same module, so no import changes.

- [ ] **Step 6: Run the Node contract to verify it passes**

Run: `npx vitest run tests/store.test.ts -t removeMember`
Expected: PASS, 10 tests.

- [ ] **Step 7: Implement `SessionDO.removeMember`**

First widen this file's type import from `./store.js` to include `RemovalOutcome` and `RemovalRequest`, beside `SeatOutcome`. `SessionEvent` and `eventKey` are already in scope.

In `src/store-do.ts`, directly after `SessionDO.seatMember`, add:

```ts
  async removeMember(
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    // `written` rides out of the closure so the wake can happen after the
    // commit, the way appendEvent does it: nobody hears of an event that did
    // not land. It is stripped before the result goes back over RPC.
    const outcome = await this.ctx.storage.transaction<
      RemovalOutcome & { written: SessionEvent[] }
    >(async (txn) => {
      const no = { removed: false, codeRetired: null, written: [] };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (req.frozen === "refuse" && s.frozenAt !== null) {
        return { refused: "frozen" as const, ...no };
      }
      if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
        return { refused: "forbidden" as const, ...no };
      }
      const m = s.members.find((mm) => mm.memberId === memberId);
      if (!m) return { refused: "not_found" as const, ...no };
      // Already out: the departure is not restated, which is the half an
      // idempotency key could not cover. A live door is still shut below.
      if (m.leftAt !== null) return { refused: null, ...no };

      // One value for "there is a live door to shut". Nothing prunes an expired
      // record, so a code's presence in joinCodes is not the same as a door
      // being open, and retiring on presence announces a closing that already
      // happened.
      const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
      const retiring = req.retire && rec && req.now <= rec.expiresAt
        ? { role: req.retire.role, code: rec.code, event: req.retire.event }
        : null;

      const members = s.members.map(
        (mm) => (mm.memberId === memberId ? { ...mm, leftAt: req.now } : mm)
      );
      const joinCodes = { ...s.joinCodes };
      if (retiring) delete joinCodes[retiring.role];

      // Written through the private writer, not appendEvent: the frozen refusal
      // lives on the public append and stays there, because it is what stops a
      // freeze landing between a tool's read and its write and letting a room
      // grow. This operation declares its own policy through `frozen`. The
      // store still never asks what an event means — it writes what it was given.
      //
      // The order is the one a person would tell it: the member went, then the
      // door shut.
      let cursor = await this.nextCursor(txn);
      const at = Date.now();
      const written: SessionEvent[] = [{ ...req.event, cursor, at }];
      if (retiring) written.push({ ...retiring.event, cursor: ++cursor, at });

      // A falsy org names a stream nobody reads, so it is filtered before it is
      // queued as well as before it is delivered. Two defences, for the reason
      // ARCHITECTURE.md section 9 runtime fact 4 gives.
      const intents = req.audit.filter((e) => e.orgId).map(auditIntent);
      const codeRows = retiring ? [dropCodeIntent(retiring.code)] : [];
      const rows = await this.driver.enqueue(txn, [...codeRows, ...intents]);

      await txn.put<unknown>({
        session: { ...s, members, joinCodes },
        ...Object.fromEntries(written.map((e) => [eventKey(e.cursor), e])),
        cursor,
        ...rows,
      });
      return { refused: null, removed: true, codeRetired: retiring?.role ?? null, written };
    });

    const { written, ...result } = outcome;
    // After the commit, never inside the closure: everything awaited in there
    // holds every other call to this object until it commits, and reArm() reads
    // stored(). A member leaving can take the last reporting seat with them, so
    // the derived tick may have moved.
    for (const e of written) this.#wake(e);
    if (result.removed) {
      await this.driver.deliverNow();
      await this.driver.reArm();
    }
    return result;
  }
```

- [ ] **Step 8: Implement the facade**

In `src/store-do.ts`, in `DurableObjectStore`, directly after `seatMember`, add:

```ts
  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    return this.session(sessionId).removeMember(memberId, req);
  }
```

- [ ] **Step 9: Run both programs**

Run: `npx vitest run tests/store.test.ts` then `npm run test:worker -- store-contract`
Expected: PASS in both. The same ten cases run against `DurableObjectStore` inside workerd.

- [ ] **Step 10: Break it on purpose, three ways, and quote each failure**

Each of these is a mistake a reader of the final code would not catch.

1. Change the idempotent path to `return { refused: null, removed: true, codeRetired: null }`. The "already out" case fails on the event list. Put it back.
2. Change `req.now <= rec.expiresAt` to `rec !== undefined`. The expired-code case fails on `codeRetired`. Put it back.
3. Move `const intents = …` above the `if (m.leftAt !== null)` early return and enqueue unconditionally. The "already out" case fails on the audit list. Put it back.

If any of the three will not go red, the case never reached the code it names.

- [ ] **Step 11: Commit**

```bash
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "Make a member's removal one store operation

leaveRoom read leftAt and wrote it with an await between, so two calls on
one handle both announced. evictMember guarded on a snapshot and mutated
after it. And a leave from a frozen room lost its event, because the
public append refuses while frozen.

removeMember does the guard, the stamp, the event, the code and the audit
rows in one transaction, and reports what it did. Nothing calls it yet."
```

---

## Task 3: Move `leaveRoom` and `evictMember` onto it

This is where #73, #117 and #118 close. The handler keeps what the store cannot know: the sentence the caller reads, the event and audit bodies, and the closing.

**Files:**
- Modify: `src/rooms.ts` — `leaveRoom`, `evictMember`, and `announceDoorShut`
- Test: `tests/rooms.test.ts` (add cases; the file exists)

**Interfaces:**
- Consumes: `removeMember`, `RemovalOutcome` from Task 2
- Produces: no new exports. `leaveRoom` and `evictMember` keep their current signatures and return shapes, so `src/server.ts` does not change in this task.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rooms.test.ts`:

```ts
  it("leaveRoom announces the departure from a frozen room", async () => {
    // #73. The event is how peers learn someone is gone; losing it leaves them
    // showing a member who left.
    const s = session({
      frozenAt: Date.now(),
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    const result = await leaveRoom(store, peer, s.id, "m_peer");

    expect(result.ok).toBe(true);
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
  });

  it("leaveRoom announces once when two first-time leaves race on one handle", async () => {
    // #117. Both calls read leftAt as null under the old shape, and both
    // announced and audited.
    const s = session({
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    await Promise.all([
      leaveRoom(store, peer, s.id, "m_peer"),
      leaveRoom(store, peer, s.id, "m_peer"),
    ]);

    expect((await store.eventsAfter(s.id, 0)).filter((e) => e.type === "member_left")).toHaveLength(1);
    expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.action === "member_left"))
      .toHaveLength(1);
  });

  it("evictMember refuses a room frozen under it, writing nothing", async () => {
    // #118. The guard and the write are one transaction, so a freeze cannot
    // land between them and have the removal go through against a room whose
    // writes were meant to have stopped.
    const s = session({
      frozenAt: Date.now(),
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    const result = await evictMember(store, jesse, s.id, "m_peer");

    expect(result.ok).toBe(false);
    expect((await store.getSession(s.id))!.members.find((m) => m.memberId === "m_peer")?.leftAt)
      .toBeNull();
    expect(await store.eventsAfter(s.id, 0)).toEqual([]);
  });

  it("evictMember announces the removal and the door in one operation", async () => {
    const s = session({
      joinCodes: oneCode("BELL-LIVE-01"),
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    const result = await evictMember(store, jesse, s.id, "m_peer");

    expect(result.ok).toBe(true);
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
      .toEqual(["member_evicted", "invite_revoked"]);
  });
```

This file already provides everything these cases use, so add no imports and no local fixtures: `oneCode`, `member` and `session` come from `./helpers/fixtures.js`; `jesse` and `peer` are module-level `Identity` constants (`u_jesse`/`org_codenerd`/admin and `u_peer`/`org_codenerd`/member); and `store` is a fresh `MemoryStore` from the file's `beforeEach`. Do not declare a second `store` inside a case — it would shadow the shared one and silently test a different object.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/rooms.test.ts`
Expected: FAIL. The frozen-leave case finds no `member_left`; the racing case finds two; the frozen-evict case finds the member stamped out anyway.

- [ ] **Step 3: Rewrite `leaveRoom`**

Replace `leaveRoom`'s body in `src/rooms.ts` with:

```ts
export async function leaveRoom(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
): Promise<RoomResult<{ sessionStatus: string }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");
  const me = findMember(session, memberId, actor);
  if (!me) return refuse("forbidden", "member_id is not yours.");

  // One operation: the guard, the stamp, the departure and the audit row. Read
  // then write was the bug — two calls on one handle both saw leftAt null and
  // both announced (#117) — and the frozen room lost the event outright, because
  // the public append refuses while frozen and leaving must never be refused
  // (#73). `frozen: "allow"` is that rule, said once, here.
  const outcome = await store.removeMember(sessionId, memberId, {
    now: Date.now(),
    frozen: "allow",
    event: {
      type: "member_left",
      fromMemberId: memberId,
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { label: actor.label },
      refId: null,
    },
    audit: auditEntries(session, actor, "member_left", {}),
  });

  if (outcome.refused === "closed") return refuse("closed", "session is closed.");
  if (outcome.refused !== null) return refuse("not_found", "session not found.");

  // The closing is a separate decision and stays one. `closeSessionIfEmpty`
  // makes it atomically; folding it into the removal would close the room over
  // a member who joined in the gap. A removal that died before this leaves the
  // room empty and open, and a retry — which now takes the idempotent path,
  // writing nothing — still reaches here and heals it.
  return succeed({ sessionStatus: await closeIfEmpty(store, session) });
}
```

- [ ] **Step 4: Split `audit` into a builder and a writer**

`removeMember` takes the entries rather than writing them, so the rule that decides which orgs get a row has to be callable without writing. In `src/rooms.ts`, replace `audit` with:

```ts
/**
 * Which orgs get a row for this action, and what it says. One rule, in one
 * place, for the callers that write it themselves and the ones that hand it to
 * a store operation to commit with the mutation it records.
 */
export function auditEntries(
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): AuditEntry[] {
  const orgs = new Set<string | null>([session.orgId, actor.orgId, ...alsoOrgs]);
  const at = Date.now();
  return [...orgs]
    .filter((orgId): orgId is string => orgId !== null)
    .map((orgId) => ({
      at, orgId, sessionId: session.id, actorUserId: actor.userId, action, detail,
    }));
}

export async function audit(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): Promise<void> {
  for (const entry of auditEntries(session, actor, action, detail, alsoOrgs)) {
    await store.appendAudit(entry);
  }
}
```

Every existing caller of `audit` keeps working unchanged.

- [ ] **Step 5: Rewrite `evictMember`**

Replace `evictMember`'s body in `src/rooms.ts` with:

```ts
export async function evictMember(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  targetMemberId: string,
): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");

  // A direct lookup, NOT findMember: that helper requires the handle to belong
  // to the caller, which is the one thing eviction has to do differently. Read
  // here only to say WHICH refusal the caller reads and to build the rows; the
  // guards that decide whether the write happens are inside removeMember, where
  // a freeze landing in this gap cannot slip past them (#118).
  const target = session.members.find((m) => m.memberId === targetMemberId);
  if (!target) return refuse("not_found", "no member with that member_id is in this room.");
  if (target.userId === actor.userId) {
    // Names no tool and no route. This module serves every transport, and a panel
    // user cannot call an MCP tool: advice naming one is advice half the callers
    // cannot act on. An agent reading "leave the room" knows which tool does that.
    return refuse("forbidden", "you cannot evict yourself; leave the room instead.");
  }

  const outcome = await store.removeMember(sessionId, targetMemberId, {
    now: Date.now(),
    frozen: "refuse",
    byUserId: session.createdBy,
    event: {
      type: "member_evicted",
      // No member handle to name: creator authority is on the user, and a
      // creator who has left the room still holds it. "system" is the existing
      // marker for a server-originated event; the creator is in fromUserId.
      fromMemberId: "system",
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { member_id: targetMemberId, label: target.label, room_role: target.roomRole },
      refId: null,
    },
    // The door and the member go together now. Under the old shape the door
    // shut FIRST and deliberately, so a failure left the member in with the
    // door shut rather than out with it open — over-revoking is recoverable by
    // minting again, under-revoking leaves a door open behind someone who
    // believes it shut. One transaction makes both land or neither, so the
    // ordering no longer carries that. The events are still written in the
    // order a person would tell it: the member went, then the door shut.
    retire: { role: target.roomRole, event: doorShutEvent(actor, target.roomRole) },
    audit: auditEntries(
      session, actor, "member_evicted",
      {
        // The seat and the person. member_id is per connection and only resolves
        // inside the room, so user_id is what lets an org reading its own log see
        // which of its people went; member_id stays for when one person holds two.
        // No `code_retired` here. Whether a door shut is the store's answer,
        // not this handler's prediction, and the `invite_revoked` event the
        // store writes in the same transaction is where it is recorded. A
        // predicted field in an audit row is the shape this PR exists to remove.
        member_id: targetMemberId, user_id: target.userId, room_role: target.roomRole,
      },
      // The evicted member's org as well. The actor here is the creator, not the
      // member, so unless that org is also the room's it would get no row.
      [target.orgId],
    ),
  });

  if (outcome.refused === "closed") return refuse("closed", "session is closed.");
  if (outcome.refused === "frozen") return refuse("frozen", FROZEN);
  if (outcome.refused === "forbidden") {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }
  if (outcome.refused !== null) return refuse("not_found", "session not found.");

  return succeed({
    evicted: true,
    codeRetired: outcome.codeRetired,
    // Last, as before: whatever came after the close would be lost, because
    // every later call refuses on "closed".
    sessionStatus: await closeIfEmpty(store, session),
  });
}
```

Replace `announceDoorShut` with the body-builder it becomes:

```ts
/** The event that says a role's door has shut. Built here, written by the store. */
function doorShutEvent(actor: Identity, role: string) {
  return {
    type: "invite_revoked",
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { roles: [role] },
    refId: null,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/rooms.test.ts`
Expected: PASS. Existing cases in this file must pass unchanged; if one about repeated leaves fails, read it — it is titled for sequential repeats and its expectations should still hold.

- [ ] **Step 7: Run the whole Node program**

Run: `npm test`
Expected: PASS. `tests/server.test.ts` drives `bellman_leave` and `bellman_evict` through the real handlers; a changed refusal string shows up there.

- [ ] **Step 8: Break it on purpose, and quote the failure**

Change `frozen: "allow"` to `frozen: "refuse"` in `leaveRoom`, run `npx vitest run tests/rooms.test.ts`, and confirm the frozen-leave case fails — a member trapped in a frozen room is the regression this flag exists to prevent. Put it back and re-run.

- [ ] **Step 9: Commit**

```bash
git add src/rooms.ts tests/rooms.test.ts
git -c commit.gpgsign=true commit -S -m "Leave and evict through removeMember, so the guard and the write are one

Closes the three the split produced: a departure from a frozen room is
announced rather than swallowed, a freeze landing mid-eviction cannot slip
past the guard it was checked against, and two first-time leaves on one
handle announce once.

The closing stays a separate decision, and the retry that heals it still
reaches it."
```

---

## Task 4: `seatMember` clears the codes that its own seat filled

#116. `bellman_confirm` calls `clearJoinCodes` after `SessionDO` has committed the seat, reaching a second object with nothing spanning it. `seatMember` already decides capacity inside its transaction and already queues registry drops, so the clearing belongs in that closure.

**Files:**
- Modify: `src/store.ts` — `SeatOutcome`, `MemoryStore.seatMember`
- Modify: `src/store-do.ts` — `SessionDO.seatMember`
- Modify: `src/server.ts` — `bellman_confirm`
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `SeatOutcome` from `src/store.ts`
- Produces: `SeatOutcome.codesCleared: boolean`

- [ ] **Step 1: Write the failing contract cases**

Append inside `describeStoreContract`:

```ts
    it("seatMember clears the room's codes when the seat it took filled the room", async () => {
      // #116. This used to be a second call after the seat had committed, in
      // another object, with nothing spanning the two: if it threw, the member
      // was in the room with no event, no audit row and no member_id returned,
      // and the connect token that got them there is single use.
      const s = session({
        maxMembers: 2,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);

      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }), 1, 9_000_000,
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.codesCleared).toBe(true);
      expect((await store.getSession(s.id))!.joinCodes).toEqual({});
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
    });

    it("seatMember leaves the codes alone when a stale seat could still be reclaimed", async () => {
      // The room has no FREE seat, but one is reclaimable, so a further joiner
      // would get in and the door stays open. Counting members with a null
      // leftAt would retire the code here and lock them out.
      const s = session({
        maxMembers: 2,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [
          member({ memberId: "m_quiet_a", lastSeenAt: 1 }),
          member({ memberId: "m_quiet_b", userId: "u_b", roomRole: "peer_b", lastSeenAt: 2 }),
        ],
      });
      await store.createSession(s);

      // Both seats are stale, so this joiner reclaims ONE and the other stays
      // occupied but reclaimable. A further joiner would still get in, so the
      // door stays open. Both members fresh after the seating would be the
      // other case, and that one DOES clear.
      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
        1_000_000, 9_000_000,
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.reclaimed).toHaveLength(1);
      expect(outcome.codesCleared).toBe(false);
      expect((await store.getSession(s.id))!.joinCodes["peer_b"]?.code).toBe("BELL-LIVE-01");
    });

    it("seatMember leaves the codes alone when a seat is still spare", async () => {
      const s = session({
        maxMembers: 5,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);

      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }), 1, 9_000_000,
      );

      expect(outcome.codesCleared).toBe(false);
      expect((await store.getSession(s.id))!.joinCodes["peer_b"]?.code).toBe("BELL-LIVE-01");
    });

    /** Review Focus 5. */
    it("seatMember clears no codes when it refuses the seating", async () => {
      const s = session({
        maxMembers: 1,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator", lastSeenAt: Date.now() })],
      });
      await store.createSession(s);

      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }), 1, 9_000_000,
      );

      expect(outcome.refused).toBe("full");
      expect(outcome.codesCleared).toBe(false);
      expect((await store.getSession(s.id))!.joinCodes["peer_b"]?.code).toBe("BELL-LIVE-01");
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store.test.ts -t seatMember`
Expected: FAIL — `expected undefined to be true` on `codesCleared`.

- [ ] **Step 3: Widen `SeatOutcome`**

In `src/store.ts`:

```ts
export interface SeatOutcome {
  refused: "not_found" | "closed" | "frozen" | "full" | null;
  reclaimed: Member[];
  /** The seating filled the room, so every role's code was retired with it. */
  codesCleared: boolean;
}
```

- [ ] **Step 4: Update `MemoryStore.seatMember`**

Every refusal gains `codesCleared: false`. Replace the three refusal returns and the tail:

```ts
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", reclaimed: [], codesCleared: false };
    if (s.closed) return { refused: "closed", reclaimed: [], codesCleared: false };
    if (s.frozenAt !== null) return { refused: "frozen", reclaimed: [], codesCleared: false };

    const connected = connectedAmong(s.members, this.attachedTo(sessionId));
    const victims = seatVictims(s.members, s.maxMembers, staleBefore, connected);
    if (victims === null) return { refused: "full", reclaimed: [], codesCleared: false };

    const reclaimed: Member[] = [];
    for (const v of victims) {
      const row = s.members.find((m) => m.memberId === v.memberId)!;
      row.leftAt = now;
      reclaimed.push(detach(row));
    }
    s.members.push(detach(member));
    // After the guards, so a refused seating leaves no trace in the listing.
    this.indexMember(member.userId, sessionId);

    // A full room has no seat for ANY role, so every code goes — decided and
    // written here rather than by the caller afterwards. As a second call in
    // another object it had nothing spanning it: a failure left the joiner
    // seated with the codes still redeemable (#116).
    //
    // "Full" is asked the only way that preserves what the caller used to
    // compute: whether a FURTHER joiner would be refused. Counting members with
    // a null leftAt is not the same question — a stale seat is occupied but
    // reclaimable, so a room with one still has a door worth leaving open, and
    // counting would have retired its code.
    const full = seatVictims(s.members, s.maxMembers, staleBefore, connected) === null;
    if (full) {
      for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
      s.joinCodes = {};
    }
    return { refused: null, reclaimed, codesCleared: full };
```

- [ ] **Step 5: Update `SessionDO.seatMember`**

Replace its closure's refusals and tail:

```ts
  async seatMember(member: Member, staleBefore: number, now: number): Promise<SeatOutcome> {
    const outcome = await this.ctx.storage.transaction<SeatOutcome>(async (txn) => {
      const no = { reclaimed: [], codesCleared: false };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (s.frozenAt !== null) return { refused: "frozen" as const, ...no };

      // The sockets as they are now, read here and not passed in. It is
      // synchronous and inside the transaction, so the decision is made against
      // the sockets that exist while this holds the object. A set fetched by the
      // caller first could not promise that: a member can connect in the gap, and
      // reclaiming it is final.
      const connected = connectedAmong(s.members, this.#attachedIds());
      const victims = seatVictims(s.members, s.maxMembers, staleBefore, connected);
      if (victims === null) return { refused: "full" as const, ...no };

      const departed = new Set(victims.map((v) => v.memberId));
      const reclaimed: Member[] = [];
      const members = s.members.map((m) => {
        if (!departed.has(m.memberId)) return m;
        const next = { ...m, leftAt: now };
        reclaimed.push(next);
        return next;
      });
      const seated = [...members, member];

      // A full room has no seat for ANY role, so every code goes — in this
      // transaction, not in a second call to another object after it committed
      // (#116). The registry drops ride the same outbox clearJoinCodes uses.
      //
      // "Full" is asked the only way that preserves what bellman_confirm used to
      // compute: whether a FURTHER joiner would be refused. Counting members with
      // a null leftAt is not the same question — a stale seat is occupied but
      // reclaimable, so a room with one still has a door worth leaving open.
      const full = seatVictims(seated, s.maxMembers, staleBefore, connected) === null;
      const codes = full ? Object.values(s.joinCodes).map((rec) => rec.code) : [];
      const rows = await this.driver.enqueue(txn, codes.map((code) => dropCodeIntent(code)));

      await txn.put<unknown>({
        session: { ...s, members: seated, joinCodes: full ? {} : s.joinCodes },
        ...rows,
      });
      return { refused: null, reclaimed, codesCleared: full };
    });
    if (outcome.refused === null) {
      if (outcome.codesCleared) await this.driver.deliverNow();
      await this.driver.reArm();
    }
    return outcome;
  }
```

- [ ] **Step 6: Run both contracts**

Run: `npx vitest run tests/store.test.ts -t seatMember` then `npm run test:worker -- store-contract`
Expected: PASS in both.

- [ ] **Step 6b: Correct two descriptions in `src/server.ts` that the removal change made false**

Found by Task 3's implementer, outside its own files.

- `bellman_evict`'s description says an eviction completes "unless the room freezes at that instant: the removal still completes, unannounced." That is no longer true: a freeze reaching the store before the guard is refused with the frozen sentence, and one arriving after the commit finds the event already written. Delete that clause. (`tests/tools/invite.test.ts` pins the INVITE tool's equivalent sentence, which is still true — do not touch that one.)
- The `idempotentHint` comment says a retry "finishes an eviction that died partway, whatever of the door, the removal and the closing was left undone." For an active member only the closing can be left undone now, because the door and the removal commit together. Say that.

- [ ] **Step 7: Take the clearing out of `bellman_confirm`**

In `src/server.ts`, delete these lines from the confirm handler:

```ts
      // A full pair session has no seat for ANY role, so every code goes.
      if (seatedMembers(joined, Date.now(), connected).length >= joined.maxMembers) {
        await s.clearJoinCodes(joined.id);
      }
```

The seating already did it. If `seatedMembers` or `connected` becomes unused as a result, leave them — `connected` is used by the roster below; check `seatedMembers`' other uses in this file before removing its import.

- [ ] **Step 8: Run the whole Node program**

Run: `npm test`
Expected: PASS. `tests/server.test.ts` covers a pair room filling and its code going dead.

- [ ] **Step 9: Break it on purpose, and quote the failure**

Change `>= s.maxMembers` to `> s.maxMembers` in `SessionDO.seatMember`, run `npm run test:worker -- store-contract`, and confirm the filling case fails with `expected false to be true`. An off-by-one here leaves a pair room's code live after it filled, which is the door #116 is about. Put it back and re-run.

- [ ] **Step 10: Commit**

```bash
git add src/store.ts src/store-do.ts src/server.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "Clear a filled room's codes inside the seating that filled it

bellman_confirm cleared them in a second call to another object after the
seat had committed. If it threw, the member was in the room with no
member_joined, no audit row and no member_id returned, and the connect
token that got them there is single use, so the retry could not replay."
```

---

## Task 5: The race windows, the documentation, and the PR

The contract suite proves the operations. These prove the windows they were built to close, in the runtime where the windows exist.

**Files:**
- Test: `worker-tests/removal-race.test.ts` (create)
- Modify: `docs/ARCHITECTURE.md` — §9

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: nothing code depends on

- [ ] **Step 1: Write the worker tests**

Create `worker-tests/removal-race.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../src/store-do.js";
import { DurableObjectStore } from "../src/store-do.js";

const store = () => new DurableObjectStore(env);

const body = (type: string, memberId: string) => ({
  type, fromMemberId: memberId, fromUserId: "u_peer",
  fromLabel: "peer@codenerd", payload: {}, refId: null,
});

async function room(id: string) {
  const s = store();
  await s.createSession({
    id,
    manifest: { mode: "pair", defaultRole: "peer_a", roles: {} } as never,
    frozenAt: null, createdBy: "u_jesse", orgId: "org_codenerd", orgOnly: false,
    joinCodes: {}, expiresAt: Date.now() + 3_600_000, maxMembers: 4,
    members: [
      { memberId: "m_creator", userId: "u_jesse", label: "jesse", orgId: "org_codenerd",
        capabilities: [], roomRole: "peer_a", brief: {} as never,
        joinedAt: Date.now(), lastSeenAt: Date.now(), leftAt: null, lastReportAt: null } as never,
      { memberId: "m_peer", userId: "u_peer", label: "peer", orgId: "org_codenerd",
        capabilities: [], roomRole: "peer_b", brief: {} as never,
        joinedAt: Date.now(), lastSeenAt: Date.now(), leftAt: null, lastReportAt: null } as never,
    ],
    events: [], closed: false,
  } as never);
  return s;
}

describe("removeMember under concurrency", () => {
  it("records one departure when two calls race on one handle", async () => {
    // #117, in the runtime where the input gate is real. Dispatched without an
    // await between them, so both are in flight before either commits.
    const s = await room("qs_race_leave");
    const req = {
      now: Date.now(), frozen: "allow" as const, event: body("member_left", "m_peer"), audit: [],
    };

    const [a, b] = await Promise.all([
      s.removeMember("qs_race_leave", "m_peer", req),
      s.removeMember("qs_race_leave", "m_peer", req),
    ]);

    expect([a.removed, b.removed].filter(Boolean)).toHaveLength(1);
    const events = await s.eventsAfter("qs_race_leave", 0);
    expect(events.filter((e) => e.type === "member_left")).toHaveLength(1);
  });

  it("does not remove a member from a room frozen in the same round", async () => {
    // #118. A freeze dispatched alongside the eviction: whichever lands first,
    // the two outcomes that are allowed are a removal from an unfrozen room or
    // a refusal from a frozen one. A removal from a FROZEN room is the bug.
    const s = await room("qs_race_freeze");

    const [outcome] = await Promise.all([
      s.removeMember("qs_race_freeze", "m_peer", {
        now: Date.now(), frozen: "refuse", byUserId: "u_jesse",
        event: body("member_evicted", "system"), audit: [],
      }),
      s.freezeSession("qs_race_freeze", Date.now()),
    ]);

    const fresh = (await s.getSession("qs_race_freeze"))!;
    const peer = fresh.members.find((m) => m.memberId === "m_peer")!;
    if (outcome.removed) {
      // It won the race. The room it wrote to was not frozen at the time, and
      // the event landed with the stamp.
      expect(peer.leftAt).not.toBeNull();
      expect((await s.eventsAfter("qs_race_freeze", 0)).map((e) => e.type))
        .toContain("member_evicted");
    } else {
      expect(outcome.refused).toBe("frozen");
      expect(peer.leftAt).toBeNull();
      expect(await s.eventsAfter("qs_race_freeze", 0)).toEqual([]);
    }
  });

  /**
   * Review Focus 1 and 2, pinned directly rather than through delivery.
   *
   * The contract suite can only see "queued nothing" by looking for a delivered
   * row, and in the Workers program that is visible at all only because the
   * suite's fake clock makes the outbox's five-second grace alarm overdue at
   * once. On a real clock a refused call could leave rows sitting in `ob:` and
   * the contract case would still pass. This reads the queue itself.
   */
  it("leaves the outbox empty when the removal is refused and when it is a no-op", async () => {
    const s = await room("qs_queue_empty");
    await s.freezeSession("qs_queue_empty", Date.now());

    const refused = await s.removeMember("qs_queue_empty", "m_peer", {
      now: Date.now(), frozen: "refuse", byUserId: "u_jesse",
      event: body("member_evicted", "system"),
      retire: { role: "peer_b", event: body("invite_revoked", "system") },
      audit: [{
        at: Date.now(), orgId: "org_codenerd", sessionId: "qs_queue_empty",
        actorUserId: "u_jesse", action: "member_evicted", detail: {},
      }],
    });
    expect(refused.refused).toBe("frozen");

    const id = env.SESSION.idFromName("qs_queue_empty");
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      expect([...(await ctx.storage.list({ prefix: "ob:" })).keys()]).toEqual([]);
    });

    // And the idempotent path: a member already out queues nothing either.
    await s.freezeSession("qs_queue_empty", null);
    await s.removeMember("qs_queue_empty", "m_peer", {
      now: Date.now(), frozen: "allow", event: body("member_left", "m_peer"), audit: [],
    });
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      await ctx.storage.delete([...(await ctx.storage.list({ prefix: "ob:" })).keys()]);
    });
    const again = await s.removeMember("qs_queue_empty", "m_peer", {
      now: Date.now(), frozen: "allow", event: body("member_left", "m_peer"),
      audit: [{
        at: Date.now(), orgId: "org_codenerd", sessionId: "qs_queue_empty",
        actorUserId: "u_peer", action: "member_left", detail: {},
      }],
    });
    expect(again.removed).toBe(false);
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      expect([...(await ctx.storage.list({ prefix: "ob:" })).keys()]).toEqual([]);
    });
  });

  /**
   * The door-only path: a member already out, whose seat's code is still live.
   * It writes an event and queues rows WITHOUT recording a departure, and it is
   * the one path on which nothing else pins the delivery — the contract suite
   * sees the audit row only because the pinned clock makes the outbox's grace
   * alarm overdue at once, so a missing deliverNow() there goes unnoticed.
   */
  it("drains the queue on the door-only path, and queues no org-less row", async () => {
    const s = await room("qs_door_only");
    await s.setJoinCode("qs_door_only", "peer_b", "BELL-DOOR-01", Date.now() + 900_000);
    await s.removeMember("qs_door_only", "m_peer", {
      now: Date.now(), frozen: "allow", event: body("member_left", "m_peer"), audit: [],
    });

    const outcome = await s.removeMember("qs_door_only", "m_peer", {
      now: Date.now(),
      frozen: "refuse",
      byUserId: "u_jesse",
      event: body("member_evicted", "system"),
      retire: {
        role: "peer_b",
        event: body("invite_revoked", "system"),
        audit: [
          { at: Date.now(), orgId: "org_codenerd", sessionId: "qs_door_only",
            actorUserId: "u_jesse", action: "invite_revoked", detail: { roles: ["peer_b"] } },
          // Org-less: the producer must drop it before it is ever queued.
          { at: Date.now(), orgId: null, sessionId: "qs_door_only",
            actorUserId: "u_jesse", action: "invite_revoked", detail: {} },
        ],
      },
      audit: [],
    });

    // The departure is not restated, but the door that was still open is shut.
    expect(outcome.removed).toBe(false);
    expect(outcome.codeRetired).toBe("peer_b");

    const id = env.SESSION.idFromName("qs_door_only");
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      // Drained inline, not left for the alarm.
      expect([...(await ctx.storage.list({ prefix: "ob:" })).keys()]).toEqual([]);
    });
    // One row, not two: the org-less entry never entered the queue.
    expect(await s.auditForOrg("org_codenerd", 10)).toHaveLength(1);

    // An unknown member must not retire the door or queue rows on its way to
    // refusing. The contract suite catches this through an audit read that races
    // the delivering alarm; reading the queue is the deterministic form.
    const unknown = await s.removeMember("qs_door_only", "m_ghost", {
      now: Date.now(),
      frozen: "refuse",
      byUserId: "u_jesse",
      event: body("member_evicted", "system"),
      retire: { role: "peer_a", event: body("invite_revoked", "system"), audit: [
        { at: Date.now(), orgId: "org_codenerd", sessionId: "qs_door_only",
          actorUserId: "u_jesse", action: "invite_revoked", detail: {} },
      ] },
      audit: [],
    });
    expect(unknown.refused).toBe("not_found");
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      expect([...(await ctx.storage.list({ prefix: "ob:" })).keys()]).toEqual([]);
    });
  });

  it("keeps the removal when the audit delivery is still owed", async () => {
    // The row is queued in the removal's transaction, so a delivery that has
    // not happened yet cannot unmake the departure. The alarm is what finishes it.
    const s = await room("qs_audit_owed");
    const outcome = await s.removeMember("qs_audit_owed", "m_peer", {
      now: Date.now(),
      frozen: "allow",
      event: body("member_left", "m_peer"),
      audit: [{
        at: Date.now(), orgId: "org_codenerd", sessionId: "qs_audit_owed",
        actorUserId: "u_peer", action: "member_left", detail: {},
      }],
    });

    expect(outcome.removed).toBe(true);
    expect((await s.getSession("qs_audit_owed"))!.members.find((m) => m.memberId === "m_peer")!.leftAt)
      .not.toBeNull();
    expect(await s.auditForOrg("org_codenerd", 10)).toHaveLength(1);
  });
});
```

The fixture above builds a session inline because `tests/helpers/fixtures.ts` is in the root program. If `worker-tests/` already has a session helper, use it and delete the inline one.

- [ ] **Step 2: Run them**

Run: `npm run test:worker -- removal-race`
Expected: PASS, 5 tests — the no-org case runs once per shape.

- [ ] **Step 3: Break the race case on purpose, and quote the failure**

In `SessionDO.removeMember`, move the `if (m.leftAt !== null) return …` check to before the `transaction` call, reading through `this.stored()` instead of `txn`. Run `npm run test:worker -- removal-race` and confirm the racing case fails with two removals — the read-then-write shape restored, and the test seeing it. Put it back and re-run.

If it will not go red, the two calls are not overlapping; check they are dispatched without an await between them.

- [ ] **Step 4: Update ARCHITECTURE.md §9**

In the "Within one object the problem is tractable" paragraph, add `removeMember` to the list of single transactions beside `seatMember` and `addMember`. Then, after the `seatMember` paragraph, add:

```markdown
`removeMember` is the same shape for the other direction, and it goes one step
further than `seatMember` for a reason. A seating leaves its events to the
handler, because the handler knows which sentence the joiner reads. A removal
cannot: the event is the thing that was being lost. A leave from a frozen room
dropped its `member_left` outright, because the public append refuses while
frozen (#73); an eviction checked `closed` and `frozenAt` against a snapshot and
mutated afterwards, so a freeze landing in the window either wrote to a room
whose writes had stopped or swallowed the `member_evicted` the bridge disarms a
watcher on (#118); and two first-time leaves on one handle both read `leftAt` as
null and both announced (#117). So the caller hands the event bodies in and the
store writes them inside the transaction, through the private writer rather than
`appendEvent` — the frozen refusal stays on the public append, which is a
different operation, and this one declares its own policy. The store still never
asks what an event means.

Its audit rows ride a third outbox kind, `audit`, delivered `SessionDO → AuditDO`
and deduped on the intent id like the registry's. That is what closes the half of
#117 an idempotency key could not: `appendEventOnce` would have deduped the event
and left the audit row doubled.
```

Three existing sentences go stale with this change and are part of the same step:

- The §9 table's **"Where it lives"** row reads ``src/outbox.ts``, used `RegistryDO → AuditDO` and `SessionDO → RegistryDO`". Add `SessionDO → AuditDO`.
- **"It is used twice:"** above the two bulleted uses. It is used three times now. Change the count and add a third bullet for `SessionDO → AuditDO` (#73/#117), naming `AuditDO.append`'s intent-id dedupe as what absorbs a redelivery.
- **Runtime fact 4** ends "`hasOrg` in `src/grant-audit.ts` and the guard in `RegistryDO`'s `#deliver` are two defences for that reason." There are three now: add `SessionDO`'s `#deliver` guard and change "two" to "three". Note that `removeMember` also filters org-less entries at the producer before queueing them, so the guard is the second line rather than the only one.

In the "Rolling back" paragraph, add a sentence:

```markdown
A build with no `audit` branch in `SessionDO.#deliver` throws `outbox: unknown
kind audit` on such a row rather than skipping it, which blocks every row behind
it. Rolling back past this change strands a queued audit row the same way
rolling back past #62 strands a `due:outbox` marker.
```

- [ ] **Step 5: Run the whole verify**

Run: `npm run verify`
Expected: PASS — typecheck, typecheck:worker, build, test, test:worker.

- [ ] **Step 6: Commit the docs**

```bash
git add docs/ARCHITECTURE.md worker-tests/removal-race.test.ts
git -c commit.gpgsign=true commit -S -m "Hold the removal's windows open in workerd, and say so in section 9

The contract suite proves the operation. These prove the three windows it
was built to close, in the runtime where they exist: two leaves racing on
one handle, a freeze dispatched alongside an eviction, and an audit row
still owed after the departure has committed."
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin mcfearsome/the-atomocity-class
gh pr create --title "Sweep the atomicity class: one removal operation, not four fixes" --body "$(cat <<'BODY'
`CLAUDE.md` names the cross-object atomicity gap and `docs/ARCHITECTURE.md` §9 is
the section on it. Eleven issues were open against the question it asks. This is
PR 1 of four, and closes the four that are one operation split across three or
four store calls.

**`removeMember`** performs the guard, the `leftAt` write, the removal event, the
code retirement and its event, and queues the audit rows — in one `SessionDO`
transaction. The handler passes the event bodies in, so the store writes a record
it was given and never learns what an event means. The frozen refusal stays on
`appendEvent`; a removal declares its own policy.

**An `audit` outbox kind** on `SessionDO`, so a room's audit rows commit with the
mutation that earns them. `AuditDO.append` already dedupes on the intent id.

**`seatMember` clears a filled room's codes** inside the transaction that filled
it, so `bellman_confirm` makes no second-object call after the seat commits.

Peer content is untrusted as before; nothing here changes how it crosses or is
rendered.

Closes #73
Closes #116
Closes #117
Closes #118
BODY
)"
```

Confirm every `Closes` line is present before submitting: a narrow grep for one issue number is not evidence the others are there.

---

## Self-review

- **Spec coverage.** §Design 1 → Task 2. §Design 2 → Task 2, Step 7. §Design 3 → Task 1. §Design 4 → Task 4. §Design 5 → Task 3 (the closing stays in `leaveRoom` and `evictMember`). §Error handling 1–4 → Task 3's comments and Task 2's cases. §Compatibility → Task 5, Step 4. §Testing → Tasks 2, 4 (contract) and 5 (workerd).
- **Review Focus.** 1 → Task 2 Step 3. 2 → Task 2 Step 3. 3 → Task 2 Step 3. 4 → Task 1 Step 1. 5 → Task 4 Step 1.
