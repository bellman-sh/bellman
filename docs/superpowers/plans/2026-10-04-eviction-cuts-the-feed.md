# Eviction Cuts the Feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An evicted member stops receiving a room's new events, over the poll and over the socket, while its history stays readable.

**Architecture:** A new optional `Member.removedAtCursor` records the cursor of the `member_evicted` event that removed a member. It is written inside that append's own transaction through `AppendExtras.markRemoved`, the arrangement `creditReport` already uses. `bellman_sync` caps a cut member's slice at that cursor and does not long-poll; the `/ws` arm refuses a cut member's upgrade and closes the socket of one evicted mid-connection.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk`, Cloudflare Workers + Durable Objects, vitest (two programs: `npm test` for Node, `npm run test:worker` for workerd).

**Spec:** `docs/superpowers/specs/2026-10-04-eviction-cuts-the-feed-design.md`

## Global Constraints

- **`main` moves only through merges.** Work on a branch, land by PR. The repo is colocated with jj; a detached git HEAD is normal.
- **Run `npm run verify` before every commit.** It is typecheck + worker typecheck + build + `npm test` + `npm run test:worker`. A task is not done until it exits 0.
- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly.
- **Read and register in the same turn.** `waitForEvents` must not `await` between reading events and registering a waiter.
- **Workers-only files are excluded from the Node build** (`src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`). Anything importing `cloudflare:workers` cannot be imported by a vitest test under `tests/`; put the shape in a runtime-free module beside it.
- **A room holds many members, not two.** Never write "the other session" or "two sessions" in code, comments, docs, commit messages or PR bodies. Say *members*, *the room*, or *peers*.
- **Peer content is untrusted, everywhere.** Nothing in this plan weakens that.
- **No new tool is added**, so `extension/manifest.json` needs no edit. `tests/extension.test.ts` asserts the tool *list*, not descriptions, so the description changes in Task 3 do not touch it.
- **`tests/helpers/store-contract.ts` is the conformance suite** every `BellmanStore` implementation must pass identically. A store rule added without a contract test is incomplete.

## Review Focus

Five input classes the spec implies that no task's own happy path exercises. Each has a test assigned to the task that owns the code.

1. **An evictee polls with `since_cursor` already past its cut.** The slice is empty; the returned cursor must stay where the caller put it rather than moving backwards to the cut, or a client that round-trips it re-requests the same range forever. — Task 3.
2. **One identity, two handles, one cut.** The poll is per *handle*, the socket is per *identity*. The cut handle's `bellman_sync` must be capped even though that identity's socket survives on the live handle. — Tasks 3 and 4.
3. **An evictee rejoins on a fresh code.** R1 says they may. The new handle carries no cursor and reads everything; the old handle must stay cut. — Task 3.
4. **A socket whose attachment names a member the roster no longer holds.** `#wake` already fails closed on a missing attachment; the close pass must not throw on an unresolvable id and strand the other sockets. — Task 4.
5. **The evictee is the room's last active member.** The eviction closes the room. A cut member must still read its history out of a closed room, because `bellman_sync` has no closed guard on reads. — Task 3.

## Spec traceability

The spec is the authority. When a task's instructions and the spec disagree, the
spec wins and the disagreement is worth raising before coding — the plan is a
reading of the spec, not a replacement for it.

| Spec | What it rules | Implemented by |
|---|---|---|
| R1 | eviction cuts the feed; not a ban, not removal-only | Tasks 1–4 together |
| R2 | only a creator's eviction cuts; left and timed-out read on | T2 S1 (third test), T3 S3, T4 S1 (second test) |
| R3 | `delivered_to` keeps its value, loses its claim | T3 S7 |
| R4 | the cut includes the member's own `member_evicted` | T3 S5 (`<=`), T3 S10 (mutation) |
| D1 | a cursor on the member record, not a timestamp | T1 S3, T1 S4 |
| D2 | written inside the append's own transaction | T1 S5, T1 S6, T2 S3 |
| D3 | the rule lives in `store.ts`, applied by both stores | T1 S4, proven by T1 S1 run in both programs |
| D4 | `bellman_sync` caps and does not wait | T3 S5 |
| D5 | an evictee gets no socket and loses the one it has | T4 S3, T4 S4 |
| D6 | evicting a member who already left does NOT cut them | T2 S1 (third test) |
| D7 | nothing is filtered inside `waitForEvents` | T3 S5 — the cut arm calls `eventsAfter`; `waitForEvents` is untouched |
| D8 | the field does not leave the server | T3 S9 |

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/types.ts` | `Member.removedAtCursor?: number` | 1 |
| `src/store.ts` | the `markRemoved` rule, `isRemovedMember`, `AppendExtras.markRemoved`, `MemoryStore` applying it | 1 |
| `src/store-do.ts` | `SessionDO` applying it in the append's transaction; `membersOf` filter; closing cut sockets | 1, 4 |
| `tests/helpers/store-contract.ts` | conformance for the new rule, run against both stores | 1 |
| `src/rooms.ts` | `evictMember` folds the member write into the append | 2 |
| `src/server.ts` | `bellman_sync` caps and does not wait; three descriptions/comments | 3 |
| `tests/tools/evict.test.ts` | the headline behaviour, and the inverted old ruling | 3 |
| `worker-tests/ws-delivery.test.ts` | the socket arm, where sockets are real | 4 |

---

## Task 1: The store rule, and both stores applying it

**Files:**
- Modify: `src/types.ts` (the `Member` interface)
- Modify: `src/store.ts` (`MemberPatch`, `AppendExtras`, a new `markRemoved` and `isRemovedMember`, `MemoryStore.credit` → `MemoryStore.applyExtras`)
- Modify: `src/store-do.ts` (`reportRow` → `memberRow`, used by `appendEvent` and `appendEventOnce`)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Member.removedAtCursor?: number`
  - `isRemovedMember(m: Member): boolean`
  - `markRemoved(members: Member[], memberId: string, cursor: number, at: number): Member[] | null`
  - `AppendExtras.markRemoved?: string`

- [ ] **Step 1: Write the failing contract tests**

Add to `tests/helpers/store-contract.ts`, directly after the `describe("crediting the sender's report", ...)` block that ends near line 1395.

**The suite has no ready-made session fixture.** It builds one with `session()`
and `member()` from `tests/helpers/fixtures.ts` and then calls
`store.createSession(s)` — see the `creditReport` block's `unstamped()` for the
pattern. `member()` defaults to a single `m_creator`, so a two-member roster has
to be spelled out. `store` is the suite's existing fixture.

```ts
    describe("recording a member out at an event's cursor", () => {
      /** A creator and one peer, created in the store. */
      const roomOfTwo = async () => {
        const s = session({
          members: [
            member(),
            member({ memberId: "m_peer", userId: "u_peer", label: "peer@elsewhere" }),
          ],
        });
        await store.createSession(s);
        return s;
      };
      const TARGET = "m_peer";

      /** The eviction announcement, as evictMember writes it. */
      const removal = (memberId: string) => ({
        type: "member_evicted" as const,
        fromMemberId: "system",
        fromUserId: "u_jesse",
        fromLabel: "jesse",
        payload: { member_id: memberId },
        refId: null,
      });

      it("sets leftAt and removedAtCursor together, at the event's own cursor", async () => {
        const s = await roomOfTwo();
        const target = TARGET;

        const event = (await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        }))!;

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        // One write, not two: a store that set only one of these is the bug
        // this rides in the transaction to prevent.
        expect(m.removedAtCursor).toBe(event.cursor);
        expect(m.leftAt).not.toBeNull();
      });

      it("leaves every other member untouched", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const other = "m_creator";

        await store.appendEvent(s.id, removal(target), { markRemoved: target });

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === other)!;
        expect(m.removedAtCursor).toBeUndefined();
        expect(m.leftAt).toBeNull();
      });

      it("writes nothing for a member the roster does not name", async () => {
        const s = await roomOfTwo();
        const before = (await store.getSession(s.id))!;

        const event = await store.appendEvent(s.id, removal("m_nobody"), {
          markRemoved: "m_nobody",
        });

        // The event still lands. An unknown member is a no-op, not a throw —
        // updateMember's rule, and creditReport's.
        expect(event).not.toBeNull();
        const after = (await store.getSession(s.id))!;
        expect(after.members.map((m) => m.removedAtCursor))
          .toEqual(before.members.map((m) => m.removedAtCursor));
      });

      it("does not move a cut that is already recorded", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const first = (await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        }))!;

        await store.appendEvent(s.id, removal(target), { markRemoved: target });

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        // Otherwise a second eviction widens the window the first one closed.
        expect(m.removedAtCursor).toBe(first.cursor);
      });

      it("records nothing when the room is frozen and the append is refused", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        await store.freezeSession(s.id, Date.now());

        const event = await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        });

        // The two go together or the design's atomicity claim is false.
        expect(event).toBeNull();
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBeUndefined();
        expect(m.leftAt).toBeNull();
      });

      it("records the member out on a keyed append too", async () => {
        const s = await roomOfTwo();
        const target = TARGET;

        const write = await store.appendEventOnce(
          s.id, removal(target), "evict-0001", { markRemoved: target },
        );

        expect(write.outcome).toBe("appended");
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBe(write.outcome === "appended" ? write.event.cursor : -1);
      });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/store.test.ts tests/store-do.test.ts
```

Expected: FAIL. TypeScript rejects `markRemoved` on `AppendExtras` ("Object literal may only specify known properties"), and `removedAtCursor` is not a property of `Member`. Fix nothing else until the failures are about behaviour.

- [ ] **Step 3: Add the field to `Member`**

In `src/types.ts`, after `lastReportAt`:

```ts
  /**
   * The cursor of the `member_evicted` event that removed this member, if a
   * creator removed them.
   *
   * Absent on a member still in the room, on one who left of their own accord,
   * on one whose seat timed out, and on every row stored before this field
   * existed — all of which keep the open feed (#113). Absence IS the answer
   * here, so there is no lifting accessor as `lastSeenAt` and `lastReportAt`
   * have: for those, reading `undefined` as "never" would have been actively
   * wrong, and every legacy row would have read as reclaimable.
   */
  removedAtCursor?: number;
```

- [ ] **Step 4: Add the rule to `src/store.ts`**

Beside `creditReport`, which this follows exactly. `MemberPatch` gains a comment rather than the field:

```ts
/** Fields of a Member that may change after it is created. */
export type MemberPatch = Partial<
  Pick<Member, "brief" | "capabilities" | "leftAt" | "lastSeenAt" | "lastReportAt">
>;
// `removedAtCursor` is deliberately absent. It is the append's to write, inside
// the transaction that stores the event it names (#113), and a patch route
// would be a second way to write it — one that could set a cursor no event has.
```

```ts
/** Whether a creator removed this member, so its feed is cut (#113). */
export const isRemovedMember = (m: Member): boolean => m.removedAtCursor !== undefined;

/**
 * Record `memberId` out at `cursor`, returning the new roster or `null` when
 * there is nothing to write.
 *
 * Sets `leftAt` AND `removedAtCursor` in one go, because they are one write:
 * folded into the append's transaction, a failure leaves the member in rather
 * than half out. `creditReport` above carries the argument for why a member
 * write that must agree with an event belongs in the event's own transaction.
 *
 * `null` for a member the roster does not name — `updateMember`'s rule, an
 * unknown member is a no-op and not a throw — and `null` for one already
 * carrying a cursor. The second is not merely an optimisation: without it a
 * creator evicting the same member twice would move the cut forward and widen
 * the window the first eviction closed.
 *
 * Here beside `creditReport` and `isActiveMember`, and the direction is theirs:
 * this is applied INSIDE both stores, so it can live in neither.
 */
export function markRemoved(
  members: Member[],
  memberId: string,
  cursor: number,
  at: number,
): Member[] | null {
  const i = members.findIndex((m) => m.memberId === memberId);
  if (i < 0) return null;
  if (members[i].removedAtCursor !== undefined) return null;
  const next = [...members];
  next[i] = { ...next[i], leftAt: at, removedAtCursor: cursor };
  return next;
}
```

And `AppendExtras`:

```ts
export interface AppendExtras {
  creditReport?: boolean;
  /**
   * Record this member out at the event's own cursor, in the event's own
   * transaction. `evictMember` passes it on the `member_evicted` append; see
   * `markRemoved` for why the two writes cannot be separated (#113).
   */
  markRemoved?: string;
}
```

- [ ] **Step 5: Apply it in `MemoryStore`**

Rename `credit` to `applyExtras` and widen it. Both `appendEvent` and `appendEventOnce` already call `this.credit(s, e.fromMemberId, event.at, extras)`; they become `this.applyExtras(s, event, extras)`. There are **three** call sites — two in `appendEventOnce` (the replay arm and the append arm) and one in `appendEvent`.

```ts
  /**
   * Apply an append's `extras`, if it asked for any. Both rules live in this
   * module and are shared with `SessionDO`, so the two stores cannot disagree
   * about when a member write rides an append.
   *
   * One method rather than two, because both rules rewrite the same member
   * array: applied separately, the second would read `s.members` from before
   * the first and discard it.
   *
   * No awaits, for appendEvent's reason above.
   */
  private applyExtras(s: Session, event: SessionEvent, extras: AppendExtras): void {
    let members = s.members;
    if (extras.creditReport) {
      members = creditReport(members, event.fromMemberId, event.at) ?? members;
    }
    if (extras.markRemoved !== undefined) {
      members = markRemoved(members, extras.markRemoved, event.cursor, event.at) ?? members;
    }
    if (members !== s.members) s.members = members;
  }
```

Note for the replay arm in `appendEventOnce`: it currently passes `original.at`. It now passes `original` itself, so `markRemoved` sees the original event's cursor — a replay re-asserts the same cut, which `markRemoved` answers `null` to. Change that call to `this.applyExtras(s, original, extras)`.

Add `markRemoved` to the import list at the top of the file if the module does not already name it locally (it is defined in this same file, so no import is needed — check before adding one).

- [ ] **Step 6: Apply it in `SessionDO`**

Replace `reportRow` with one builder that composes both rules, so neither can clobber the other's `session` row:

```ts
/**
 * The extra storage rows an append owes, as one put.
 *
 * One function for both rules, and one `session` row: written as two builders
 * each returning `{ session: ... }`, the second would overwrite the first's
 * member array and silently drop its write.
 *
 * A free function and not a method on the class, for `reportRow`'s reason: a
 * Durable Object answers RPC for every method on its class, so a writing helper
 * reachable from outside would let a plain stub forge one of these into any
 * room. The rules it applies (`creditReport`, `markRemoved`) are shared with
 * MemoryStore and belong to neither store.
 */
function memberRow(
  s: StoredSession,
  event: SessionEvent,
  extras: AppendExtras,
): Record<string, unknown> {
  let members = s.members;
  if (extras.creditReport) {
    members = creditReport(members, event.fromMemberId, event.at) ?? members;
  }
  if (extras.markRemoved !== undefined) {
    members = markRemoved(members, extras.markRemoved, event.cursor, event.at) ?? members;
  }
  return members === s.members ? {} : { session: { ...s, members } };
}
```

Import `markRemoved` from `./store.js`, alongside the existing `creditReport`.

In `appendEvent`, the write becomes:

```ts
      const next: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      await this.#writeEvent(txn, next, memberRow(s, next, extras));
      return next;
```

Do the same at every `reportRow` call site in `appendEventOnce`. Search for `reportRow` and leave none behind.

Extend `appendEvent`'s docblock, which currently explains `creditReport` riding in the same put, to say the same of `markRemoved`:

```
   * **`extras.markRemoved` rides in that same put, for the same reason.** The
   * cut a member's feed is capped at has to commit with the event whose cursor
   * it names, or a reader can be refused at a cursor no stored event carries,
   * or admitted past one that is already written (#113).
```

- [ ] **Step 7: Run the contract tests to verify they pass**

```bash
npx vitest run tests/store.test.ts tests/store-do.test.ts
npm run test:worker
```

Expected: PASS in both programs. The worker run proves `SessionDO` answers the same contract as `MemoryStore`.

- [ ] **Step 8: Prove the tests can fail**

Make each break on purpose and confirm the named test goes red, then revert:

| Mutation | Must redden |
|---|---|
| `markRemoved` returns `next` without setting `leftAt` | "sets leftAt and removedAtCursor together" |
| drop the `removedAtCursor !== undefined` early return | "does not move a cut that is already recorded" |
| in `memberRow`, return `{ session: { ...s } }` ignoring `members` | every test in the block |
| apply the two rules as two separate `session` rows | a combined `creditReport` + `markRemoved` append (add one if no test covers it) |

A mutation that reddens nothing means the test is decoration — fix the test, not the mutation.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add src/types.ts src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git commit -m "Record a removed member's cut cursor in the append's transaction (#113)"
```

---

## Task 2: `evictMember` folds the member write into the append

**Files:**
- Modify: `src/rooms.ts` (`evictMember`, the live-removal path near the `member_evicted` append)
- Test: `tests/rooms.test.ts`

**Interfaces:**
- Consumes: `AppendExtras.markRemoved` from Task 1.
- Produces: no new exports. `evictMember`'s `RoomResult` now refuses `"frozen"` where it used to succeed after a mid-operation freeze.

- [ ] **Step 1: Write the failing tests**

Add to `tests/rooms.test.ts`, following its existing store-and-identity fixtures:

```ts
  it("records the evicted member out at the announcement's own cursor", async () => {
    const { store, creator, session, target } = await roomWithThree();

    const out = await evictMember(store, creator, session.id, target.memberId);
    expect(out.ok).toBe(true);

    const after = (await store.getSession(session.id))!;
    const m = after.members.find((mm) => mm.memberId === target.memberId)!;
    const announcement = (await store.eventsAfter(session.id, 0))
      .filter((e) => e.type === "member_evicted")
      .at(-1)!;
    // The cut names the event that announced it, so an evictee's last readable
    // event is the one telling them why (#113 R4).
    expect(m.removedAtCursor).toBe(announcement.cursor);
  });

  it("leaves the member in, not half out, when the append is refused", async () => {
    const { store, creator, session, target } = await roomWithThree();
    // Freeze between the guard's read and the append — the gap the old
    // ordering resolved by leaving the member out and unannounced.
    await store.freezeSession(session.id, Date.now());

    const out = await evictMember(store, creator, session.id, target.memberId);

    expect(out.ok).toBe(false);
    const after = (await store.getSession(session.id))!;
    const m = after.members.find((mm) => mm.memberId === target.memberId)!;
    // Consistent either way: in with no cut, or out with one. Never out
    // without a cut, which is the state that leaves the feed open.
    expect(m.leftAt).toBeNull();
    expect(m.removedAtCursor).toBeUndefined();
  });

  it("does not record a cut for a member who already left", async () => {
    const { store, creator, session, target, targetIdentity } = await roomWithThree();
    await leaveRoom(store, targetIdentity, session.id, target.memberId);

    const out = await evictMember(store, creator, session.id, target.memberId);
    expect(out.ok).toBe(true);

    const after = (await store.getSession(session.id))!;
    const m = after.members.find((mm) => mm.memberId === target.memberId)!;
    // Spec D6: the cut rides the announcement, and the early return writes
    // none. A voluntary leaver keeps the open feed (R2); the late eviction is
    // about the door, not their reading.
    expect(m.removedAtCursor).toBeUndefined();
  });
```

If `roomWithThree` does not exist in that file, write it from the existing helpers there: a swarm room with a creator and two joiners, returning `{ store, creator, session, target, targetIdentity }`. Do not invent a fixture module.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/rooms.test.ts
```

Expected: FAIL. The first on `removedAtCursor` being `undefined`; the second on `out.ok` being `true` and `leftAt` set. The third should already PASS — it pins D6, which the early return gives for free, and it is here so a later change cannot take it away silently.

- [ ] **Step 3: Replace the two writes with one append**

In `evictMember`, the live-removal path currently reads:

```ts
  if (live) await store.consumeJoinCode(sessionId, target.roomRole);

  await store.updateMember(sessionId, targetMemberId, { leftAt: Date.now() });

  await store.appendEvent(sessionId, {
    type: "member_evicted",
    // ...
  });
```

It becomes:

```ts
  if (live) await store.consumeJoinCode(sessionId, target.roomRole);

  // The door still shuts first, for the reason written above it: the other
  // ordering leaves a door open behind someone who believes it shut.
  //
  // One append, where this was an updateMember followed by an appendEvent. The
  // member write rides the announcement's transaction (#113), because the cut
  // a reader is capped at names this event's cursor and the two cannot be
  // allowed to disagree — a cut naming a cursor no event carries, or a member
  // recorded out with no cut at all, which is the open feed this closes.
  //
  // So a refusal here means the member is still IN, where it used to mean they
  // were out and unannounced. That is the more recoverable of the two: a retry
  // finds `leftAt` still null and performs the whole eviction, announcement
  // included. The frozen case is the one that reaches it — the guard above
  // refuses a room already frozen, so this is a freeze landing in the gap.
  const announced = await store.appendEvent(sessionId, {
    type: "member_evicted",
    // No member handle to name: creator authority is on the user, and a
    // creator who has left the room still holds it. "system" is the existing
    // marker for a server-originated event; the creator is in fromUserId.
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { member_id: targetMemberId, label: target.label, room_role: target.roomRole },
    refId: null,
  }, { markRemoved: targetMemberId });
  if (!announced) return refuse("frozen", FROZEN);
```

The `announceDoorShut` call and everything after it stay as they are.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/rooms.test.ts tests/tools/evict.test.ts
```

Expected: `tests/rooms.test.ts` PASSES. `tests/tools/evict.test.ts` may now fail on the test named `"keeps returning new events to them, including what is said after"` — leave it failing; Task 3 owns it. If any *other* evict test fails, stop and read it: the eviction's observable behaviour should not have changed yet.

- [ ] **Step 5: Prove the frozen test can fail**

Revert the `if (!announced) return refuse(...)` line and confirm "leaves the member in, not half out" goes red. Restore it.

- [ ] **Step 6: Commit**

```bash
npm run verify
```

`npm run verify` will fail on the one evict test Task 3 owns. That is expected at this point in the plan and is the only acceptable failure; commit anyway so the task boundary is reviewable, and note it in the commit message.

```bash
git add src/rooms.ts tests/rooms.test.ts
git commit -m "Evict in one append, so the member write and its cut commit together (#113)

tests/tools/evict.test.ts still pins the open feed, which the next commit
reverses. verify is red on that one test and no other."
```

---

## Task 3: `bellman_sync` caps, and does not wait

**Files:**
- Modify: `src/server.ts` (the `bellman_sync` handler; `bellman_sync`'s description and `readOnlyHint` comment; `bellman_evict`'s description; the `delivered_to` comment)
- Test: `tests/tools/evict.test.ts`

**Interfaces:**
- Consumes: `Member.removedAtCursor` from Task 1, written by Task 2.
- Produces: no new exports.

- [ ] **Step 1: Invert the test that pins the old ruling**

`tests/tools/evict.test.ts` has a `describe("what the person removed keeps", ...)` whose first test is `"keeps returning new events to them, including what is said after"`. Its own comment above the block says the promises are "pinned by what happens rather than by the words, so whoever changes the behaviour has to come back and change the sentence". That is this task.

Replace that one test with the two below, and leave the rest of the block alone:

```ts
    it("stops returning new events to them, while the history stays theirs", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      expect(out.isError, out.text).toBe(false);

      const sent = await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "said after you were removed" },
      });
      expect(sent.isError, sent.text).toBe(false);

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: third.cursor,
        wait_seconds: 0,
      });
      expect(synced.isError, synced.text).toBe(false);
      const said = envelopes(synced.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message")
        .map((d) => d.payload.text);
      // The room went on talking; none of it reaches them.
      expect(said).toEqual([]);

      // The history is still theirs, including the event that removed them —
      // so the feed itself says why it stopped (#113 R4).
      const history = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: 0,
        wait_seconds: 0,
      });
      expect(history.isError, history.text).toBe(false);
      const kinds = envelopes(history.data.events).map((e) => (e.data as { type: string }).type);
      expect(kinds).toContain("member_evicted");
      expect(kinds).not.toContain("message");
    });

    it("does not hold their long poll open, because there is nothing coming", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });

      const t0 = Date.now();
      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: third.cursor,
        wait_seconds: 10,
      });
      const waited = Date.now() - t0;

      expect(synced.isError, synced.text).toBe(false);
      // A cut member that still waited would wake on every append it then
      // hides — a busy loop against a room it cannot read.
      expect(waited).toBeLessThan(1_000);
    });
```

- [ ] **Step 2: Add the four Review Focus tests**

Same file, same `describe` block. These are the input classes the happy path does not reach.

```ts
    // Review Focus 1.
    it("does not move their cursor backwards when they ask from past the cut", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "well past their cut" },
      });

      const ahead = 9_999;
      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: ahead,
        wait_seconds: 0,
      });

      expect(synced.isError, synced.text).toBe(false);
      expect(synced.data.events).toEqual([]);
      // Capping the RETURNED cursor to the cut would make a client that
      // round-trips it re-request the same empty range forever.
      expect(synced.data.cursor).toBe(ahead);
    });

    // Review Focus 3.
    it("cuts the old handle only: a fresh code reads the room again", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "after the removal" },
      });

      // No `role`, and the field is `join_code` — both match the `joinThird`
      // helper at the top of this file. The swarm preset's roles are lead,
      // helper and observer; there is no "member" role to ask for.
      const invited = await s.creator.call("bellman_invite", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      expect(invited.isError, invited.text).toBe(false);
      const rejoined = await join(third.peer, invited.data.join_code);
      expect(rejoined.isError, rejoined.text).toBe(false);

      const fresh = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: String(rejoined.data.member_id),
        since_cursor: 0,
        wait_seconds: 0,
      });
      const freshKinds = envelopes(fresh.data.events).map((e) => (e.data as { type: string }).type);
      expect(freshKinds).toContain("message");

      // The cut is on the handle, not the person. R1: removal is not a ban.
      const old = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: third.cursor,
        wait_seconds: 0,
      });
      expect(envelopes(old.data.events)
        .map((e) => (e.data as { type: string }).type)
        .filter((t) => t === "message")).toEqual([]);
    });

    // Review Focus 2, the poll half. The socket half is Task 4.
    it("caps the cut handle while the same person's live handle reads on", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const first = await joinThird(s);
      // joinThird connects DEV_KEY.outsider every time, and one bearer key is
      // one userId — so a second call gives the SAME identity a second member
      // handle, which is exactly the input this test needs.
      const second = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: first.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "to whoever is left" },
      });

      const onCut = await first.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: first.memberId,
        since_cursor: first.cursor, wait_seconds: 0,
      });
      const onLive = await first.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: second.memberId,
        since_cursor: second.cursor, wait_seconds: 0,
      });

      const texts = (r: typeof onCut) => envelopes(r.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message").map((d) => d.payload.text);
      expect(texts(onCut)).toEqual([]);
      expect(texts(onLive)).toEqual(["to whoever is left"]);
    });

    // Review Focus 5.
    it("still serves their history after the removal closed the room", async () => {
      // A pair room: removing the only joiner leaves nobody active, which
      // closes the room. bellman_sync has no closed guard on reads.
      const s = await pairUp(h);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });

      const history = await s.joiner.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
        since_cursor: 0,
        wait_seconds: 0,
      });

      expect(history.isError, history.text).toBe(false);
      expect(envelopes(history.data.events).length).toBeGreaterThan(0);
      expect(history.data.session_status).toBe("closed");
    });
```

**No new helper is needed.** `joinThird` connects `DEV_KEY.outsider` and joins
on a fresh invite, so calling it twice seats two handles for one identity —
`u_outsider`. That premise is what makes the test meaningful, and it is pinned
where it is natural to pin: Task 4's `membersOf` test reads `userId` directly.
Do not add a helper, a tool or a fixture module here.

A swarm room created by `DEV_KEY.jesse` (team plan) holds 25 members — see the
entitlement table in `src/auth.ts` — so seating four is within capacity.

- [ ] **Step 3: Add the two R2 guard tests**

These keep the fix from widening into what R2 rejects. Put them in the same block.

```ts
    it("leaves a member who LEFT reading the room, feed and all", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await third.peer.call("bellman_leave", {
        session_id: s.sessionId, member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
        type: "message", payload: { text: "after they left of their own accord" },
      });

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: third.cursor, wait_seconds: 0,
      });
      // R2: leaving is a choice, and the open feed is deliberate there.
      expect(envelopes(synced.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message")
        .map((d) => d.payload.text)).toEqual(["after they left of their own accord"]);
    });
```

For the timed-out half of R2, pin it at the source rather than rebuilding the reclaim machinery here:

```bash
grep -n "member_timed_out" src/rooms.ts
```

That `appendEvent` must carry **no** `markRemoved`. Add a one-line comment there saying why (R2), so the next person does not add one for symmetry. Then check whether `tests/presence.test.ts` already reclaims a seat; if it does, add an assertion there that the reclaimed member's `removedAtCursor` is `undefined`.

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npx vitest run tests/tools/evict.test.ts
```

Expected: the new "stops returning new events" FAILS with `said` equal to `["said after you were removed"]` — the bug, reproduced through the real handlers. "does not hold their long poll open" FAILS on the elapsed time. The Review Focus tests fail on the same cause. "leaves a member who LEFT reading the room" should already PASS.

- [ ] **Step 5: Cap the slice in `bellman_sync`**

In `src/server.ts`, the handler currently reads:

```ts
      await touchMember(s, session, me);

      const all = await s.waitForEvents(session_id, since_cursor, wait_seconds * 1000);
      const cursor = all.length > 0 ? all[all.length - 1].cursor : since_cursor;
```

It becomes:

```ts
      await touchMember(s, session, me);

      // A member a creator removed reads its history and nothing after it
      // (#113). The cut is the cursor of the `member_evicted` event that
      // removed them, and the comparison is `<=` so that event is the last
      // thing they receive: the feed says why it stopped.
      //
      // Only an eviction cuts. A member who left of their own accord, and one
      // whose seat timed out, both read on — the first chose to go, and the
      // second is the server guessing, not a decision that they should be out.
      //
      // `wait_seconds` is ignored on this arm, and that is not an
      // optimisation. A cut member that still long-polled would wake on every
      // append it then hides, turning a 25-second poll into a busy loop
      // against a room it cannot read. There is nothing coming: its feed has a
      // last event and that event is in the past.
      const cut = me.removedAtCursor;
      const all = cut === undefined
        ? await s.waitForEvents(session_id, since_cursor, wait_seconds * 1000)
        : (await s.eventsAfter(session_id, since_cursor)).filter((e) => e.cursor <= cut);
      // `since_cursor` and not the cut when the slice is empty: a caller that
      // asked from past its cut gets its own cursor back, so round-tripping it
      // stays put instead of re-requesting the same empty range forever.
      const cursor = all.length > 0 ? all[all.length - 1].cursor : since_cursor;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/tools/evict.test.ts
npm test
```

Expected: PASS. Run the whole Node suite, not just this file — `tests/tools/exchange.test.ts` and `tests/presence.test.ts` both drive `bellman_sync` and either would catch a cap that fired on the wrong members.

- [ ] **Step 7: Correct the three descriptions and the comment**

**`bellman_evict`'s description** — the paragraph beginning "Reads stay open to the person removed" now promises the behaviour this removes. Replace it:

```
The history stays readable to the person removed: it was theirs too, and their bellman_sync keeps returning it, including the member_evicted event that removed them. What stops is everything after: new events do not reach them, their next bellman_send is refused, and a room socket is refused too. Rejoining on a live code gives them a fresh handle that reads the room again.
```

**`bellman_sync`'s description and its `readOnlyHint` comment** — the comment lists who reads stay open to ("a closed room, a frozen one, and a member who has left"). Add the exception:

```
        // ... and a member who has left. A member a creator REMOVED reads its
        // history and nothing after it (#113), which is still a read: this
        // tool cannot remove anybody or change what any other caller sees.
```

**`delivered_to`'s comment** (R3) — it claims the field answers who can read:

```ts
        // The members active NOW, not the ones active when this was first
        // appended, and no history is kept to do better.
        //
        // It does NOT answer who can read this, and used to say it did. A
        // member who left of their own accord goes on reading the room and is
        // not listed here (#113 R3). The two predicates are different on
        // purpose: this one answers who is in the room.
```

- [ ] **Step 8: Pin the descriptions**

The existing block already has `it("names both of its effects", ...)` reading the live tool description. Add beside it:

```ts
    it("no longer promises the person removed the room's new events", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_evict")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("The history stays readable to the person removed");
      expect(doc).toContain("new events do not reach them");
      // The sentence #112 shipped. It was true then and is false now.
      expect(doc).not.toContain("keeps returning new events");
      expect(doc).not.toContain("removal does not keep later messages from them");
    });
```

Update the `describe` block's own name and the file's top docblock, both of which state the old behaviour. The file header currently reads "Reads stay open to the person removed — the history was theirs too — so what changes is writing, and the room's roster." Make it say that the history stays open and the feed stops.

- [ ] **Step 9: Pin that the cut cursor does not leave the server (spec D8)**

`storedMember` builds its object field by field rather than spreading the
member, so `removedAtCursor` cannot reach `publicMember` or the
`member_joined` payload today. That is exactly the kind of guarantee a later
refactor to `{ ...m }` removes without anyone noticing, so it gets a test.

```ts
    it("does not tell the room which cursor cut a member", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId, member_id: third.memberId,
      });

      // Every surface that ships a member: the live roster, and the stored
      // member inside the member_joined payload that gets replayed.
      const roster = await s.creator.call("bellman_whoami", {});
      const history = await s.creator.call("bellman_sync", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
        since_cursor: 0, wait_seconds: 0,
      });

      const serialized = JSON.stringify([roster.data, history.data]);
      // The point is not secrecy for its own sake: the roster already says a
      // member is departed. It is that no client needs the exact cursor at
      // which another member stopped being able to read (#113 D8).
      expect(serialized).not.toContain("removedAtCursor");
      expect(serialized).not.toContain("removed_at_cursor");
    });
```

If `bellman_whoami` does not return a roster, use whichever call in this file
already reads one — `bellman_connect`'s preview or `bellman_confirm`'s result
both carry `publicMember` output. Do not add a tool to make the test work.

- [ ] **Step 10: Prove the headline test can fail**

Revert the `cut === undefined` branch to the unconditional `waitForEvents` and confirm "stops returning new events to them" goes red with the old text in `said`. Restore it. Then set the comparison to `e.cursor < cut` and confirm the history assertion goes red on the missing `member_evicted` — that is R4's test earning its place.

- [ ] **Step 11: Verify and commit**

```bash
npm run verify
git add src/server.ts tests/tools/evict.test.ts
git commit -m "Cut an evicted member's feed at the removal, and stop long-polling it (#113)"
```

`npm run verify` must exit 0 here. Task 2's known-red test is the one this task fixed.

---

## Task 4: The socket arm

**Files:**
- Modify: `src/store-do.ts` (`membersOf`; a socket-closing pass after `#wake`)
- Test: `worker-tests/ws-delivery.test.ts`

**Interfaces:**
- Consumes: `isRemovedMember` and `AppendExtras.markRemoved` from Task 1.
- Produces: no new exports. `membersOf`'s return shape is unchanged; its `memberIds` no longer names cut members.

- [ ] **Step 1: Write the failing tests**

`worker-tests/ws-delivery.test.ts` already drives real sockets against a real `SessionDO`. Follow its existing setup for making a session and opening a socket; do not invent a harness.

```ts
  it("refuses a /ws upgrade to a member a creator removed", async () => {
    // membersOf drops cut members, so the identity owns no member here and
    // the Worker's existing memberIds.length === 0 arm answers 403.
    const { stub, sessionId, target } = await roomWithASocketMember();
    await evictThrough(stub, sessionId, target.memberId);

    const { memberIds } = await stub.membersOf(target.userId);
    expect(memberIds).toEqual([]);
  });

  it("still names a member who left of their own accord", async () => {
    const { stub, sessionId, target } = await roomWithASocketMember();
    await stub.updateMember(sessionId, target.memberId, { leftAt: Date.now() });

    const { memberIds } = await stub.membersOf(target.userId);
    // R2: a voluntary leaver keeps the open feed, so it keeps its socket. The
    // filter is on removedAtCursor and NOT on isActiveMember, which this pins.
    expect(memberIds).toEqual([target.memberId]);
  });

  it("closes a socket open at the moment of the eviction, after the frame", async () => {
    const { stub, sessionId, target, socket, frames } = await roomWithASocketMember();

    await evictThrough(stub, sessionId, target.memberId);

    // The last thing they receive is the notice that removed them.
    expect(frames.map((f) => JSON.parse(f).type)).toContain("member_evicted");
    expect([2, 3]).toContain(socket.readyState); // CLOSING, CLOSED
  });

  it("leaves the socket open when the same identity still holds a live handle", async () => {
    const { stub, sessionId, target, second, socket } = await roomWithTwoHandles();
    await evictThrough(stub, sessionId, target.memberId);

    // Review Focus 2, socket half: the socket is per identity, and one live
    // handle entitles it.
    expect(socket.readyState).not.toBe(3);
    const { memberIds } = await stub.membersOf(target.userId);
    expect(memberIds).toEqual([second.memberId]);
  });

  it("does not strand other sockets on an attachment it cannot resolve", async () => {
    // Review Focus 4: a socket whose attachment names a member the roster no
    // longer holds must be skipped, not thrown on.
    const { stub, sessionId, target, otherSocket } = await roomWithAStaleAttachment();
    await evictThrough(stub, sessionId, target.memberId);

    expect(otherSocket.readyState).not.toBe(3);
  });
```

Write `roomWithASocketMember`, `roomWithTwoHandles`, `roomWithAStaleAttachment`
and `evictThrough` from the file's existing helpers.

**Two layers, and this file already uses both.** `evictThrough` appends through
the **store wrapper** — `store.appendEvent(sessionId, event, { markRemoved })`,
as that file's existing setup does — because `SessionDO.appendEvent` takes no
`sessionId`; only the wrapper does. `membersOf` is read off the **DO stub**,
obtained the way the file already obtains one:

```ts
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await store.appendEvent(sessionId, removalEvent(target.memberId), {
      markRemoved: target.memberId,
    });
    const { memberIds } = await stub.membersOf(target.userId);
```

The `2`/`3` readyState literals match how `store-do.ts` justifies them over
`WebSocket.CLOSING`/`CLOSED` — the program may have either WebSocket global.

**Do not change this file's teardown.** It is `evictAllDurableObjects()`, not
`abortAllDurableObjects()`, and its header explains at length why: abort closes
every accepted socket, so a test asserting a socket is still OPEN would pass or
fail on the teardown rather than on the code under test.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:worker
```

Expected: FAIL. The first on `memberIds` naming the cut member; the third on the socket still reading OPEN.

- [ ] **Step 3: Filter `membersOf`**

```ts
  async membersOf(userId: string): Promise<{ memberIds: string[]; closed: boolean }> {
    const s = await this.stored();
    if (!s) return { memberIds: [], closed: true };
    return {
      // Cut members are left out, so an identity that owns only removed
      // handles here reaches the Worker's `memberIds.length === 0` arm and is
      // answered 403 (#113). The socket is the room's future and a removed
      // member has none; its history is served by bellman_sync.
      //
      // Filtered on `isRemovedMember` and NOT on `isActiveMember`: a member
      // who left of their own accord, and one whose seat timed out, both keep
      // the open feed, and both have `leftAt` set.
      memberIds: s.members
        .filter((m) => m.userId === userId && !isRemovedMember(m))
        .map((m) => m.memberId),
      closed: s.closed || Date.now() > s.expiresAt,
    };
  }
```

Import `isRemovedMember` from `./store.js`.

- [ ] **Step 4: Close the sockets of a member just cut**

In `appendEvent`, after the existing wake:

```ts
    if (event) this.#wake(event);
    // After the wake, so the member removed receives the frame announcing it
    // before the socket goes. The notice is the last thing they get.
    if (event && extras.markRemoved !== undefined) await this.#closeCutSockets();
    return event;
```

And the method:

```ts
  /**
   * Close every socket whose attachment names only members a creator removed.
   *
   * `#private` for `#wake`'s reason: a Durable Object answers RPC for every
   * method on its class, so a reachable version would let any caller holding
   * the SESSION binding close a room's sockets.
   *
   * Run after an append that carried `markRemoved`, and only then — it reads
   * the roster, which is a storage read this must not pay on every append.
   *
   * A socket survives if ANY member it names is still uncut: the socket is per
   * identity and one live handle entitles it (#113). An attachment naming a
   * member the roster does not hold counts as neither — it cannot entitle the
   * socket and it cannot condemn it, so such a socket is left alone, which is
   * the same direction `#wake` fails in on a missing attachment.
   */
  async #closeCutSockets(): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const cut = new Set(s.members.filter(isRemovedMember).map((m) => m.memberId));
    const known = new Set(s.members.map((m) => m.memberId));
    for (const ws of this.ctx.getWebSockets()) {
      // One socket must not starve the rest, for the reason #wake gives: a
      // throw here would leave every later socket unclosed.
      try {
        if (!isOpen(ws)) continue;
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (!att || att.memberIds.length === 0) continue;
        const named = att.memberIds.filter((id) => known.has(id));
        if (named.length === 0 || named.some((id) => !cut.has(id))) continue;
        // Within 123 bytes of UTF-8: ws.close() throws above that and the
        // throw leaves the socket open, so enforcement would become an
        // exception. The reason is what a developer reads in their client.
        ws.close(1008, "You were removed from this room. Its history is still readable over /mcp.");
      } catch (err) {
        console.error("closing a removed member's socket failed:", err);
      }
    }
  }
```

Check the close reason's byte length before committing:

```bash
node -e 'const r="You were removed from this room. Its history is still readable over /mcp.";console.log(Buffer.byteLength(r,"utf8"))'
```

It must be ≤ 123. Shorten it if not.

- [ ] **Step 5: Update the `SocketAttachment` docblock**

It currently says: "What else could read it is what has to find a socket by member, the use in view being to close the sockets of a member who has left. Nothing does that yet." Something does now:

```
 * `#closeCutSockets` is what reads it that way: on an eviction it finds the
 * sockets naming only members a creator removed and closes them (#113). A
 * member who merely left keeps its socket, so "has left" is not the predicate
 * — "was removed" is.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:worker
```

Expected: PASS, including `worker-tests/presence-sockets.test.ts`, which reads the same attachment. A `membersOf` filter that caught too much would show up there as a member losing its seat.

- [ ] **Step 7: Prove the tests can fail**

| Mutation | Must redden |
|---|---|
| filter `membersOf` on `isActiveMember` instead | "still names a member who left of their own accord" |
| call `#closeCutSockets` before `#wake` | "closes a socket open at the moment of the eviction, after the frame" |
| close when `named.some((id) => cut.has(id))` | "leaves the socket open when the same identity still holds a live handle" |
| drop the `named.length === 0` guard | "does not strand other sockets on an attachment it cannot resolve" |

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/store-do.ts worker-tests/ws-delivery.test.ts
git commit -m "Refuse a removed member's socket, and close the one it holds (#113)"
```

---

## Task 5: Close the loop on the docs the spec owes

**Files:**
- Modify: `docs/ARCHITECTURE.md` (only if it states the membership predicate)
- Modify: `docs/superpowers/specs/2026-10-04-eviction-cuts-the-feed-design.md` (an Amendments section, if review changed anything)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Find out whether ARCHITECTURE.md says anything that is now wrong**

```bash
grep -n "leftAt\|evict\|removed\|reads stay open\|membersOf" docs/ARCHITECTURE.md
```

If it states who may read a room, correct it to name the three outcomes: in the room, left or timed out (reads on), removed (history only). If it says nothing on the subject, change nothing and record that in the commit message — a doc edit with no reason is worse than none.

- [ ] **Step 2: Record any amendment the review forced**

If implementation contradicted a decision in the spec, add an `## Amendments after review` section to the spec saying which decision changed and why, following `2026-09-26-idempotent-event-append-design.md`'s section of that name. If nothing changed, add nothing.

- [ ] **Step 3: Verify and commit**

```bash
npm run verify
git add -A docs/
git commit -m "Docs: say who may read a room after a removal (#113)"
```

Skip this commit entirely if Steps 1 and 2 both found nothing to change.

---

## Done when

- [ ] `npm run verify` exits 0: typecheck, worker typecheck, build, Node tests, worker tests.
- [ ] An evicted member's `bellman_sync` returns its history including its own `member_evicted` event, and nothing after.
- [ ] An evicted member's `/ws` upgrade is refused, and a socket it held at the moment of eviction received the notice and closed.
- [ ] A member who left, and one whose seat timed out, both still receive new events.
- [ ] Every new test has been run against a broken implementation and seen to fail.
- [ ] `bellman_evict`'s description no longer promises the person removed the room's new events, and a test pins that.
- [ ] No surface ships `removedAtCursor` to a client (spec D8), and a test pins that too.
