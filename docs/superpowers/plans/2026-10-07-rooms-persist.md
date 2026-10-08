# Rooms Persist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No room dies on a clock. A room ends when its last member leaves or after 90 days in which nobody in it was seen; a swarm room holds up to 100 members on every paid plan; the max plan is marked coming soon.

**Architecture:** The session TTL (`expiresAt`, `sessionTtlMs`) and the plan cap (`maxMembers`) leave the types. Abandonment takes the TTL's seam: one pure predicate pair (`abandonedAt`, `isAbandoned`) that both stores, the Durable Object's derived alarm and every "does this room read closed" check share, with the alarm stamping `lastSeenAt` instead of closing when a socket vouches for a member. Capacity becomes a pure function of the manifest's mode (`capacityOf`), so nothing stored can disagree with it.

**Tech Stack:** TypeScript, vitest (two programs: `tests/` on Node, `worker-tests/` inside workerd via `@cloudflare/vitest-pool-workers`), Cloudflare Durable Objects, jj (colocated git), `gh`.

**Spec:** `docs/superpowers/specs/2026-10-07-rooms-persist-design.md`

## Global Constraints

- `ABANDONED_AFTER_MS = 90 * 24 * 60 * 60 * 1000` (spec D2). `ROOM_MEMBER_CEILING = 100` (spec D3). `capacityOf(manifest)` is `manifest.mode === "pair" ? 2 : ROOM_MEMBER_CEILING`.
- `abandonedAt(s)` is null when `s.closed`, `s.frozenAt !== null`, or no active member; otherwise `max(lastSeen(m) for active m) + ABANDONED_AFTER_MS`. `isAbandoned(s, now, connected)` is `abandonedAt(s) !== null && now > abandonedAt(s)` and no active member of `s` is in `connected`. Strict `>`, as `pastTtl` was (D2).
- The `session_expired` event stays; its payload becomes `{ reason: "abandoned", last_seen_at: <ISO of abandonedAt - ABANDONED_AFTER_MS> }` (D2).
- The derived alarm name is `"abandoned"`; it is never stored under `due:` (D2). The handler is `#closeIfAbandoned`, `#private`, replacing `#expireIfDue`.
- A frozen room is never swept; a thaw stamps `lastSeenAt = now` on every active member, on the TRANSITION only, beside `clearSilence` (D2).
- An empty open room stays `closeSessionIfEmpty`'s (D2). A stored row carrying `expiresAt` or `maxMembers` is stripped on read by `hydrateStoredSession` (D1, D3).
- `max` stays in `ENTITLEMENTS` and differs from `pro` only by `monthlyCreates` (2,000 vs 500); the README marks it *coming soon*; `STRIPE_PAYMENT_LINKS` carries no `max` entry, an operator rule rather than code (D4).
- Every refusal of a seat keeps the word "full" (tests match `/full/i`); a swarm room's names the ceiling: *this room holds 100 members, Bellman's ceiling for one room* (D3).
- Every new assertion is run against a broken implementation before it counts (spec, *Testing*). "Expected: FAIL" lines below are that control; a test that passes before its step's code exists is a finding about the test.
- Writing: a room holds many members, never "two sessions"/"the other session"; no phrase from `~/.claude/projects/-Users-mcfearsome-src-github-com-bellman-sh-bellman/memory/banned-phrases.md`.
- Repo: `main` moves only through merges. Work on the change on top of the spec commit with jj; each task ends in `jj commit -m "<message>"`. Commits must be signed: before pushing, `git cat-file commit <id> | grep -c 'BEGIN SSH SIGNATURE'` prints `1` for each.
- Test commands: `npx vitest run <files>` for the Node program; `npm run test:worker` for workerd (whole program; it installs its own tree, about two minutes); `npm run verify` before the PR.

**One placement differs from the spec's letter, on purpose.** The spec puts `ABANDONED_AFTER_MS`, `abandonedAt` and `isAbandoned` in `src/presence.ts`. They are DEFINED in `src/store.ts` beside `lastSeen` and `connectedAmong`, and RE-EXPORTED from `src/presence.ts`, for the reason `lastSeen`'s docblock already gives: both stores call them inside method bodies, `presence.ts` imports `store.ts`, and the other direction is the import cycle `asked`'s docblock warns about. Every importer outside the stores (tests, tools) reads them from `presence.ts`, which is what the spec asks of them. Do not move them back.

## Review Focus

1. **A socket held open for a quarter of a year.** The alarm must stamp and re-arm 90 days out, not close, and not fire back to back. *(Task 3: wiring case "stamps the members a socket vouches for and re-arms 90 days out"; worker case in `alarms.test.ts`.)*
2. **A thaw after a freeze longer than the window.** The thaw's `reArm()` would otherwise point at a time already past and the next firing closes the room the person just paid to get back. *(Task 2: contract case "a thaw stamps every active member"; Task 3: wiring case "keeps a room thawed past the window open on the next firing".)*
3. **A read while a socket vouches, past the window.** `membersOf` and `fetch` must read the room as open, and the same row with no socket as closed. *(Task 3: wiring case "reads an aged room as open while a socket vouches".)*
4. **A full swarm room's refusal.** A creator at the ceiling must be told it is the ceiling, not a plan limit, from `bellman_invite`. *(Task 5: `tests/rooms.test.ts` case "names the ceiling when a swarm room is full".)*
5. **A legacy row stamped `maxMembers: 8` with eight members.** The ninth seat must not be refused for a cap that no longer exists, and the row must come back without the field. *(Task 5: `tests/stored-session.test.ts` strips it; `tests/store-do-wiring.test.ts` case "seats past a legacy cap".)*

---

## Setup

The spec commit is `@-` (`310cd473`, "spec: rooms persist…"); `@` is an empty change on top of it. Commit this plan into it, then work on the next change:

```bash
cd ~/src/github.com/bellman-sh/bellman
jj commit -m "plan: rooms persist (#18)"
```

Each task below ends with `jj commit -m "…"`, which commits the working copy and opens a new empty change. The bookmark is created and pushed once, in Task 7.

---

### Task 1: The abandonment predicates

**Files:**
- Modify: `src/store.ts` (after `connectedAmong`, before `asked`)
- Modify: `src/presence.ts` (imports/re-exports and the module docblock)
- Test: `tests/presence.test.ts`

**Interfaces:**
- Consumes: `isActiveMember`, `lastSeen`, `NO_SOCKETS` from `src/store.ts` (exist).
- Produces, from `src/store.ts` and re-exported by `src/presence.ts`:
  - `export const ABANDONED_AFTER_MS: number`
  - `export type RoomRoster = Pick<Session, "closed" | "frozenAt" | "members">`
  - `export function abandonedAt(s: RoomRoster): number | null`
  - `export function isAbandoned(s: RoomRoster, now: number, connected?: ReadonlySet<string>): boolean`
  - `export function stampSeen(members: Member[], now: number, only?: ReadonlySet<string>): Member[]` — every active member's `lastSeenAt` set to `now`, or only those named in `only`. (`store.ts` only; both stores and `#closeIfAbandoned` use it.)

- [ ] **Step 1: Write the failing tests**

Append to `tests/presence.test.ts`. Add `ABANDONED_AFTER_MS, abandonedAt, isAbandoned` to the existing import from `../src/presence.js`, and `stampSeen` to the import from `../src/store.js`.

```ts
describe("abandonment is derived from the members' presence (#18)", () => {
  const WINDOW_AGO = NOW - ABANDONED_AFTER_MS;

  it("is 90 days", () => {
    expect(ABANDONED_AFTER_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("falls 90 days after the last time any active member was seen", () => {
    const s = session({ members: [
      member({ memberId: "m_a", lastSeenAt: NOW - 5_000 }),
      member({ memberId: "m_b", userId: "u_b", roomRole: "peer_b", lastSeenAt: NOW - 1_000 }),
    ] });
    expect(abandonedAt(s)).toBe(NOW - 1_000 + ABANDONED_AFTER_MS);
  });

  it("does not count a departed member, however recently it spoke", () => {
    const s = session({ members: [
      member({ memberId: "m_quiet", lastSeenAt: 1 }),
      member({ memberId: "m_gone", userId: "u_gone", roomRole: "peer_b", lastSeenAt: NOW, leftAt: NOW - 1 }),
    ] });
    expect(abandonedAt(s)).toBe(1 + ABANDONED_AFTER_MS);
  });

  it("lifts a member stored before lastSeenAt existed to its joinedAt", () => {
    const legacy = member({ joinedAt: NOW - 1_000 });
    delete (legacy as { lastSeenAt?: number }).lastSeenAt;
    expect(abandonedAt(session({ members: [legacy] }))).toBe(NOW - 1_000 + ABANDONED_AFTER_MS);
  });

  it("is null for a closed, a frozen, and an empty room", () => {
    const quiet = member({ lastSeenAt: 1 });
    expect(abandonedAt(session({ members: [quiet], closed: true }))).toBeNull();
    expect(abandonedAt(session({ members: [quiet], frozenAt: NOW }))).toBeNull();
    // Empty is closeSessionIfEmpty's, not the sweep's.
    expect(abandonedAt(session({ members: [member({ leftAt: 5 })] }))).toBeNull();
    expect(abandonedAt(session({ members: [] }))).toBeNull();
  });

  it("is not abandoned at the boundary and is one millisecond past it", () => {
    const s = session({ members: [member({ lastSeenAt: WINDOW_AGO })] });
    expect(isAbandoned(s, NOW)).toBe(false);
    expect(isAbandoned(s, NOW + 1)).toBe(true);
  });

  it("is never abandoned while a socket vouches for an active member", () => {
    const s = session({ members: [member({ memberId: "m_socket", lastSeenAt: 1 })] });
    expect(isAbandoned(s, NOW), "control: with no socket it is").toBe(true);
    expect(isAbandoned(s, NOW, new Set(["m_socket"]))).toBe(false);
  });

  it("is abandoned when the only socket belongs to a member who left", () => {
    const s = session({ members: [
      member({ memberId: "m_quiet", lastSeenAt: 1 }),
      member({ memberId: "m_left", userId: "u_left", roomRole: "peer_b", lastSeenAt: NOW, leftAt: NOW - 1 }),
    ] });
    expect(isAbandoned(s, NOW, new Set(["m_left"]))).toBe(true);
  });

  it("is never abandoned when nothing says when it would be", () => {
    expect(isAbandoned(session({ members: [member({ lastSeenAt: 1 })], frozenAt: NOW }), NOW)).toBe(false);
  });
});

describe("stampSeen", () => {
  it("moves every active member's lastSeenAt and leaves a departed one alone", () => {
    const stamped = stampSeen([
      member({ memberId: "m_a", lastSeenAt: 1 }),
      member({ memberId: "m_gone", lastSeenAt: 1, leftAt: 5 }),
    ], NOW);
    expect(stamped.map((m) => [m.memberId, m.lastSeenAt])).toEqual([["m_a", NOW], ["m_gone", 1]]);
  });

  it("stamps only the members named, when asked to", () => {
    const stamped = stampSeen([
      member({ memberId: "m_a", lastSeenAt: 1 }),
      member({ memberId: "m_b", userId: "u_b", roomRole: "peer_b", lastSeenAt: 2 }),
    ], NOW, new Set(["m_b"]));
    expect(stamped.map((m) => m.lastSeenAt)).toEqual([1, NOW]);
  });

  it("returns new objects and does not write into the roster it was handed", () => {
    const roster = [member({ memberId: "m_a", lastSeenAt: 1 })];
    const stamped = stampSeen(roster, NOW);
    expect(roster[0].lastSeenAt).toBe(1);
    expect(stamped[0]).not.toBe(roster[0]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/presence.test.ts`
Expected: FAIL. The file does not compile: `"../src/presence.js"` has no exported member `ABANDONED_AFTER_MS` (and the others).

- [ ] **Step 3: Implement**

In `src/store.ts`, after `connectedAmong` and before `asked`:

```ts
/**
 * How long a room may go with nobody in it before it is abandoned (#18).
 *
 * Rooms persist: there is no clock on a room, on any plan. What ends one is its
 * last member leaving (`closeSessionIfEmpty`) or this: 90 days in which no
 * active member was heard from or held a socket. An abandoned room costs
 * storage and nothing else, and the member a hub room would most regret losing
 * is its quietest one, so the window is long. It is not forever because a room
 * whose every member died with its laptop should not sit in a Durable Object
 * for good, and the sweep is also what retires its codes from the registry.
 *
 * Here beside `lastSeen`, and re-exported from presence.ts, for the reason
 * `lastSeen` gives: both stores read these inside their own methods, and
 * presence.ts imports this module.
 */
export const ABANDONED_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** What the abandonment rule reads: a session, or a stored one. */
export type RoomRoster = Pick<Session, "closed" | "frozenAt" | "members">;

/**
 * When this room becomes abandoned, or null if the question does not apply: a
 * closed room is over, a frozen one is waiting on a payment and `touchMember`
 * cannot stamp it, and an empty one is `closeSessionIfEmpty`'s. Departed members
 * do not count: a goodbye yesterday does not keep open a room that nobody else
 * has been in for a season.
 */
export function abandonedAt(s: RoomRoster): number | null {
  if (s.closed || s.frozenAt !== null) return null;
  const active = s.members.filter(isActiveMember);
  if (active.length === 0) return null;
  return Math.max(...active.map(lastSeen)) + ABANDONED_AFTER_MS;
}

/**
 * Whether this room is abandoned now. `connected` is the members a live socket
 * vouches for (`connectedAmong`): a member on a socket is there whatever its
 * `lastSeenAt` says, so a room with one is never abandoned. Strict `>`, so a
 * read landing exactly on `abandonedAt` still sees the room open.
 *
 * Shared by both stores' sweeps and lazy closes, SessionDO's derived alarm and
 * every reader that answers "closed" without writing (`readsClosed`), so the
 * four cannot drift the first time one of them is edited.
 */
export function isAbandoned(
  s: RoomRoster,
  now: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): boolean {
  const due = abandonedAt(s);
  if (due === null || now <= due) return false;
  return !s.members.some((m) => isActiveMember(m) && connected.has(m.memberId));
}

/**
 * The roster with `lastSeenAt` moved to `now` on every active member, or only
 * on those named. New objects, so a caller's copy is not written into.
 *
 * Two callers. A thaw stamps every active member, so a room coming back from a
 * freeze gets a full window rather than closing on the alarm the thaw re-arms.
 * The abandonment alarm stamps the members a socket vouches for, which is the
 * stamp `webSocketClose` makes on a drop (#152), made on a schedule: without it
 * a room held open on one socket for a season would fire its alarm back to back.
 */
export function stampSeen(members: Member[], now: number, only?: ReadonlySet<string>): Member[] {
  return members.map((m) =>
    isActiveMember(m) && (only === undefined || only.has(m.memberId)) ? { ...m, lastSeenAt: now } : m,
  );
}
```

In `src/presence.ts`, replace the import/re-export pair:

```ts
import {
  ABANDONED_AFTER_MS, NO_SOCKETS, abandonedAt, connectedAmong, isAbandoned, isActiveMember, lastSeen,
} from "./store.js";
export { ABANDONED_AFTER_MS, NO_SOCKETS, abandonedAt, connectedAmong, isAbandoned, lastSeen };
export type { RoomRoster } from "./store.js";
```

and add to the module docblock, after the "Presence is DERIVED, never stored" table:

```
 * Abandonment is the same reading over the whole room (#18). A room has no
 * clock; it is abandoned when no active member has been seen, by window or by
 * socket, for `ABANDONED_AFTER_MS`, and `abandonedAt`/`isAbandoned` say when.
 * They are defined in store.ts beside `lastSeen` for the reason given there and
 * re-exported here, which is where everything outside the stores reads them.
```

Also in `src/presence.ts`: in `STALE_AFTER_MS`'s docblock, "rather than at the room's TTL, which #18 made long." becomes "rather than never: rooms have no clock (#18)."; in the module docblock, "stayed full and unjoinable for the rest of its TTL (#103)" becomes "stayed full and unjoinable for good (#103)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/presence.test.ts`
Expected: PASS, every case in both new describes.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: abandonedAt and isAbandoned, the rule that replaces the clock (#18)"
```

---

### Task 2: MemoryStore sweeps for abandonment

**Files:**
- Modify: `src/store.ts` — `MemoryStore.expireIfDue` → `closeIfAbandoned`; `getSession`, `sessionsCreatedBy`, `sweep`, `freezeSession`; the `BellmanStore` interface docblock near line 684; `closeNow`'s comment.
- Modify: `tests/tools/sync-status.test.ts` (the one case that sweeps at the clock)
- Test: `tests/helpers/store-contract.ts` (the three sweep cases become abandonment cases; new cases), `tests/presence-sockets.test.ts` (the socket-stamp case in memory). `tests/store.test.ts` runs the suite.

**Interfaces:**
- Consumes: `abandonedAt`, `isAbandoned`, `stampSeen`, `ABANDONED_AFTER_MS` (Task 1); `MemoryStore.attachedTo(sessionId)` (exists, `protected`).
- Produces: `MemoryStore` behaviour the contract suite pins; nothing new exported.

The DurableObjectStore fails these contract cases until Task 3. Run only the Node program here; `npm run test:worker` is Task 3's.

- [ ] **Step 1: Rewrite the three sweep cases and add the new ones in `tests/helpers/store-contract.ts`**

Add to the imports: `import { ABANDONED_AFTER_MS } from "../../src/presence.js";` and change the type import to `import type { Session, SurfaceItem } from "../../src/types.js";`.

Replace the three cases "sweep expires a session past its TTL and emits session_expired", "sweep is idempotent — one expiry event, not one per sweep" and "expires a due session lazily on read, without waiting for a sweep" with:

```ts
    // ------------------------------------------------------- abandonment (#18)
    /** Last heard from a millisecond past the window: nobody has been in for 90 days. */
    const AGED = () => Date.now() - ABANDONED_AFTER_MS - 1;
    const abandonedRoom = (over: Partial<Session> = {}) =>
      session({ members: [member({ lastSeenAt: AGED() })], ...over });

    it("sweep closes a room nobody has been in for 90 days, retires its codes and says since when", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.sweep(Date.now()));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(true);
      expect(fresh.joinCodes).toEqual({});
      // Read after getSession, not before it: DurableObjectStore.sweep is a
      // no-op, so there it is the read above that closes the room and writes
      // this event. getSession no longer carries history (#25).
      const last = (await store.eventsAfter(s.id, 0)).at(-1)!;
      expect(last.type).toBe("session_expired");
      // The fact the decision was made on, so a client can say "closed, nobody
      // since <date>" rather than "closed".
      expect(last.payload).toEqual({ reason: "abandoned", last_seen_at: new Date(AGED()).toISOString() });
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    it("sweep is idempotent — one closing event, not one per sweep", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));

      await store.getSession(s.id);
      const expired = (await store.eventsAfter(s.id, 0)).filter((e) => e.type === "session_expired");
      expect(expired).toHaveLength(1);
    });

    it("closes an abandoned room lazily on read, without waiting for a sweep", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("keeps a room open while one active member was seen inside the window", async () => {
      const s = session({ members: [
        member({ lastSeenAt: AGED() }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: Date.now() - 1_000 }),
      ] });
      (await store.createSession(s));
      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
    });

    it("keeps a room open at exactly 90 days, and closes it a millisecond later", async () => {
      const s = session({ members: [member({ lastSeenAt: Date.now() - ABANDONED_AFTER_MS })] });
      (await store.createSession(s));
      expect((await store.getSession(s.id))?.closed, "at the boundary").toBe(false);

      vi.advanceTimersByTime(1);
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("never sweeps a frozen room, however long it has been frozen", async () => {
      const s = abandonedRoom({ frozenAt: Date.now() - ABANDONED_AFTER_MS });
      (await store.createSession(s));
      (await store.sweep(Date.now()));
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.frozenAt).not.toBeNull();
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
    });

    it("a thaw stamps every active member as seen now, so the room gets a full window back", async () => {
      // Frozen past the window, with one member who left before the freeze: the
      // thaw credits the active member and leaves the departed one alone.
      const s = session({
        frozenAt: Date.now() - 1_000,
        members: [
          member({ lastSeenAt: AGED() }),
          member({ memberId: "m_gone", userId: "u_gone", roomRole: "peer_b", lastSeenAt: AGED(), leftAt: AGED() }),
        ],
      });
      (await store.createSession(s));

      (await store.freezeSession(s.id, null));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.members.map((m) => [m.memberId, m.lastSeenAt]))
        .toEqual([["m_creator", Date.now()], ["m_gone", AGED()]]);
      // And the sweep agrees: the window restarted at the thaw.
      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
    });

    it("a thaw of a room that was not frozen stamps nobody", async () => {
      // The credit is paid on the transition, as clearSilence's is: a retried
      // freezeSession(null) must not keep a quiet room alive for good.
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.freezeSession(s.id, null));

      expect((await store.getSession(s.id))?.closed, "the sweep still sees it as abandoned").toBe(true);
    });
```

(`vi` is already imported in the suite. The remaining two sweep cases, "sweep drops expired pending connects" and "sweep leaves live sessions and tokens alone", stay as they are.)

- [ ] **Step 2: Rewrite the clock case in `tests/tools/sync-status.test.ts`**

Add `import { abandonedAt } from "../../src/presence.js";`. Rename "reports a room that expired while the poll waited as closed, beside the event that says so" to "reports a room abandoned while the poll waited as closed, beside the event that says so" and replace its first two lines with:

```ts
    const room = (await store.getSession(p.sessionId))!;
    store.onPark = () => { void store.sweep(abandonedAt(room)! + 1); };
```

- [ ] **Step 3: Add the socket-stamp case to `tests/presence-sockets.test.ts`**

In `describe("the four places a handler reads presence", …)`, which already has `SocketedStore`, `creator()`, `read()` and `member`, append:

```ts
  it("a sweep stamps the members a socket vouches for instead of closing the room (#18)", async () => {
    await store.createSession(session({ members: [
      creator(), member({ memberId: "m_quiet", userId: "u_quiet", roomRole: "peer_b", lastSeenAt: 1 }),
    ] }));
    // Both quiet past any window (1 ms after the epoch); only m_quiet is on a socket.
    await store.updateMember("qs_test", "m_creator", { lastSeenAt: 1 });
    store.attached.add("m_quiet");
    const now = Date.now();

    await store.sweep(now);

    const after = await read();
    expect(after.closed).toBe(false);
    expect(after.members.map((m) => [m.memberId, m.lastSeenAt])).toEqual([["m_creator", 1], ["m_quiet", now]]);
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);

    // The same sweep with the socket gone closes it: the stamp was the socket's.
    store.attached.clear();
    await store.updateMember("qs_test", "m_quiet", { lastSeenAt: 1 });
    await store.sweep(now);
    expect((await read()).closed).toBe(true);
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run tests/store.test.ts tests/presence-sockets.test.ts tests/tools/sync-status.test.ts`
Expected: FAIL. Contract: "sweep closes a room nobody has been in…" fails on `expect(fresh.closed).toBe(true)` (MemoryStore still reads the clock, 4 hours ahead); "closes an abandoned room lazily" and the boundary case fail the same way; "a thaw stamps…" fails on the `lastSeenAt` equality; "a thaw of a room that was not frozen" fails on `closed`. "never sweeps a frozen room" passes already (the clock is ahead); acceptable, it is pinned for Task 3's store. The socket case fails on `closed`. sync-status fails: the sweep at `abandonedAt + 1` closes nothing, the poll runs to its wait, and `session_expired` is absent.

- [ ] **Step 5: Implement in `src/store.ts`**

Replace `MemoryStore.expireIfDue` with:

```ts
  /**
   * Operates on the canonical session; callers hold detached copies.
   *
   * The abandonment rule is `isAbandoned`'s, shared with SessionDO's alarm and
   * readers. A socket vouching for an active member is the one way a room past
   * the window stays open, and it is recorded: those members are stamped as seen
   * now, which is what `webSocketClose` does on a drop (#152), so the next sweep
   * finds a fresh window rather than the same question.
   */
  private closeIfAbandoned(s: Session, now: number): void {
    const due = abandonedAt(s);
    if (due === null || now <= due) return;
    const connected = connectedAmong(s.members, this.attachedTo(s.id));
    if (!isAbandoned(s, now, connected)) {
      s.members = stampSeen(s.members, now, connected);
      return;
    }
    this.closeNow(s);
    const event: SessionEvent = {
      cursor: s.events.length + 1,
      type: "session_expired" as EventType,
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
      refId: null,
      at: now,
    };
    s.events.push(event);
    this.wake(s);
  }
```

Then: every `this.expireIfDue(` in `MemoryStore` (`getSession`, `sessionsCreatedBy`, `sweep`) becomes `this.closeIfAbandoned(`. Comments: in `sessionsCreatedBy`, "`expireIfDue` first, for the same reason getSession calls it: a room past its TTL is closed whether or not anything has written that down yet, and a sweep that read the flag alone would keep every expired room in the window" becomes "`closeIfAbandoned` first, for the same reason getSession calls it: an abandoned room is closed whether or not anything has written that down yet, and a sweep that read the flag alone would keep every abandoned room in the window"; in `getSession`, "expireIfDue has already run on `s`" becomes "closeIfAbandoned has already run on `s`"; in `closeNow`, "Agrees with expireIfDue" becomes "Agrees with closeIfAbandoned". The `BellmanStore` interface comment "past its TTL counts as closed here whether or not its alarm has fired" becomes "an abandoned room counts as closed here whether or not its alarm has fired".

`freezeSession`:

```ts
  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const wasFrozen = s.frozenAt !== null;
    s.frozenAt = frozenAt;
    if (frozenAt === null && wasFrozen) {
      const now = Date.now();
      // The report credit (#111 D10) and the presence stamp (#18) ride the same
      // transition: a room coming back from a freeze gets a full window, not the
      // one the freeze spent.
      s.members = stampSeen(clearSilence(s, now), now);
    }
  }
```

Add to its docblock: "The thaw also stamps every active member as seen now (#18). `touchMember` refuses a frozen room, so the window was not moving while it was frozen; without this stamp a room thawed after 90 days frozen would be swept on the next read."

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/store.test.ts tests/presence-sockets.test.ts tests/tools/sync-status.test.ts tests/presence.test.ts`
Expected: PASS, all files.

Then: `npx vitest run`
Expected: PASS for every Node test file; nothing else reads `expireIfDue`. (The worker program is red until Task 3; do not run it here.)

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: MemoryStore closes abandoned rooms, not expired ones (#18)"
```

---

### Task 3: SessionDO's abandonment alarm

**Files:**
- Modify: `src/store-do.ts` — `pastTtl` (delete), `readsClosed`, the driver field's docblock, `membersOf`, `fetch`, `getSession`, `freezeSession`, `#stampClosing`, `alarm()`, `#derivedDue`, `#expireIfDue` → `#closeIfAbandoned`, `#tickIfDue`; the module header's "session TTL is enforced by a per-object alarm" sentence.
- Modify comments only: `src/outbox.ts` (lines ~215–216 and ~255), `src/heartbeat.ts` (~109), `src/worker.ts` (~268), `src/rooms.ts` (~615), `src/tools/connect.ts` (~68), `src/tools/sync.ts` (~173, only if it means the room's clock).
- Test: `tests/store-do-wiring.test.ts`; `worker-tests/alarms.test.ts`, `worker-tests/session-expiry-atomic.test.ts`, `worker-tests/heartbeat-tick.test.ts`, `worker-tests/join-code-outbox.test.ts`, `worker-tests/ws-close-race.test.ts`.

**Interfaces:**
- Consumes: `abandonedAt`, `isAbandoned`, `stampSeen`, `ABANDONED_AFTER_MS` from `./store.js` (Task 1); `connectedAmong`, `dropCodeIntent`, `nextTickAt`, `clearSilence` (exist).
- Produces: `const ABANDONED_HANDLER = "abandoned"` (module-private); `readsClosed(s, now, attached: Iterable<string>)`; `#closeIfAbandoned(s, now)`.

- [ ] **Step 1: Rewrite the Node wiring cases in `tests/store-do-wiring.test.ts`**

Add `import { ABANDONED_AFTER_MS } from "../src/presence.js";` and, if `Member` is not already a type import there, `import type { Member } from "../src/types.js";`. Then, by test name:

1. "alarm() leaves it alone even when it is past its TTL" → rename "alarm() leaves it alone even when it is abandoned"; the row is `legacyRow({ members: [member({ lastSeenAt: 1 })] })`; the first comment line becomes "closeIfAbandoned changes only a row that is abandoned and returns early on any other."
2. "still expires when its alarm fires" → rename "still closes when its alarm fires"; `session({ id: "qs_expired", members: [member({ lastSeenAt: 1 })] })`.
3. "lets a mutator rewrite it and a due alarm expire it" → the `viaAlarm` row is `{ ...legacyRow({ members: [member({ lastSeenAt: 1 })] }), joinCodes: {}, manifest: { heartbeatOnMs: null } }`.
4. "reports a room past its TTL as closed, and writes nothing" → rename "reports an abandoned room as closed, and writes nothing"; the row is `withMembers({ memberId: "m1", userId: "u1", lastSeenAt: 1 })`; in the comment, "getSession closes a room past its TTL on read (expireIfDue)" → "getSession closes an abandoned room on read (closeIfAbandoned)".
5. "agrees with getSession about a room at its TTL boundary" → rename "…at its abandonment boundary"; the loop becomes

   ```ts
      for (const [where, lastSeenAt] of [
        ["a millisecond past", now - ABANDONED_AFTER_MS - 1],
        ["exactly at", now - ABANDONED_AFTER_MS],
        ["a millisecond short of", now - ABANDONED_AFTER_MS + 1],
      ] as const) {
        const row = withMembers({ memberId: "m1", userId: "u1", lastSeenAt });
   ```

   with the label `${where} its window`. Its comment "> and >= differ only at now === expiresAt" → "now === abandonedAt".
6. In `describe("a room that reads closed")`, the second CASE becomes `{ what: "abandoned with the alarm still to come", over: { members: [member({ lastSeenAt: 1 })] } }`.
7. "delivers session_expired over the socket too": the socket belongs to a member who LEFT, so it vouches for nobody (R2: a leaver still watches):

   ```ts
    const live = currentRow({ members: [
      member({ memberId: "m1", userId: "u1", leftAt: 5 }),
      member({ memberId: "m2", userId: "u2", lastSeenAt: Date.now() }),
    ] });
    const storage = fakeStorage({ session: live, cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    await doi.fetch(open(ctx, 0)); // the socket names m1, who has left
    await storage.put("session", {
      ...live, members: (live.members as Member[]).map((m) => ({ ...m, lastSeenAt: 1 })),
    });
    await doi.alarm();
    expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).type)).toEqual(["session_expired"]);
   ```

   In its comment, "the TTL arrives beneath them" → "the window closes beneath them".
8. `describe("SessionDO.alarm: the TTL re-arm")` → `"SessionDO.alarm: the abandonment re-arm"`. In each of its four cases replace `{ ...currentRow(<over>), expiresAt: at }` with `currentRow({ ...<over>, members: [member({ lastSeenAt: at - ABANDONED_AFTER_MS })] })`, and the closed case's row with `{ ...currentRow({ members: [member({ lastSeenAt: 1 })] }), closed: true }`. In names and comments: "TTL" → "window", "expiresAt" → "abandonedAt", "expireIfDue's guard is `now <= expiresAt`" → "closeIfAbandoned's guard is `now <= abandonedAt`", "expires nothing" → "closes nothing", "derives no TTL" → "derives no abandonment time".

Then ADD, in the describe that holds case 7 (it has `open` and `fakeCtx`):

```ts
  it("stamps the members a socket vouches for and re-arms 90 days out, instead of closing", async () => {
    // Review Focus 1: a room held open on one socket for a season. Without the
    // stamp the alarm finds the same abandoned row every firing and reArm()
    // points it straight back, back to back for as long as the socket lives.
    const live = currentRow({ members: [member({ memberId: "m1", userId: "u1", lastSeenAt: 1 })] });
    const storage = fakeStorage({ session: live, cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    await doi.fetch(open(ctx, 0));
    const before = Date.now();

    await doi.alarm();

    const row = (await storage.get("session")) as { closed: boolean; members: { lastSeenAt: number }[] };
    expect(row.closed).toBe(false);
    expect(row.members[0].lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(ctx.sockets[0].sent).toEqual([]);
    expect(storage.alarms.at(-1)).toBeGreaterThanOrEqual(before + ABANDONED_AFTER_MS);
  });
```

In the describe that holds `withMembers` (membersOf), add:

```ts
  it("reads an aged room as open while a socket vouches for an active member, and closed once it does not", async () => {
    // Review Focus 3. The reader and the alarm share isAbandoned, sockets included.
    const row = withMembers({ memberId: "m1", userId: "u1", lastSeenAt: 1 });
    const vouchedStorage = fakeStorage({ session: row, cursor: 0 });
    const vouched = fakeCtx(vouchedStorage);
    const doiVouched = new storeDo.SessionDO(vouched as never, {} as never);
    await doiVouched.fetch(open(vouched, 0)); // m1's socket
    expect((await doiVouched.membersOf("u1")).closed).toBe(false);

    const alone = new storeDo.SessionDO(fakeCtx(fakeStorage({ session: row, cursor: 0 })) as never, {} as never);
    expect((await alone.membersOf("u1")).closed, "control: the same row with no socket").toBe(true);
  });
```

(`open(ctx, cursor, members = "m1")` is defined inside the socket describe at line ~1353; if it is out of scope where `withMembers` lives, build the request as that helper does, with `x-bellman-members: m1`.)

And, for Review Focus 2, in the re-arm describe:

```ts
  it("keeps a room thawed past the window open on the next firing", async () => {
    // Review Focus 2. The thaw stamps, so the firing it re-arms finds a fresh window.
    const storage = fakeStorage({
      session: { ...currentRow({ members: [member({ lastSeenAt: 1 })] }), frozenAt: Date.now() - ABANDONED_AFTER_MS },
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    await doi.freezeSession(null);
    await doi.alarm();

    expect((await storage.get("session")) as { closed: boolean }).toMatchObject({ closed: false });
    expect(storage.alarms.at(-1)).toBeGreaterThan(Date.now() + ABANDONED_AFTER_MS - 60_000);
  });
```

- [ ] **Step 2: Rewrite the worker tests**

`worker-tests/alarms.test.ts` — add `import { ABANDONED_AFTER_MS } from "../src/presence.js";`, change the fixtures import to `import { member, session } from "../tests/helpers/fixtures.js";`, add `import type { Member } from "../src/types.js";`, add `SELF` to the `cloudflare:test` import, and replace `room`:

```ts
/** A room whose one member was last seen at `lastSeenAt`; the window runs from there. */
const room = (id: string, lastSeenAt: number) =>
  session({ id, joinCodes: {}, members: [member({ lastSeenAt })] });
```

- "arms the session TTL through the named-alarm path" → "arms the abandonment time through the named-alarm path": `const seen = Date.now() - 1_000; await store.createSession(room("qs_abandoned", seen)); … expect(await ctx.storage.getAlarm()).toBe(seen + ABANDONED_AFTER_MS);`
- "still expires a session that has no stored due row" → "still closes an abandoned room that has no stored due row, and ignores a legacy expiresAt"; the forge becomes

  ```ts
    const stored = await ctx.storage.get<{ members: Member[] }>("session");
    // The pre-#18 shape as well: a clock in the past, which nothing reads any more.
    await ctx.storage.put("session", {
      ...stored, expiresAt: Date.now() - 1,
      members: stored!.members.map((m) => ({ ...m, lastSeenAt: 1 })),
    });
  ```

  Everything after it stays. In its docblock, "only its expiresAt" → "only its members' lastSeenAt", "never expire" → "never be swept".
- "leaves the TTL armed after an alarm that had nothing to expire" → "leaves the abandonment time armed after an alarm that had nothing to close": `const seen = Date.now() - 1_000; … expect(await ctx.storage.getAlarm()).toBe(seen + ABANDONED_AFTER_MS);`
- ADD, copying `const KEY = "qk_ws_test";` and `open(id)` from `worker-tests/presence-sockets.test.ts`:

```ts
/**
 * Review Focus 1, through a real socket. The alarm finds the room past its window
 * and a socket vouching for its member: it stamps and re-arms a window ahead,
 * and the room is not closed. The fixture's member is u_jesse, which is the
 * identity KEY carries, so the socket vouches for it.
 */
it("stamps and re-arms instead of closing when a socket vouches for a member", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_held", 1));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_held"));
  await open("qs_held");
  const before = Date.now();

  await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

  const after = await runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    session: await ctx.storage.get<{ closed: boolean; members: { lastSeenAt: number }[] }>("session"),
    alarm: await ctx.storage.getAlarm(),
    events: [...(await ctx.storage.list({ prefix: "e:" })).keys()],
  }));
  expect(after.session!.closed).toBe(false);
  expect(after.session!.members[0].lastSeenAt).toBeGreaterThanOrEqual(before);
  expect(after.events).toEqual([]);
  expect(after.alarm).toBeGreaterThanOrEqual(before + ABANDONED_AFTER_MS);
});
```

`worker-tests/session-expiry-atomic.test.ts` — `lapsedRoom`'s forge becomes `members: stored!.members.map((m) => ({ ...m, lastSeenAt: 1 }))` with `stored` read as `ctx.storage.get<{ members: Member[] }>("session")` (import `type Member`); `WAYS[1].way` becomes `"the abandonment alarm"`; in the header and the `lapsedRoom` docblock, `#expireIfDue` → `#closeIfAbandoned`, "the TTL alarm" → "the abandonment alarm", "its TTL already behind it" → "its window already behind it".

`worker-tests/heartbeat-tick.test.ts` — add `import { ABANDONED_AFTER_MS, abandonedAt } from "../src/presence.js";` and `import type { Member } from "../src/types.js";`:
- "arms nothing for a room whose roles ask for no reports": read `const s = await ctx.storage.get<{ closed: boolean; frozenAt: number | null; members: Member[] }>("session");` and `expect(await ctx.storage.getAlarm()).toBe(abandonedAt(s!));`; comment "Only the TTL, which is the session's expiry and not a tick." → "Only the abandonment time, which is not a tick."
- `lapseRoom(stub, lastSeenAt: number)` puts `members: (s!.members as Member[]).map((m) => ({ ...m, lastSeenAt }))`; its docblock: "Push every member's `lastSeenAt` back, as a room does by sitting idle between two firings. Raw rows, and the room stays OPEN: `#closeIfAbandoned` is what closes it, and this is the state the alarm finds before it has."
- "writes no tick into a room past its TTL, which the alarm closes in the same firing" → "writes no tick into an abandoned room, which the alarm closes in the same firing"; `lapseRoom(stub, Date.now() - ABANDONED_AFTER_MS - 1_000)`. Its docblock becomes: "`derivedDue` hands back both names, `dueNames` sorts them, and `abandoned` sorts before `heartbeat`, so the close runs first and the tick finds a closed room. That order is an accident of the alphabet; the guard the next case puts on trial is what holds if it changes."
- "still ticks a room whose expiry is ahead of it" → "still ticks a room whose window is still ahead of it"; `lapseRoom(stub, Date.now() - ABANDONED_AFTER_MS + 30_000)`; in its docblock "whose TTL is still ahead of it" → "whose window is still ahead of it", "#expireIfDue acts only once `now` is past `expiresAt`" → "#closeIfAbandoned acts only once `now` is past `abandonedAt`".
- ADD after it, using the file's `nameTheTick`-driven helper (`fireNamedTick`, as the frozen case uses):

  ```ts
  it("writes no tick into an abandoned room even when the alarm names the tick alone", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(room("qs_abandoned_tick"));
    const stub = env.SESSION.get(env.SESSION.idFromName("qs_abandoned_tick"));
    await ageRoom(stub);
    await lapseRoom(stub, Date.now() - ABANDONED_AFTER_MS - 1_000);

    await fireNamedTick(stub);

    const after = await rows(stub);
    expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
    // Only the tick ran, so the guard, not the close, is what refused it.
    expect(after.events.filter((e) => e.type === "session_expired")).toEqual([]);
  });
  ```

- `alarmAndExpiry` → `alarmAndAbandonment`, returning `{ alarm, abandonedAt: abandonedAt(row)! }` where `row` is the stored session read with the three-field type above; every `.expiresAt` on its result becomes `.abandonedAt`; "the TTL" in those comments becomes "the abandonment time".
- "arms the tick again when a frozen room is thawed": a frozen room derives nothing, so after the firing nothing is armed: `expect(frozen.alarm).toBeNull();` and keep `expect(thawed.alarm).toBeLessThan(thawed.abandonedAt);`. Its docblock sentence "re-armed to the TTL alone" → "left with no alarm".

`worker-tests/join-code-outbox.test.ts` — add `member` to the fixtures import, `ABANDONED_AFTER_MS` from `../src/presence.js`, `type Member` from `../src/types.js`:
- `lapse(id)` puts `members: (stored!.members as Member[]).map((m) => ({ ...m, lastSeenAt: 1 }))`; docblock "Put the session's members past the window, as alarms.test.ts does."
- "arms the TTL once the backstop has fired, for a room created with a join code" → "arms the abandonment time once…": `const seen = Date.now() - 1_000; await store.createSession(session({ id, joinCodes: oneCode(A, "peer_b"), members: [member({ lastSeenAt: seen })] })); … expect(await armedAlarm(id)).toBe(seen + ABANDONED_AFTER_MS);`. Its docblock: "the TTL" → "the abandonment time", "never expires" → "is never swept".
- "does not answer over RPC for the methods that write what their caller supplies": `expireIfDue` → `closeIfAbandoned` in the forged call, the `outcomes` key and the docblock; the forged record is `session({ id, members: [member({ lastSeenAt: 1 })], joinCodes: { peer_b: { code: A, expiresAt: live() } } })` and its comment "lapsed and open" → "abandoned and open".
- "It is the TTL handler that closes the room" → "It is the abandonment handler that closes the room".

`worker-tests/ws-close-race.test.ts` — add `member` to the fixtures import and `ABANDONED_AFTER_MS` from `../src/presence.js`; "is refused when the room lapses past its TTL while the upgrade waits" → "is refused when the room's window closes while the upgrade waits":

```ts
    const due = Date.now() + 500;
    const { id, stub } = await room({ members: [member({ lastSeenAt: due - ABANDONED_AFTER_MS })] });
    …
    await until(() => Date.now() > due, "the room's window to close", 5_000);
```

and in its comment "the clock simply crosses expiresAt" → "the clock simply crosses abandonedAt".

- [ ] **Step 3: Run the Node wiring file to verify it fails**

Run: `npx vitest run tests/store-do-wiring.test.ts`
Expected: FAIL. Red: "still closes when its alarm fires" (row not closed: the alarm reads `expiresAt`, 4 hours ahead), "reports an abandoned room as closed" (closed false), the 409 CASE "abandoned with the alarm still to come" (101, not 409), "delivers session_expired over the socket too" (nothing sent), the two new stamp/thaw cases, "reads an aged room as open…" (the control reads false), and the re-arm describe (alarms at the clock, not the window). The boundary comparison passes on both sides false; acceptable, it cannot fail alone.

- [ ] **Step 4: Implement in `src/store-do.ts`**

Imports: add `ABANDONED_AFTER_MS, abandonedAt, isAbandoned, stampSeen` to the import from `./store.js`.

Beside `HEARTBEAT_HANDLER`:

```ts
/**
 * The alarm handler that closes a room nobody has been in for 90 days (#18). A
 * name only, derived like the heartbeat's: never stored under `due:`, so a
 * rollback strands nothing. See derivedDue().
 */
const ABANDONED_HANDLER = "abandoned";
```

Delete `pastTtl` and its docblock. `readsClosed` becomes:

```ts
/**
 * Whether a room reads as closed, deciding it without writing: closed outright, or
 * abandoned with the alarm still to come. A row that is gone reads closed, which
 * is the answer an unknown room has always had.
 *
 * `attached` is what the object's sockets carry (`#attachedIds()`), because a
 * socket vouching for an active member is the one thing that keeps a room past
 * its window open. The rule is `isAbandoned`'s, shared with `#closeIfAbandoned`
 * and both stores' sweeps, so a room reads closed here exactly when the alarm
 * would close it.
 *
 * Every read that refuses a closed room goes through here, so the rule and the
 * refusals cannot drift apart. `membersOf` authorizes a watch with it and `fetch`
 * rechecks it before accepting the socket: one rule asked twice, which is what #133
 * was missing. With no recheck, a close landing between the two calls left a socket
 * on a closed room and nothing to close it.
 */
const readsClosed = (s: StoredSession | undefined, now: number, attached: Iterable<string>): boolean =>
  !s || s.closed || isAbandoned(s, now, connectedAmong(s.members, attached));
```

Callers: `membersOf` → `closed: readsClosed(s, Date.now(), this.#attachedIds())`; `fetch` → `if (!s || readsClosed(s, Date.now(), this.#attachedIds()))`. In `fetch`'s comment, "a close, the TTL alarm, or a removal" → "a close, the abandonment alarm, or a removal"; in `membersOf`'s docblock, "a room past its TTL whose alarm has not fired yet" → "an abandoned room whose alarm has not fired yet" and "expireIfDue" → "closeIfAbandoned" (twice).

`getSession`: `await this.#closeIfAbandoned(s, Date.now());` with the comment "Re-read: closeIfAbandoned may have written closed=true and cleared the codes, or stamped a socket's members."

`freezeSession`:

```ts
    const thawing = frozenAt === null && s.frozenAt !== null;
    const now = Date.now();
    const members = thawing ? stampSeen(clearSilence(s, now), now) : s.members;
```

Add to its docblock: "The thaw also stamps every active member as seen now (#18): `touchMember` refuses a frozen room, so the window did not move while it was frozen, and the `reArm()` below would otherwise point at an abandonment time already past and the next firing would close the room the thaw just gave back."

`#stampClosing`: replace the `members:` line with `members: stampSeen(s.members, now, stamped),`.

`alarm()`:

```ts
      if (name === ABANDONED_HANDLER) {
        const s = await this.stored();
        if (s) await this.#closeIfAbandoned(s, now);
      }
```

`#derivedDue`:

```ts
  /**
   * Due times this object computes rather than stores. A closed session has nothing
   * left to enforce: deriving a time for it would re-arm the alarm to a moment already
   * past, and it would fire again for as long as the session existed. It has no tick
   * to send either, which is why the early return covers both. A frozen room derives
   * neither (both functions answer null for it), so a freeze leaves this object with
   * no alarm until the thaw re-arms it.
   */
  async #derivedDue(): Promise<Map<string, number>> {
    const s = await this.stored();
    if (!s || s.closed) return new Map();
    const due = new Map<string, number>();
    // Derived rather than a stored `due:` row, deliberately. A name the driver
    // can report with no branch in alarm() is never consumed, and the closing
    // reArm() fires the alarm back to back for good: the rollback hazard this
    // object's alarm() comment records for `due:outbox`. A build that does not
    // know this name does not compute it either, so rolling back strands nothing.
    const abandoned = abandonedAt(s);
    if (abandoned !== null) due.set(ABANDONED_HANDLER, abandoned);
    const tick = nextTickAt(s);
    if (tick !== null) due.set(HEARTBEAT_HANDLER, tick);
    return due;
  }
```

`#expireIfDue` becomes `#closeIfAbandoned`, keeping its transaction, `#writeEvent`, `#wake` and drain:

```ts
  /**
   * `#private`, because it overwrites the session with the record it is handed and queues
   * the registry's removal of every code in it. A Durable Object answers RPC for every
   * method on its class, so a TypeScript `private` one would let anything holding the
   * SESSION binding rewrite a room and reach into the registry's index.
   *
   * Reached from the alarm and from any read that finds the room abandoned. Two
   * outcomes past the window. A socket vouching for an active member means the room
   * is not abandoned whatever `lastSeenAt` says, and that is written down: those
   * members are stamped as seen now, the stamp `webSocketClose` makes on a drop
   * (#152) made on a schedule, so reArm() points the alarm a window ahead instead
   * of straight back at this one. Otherwise the room closes: the close, the registry
   * removals its codes owe and the `session_expired` event are one commit (#124).
   * Split, an interruption after the close left a room closed with no event, and
   * nothing wrote one afterwards, because the retry found the room closed and had
   * nothing left to do. In one transaction an interruption leaves the room as it
   * was, still abandoned, and the next read or the alarm does all of it again.
   */
  async #closeIfAbandoned(s: StoredSession, now: number): Promise<void> {
    const due = abandonedAt(s);
    if (due === null || now <= due) return;
    // The sockets as they are now, synchronous, so the decision and the write are
    // made against the same set. Nothing but storage is awaited between the read
    // that produced `s` and the put below, so the input gate holds across both.
    const connected = connectedAmong(s.members, this.#attachedIds());
    if (!isAbandoned(s, now, connected)) {
      await this.ctx.storage.put("session", { ...s, members: stampSeen(s.members, now, connected) });
      return;
    }
    const intents = Object.values(s.joinCodes).map((rec) => dropCodeIntent(rec.code));
    const event = await this.ctx.storage.transaction<SessionEvent>(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      const expired: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "session_expired" as EventType,
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "bellman",
        payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
        refId: null,
        at: now,
      };
      await this.#writeEvent(txn, expired, {
        session: { ...s, closed: true, joinCodes: {} }, ...rows,
      });
      return expired;
    });
    this.#wake(event);
    // Last, so a poll woken above does not wait on the registry. Reached from the
    // alarm and from any read that finds the room abandoned, and both drain here
    // rather than leave the rows for the next alarm.
    if (intents.length > 0) await this.driver.deliverNow();
  }
```

`#tickIfDue`: the guard becomes

```ts
      if (s.closed || s.frozenAt !== null) return null;
      if (isAbandoned(s, now, connectedAmong(s.members, this.#attachedIds()))) return null;
```

and its docblock's third bullet becomes: "An **abandoned** room gets the same, and it is reachable where the other two are not: it is not closed until `#closeIfAbandoned` closes it, so a firing told of the tick alone would ask members who are not there. `isAbandoned` is `#closeIfAbandoned`'s own test, read here rather than relying on `dueNames`' order: a guard is checkable where a name's place in an alphabet is an accident."

Other comments in `store-do.ts`: the driver field's docblock, `"ttl"` paragraph → `"abandoned" closes a room nobody has been in for 90 days (#18). It is DERIVED from the members' lastSeenAt rather than stored as a due: row, because sessions written before named alarms have no row and an alarm re-armed from stored rows alone would leave every one of them unswept. See derivedDue().`, and `Derived like "ttl"` → `Derived like "abandoned"`. `alarm()`'s docblock: every "TTL" → "abandonment time", "expireIfDue" → "closeIfAbandoned", "`now > expiresAt`" → "`now > abandonedAt`", "expiresAt" → "abandonedAt", "expires nothing" → "closes nothing"; add after the boundary paragraph: "A socket vouching past the window is the third case: the handler stamps and the derived time moves a window ahead, so that firing is not repeated either." The module header: "session TTL is enforced by a per-object alarm" → "abandonment is enforced by a per-object alarm".

Comment-only edits outside: `src/outbox.ts` ~215–216 "SessionDO returns its session TTL here so that sessions written before named alarms still expire" → "SessionDO returns its abandonment time here so that sessions written before named alarms are still swept"; ~255 "session TTL that was already closer" → "abandonment time that was already closer". `src/heartbeat.ts` ~109 "about the TTL" → "about abandonment". `src/worker.ts` ~268 "the TTL alarm" → "the abandonment alarm". `src/rooms.ts` ~615 "the session-TTL sweep" → "the abandonment sweep". `src/tools/connect.ts` ~68 "at every retry until its TTL" → "at every retry for good". `src/tools/sync.ts` ~173: read the sentence; if "the room's TTL" means the room's clock it becomes "the room's abandonment"; if it means `ACTION_REQUEST_TTL_MS`, leave it.

- [ ] **Step 5: Run the Node wiring file to verify it passes**

Run: `npx vitest run tests/store-do-wiring.test.ts tests/outbox.test.ts`
Expected: PASS. (`tests/outbox.test.ts` uses `"ttl"` as an arbitrary handler name in pure driver tests; it stays green untouched.)

- [ ] **Step 6: Run the worker program to verify it passes**

Run: `npm run test:worker 2>&1 | tail -40`
Expected: PASS, every file, including `store-contract.test.ts` with Task 2's abandonment cases now green against `DurableObjectStore`. A failure in `alarms.test.ts`'s new socket case on `getAlarm()` means the stamp put happened but no re-arm followed: `alarm()`'s closing `reArm()` is what re-arms, and the handler must not return before the loop reaches it.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: SessionDO sweeps for abandonment; a socket keeps the room and stamps it (#18)"
```

---

### Task 4: The clock leaves the types

**Files:**
- Modify: `src/types.ts` (`Session.expiresAt`, `Entitlements.sessionTtlMs`), `src/auth.ts` (`sessionTtlMs` off every plan), `src/stored-session.ts` (strip `expiresAt`), `src/tools/start.ts` (session construction, return, description), `src/oauth/routes.ts` (the *Session lifetime* row).
- Modify: `tests/helpers/fixtures.ts` (`session()` loses `expiresAt`), `tests/auth.test.ts`, `tests/stored-session.test.ts`, `tests/tools/handshake.test.ts`, `tests/oauth-flow.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `Session` without `expiresAt`; `Entitlements` without `sessionTtlMs`; `bellman_start` without `session_expires_at`.

- [ ] **Step 1: Write the failing tests**

`tests/stored-session.test.ts` — append:

```ts
/**
 * A record stored before rooms persisted (#18): it carries the clock, and from
 * the same change the plan cap. Both are stripped rather than defaulted,
 * because a missing clock IS the new state and a stored cap would be the stale
 * mirror of capacityOf(manifest).
 */
describe("hydrateStoredSession — a record stored with a clock", () => {
  it("strips expiresAt", () => {
    const { events: _events, ...raw } = session();
    const row = hydrateStoredSession({ ...raw, expiresAt: 1 })!;
    expect(row).not.toHaveProperty("expiresAt");
  });
});
```

Also in that file, the comment "session() stamps expiresAt from Date.now()" (in "leaves a row that already has joinCodes alone") becomes "session() stamps its join code's expiresAt from Date.now()".

`tests/tools/handshake.test.ts` — in "derives mode from the manifest, not from an argument", after the `isError` check:

```ts
    // Rooms persist (#18): nothing on the return says when the room ends.
    expect(res.data).not.toHaveProperty("session_expires_at");
```

`tests/auth.test.ts`:
- "raises member ceilings, TTLs and quotas monotonically by plan": delete its three `sessionTtlMs` lines (the `maxMembers` lines go in Task 5).
- "gives max the team-sized room: 25 members for 14 days, 2,000 a month (#45)": delete the `sessionTtlMs` line.
- "describes creation limits only — no join-side gating exists": remove `"sessionTtlMs"` from `creationOnlyFields`.

`tests/oauth-flow.test.ts` — beside "shows plan, where it came from, and the quota":

```ts
  it("renders the account page without a session lifetime, because rooms persist (#18)", async () => {
    const token = await tokenFor();
    const res = await call("/account", { headers: { authorization: `Bearer ${token}`, accept: "text/html" } });
    const html = await res.text();

    expect(html, "control: the table is there").toContain("Modes");
    expect(html).not.toContain("Session lifetime");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/stored-session.test.ts tests/tools/handshake.test.ts tests/auth.test.ts tests/oauth-flow.test.ts`
Expected: FAIL: "strips expiresAt" (property present), "derives mode…" (`session_expires_at` present), "renders the account page without a session lifetime" (row present). `tests/auth.test.ts` passes (its edits removed assertions; its red is the typecheck in Step 4).

- [ ] **Step 3: Implement**

`src/types.ts`: delete `expiresAt: number;            // whole-session TTL` from `Session` and `sessionTtlMs: number;` from `Entitlements`. Where the `Session` line was:

```ts
  // There is no `expiresAt`: rooms persist (#18). A room ends when its last
  // member leaves or when nobody has been in it for ABANDONED_AFTER_MS, and
  // that time is derived from the members (`abandonedAt`), never stored.
```

`src/auth.ts`: delete the four `sessionTtlMs:` lines. (The `max` comment is Task 6's.)

`src/stored-session.ts`: the destructure becomes

```ts
  const {
    joinCode, joinCodeExpiresAt, expiresAt: _clock, ...row
  } = raw as StoredSession & { joinCode?: string | null; joinCodeExpiresAt?: number; expiresAt?: number };
```

and the docblock gains a bullet: "- **expiresAt** (#18) is stripped. Rooms persist, so a missing clock is the state every row is in now; a stored one would be a field the type forbids, read by nothing." Update "Five changes to the stored shape" to "Six".

`src/tools/start.ts`: delete `expiresAt: now + ent.sessionTtlMs,` from the session literal and `session_expires_at: …` from the return; in the description, `join_code_expires_at, session_expires_at, plan,` → `join_code_expires_at, plan,`, and after "Keep member_id — every subsequent call needs it." add "The room has no lifetime: it ends when its last member leaves, or after 90 days in which nobody in it was seen."

`src/oauth/routes.ts`: delete the `row("Session lifetime", …)` line.

`tests/helpers/fixtures.ts`: delete `expiresAt: now + 4 * 60 * 60 * 1000,` from `session()`.

- [ ] **Step 4: Typecheck both programs, and fix every site the compiler names**

Run: `npm run typecheck && npm run typecheck:worker`
Expected: errors only at sites that still name `expiresAt` on a session or `sessionTtlMs`. Each is fixed by the rule of Tasks 2–3: a session's `expiresAt: <past>` becomes `members: [member({ lastSeenAt: 1 })]`; a `<future>` one becomes a member seen at `<future> - ABANDONED_AFTER_MS`; a read of `.expiresAt` on a session becomes `abandonedAt(row)`. The join-code and connect-token `expiresAt` fields are untouched. Re-run until clean.

Then: `npx vitest run` and `npm run test:worker 2>&1 | tail -20`
Expected: PASS, both programs.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: the session clock leaves the types, the plans and bellman_start (#18)"
```

---

### Task 5: A swarm room's size is a ceiling, not a plan

**Files:**
- Modify: `src/store.ts` (`ROOM_MEMBER_CEILING`, `capacityOf`; `MemoryStore.seatMember`), `src/store-do.ts` (`seatMember`), `src/types.ts` (`Session.maxMembers`, `Entitlements.maxMembers`), `src/auth.ts`, `src/stored-session.ts` (strip `maxMembers`), `src/rooms.ts` (`fullMessage`, `issueInvite`), `src/tools/start.ts`, `src/tools/connect.ts`, `src/tools/confirm.ts`, `src/oauth/routes.ts` (the *Members per session* row).
- Modify: `tests/helpers/fixtures.ts` (`swarmSession`), `tests/helpers/store-contract.ts`, `tests/presence.test.ts`, `tests/presence-sockets.test.ts`, `tests/rooms.test.ts`, `tests/tools/handshake.test.ts`, `tests/tools/verbs.test.ts`, `tests/tools/max-plan.test.ts`, `tests/auth.test.ts`, `tests/stored-session.test.ts`, `tests/store-do-wiring.test.ts`, `tests/oauth-flow.test.ts`, `worker-tests/presence-sockets.test.ts`, `worker-tests/ws-delivery.test.ts`, `worker-tests/session-close-join-race.test.ts`, `worker-tests/removed-member-sync.test.ts`.

**Interfaces:**
- Consumes: `seatVictims(members, cap, staleBefore, connected)` (unchanged), `seatedMembers` (unchanged).
- Produces, from `src/store.ts`: `export const ROOM_MEMBER_CEILING = 100` and `export const capacityOf = (manifest: RoomManifest): number`. From `src/rooms.ts`: `export function fullMessage(manifest: RoomManifest): string`. From `tests/helpers/fixtures.ts`: `export function swarmSession(over?: Partial<Session>): Session`, the pair fixture's roles under `mode: "swarm"`, `preset: null`.

- [ ] **Step 1: Write the failing tests**

`tests/helpers/fixtures.ts` — add:

```ts
/**
 * The pair fixture's roles in a room that holds the ceiling. `capacityOf` reads
 * the mode and nothing else, so this is how a test gets a spare seat beyond two
 * without changing the seats it already names.
 */
export function swarmSession(over: Partial<Session> = {}): Session {
  return session({ manifest: roomManifest({ mode: "swarm", preset: null }), ...over });
}
```

`tests/presence.test.ts` — append, importing `ROOM_MEMBER_CEILING, capacityOf` from `../src/store.js` and `roomManifest` from the fixtures:

```ts
describe("capacity is the manifest's (#18)", () => {
  it("is two for a pair room and the ceiling for a swarm room", () => {
    expect(capacityOf(roomManifest())).toBe(2);
    expect(capacityOf(roomManifest({ mode: "swarm" }))).toBe(ROOM_MEMBER_CEILING);
  });

  it("puts the ceiling at 100, which a room of maximal briefs keeps under one stored value", () => {
    // A brief at the schema's maximum is 14,710 characters; 100 of them are 1.47 MB
    // of a 2 MB Durable Object value. 250 would be 3.7 MB.
    expect(ROOM_MEMBER_CEILING).toBe(100);
  });
});
```

`tests/helpers/store-contract.ts` — add `swarmSession` to the fixtures import and `ROOM_MEMBER_CEILING` to the `../../src/store.js` import; append to the seating section:

```ts
    it("seatMember seats a 100th member into a swarm room and refuses a 101st", async () => {
      const present = (i: number) =>
        member({ memberId: `m_${i}`, userId: `u_${i}`, roomRole: "peer_b", lastSeenAt: Date.now() });
      const s = swarmSession({ members: Array.from({ length: ROOM_MEMBER_CEILING - 1 }, (_, i) => present(i)) });
      (await store.createSession(s));

      const hundredth = await store.seatMember(s.id, present(100), 1, Date.now());
      const beyond = await store.seatMember(s.id, present(101), 1, Date.now());

      expect(hundredth).toEqual({ refused: null, reclaimed: [], codesCleared: true });
      expect(beyond).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.members.filter((m) => m.leftAt === null)).toHaveLength(ROOM_MEMBER_CEILING);
    });
```

`tests/rooms.test.ts` — in the describe holding "refuses a full room, because the code could not be used", add (import `swarmSession` from the fixtures and `ROOM_MEMBER_CEILING` from `../src/store.js`):

```ts
  it("names the ceiling when a swarm room is full", async () => {
    // Review Focus 4: a creator at 100 is told it is Bellman's ceiling, not their plan's.
    const seats = Array.from({ length: ROOM_MEMBER_CEILING - 1 }, (_, i) =>
      member({ memberId: `m_${i}`, userId: `u_${i}`, roomRole: "peer_b" }));
    await store.createSession(swarmSession({ members: [member(), ...seats] }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("conflict");
    expect(r.reason).toMatch(/full/);
    expect(r.reason).toContain("100 members");
    expect(r.reason).toContain("ceiling");
  });
```

`tests/tools/handshake.test.ts` — in "reports the manifest's mode in the connect preview", add:

```ts
    // The number an agent can act on: the room's capacity, not a plan limit.
    expect((preview.data.session as { max_members: number }).max_members).toBe(100);
```

and beside it:

```ts
  it("reports a pair room's capacity as two in the connect preview", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const started = await jesse.call("bellman_start", { brief: brief(), manifest: { room: "r", preset: "pair" } });
    const preview = await peer.call("bellman_connect", { join_code: String(started.data.join_code) });
    expect(preview.isError, preview.text).toBe(false);
    expect((preview.data.session as { max_members: number }).max_members).toBe(2);
  });
```

`tests/tools/max-plan.test.ts` — the first case becomes "is a swarm that seats more members than any plan used to cap, and still has room": the loop runs `for (let n = 2; n <= 30; n++)`, the roster assertion is `toHaveLength(30)`, and the closing refusal is replaced by

```ts
    // Not full: the ceiling is 100 and it is the same on every plan.
    const more = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId });
    expect(more.isError, more.text).toBe(false);
```

Its header comment "team-sized, long-lived rooms for one person, with none of the org machinery" → "rooms for one person, with none of the org machinery; its facet is coming (#188, #189)".

`tests/auth.test.ts`:
- "raises member ceilings, TTLs and quotas monotonically by plan" → rename "raises quotas monotonically by plan"; delete the three `maxMembers` lines; its docblock: "max sells creates between pro and team; nothing else steps."
- Replace "gives max the team-sized room…" with:

```ts
  /**
   * Max is coming soon (#45, #18). With no room lifetime and no member cap, it
   * differs from pro by creates alone; hosted agents (#188, #189) are the facet
   * that will set it apart, and landing one is a deliberate edit to this line.
   */
  it("gives max nothing but creates over pro, until it has a facet", () => {
    const { monthlyCreates: maxCreates, ...maxRest } = ENTITLEMENTS.max;
    const { monthlyCreates: proCreates, ...proRest } = ENTITLEMENTS.pro;
    expect(maxRest).toEqual(proRest);
    expect(maxCreates).toBe(2000);
    expect(proCreates).toBe(500);
  });
```

- `creationOnlyFields` → `["modes", "monthlyCreates", "orgScoping", "audit"]`.

`tests/stored-session.test.ts` — in Task 4's describe, add:

```ts
  it("strips maxMembers, so capacity is the manifest's from the next read", () => {
    const { events: _events, ...raw } = session();
    const row = hydrateStoredSession({ ...raw, maxMembers: 8 })!;
    expect(row).not.toHaveProperty("maxMembers");
  });
```

`tests/store-do-wiring.test.ts` — in `describe("a current row is untouched by the guard")` (`roomManifest`, `member`, `currentRow`, `fakeStorage`, `fakeCtx` are in scope):

```ts
  it("seats past a legacy cap: a swarm row stamped maxMembers 8 holds a ninth", async () => {
    // Review Focus 5. The cap is stripped on read and capacityOf reads the mode.
    const seats = Array.from({ length: 8 }, (_, i) => member({ memberId: `m_${i}`, userId: `u_${i}`, roomRole: "peer_b" }));
    const storage = fakeStorage({
      session: { ...currentRow({ manifest: roomManifest({ mode: "swarm", preset: null }), joinCodes: {}, members: seats }), maxMembers: 8 },
      cursor: 0,
    });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    const ninth = await doi.seatMember(member({ memberId: "m_9", userId: "u_9", roomRole: "peer_b" }), 1, Date.now());

    expect(ninth.refused).toBeNull();
    expect((await doi.getSession())!.members).toHaveLength(9);
    expect(await doi.getSession()).not.toHaveProperty("maxMembers");
  });
```

`tests/oauth-flow.test.ts` — extend Task 4's case: rename it "renders the account page without a session lifetime or a member cap (#18)" and add `expect(html).not.toContain("Members per session");`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/presence.test.ts tests/store.test.ts tests/rooms.test.ts tests/tools/handshake.test.ts tests/tools/max-plan.test.ts tests/auth.test.ts tests/stored-session.test.ts tests/store-do-wiring.test.ts tests/oauth-flow.test.ts`
Expected: FAIL. `capacityOf`, `ROOM_MEMBER_CEILING`, `swarmSession` do not exist (compile errors in the files importing them); the max-plan case refuses the 26th join with "full"; the handshake preview reports 25 (jesse is team), not 100; "strips maxMembers" finds the property; the account page contains the row.

- [ ] **Step 3: Implement**

`src/store.ts`, beside `SWEEP_RPC_BUDGET` at the bottom:

```ts
/**
 * How many members one room holds, on every plan that can start a swarm (#18).
 *
 * A ceiling, not a plan fact. A room is one value in SQLite-backed Durable Object
 * storage, members and briefs included (events and surface rows are separate,
 * #25), and a value holds 2 MB. A brief at the schema's maximum (src/tools/kit.ts:
 * goal 500, state 2,000, twenty constraints and twenty open questions of 300) is
 * 14,710 characters; 100 of them are 1.47 MB, under the limit with room for the
 * manifest and the codes. 250 would be 3.7 MB. Two-byte text at the maximum in
 * every brief of a full room is the remaining gap, and the transaction turns it
 * into one failed join rather than a broken room. Reaching this is the trigger
 * for moving members to rows of their own, which is what lifts it.
 */
export const ROOM_MEMBER_CEILING = 100;

/**
 * How many members this room holds. A `pair` room holds two because the preset
 * says so; a `swarm` room holds as many as its creator invites, up to the
 * ceiling. Derived from the manifest and never stored, for the rule written on
 * the Session type: two fields for one fact could disagree.
 */
export const capacityOf = (manifest: RoomManifest): number =>
  manifest.mode === "pair" ? 2 : ROOM_MEMBER_CEILING;
```

(Add `RoomManifest` to the type import from `./types.js` if it is not there.) In `MemoryStore.seatMember`, both `seatVictims(…, s.maxMembers, …)` calls become `seatVictims(…, capacityOf(s.manifest), …)`. Same two calls in `SessionDO.seatMember` in `src/store-do.ts` (add `capacityOf` to its import from `./store.js`).

`src/types.ts`: delete `maxMembers: number;` from `Session` and from `Entitlements`; extend Task 4's comment on `Session`: "There is no `maxMembers` either: capacity is `capacityOf(manifest)`, two for a pair room and the ceiling for a swarm."

`src/auth.ts`: delete the four `maxMembers:` lines.

`src/stored-session.ts`: add `maxMembers: _cap` to the destructure and `maxMembers?: number` to the cast; the bullet becomes "- **expiresAt and maxMembers** (#18) are stripped. Rooms persist, so a missing clock is the state every row is in now, and capacity is `capacityOf(manifest)`, so a stored cap would be the stale mirror the Session type forbids. A swarm room created under an 8- or 25-member cap holds the ceiling from its next read."

`src/rooms.ts` — beside `seatedMembers` (import `ROOM_MEMBER_CEILING, capacityOf` from `./store.js` and `RoomManifest` as a type):

```ts
/**
 * Why a seat is refused, said for the room's shape. A pair room is two by its
 * preset; a swarm room is at the ceiling, which is storage and the same on every
 * plan, so the message says so rather than pointing at an upgrade that would not
 * help. Every variant keeps the word "full": clients and tests match on it.
 */
export function fullMessage(manifest: RoomManifest): string {
  return manifest.mode === "pair"
    ? "session is full (2 members — a pair room holds two). Wait for someone to leave, or start a swarm session."
    : `session is full: this room holds ${ROOM_MEMBER_CEILING} members, Bellman's ceiling for one room, the same on every plan. Wait for someone to leave, or start another room.`;
}
```

In `issueInvite`: `>= session.maxMembers` → `>= capacityOf(session.manifest)`; the refusal becomes `refuse("conflict", \`a new code could not be used: ${fullMessage(session.manifest)}\`)`.

`src/tools/start.ts`: delete `maxMembers: manifest.mode === "pair" ? 2 : ent.maxMembers,`. In `share_instructions`, "A swarm room takes more than one joiner;" → "A swarm room holds as many members as you invite, up to 100;".

`src/tools/connect.ts`: `>= session.maxMembers` → `>= capacityOf(session.manifest)` (import `capacityOf` from `../store.js`, `fullMessage` from `../rooms.js`); `fail("session is full.")` → `fail(fullMessage(session.manifest))`; `max_members: session.maxMembers` → `max_members: capacityOf(session.manifest)`. In the description, after the *Returns* line: "max_members is the room's capacity: 2 for a pair room, 100 for a swarm room — Bellman's ceiling for one room, the same on every plan, not a plan limit."

`src/tools/confirm.ts`: `return fail("session filled while you were confirming.")` → `return fail(\`session filled while you were confirming. ${fullMessage(session.manifest)}\`)` (import `fullMessage` from `../rooms.js`).

`src/oauth/routes.ts`: delete the `row("Members per session", …)` line.

- [ ] **Step 4: Typecheck, then fix every test that still names the cap, by rule**

Run: `npm run typecheck && npm run typecheck:worker`
Expected: errors at every `maxMembers` left in a test. The rules, applied per site:

1. `maxMembers: 2` in a `session({ … })` → delete the key.
2. `maxMembers: N` with `N > 2` → delete the key; then if the case goes red because the room is now full at two (a `"full"` refusal, a `conflict`, `codesCleared: true` where `false` was expected, or a member reclaimed where none was), change `session(` to `swarmSession(` for that case. Known to need `swarmSession`: in `tests/helpers/store-contract.ts` "seatMember leaves the codes alone when a seat is still spare" and "seatMember does not count a member who has left toward a full room"; in `tests/presence-sockets.test.ts` "bellman_confirm still reports a quiet member without a socket as stale"; in `tests/rooms.test.ts` every `issueInvite`/`revokeInvite` case whose room holds two active members and expects success. Known to keep `session(`: `closeSessionIfEmpty`, eviction and removal cases, where nothing asks for a seat.
3. `maxMembers: 1` is unrepresentable. `tests/helpers/store-contract.ts` "seatMember clears no codes when it refuses a $refusal room": the `full` row becomes `{ refusal: "full", over: () => ({ members: [member({ memberId: "m_creator", lastSeenAt: Date.now() }), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: Date.now() })] }) }` and the final roster assertion becomes `expect(after.members.map((m) => m.memberId), "nobody was seated").not.toContain("m_late")`. `tests/presence.test.ts` "does not close the room when it reclaims its last member": DELETE the case. Its premise is a one-seat room; `seatMember` has no close path; the contract suite's "lets exactly one of a close and a join win" pins the close/join race. Record it as a ruling.
4. Exactly-full-at-three cases become pair rooms. `tests/presence-sockets.test.ts` "bellman_confirm reports the member present and retires the codes of a full room" → members `[quiet()]` only, roster `[["m_quiet", "present"], [String(confirmed.data.member_id), "present"]]`, codes `{}`, and its "Three seats" comment becomes "Two seats: a quiet member on a socket, and the joiner". "bellman_invite refuses a room whose seats are all held by present members" → drop `m_third`; comment "creator, quiet, and a third present member in three seats" → "creator and quiet in two seats". `worker-tests/presence-sockets.test.ts`: `room(members)` loses its second parameter and its callers their second argument; "retires the codes of a room a quiet member's socket keeps full…" → both rooms are `room([quiet("m_quiet")])` (no `here`), same expected outcomes; the three-member cases keep their members and their `"full"` expectation (a pair room over-full by one, with both quiet seats on a socket, is full) and their "three-seat room" comments say "a pair room over-full by one".
5. Reads of `.maxMembers`: `tests/helpers/store-contract.ts` detach case → `read.orgOnly = true;` and `expect(fresh.orgOnly).toBe(false);`; `tests/presence.test.ts` "never overfills the room" → `toHaveLength(2)`; `tests/tools/handshake.test.ts` → `expect(capacityOf(session!.manifest)).toBe(ROOM_MEMBER_CEILING)` and `.toBe(2)` (import both from `../../src/store.js`); `tests/tools/verbs.test.ts` → `.toBeLessThan(capacityOf(before.manifest))` (import `capacityOf`).
6. `worker-tests/ws-delivery.test.ts`, `session-close-join-race.test.ts`, `removed-member-sync.test.ts`: delete the key; nothing in them seats through capacity.

Re-run the typecheck until clean, then:

Run: `npx vitest run`
Expected: PASS. Any remaining red is rule 2's second clause: switch that case to `swarmSession` and re-run.

Run: `npm run test:worker 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: a swarm room holds up to 100 on every plan; the cap leaves the types (#18)"
```

---

### Task 6: Max is coming soon, and the docs say what the code does

**Files:**
- Modify: `src/auth.ts` (the `max` comment), `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` (one clause)
- Create: `docs/adr/0001-rooms-persist.md`

**Interfaces:** none. This task has no failing test: it is prose, and Task 5's `tests/auth.test.ts` already pins D4. The control is the grep in Step 3.

- [ ] **Step 1: `src/auth.ts`, the `max` comment**

Replace the two-line comment above `max:` with:

```ts
  // Coming soon. With no room lifetime and no member cap (#18), max differs from
  // pro by creates alone, so nothing sells it: no Stripe price names it and
  // STRIPE_PAYMENT_LINKS carries no `max` entry, so /upgrade/max stays a 404. It
  // stays here because a hand grant still works and because it is the shape
  // hosted agents (#188, #189) attach their facet to. tests/auth.test.ts pins
  // the difference, so a facet landing is a deliberate edit to that line.
```

- [ ] **Step 2: README.md**

*Line 5*: "A pair room holds two; a swarm room fills to your plan's limit, and you can issue a fresh code — one per role — to add members later." → "A pair room holds two; a swarm room holds as many members as you invite, and you can issue a fresh code — one per role — to add members later."

*What a plan gates*: replace the table and add the paragraph after it:

```markdown
| | modes | rooms / month | |
| --- | --- | --- | --- |
| `free` | pair | 20 | |
| `pro` | pair, swarm | 500 | |
| `max` | pair, swarm | 2,000 | *coming soon*: hosted agents will be what sets it apart |
| `team` | pair, swarm | 5,000 | `org_only` scoping, audit trail |

A pair room holds two. A swarm room holds as many members as you invite, up to 100, a storage ceiling that is the same on every plan. Rooms persist on every plan: a room ends when its last member leaves, or after 90 days in which nobody in it was seen.
```

*Plans*: "pair sessions, 20 a month, 4 hour lifetime." → "pair sessions, 20 a month."

*When a plan lapses*, last paragraph: "That resolves itself as those sessions reach their TTL." → "Those rooms persist like any other, so a lapse will not reach them."

- [ ] **Step 3: docs/ARCHITECTURE.md, CLAUDE.md, and the grep**

By the sentence:

- ~299 "So a close, or the TTL alarm, lands between them," → "So a close, or the abandonment alarm, lands between them,"
- ~305 "also what the TTL alarm expires a room by." → "also what the abandonment alarm closes a room by."
- ~400 (diagram) "surface rows, TTL alarm," → "surface rows, abandonment alarm,"
- ~434 "used to read as full for the rest of its TTL," → "used to read as full for good,"
- ~628 (diagram) "modes, members, TTL, quota, audit" → "modes, quota, audit"
- ~839 "the two appends, the expiry, and" → "the two appends, the abandonment close, and"; ~846–850 "The expiry is the same shape … has nothing to expire." → "The abandonment close is the same shape with the room's close in place of a member's stamp: it commits the close, the registry removals its codes owe and the `session_expired` event together ([#124](../../../issues/124)). Split, an interruption after the close left a room closed with no event, and nothing wrote one afterwards, because the retry finds the room closed and has nothing to close."
- ~923–925 "`SessionDO` has three handlers, `outbox`, `ttl` and `heartbeat`, and only `outbox` is stored. The TTL is derived from `expiresAt`, so sessions written before named alarms still expire." → "`SessionDO` has three handlers, `outbox`, `abandoned` and `heartbeat`, and only `outbox` is stored. The abandonment time is derived from the members' `lastSeenAt` (`abandonedAt`, #18), so a room written before named alarms, or before rooms persisted, is still swept; a socket vouching for a member moves it a window ahead instead of closing the room."
- ~1073 and ~1075 `expireIfDue` → `closeIfAbandoned`.
- ~1164 "nothing to run and re-arms for the TTL." → "nothing to run and re-arms for the abandonment time."

`CLAUDE.md`, the *Writing* paragraph: "a `swarm` room fills to the plan's limit, codes are reissuable to add members later" → "a `swarm` room holds as many members as its creator invites, up to one ceiling for every plan, codes are reissuable to add members later".

Control:

Run: `grep -rn -i -E '\bttl\b|expiresAt|expireIfDue|sessionTtl|maxMembers|session_expires_at' src README.md CLAUDE.md docs/ARCHITECTURE.md | grep -v -i -E 'joinCode|join_code|JOIN_CODE|CONNECT_TOKEN|connect_token|PendingConnect|pending|grant|ACTION_REQUEST|rec\.expiresAt|p\.expiresAt|expires_at|code expir|codes expire|token|30 minutes'`
Expected: no output. Every line it prints is a mention this task missed; fix it and re-run.

- [ ] **Step 4: The ADR**

Create `docs/adr/0001-rooms-persist.md`:

```markdown
# ADR 0001 — Rooms persist

**Date:** 2026-10-07 · **Status:** accepted · **Closes:** #18 · **Spec:** `docs/superpowers/specs/2026-10-07-rooms-persist-design.md`

## Context

Every room died on a clock: `sessionTtlMs` per plan (4 hours to 30 days), stamped
into `Session.expiresAt` at creation and enforced by `SessionDO`'s alarm. A hub room
accumulates members over weeks, and a clock ended it in the middle of being useful.
Watching a room costs nothing now (the sockets hibernate and the object sleeps with
them), so the clock paid for nothing. `maxMembers` (2/8/25/25) was a plan fact
stamped into the room, and a persistent room capped at eight is a room somebody
has to recreate.

## Decision

1. **Rooms persist on every plan.** A room ends when its last member leaves
   (`closeSessionIfEmpty`), or after 90 days in which no active member was seen,
   by `lastSeenAt` or by a live socket. The rule is one pure predicate pair,
   `abandonedAt` / `isAbandoned`, shared by both stores' sweeps, the Durable
   Object's derived alarm and every "does this room read closed" check. The alarm
   stamps a socket's members instead of closing, so a room held open on one
   socket is never swept and the alarm never fires back to back. Frozen rooms are
   not swept; a thaw restarts the window. The `session_expired` event stays, with
   `{ reason: "abandoned", last_seen_at }`.
2. **A swarm room's size is a ceiling, not a plan.** `capacityOf(manifest)` is 2
   for `pair` and `ROOM_MEMBER_CEILING = 100` for `swarm`, on every plan that can
   start one. 100 because a room is one 2 MB stored value: 100 maximal briefs are
   1.47 MB, 250 would be 3.7 MB. `maxMembers` left `Session` rather than becoming
   `null`, for the rule on that type: two fields for one fact can disagree.
3. **Max is coming soon.** It differs from pro by `monthlyCreates` alone, stays in
   `ENTITLEMENTS` for hand grants and as the shape hosted agents (#188, #189)
   attach to, and is not sold.

## Consequences

- Rooms alive at deploy persist: `hydrateStoredSession` strips `expiresAt` and
  `maxMembers` on read, and nothing is backfilled.
- A rollback finds `now > undefined` false and `seatVictims` given `undefined`
  seats everyone: rooms neither expire nor cap, which is the direction of travel.
- Reaching the ceiling is the trigger for moving members to rows of their own.
- The site's plan copy follows in `bellman-sh/bellman.sh` (room size, FAQ, compare pages).
```

- [ ] **Step 5: Run the whole verification**

Run: `npm run verify 2>&1 | tail -30`
Expected: typecheck, worker typecheck, build, Node tests and worker tests all green.

- [ ] **Step 6: Commit**

```bash
jj commit -m "docs: rooms persist, the ceiling, and max coming soon; ADR 0001 (#18)"
```

---

### Task 7: Bookmark, push, pull request

**Files:** none.

- [ ] **Step 1: Confirm the commits are signed**

```bash
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
for c in $(jj log -r 'main..@-' --no-graph -T 'commit_id ++ "\n"'); do git cat-file commit $c | grep -c 'BEGIN SSH SIGNATURE'; done
```

Expected: eight commits (spec, plan, six tasks), one `1` per commit. A `0` means the 1Password agent was locked for that commit: unlock it and re-sign with `jj describe -r <change>` (same text), never bypass signing.

- [ ] **Step 2: Create the bookmark on the last commit and push it**

```bash
jj bookmark create mcfearsome/rooms-persist -r @-
jj git push --bookmark mcfearsome/rooms-persist --allow-new
```

Expected: the bookmark is pushed; `main` is untouched.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head mcfearsome/rooms-persist --title "Rooms persist: no clock, one ceiling, max coming soon" --body-file - <<'EOF'
Closes #18. Touches #45.

**Rooms persist on every plan.** `sessionTtlMs` and `Session.expiresAt` are gone. A room ends when its last member leaves, or after 90 days in which no active member was seen, by `lastSeenAt` or by a live socket. `abandonedAt`/`isAbandoned` are one pure rule shared by both stores' sweeps, `SessionDO`'s derived `abandoned` alarm (in the `ttl` slot, derived like it, so a rollback strands nothing) and every reader that answers "closed" without writing. When the alarm finds a socket vouching for a member it stamps those members and re-arms a window ahead instead of closing, so a room held open on one socket for a season is neither swept nor hammered. Frozen rooms are not swept; a thaw restarts the window. `session_expired` stays, with `{ reason: "abandoned", last_seen_at }`. Rows stored with `expiresAt` are stripped on read; nothing is backfilled.

**A swarm room holds up to 100 on every plan.** `maxMembers` leaves `Entitlements` and `Session`; capacity is `capacityOf(manifest)`: 2 for pair, `ROOM_MEMBER_CEILING = 100` for swarm. 100 because a room is one 2 MB stored value and 100 maximal briefs are 1.47 MB. The refusal names the ceiling, not a plan. A swarm room created under the old 8 or 25 holds 100 from its next read.

**Max is coming soon.** It now differs from pro by creates alone; it stays in `ENTITLEMENTS` for hand grants and as the shape hosted agents (#188, #189) will attach to, and nothing sells it. `tests/auth.test.ts` pins the difference.

Docs: README plan table, `docs/ARCHITECTURE.md`, `docs/adr/0001-rooms-persist.md` (the first ADR), the admin panel's two rows, tool descriptions. Site copy follows in bellman-sh/bellman.sh.

Spec: `docs/superpowers/specs/2026-10-07-rooms-persist-design.md`. Plan: `docs/superpowers/plans/2026-10-07-rooms-persist.md`.
EOF
```

Expected: a PR URL. Report it.

---

## Self-review

**Spec coverage.** D1 (clock goes: types, plans, start, hydration) → Task 4. D2 (predicates, constant, alarm name and handler, socket stamp, readers, MemoryStore mirror, payload, frozen exemption and thaw stamp, empty rooms untouched) → Tasks 1–3. D3 (ceiling, `capacityOf`, fields removed, hydration, callers, previews, refusals) → Task 5. D4 (max unsold, comment, test pin) → Tasks 5–6. D5 (README, ARCHITECTURE, ADR, admin rows, tool descriptions) → Tasks 4–6. Error-handling table: alarm with socket → Task 3; silence without socket → Tasks 2–3; read between window and alarm → Task 3 case 6; frozen → Task 2; empty → untouched, the existing `closeSessionIfEmpty` cases; swarm at 100 → Task 5; stored row carrying the fields → Tasks 4–5; rollback → the ADR records the argument, untestable here. Testing section: pure, contract, worker, wiring, tools, auth, sync-status, admin panel, all placed. The site follow-up is another repo and is noted in the PR body.

**Placeholders.** None: every step carries its code or the exact sentence. Task 5 Step 4 is a procedure with a rule rather than a list, on purpose: the compiler enumerates the sites and the rule decides each.

**Type consistency.** `abandonedAt(s: RoomRoster)` takes `Pick<Session, "closed" | "frozenAt" | "members">`, which `Session` (fixtures) and `StoredSession` both satisfy. `readsClosed(s, now, attached: Iterable<string>)`: all three callers pass `this.#attachedIds()`. `stampSeen(members, now, only?)`: the thaws call it with two arguments, the alarm and `#stampClosing` with three. `fullMessage(manifest)`: the three tools pass `session.manifest`. `swarmSession` keeps `session()`'s signature.

**Review Focus.** Each of the five has its test in the task named beside it.
