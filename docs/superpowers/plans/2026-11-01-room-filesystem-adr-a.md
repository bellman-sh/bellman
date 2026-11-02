# Room Filesystem, ADR A (#430) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room files and agent memory at paths in a room, plus a read-only `/.bellman/` view of governed config, through one new tool, `bellman_fs`, and dash routes.

**Architecture:** `fs:`/`fsh:`/`mi:` rows in `SessionDO`, written by `writeFs` (a sibling of `writeSurface`) through one store call, `appendFs`, that writes the row, a history row, an `fs` event and the audit entries in one transaction. Memory under `/members/<memory id>/` is keyed by account; peers read it only when every seat the account holds grants `read_context`.

**Tech Stack:** TypeScript, zod, Cloudflare Durable Objects, vitest (root and `worker-tests/`), the `diff` package.

**Spec:** `docs/superpowers/specs/2026-11-01-room-filesystem-and-apps-design.md`: §3, §10, §11 and Detailed Implementation Plan items 1–23. This plan argues from it and names its decisions where the spec leaves a choice.

## Shipping

- **PR A (Tasks 1–2):** ADR A, its docs, and the memory delivery rule. The spec's PR 1 and PR 2 are combined here, since both must land before PR 3. The rule still deploys a release ahead of anything that writes `fs` events.
- **PR B (Tasks 3–8):** room files. Opened once PR A is deployed, as the spec's PR 3.

## Global Constraints

- Peer content is untrusted. File content and `find` results go out inside `untrusted()`, with the server-stamped writer seat as origin.
- User ids never appear in a path, an event, a listing or a tool result. Memory ids are 16 random hex characters, from `newBlobId`'s generator.
- The memory rule: a peer reads an account's `/members/<id>/**` only if every seat the account holds (`leftAt === null`) grants `read_context`. With no seat held, every seat it held must have granted when it left or was evicted. The account's own seats read their own files. A null reader (the room socket) and the public page never read them.
- Text files only, at most 64 KiB each. The last 20 revisions are kept per path.
- A write whose `base_rev` is not the current revision is refused `stale`. A write without `base_rev` creates the file and is refused `stale` if the path exists.
- `fsBytesPerRoom` is 1 MiB on `free`, 50 MiB on `pro`, and 500 MiB on `max` and `team`. Each write charges the net change.
- `find` matches path names only, at most 20 results.
- `bellman_fs`'s whole definition is at most 600 tokens. The listing stays at or under 11,840 tokens (ARCHITECTURE §11).
- `/apps/**` writes are refused until ADR B. `/.bellman/**` writes are refused with the dash route.

## Review Focus

1. A peer listing `/members/` must not learn that a withholding account has any memory: no name, no count, no event.
2. An account holding one granting seat and one withholding seat is withheld from peers.
3. A path like `/a/../members/<id>/x`, `/a//b`, a NUL byte, or an NFC/NFD pair must normalize, or be refused, before any authorization runs.
4. Two writers with the same `base_rev`: the second is `stale` and carries the current content.
5. Deleting files gives their bytes back, so a room cannot fill its quota with history alone.

---

### Task 1: ADR A and docs (PR A)

**Files:** Create `docs/adr/0046-room-filesystem.md` and `GLOSSARY.md`. Modify `docs/ARCHITECTURE.md` (§5 and §7). Edit issue #430 through `gh`.

- [ ] Write ADR 0046 as spec item 1 describes, including the rollback note: the delivery rule is never rolled back while `fs` events exist. Before the PR opens, check that the number is free on `origin/main`, every open PR, and `git for-each-ref` over `docs/adr`.
- [ ] Write `GLOSSARY.md` (spec item 2): account, seat, member, room file, memory id, room socket, public page.
- [ ] ARCHITECTURE: §5 gains `fs:`/`fsh:`/`mi:`; §7 gains the memory rule.
- [ ] After PR A merges, edit #430 as spec item 4 says: point it at ADR 0046, move the superseded paragraphs under "Superseded", and open sub-issues for PR B.
- [ ] Commit `ADR 0046: the room filesystem (#430)`.

### Task 2: The memory delivery rule (PR A)

**Files:** Modify `src/types.ts`, `src/attention.ts`, `src/public-event.ts`, `src/rooms.ts` (`eventsFor`), and `tests/tools/report.test.ts` (its `EventType` table). Test: `tests/public-event-memory.test.ts` (Create), `tests/attention.test.ts`, `tests/delivery-paths.test.ts` (only if the pinned counts move).

**Interfaces (produces):**
- `EventType` gains `"fs"`, with payload `FsEventPayload = { path: string; rev: number; size: number; op: "write" | "delete" | "restore" }`. `ATTENTION.fs = "ambient"`.
- `isMemoryPath(path: string): boolean`: true for `/members/` and anything under it.
- `isMemoryEvent(e: SessionEvent): boolean`: an `fs` event whose `payload.path` is a memory path.
- `seesMemory(seats: readonly Pick<Member, "capabilities" | "leftAt">[], ownerUserId: string, reader: string | null, opts?: { ownAccount?: boolean }): boolean`. `ownAccount` defaults to true. Returns false for a null reader, and true for `reader === ownerUserId` while `ownAccount` holds. Otherwise the seats held (`leftAt === null`), or every seat when none is held, must be non-empty and all grant `read_context`.
- `readableEvent(e, author, reader, accountSeats?: readonly Member[])`: a memory event returns `seesMemory(accountSeats ?? [], e.fromUserId, reader) ? e : null`, which fails closed when no seats are passed. Every other path is unchanged.
- `readableEvents(events, members, reader, seatsByUser?: ReadonlyMap<string, readonly Member[]>)` passes `seatsByUser.get(e.fromUserId)`.
- `memoryAuthors(events): string[]`: the distinct `fromUserId` of memory events. `eventsFor` loads `membersOfUser` for each and passes the map.
- `publicReadEvent` returns null for every `fs` event.
- The two single-event callers in `src/rooms.ts` (restore and report) pass no seats. They refuse every type an `fs` event could be anyway. Ruling: unchanged.
- The room socket (`src/store-do.ts`, reader null) drops memory events through `readableEvent` with no seats. No change.

- [ ] **Step 1: Test `seesMemory`:**
  - The own account is true. A null reader is false.
  - One granting seat is true; granting plus withholding is false.
  - With no seat held: every departed seat granted is true; one did not is false.
  - An evicted seat counts as not held.
  - An empty list is false.
  - `ownAccount: false` refuses the own account when one seat withholds.
- [ ] **Step 2: Test `readableEvent` and `readableEvents`:**
  - A memory `fs` event reaches its own account, and a peer only when every seat grants.
  - A non-memory `fs` event (`/plans/x.md`) reaches everyone.
  - No seats passed means dropped for a peer.
  - The room socket (null) drops it.
  - `publicReadEvent` returns null for both kinds of `fs` event.
- [ ] **Step 3: Test `eventsFor` through a `MemoryStore`.** A room with two seats of one account, one of them withholding: a peer is handed none of that account's memory events.
- [ ] **Step 4: Run the tests and see them fail. Implement. Run them again and see them pass.** Then run `npm run verify`.
- [ ] **Step 5: Commit** `The memory delivery rule, a release ahead of anything that writes fs events (#430)`.

### Task 3: Paths, quota and planning (PR B)

**Files:** Create `src/fs-path.ts` and `src/fs.ts`. Modify `src/types.ts` (`Session.fsBytesCeiling`, `Entitlements.fsBytesPerRoom`, `FsRow`), `src/stored-session.ts`, `src/auth.ts`, `src/tools/start.ts` and `package.json` (`diff`). Test: `tests/fs-path.test.ts`, `tests/fs.test.ts` (the planning half) and `tests/auth.test.ts`.

**Interfaces (produces):**
- `normalizePath(raw: string): { ok: true; path: string } | { ok: false; reason: string }`. It applies NFC, collapses `//`, and requires a leading `/`. It refuses `.`, `..`, empty segments, control characters and NUL. The limits are 512 characters and 32 segments.
- `namespaceOf(path): { ns: "memory"; memoryId: string } | { ns: "bellman" } | { ns: "app"; key: string } | { ns: "room" }`.
- `FsRow = { path; rev; content; size; writerMemberId; writerLabel; at; deleted: boolean }`.
- `decideFsCharge(s: Pick<Session, "frozenAt" | "fsBytes" | "fsBytesCeiling">, closed: boolean, delta: number): { ok: true; next: number } | { ok: false; reason: "closed" | "frozen" | "over_quota"; used: number; ceiling: number }`. A negative delta always passes.
- `planWrite(op, current: FsRow | null, input)`: computes the next content for `write`, `edit` (exactly one match of `old`), `append`, `delete` and `restore`, and checks `base_rev`, the 64 KiB cap and stale. It returns the next row, or a refusal of `stale` (with `current_rev` and current content up to 64 KiB), `too_large` or `invalid`.
- `diffText(a: string, b: string): { diff: string; truncated: boolean }`: unified, 3 lines of context, cut at 64 KiB.
- Plans: `fsBytesPerRoom` (`free` 1 MiB, `pro` 50 MiB, `max` and `team` 500 MiB), stamped as `fsBytesCeiling` at start. Old rooms read the `free` value through `hydrateStoredSession`.

- [ ] TDD each function:
  - Path tables, plus a seeded random loop: no output contains `..` or escapes its root, and NFC is applied.
  - The edit match count.
  - Stale and create-only `base_rev`.
  - The charge with negative deltas.
  - `diffText`'s truncation.
- [ ] Commit `Room files: paths, quota and the pure planning of each op (#430)`.

### Task 4: Store methods (PR B)

**Files:** Modify `src/store.ts`, `src/store-do.ts` and the facade. Test: `tests/helpers/store-contract.ts`.

**Interfaces (produces), all async and in the contract suite:**
- `readFs(sessionId, path, rev?) → FsRow | null`.
- `listFs(sessionId, prefix, cursor?) → { entries: FsRow[]; next: string | null }`: 100 a page, live files only.
- `fsHistory(sessionId, path) → FsRow[]`: newest first, at most 20.
- `findFs(sessionId, query, cursor?) → { entries; next }`: paths containing every word, case-insensitive, at most 20.
- `appendFs(sessionId, w: FsWrite, audit) → FsAppend`. In one transaction it:
  - checks the idempotency key;
  - re-runs `planWrite` against the row read in the transaction;
  - charges the net bytes through `decideFsCharge`;
  - assigns a memory id on the account's first write under `/members/`;
  - writes `fs:<path>` and `fsh:<path>:<rev padded 10>`, pruning past 20;
  - appends one `fs` event and the audit entries.

  `FsAppend = { outcome: "ok"; rev; event } | { outcome: "replayed"; event } | { outcome: "conflict" } | { outcome: "stale"; currentRev; content } | { outcome: "over_quota"; used; ceiling } | { outcome: "too_large" } | { outcome: "frozen" | "closed" }`.
- `memoryIdOf(sessionId, userId) → string | null` (never writes). `memoryIdOwner(sessionId, memoryId) → string | null`.
- Ruling: the planner runs inside the store's transaction, because the stale check and the charge must read the same row they write. `src/fs.ts` stays pure, and both stores call it, as `decideConfigWrite` is shared.

- [ ] Contract tests:
  - A write, a read back, and one event without content.
  - Stale on a second same-base write.
  - 21 writes keep 20, and pruning gives bytes back.
  - A delete gives bytes back.
  - `over_quota`.
  - A replayed key, and a conflicting key.
  - A memory id assigned on the first `/members/` write and reused across seats of the account; reads never assign one.
  - Frozen and closed rooms are refused.
  - A colon in a path round-trips.
  - Purge removes the rows (`worker-tests/purge.test.ts`).
- [ ] Commit `Room files in both stores: fs:, fsh: and mi: rows in one transaction with the event (#430)`.

### Task 5: `writeFs`, the RoomFailure codes, and `/.bellman/` (PR B)

**Files:** Modify `src/rooms.ts` (`writeFs`, `readFsFor`, `RoomFailure` plus `stale`, `too_large` and `over_quota`) and `src/http/rooms.ts` (`STATUS`). Create `src/governed-view.ts`. Test: `tests/fs.test.ts` and `tests/governed-view.test.ts`.

**Interfaces:**
- `writeFs(store, identity, sessionId, memberId, input)`:
  1. `gateSeat(..., "write_surface")` for non-memory paths. Memory paths need the seat to belong to the account that owns the memory id: the gate checks the seat without a verb, since memory writing is the account's own.
  2. Authorize by namespace: memory, only the owning account; `/.bellman/`, refused with "change room settings in the dash"; `/apps/`, refused `apps_not_enabled`; room paths, `write_surface`.
  3. `admitSend`, then `auditEntries("fs_write", { path, rev, op, size, sha256 })`, then `appendFs`.
- Reads: `readFsFor(store, identity, sessionId, memberId, path, rev?)` and the list, history and find equivalents apply `seesMemory` per memory id. A memory id's account comes from `memoryIdOwner`; its seats from `membersOfUser`.
- `renderGovernedView(path, store, sessionId)`: `/.bellman/room.md` is `getGovernedConfig("room_instructions")`'s markdown, or an empty file; listing `/.bellman/` shows `room.md`.
- `STATUS` gains `stale: 409`, `too_large: 413` and `over_quota: 413`.

- [ ] Tests:
  - CUJ 1 end to end (the spec's CUJs section).
  - CUJ 2 end to end, including a rejoin.
  - A mixed-grant account is withheld (Review Focus 2).
  - Listing `/members/` hides a withholding account entirely (Review Focus 1).
  - `/.bellman/` writes are refused, and reads render from config.
  - A frozen room, an evicted seat and a departed seat are refused.
  - No user id appears in any output.
  - The send limit refuses past its count.
- [ ] Commit `writeFs and the reads, with the memory rule on every path (#430)`.

### Task 6: `bellman_fs` and the dash routes (PR B)

**Files:** Create `src/tools/fs.ts` and `src/http/files.ts` (mounted from `roomRoutes`). Modify `src/server.ts`, `src/projections.ts` (`fsEntry`, `fsFile` in `untrusted()`) and `extension/manifest.json`. Test: `tests/tools/fs.test.ts` and `tests/http-files.test.ts`.

**Interfaces:**
- `bellman_fs` takes `session_id`, `member_id`, `op` (`read`, `list`, `write`, `edit`, `append`, `delete`, `restore`, `history` or `find`), and as each op needs: `path`, `content`, `base_rev`, `old`, `new`, `rev`, `from`, `to`, `prefix`, `cursor`, `query` and `idempotency_key`. Bounds are as in the Global Constraints.
- Refusals carry a stable code, the current state and one next step. The whole definition is at most 600 tokens.
- Routes:
  - `GET /rooms/:id/files?member_id=&prefix=&cursor=` and `GET /rooms/:id/files/<path>?member_id=&rev=`.
  - `PUT` (`{ content, base_rev }`) and `DELETE` (`?base_rev=`) on the same path.
  - Writes take `?member_id=`, then run `findMember` (404), `adminWriteRefusal`, then `writeFs`. They are cookie-only, refused with 403 `dash_session_required`, as the governed config routes are (ruling: a dash write is a person's). The Origin check is `csrfRefusal`.
- [ ] Tests:
  - Each op through the harness.
  - Every result wraps content as untrusted.
  - Bearer writes on the routes are refused.
  - `tests/extension.test.ts` passes.
  - `npm run docs:gen`.
- [ ] Measure the listing (§11 method, with a control on `main`). Add the budget row.
- [ ] Commit `bellman_fs and the file routes (#430)`.

### Task 7: Docs (PR B)

**Files:** Create `docs-site/src/content/docs/guides/room-files.md`. Modify `CLAUDE.md` (layout lines) and `docs/ARCHITECTURE.md` §11.

- [ ] The guide covers files, memory and `/.bellman/`, and who can read what. It says memory is room-readable while `read_context` is granted, that a shared memory id links an account's seats, and that the docs ask for no personal records. Then run `npm --prefix docs-site run build`.
- [ ] Commit `Room files guide (#430)`.

### Task 8: Verification (PR B)

- [ ] Run `npm run verify` and `wrangler deploy --dry-run`.
- [ ] Positive controls. Remove each of these and watch its tests fail:
  - the memory rule in the reads;
  - the stale check;
  - the namespace authorization.
- [ ] One whole-branch review on the most capable model, with Review Focus 1–5.
