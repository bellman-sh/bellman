# Joined Rooms, Eviction, and the Room-Operation Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `BellmanStore` a joined-rooms index, make eviction an authorized
operation, and move the room operations out of the MCP tool handlers into a
layer a future HTTP route can call without re-implementing the checks.

**Architecture:** A new `src/rooms.ts` sits between `src/server.ts` and
`src/store.ts`. It owns four operations — `leaveRoom`, `issueInvite`,
`revokeInvite`, `evictMember` — each doing resolve, authorize, mutate, append
the event and write the audit row as one unit, returning a discriminated
`RoomResult` rather than an MCP `ToolResult`. The tools become adapters. The
joined index mirrors the existing creator index (`us:`) as `um:` on
`RegistryDO`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, the MCP
TypeScript SDK, Cloudflare Workers + Durable Objects. Two test programs: the
root `npm test` and `npm run test:worker` (real workerd).

**Spec:** `docs/superpowers/specs/2026-09-29-joined-rooms-eviction-and-the-room-operation-seam-design.md`

## Global Constraints

- **`npm run verify` before every commit.** It is `typecheck && typecheck:worker && build && test && test:worker`. A task is not done until it passes.
- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly.
- **Reads return detached copies.** `MemoryStore` uses `detach()` (`structuredClone`); never hand back a live reference.
- **`src/roles.ts` must never contain the string `Identity`.** `tests/tools/verbs.test.ts:641` greps the file. Do not import, annotate or mention it there.
- **`waitForEvents` must not `await` between reading events and registering a waiter.** Nothing in this plan touches it; do not introduce an await there while editing neighbours.
- **A room holds many members, not two.** In comments, docs and commit messages say *members*, *the room*, or *peers* — never "the other session" or "both sides".
- **Workers-only files are excluded from the Node build:** `src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`. `src/rooms.ts` is a Node-build file and must not import from any of them.
- **Imports carry the `.js` extension** even for `.ts` sources (`./rooms.js`).
- **`main` moves only through merges.** Work stays on `mcfearsome/an-http-api-for-the-control-panel-rooms-members`; never commit to `main`.
- **Every new assertion is run against a deliberately broken implementation before it counts as verification.** An assertion that has never been seen to fail is not evidence. Each task's "verify it fails" step is that check, and it is not optional.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has
a test in the task named beside it.

1. **A freeze landing mid-eviction.** `appendEvent` returns `null` when the session froze between the guard and the append; the member is already out, and the operation must complete rather than throw or unwind. — Task 5.
2. **A creator evicting their own second handle.** `Member.memberId` is per connection, so a creator joined from two machines has two handles. `target.userId === actor.userId` refuses it, which means a creator cannot evict themselves under any handle. — Task 5.
3. **A creator who has left the room still evicting.** Creator authority is on `session.createdBy`, a user id, not on holding an active seat. — Task 5.
4. **A member with two handles, one evicted.** The room stays in their `sessionsJoinedBy` listing, and their other handle keeps working. — Task 5.
5. **A closed room still listed by `sessionsJoinedBy`.** The store returns ids regardless of status; filtering is the caller's job (D1). A caller that assumed otherwise would silently drop closed rooms. — Task 1.

---

### Task 1: `sessionsJoinedBy` on both stores

The interface method, the contract cases, both implementations, and the
architecture-doc row. One task because adding the method to `BellmanStore`
breaks `typecheck:worker` until `DurableObjectStore` implements it — they
cannot be separate commits.

**Files:**
- Modify: `src/store.ts` — the interface (after `sessionsCreatedBy`, ~line 105) and `MemoryStore`
- Modify: `src/store-do.ts` — `RegistryDO` (~line 526) and `DurableObjectStore.addMember` (~line 642)
- Modify: `docs/ARCHITECTURE.md` — the cross-object table in section 9
- Test: `tests/helpers/store-contract.ts` — after the `sessionsCreatedBy` cases (~line 360)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BellmanStore.sessionsJoinedBy(userId: string, limit: number): Promise<string[]>`. No later task in this plan calls it; the HTTP routes will.

- [ ] **Step 1: Write the failing contract cases**

In `tests/helpers/store-contract.ts`, directly after the
`it("honours the limit on that listing", ...)` case, add:

```ts
    /**
     * The panel's main screen splits rooms a person created from rooms they
     * joined, and only the first had an index. `um:` is the second.
     *
     * The store returns ids for every room the user has ever held a handle in
     * — created, joined, left and closed alike. Filtering is the caller's, so
     * that one index can serve a panel screen and a freeze sweep that disagree
     * about what counts as current (D1, D4).
     */
    it("lists the rooms a person joined, and nobody else's", async () => {
      await store.createSession(session({ id: "qs_hers", createdBy: "u_peer", members: [] }));
      await store.createSession(session({ id: "qs_his", createdBy: "u_peer", members: [] }));
      await store.addMember("qs_hers", member({ memberId: "m_1", userId: "u_jesse" }));
      await store.addMember("qs_his", member({ memberId: "m_2", userId: "u_other" }));

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_hers"]);
      expect(await store.sessionsJoinedBy("u_other", 10)).toEqual(["qs_his"]);
      expect(await store.sessionsJoinedBy("u_nobody", 10)).toEqual([]);
    });

    it("lists a room once for a person who joined it from two machines", async () => {
      await store.createSession(session({ id: "qs_twice", members: [] }));
      await store.addMember("qs_twice", member({ memberId: "m_laptop", userId: "u_jesse" }));
      await store.addMember("qs_twice", member({ memberId: "m_desktop", userId: "u_jesse" }));

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_twice"]);
    });

    it("lists the creator's own room, because the creator holds a handle too", async () => {
      // session() seats member() — m_creator / u_jesse — at members[0], but
      // createSession does not call addMember, so the creator is indexed when
      // their handle is added the way bellman_start adds it.
      await store.createSession(session({ id: "qs_mine", createdBy: "u_jesse", members: [] }));
      await store.addMember("qs_mine", member({ userId: "u_jesse" }));

      expect(await store.sessionsCreatedBy("u_jesse", 10)).toEqual(["qs_mine"]);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_mine"]);
    });

    it("keeps listing a room after the member left it", async () => {
      await store.createSession(session({ id: "qs_past", members: [] }));
      await store.addMember("qs_past", member({ memberId: "m_gone", userId: "u_jesse" }));
      await store.updateMember("qs_past", "m_gone", { leftAt: Date.now() });

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_past"]);
    });

    /** REVIEW FOCUS 5 — status is the caller's filter, not the store's. */
    it("keeps listing a room after it closed", async () => {
      await store.createSession(session({ id: "qs_over", members: [] }));
      await store.addMember("qs_over", member({ memberId: "m_was", userId: "u_jesse" }));
      await store.closeSession("qs_over");

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_over"]);
    });

    it("honours the limit on the joined listing", async () => {
      for (const id of ["qs_j1", "qs_j2", "qs_j3"]) {
        await store.createSession(session({ id, members: [] }));
        await store.addMember(id, member({ memberId: `m_${id}`, userId: "u_jesse" }));
      }

      expect(await store.sessionsJoinedBy("u_jesse", 2)).toHaveLength(2);
    });

    it("indexes nothing when addMember refuses a frozen session", async () => {
      await store.createSession(session({ id: "qs_cold", members: [] }));
      await store.freezeSession("qs_cold", Date.now());

      expect(await store.addMember("qs_cold", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual([]);
    });

    it("indexes nothing when addMember refuses an unknown session", async () => {
      expect(await store.addMember("qs_ghost", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual([]);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- tests/store.test.ts
```

Expected: FAIL. The first error is a TypeScript one —
`Property 'sessionsJoinedBy' does not exist on type 'BellmanStore'`. That is
the correct first failure; do not add the method to make it go away until
Step 3.

- [ ] **Step 3: Add the method to the interface**

In `src/store.ts`, directly after the `sessionsCreatedBy` line in the
`BellmanStore` interface:

```ts
  /**
   * Rooms in which this user has ever held a member handle — created, joined,
   * left and closed alike.
   *
   * Ids only, like `sessionsCreatedBy`, and no status parameter. Its two
   * callers do not agree on what counts as current: the control panel hides
   * closed rooms, a freeze sweep wants exactly the live ones. Encoding either
   * answer here would make one of them filter twice.
   */
  sessionsJoinedBy(userId: string, limit: number): Promise<string[]>;
```

- [ ] **Step 4: Implement it on `MemoryStore`**

Add the index beside `byCreator` in the field block:

```ts
  private byMember = new Map<string, Set<string>>();
```

Write to it in `addMember`, after the guards and only on the success path:

```ts
  async addMember(sessionId: string, member: Member): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    s.members.push(detach(member));
    const joined = this.byMember.get(member.userId) ?? new Set<string>();
    joined.add(sessionId);
    this.byMember.set(member.userId, joined);
    return true;
  }
```

And read it beside `sessionsCreatedBy`:

```ts
  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byMember.get(userId) ?? [])].slice(0, limit);
  }
```

- [ ] **Step 5: Run the root suite to verify it passes**

```bash
npm test -- tests/store.test.ts
```

Expected: PASS, all eight new cases green.

- [ ] **Step 6: Break it on purpose, and watch the right cases go red**

Temporarily move the `byMember` write in `addMember` above the
`if (s.frozenAt !== null) return false;` guard, then run the suite again.
Expected: `indexes nothing when addMember refuses a frozen session` FAILS and
the others stay green. Put the line back. This is the positive control — an
assertion never seen to fail is not evidence.

- [ ] **Step 7: Implement it on `RegistryDO`**

In `src/store-do.ts`, directly after `sessionsCreatedBy` on `RegistryDO`:

```ts
  /**
   * `um:<userId>:<sessionId>` — which rooms a person holds a handle in.
   *
   * The same shape as `us:` above, and the same injectivity argument: two
   * variable segments, and neither can contain the separator. A user id is
   * `u_[A-Za-z0-9_-]+` and a session id is `qs_<uuid>`.
   *
   * Keyed by user rather than by member, so a person who joined the same room
   * from two machines is one entry — the put is idempotent, and the panel wants
   * the room once.
   *
   * **Members who joined before this deploy are not in here.** A backfill is
   * possible in principle — `us:` enumerates creators and each session lists
   * its members — and is not worth walking the registry for a listing that
   * fills itself in as sessions reach their TTL. Until then a joined room is
   * missing from one screen, which is not a room lost.
   */
  async indexMembership(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`um:${userId}:${sessionId}`, Date.now());
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    const prefix = `um:${userId}:`;
    const map = await this.ctx.storage.list<number>({ prefix, limit });
    return [...map.keys()].map((k) => k.slice(prefix.length));
  }
```

- [ ] **Step 8: Wire it into `DurableObjectStore`**

Replace `DurableObjectStore.addMember`:

```ts
  async addMember(sessionId: string, member: Member): Promise<boolean> {
    const added = await this.session(sessionId).addMember(member);
    // Gated on the result: addMember refuses an unknown or frozen session, and
    // indexing regardless would put rooms into a person's joined listing that
    // they were turned away from.
    //
    // A second write into a second object with no transaction spanning it —
    // the same gap as the join code and the creator index, tracked on #62. The
    // failure is a listing, not a membership: SessionDO.members stays
    // authoritative and the index is reconstructible from it, so a lost write
    // costs a row on one screen.
    if (added) await this.registry.indexMembership(member.userId, sessionId);
    return added;
  }
```

And add the read beside `sessionsCreatedBy`:

```ts
  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsJoinedBy(userId, limit);
  }
```

- [ ] **Step 9: Run both programs**

```bash
npm run typecheck && npm run typecheck:worker && npm test && npm run test:worker
```

Expected: PASS in both. The same eight cases now run inside real workerd
against real Durable Objects.

- [ ] **Step 10: Document the index in ARCHITECTURE.md**

In section 9's table of cross-object operations, add a row after the `#62`
one:

```markdown
| [#62](../../../issues/62) | SessionDO + RegistryDO | a joined-rooms index entry (`um:`) lost after the member was added, leaving a room out of one listing |
```

- [ ] **Step 11: Verify and commit**

```bash
npm run verify
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts docs/ARCHITECTURE.md
git commit -m "feat: sessionsJoinedBy, an index of the rooms a person holds a handle in (#49)"
```

---

### Task 2: `src/rooms.ts` and the primitives that move into it

A pure move. No behaviour changes, no new tests — the existing suite is the
test, and it must pass untouched. Doing it alone makes Tasks 3 and 4 small
diffs a reviewer can read.

**Files:**
- Create: `src/rooms.ts`
- Modify: `src/server.ts` — delete the five moved declarations, import them instead

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: from `src/rooms.ts` — `RoomFailure`, `RoomResult<T>`, `succeed<T>(value): RoomResult<T>`, `refuse(code, reason): RoomResult<never>`, `FROZEN: string`, `activeMembers(s: Session): Member[]`, `findMember(s: Session, memberId: string, identity: Identity): Member | undefined`, `sessionStatus(session: { closed: boolean; frozenAt: number | null }): string`, `audit(store, session, actor, action, detail): Promise<void>`.

- [ ] **Step 1: Create `src/rooms.ts`**

```ts
/**
 * Room operations, and the seam under them.
 *
 * Each operation here does the whole thing: resolve the room, authorize the
 * caller, mutate, append the event, write the audit row. That is the point.
 * `src/server.ts` used to hold the sequence inline in every tool handler, and
 * #49 wants an HTTP API over the same rooms — a second transport re-typing the
 * sequence would be a second chance to skip the audit row or the frozen guard,
 * on exactly the paths where skipping one matters.
 *
 * So a transport's job is narrowed to translation: call an operation, map its
 * result. MCP maps it to a ToolResult, a route maps it to a status code.
 *
 * This module must stay importable by the Node build: no `cloudflare:workers`,
 * directly or transitively.
 */
import type { AuditEntry, Identity, Member, Session } from "./types.js";
import type { BellmanStore } from "./store.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Why an operation refused, in a form a transport can switch on.
 *
 * A route picks 403 from `"forbidden"` rather than pattern-matching English,
 * and a route that forgets a case fails to compile rather than returning 500.
 */
// Implementation added a sixth: "invalid", for the caller's own mistake. An
// undeclared role is not a missing room, and reporting it as not_found makes a
// route answer 404 for a room that exists.
export type RoomFailure =
  | "not_found" | "closed" | "frozen" | "forbidden" | "conflict" | "invalid";

/**
 * Not a throw, because these are ordinary outcomes — a closed room is not
 * exceptional. Not a ToolResult, because that shape is MCP's and a route has
 * no use for a `content` array.
 */
export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RoomFailure; reason: string };

export const succeed = <T>(value: T): RoomResult<T> => ({ ok: true, value });

/** `RoomResult<never>` so a refusal is assignable to any operation's result. */
export const refuse = (code: RoomFailure, reason: string): RoomResult<never> =>
  ({ ok: false, code, reason });

// ---------------------------------------------------------------------------
// Room primitives
// ---------------------------------------------------------------------------

/**
 * Refused while frozen, allowed while frozen: writes stop, reads do not.
 *
 * Freezing is what a lapsed plan does to a room, and it has to be reversible
 * without costing anyone their work — so membership, history and sync all keep
 * working, and only sending, joining and inviting are refused.
 */
export const FROZEN =
  "this session is frozen: the plan that created it has lapsed. Everyone stays a member and the " +
  "history is still readable, but nothing new can be sent or joined until the plan is restored.";

export function activeMembers(s: Session): Member[] {
  return s.members.filter((m) => m.leftAt === null);
}

export function findMember(s: Session, memberId: string, identity: Identity): Member | undefined {
  const m = s.members.find((mm) => mm.memberId === memberId);
  // A member handle can only be driven by the identity that created it.
  if (!m || m.userId !== identity.userId) return undefined;
  return m;
}

export const sessionStatus = (session: { closed: boolean; frozenAt: number | null }): string =>
  session.closed ? "closed" : session.frozenAt !== null ? "frozen" : "active";

/**
 * Enterprise audit trail. Cross-org sessions write one entry per involved org
 * so each org's admins see the crossings that touched THEIR boundary —
 * without being able to read the other org's unrelated activity.
 *
 * It lives here rather than in a transport because a transport that writes its
 * own row is a transport that will one day write it for one org and not the
 * other.
 */
export async function audit(
  store: BellmanStore,
  session: Session,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  // Added during implementation: orgs beyond the room's and the actor's.
  // Eviction passes the evicted member's, because the actor is not always the
  // person the entry is about. Defaults to [] so no earlier caller changes.
  alsoOrgs: readonly (string | null)[] = []
): Promise<void> {
  const orgs = new Set<string | null>([session.orgId, actor.orgId, ...alsoOrgs]);
  for (const orgId of orgs) {
    if (orgId === null) continue;
    const entry: AuditEntry = {
      at: Date.now(),
      orgId,
      sessionId: session.id,
      actorUserId: actor.userId,
      action,
      detail,
    };
    await store.appendAudit(entry);
  }
}
```

- [ ] **Step 2: Delete the moved declarations from `src/server.ts`**

Delete, keeping everything else in place:

- `function activeMembers` (~line 104)
- `function findMember` (~line 108)
- `async function audit` with its doc comment (~lines 197–230)
- `const FROZEN` with its doc comment (~lines 228–240)
- `const sessionStatus` (~line 260)

Leave `FrozenError` and `appendOrFrozen` where they are. Their only callers
(`bellman_confirm`, `bellman_send`) stay in this file, and the throw exists to
keep a `null` out of a tool handler's happy path — a concern an operation
returning a `RoomResult` does not have.

Also remove `AuditEntry` from the `./types.js` import list if nothing else in
the file uses it.

- [ ] **Step 3: Import them instead**

Add after the `./roles.js` import:

```ts
import { FROZEN, activeMembers, audit, findMember, sessionStatus } from "./rooms.js";
```

- [ ] **Step 4: Run the whole suite — nothing should change**

```bash
npm run typecheck && npm test
```

Expected: PASS, with the same test count as before the task. A failure here is
a transcription error in the move, not a design problem: diff the moved bodies
against `git show HEAD:src/server.ts`.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/rooms.ts src/server.ts
git commit -m "refactor: move the room primitives into src/rooms.ts (#49)"
```

---

### Task 3: `leaveRoom`, and `bellman_leave` as an adapter

The smallest operation, moved first so the pattern is settled before the large
one. Behaviour is unchanged, so the existing `bellman_leave` assertions are the
test.

**Files:**
- Modify: `src/rooms.ts` — add `leaveRoom`
- Modify: `src/server.ts:861-901` — the `bellman_leave` handler body

**Interfaces:**
- Consumes: `succeed`, `refuse`, `activeMembers`, `findMember`, `sessionStatus`, `audit`, `RoomResult` from Task 2.
- Produces: `leaveRoom(store: BellmanStore, actor: Identity, sessionId: string, memberId: string): Promise<RoomResult<{ sessionStatus: string }>>`.

- [ ] **Step 1: Write the failing test**

Create `tests/rooms.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { member, session } from "./helpers/fixtures.js";
import { MemoryStore } from "../src/store.js";
import { leaveRoom } from "../src/rooms.js";
import type { Identity } from "../src/types.js";

/**
 * The operations in src/rooms.ts, driven directly. The authority rules are the
 * reason this file exists: through the MCP harness they are visible only as a
 * refusal sentence, and here they are the subject.
 */
const jesse: Identity = {
  userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
};
const peer: Identity = {
  userId: "u_peer", orgId: "org_codenerd", plan: "free", role: "member", label: "peer@codenerd",
};

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

describe("leaveRoom", () => {
  it("marks the member gone and reports the room's status", async () => {
    await store.createSession(session({
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await leaveRoom(store, peer, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
  });

  it("refuses a handle that belongs to someone else", async () => {
    await store.createSession(session({
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  it("closes the room when the last active member leaves", async () => {
    await store.createSession(session({ members: [member()] }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
  });

  it("reports not_found for a room that does not exist", async () => {
    const r = await leaveRoom(store, jesse, "qs_ghost", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- tests/rooms.test.ts
```

Expected: FAIL with `"leaveRoom" is not exported by "src/rooms.ts"`.

- [ ] **Step 3: Implement `leaveRoom`**

Append to `src/rooms.ts`:

```ts
// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * A member departs. The room closes behind the last one out.
 *
 * Reads stay open to a member who left — history is still theirs — so this
 * refuses nothing after the fact and is idempotent on a second call.
 */
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
  if (me.leftAt !== null) return succeed({ sessionStatus: sessionStatus(session) });

  await store.updateMember(session.id, memberId, { leftAt: Date.now() });
  await store.appendEvent(session.id, {
    type: "member_left",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { label: actor.label },
    refId: null,
  });

  // Re-read: `session` predates the departure.
  const after = (await store.getSession(sessionId)) ?? session;
  if (activeMembers(after).length === 0) await store.closeSession(sessionId);
  await audit(store, session, actor, "member_left", {});

  // Closed wins over frozen: an empty room is over either way, and telling
  // someone their room is frozen when it has no members left to thaw for
  // would point them at paying to fix something payment will not fix.
  const closed = after.closed || activeMembers(after).length === 0;
  return succeed({ sessionStatus: closed ? "closed" : sessionStatus(after) });
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- tests/rooms.test.ts
```

Expected: PASS.

- [ ] **Step 5: Break it on purpose**

Change `if (!me) return refuse("forbidden", ...)` to `if (!me) return succeed({ sessionStatus: "active" })`.
Expected: `refuses a handle that belongs to someone else` FAILS. Put it back.

- [ ] **Step 6: Reduce `bellman_leave` to an adapter**

In `src/server.ts`, replace the whole handler body (the arrow function passed
as the third argument to `registerTool("bellman_leave", ...)`) with:

```ts
    async ({ session_id, member_id }): Promise<ToolResult> => {
      const r = await leaveRoom(s, identity, session_id, member_id);
      return r.ok ? ok({ left: true, session_status: r.value.sessionStatus }) : fail(r.reason);
    }
```

Add `leaveRoom` to the `./rooms.js` import.

- [ ] **Step 7: Run the tool suite — behaviour must be identical**

```bash
npm test -- tests/tools/
```

Expected: PASS with no changed assertions. Every `bellman_leave` expectation in
`tests/tools/exchange.test.ts`, `handshake.test.ts` and `invite.test.ts` is now
a regression test over the adapter.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/rooms.ts src/server.ts tests/rooms.test.ts
git commit -m "refactor: leaveRoom moves into src/rooms.ts; bellman_leave adapts (#49)"
```

---

### Task 4: `issueInvite` and `revokeInvite`, and `bellman_invite` as an adapter

The largest move. Both halves of `bellman_invite` go, sharing the seat gate
that `leaveRoom` did not need because leaving requires no verb.

**Files:**
- Modify: `src/rooms.ts` — add `gateSeat`, `issueInvite`, `revokeInvite`
- Modify: `src/server.ts:583-658` — the `bellman_invite` handler body
- Test: `tests/rooms.test.ts` — add the two describes

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: `issueInvite(store, actor, sessionId, memberId, role?): Promise<RoomResult<{ code: string; role: string; expiresAt: number; replacedPrevious: boolean }>>` and `revokeInvite(store, actor, sessionId, memberId, role?): Promise<RoomResult<{ roles: string[] }>>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rooms.test.ts`:

```ts
describe("issueInvite", () => {
  it("mints a code for the room's default seat", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.role).toBe("peer_b");
    expect(r.value.replacedPrevious).toBe(false);
    expect((await store.getSessionByJoinCode(r.value.code))?.role).toBe("peer_b");
  });

  it("refuses a role the manifest does not declare", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator", "scribe");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.reason).toContain("declares no role");
  });

  it("refuses a full room, because the code could not be used", async () => {
    await store.createSession(session({
      maxMembers: 2,
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("conflict");
  });

  it("refuses a frozen room", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    await store.freezeSession("qs_test", Date.now());

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
  });
});

describe("revokeInvite", () => {
  it("retires every live code when no role is named", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.roles).toEqual(["peer_b"]);
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
  });

  it("reports nothing retired when the only code had already expired", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: { peer_b: { code: "BELL-OLD-01", expiresAt: Date.now() - 1000 } },
    }));

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.roles).toEqual([]);
  });
});
```

Extend the import at the top of the file:

```ts
import { issueInvite, leaveRoom, revokeInvite } from "../src/rooms.js";
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test -- tests/rooms.test.ts
```

Expected: FAIL with `"issueInvite" is not exported by "src/rooms.ts"`.

- [ ] **Step 3: Implement the gate and both operations**

Add to the imports at the top of `src/rooms.ts`:

```ts
import type { Verb } from "./types.js";
import { renderJoinCode } from "./codes.js";
import { denyVerb } from "./roles.js";
import { JOIN_CODE_TTL } from "./store.js";
```

Append to `src/rooms.ts`:

```ts
/**
 * The preamble every verb-gated operation shares: the room is live, it is not
 * frozen, the handle is the caller's and still in the room, and the seat holds
 * the verb.
 *
 * `leaveRoom` does not use it. Leaving needs no verb, and it must work on a
 * closed room so a member can tidy up after one.
 */
async function gateSeat(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  verb: Verb,
): Promise<RoomResult<{ session: Session; me: Member }>> {
  const session = await store.getSession(sessionId);
  if (!session || session.closed) return refuse("not_found", "session not found or closed.");
  if (session.frozenAt !== null) return refuse("frozen", FROZEN);
  const me = findMember(session, memberId, actor);
  if (!me || me.leftAt !== null) {
    return refuse("forbidden", "member_id is not yours or has left the session.");
  }
  const denial = denyVerb(session, me, verb);
  if (denial) return refuse("forbidden", denial);
  return succeed({ session, me });
}

/** Every name the manifest declares, for the sentence a bad role gets back. */
function noSuchRole(session: Session, role: string): RoomResult<never> {
  return refuse(
    "not_found",
    `this room declares no role "${role}" (it declares: ${Object.keys(session.manifest.roles).join(", ")}).`
  );
}

/**
 * Mint a fresh code for a seat. Issuing for a role RETIRES that role's previous
 * code and leaves every other role's alone.
 */
export async function issueInvite(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  role?: string,
): Promise<RoomResult<{ code: string; role: string; expiresAt: number; replacedPrevious: boolean }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "invite");
  if (!gate.ok) return gate;
  const { session } = gate.value;

  if (role !== undefined && !Object.hasOwn(session.manifest.roles, role)) {
    return noSuchRole(session, role);
  }
  if (activeMembers(session).length >= session.maxMembers) {
    return refuse(
      "conflict",
      `session is full (${session.maxMembers} members) — a new code could not be used. Wait for someone to leave, or start a swarm session.`
    );
  }

  const issuedRole = role ?? session.manifest.defaultRole;
  const previous = Boolean(session.joinCodes[issuedRole]);
  const code = renderJoinCode(issuedRole);
  const expiresAt = Date.now() + JOIN_CODE_TTL;
  if (!(await store.setJoinCode(sessionId, issuedRole, code, expiresAt))) {
    return refuse("frozen", FROZEN);
  }
  await store.appendEvent(session.id, {
    type: "invite_issued",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { role: issuedRole, expires_at: new Date(expiresAt).toISOString() },
    refId: null,
  });
  await audit(store, session, actor, "invite_issued", {
    role: issuedRole, replaced_previous: previous,
  });

  return succeed({ code, role: issuedRole, expiresAt, replacedPrevious: previous });
}

/**
 * Close a door and leave it closed. An absent role retires EVERY code,
 * deliberately asymmetric with issuing: over-revoking is recoverable by minting
 * again, while under-revoking leaves a door open behind someone who believes
 * they shut it.
 */
export async function revokeInvite(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  role?: string,
): Promise<RoomResult<{ roles: string[] }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "revoke");
  if (!gate.ok) return gate;
  const { session } = gate.value;

  if (role !== undefined && !Object.hasOwn(session.manifest.roles, role)) {
    return noSuchRole(session, role);
  }

  // An expired code is not a live code, and nothing prunes joinCodes when a
  // code merely expires — only setJoinCode, consumeJoinCode, clearJoinCodes and
  // the session-TTL sweep touch the map. So presence alone is not enough, or a
  // bare revoke announces the closing of a door that had already shut by
  // itself: an event, an audit row, and over-reported roles.
  const retired = (role ? [role] : Object.keys(session.joinCodes)).filter((r) => {
    const rec = session.joinCodes[r];
    return rec !== undefined && Date.now() <= rec.expiresAt;
  });
  if (role) await store.consumeJoinCode(sessionId, role);
  else await store.clearJoinCodes(sessionId);

  if (retired.length > 0) {
    await store.appendEvent(session.id, {
      type: "invite_revoked",
      fromMemberId: memberId,
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { roles: retired },
      refId: null,
    });
    await audit(store, session, actor, "invite_revoked", { roles: retired });
  }

  return succeed({ roles: retired });
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
npm test -- tests/rooms.test.ts
```

Expected: PASS.

- [ ] **Step 5: Break it on purpose**

Drop the `Date.now() <= rec.expiresAt` clause from `retired`, leaving
`rec !== undefined`. Expected:
`reports nothing retired when the only code had already expired` FAILS. Put it
back.

- [ ] **Step 6: Reduce `bellman_invite` to an adapter**

Replace the whole handler body with:

```ts
    async ({ session_id, member_id, role, revoke }): Promise<ToolResult> => {
      if (revoke) {
        const r = await revokeInvite(s, identity, session_id, member_id, role);
        return r.ok ? ok({ revoked: true, roles: r.value.roles, join_code: null }) : fail(r.reason);
      }
      const r = await issueInvite(s, identity, session_id, member_id, role);
      if (!r.ok) return fail(r.reason);
      return ok({
        join_code: r.value.code,
        join_code_expires_at: new Date(r.value.expiresAt).toISOString(),
        role: r.value.role,
        replaced_previous: r.value.replacedPrevious,
        share_instructions:
          `Give this code to the joining session. It seats them as "${r.value.role}". Any code issued earlier for that role has stopped working; other roles' codes are unaffected.`,
      });
    }
```

Add `issueInvite` and `revokeInvite` to the `./rooms.js` import. Remove
`renderJoinCode` and `JOIN_CODE_TTL` from `src/server.ts`'s imports only if
nothing else there still uses them — `bellman_start` does, so expect both to
stay.

- [ ] **Step 7: Run the tool suite — behaviour must be identical**

```bash
npm test -- tests/tools/
```

Expected: PASS with no changed assertions. `tests/tools/invite.test.ts` is the
regression suite for this task.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/rooms.ts src/server.ts tests/rooms.test.ts
git commit -m "refactor: issueInvite and revokeInvite move into src/rooms.ts (#49)"
```

---

### Task 5: `member_evicted` and `evictMember`

The new behaviour. No tool yet — the operation and its authority matrix stand
on their own, and Task 6 is then a pure adapter.

**Files:**
- Modify: `src/types.ts:41-52` — the `EventType` union
- Modify: `src/rooms.ts` — add `evictMember`
- Test: `tests/rooms.test.ts` — add the `evictMember` describe

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `evictMember(store, actor, sessionId, memberId): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>>`.

**One decision the spec left open.** `member_evicted` is written with
`fromMemberId: "system"`, the existing marker for a server-originated event,
and carries the creator in `fromUserId` and `fromLabel`. Creator authority is
on the user, not on a seat (D8, D14), and a creator who has left the room still
holds it — so there is no member handle to name, and `"system"` is the honest
answer. The evicted member's identity travels in the payload.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rooms.test.ts`:

```ts
describe("evictMember", () => {
  /** A room with the creator and one peer, both active. */
  const peopled = () => session({
    maxMembers: 4,
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
  });

  it("removes the member, retires their seat's code, and says so", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBe("peer_b");
    expect(r.value.sessionStatus).toBe("active");

    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();

    const types = (await store.eventsAfter("qs_test", 0)).map((e) => e.type);
    expect(types).toEqual(["member_evicted", "invite_revoked"]);
  });

  it("attributes the eviction to the creator, from the system handle", async () => {
    await store.createSession(peopled());

    await evictMember(store, jesse, "qs_test", "m_peer");

    const [evicted] = await store.eventsAfter("qs_test", 0);
    expect(evicted.fromMemberId).toBe("system");
    expect(evicted.fromUserId).toBe("u_jesse");
    expect(evicted.payload).toMatchObject({ member_id: "m_peer", room_role: "peer_b" });
  });

  it("refuses a member who is not the creator, whatever verbs their seat holds", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, peer, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  it("refuses an org admin who did not create the room", async () => {
    // jesse is role: "admin" on org_codenerd. The room is someone else's.
    await store.createSession(session({
      createdBy: "u_peer",
      members: [member({ memberId: "m_owner", userId: "u_peer" }),
                member({ memberId: "m_mine", userId: "u_jesse", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_owner");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  /** REVIEW FOCUS 2 — memberId is per connection; the rule is on userId. */
  it("refuses a creator evicting their own second handle", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(), member({ memberId: "m_laptop", userId: "u_jesse", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_laptop");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
    expect(r.reason).toContain("leave the room");
  });

  /** REVIEW FOCUS 3 — authority is on createdBy, not on holding a live seat. */
  it("lets a creator who already left evict someone", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  /** REVIEW FOCUS 4 — one handle out, the room stays in their listing. */
  it("leaves a member's other handle, and their joined listing, intact", async () => {
    await store.createSession(session({ maxMembers: 4, members: [member()] }));
    await store.addMember("qs_test", member({ memberId: "m_a", userId: "u_peer", roomRole: "peer_b" }));
    await store.addMember("qs_test", member({ memberId: "m_b", userId: "u_peer", roomRole: "peer_b" }));

    await evictMember(store, jesse, "qs_test", "m_a");

    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_b")?.leftAt).toBeNull();
    expect(await store.sessionsJoinedBy("u_peer", 10)).toEqual(["qs_test"]);
  });

  it("succeeds and writes nothing for a member who already left", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBeNull();
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("retires nothing when the seat's code had already expired", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: { peer_b: { code: "BELL-OLD-01", expiresAt: Date.now() - 1000 } },
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBeNull();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["member_evicted"]);
  });

  it("closes the room when the evicted member was the last active one", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
  });

  it("refuses a frozen room", async () => {
    await store.createSession(peopled());
    await store.freezeSession("qs_test", Date.now());

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
  });

  /**
   * REVIEW FOCUS 1 — a freeze landing between the guard and the append.
   *
   * appendEvent returns null once frozen and the member is already out, so the
   * operation completes rather than throwing: an announced removal that did
   * not happen would be worse than a removal that was not announced.
   */
  it("completes when the room freezes after the member was removed", async () => {
    await store.createSession(peopled());
    const real = store.updateMember.bind(store);
    store.updateMember = async (sid, mid, patch) => {
      await real(sid, mid, patch);
      await store.freezeSession(sid, Date.now());
    };

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
  });

  it("reports not_found for a member_id nobody in the room holds", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, jesse, "qs_test", "m_ghost");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });
});
```

Extend the import:

```ts
import { evictMember, issueInvite, leaveRoom, revokeInvite } from "../src/rooms.js";
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test -- tests/rooms.test.ts
```

Expected: FAIL with `"evictMember" is not exported by "src/rooms.ts"`.

- [ ] **Step 3: Add the event type**

In `src/types.ts`, inside the `EventType` union, after `"member_left"`:

```ts
  | "member_evicted"
```

- [ ] **Step 4: Implement `evictMember`**

Append to `src/rooms.ts`:

```ts
/**
 * The room's creator removes a member.
 *
 * Creator-only, and outside the verb set — the same category as closing a
 * room. Authority over a room as an object, rather than authority to act
 * within it. An `evict` verb would let a manifest hand eviction to a joiner,
 * and a room whose preset does that is not one anybody asked for.
 *
 * Not an org-admin path either. `Identity.role` is platform authority over an
 * org and buys nothing inside a room; an org admin is not automatically
 * anything in a room, and a room's creator need not be an org admin. That is
 * why the check lives here and not in `src/roles.ts`.
 *
 * Removal is soft. `SessionEvent` denormalises `fromMemberId`, `fromUserId`
 * and `fromLabel` precisely so a room's history survives a departure; deleting
 * the member record would make the past unrenderable to keep the present tidy.
 */
export async function evictMember(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");
  if (session.closed) return refuse("closed", "session is closed.");
  if (session.frozenAt !== null) return refuse("frozen", FROZEN);
  if (session.createdBy !== actor.userId) {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }

  // A direct lookup, NOT findMember: that helper requires the handle to belong
  // to the caller, which is the one thing eviction has to do differently.
  const target = session.members.find((m) => m.memberId === memberId);
  if (!target) return refuse("not_found", "no member with that member_id is in this room.");
  if (target.userId === actor.userId) {
    return refuse("forbidden", "you cannot evict yourself; leave the room instead.");
  }
  if (target.leftAt !== null) {
    return succeed({ evicted: true, codeRetired: null, sessionStatus: sessionStatus(session) });
  }

  await store.updateMember(sessionId, memberId, { leftAt: Date.now() });
  // A null return means the room froze in the gap. The member is already out,
  // so this is tolerated rather than unwound: a removal nobody announced is
  // recoverable, an announcement of a removal that did not happen is not.
  await store.appendEvent(sessionId, {
    type: "member_evicted",
    // No member handle to name: creator authority is on the user, and a
    // creator who has left the room still holds it. "system" is the existing
    // marker for a server-originated event; the creator is in fromUserId.
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { member_id: memberId, label: target.label, room_role: target.roomRole },
    refId: null,
  });

  // A room holds one live code per role, so removing someone while their seat's
  // door stays open is a removal that undoes itself the moment they reconnect.
  // It retires the code for anyone else mid-join on that seat too — the same
  // direction bellman_invite already argues for: over-revoking is recoverable
  // by minting again, under-revoking is not.
  const rec = session.joinCodes[target.roomRole];
  const live = rec !== undefined && Date.now() <= rec.expiresAt;
  if (live) {
    await store.consumeJoinCode(sessionId, target.roomRole);
    await store.appendEvent(sessionId, {
      type: "invite_revoked",
      fromMemberId: "system",
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { roles: [target.roomRole] },
      refId: null,
    });
  }

  const after = (await store.getSession(sessionId)) ?? session;
  if (activeMembers(after).length === 0) await store.closeSession(sessionId);
  await audit(store, session, actor, "member_evicted", {
    member_id: memberId, user_id: target.userId,
    room_role: target.roomRole, code_retired: live,
  });

  const closed = after.closed || activeMembers(after).length === 0;
  return succeed({
    evicted: true,
    codeRetired: live ? target.roomRole : null,
    sessionStatus: closed ? "closed" : sessionStatus(after),
  });
}
```

- [ ] **Step 5: Run them to verify they pass**

```bash
npm test -- tests/rooms.test.ts
```

Expected: PASS.

- [ ] **Step 6: Break it on purpose, three ways**

Run the suite after each, then undo it.

1. Change `target.userId === actor.userId` to `target.memberId === memberId`.
   Expected: `refuses a creator evicting their own second handle` FAILS.
2. Delete the `Date.now() <= rec.expiresAt` clause from `live`.
   Expected: `retires nothing when the seat's code had already expired` FAILS.
3. Change the creator check to
   `session.createdBy !== actor.userId && actor.role !== "admin"`.
   Expected: `refuses an org admin who did not create the room` FAILS.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/types.ts src/rooms.ts tests/rooms.test.ts
git commit -m "feat: evictMember, creator authority over a room's roster (#49)"
```

---

### Task 6: the `bellman_evict` tool

An adapter over Task 5, plus the two places that enumerate the tool set.

**Files:**
- Modify: `src/server.ts` — register the tool after `bellman_leave`
- Modify: `tests/tools/surface.test.ts:14-44` — `EXPECTED_TOOLS` and the length assertion
- Modify: `tests/bridge.test.ts:205-208` — the bridge proxies every remote tool, so its list grows too
- Modify: `README.md:15-28` — the tool table
- Test: `tests/tools/evict.test.ts` (create)

**Interfaces:**
- Consumes: `evictMember` from Task 5.
- Produces: the `bellman_evict` MCP tool. Output shape: `{ evicted: boolean, code_retired: string | null, session_status: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/evict.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness, envelopes } from "../helpers/harness.js";

/**
 * A creator removing a member. Reads stay open to the person removed — the
 * history was theirs too — so what changes is writing, and the room's roster.
 */
let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

describe("bellman_evict", () => {
  it("removes a member, who then sees why in their own sync", async () => {
    const s = await pairUp(h);

    const out = await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.evicted).toBe(true);

    const synced = await s.joiner.call("bellman_sync", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
      since_cursor: s.joinerCursor,
      wait_seconds: 0,
    });
    const types = envelopes(synced.data.events).map((e) => (e.data as { type: string }).type);
    expect(types).toContain("member_evicted");
  });

  it("refuses the evicted member's next send", async () => {
    const s = await pairUp(h);
    await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });

    const sent = await s.joiner.call("bellman_send", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
      type: "message",
      payload: { text: "still here?" },
    });
    expect(sent.isError).toBe(true);
  });

  it("refuses a member who did not create the room", async () => {
    const s = await pairUp(h);

    const out = await s.joiner.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.creatorMemberId,
    });

    expect(out.isError).toBe(true);
    expect(out.text).toContain("created this room");
  });

  it("reports the retired seat code", async () => {
    const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
    const issued = await s.creator.call("bellman_invite", {
      session_id: s.sessionId,
      member_id: s.creatorMemberId,
    });
    expect(issued.isError, issued.text).toBe(false);

    const out = await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });

    expect(out.isError, out.text).toBe(false);
    expect(out.data.code_retired).toBe(String(issued.data.role));
    const stale = await h.connect(DEV_KEY.outsider);
    expect((await stale.call("bellman_connect", { join_code: issued.data.join_code })).isError)
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- tests/tools/evict.test.ts
```

Expected: FAIL — the tool is not registered, so every call errors with an
unknown-tool message.

- [ ] **Step 3: Register the tool**

In `src/server.ts`, after the `bellman_leave` registration:

```ts
  // -------------------------------------------------------------- bellman_evict
  server.registerTool(
    "bellman_evict",
    {
      title: "Remove a member from a room you created",
      description: `Remove someone from a room you created. Only the room's creator can do this — it is not a manifest verb, so no seat grants it and no role can be given it.

Evicting also retires the join code for that member's seat, if one is live. A code is the door; leaving it open behind someone you removed means they can walk back in. Other roles' codes are unaffected, and so is anyone else already in the room.

Reads stay open to the person removed: the history was theirs too, and taking it away is not what removal is for. What stops is writing — their next bellman_send is refused.

Args: session_id, member_id (THEIRS, not yours)
Returns: { evicted, code_retired, session_status }
Everyone in the room sees a member_evicted event, so removal is never silent, and the person removed sees it too. Removing the last active member closes the room.
Errors: only the creator may call it; you cannot evict yourself (leave the room instead); a frozen room refuses, as it refuses joining, sending and inviting — though not leaving, which must never trap anyone inside. Removing someone who already left does not repeat the removal, but it does shut their seat's door if it is still open.`,
      inputSchema: {
        session_id: z.string().min(4),
        member_id: z.string().min(4),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
      },
    },
    async ({ session_id, member_id }): Promise<ToolResult> => {
      const r = await evictMember(s, identity, session_id, member_id);
      return r.ok
        ? ok({
            evicted: r.value.evicted,
            code_retired: r.value.codeRetired,
            session_status: r.value.sessionStatus,
          })
        : fail(r.reason);
    }
  );
```

Add `evictMember` to the `./rooms.js` import.

- [ ] **Step 4: Update the tool-surface invariant**

In `tests/tools/surface.test.ts`, add `"bellman_evict"` to `EXPECTED_TOOLS` and
change the length assertion:

```ts
    expect(EXPECTED_TOOLS).toHaveLength(9);
```

- [ ] **Step 5: Update the bridge's proxied-tool assertion**

The bridge proxies whatever the remote registers, so a ninth tool appears
there too. In `tests/bridge.test.ts`, in
`it("declares itself a channel, never permission relay, and proxies the Bellman tools", ...)`,
add `"bellman_evict"` to the expected array, keeping it sorted:

```ts
    expect(names).toEqual([
      "bellman_audit", "bellman_confirm", "bellman_connect", "bellman_evict",
      "bellman_invite", "bellman_leave", "bellman_send", "bellman_start",
      "bellman_sync", "bellman_whoami",
    ]);
```

- [ ] **Step 6: Update the README tool table**

In `README.md`, after the `bellman_leave` row:

```markdown
| `bellman_evict` | Creator-only: remove a member and retire their seat's code. Not a verb — no role grants it. |
```

- [ ] **Step 7: Run the tool suite to verify it passes**

```bash
npm test -- tests/tools/
```

Expected: PASS, including the surface invariant at nine tools.

- [ ] **Step 8: Break it on purpose**

Remove `"bellman_evict"` from `EXPECTED_TOOLS` but leave the length at 9.
Expected: `registers exactly the 9 Bellman tools` FAILS on the list comparison
before the length one. Put it back.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add src/server.ts tests/tools/evict.test.ts tests/tools/surface.test.ts tests/bridge.test.ts README.md
git commit -m "feat: bellman_evict, a creator removing a member (#49)"
```

---

### Task 7: the bridge stops watching a room it was evicted from

`member_evicted` is a new event, and the Claude Code bridge is a consumer of
events. Its watcher stops on a closed room and on a `bellman_leave` call it
proxied — neither happens to an evicted member, and `bellman_sync` keeps
answering because reads stay open. Without this the bridge long-polls a room
its member is no longer in, for the life of the process.

**Files:**
- Modify: `src/bridge.ts:630-636` — the watcher, after the delivery loop
- Test: `tests/bridge.test.ts` — add one case

**Interfaces:**
- Consumes: the `member_evicted` event type from Task 5 and the tool from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

In `tests/bridge.test.ts`, inside `describe("channel delivery", ...)`, directly
after `it("stops watching a membership once you leave", ...)`:

```ts
  it("stops watching a room this member was evicted from", async () => {
    const a = await open(DEV_KEY.jesse);
    const b = await open(DEV_KEY.peer);
    const { sessionId, joinerMember } = await pair(a, b);
    expect(b.bridge.watching()).toHaveLength(1);

    await a.call("bellman_evict", { session_id: sessionId, member_id: joinerMember });

    // The event reaches the human first. Nothing else would: bellman_sync
    // keeps answering a member who is out, because reads stay open to them,
    // and the room is not closed.
    await until(() => channelEvents(b).some((e) => e.meta.type === "member_evicted"));
    await until(() => b.bridge.watching().length === 0);
  });

  it("keeps watching when the member evicted is somebody else", async () => {
    const a = await open(DEV_KEY.jesse);
    const b = await open(DEV_KEY.peer);
    const { sessionId, joinerMember } = await pair(a, b);
    expect(a.bridge.watching()).toHaveLength(1);

    await a.call("bellman_evict", { session_id: sessionId, member_id: joinerMember });
    await until(() => channelEvents(a).some((e) => e.meta.type === "member_evicted"));

    // The creator is still in the room, so the event is news, not an exit.
    expect(a.bridge.watching()).toHaveLength(1);
  });
```

Both members see the event because `member_evicted` carries
`fromMemberId: "system"` — neither party filters it as their own. The room does
not close, because the creator is still active.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- tests/bridge.test.ts
```

Expected: the first case FAILS — `b.bridge.watching()` stays at 1 and `until`
times out. The second case passes already; it is the control that keeps the
fix from over-reaching.

- [ ] **Step 3: Disarm on the event**

In `src/bridge.ts`, between the `w.delivered = Math.max(...)` line and the
`if (out.session_status === "closed")` block:

```ts
      /**
       * Evicted. The event has already been delivered above, so the human
       * knows why this stopped.
       *
       * Nothing else would stop it: bellman_sync keeps answering a member who
       * is out, because reads stay open to them, and the room is not closed.
       * A bellman_leave the agent called would have disarmed this watcher on
       * the way past; an eviction is a thing that happened TO this member, so
       * the event is the only signal there is.
       */
      const evicted = (out.events ?? []).some(
        (e) =>
          e.data.type === "member_evicted" &&
          (e.data.payload as { member_id?: string } | null)?.member_id === w.memberId
      );
      if (evicted) {
        disarm(w.memberId);
        return;
      }
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- tests/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 5: Break it on purpose**

Drop the `?.member_id === w.memberId` comparison, leaving the type check alone.
Expected: `keeps watching when the member evicted is somebody else` FAILS —
the creator's watcher disarms on an eviction that was not theirs. Put it back.
That case is the whole reason the comparison is there.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/bridge.ts tests/bridge.test.ts
git commit -m "fix: the bridge stops watching a room its member was evicted from (#49)"
```

---

## Done when

- `npm run verify` passes: both typecheck programs, the build, `npm test`, and `npm run test:worker`.
- `sessionsJoinedBy` is proven identically on `MemoryStore` and `DurableObjectStore` by the contract suite.
- `src/server.ts` contains no `activeMembers`, `findMember`, `sessionStatus`, `FROZEN` or `audit` declaration — only imports of them.
- `src/roles.ts` is byte-identical to its state at the start of this plan.
- `tests/tools/invite.test.ts` and the `bellman_leave` assertions elsewhere pass with no edits, proving the refactor moved code without moving behaviour.
