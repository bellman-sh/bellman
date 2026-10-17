# Abuse Protections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan runs with subagents and **one whole-branch review at the end of each part**: no per-task review steps, whatever a skill says.

**Goal:** A public room's permanent join code can go in a README: a creator can ban an account from a room or from every room they own, an operator can suspend an account, every member's sends are limited per minute, and anyone a room admits can report it.

**Architecture:** Room bans and send counts live in the room's own `SessionDO`; creator-wide bans, suspensions and the report queue live in `RegistryDO`, and a creator-wide ban made by an eviction reaches the registry through the room's outbox (ADR 0006). Each check reads one object. Operator routes reuse the `/admin/handles` gate (`BELLMAN_OPERATORS`, bearer only). Suspension is read where the Worker resolves a caller, through a per-isolate cache.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, the MCP SDK, zod, vitest (root program) and `@cloudflare/vitest-pool-workers` (`worker-tests/`); the dash is Vite, React 19 and Testing Library; the site is static HTML with Python unittest.

**Spec:** `docs/superpowers/specs/2026-10-15-abuse-protections-design.md`

## Global Constraints

- Send limit: **30** sends a minute for a member, **6** for a stranger, per member, per room, over a rolling minute, in the room object's memory. The hosted seat is exempt. A refusal is `rate_limited` with `retry_after` in seconds, and nothing is written to the log.
- A stranger is a member who joined a public room through its permanent code, recorded as `via: "permanent"` on the member row. The creator, and anyone who joined with a 15-minute code, is never a stranger.
- Bans: `bellman_evict` takes `ban?: "room" | "all"`. A banned account sees exactly `You can't join this room.`, naming neither who banned it nor the level. A ban removes nothing from the log. A `banId` is opaque; a creator never sees an account's user id.
- Suspension: refused with exactly `This account is suspended.`; cached per isolate for **60 seconds**.
- Operator powers (suspension, the report queue, releasing a handle) take a user id listed in the `BELLMAN_OPERATORS` secret. Unset or empty: nobody passes. `BELLMAN_USERS` overrides grant none of them.
- Reports: reasons `spam`, `harassment`, `impersonation`, `illegal`, `other`; a note of at most **500** characters; **10** reports per account a day; a repeat of the same target by the same account folds into the first, with no new email; kept **180 days** after resolved; unresolved reports stay.
- Each report sends one email to support@ through the `send_email` binding, after the report is stored. A failed email never fails the report. The note is untrusted text: the dash renders it as text, the email carries it as plain text.
- A creator never sees who filed a report. The reported person is not told.
- Every `BellmanStore` method is async, and every new one gets contract cases that both stores pass (`tests/helpers/store-contract.ts`).
- A new tool means editing `extension/manifest.json`. The ADR is **0022**.
- A room holds many members: never write "two sessions" or "the other session". Never write "load-bearing", any "worth …" phrase, or "structural".
- Edit with the Edit or Write tool, never `perl -i` or `sed -i`. Never call a `graph_*` or `bellman_*` tool. Never bypass commit signing.

## Review Focus

1. **A ban on a member who already left, behind no live door.** The removal writes the ban and no event. Expect no crash and no cursor move: `SessionDO.removeMember` writes its `cursor` row from the last event written, and there is none. Pinned in Task 1.
2. **An account holding two handles in the room.** A ban names one `member_id`, and `member_id` is per connection. Expect every handle that account holds in the room to be removed, or the second one keeps sending. Pinned in Task 3.
3. **A keyed `bellman_send` retried at the limit.** Expect `rate_limited` while the minute is full, and after `retry_after` the same key replays the original event rather than sending a second. Pinned in Task 8.
4. **A report note carrying CR/LF, `Subject:` or markup.** Expect the email's subject built from closed sets alone, the note only in the body and unchanged, and the dash showing the markup as text. Pinned in Tasks 10 and D4.
5. **The same account reporting the same target after the first report was resolved.** Expect a new report and a new email, not a fold into a closed report. Pinned in Task 9.

## Rulings

Where the spec was silent or the code disagreed with it. Each is a decision this plan carries out.

- **R1. The dash's Ban button needs a route.** The spec gives `bellman_evict` its `ban` and the dash a Ban button, but no HTTP route bans. Task 4 adds `POST /rooms/:id/bans` with `{ member_id, scope }`, which runs the same `evictMember` operation the tool runs.
- **R2. The creator-wide check is a registry read beside the code's resolution, not inside it.** The registry's `jc:` rows map a code to a room id and do not know the room's creator, and `getSessionByJoinCode` already reads the room after the registry. `bellman_connect` therefore calls `isBannedByCreator(session.createdBy, userId)` right after the code resolves. `bellman_confirm` calls it again, because a preview minted before the ban holds a 10-minute token.
- **R3. A ban removes every handle the account holds in the room.** That is the target's handle and each other handle still in the room, each in its own `removeMember` call. A refusal partway is finished by repeating the eviction.
- **R4. `ban: "all"` writes both a room ban and a creator-wide ban** (the spec's "also"). They are separate records: lifting one leaves the other, and the dash says so.
- **R5. A ban writes no event.** A public room's log is public, and the banned person is told only that they can't join. The audit row of the eviction carries `ban`.
- **R6. The send limit counts `bellman_send` calls only.** That includes its `surface` kind and a keyed retry. The HTTP surface routes are not counted, because the dash's group drag writes one PUT per card and would pass 30. Gap: a stranger whose seat holds `write_surface` could write through the route uncounted. No built-in preset gives a default seat that verb.
- **R7. The count is a separate store call, `admitSend`, made after a send's checks and before its append.** A send that fails after admission, such as a frozen room or a key conflict, still used its place. This keeps both append methods' return types as they are.
- **R8. "Every authenticated call" means every call that reads or writes the store as the caller.** That is `/mcp`, `/ws`, `/rooms*`, `/presets*`, `/account/handle` and `/account/bans*`. The authorization server's paths (`/auth/*`, the `/account` page, `/token`, `/authorize`, `/upgrade`, `/admin/*`) are not gated, so a suspended person can still sign out. An open room socket is not closed; the next connect is refused.
- **R9. A fold is into an open report only.** After the first report by an account about a target is resolved, a repeat files a new report and sends a new email. A fold writes nothing and does not count toward the 10 a day.
- **R10. "10 a day" is a rolling 24 hours.**
- **R11. Who may report a room.** Anyone who holds or held a handle in it may, and, while the room is public, anyone signed in. The tool and the route run one operation, `fileRoomReport`. Both take `member_id` or `cursor`, or neither for the room. A message target must be an event a member sent, so `fromMemberId` is not `"system"`.
- **R12. A report keeps whom it is about.** That is the member id, user id and label (`subject`), so an operator can suspend the account. The creator's view carries the member id and label only.
- **R13. The email uses the builder form of `send_email`.** It is `{ from: "reports@bellman.sh", to: "support@bellman.sh", subject, text }`, sent from the tool and the route after the store answers `filed`.
- **R14. Suspension routes.** `POST` needs `{ note }`, 1 to 500 characters. `:userId` must have `isLinkableUserId`'s shape. `DELETE` answers 404 when nothing was suspended. There is no listing route, because the spec names none.
- **R15. A resolved report's deletion is a named handler, `report_purge`, on the registry's one alarm.** `MemoryStore` deletes in `sweep`.
- **R16. One ADR, 0022, written in section 1A for the whole design.** `docs/adr/` holds 0021 (bylines) as the highest number, and two ADRs share 0019.
- **R17. The privacy page also says what a ban and a suspension keep.** A ban keeps the account's label, which for most is an email address.
- **R18. The site's `/docs` page says "eleven tools" and lists no `bellman_public_name`.** Adding `bellman_report` would leave the count false, so Part 3 adds both rows and states the true count.

## File map

| File | Part | Responsibility |
|---|---|---|
| `src/bans.ts` (new) | 1A | `Ban`, `CreatorBan`, `BanScope`, `BANNED`, `newBanId`, `banView`, `creatorBanView` |
| `src/suspension.ts` (new) | 1A | `Suspension`, `SUSPENDED`, `SUSPENSION_CACHE_MS`, `SuspensionCache` |
| `src/http/moderation.ts` (new) | 1A, 1C | `/rooms/:id/bans*`, `/rooms/:id/reports`, `/account/bans*` |
| `src/send-limit.ts` (new) | 1B | the two limits, the window, `sendLimitFor`, `admitAt` |
| `src/reports.ts` (new) | 1C | report types and constants, ids, the email, the two views |
| `src/tools/report.ts` (new) | 1C | `bellman_report` |
| `src/store.ts`, `src/store-do.ts` | all | the new store methods, both stores |
| `src/rooms.ts` | all | `evictMember` with `ban`, `admitSend`, `writeSurface`'s count, `fileRoomReport` |
| `src/tools/{evict,connect,confirm,send,kit}.ts`, `src/server.ts` | all | tool wiring |
| `src/oauth/routes.ts` | 1A, 1C | `operatorGate`, `/admin/suspensions/:userId`, `/admin/reports*` |
| `src/worker.ts`, `src/app.ts`, `wrangler.toml` | all | dispatch, the suspension gate, the email binding |
| `extension/manifest.json` | 1C | `bellman_report` |

---

# Part 1 — the server

**Workspace:** `/Users/mcfearsome/.worktrees/bellman-abuse`, a jj workspace whose working copy sits on top of this plan's change, which sits on the spec's (bookmark `mcfearsome/abuse-protections`). Git commands fail there; that is expected. Each task ends with `jj commit -m "…"`; move the bookmark to the last change before opening a PR.

**Shipping:** the three sections are the rollout order, and each ends green, so each can be its own PR: 1A closes the README hole, 1B adds the limit, 1C adds reports. Before 1C deploys, the owner sets up Email Routing on bellman.sh with support@ as a verified destination, and sets the `BELLMAN_OPERATORS` secret.

**Commands:** `npx vitest run <file> -t "<name>"` for the root program; `npm run build:ui && npm --prefix worker-tests run test -- <file> -t "<name>"` for workerd (`npm run test:worker` once first installs its tree); `npm run verify` before every commit that ends a section.

- [ ] **Setup:** `cd /Users/mcfearsome/.worktrees/bellman-abuse && npm run verify`. Expected: green. The worker log's uncaught "Unknown session" lines are pre-existing.

## Section 1A — Bans

### Task 1: Room bans in the store

**Files:**
- Create: `src/bans.ts`
- Modify: `src/store.ts` (`RemovalRequest`, `SeatOutcome`, `BellmanStore`, `MemoryStore`), `src/store-do.ts` (`SessionDO.seatMember`, `SessionDO.removeMember`, new `SessionDO` methods, `DurableObjectStore`)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces, in `src/bans.ts`:
  ```ts
  export type BanScope = "room" | "all";
  /** An account banned from a room (spec §1): an opaque id, the label it had there, and when. */
  export interface Ban { banId: string; userId: string; label: string; at: number }
  /** An account banned from every room a creator owns, and the room the ban was made in. */
  export interface CreatorBan extends Ban { sessionId: string }
  export const BANNED = "You can't join this room.";
  /** `ban_` and 16 hex characters. */
  export function newBanId(): string;
  /** What a ban list sends a creator: never the account's user id. */
  export function banView(b: Ban): { ban_id: string; label: string; at: string };            // at as ISO 8601
  export function creatorBanView(b: CreatorBan): { ban_id: string; label: string; at: string; session_id: string };
  ```
- Produces, in `src/store.ts`: `RemovalRequest.ban?: BanScope`; `SeatOutcome.refused` gains `"banned"`; `BellmanStore.roomBans(sessionId: string): Promise<Ban[]>` (oldest first, `[]` for an unknown room); `BellmanStore.liftRoomBan(sessionId: string, banId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests.** In `tests/helpers/store-contract.ts`, inside the removal section (after the last `removeMember` case, where `eviction()` and `leaveEvent()` are in scope):

```ts
    describe("room bans (abuse protections spec §1)", () => {
      const twoInRoom = () => session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" })],
      });
      const back = (memberId = "m_peer_2", roomRole = "peer_b") =>
        member({ memberId, userId: "u_peer", label: "peer@codenerd", roomRole });

      it("records the account on an eviction that asks, and refuses its next seating in any seat", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        expect(await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" }))
          .toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
        expect(await store.roomBans(s.id)).toEqual([
          { banId: expect.stringMatching(/^ban_[0-9a-f]{16}$/), userId: "u_peer", label: "peer@codenerd", at: 9_000_000 },
        ]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBe("banned");
        expect((await store.seatMember(s.id, back("m_peer_3", "peer_a"), 1, 9_100_000)).refused).toBe("banned");
        expect((await store.seatMember(s.id, member({ memberId: "m_other", userId: "u_other", label: "other@x" }), 1, 9_100_000)).refused,
          "the control: another account seats").toBeNull();
      });

      it("writes no ban for a removal that does not ask, and the account seats again", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", eviction());
        expect(await store.roomBans(s.id)).toEqual([]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBeNull();
      });

      /** Review Focus 1. */
      it("bans a member who already left, behind no live door, writing no event and moving no cursor", async () => {
        const s = session({
          joinCodes: {},
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", leftAt: 5_000 })],
        });
        await store.createSession(s);
        expect(await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" }))
          .toEqual({ refused: null, removed: false, codeRetired: null });
        expect((await store.roomBans(s.id)).map((b) => b.userId)).toEqual(["u_peer"]);
        expect(await store.eventsAfter(s.id, 0)).toEqual([]);
        expect((await store.appendEvent(s.id, leaveEvent("m_creator")))?.cursor).toBe(1);
      });

      it("keeps one ban per account: a repeat records nothing new", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const first = await store.roomBans(s.id);
        await store.removeMember(s.id, "m_peer", { ...eviction(9_500_000), ban: "room" });
        expect(await store.roomBans(s.id)).toEqual(first);
      });

      it("writes no ban when the removal is refused", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), byUserId: "u_someone_else", ban: "room" });
        expect(await store.roomBans(s.id)).toEqual([]);
      });

      it("lifts a ban by its id, once, and the account seats again", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const [ban] = await store.roomBans(s.id);
        expect(await store.liftRoomBan(s.id, "ban_0000000000000000")).toBe(false);
        expect(await store.liftRoomBan(s.id, ban.banId)).toBe(true);
        expect(await store.liftRoomBan(s.id, ban.banId)).toBe(false);
        expect(await store.roomBans(s.id)).toEqual([]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBeNull();
      });

      it("answers no bans for an unknown room", async () => {
        expect(await store.roomBans("qs_nowhere")).toEqual([]);
        expect(await store.liftRoomBan("qs_nowhere", "ban_0000000000000000")).toBe(false);
      });
    });
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run tests/store.test.ts -t "room bans"`. Expected: FAIL, `roomBans is not a function` and a type error on `ban`.

- [ ] **Step 3: Implement.**
  - `src/bans.ts` as in Interfaces. `newBanId` takes `crypto.randomUUID()`, drops the hyphens, keeps 16 characters.
  - `RemovalRequest.ban`: when set, the removal bans the member's account (`m.userId`, `m.label`, `req.now`) from the room, unless a ban for that account exists, which then stands. The ban is written whether or not this call removed the member, as the door is, and never on a refusal. Document it beside `retire`.
  - **The idempotent early return** in both `removeMember`s becomes "nothing owed": not leaving, no door to retire, and no `ban` asked.
  - `SessionDO`: rows `bn:<banId>` holding the `Ban`, and `bu:<encodeURIComponent(userId)>` holding the ban id. Both are written in the removal's own transaction. **When no event was written, the put carries no `cursor` row:** today it reads `written[written.length - 1].cursor`, which is undefined then. Delivery and `reArm` after the commit keep their current conditions.
  - `seatMember` in both stores refuses `"banned"` for an account with a ban, after the frozen refusal and before capacity. `SessionDO` reads `bu:` inside its transaction.
  - `roomBans` lists `bn:`, sorted by `at` and then `banId`. `liftRoomBan` deletes both rows in one transaction and answers whether there was one. `DurableObjectStore` delegates both to the room's object.
  - `MemoryStore`: `private roomBanned = new Map<string, Ban[]>()`, keyed by session id. `purgeNow` deletes the room's entry beside `this.keys.delete(s.id)`.

- [ ] **Step 4: Run them to see them pass,** in both stores. `npx vitest run tests/store.test.ts -t "room bans"`, then `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "room bans"`. Expected: PASS. Then `npx vitest run tests/store.test.ts` and `npm run typecheck:worker`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "A room records the accounts its creator bans, and refuses them a seat"`

### Task 2: Creator-wide bans in the store

**Files:**
- Modify: `src/store.ts` (`BellmanStore`, `MemoryStore`), `src/store-do.ts` (`SessionDO.removeMember`, `SessionDO.#deliver`, `RegistryDO`, `DurableObjectStore`), the topology comment at the top of `src/store-do.ts`
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `CreatorBan`, `newBanId` (Task 1); `RemovalRequest.ban`.
- Produces on `BellmanStore`:
  ```ts
  /** This creator's bans from every room they own (spec §1), oldest first. */
  creatorBans(creatorId: string): Promise<CreatorBan[]>;
  /** Lift one of this creator's, by id. True when there was one. Another creator's id is not found. */
  liftCreatorBan(creatorId: string, banId: string): Promise<boolean>;
  /** The join check (R2): whether this creator banned this account from every room they own. */
  isBannedByCreator(creatorId: string, userId: string): Promise<boolean>;
  ```
- Produces on `RegistryDO`: `putCreatorBan(creatorId: string, ban: CreatorBan): Promise<void>`. It writes only when the key is absent, so a redelivery keeps the first ban. Key: `cb:<encodeURIComponent(creatorId)>:<encodeURIComponent(userId)>`.

- [ ] **Step 1: Write the failing tests.** After the "room bans" describe:

```ts
    describe("creator-wide bans (abuse protections spec §1)", () => {
      const room = (id: string, createdBy = "u_jesse") => session({
        id, createdBy,
        members: [member({ memberId: "m_creator", userId: createdBy }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" })],
      });

      it("bans the account from every room the creator owns and from no one else's, and from this room too", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(true);
        expect(await store.isBannedByCreator("u_someone_else", "u_peer")).toBe(false);
        expect(await store.isBannedByCreator("u_jesse", "u_other")).toBe(false);
        expect((await store.roomBans("qs_a")).map((b) => b.userId)).toEqual(["u_peer"]);
        expect(await store.creatorBans("u_jesse")).toEqual([
          { banId: expect.stringMatching(/^ban_[0-9a-f]{16}$/), userId: "u_peer", label: "peer@codenerd", at: 9_000_000, sessionId: "qs_a" },
        ]);
      });

      it("writes nothing creator-wide for a room ban", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "room" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
        expect(await store.creatorBans("u_jesse")).toEqual([]);
      });

      it("bans creator-wide a member who already left, and keeps the first ban on a repeat", async () => {
        await store.createSession(session({
          id: "qs_a", joinCodes: {},
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", leftAt: 5_000 })],
        }));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        const first = await store.creatorBans("u_jesse");
        expect(first.map((b) => b.userId)).toEqual(["u_peer"]);
        await store.removeMember("qs_a", "m_peer", { ...eviction(9_500_000), ban: "all" });
        expect(await store.creatorBans("u_jesse")).toEqual(first);
      });

      it("widens a room ban to every room on a later eviction that asks for all", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "room" });
        await store.removeMember("qs_a", "m_peer", { ...eviction(9_500_000), ban: "all" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(true);
      });

      it("lifts by id for its creator only, and leaves the room ban that came with it", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        const [ban] = await store.creatorBans("u_jesse");
        expect(await store.liftCreatorBan("u_someone_else", ban.banId)).toBe(false);
        expect(await store.liftCreatorBan("u_jesse", ban.banId)).toBe(true);
        expect(await store.liftCreatorBan("u_jesse", ban.banId)).toBe(false);
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
        expect((await store.roomBans("qs_a")).map((b) => b.userId)).toEqual(["u_peer"]);
      });

      // Operator-issued user ids may hold a colon, so one creator's id can begin another's past the key's separator.
      it("keeps creators whose ids share a prefix apart", async () => {
        await store.createSession(room("qs_xy", "u_x:y"));
        await store.removeMember("qs_xy", "m_peer", { ...eviction(), byUserId: "u_x:y", ban: "all" });
        expect(await store.creatorBans("u_x")).toEqual([]);
        expect(await store.isBannedByCreator("u_x", "u_peer")).toBe(false);
        expect((await store.creatorBans("u_x:y")).map((b) => b.userId)).toEqual(["u_peer"]);
      });
    });
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/store.test.ts -t "creator-wide bans"`. Expected: FAIL, `isBannedByCreator is not a function`.

- [ ] **Step 3: Implement.**
  - **MemoryStore:** `private creatorBanned = new Map<string, CreatorBan[]>()`, keyed by creator. With `ban: "all"`, `removeMember` adds `{ banId: newBanId(), userId, label, at: req.now, sessionId: s.id }` under `s.createdBy` unless that creator already bans the account. It does this with no await, beside the room ban.
  - **SessionDO.removeMember:** with `ban: "all"`, queue one intent in the same `driver.enqueue` call that queues the code drop and the audit rows. The intent is `{ id: crypto.randomUUID(), kind: "creator_ban", payload: { creatorId: s.createdBy, ban: CreatorBan } }`, and the ban id is made here, so a redelivery carries the same one. **After the commit, call `deliverNow()` whenever the transaction queued a row,** not only when it wrote an event. A ban on a member who already left queues one and writes none.
  - **`SessionDO.#deliver`:** a `creator_ban` branch that calls `registry().putCreatorBan(creatorId, ban)`, before the unknown-kind throw.
  - **RegistryDO:** `putCreatorBan` checks and writes in one transaction. `creatorBans` lists the creator's encoded prefix and sorts by `at`. `liftCreatorBan` lists that prefix, finds the id and deletes it, in one transaction. `isBannedByCreator` is one `get`.
  - **DurableObjectStore:** delegates the three reads and the lift to the registry.
  - Add "bans" to `SessionDO`'s line and "creator-wide bans" to `RegistryDO`'s line in the topology comment.

- [ ] **Step 4: Run to see them pass,** in both stores. `npx vitest run tests/store.test.ts -t "creator-wide bans"`, then `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "creator-wide bans"`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "An eviction can ban an account from every room its creator owns, through the room's outbox"`

### Task 3: `bellman_evict` bans; the join refuses a banned account

**Files:**
- Modify: `src/rooms.ts` (`evictMember`), `src/tools/evict.ts`, `src/tools/connect.ts`, `src/tools/confirm.ts`, `tests/helpers/flows.ts`
- Test: `tests/tools/bans.test.ts` (new)

**Interfaces:**
- Consumes: `BanScope`, `BANNED` (Task 1); `isBannedByCreator` (Task 2); `SeatOutcome.refused === "banned"`.
- Produces: `evictMember(store, actor, sessionId, targetMemberId, ban?: BanScope): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string; banned: BanScope | null }>>`. The tool returns `banned` beside its existing fields.
- Produces, in `tests/helpers/flows.ts`:
  ```ts
  /** A public swarm room started by jesse, with a permanent code for its default seat (ADR 0020). */
  export async function publicRoom(h: Harness): Promise<{ creator: Peer; sessionId: string; memberId: string; code: string }>;
  /** Both phases of joining: the preview's refusal if it refused, else the confirm's outcome. */
  export async function joinWith(peer: Peer, code: string): Promise<Outcome>;
  ```

- [ ] **Step 1: Write the helpers and the failing tests.** In `tests/helpers/flows.ts` (import `Outcome` from `./harness.js`):

```ts
export async function publicRoom(h: Harness) {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm", public: true }), brief: brief() });
  expect(started.isError, started.text).toBe(false);
  const sessionId = String(started.data.session_id);
  const memberId = String(started.data.member_id);
  const door = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId, permanent: true });
  expect(door.isError, door.text).toBe(false);
  return { creator, sessionId, memberId, code: String(door.data.join_code) };
}

export async function joinWith(peer: Peer, code: string): Promise<Outcome> {
  const preview = await peer.call("bellman_connect", { join_code: code });
  if (preview.isError) return preview;
  return peer.call("bellman_confirm", {
    connect_token: String(preview.data.connect_token), brief: brief(), capabilities: ["read_context", "receive_messages"],
  });
}
```

Create `tests/tools/bans.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BANNED } from "../../src/bans.js";
import { brief } from "../helpers/fixtures.js";
import { joinWith, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.close();
});

describe("bellman_evict with ban (abuse protections spec §1)", () => {
  /** The hole this closes (spec §4). */
  it("refuses a member banned from the room when they redeem its permanent code, and seats anyone else", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    expect(joined.isError, joined.text).toBe(false);

    const out = await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id, ban: "room" });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ evicted: true, banned: "room" });
    const row = (await h.store.auditForOrg("org_codenerd", 50)).find((a) => a.action === "member_evicted");
    expect(row?.detail).toMatchObject({ ban: "room" });

    const back = await joinWith(peer, room.code);
    expect([back.isError, back.text]).toEqual([true, `Error: ${BANNED}`]);
    expect((await joinWith(await h.connect(DEV_KEY.outsider), room.code)).isError, "the control").toBe(false);
  });

  it("without ban, lets the same permanent code seat them again", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id });
    const back = await joinWith(peer, room.code);
    expect(back.isError, back.text).toBe(false);
  });

  it("with ban all, refuses the account's preview of another room the creator owns", async () => {
    const first = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, first.code);
    await first.creator.call("bellman_evict", { session_id: first.sessionId, member_id: joined.data.member_id, ban: "all" });
    const second = await publicRoom(h);
    const preview = await peer.call("bellman_connect", { join_code: second.code });
    expect([preview.isError, preview.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  // R2: a preview holds a 10-minute token, minted before the ban.
  it("refuses a confirm whose preview came before a ban from every room", async () => {
    const first = await publicRoom(h);
    const second = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, first.code);
    const preview = await peer.call("bellman_connect", { join_code: second.code });
    expect(preview.isError, preview.text).toBe(false);
    await first.creator.call("bellman_evict", { session_id: first.sessionId, member_id: joined.data.member_id, ban: "all" });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(), capabilities: ["read_context", "receive_messages"],
    });
    expect([confirmed.isError, confirmed.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  /** Review Focus 2. */
  it("removes every handle the banned account holds in the room", async () => {
    const room = await publicRoom(h);
    const laptop = await h.connect(DEV_KEY.peer);
    const desktop = await h.connect(DEV_KEY.peer);
    const a = await joinWith(laptop, room.code);
    const b = await joinWith(desktop, room.code);
    await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: a.data.member_id, ban: "room" });
    const sent = await desktop.call("bellman_send", { session_id: room.sessionId, member_id: b.data.member_id, type: "message", payload: { text: "still here" } });
    expect([sent.isError, sent.text]).toEqual([true, "Error: member_id is not yours or has left the session."]);
  });

  it("bans nobody when someone other than the creator asks", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    const outsider = await h.connect(DEV_KEY.outsider);
    await joinWith(outsider, room.code);
    const out = await outsider.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id, ban: "all" });
    expect(out.isError).toBe(true);
    expect(await h.store.roomBans(room.sessionId)).toEqual([]);
    expect(await h.store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
  });

  it("says in its description what a ban adds, and takes it in its schema", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const tool = tools.find((t) => t.name === "bellman_evict")!;
    expect(tool.description!.replace(/\s+/g, " ")).toContain("Without ban, removal is not a ban");
    expect(tool.inputSchema.properties).toHaveProperty("ban");
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/tools/bans.test.ts`. Expected: FAIL. The first case is seated again instead of refused, and the schema case finds no `ban`.

- [ ] **Step 3: Implement.**
  - **`evictMember`:** build the `RemovalRequest` from the member it removes, with a local `request(m: Member): RemovalRequest`, so the target and each other handle get their own event, door and audit rows. Pass `ban` through. The `member_evicted` audit detail gains `ban` when it is set. After the target's removal succeeds with `ban`, remove each handle from `store.membersOfUser(sessionId, target.userId)` that is still in the room and is not the target, each with `request(other)` (R3). Their outcomes are not reported, because repeating the eviction finishes a refusal. `closeIfEmpty` stays last. Return `banned: ban ?? null`.
  - **`bellman_evict` schema:** `ban: z.enum(["room", "all"]).optional().describe('Also ban their account: "room" from this room, "all" from every room you own, now and later.')`.
  - **`bellman_evict` description:** replace `Removal is not a ban: any live code seats them again.` with `Without ban, removal is not a ban: any live code seats them again. With ban, their account cannot rejoin through any code: "room" refuses it at this room, and "all" at every room you own, now and later. A ban also removes every other handle that account holds here, and removes nothing from the log. They are told only that they can't join.`. Add `ban ("room" or "all", optional)` to Args and `banned ("room", "all" or null)` to Returns.
  - **`bellman_connect`:** after `const { session, role } = hit;`, return `fail(BANNED)` when `await s.isBannedByCreator(session.createdBy, identity.userId)`.
  - **`bellman_confirm`:** after the frozen refusal, make the same check. Map `seated.refused === "banned"` to `fail(BANNED)`, before the full room's message.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/tools/bans.test.ts tests/tools/evict.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "bellman_evict takes ban, and a banned account is refused at the join"`

### Task 4: The ban routes

**Files:**
- Create: `src/http/moderation.ts`
- Modify: `src/http/rooms.ts` (export `STATUS`), `src/worker.ts`, `src/app.ts`
- Test: `tests/http-moderation.test.ts` (new), `worker-tests/moderation-routes.test.ts` (new)

**Interfaces:**
- Consumes: `evictMember` with `ban` (Task 3); `roomBans`, `liftRoomBan`, `creatorBans`, `liftCreatorBan`; `banView`, `creatorBanView`; `json`, `problem`, `lengthRefusal`, `methodNotAllowed`, `RoomRouteDeps`, `STATUS` from `src/http/rooms.ts`; `handlesOf` from `src/rooms.ts`.
- Produces:
  ```ts
  export type ModerationDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;   // Task 11 adds mailReport
  // ponytail: 1 KB, not tuned. The body is a member id and a scope.
  export const MAX_BAN_BYTES = 1024;
  /** `undefined` for a path this module does not serve, so the server carries on to the room routes. */
  export function moderationRoutes(request: Request, deps: ModerationDeps): Promise<Response | undefined>;
  ```
  | Route | Who | Answer |
  |---|---|---|
  | `GET /rooms/:id/bans` | creator | 200 `{ bans: banView[] }` |
  | `POST /rooms/:id/bans` `{ member_id, scope }` | creator, CSRF | 200 `{ evicted, code_retired, session_status, banned }` |
  | `DELETE /rooms/:id/bans/:banId` | creator, CSRF | 204, or 404 `not_found` |
  | `GET /account/bans` | anyone signed in | 200 `{ bans: creatorBanView[] }` (their own) |
  | `DELETE /account/bans/:banId` | anyone signed in, CSRF | 204, or 404 |

  The room routes refuse in the order `unpublishRoom` does: 401 with no caller, the CSRF check on a write, one 404 for a missing room and for a caller with no handle in it, then 403 for a member who did not create it. Every route answers `OPTIONS` with `preflightResponse`, and a thrown error with 500 `internal`, as `handleRoutes` does.

- [ ] **Step 1: Write the failing tests.** Create `tests/http-moderation.test.ts`:

```ts
/**
 * The moderation routes (abuse protections spec §1, §3): a room's bans and reports for its creator, a
 * creator's bans across their rooms, and a report from anyone the room admits. Over one MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { moderationRoutes } from "../src/http/moderation.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_mod";
let store: MemoryStore;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

/** jesse created the public room; peer sits in it; outsider holds no handle. */
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
beforeEach(async () => {
  store = new MemoryStore();
  await store.createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member(), peer()] }));
});

function call(key: string | null, path: string, over: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  if (over.origin) headers.origin = over.origin;
  if (over.body !== undefined) headers["content-type"] = "application/json";
  return moderationRoutes(new Request(`${ISSUER}${path}`, {
    method: over.method ?? "GET", headers, body: over.body === undefined ? undefined : JSON.stringify(over.body),
  }), { store, caller, panelOrigins: [PANEL] });
}
const answer = async (res: Response | undefined) => [res!.status, await res!.json().catch(() => null)];

describe("the moderation routes", () => {
  it("leave every other path to the next module", async () => {
    for (const path of [`/rooms/${ROOM}`, `/rooms/${ROOM}/surface`, "/account", "/account/handle"]) {
      expect(await call(DEV_KEY.jesse, path), path).toBeUndefined();
    }
  });
});

describe("a room's bans", () => {
  it("bans a member for the creator, lists the ban by label and time with no user id, and lifts it", async () => {
    const banned = await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_peer", scope: "room" } });
    expect(await answer(banned)).toEqual([200, { evicted: true, code_retired: "peer_b", session_status: "active", banned: "room" }]);
    const [status, body] = await answer(await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`));
    expect(status).toBe(200);
    expect(body).toEqual({ bans: [{ ban_id: expect.stringMatching(/^ban_/), label: "peer@codenerd", at: expect.any(String) }] });
    expect(JSON.stringify(body)).not.toContain("u_peer");
    const id = (body as { bans: { ban_id: string }[] }).bans[0].ban_id;
    expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans/${id}`, { method: "DELETE" }))!.status).toBe(204);
    expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans/${id}`, { method: "DELETE" }))!.status).toBe(404);
    expect(await store.roomBans(ROOM)).toEqual([]);
  });

  it("answers a member who did not create the room 403, and a stranger and a missing room the same 404, banning nobody", async () => {
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/bans`))!.status).toBe(403);
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_creator", scope: "all" } }))!.status).toBe(403);
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/bans`))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, "/rooms/qs_nowhere/bans"))!.status).toBe(404);
    expect((await call(null, `/rooms/${ROOM}/bans`))!.status).toBe(401);
    expect(await store.roomBans(ROOM)).toEqual([]);
  });

  it("refuses a body with no member or no scope, and a cookie write without the panel's Origin", async () => {
    for (const body of [{ scope: "room" }, { member_id: "m_peer" }, { member_id: "m_peer", scope: "everywhere" }, []]) {
      expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body }))!.status, JSON.stringify(body)).toBe(400);
    }
    const forged = await call(null, `/rooms/${ROOM}/bans`, { method: "POST", cookie: DEV_KEY.jesse, body: { member_id: "m_peer", scope: "room" } });
    expect(forged!.status).toBe(403);
    expect(await store.roomBans(ROOM)).toEqual([]);
    const real = await call(null, `/rooms/${ROOM}/bans`, { method: "POST", cookie: DEV_KEY.jesse, origin: PANEL, body: { member_id: "m_peer", scope: "room" } });
    expect(real!.status, "the control: the panel's Origin bans").toBe(200);
  });
});

describe("a creator's bans across their rooms", () => {
  it("lists the bans with the room each came from, and lifts one, for the creator alone", async () => {
    await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_peer", scope: "all" } });
    const [status, body] = await answer(await call(DEV_KEY.jesse, "/account/bans"));
    expect(status).toBe(200);
    expect(body).toEqual({ bans: [{ ban_id: expect.stringMatching(/^ban_/), label: "peer@codenerd", at: expect.any(String), session_id: ROOM }] });
    const id = (body as { bans: { ban_id: string }[] }).bans[0].ban_id;
    expect(await answer(await call(DEV_KEY.peer, "/account/bans"))).toEqual([200, { bans: [] }]);
    expect((await call(DEV_KEY.peer, `/account/bans/${id}`, { method: "DELETE" }))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, `/account/bans/${id}`, { method: "DELETE" }))!.status).toBe(204);
    expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
    expect((await call(null, "/account/bans"))!.status).toBe(401);
  });
});
```

Create `worker-tests/moderation-routes.test.ts`:

```ts
/**
 * The Worker mounts the moderation routes over the real objects (abuse protections spec §4). Their rules are
 * pinned in tests/http-moderation.test.ts and tests/http-admin.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test"; // u_jesse, in vitest.config.ts
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}, on = workerEnv) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
}), on, ctx);
const store = () => new DurableObjectStore(env as never);
const seed = () => store().createSession(session({
  id: "qs_wire_mod", manifest: roomManifest({ public: true }),
  members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
}));

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the moderation routes through the Worker", () => {
  it("bans at /rooms/:id/bans, lists the ban, and lifts it at /rooms/:id/bans/:banId, over the real room", async () => {
    await seed();
    const banned = await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    expect(banned.status, await banned.clone().text()).toBe(200);
    const listed = (await (await call("/rooms/qs_wire_mod/bans")).json()) as { bans: { ban_id: string; label: string }[] };
    expect(listed.bans.map((b) => b.label)).toEqual(["peer@codenerd"]);
    expect((await call(`/rooms/qs_wire_mod/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().roomBans("qs_wire_mod")).toEqual([]);
  });

  it("lists a creator's bans at /account/bans from the real registry, and lifts one at /account/bans/:banId", async () => {
    await seed();
    await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    const listed = (await (await call("/account/bans")).json()) as { bans: { ban_id: string; session_id: string }[] };
    expect(listed.bans.map((b) => b.session_id)).toEqual(["qs_wire_mod"]);
    expect((await call(`/account/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().isBannedByCreator("u_jesse", "u_peer")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/http-moderation.test.ts`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement** `src/http/moderation.ts` to the table above.
  - The POST body: an object with a string `member_id` and a `scope` of `"room"` or `"all"`, bounded by `lengthRefusal(request, MAX_BAN_BYTES, "a ban request", origin)`. Its result maps through `STATUS`.
  - **Worker:** dispatch `/account/bans` and `/account/bans/*` to `moderationRoutes` behind `unconfigured`, beside the `/account/handle` block. In the `/rooms` block, answer `(await moderationRoutes(request, deps)) ?? (await roomRoutes(request, deps))`.
  - **Node (`createApp`):** mount `/account/bans` on `moderationRoutes`, and serve `/rooms` from moderation first, then the room routes.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/http-moderation.test.ts tests/http-rooms.test.ts`, then `npm run build:ui && npm --prefix worker-tests run test -- moderation-routes.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "The creator lists, sets and lifts bans over HTTP: a room's, and their own across rooms"`

### Task 5: Suspensions

**Files:**
- Create: `src/suspension.ts`
- Modify: `src/store.ts`, `src/store-do.ts` (`RegistryDO`, `DurableObjectStore`), `src/oauth/routes.ts`, `src/worker.ts`, `src/app.ts`
- Test: `tests/helpers/store-contract.ts`, `tests/suspension.test.ts` (new), `tests/http-admin.test.ts` (new), `worker-tests/moderation-routes.test.ts`

**Interfaces:**
- Produces, in `src/suspension.ts`:
  ```ts
  export interface Suspension { note: string; by: string; at: number }
  export const SUSPENDED = "This account is suspended.";
  export const SUSPENSION_CACHE_MS = 60_000;
  // ponytail: cleared whole past `max` (10,000) rather than evicted entry by entry; an LRU if one isolate ever holds that many.
  export class SuspensionCache {
    constructor(ttlMs?: number, max?: number);
    /** Whether `userId` is suspended, read through `read` at most once per `ttlMs` (spec D4). */
    check(userId: string, read: () => Promise<boolean>, now?: number): Promise<boolean>;
  }
  ```
- Produces on `BellmanStore` (the registry's, key `su:<encodeURIComponent(userId)>`): `suspend(userId: string, s: Suspension): Promise<void>` (a repeat replaces the note); `unsuspend(userId: string): Promise<boolean>`; `isSuspended(userId: string): Promise<boolean>`.
- Produces in `src/oauth/routes.ts`:
  ```ts
  /**
   * The gate for the operator's platform-wide powers (ADR 0021; abuse protections spec D3): a bearer token, never a
   * cookie, for a user id BELLMAN_OPERATORS lists. The operator, or the refusal: 401 for no credential or a cookie,
   * 403 `insufficient_scope` "<what> is limited to the user ids BELLMAN_OPERATORS lists".
   */
  async function operatorGate(request: Request, config: OAuthConfig, what: string): Promise<{ identity: Identity } | Response>;
  ```
  `/admin/handles/:handle` moves onto it unchanged in behaviour. `PlanStore` gains `"suspend" | "unsuspend"`.
  | Route | Answer |
  |---|---|
  | `POST /admin/suspensions/:userId` `{ note }` | 200 `{ user_id, note, suspended_at }`; 400 for a note that is not 1–500 characters once trimmed, or a user id that fails `isLinkableUserId` |
  | `DELETE /admin/suspensions/:userId` | 204, or 404 when none |

  Order: the gate, then the method (405, `allow: POST, DELETE`), then `config.plans` (501), then the body.

- [ ] **Step 1: Write the failing tests.** In `tests/helpers/store-contract.ts`, near "handles and bylines":

```ts
    describe("suspensions (abuse protections spec §1)", () => {
      it("suspends an account, says so for it alone, and lifts it once", async () => {
        expect(await store.isSuspended("u_peer")).toBe(false);
        await store.suspend("u_peer", { note: "spam in three rooms", by: "u_operator", at: 1_000 });
        expect(await store.isSuspended("u_peer")).toBe(true);
        expect(await store.isSuspended("u_pee")).toBe(false);
        expect(await store.unsuspend("u_peer")).toBe(true);
        expect(await store.unsuspend("u_peer")).toBe(false);
        expect(await store.isSuspended("u_peer")).toBe(false);
      });
    });
```

Create `tests/suspension.test.ts`:

```ts
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import { SUSPENDED, SUSPENSION_CACHE_MS, SuspensionCache } from "../src/suspension.js";
import { DEV_KEY } from "./helpers/harness.js";

describe("the suspension cache (spec D4)", () => {
  it("reads an account at most once a minute, and again after", async () => {
    const read = vi.fn(async () => false);
    const cache = new SuspensionCache();
    expect(await cache.check("u_a", read, 0)).toBe(false);
    read.mockResolvedValue(true);
    expect(await cache.check("u_a", read, SUSPENSION_CACHE_MS - 1)).toBe(false);
    expect(await cache.check("u_a", read, SUSPENSION_CACHE_MS)).toBe(true);
    expect(await cache.check("u_b", read, 1)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("forgets everything past its bound rather than growing", async () => {
    const read = vi.fn(async () => false);
    const cache = new SuspensionCache(SUSPENSION_CACHE_MS, 2);
    for (const id of ["u_a", "u_b", "u_c", "u_a"]) await cache.check(id, read, 0);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("a suspended account on the Node server (spec §1, R8)", () => {
  it("is refused at /mcp and at the room routes with the one message, and another account is served", async () => {
    const store = new MemoryStore();
    await store.suspend("u_peer", { note: "test", by: "u_operator", at: 0 });
    const app = createApp(store, new MemoryBlobStore(), { hostedSeat: false });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_KEY.peer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(403);
      expect(await mcp.json()).toMatchObject({ error: { message: SUSPENDED } });
      const rooms = await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${DEV_KEY.peer}` } });
      expect([rooms.status, await rooms.json()]).toEqual([403, { error: "suspended", error_description: SUSPENDED }]);
      expect((await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } })).status, "the control").toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

Create `tests/http-admin.test.ts`:

```ts
/**
 * The operator's routes (abuse protections spec D3): suspensions and the report queue, for a user id
 * BELLMAN_OPERATORS lists, over a bearer token and never a cookie, as /admin/handles is (ADR 0021).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import { MemoryStore } from "../src/store.js";
import type { Identity } from "../src/types.js";
import { COOKIE, ISSUER, PANEL, panelConfig, routeWith, seedSession } from "./helpers/panel.js";

const OPERATOR: Identity = { userId: "u_operator", orgId: null, plan: "free", role: "member", label: "ops@example.dev" };
const TEAM_ADMIN: Identity = { userId: "u_team_admin", orgId: "org_ops", plan: "team", role: "admin", label: "admin@example.dev" };
let store: MemoryStore;
let cfg: OAuthConfig;
let route: (request: Request) => Promise<Response>;

beforeEach(() => {
  store = new MemoryStore();
  cfg = panelConfig({ plans: store, operators: new Set([OPERATOR.userId]) });
  route = routeWith(cfg);
});

const bearer = async (identity: Identity, planSource = "default") => ({
  authorization: `Bearer ${await signJwt(
    { iss: ISSUER, sub: identity.userId, aud: cfg.resource, bellman: identity, plan_source: planSource },
    cfg.secret, ACCESS_TOKEN_TTL_SECONDS,
  )}`,
});
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown, on = route) => on(new Request(`${ISSUER}${path}`, {
  method,
  headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("/admin/suspensions/:userId", () => {
  it("suspends with a note and lifts, for a user id the list names", async () => {
    const auth = await bearer(OPERATOR);
    const res = await send("POST", "/admin/suspensions/u_peer", auth, { note: " spam in three rooms " });
    expect([res.status, await res.json()]).toEqual([200, { user_id: "u_peer", note: "spam in three rooms", suspended_at: expect.any(String) }]);
    expect(await store.isSuspended("u_peer")).toBe(true);
    expect((await send("DELETE", "/admin/suspensions/u_peer", auth)).status).toBe(204);
    expect((await send("DELETE", "/admin/suspensions/u_peer", auth)).status).toBe(404);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });

  it("asks for a note and a user id's shape, and suspends nobody without them", async () => {
    const auth = await bearer(OPERATOR);
    for (const body of [undefined, {}, { note: "" }, { note: "   " }, { note: "x".repeat(501) }]) {
      expect((await send("POST", "/admin/suspensions/u_peer", auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send("POST", "/admin/suspensions/github%3A4242", auth, { note: "x" })).status).toBe(400);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });

  // Fail closed (spec §4): no list, an empty one, a team admin BELLMAN_USERS made, a cookie and no credential.
  it("lets no one else through, and suspends nobody", async () => {
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("POST", "/admin/suspensions/u_peer", await bearer(OPERATOR), { note: "x" }, closed)).status).toBe(403);
    }
    expect((await send("POST", "/admin/suspensions/u_peer", await bearer(TEAM_ADMIN, "operator"), { note: "x" })).status).toBe(403);
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    expect((await send("POST", "/admin/suspensions/u_peer", { cookie: `${COOKIE}=${sid}`, origin: PANEL }, { note: "x" })).status).toBe(401);
    expect((await send("POST", "/admin/suspensions/u_peer", {}, { note: "x" })).status).toBe(401);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });
});
```

Add to `worker-tests/moderation-routes.test.ts` (imports: `ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt` from `../src/oauth/tokens.js`, `type Identity` from `../src/types.js`), above the `describe`:

```ts
const SECRET = "test-signing-secret";
/** OAuth on, for a token the authorization server signed: /admin is its. */
const oauthEnv = (over: Record<string, unknown> = {}) =>
  ({ ...env, BELLMAN_TOKEN_SECRET: SECRET, BELLMAN_OPERATORS: "u_operator", ...over }) as unknown as Parameters<typeof worker.fetch>[1];
const tokenFor = (identity: Identity) => signJwt(
  { iss: ORIGIN, sub: identity.userId, aud: canonicalResource(`${ORIGIN}/mcp`), bellman: identity, plan_source: "default" },
  SECRET, ACCESS_TOKEN_TTL_SECONDS,
);
const OPERATOR: Identity = { userId: "u_operator", orgId: null, plan: "free", role: "member", label: "ops@example.dev" };
```

and inside it:

```ts
  // A user id no earlier case read, so this isolate's cache (spec D4) holds no answer for it yet.
  it("suspends at /admin/suspensions/:userId, and the Worker refuses that account at /mcp and /rooms", async () => {
    const operator = await tokenFor(OPERATOR);
    const target = await tokenFor({ userId: "u_wire_suspended", orgId: null, plan: "free", role: "member", label: "s@example.dev" });
    const post = await worker.fetch(new Request(`${ORIGIN}/admin/suspensions/u_wire_suspended`, {
      method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ note: "wire" }),
    }), oauthEnv(), ctx);
    expect(post.status, await post.clone().text()).toBe(200);
    const mcp = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${target}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), oauthEnv(), ctx);
    expect([mcp.status, await mcp.json()]).toEqual([403, expect.objectContaining({ error: expect.objectContaining({ message: "This account is suspended." }) })]);
    const rooms = await worker.fetch(new Request(`${ORIGIN}/rooms`, { headers: { authorization: `Bearer ${target}` } }), oauthEnv(), ctx);
    expect(rooms.status).toBe(403);
  });
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/store.test.ts -t "suspensions" tests/suspension.test.ts tests/http-admin.test.ts`. Expected: FAIL, missing module and methods.

- [ ] **Step 3: Implement.**
  - The store methods in both stores, with `RegistryDO` and the facade delegating.
  - `SuspensionCache`: a `Map` of userId to `{ suspended, until }`. Read when the entry is missing or `now >= until`. Clear the whole map before adding when it holds `max` entries.
  - `operatorGate`, then `/admin/handles` on it, then `/admin/suspensions/:userId` beside it, with `ADMIN_SUSPENSION = /^\/admin\/suspensions\/([^/]+)$/`. Decode the segment in a `try`, so a bad escape is a 400.
  - **Worker:**
    - A module-level `const suspensions = new SuspensionCache();`.
    - `/mcp` and `/ws`: right after `resolveCaller`, refuse a suspended identity. `/mcp` answers `Response.json({ jsonrpc: "2.0", error: { code: -32003, message: SUSPENDED }, id: null }, { status: 403 })`, and `/ws` answers `new Response(SUSPENDED, { status: 403 })`.
    - The route modules: resolve the caller once per request. Add a local `once<T>(f: () => Promise<T>): () => Promise<T>` that keeps the first call's promise, then `const who = once(() => roomCaller(request, env, oauth))`. Hand `caller: () => who()` to every module, and refuse before dispatch with `problem(403, "suspended", SUSPENDED, allowedOrigin(request, oauth?.panelOrigins ?? []))`. That covers `/rooms`, `/presets`, `/account/handle` and `/account/bans`, and not `/public`. Resolving once keeps a cookie caller to one `touchSession` per request.
  - **Node:** the same refusals at `/mcp` and before the authenticated route mounts. `store.isSuspended` is read directly, with no cache; `MemoryStore` answers at once.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/suspension.test.ts tests/http-admin.test.ts tests/http-bylines.test.ts tests/http.test.ts`, then `npm run build:ui && npm --prefix worker-tests run test -- moderation-routes.test.ts handle-routes.test.ts store-contract.test.ts -t "suspen|handle|moderation"`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "An operator can suspend an account, and the Worker refuses it on every call to the store"`

### Task 6: Docs for bans

**Files:**
- Create: `docs/adr/0022-bans-limits-and-reports.md`
- Modify: `docs/ARCHITECTURE.md`, `README.md`

No test: this task changes prose. Its check is the measurement in Step 3 and `npm run verify`.

- [ ] **Step 1: Write ADR 0022** in the shape of ADR 0021: Date, Status accepted, Spec, Plan, Context, Decision, Consequences. Decision covers D1–D6 and R1–R15 in one line each: what was decided and where it lives. Consequences:
  - A fresh account evades a ban; the limit and reports are the backstop.
  - A ban from every room refuses the account's next join and leaves it in rooms it sits in now.
  - A suspension reaches a busy isolate within 60 seconds, and an open socket is not closed.
  - `creator_ban` and `report_purge` are new outbox and alarm names, so a rollback past them stalls the queue (ADR 0006) and deployments roll forward.
  - Send counts are forgotten when a room's object sleeps.
  - The panel's surface writes are not counted (R6).
  - A report's email can fail while the queue keeps the report.
  - Rollout: bans, then the limit, then reports.
- [ ] **Step 2: ARCHITECTURE.md and README.md.**
  - §5's mermaid: add "bans" to `SessionDO`'s node, and "creator-wide bans, suspensions, the report queue" to `RegistryDO`'s.
  - §7: a bullet on bans, suspension and their messages, naming ADR 0022.
  - README: the `bellman_evict` row says it takes `ban`. Add the ban routes and `POST|DELETE /admin/suspensions/:userId` beside the `/admin/grants` block, and a "Bans" bullet under Trust model.
- [ ] **Step 3: Measure the tool listing** by ARCHITECTURE §11's method:
  1. Save the two scripts below under `node_modules/.cache/bellman-measure/`, which is gitignored, so jj never records them and bare imports resolve.
  2. Run `npm run build:ui && npx tsx node_modules/.cache/bellman-measure/list-tools.mts "$PWD" | python3 -I node_modules/.cache/bellman-measure/count-tools.py`.
  3. Main measured 8,697 at the plan, with `bellman_evict` at 513. Add a "Re-measured on <date> for bans" paragraph to §11 naming each tool that moved.

```ts
// list-tools.mts — the server's tools/list entries, one compact JSON object a line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const root = process.argv[2];
const { buildServer } = await import(`${root}/src/server.ts`);
const { MemoryStore } = await import(`${root}/src/store.ts`);
const { MemoryBlobStore } = await import(`${root}/src/blobs.ts`);
const { resolveIdentity } = await import(`${root}/src/auth.ts`);
const server = buildServer(resolveIdentity("Bearer qk_dev_jesse"), new MemoryStore(), new MemoryBlobStore(), { hostedSeat: true });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "measure", version: "0" });
await Promise.all([server.connect(b), client.connect(a)]);
for (const t of (await client.listTools()).tools) console.log(JSON.stringify(t));
await client.close();
```

```python
# count-tools.py — cl100k over each entry's compact JSON, summed.
import json, sys, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
total = 0
for line in sys.stdin:
    entry = json.loads(line)
    n = len(enc.encode(json.dumps(entry, separators=(",", ":"))))
    total += n
    print(f"{entry['name']}\t{n}")
print(f"total\t{total}")
```

- [ ] **Step 4: Verify and commit.** `npm run verify`. Expected: green. `jj commit -m "ADR 0022, and the docs for bans and suspension"`

## Section 1B — The send limit

### Task 7: Strangers, and the count

**Files:**
- Create: `src/send-limit.ts`
- Modify: `src/types.ts` (`Member.via`, `PendingConnect.via`), `src/tools/connect.ts`, `src/tools/confirm.ts`, `src/store.ts`, `src/store-do.ts` (`SessionDO`, `DurableObjectStore`)
- Test: `tests/send-limit.test.ts` (new), `tests/helpers/store-contract.ts`, `tests/tools/send-limit.test.ts` (new)

**Interfaces:**
- Produces, in `src/send-limit.ts`:
  ```ts
  export const SEND_LIMIT = 30;
  export const STRANGER_SEND_LIMIT = 6;
  export const SEND_WINDOW_MS = 60_000;
  export type SendAdmission = { ok: true } | { ok: false; retryAfterMs: number };
  export function sendLimitFor(m: Pick<Member, "via">): number;
  /**
   * The rolling minute (spec D5), pure so both stores count alike: the times still inside the window, this one
   * added when admitted; or, at the limit, the times unchanged and how long until the oldest leaves the window.
   */
  export function admitAt(times: readonly number[], limit: number, now: number): { times: number[]; retryAfterMs: number | null };
  ```
- Produces: `Member.via?: "permanent"` and `PendingConnect.via?: "permanent"`. Each is documented as "how this seat was taken: through a public room's permanent code (spec §2); absent for every other seat, the creator's included". On `BellmanStore`: `admitSend(sessionId: string, memberId: string, limit: number, now: number): Promise<SendAdmission>`, memory only.

- [ ] **Step 1: Write the failing tests.** Create `tests/send-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SEND_LIMIT, SEND_WINDOW_MS, STRANGER_SEND_LIMIT, admitAt, sendLimitFor } from "../src/send-limit.js";

describe("the send limit (spec D5)", () => {
  it("is 30 a minute for a member and 6 for one who joined through a permanent code", () => {
    expect([SEND_LIMIT, STRANGER_SEND_LIMIT, SEND_WINDOW_MS]).toEqual([30, 6, 60_000]);
    expect(sendLimitFor({})).toBe(30);
    expect(sendLimitFor({ via: "permanent" })).toBe(6);
  });

  it("admits up to the limit in a rolling minute, then says when the oldest send leaves it", () => {
    let times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = admitAt(times, 6, 1_000 + i);
      expect(r.retryAfterMs, `send ${i + 1}`).toBeNull();
      times = r.times;
    }
    expect(admitAt(times, 6, 30_000)).toEqual({ times, retryAfterMs: 31_000 });
    expect(admitAt(times, 6, 61_000).retryAfterMs, "a minute after the first").toBeNull();
  });
});
```

In `tests/helpers/store-contract.ts`, a new describe, plus one case inside the existing `describe("appendHostEvent")` (it reuses `hostedRoom` and `question`):

```ts
    describe("the send count (abuse protections spec D5)", () => {
      it("admits a member's sends up to the limit in a minute, per member and per room", async () => {
        await store.createSession(session());
        await store.createSession(session({ id: "qs_other" }));
        for (let i = 0; i < 3; i++) expect(await store.admitSend("qs_test", "m_creator", 3, 1_000 + i)).toEqual({ ok: true });
        expect(await store.admitSend("qs_test", "m_creator", 3, 2_000)).toEqual({ ok: false, retryAfterMs: 59_000 });
        expect(await store.admitSend("qs_test", "m_peer", 3, 2_000), "another member").toEqual({ ok: true });
        expect(await store.admitSend("qs_other", "m_creator", 3, 2_000), "another room").toEqual({ ok: true });
        expect(await store.admitSend("qs_test", "m_creator", 3, 61_000), "a minute on").toEqual({ ok: true });
      });
    });
```

```ts
      // Spec §2: the hosted seat is exempt. Its writes go through this method alone, which never reads the count.
      it("writes past a full send count: the hosted seat is exempt from the limit", async () => {
        const s = hostedRoom();
        await store.createSession(s);
        for (let i = 0; i < 2; i++) await store.admitSend(s.id, HOST_MEMBER_ID, 2, NOW());
        expect(await store.admitSend(s.id, HOST_MEMBER_ID, 2, NOW()), "the premise: the count is full").toMatchObject({ ok: false });
        expect(await store.appendHostEvent(s.id, question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: true });
      });
```

Create `tests/tools/send-limit.test.ts` with the stranger case (Task 8 adds the rest):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief } from "../helpers/fixtures.js";
import { joinWith, pairUp, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

describe("who is a stranger (spec §2)", () => {
  it("records a seat taken through the permanent code as a stranger's, and one through a code that expires as not", async () => {
    const room = await publicRoom(h);
    const stranger = await joinWith(await h.connect(DEV_KEY.peer), room.code);
    const observer = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "observer" });
    const regular = await joinWith(await h.connect(DEV_KEY.outsider), String(observer.data.join_code));
    expect((await h.store.getMember(room.sessionId, String(stranger.data.member_id)))?.via).toBe("permanent");
    expect((await h.store.getMember(room.sessionId, String(regular.data.member_id)))?.via).toBeUndefined();
    expect((await h.store.getMember(room.sessionId, room.memberId))?.via, "the creator").toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/send-limit.test.ts tests/tools/send-limit.test.ts tests/store.test.ts -t "send|stranger|exempt"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `admitAt`: keep the times with `now - t < SEND_WINDOW_MS`, which stay in send order. At or past the limit, answer them with `retryAfterMs = kept[0] + SEND_WINDOW_MS - now`. Otherwise append `now`.
  - `bellman_connect` sets `via: "permanent"` on the pending connect when `session.joinCodes[role]?.expiresAt === null`. `bellman_confirm` copies `pending.via` onto the arriving member when it is set.
  - `MemoryStore.admitSend` keeps `Map<sessionId, Map<memberId, number[]>>`, and `purgeNow` drops the room's entry. `SessionDO.admitSend(memberId, limit, now)` keeps a `#sends = new Map<string, number[]>()` in the instance and never writes storage, so a sleeping object forgets. The facade delegates.

- [ ] **Step 4: Run to see them pass,** in both stores. The commands from Step 2, then `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "send count|exempt"`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "A seat taken through a permanent code is a stranger's, and a room counts each member's sends in memory"`

### Task 8: `bellman_send` refuses past the limit

**Files:**
- Modify: `src/rooms.ts` (`RoomFailure`, `RoomResult`, `refuse`, new `admitSend`, `writeSurface`), `src/http/rooms.ts` (`STATUS`), `src/tools/kit.ts`, `src/tools/send.ts`, `README.md`, `docs/ARCHITECTURE.md`
- Test: `tests/tools/send-limit.test.ts`

**Interfaces:**
- Consumes: `sendLimitFor` and `SendAdmission` (Task 7); `store.admitSend`.
- Produces:
  - `RoomFailure` gains `"rate_limited"`, and `STATUS` maps it to 429.
  - The failure arm of `RoomResult` gains `retryAfter?: number`, in seconds, and `refuse(code, reason, extra?: { retryAfter: number })`.
  - In `src/rooms.ts`: `/** Count one bellman_send against its member's minute (spec D5), or refuse it. Called after every check that can refuse the send and before its append. */ export async function admitSend(store: BellmanStore, sessionId: string, member: Member, now?: number): Promise<RoomResult<null>>`. The refusal is `refuse("rate_limited", reason, { retryAfter: Math.ceil(retryAfterMs / 1000) })`, and `reason` starts `rate_limited:` and names the limit and the wait.
  - `writeSurface` gains a last parameter, `countSend = false`. When it is true, `admitSend` runs after every validation and before the append.
  - In `src/tools/kit.ts`: `/** A room operation's refusal as a tool result; rate_limited also carries { error: "rate_limited", retry_after } as structuredContent. */ export function refusal(r: { code: string; reason: string; retryAfter?: number }): ToolResult`.

- [ ] **Step 1: Write the failing tests,** appended to `tests/tools/send-limit.test.ts`:

```ts
describe("the send limit (spec §2)", () => {
  it("refuses a member's 31st send in a minute as rate_limited with retry_after, and logs nothing for it", async () => {
    const s = await pairUp(h);
    const send = (i: number) => s.joiner.call("bellman_send", { session_id: s.sessionId, member_id: s.joinerMemberId, type: "message", payload: { text: `m${i}` } });
    for (let i = 0; i < 30; i++) expect((await send(i)).isError, `send ${i + 1}`).toBe(false);
    const before = (await h.store.eventsAfter(s.sessionId, 0)).length;
    const refused = await send(30);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("rate_limited");
    expect(refused.data).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
    expect(refused.data.retry_after as number).toBeGreaterThanOrEqual(1);
    expect(refused.data.retry_after as number).toBeLessThanOrEqual(60);
    expect((await h.store.eventsAfter(s.sessionId, 0)).length).toBe(before);
  });

  it("refuses a stranger's 7th send, counting every kind", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const kinds = [
      { type: "message", payload: { text: "hi" } },
      { type: "artifact", payload: { name: "a.md", content: "b" } },
      { type: "progress", payload: { note: "working" } },
      { type: "brief_update", payload: brief() },
      { type: "message", payload: { text: "five" } },
      { type: "message", payload: { text: "six" } },
    ];
    for (const [i, k] of kinds.entries()) {
      const r = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, ...k });
      expect(r.isError, `${k.type}, send ${i + 1}: ${r.text}`).toBe(false);
    }
    const seventh = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: "seven" } });
    expect(seventh.data).toMatchObject({ error: "rate_limited" });
  });

  it("gives a member who joined the same public room with a code that expires a member's 30", async () => {
    const room = await publicRoom(h);
    const lead = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "lead" });
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, String(lead.data.join_code))).data.member_id);
    for (let i = 0; i < 7; i++) {
      const r = await peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: `m${i}` } });
      expect(r.isError, `send ${i + 1}: ${r.text}`).toBe(false);
    }
  });

  /** Review Focus 3. */
  it("counts a keyed retry as a send, and once the minute passes the retry replays instead of sending twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const memberId = String((await joinWith(peer, room.code)).data.member_id);
    const send = (key: string) => peer.call("bellman_send", { session_id: room.sessionId, member_id: memberId, type: "message", payload: { text: key }, idempotency_key: key });
    for (let i = 0; i < 6; i++) expect((await send(`key-${i}-padded`)).isError).toBe(false);
    expect((await send("key-5-padded")).data).toMatchObject({ error: "rate_limited" });
    const count = (await h.store.eventsAfter(room.sessionId, 0)).length;
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send("key-5-padded")).data).toMatchObject({ replayed: true });
    expect((await h.store.eventsAfter(room.sessionId, 0)).length).toBe(count);
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/tools/send-limit.test.ts`. Expected: FAIL. The 31st send lands.

- [ ] **Step 3: Implement.**
  - **`bellman_send`, every kind but `surface`:** call `admitSend(s, session_id, me)` after the `progress` shape check and before `draft`, and return `refusal(admitted)` on a refusal.
  - **`bellman_send`, the `surface` branch:** pass `countSend: true` to `writeSurface`, and return `refusal(out)` on any failure. The HTTP surface route keeps the default, false (R6).
  - **`bellman_send` description:** append to its `Errors:` line `A member sends at most 30 times a minute, and one who joined through a public room's permanent code 6; past that the send is refused as rate_limited with retry_after in seconds, and nothing is sent.`.
  - **Docs:** a README Trust model bullet and an ARCHITECTURE §7 bullet on the limits, and the §11 measurement (Task 6 Step 3) for `bellman_send`.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/tools/send-limit.test.ts tests/tools/exchange.test.ts tests/tools/working-surface.test.ts tests/http-rooms.test.ts`, then `npm run verify`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "bellman_send refuses past 30 sends a minute, or 6 for a stranger, with retry_after"`

## Section 1C — Reports

### Task 9: The report queue in the store

**Files:**
- Create: `src/reports.ts`
- Modify: `src/store.ts` (`BellmanStore`, `MemoryStore` including `sweep`), `src/store-do.ts` (`RegistryDO`, its `alarm`, `DurableObjectStore`), `tests/helpers/store-contract.ts` (`StoreContractHarness.advanceRegistry`), `worker-tests/store-contract.test.ts`
- Test: `tests/reports.test.ts` (new), `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces, in `src/reports.ts` (runtime-free; imports types only):
  ```ts
  export const REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
  export type ReportReason = (typeof REPORT_REASONS)[number];
  export type ReportTarget = { kind: "room" } | { kind: "member"; memberId: string } | { kind: "message"; cursor: number };
  export const MAX_REPORT_NOTE_CHARS = 500;
  export const REPORTS_PER_DAY = 10;
  export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
  export const REPORT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
  export interface NewReport {
    sessionId: string; creatorId: string; target: ReportTarget;
    /** Whom a member or message report is about (R12); null for the room. */
    subject: { memberId: string; userId: string; label: string } | null;
    reason: ReportReason; note: string | null; reporterUserId: string; reporterLabel: string;
  }
  export interface Report extends NewReport { id: string; at: number; resolvedAt: number | null; resolution: string | null; resolvedBy: string | null }
  export type FiledReport = { outcome: "filed" | "folded"; report: Report } | { outcome: "limited"; retryAfterMs: number };
  /** "room", "member:<id>" or "message:<cursor>": what makes two reports of one target the same. */
  export function targetKey(t: ReportTarget): string;
  /** `rpt_`, the time padded to 15 digits, `_`, 8 random hex: string order is filing order. */
  export function reportId(at: number): string;
  ```
- Produces on `BellmanStore`:
  ```ts
  fileReport(r: NewReport, now: number): Promise<FiledReport>;
  /** A room's reports about members and messages, for its creator (spec §3), newest first. */
  roomReports(creatorId: string, sessionId: string): Promise<Report[]>;
  /** Every report, newest first: the operator's queue. */
  listReports(limit: number): Promise<Report[]>;
  /** Close a report with a note; the first resolution stands. Undefined for an unknown id. */
  resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined>;
  ```
- Produces on `StoreContractHarness`: `advanceRegistry?: () => Promise<void>`. The workerd run passes `() => runInDurableObject(env.REGISTRY.get(env.REGISTRY.idFromName("registry")), (instance: RegistryDO) => instance.alarm())`.

- [ ] **Step 1: Write the failing tests.** Create `tests/reports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reportId, targetKey, type ReportTarget } from "../src/reports.js";

describe("report ids and targets", () => {
  it("orders ids by the time they were filed, and keys each target once", () => {
    expect(reportId(2_000) > reportId(1_000)).toBe(true);
    expect(reportId(10_000) > reportId(9_999)).toBe(true);
    const targets: ReportTarget[] = [{ kind: "room" }, { kind: "member", memberId: "m_a" }, { kind: "message", cursor: 7 }];
    expect(targets.map(targetKey)).toEqual(["room", "member:m_a", "message:7"]);
  });
});
```

In `tests/helpers/store-contract.ts` (import `type NewReport, type Report` from `../../src/reports.js`):

```ts
    describe("reports (abuse protections spec §3)", () => {
      const filed = (over: Partial<NewReport> = {}): NewReport => ({
        sessionId: "qs_test", creatorId: "u_jesse",
        target: { kind: "member", memberId: "m_peer" },
        subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
        reason: "harassment", note: "called names", reporterUserId: "u_reader", reporterLabel: "reader@x", ...over,
      });
      const file = async (over: Partial<NewReport> = {}) => (await store.fileReport(filed(over), Date.now())) as { outcome: string; report: Report };
      const sweepRegistry = async () => {
        await store.sweep(Date.now());
        await harness.advanceRegistry?.();
      };

      it("files a report, and lists the queue newest first", async () => {
        const first = await file();
        vi.advanceTimersByTime(1_000);
        const second = await file({ target: { kind: "room" }, subject: null });
        expect(first).toMatchObject({ outcome: "filed", report: { reason: "harassment", note: "called names", resolvedAt: null } });
        expect((await store.listReports(10)).map((r) => r.id)).toEqual([second.report.id, first.report.id]);
      });

      it("folds a second report of one target by one account into the open first", async () => {
        const first = await file();
        expect(await store.fileReport(filed({ reason: "spam", note: "again" }), Date.now())).toEqual({ outcome: "folded", report: first.report });
        expect(await store.listReports(10)).toHaveLength(1);
        expect((await file({ reporterUserId: "u_other" })).outcome, "another account").toBe("filed");
        expect((await file({ target: { kind: "message", cursor: 3 } })).outcome, "another target").toBe("filed");
      });

      /** Review Focus 5. */
      it("files anew once the first is resolved, rather than folding into a closed report", async () => {
        const first = await file();
        await store.resolveReport(first.report.id, { note: "warned", by: "u_operator" }, Date.now());
        expect((await file()).outcome).toBe("filed");
      });

      it("takes 10 reports from an account a day, counts no fold, and takes the next once a day has passed", async () => {
        for (let i = 0; i < 10; i++) expect((await file({ target: { kind: "message", cursor: i + 1 } })).outcome).toBe("filed");
        expect((await file({ target: { kind: "message", cursor: 1 } })).outcome, "a repeat still folds").toBe("folded");
        expect(await store.fileReport(filed({ target: { kind: "room" }, subject: null }), Date.now()))
          .toEqual({ outcome: "limited", retryAfterMs: 24 * 3_600_000 });
        vi.advanceTimersByTime(24 * 3_600_000);
        expect((await file({ target: { kind: "room" }, subject: null })).outcome).toBe("filed");
      });

      it("lists for a room's creator its reports about members and messages, and none about the room", async () => {
        await file();
        await file({ target: { kind: "message", cursor: 4 } });
        await file({ target: { kind: "room" }, subject: null });
        await file({ sessionId: "qs_elsewhere" });
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.target.kind).sort()).toEqual(["member", "message"]);
        expect(await store.roomReports("u_someone_else", "qs_test")).toEqual([]);
      });

      it("resolves once with a note, keeps the first resolution, and answers nothing for an unknown id", async () => {
        const { report } = await file();
        const at = Date.now();
        const done = await store.resolveReport(report.id, { note: "warned", by: "u_operator" }, at);
        expect(done).toMatchObject({ id: report.id, resolvedAt: at, resolution: "warned", resolvedBy: "u_operator" });
        expect(await store.resolveReport(report.id, { note: "again", by: "u_x" }, at + 1_000)).toEqual(done);
        expect(await store.resolveReport("rpt_000000000000000_00000000", { note: "x", by: "u_x" }, at)).toBeUndefined();
      });

      it("deletes a report 180 days after it is resolved, from every list, and keeps an open one", async () => {
        const done = (await file()).report;
        const open = (await file({ target: { kind: "message", cursor: 2 } })).report;
        await store.resolveReport(done.id, { note: "warned", by: "u_operator" }, Date.now());
        vi.advanceTimersByTime(180 * 24 * 3_600_000 - 1);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id).sort(), "a millisecond before").toEqual([done.id, open.id].sort());
        vi.advanceTimersByTime(1);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id)).toEqual([open.id]);
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.id)).toEqual([open.id]);
      });
    });
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/reports.test.ts tests/store.test.ts -t "report"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`fileReport`, in one step in each store:**
    1. Fold: when the account's fold row for `(sessionId, targetKey)` names a report that is still open, answer `folded` with it and write nothing.
    2. Limit: keep the account's filing times with `now - t < REPORT_WINDOW_MS`. At `REPORTS_PER_DAY`, answer `limited` with `kept[0] + REPORT_WINDOW_MS - now`.
    3. Write the report, its fold row and the times with `now`, and, for a member or message target, the creator index row.
  - **`resolveReport`, in one step:**
    1. An unknown id answers undefined, and a resolved report is answered as it is.
    2. Otherwise stamp the resolution, delete the fold row (R9), and schedule the deletion at `now + REPORT_RETENTION_MS`.
  - **RegistryDO keys:**
    - `rp:<id>` holds the report.
    - `rf:<encodeURIComponent(reporter)>:<sessionId>:<targetKey>` holds the id.
    - `rl:<encodeURIComponent(reporter)>` holds `number[]`.
    - `rc:<encodeURIComponent(creatorId)>:<sessionId>:<id>` holds the id.
    - `rr:<purgeAt padded to 15>:<id>` holds the id.
    - The stored due row is `dueKey("report_purge")`, set to the earlier of itself and the new purge time inside the resolve's transaction, followed by `this.driver.reArm()` after the commit.
  - **Listing:** `listReports` lists `rp:` with `reverse: true, limit`. `roomReports` lists the `rc:` prefix and reads the rows it names.
  - **`RegistryDO.alarm`:** add `if (name === "report_purge") await this.#purgeReports(now)` to its loop. Without a branch the name is never consumed and the alarm fires back to back. Read `now` once at the top, as `SessionDO.alarm` does. `#purgeReports` deletes, in one transaction, every `rr:` row due by `now` with the report and its `rc:` row. It then sets the due row to the next `rr:` time, or deletes it.
  - **MemoryStore:** keeps a `Map` of reports, a fold map and a times map. `sweep(now)` deletes resolved reports with `resolvedAt + REPORT_RETENTION_MS <= now`.
  - **The harness:** `worker-tests/store-contract.test.ts` passes `advanceRegistry`.

- [ ] **Step 4: Run to see them pass,** in both stores. `npx vitest run tests/reports.test.ts tests/store.test.ts -t "report"`, then `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "reports"`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "The registry keeps a report queue: folded repeats, ten a day, and deletion 180 days after a report is resolved"`

### Task 10: `bellman_report`, and the email

**Files:**
- Create: `src/tools/report.ts`
- Modify: `src/reports.ts` (the email and the views), `src/rooms.ts` (`fileRoomReport`), `src/server.ts`, `extension/manifest.json`, `tests/helpers/harness.ts`
- Modify (the tool surface's lists and counts; find them with `grep -rn 'bellman_public_name\|toHaveLength(1[25])\|twelve\|fifteen' tests docs/ARCHITECTURE.md`): `tests/tools/surface.test.ts` (header 13, `EXPECTED_TOOLS`, `toHaveLength(13)`), `tests/extension.test.ts` ("sixteen", `toHaveLength(16)`, the comment's thirteen), `tests/http.test.ts` ("lists the 13 tools"), `tests/bridge.test.ts` (both name lists), `docs/ARCHITECTURE.md` ("the thirteen tools")
- Test: `tests/reports.test.ts`, `tests/tools/report.test.ts` (new)

**Interfaces:**
- Produces, in `src/reports.ts`:
  ```ts
  export const REPORT_FROM = "reports@bellman.sh";
  export const REPORT_TO = "support@bellman.sh";
  /** The message support@ is sent (R13): a subject from closed sets alone, the note only in the body, as written. */
  export function reportMail(r: Report): { subject: string; text: string };
  export interface MailBinding { send(m: { from: string; to: string; subject: string; text: string }): Promise<unknown> }
  export type ReportMailer = (r: Report) => Promise<void>;
  /** Sends one message; never throws. A missing binding or a failed send is logged, and the queue keeps the report. */
  export function reportMailer(binding: MailBinding | undefined): ReportMailer;
  export function creatorReportView(r: Report): { id; target; about: { member_id; label } | null; reason; note; at; resolved };
  export function operatorReportView(r: Report): { id; session_id; creator_id; target; about: { member_id; user_id; label } | null; reason; note; filed_by: { user_id; label }; at; resolved_at; resolution; resolved_by };
  ```
  In both views `target` is `{ kind: "room" } | { kind: "member", member_id } | { kind: "message", cursor }`, and times are ISO 8601 or null.
- `reportMail` copy, exactly:
  - The subject is `Bellman report ${id}: ${reason}, ${kind}`, where `kind` is `the room`, `a member` or `a message`.
  - The body's lines, in order:
    1. `Report ${id}, filed ${ISO at}.`
    2. `Room: ${sessionId} (creator ${creatorId})`
    3. One of `About: the room`, `Member: ${label} (${memberId}, ${userId})`, or `Message: cursor ${cursor}, from ${label} (${memberId}, ${userId})`.
    4. `Reason: ${reason}`
    5. `Filed by: ${reporterLabel} (${reporterUserId})`
    6. `Note (untrusted, as written):`, then the note or `(none)`.
    7. A blank line, then `Read the queue at GET /admin/reports, and close this report at POST /admin/reports/${id}/resolve.`
- Produces, in `src/rooms.ts`:
  ```ts
  /**
   * File a report (spec §3, R11), for both transports: who may report, what a target must be, the store's
   * fold and daily limit, and the email after a report is filed (never after a fold).
   */
  export async function fileRoomReport(
    store: BellmanStore, actor: Identity, sessionId: string,
    input: { memberId?: string; cursor?: number; reason: string; note?: string | null },
    mail: ReportMailer, now?: number,
  ): Promise<RoomResult<{ reportId: string; folded: boolean }>>;
  ```
  Refusals:
  - `not_found` "no such room, or no member of yours in it": no room, or no handle and not public.
  - `invalid`: a reason outside `REPORT_REASONS`; both `memberId` and `cursor`; a note over 500 characters once trimmed (an empty note is null); a member the room never seated; a cursor that is not a positive integer, or names no event, or names a `fromMemberId === "system"` event.
  - `rate_limited` with `retryAfter`: the store answered `limited`.

  The subject comes from `getMember`, or from the event's `fromMemberId`, `fromUserId` and `fromLabel`.
- `bellman_report` (registered after `bellman_public_name`; `buildServer`'s `features` gains `mailReport?: ReportMailer`, defaulting to `reportMailer(undefined)`; `Harness` gains `opts.mailReport`, passed through):
  - inputSchema: `...RoomRefShape, member_id: z.string().min(4).optional(), cursor: z.number().int().positive().optional(), reason: z.enum(REPORT_REASONS), note: z.string().max(500).optional()`.
  - annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false`.
  - Returns `{ report_id, folded }`, and `refusal(r)` on a refusal.
  - Description, exactly:
    ```
    Report a room, a member or a message to Bellman's operators. Give member_id (theirs) to report a member, cursor to report a message, or neither to report the room. A report about a member or a message also reaches the room's creator, who never sees who filed it. The person reported is not told.

    Args: session_id, member_id or cursor, reason (spam, harassment, impersonation, illegal, other), note (optional, at most 500 characters)
    Returns: { report_id, folded } — folded: true when you reported this already and it is still open; nothing new was filed.
    Errors: an account files at most 10 reports a day (rate_limited, with retry_after); you must hold or have held a seat in the room, unless it is public.
    ```
- `extension/manifest.json`: `{ "name": "bellman_report", "description": "Report a room, a member or a message to Bellman." }`, after `bellman_public_name`'s entry.

- [ ] **Step 1: Write the failing tests.** Append to `tests/reports.test.ts` (imports: `vi`, `reportMail`, `reportMailer`, `type Report`):

```ts
describe("the report's email (spec §3)", () => {
  const report: Report = {
    id: "rpt_000001792108523622_ab12cd34", sessionId: "qs_1", creatorId: "u_jesse",
    target: { kind: "message", cursor: 12 }, subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
    reason: "harassment", note: "line one\r\nSubject: forged\r\n<b>bold</b>",
    reporterUserId: "u_reader", reporterLabel: "reader@example.dev",
    at: Date.UTC(2026, 9, 15), resolvedAt: null, resolution: null, resolvedBy: null,
  };

  /** Review Focus 4. */
  it("builds the subject from closed sets, and carries the note in the body as written", () => {
    const mail = reportMail(report);
    expect(mail.subject).toBe("Bellman report rpt_000001792108523622_ab12cd34: harassment, a message");
    expect(mail.text).toContain("line one\r\nSubject: forged\r\n<b>bold</b>");
    expect(mail.text).toContain("Room: qs_1 (creator u_jesse)");
    expect(mail.text).toContain("Message: cursor 12, from peer@codenerd (m_peer, u_peer)");
    expect(mail.text).toContain("Filed by: reader@example.dev (u_reader)");
  });

  it("sends one message from reports@ to support@, and logs a failure or a missing binding without throwing", async () => {
    const sent: unknown[] = [];
    await reportMailer({ send: async (m) => sent.push(m) })(report);
    expect(sent).toEqual([{ from: "reports@bellman.sh", to: "support@bellman.sh", ...reportMail(report) }]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reportMailer({ send: async () => { throw new Error("not verified"); } })(report)).resolves.toBeUndefined();
    await expect(reportMailer(undefined)(report)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
```

Create `tests/tools/report.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "../../src/reports.js";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
let mailed: Report[];
const harness = () => {
  mailed = [];
  h = new Harness(undefined, undefined, { mailReport: async (r) => { mailed.push(r); } });
  return h;
};
afterEach(async () => {
  await h.close();
});

describe("bellman_report (spec §3)", () => {
  it("files a report about a member, mails it once, and folds a repeat without mailing again", async () => {
    const s = await pairUp(harness());
    const out = await s.joiner.call("bellman_report", { session_id: s.sessionId, member_id: s.creatorMemberId, reason: "spam", note: " ads " });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toEqual({ report_id: expect.stringMatching(/^rpt_/), folded: false });
    const again = await s.joiner.call("bellman_report", { session_id: s.sessionId, member_id: s.creatorMemberId, reason: "spam" });
    expect(again.data).toEqual({ report_id: out.data.report_id, folded: true });
    expect(mailed.map((r) => r.id)).toEqual([out.data.report_id]);
    expect((await h.store.listReports(10))[0]).toMatchObject({
      target: { kind: "member", memberId: s.creatorMemberId }, subject: { userId: "u_jesse", label: "jesse@codenerd" },
      reporterUserId: "u_peer", creatorId: "u_jesse", note: "ads",
    });
  });

  it("reports a message by its cursor, naming its sender, and the room with neither", async () => {
    const s = await pairUp(harness());
    const sent = await s.creator.call("bellman_send", { session_id: s.sessionId, member_id: s.creatorMemberId, type: "message", payload: { text: "buy now" } });
    expect((await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor: sent.data.cursor, reason: "spam" })).isError).toBe(false);
    expect((await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "other", note: "the purpose" })).isError).toBe(false);
    const reports = await h.store.listReports(10);
    expect(reports.map((r) => r.target)).toEqual(expect.arrayContaining([{ kind: "room" }, { kind: "message", cursor: sent.data.cursor }]));
    expect(reports.find((r) => r.target.kind === "message")?.subject).toMatchObject({ memberId: s.creatorMemberId, label: "jesse@codenerd" });
  });

  it("refuses both member_id and cursor, a cursor with no event, a member the room never seated, and a stranger, filing nothing", async () => {
    const s = await pairUp(harness());
    for (const args of [{ member_id: s.creatorMemberId, cursor: 1 }, { cursor: 9_999 }, { member_id: "m_nobody" }]) {
      const r = await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "spam", ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_report", { session_id: s.sessionId, reason: "spam" })).isError).toBe(true);
    expect(await h.store.listReports(10)).toEqual([]);
    expect(mailed).toEqual([]);
  });
});
```

Then update the tool-surface lists and counts named under Files.

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/reports.test.ts tests/tools/report.test.ts tests/tools/surface.test.ts tests/extension.test.ts`. Expected: FAIL. The tool and the functions do not exist yet.

- [ ] **Step 3: Implement** to the Interfaces above. The route uses `fileRoomReport` in Task 11.

- [ ] **Step 4: Run to see them pass.** The command from Step 2, then `npx vitest run tests/http.test.ts tests/bridge.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "bellman_report files a report about a room, a member or a message, and emails support"`

### Task 11: The report routes and the email binding

**Files:**
- Modify: `src/http/moderation.ts`, `src/oauth/routes.ts`, `src/worker.ts`, `src/app.ts`, `wrangler.toml`
- Test: `tests/http-moderation.test.ts`, `tests/http-admin.test.ts`, `worker-tests/moderation-routes.test.ts`

**Interfaces:**
- Consumes: `fileRoomReport`, `reportMailer`, `creatorReportView`, `operatorReportView` (Task 10); `roomReports`, `listReports`, `resolveReport` (Task 9); `operatorGate` (Task 5).
- Produces:
  - `ModerationDeps.mailReport?: ReportMailer`. When it is absent the route uses `reportMailer(undefined)`, which files the report and logs that no email went.
  - `// ponytail: 4 KB, not tuned. A 500-character note escapes to at most about 3 KB of JSON.` `export const MAX_REPORT_BYTES = 4096`.
  - `PlanStore` gains `"listReports" | "resolveReport"`, and `MAX_REPORTS_LISTED = 200`.
  - `WorkerEnv.SEND_EMAIL?: SendEmail`. The Worker builds `reportMailer(env.SEND_EMAIL)` once per request and hands it to `buildServer` and to `moderationRoutes`. The Node app hands `reportMailer(undefined)`.

  | Route | Who | Answer |
  |---|---|---|
  | `POST /rooms/:id/reports` `{ member_id?, cursor?, reason, note? }` | anyone signed in, CSRF | 201 `{ report_id, folded: false }`, 200 `{ report_id, folded: true }`, 429 with `Retry-After` |
  | `GET /rooms/:id/reports` | creator | 200 `{ reports: creatorReportView[] }`, newest first |
  | `GET /admin/reports` | operator | 200 `{ reports: operatorReportView[] }` |
  | `POST /admin/reports/:id/resolve` `{ note }` | operator | 200 `{ report }`; 400 for a note not 1–500 characters; 404 unknown |

- `wrangler.toml`:
  ```toml
  # Reports email support@ (abuse protections spec §3). Email Routing on bellman.sh, with support@ a verified
  # destination, comes first: a send_email binding sends only to verified destinations.
  [[send_email]]
  name = "SEND_EMAIL"
  destination_address = "support@bellman.sh"
  ```

- [ ] **Step 1: Write the failing tests.** In `tests/http-moderation.test.ts`:
  - Add `let mailed: string[]`, reset to `[]` in `beforeEach`.
  - Have `call` pass `mailReport: async (r) => { mailed.push(r.id); }` in its deps.
  - Import `session` and `member` as already imported, and `type Report` if the callback is typed.

  Then append:

```ts
describe("a room's reports", () => {
  const report = (key: string | null, body: unknown, over: { cookie?: string; origin?: string } = {}) =>
    call(key, `/rooms/${ROOM}/reports`, { method: "POST", body, ...over });

  it("files a public room reader's report, mails it once, and shows the creator what it is about and never who filed it", async () => {
    const filed = await report(DEV_KEY.outsider, { member_id: "m_peer", reason: "harassment", note: "<b>not markup</b>" });
    const [status, made] = await answer(filed);
    expect([status, made]).toEqual([201, { report_id: expect.stringMatching(/^rpt_/), folded: false }]);
    expect(mailed).toEqual([(made as { report_id: string }).report_id]);
    const [listed, body] = await answer(await call(DEV_KEY.jesse, `/rooms/${ROOM}/reports`));
    expect(listed).toBe(200);
    expect(body).toEqual({ reports: [{
      id: expect.stringMatching(/^rpt_/), target: { kind: "member", member_id: "m_peer" }, about: { member_id: "m_peer", label: "peer@codenerd" },
      reason: "harassment", note: "<b>not markup</b>", at: expect.any(String), resolved: false,
    }] });
    expect(JSON.stringify(body)).not.toContain("outsider");
  });

  it("folds a repeat: 200, the first report's id, and no second email", async () => {
    const [, first] = await answer(await report(DEV_KEY.peer, { reason: "spam" }));
    expect(await answer(await report(DEV_KEY.peer, { reason: "spam", note: "again" })))
      .toEqual([200, { report_id: (first as { report_id: string }).report_id, folded: true }]);
    expect(mailed).toHaveLength(1);
  });

  it("answers the eleventh report in a day 429 with Retry-After, and files nothing for it", async () => {
    for (let i = 0; i < 8; i++) {
      await store.appendEvent(ROOM, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: `m${i}` }, refId: null });
    }
    const targets = [{}, { member_id: "m_peer" }, { member_id: "m_creator" }, ...[1, 2, 3, 4, 5, 6, 7].map((cursor) => ({ cursor }))];
    for (const t of targets) expect((await report(DEV_KEY.peer, { ...t, reason: "spam" }))!.status, JSON.stringify(t)).toBe(201);
    const limited = (await report(DEV_KEY.peer, { cursor: 8, reason: "spam" }))!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(86_000);
    expect(await store.listReports(50)).toHaveLength(10);
  });

  it("refuses a stranger to a private room as it refuses a missing one, a target the room lacks, and a cookie report without the panel's Origin, filing nothing", async () => {
    await store.createSession(session({ id: "qs_private", members: [member(), peer()] }));
    await store.appendEvent(ROOM, { type: "invite_revoked", fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: {}, refId: null });
    expect((await call(DEV_KEY.outsider, "/rooms/qs_private/reports", { method: "POST", body: { reason: "spam" } }))!.status).toBe(404);
    expect((await call(DEV_KEY.outsider, "/rooms/qs_nowhere/reports", { method: "POST", body: { reason: "spam" } }))!.status).toBe(404);
    for (const body of [
      { member_id: "m_nobody", reason: "spam" }, { cursor: 99, reason: "spam" }, { cursor: 1, reason: "spam" },
      { reason: "rude" }, { member_id: "m_peer", cursor: 1, reason: "spam" }, { reason: "spam", note: "x".repeat(501) },
    ]) {
      expect((await report(DEV_KEY.peer, body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await report(null, { reason: "spam" }, { cookie: DEV_KEY.peer }))!.status).toBe(403);
    expect((await report(null, { reason: "spam" }))!.status).toBe(401);
    expect(await store.listReports(50)).toEqual([]);
    expect(mailed).toEqual([]);
  });

  it("shows a room's reports to its creator alone", async () => {
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/reports`))!.status).toBe(403);
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/reports`))!.status).toBe(404);
  });
});
```

Append to `tests/http-admin.test.ts` (import `type Report` from `../src/reports.js`):

```ts
describe("/admin/reports and /admin/reports/:id/resolve", () => {
  const file = async () => ((await store.fileReport({
    sessionId: "qs_1", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "illegal",
    note: "see the surface", reporterUserId: "u_reader", reporterLabel: "reader@example.dev",
  }, Date.now())) as { report: Report }).report;

  it("lists every report with who filed it, a room report included, and resolves one with a note", async () => {
    const report = await file();
    const auth = await bearer(OPERATOR);
    const listed = await send("GET", "/admin/reports", auth);
    expect([listed.status, await listed.json()]).toEqual([200, { reports: [expect.objectContaining({
      id: report.id, session_id: "qs_1", target: { kind: "room" }, about: null, reason: "illegal", note: "see the surface",
      filed_by: { user_id: "u_reader", label: "reader@example.dev" }, resolved_at: null,
    })] }]);
    expect((await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "" })).status).toBe(400);
    const resolved = await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "removed the item" });
    expect([resolved.status, await resolved.json()]).toEqual([200, { report: expect.objectContaining({
      id: report.id, resolution: "removed the item", resolved_by: "u_operator", resolved_at: expect.any(String),
    }) }]);
    expect((await send("POST", "/admin/reports/rpt_000000000000000_00000000/resolve", auth, { note: "x" })).status).toBe(404);
  });

  it("lets no one else read or resolve the queue", async () => {
    const report = await file();
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("GET", "/admin/reports", await bearer(OPERATOR), undefined, closed)).status).toBe(403);
    }
    expect((await send("GET", "/admin/reports", await bearer(TEAM_ADMIN, "operator"))).status).toBe(403);
    expect((await send("POST", `/admin/reports/${report.id}/resolve`, await bearer(TEAM_ADMIN, "operator"), { note: "x" })).status).toBe(403);
    expect((await store.listReports(10))[0].resolvedAt).toBeNull();
  });
});
```

Append inside `worker-tests/moderation-routes.test.ts`'s `describe`:

```ts
  it("files a report at /rooms/:id/reports over the real registry, mails it once through SEND_EMAIL, and the creator reads it", async () => {
    await seed();
    const sent: unknown[] = [];
    const mailEnv = { ...env, SEND_EMAIL: { send: async (m: unknown) => { sent.push(m); return { messageId: "m1" }; } } } as unknown as Parameters<typeof worker.fetch>[1];
    const filed = await call("/rooms/qs_wire_mod/reports", { method: "POST", body: JSON.stringify({ member_id: "m_peer", reason: "spam", note: "ads" }) }, mailEnv);
    expect(filed.status, await filed.clone().text()).toBe(201);
    expect(sent).toEqual([expect.objectContaining({ from: "reports@bellman.sh", to: "support@bellman.sh" })]);
    const listed = (await (await call("/rooms/qs_wire_mod/reports", {}, mailEnv)).json()) as { reports: { reason: string }[] };
    expect(listed.reports.map((r) => r.reason)).toEqual(["spam"]);
  });

  it("lists the queue at /admin/reports and resolves one at /admin/reports/:id/resolve for a listed operator", async () => {
    const filed = await store().fileReport({
      sessionId: "qs_wire_mod", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "illegal",
      note: null, reporterUserId: "u_reader", reporterLabel: "reader@x",
    }, Date.now());
    const id = (filed as { report: { id: string } }).report.id;
    const auth = { authorization: `Bearer ${await tokenFor(OPERATOR)}`, "content-type": "application/json" };
    const listed = await worker.fetch(new Request(`${ORIGIN}/admin/reports`, { headers: auth }), oauthEnv(), ctx);
    expect(((await listed.json()) as { reports: { id: string }[] }).reports.map((r) => r.id)).toEqual([id]);
    const resolved = await worker.fetch(new Request(`${ORIGIN}/admin/reports/${id}/resolve`, {
      method: "POST", headers: auth, body: JSON.stringify({ note: "handled" }),
    }), oauthEnv(), ctx);
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect((await store().listReports(10))[0].resolvedAt).not.toBeNull();
  });
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/http-moderation.test.ts tests/http-admin.test.ts`. Expected: FAIL, 404 and `undefined` answers.

- [ ] **Step 3: Implement** to the table.
  - **The POST body:** an object whose `member_id` is a string when present, `cursor` a number when present, `reason` a string and `note` a string when present, else 400. The rest is `fileRoomReport`'s to refuse.
  - **A refusal:** answer `problem(STATUS[code], code, reason, origin)`. A `rate_limited` one also carries `retry-after: String(retryAfter)` and `retry_after` in the JSON.
  - **The creator list's refusals:** the order the ban routes use.
  - **Admin routes:** `operatorGate(request, config, "reading reports")` and `"resolving a report"`. Path patterns: `path === "/admin/reports"` and `/^\/admin\/reports\/([^/]+)\/resolve$/`. Order: gate, method, `config.plans`, body.
  - **`SEND_EMAIL`:** pass it straight to `reportMailer`. If `typecheck:worker` refuses its overloads against `MailBinding`, wrap it as `{ send: (m) => env.SEND_EMAIL!.send(m) }`.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/http-moderation.test.ts tests/http-admin.test.ts`, then `npm run build:ui && npm --prefix worker-tests run test -- moderation-routes.test.ts`. Expected: PASS. Then `npx wrangler deploy --dry-run --outdir "$(mktemp -d)"`. Expected: it bundles with the `SEND_EMAIL` binding listed, and no error.

- [ ] **Step 5: Commit.** `jj commit -m "Reports over HTTP: a reader files one, the creator reads their room's, and the operator works the queue"`

### Task 12: Docs for reports

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`. No test: this task changes prose.

- [ ] **Step 1:** README:
  - Add the `bellman_report` row to the tool table, and `bellman_public_name`'s, which the table lacks, so it lists every tool.
  - Add the report routes and the two admin report routes.
  - Add a "Reports" bullet under Trust model.
  - Under Run it, a line: before reports ship, Email Routing on bellman.sh with support@ verified, and `BELLMAN_OPERATORS` set.
- [ ] **Step 2:** ARCHITECTURE:
  - §7: a bullet saying a report's note is untrusted text, shown as text in the dash and sent as plain text in the email, and that its subject is built from closed sets.
  - §11: the measurement (Task 6 Step 3) for `bellman_report`, with the total before and after.
  - Check that `bellman_report`'s description is the shortest that says its rules. If the measurement puts it past 300 tokens, cut the description, not the rules.
- [ ] **Step 3: Verify and commit.** `npm run verify`. Expected: green. `jj commit -m "The docs for reports, and the tool listing measured"`

- [ ] **Part 1 done:** one whole-branch review of Part 1, then the PRs in section order.

---

# Part 2 — the dash

**Workspace:** `git -C /Users/mcfearsome/src/github.com/bellman-sh/dash fetch origin && git -C /Users/mcfearsome/src/github.com/bellman-sh/dash worktree add /Users/mcfearsome/.worktrees/dash-abuse -b mcfearsome/abuse-protections origin/main`, then `cd /Users/mcfearsome/.worktrees/dash-abuse && npm ci`. It gets its own install, not a symlinked `node_modules`. Commits are git, signed. Every task's check is `npx vitest run <file>`, and the part ends with `npm test && npm run lint && npm run typecheck && npm run build`. The tests stub `fetch`, so this part needs no running server; its wire shapes are Part 1's Interfaces.

Follow each file's own style: semicolons or none, and quote style. Peer content and report notes are rendered as React text, never as markup.

### Task D1: The API client

**Files:** Modify `src/lib/api.ts`; Test `src/lib/api.test.ts`.

**Interfaces (produces):**
```ts
/** Mirrors `banView` in the Worker's src/bans.ts: never the account's user id. */
export interface Ban { ban_id: string; label: string; at: string }
/** Mirrors `creatorBanView`: a ban from every room the person owns, with the room it was made in. */
export interface CreatorBan extends Ban { session_id: string }
export const REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Mirrors `creatorReportView` in the Worker's src/reports.ts: never who filed it. */
export interface RoomReport {
  id: string;
  target: { kind: "member"; member_id: string } | { kind: "message"; cursor: number };
  about: { member_id: string; label: string } | null;
  reason: ReportReason; note: string | null; at: string; resolved: boolean;
}
export const getRoomBans: (id: string) => Promise<Ban[]>;                          // GET /rooms/:id/bans
export const banMember: (id: string, memberId: string, scope: "room" | "all") => Promise<void>;  // POST /rooms/:id/bans
export const liftRoomBan: (id: string, banId: string) => Promise<void>;            // DELETE /rooms/:id/bans/:banId
export const getRoomReports: (id: string) => Promise<RoomReport[]>;                // GET /rooms/:id/reports
/** With the cookie, from a public page too: a report is filed as the person signed in. */
export const fileReport: (id: string, report: { member_id?: string; cursor?: number; reason: ReportReason; note?: string }) => Promise<{ report_id: string; folded: boolean }>;
export const getAccountBans: () => Promise<CreatorBan[]>;                          // GET /account/bans
export const liftAccountBan: (banId: string) => Promise<void>;                     // DELETE /account/bans/:banId
```

- [ ] **Step 1: Write the failing tests** in `src/lib/api.test.ts` (extend its import list):

```ts
  it("reads and lifts a room's bans, and bans a member by scope", async () => {
    next = answer(200, { bans: [{ ban_id: "ban_1", label: "peer@x", at: "2026-10-15T00:00:00.000Z" }] });
    expect(await getRoomBans("qs 1")).toEqual([{ ban_id: "ban_1", label: "peer@x", at: "2026-10-15T00:00:00.000Z" }]);
    expect(calls[0].url).toBe(`${API_ORIGIN}/rooms/qs%201/bans`);
    next = answer(204);
    await liftRoomBan("qs_1", "ban_1");
    expect([calls[1].url, calls[1].init.method]).toEqual([`${API_ORIGIN}/rooms/qs_1/bans/ban_1`, "DELETE"]);
    next = answer(200, { evicted: true, code_retired: null, session_status: "active", banned: "all" });
    await banMember("qs_1", "m_peer", "all");
    expect([calls[2].url, calls[2].init.method, calls[2].init.body]).toEqual([`${API_ORIGIN}/rooms/qs_1/bans`, "POST", JSON.stringify({ member_id: "m_peer", scope: "all" })]);
  });

  it("files a report with the cookie, and reads a room's reports and a creator's bans", async () => {
    next = answer(201, { report_id: "rpt_1", folded: false });
    expect(await fileReport("qs_1", { cursor: 4, reason: "spam" })).toEqual({ report_id: "rpt_1", folded: false });
    expect([calls[0].url, calls[0].init.method, calls[0].init.credentials, calls[0].init.body])
      .toEqual([`${API_ORIGIN}/rooms/qs_1/reports`, "POST", "include", JSON.stringify({ cursor: 4, reason: "spam" })]);
    next = answer(200, { reports: [] });
    expect(await getRoomReports("qs_1")).toEqual([]);
    next = answer(200, { bans: [] });
    expect(await getAccountBans()).toEqual([]);
    expect(calls[2].url).toBe(`${API_ORIGIN}/account/bans`);
    next = answer(204);
    await liftAccountBan("ban_9");
    expect([calls[3].url, calls[3].init.method]).toEqual([`${API_ORIGIN}/account/bans/ban_9`, "DELETE"]);
  });
```

- [ ] **Step 2:** `npx vitest run src/lib/api.test.ts`. Expected: FAIL, the functions do not exist.
- [ ] **Step 3:** Implement them over `request`. JSON bodies carry `content-type: application/json`.
- [ ] **Step 4:** `npx vitest run src/lib/api.test.ts`. Expected: PASS.
- [ ] **Step 5:** `git add src/lib/api.ts src/lib/api.test.ts && git commit -m "The client reads and sets bans, and files and reads reports"`

### Task D2: The room's moderation, for its creator

**Files:** Create `src/components/room/moderation.tsx`, `src/components/room/moderation.test.tsx`; Modify `src/components/canvas/side-panel.tsx`, `src/components/canvas/side-panel.test.tsx`.

**Interfaces:**
- Produces: `export function Moderation({ roomId }: { roomId: string })`.
- It has two sections. **Reports:** each shows its reason, `about.label`, its time and its note as text in a `whitespace-pre-wrap break-words` paragraph. A report with an `about` gets two buttons, "Ban from this room" and "Ban from all your rooms", with aria-labels `Ban ${label} from this room` and `Ban ${label} from all your rooms`. **Bans:** each shows its label and time, and a "Lift" button with the aria-label `Lift the ban on ${label}`.
- After a ban it reads the bans again; after a lift it drops the row. A failed call shows its message in a `role="alert"` paragraph.
- Under the Bans heading, the text: `Settings lists a ban from all your rooms; lifting one here leaves that one.`
- `SidePanel` renders `<Moderation roomId={detail.id} />` as its last section when `detail.mine` is true.

- [ ] **Step 1: Write the failing tests.** `src/components/room/moderation.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Moderation } from "@/components/room/moderation";
import * as api from "@/lib/api";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("the test reached the network");
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const report = (over: Partial<api.RoomReport> = {}): api.RoomReport => ({
  id: "rpt_1", target: { kind: "message", cursor: 4 }, about: { member_id: "m_peer", label: "peer@codenerd" },
  reason: "spam", note: "<b>buy now</b>", at: "2026-10-15T12:00:00.000Z", resolved: false, ...over,
});

describe("a room's moderation, for its creator", () => {
  it("shows a report's note as text, bans the member it is about from the room, and lists the ban", async () => {
    vi.spyOn(api, "getRoomReports").mockResolvedValue([report()]);
    const bans = vi.spyOn(api, "getRoomBans").mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ban_id: "ban_1", label: "peer@codenerd", at: "2026-10-15T12:01:00.000Z" }]);
    const ban = vi.spyOn(api, "banMember").mockResolvedValue();
    render(<Moderation roomId="qs_1" />);
    expect(await screen.findByText("<b>buy now</b>")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ban peer@codenerd from this room" }));
    expect(ban).toHaveBeenCalledWith("qs_1", "m_peer", "room");
    expect(await screen.findByRole("button", { name: "Lift the ban on peer@codenerd" })).toBeInTheDocument();
    expect(bans).toHaveBeenCalledTimes(2);
  });

  it("bans from all your rooms, and says Settings lists that ban", async () => {
    vi.spyOn(api, "getRoomReports").mockResolvedValue([report({ target: { kind: "member", member_id: "m_peer" }, note: null })]);
    vi.spyOn(api, "getRoomBans").mockResolvedValue([]);
    const ban = vi.spyOn(api, "banMember").mockResolvedValue();
    render(<Moderation roomId="qs_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ban peer@codenerd from all your rooms" }));
    expect(ban).toHaveBeenCalledWith("qs_1", "m_peer", "all");
    expect(screen.getByText(/Settings lists a ban from all your rooms/)).toBeInTheDocument();
  });

  it("lifts a ban and drops it from the list, and shows a refusal as an alert", async () => {
    vi.spyOn(api, "getRoomReports").mockResolvedValue([]);
    vi.spyOn(api, "getRoomBans").mockResolvedValue([{ ban_id: "ban_1", label: "peer@codenerd", at: "2026-10-15T12:01:00.000Z" }]);
    const lift = vi.spyOn(api, "liftRoomBan").mockRejectedValueOnce(new api.ApiError(409, "conflict", "try again")).mockResolvedValue();
    render(<Moderation roomId="qs_1" />);
    const button = await screen.findByRole("button", { name: "Lift the ban on peer@codenerd" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("try again");
    fireEvent.click(button);
    expect(lift).toHaveBeenLastCalledWith("qs_1", "ban_1");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Lift the ban on peer@codenerd" })).not.toBeInTheDocument());
  });
});
```

In `src/components/canvas/side-panel.test.tsx`, add at the top `vi.mock("@/components/room/moderation", () => ({ Moderation: ({ roomId }: { roomId: string }) => <p>moderation for {roomId}</p> }));`, and:

```tsx
  it("shows the room's moderation to its creator and to no one else", () => {
    const { rerender } = render(<SidePanel detail={roomDetail({ mine: true })} items={[]} onLocate={vi.fn()} />);
    expect(screen.getByText("moderation for qs_1")).toBeInTheDocument();
    rerender(<SidePanel detail={roomDetail({ mine: false })} items={[]} onLocate={vi.fn()} />);
    expect(screen.queryByText("moderation for qs_1")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2:** `npx vitest run src/components/room/moderation.test.tsx src/components/canvas/side-panel.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement to the Interfaces.
- [ ] **Step 4:** The same command. Expected: PASS.
- [ ] **Step 5:** `git add src/components && git commit -m "A room's creator reads its reports, bans from them, and lifts bans, on the room's page"`

### Task D3: Settings lists bans from every room

**Files:** Create `src/components/settings/bans-section.tsx`, `src/components/settings/bans-section.test.tsx`; Modify `src/routes/settings.tsx`.

**Interfaces:**
- Produces: `export function BansSection()`. It reads `getAccountBans()` at mount. Each ban shows its label, its time, a plain link `<a href={`/rooms/${session_id}`}>the room</a>`, and a "Lift" button with the aria-label `Lift the ban on ${label}`. With none it says `You have banned no one from all your rooms.`.
- The heading is "Bans from all your rooms". Settings renders it after `<HandleSection />`.

- [ ] **Step 1: Write the failing tests:**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BansSection } from "@/components/settings/bans-section";
import * as api from "@/lib/api";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("the test reached the network");
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bans from all your rooms, in Settings", () => {
  it("lists each ban with the room it was made in, and lifts one", async () => {
    vi.spyOn(api, "getAccountBans").mockResolvedValue([{ ban_id: "ban_1", label: "peer@codenerd", at: "2026-10-15T12:01:00.000Z", session_id: "qs_1" }]);
    const lift = vi.spyOn(api, "liftAccountBan").mockResolvedValue();
    render(<BansSection />);
    expect(await screen.findByText("peer@codenerd")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "the room" })).toHaveAttribute("href", "/rooms/qs_1");
    fireEvent.click(screen.getByRole("button", { name: "Lift the ban on peer@codenerd" }));
    expect(lift).toHaveBeenCalledWith("ban_1");
    await waitFor(() => expect(screen.queryByText("peer@codenerd")).not.toBeInTheDocument());
  });

  it("says when there are none", async () => {
    vi.spyOn(api, "getAccountBans").mockResolvedValue([]);
    render(<BansSection />);
    expect(await screen.findByText("You have banned no one from all your rooms.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** `npx vitest run src/components/settings/bans-section.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement; mount in `Settings`.
- [ ] **Step 4:** The same command. Expected: PASS.
- [ ] **Step 5:** `git add src && git commit -m "Settings lists the bans a person made from all their rooms, and lifts them"`

### Task D4: Report from a public room's page

**Files:** Create `src/components/room/report-form.tsx`, `src/components/room/report-form.test.tsx`; Modify `src/components/room/room-log.tsx`, `src/components/room/room-log.test.tsx`, `src/routes/public-room.tsx`, `src/routes/public-room.test.tsx`.

**Interfaces:**
- Produces:
  ```tsx
  export type ReportTarget = { kind: "room" } | { kind: "message"; cursor: number; memberId: string; label: string };
  export function ReportForm({ roomId, target, onDone }: { roomId: string; target: ReportTarget; onDone: () => void });
  ```
  - **Fields:** a select labelled `Reason`, of `REPORT_REASONS`, `spam` first. A textarea labelled `Note (optional)`, `maxLength={500}`. For a message target, two radios: `This message` (checked) and `Who sent it (${label})`. A submit button, `Send report`, and a `Cancel` button that calls `onDone`.
  - **The body:** `{ reason }`, plus `cursor` for this message or `member_id` for who sent it, plus `note` when it is not blank.
  - **Answers:** filed shows `Reported. Bellman's operators will read it.` in `role="status"`. Folded shows `You reported this already.` there. A 401 shows a link `Sign in to report` to `signInUrl(window.location.href)`. A 429 shows `You have filed 10 reports today. Try again tomorrow.` in `role="alert"`. Any other error shows its message there.
- `LogList` gains `onReport?: (e: RoomEvent) => void`. When given, each event whose `from.member_id` is not `"system"` gets a `Report` button with the aria-label `Report event ${cursor}`. `RoomLog` passes none.
- `PublicRoom`: a `Report this room` button in the header opens `<ReportForm target={{ kind: "room" }} />` below it. `PublicLog` passes `onReport`, which opens a message `ReportForm` above the list for that event.

- [ ] **Step 1: Write the failing tests.** `src/components/room/report-form.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportForm } from "@/components/room/report-form";
import * as api from "@/lib/api";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("the test reached the network");
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the report form", () => {
  it("reports who sent a message, with the reason and the note", async () => {
    const file = vi.spyOn(api, "fileReport").mockResolvedValue({ report_id: "rpt_1", folded: false });
    render(<ReportForm roomId="qs_1" target={{ kind: "message", cursor: 4, memberId: "m_peer", label: "member 2" }} onDone={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Who sent it (member 2)"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "harassment" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "<b>repeatedly</b>" } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(file).toHaveBeenCalledWith("qs_1", { member_id: "m_peer", reason: "harassment", note: "<b>repeatedly</b>" });
    expect(await screen.findByRole("status")).toHaveTextContent("Reported. Bellman's operators will read it.");
  });

  it("reports the message itself by default, with no note when none was written", async () => {
    const file = vi.spyOn(api, "fileReport").mockResolvedValue({ report_id: "rpt_1", folded: false });
    render(<ReportForm roomId="qs_1" target={{ kind: "message", cursor: 4, memberId: "m_peer", label: "member 2" }} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(file).toHaveBeenCalledWith("qs_1", { cursor: 4, reason: "spam" });
  });

  it("asks a reader who is not signed in to sign in, and says when it is a repeat or past the day's limit", async () => {
    const file = vi.spyOn(api, "fileReport").mockRejectedValueOnce(new api.ApiError(401, "unauthorized", "sign in"));
    render(<ReportForm roomId="qs_1" target={{ kind: "room" }} onDone={vi.fn()} />);
    const send = screen.getByRole("button", { name: "Send report" });
    fireEvent.click(send);
    expect(await screen.findByRole("link", { name: "Sign in to report" })).toHaveAttribute("href", api.signInUrl(window.location.href));
    file.mockResolvedValueOnce({ report_id: "rpt_1", folded: true });
    fireEvent.click(send);
    expect(await screen.findByRole("status")).toHaveTextContent("You reported this already.");
    file.mockRejectedValueOnce(new api.ApiError(429, "rate_limited", "ten a day"));
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("You have filed 10 reports today. Try again tomorrow.");
  });

  it("caps the note at 500 characters", () => {
    render(<ReportForm roomId="qs_1" target={{ kind: "room" }} onDone={vi.fn()} />);
    expect(screen.getByLabelText("Note (optional)")).toHaveAttribute("maxLength", "500");
  });
});
```

In `src/components/room/room-log.test.tsx` (add `fireEvent` and `vi` to its imports):

```tsx
  it("offers a report on each event a member sent, when the page asks for one", () => {
    const system: Envelope<RoomEvent> = { ...ev(2, "invite_revoked", {}), data: { ...ev(2, "invite_revoked", {}).data, from: { member_id: "system", label: "jesse@codenerd" } } };
    const onReport = vi.fn();
    render(<LogList events={[ev(1, "message", { text: "spam" }), system]} onReport={onReport} />);
    const buttons = screen.getAllByRole("button", { name: /^Report event/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ cursor: 1 }));
  });

  it("offers no report when the page asks for none", () => {
    render(<LogList events={[ev(1, "message", { text: "hi" })]} />);
    expect(screen.queryByRole("button", { name: /^Report event/ })).not.toBeInTheDocument();
  });
```

In `src/routes/public-room.test.tsx` (add `fireEvent` to its imports, and `vi.mock("@/components/room/report-form", () => ({ ReportForm: ({ target }: { target: { kind: string } }) => <p>report form for the {target.kind}</p> }))`), appended after the existing case:

```tsx
  it("opens the report form for the room from its header", () => {
    state.view = undefined
    render(<PublicRoom />)
    fireEvent.click(screen.getByRole("button", { name: "Report this room" }))
    expect(screen.getByText("report form for the room")).toBeInTheDocument()
  })
```

- [ ] **Step 2:** `npx vitest run src/components/room src/routes/public-room.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement to the Interfaces.
- [ ] **Step 4:** The same command, then `npm test && npm run lint && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5:** `git add src && git commit -m "A signed-in reader reports a public room, a message in it, or who sent it"`

- [ ] **Part 2 done:** one whole-branch review; the PR merges after Part 1's routes deploy.

---

# Part 3 — the site

**Workspace:** `git -C /Users/mcfearsome/src/github.com/bellman-sh/site fetch origin && git -C /Users/mcfearsome/src/github.com/bellman-sh/site worktree add /Users/mcfearsome/.worktrees/site-abuse -b mcfearsome/abuse-protections origin/main`. The pages are hand-written: match each page's markup, tone and apostrophe style, and keep the one header and footer (`tools/test_sitenav.py`). Checks: `python3 -m unittest discover -s tools -p 'test_*.py'` and `node --test tools/worker.test.mjs`. Every fact must trace to Part 1's code.

### Task S1: The trust page and the docs page

**Files:** Create `tools/test_abuse_pages.py`; Modify `public/trust.html`, `public/docs.html`.

- [ ] **Step 1: Write the failing test:**

```python
"""The abuse protections as the site states them (bellman's abuse protections spec): each fact the server pins,
on the page that promises it. Run: python3 -m unittest discover -s tools -p 'test_*.py'"""

import html
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def text(page: str) -> str:
    raw = (ROOT / "public" / page).read_text(encoding="utf-8")
    words = html.unescape(re.sub(r"<[^>]+>", " ", raw)).replace(chr(0x2019), "'")
    return re.sub(r"\s+", " ", words)


class TestTrustPage(unittest.TestCase):
    def test_says_how_bans_work(self):
        t = text("trust.html")
        for fact in ["from that room, or from every room they own", "You can't join this room.", "removes nothing from the room's log"]:
            self.assertIn(fact, t)

    def test_states_the_send_limits(self):
        t = text("trust.html")
        self.assertIn("30 times a minute", t)
        self.assertIn("6 times a minute", t)

    def test_says_who_reads_a_report(self):
        t = text("trust.html")
        for fact in ["10 reports a day", "never sees who filed it", "500 characters", "This account is suspended."]:
            self.assertIn(fact, t)


class TestDocsPage(unittest.TestCase):
    def test_lists_every_tool_and_counts_them_truly(self):
        t = text("docs.html")
        for tool in ["bellman_report", "bellman_public_name"]:
            self.assertIn(tool, t)
        self.assertIn("The thirteen tools on the server", t)

    def test_names_bans_limits_and_reports_under_safety(self):
        t = text("docs.html")
        for fact in ["ban", "30 times a minute", "report"]:
            self.assertIn(fact, t)
```

- [ ] **Step 2:** `python3 -m unittest discover -s tools -p 'test_abuse_pages.py' -v`. Expected: FAIL.
- [ ] **Step 3: Write the copy.**
  - **`trust.html`:** three cards in the existing card markup, after "Per-connection handles".
    - **Bans:** "A room's creator can ban a member: from that room, or from every room they own, now and later. A banned account is refused at the join step, through any code, with "You can't join this room." It is not told who banned it or how widely. A ban is by account and removes nothing from the room's log. Bellman's operators can also suspend an account; a suspended account is refused on every call with "This account is suspended.""
    - **Send limits:** "A member sends at most 30 times a minute in a room. A member who joined a public room through its permanent link sends at most 6 times a minute. A send past the limit is refused with how long to wait, and nothing reaches the room."
    - **Reports:** "A member, or a signed-in reader of a public room, can report the room, a member or a message, with a reason and a note of up to 500 characters. Bellman's operators read every report. A report about a member or a message also reaches the room's creator, who never sees who filed it. An account can file 10 reports a day, and the person reported is not told."
  - **`docs.html`:**
    - Tools: rows for `bellman_public_name` ("Name a public room you created, so its link reads dash.bellman.sh/r/&lt;name&gt;.", Writes) and `bellman_report` ("Report a room, a member or a message to Bellman's operators.", Writes). The intro becomes "The thirteen tools on the server, and whether each one changes anything."
    - Manage the room: a card **Ban**, with the prompt "Remove the member in the peer_b seat and ban them from this room."
    - Safety: a paragraph on bans, the send limits (30 times a minute, 6 for a newcomer through a public room's permanent link) and reporting, ending "The full model is on the trust page."
- [ ] **Step 4:** `python3 -m unittest discover -s tools -p 'test_*.py'` and `node --test tools/worker.test.mjs`. Expected: PASS. Serve with `python3 -m http.server 4173 --directory public` and open `/trust` and `/docs`; every internal link resolves.
- [ ] **Step 5:** `git add tools/test_abuse_pages.py public/trust.html public/docs.html && git commit -m "The trust and docs pages say how bans, send limits and reports work, and /docs lists every tool"`

### Task S2: The privacy page

**Files:** Modify `public/privacy.html`, `tools/test_abuse_pages.py`.

- [ ] **Step 1: Write the failing test,** appended:

```python
class TestPrivacyPage(unittest.TestCase):
    def test_says_what_a_report_keeps_and_for_how_long(self):
        t = text("privacy.html")
        for fact in ["your account and your note", "180 days after it is resolved", "never sees who filed it"]:
            self.assertIn(fact, t)

    def test_says_what_a_ban_and_a_suspension_keep(self):
        t = text("privacy.html")
        for fact in ["the label it had in the room", "until the room's creator lifts it", "until it is lifted"]:
            self.assertIn(fact, t)
```

- [ ] **Step 2:** `python3 -m unittest discover -s tools -p 'test_abuse_pages.py' -v`. Expected: FAIL in `TestPrivacyPage`.
- [ ] **Step 3: Write the copy,** in the page's list style.
  - **What we collect:** "**Reports.** If you file one: your account and your note, the room, what you reported and why, and the account it is about."
  - **Who else sees it:** "**A room's creator**, for a report about a member or a message in their room: what it is about, the reason and the note. The creator never sees who filed it."
  - **How long we keep it:**
    - "**Reports.** A report keeps your account and your note, and the account it names, for 180 days after it is resolved, and is then deleted. A report not yet resolved is kept until it is."
    - "**Bans.** A ban keeps the banned account and the label it had in the room until the room's creator lifts it; a room's own bans go when the room is deleted."
    - "**Suspensions.** A suspension keeps the account and our note until it is lifted."
- [ ] **Step 4:** `python3 -m unittest discover -s tools -p 'test_*.py'`. Expected: PASS.
- [ ] **Step 5:** `git add tools/test_abuse_pages.py public/privacy.html && git commit -m "The privacy page says what a report, a ban and a suspension keep, and for how long"`

- [ ] **Part 3 done:** one whole-branch review; the PR merges once Part 1's reports section has shipped, since the pages describe it.
