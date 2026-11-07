# Memory Controls Implementation Plan (#531)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four controls a person needs to trust home memory: pause, a lookup log of every agent read, hard delete, and a Markdown export, as server routes and store methods; the dash UI follows in the dash repo.

**Architecture:** Pause is a second boolean in the home room's `hs` settings row, set through the existing `PUT /me/memory`, and read inside every home read and write. The lookup log is `lk:` rows in the home room, written by new store methods that read and log in one transaction, so a read never happens without its row and a hard delete never leaves a stray row. Hard delete is one store method that empties the home room's object. Export is a runtime-free Markdown renderer over the reads that already exist. Everything in `src/memory.ts` and `src/http/me.ts` stays route-and-tool code over `BellmanStore`; no tool reaches a home room by any other path.

**Tech Stack:** TypeScript, vitest (`tests/`), the Workers pool (`worker-tests/`, runs the store contract against the Durable Object), zod, Cloudflare Durable Objects.

**Spec:** `docs/adr/0047-bellman-memory.md` decisions 13 and 14, and `docs/superpowers/specs/2026-11-04-bellman-memory-design.md` §8 (Controls) and CUJ 4. The ADR wins where the two differ.

## Global Constraints

- Every `BellmanStore` method is async, and both stores (`MemoryStore` in `src/store.ts`, the Durable Object in `src/workerd/session-do.ts` through `src/workerd/store-do.ts`) implement every new method; `tests/helpers/store-contract.ts` is where their shared behaviour is asserted, and `worker-tests/store-contract.test.ts` runs it on the real object.
- A home room's reads and writes touch one object. No new method reads two.
- Dash-only routes refuse a bearer with 403, check `csrfRefusal` on writes, and take `allowedOrigin` for CORS, exactly as `PUT /me/memory` does today in `src/http/me.ts`.
- A home room writes no `fs` events and no org audit entries (ADR 0047 decisions 3 and 13). The lookup log is shown to the account only.
- Tool descriptions use the concise output style; a change to `bellman_memory`'s description re-measures `docs/ARCHITECTURE.md` §11 and adds a budget row (`tests/tool-budget.test.ts` fails until it does). `npm run docs:gen` after any tool text change (`tests/docs-reference.test.ts`).
- The pr skill writes the PR body. `npm run verify` before every commit that touches `src/`. Commit with `git` (this worktree is plain git, not jj).
- **If PR #549 (`src/storage/`) merges before this branch does**: the `BellmanStore` interface and shared types move to `src/storage/store.ts` and `MemoryStore` to `src/storage/memory-store.ts`. Every "Modify `src/store.ts`" below then means those two files; `import { MemoryStore } from "../src/storage/memory-store.js"` in tests. Nothing else in this plan changes.
- Writing rule: a room holds many members. Say *members*, *peers*, *the room*; never "the other session".

## Decisions this plan makes (not in the spec; the ADR amendment in Task 9 records them)

1. Pause is `paused: boolean` in `HomeSettings`, set through `PUT /me/memory` with `{ "paused": boolean }`, not a separate `/me/memory/pause` route. A body may carry `capture`, `paused` or both; any other key is 400.
2. `unshare` is allowed while paused: it reads no memory and reduces exposure. Every other op but `forget` is refused `paused`.
3. A lookup row's `agent` is the seat's brief agent when the read names a seat (`share`, arrival), and null for a bare `recall`, which has no seat. The row's `room` and `member` are null then too.
4. Retention: a logged read deletes rows older than 90 days; `GET /me/memory/lookups` returns the newest 1,000 and deletes the rest. A home room that is never opened in the dash is bounded by time alone.
5. `DELETE /me/memory` empties the whole object, the `hs` settings row included: capture and pause read as off afterwards. The person deleted their memory; the safer default is capture off.
6. Per-note hard delete from the dash is `DELETE /me/memory/notes?path=<encoded path>`: the file and its history go as `forget`'s do, and the path is scrubbed from every lookup row (a row left with no paths is deleted).
7. Arrival's `recall` block always carries `paused: boolean`.
8. Export is one `text/markdown` document: home notes, then the account's room notes per room, each note's content verbatim under its heading. Dash session only.
9. Deleting the account's room notes in one room is `DELETE /rooms/:id/notes` from a dash session, one `writeFs` delete per file from the account's first active seat (it is a send, counted and audited as any room file delete); it stops at the first refusal and reports what it deleted.

## Review Focus

1. A read and a hard delete racing: the lookup row must land in the same transaction as the read, or an `lk:` row survives in an emptied object and shows in the next home room's log. Task 2's DO implementation uses one `storage.transaction`; Task 6's contract test deletes and then lists lookups.
2. An existing `hs` row written by #530 holds `capture` only; reading it must yield `paused: false`, not `undefined`. Task 1 pins it in the contract.
3. Pause must stop arrival's home read and its lookup row, not only the tool. Task 4 asserts no row is written for a paused arrival.
4. Export must not read rooms the account has left or that are closed, and must not leak another account's room notes. Task 7 asserts a peer's note is absent.
5. `PUT /me/memory` with `{ "paused": true }` must leave `capture` as it was, and vice versa. Task 1's route test pins both orders.

---

### Task 1: `paused` in the settings row, read and set through `/me/memory`

**Files:**
- Modify: `src/types.ts` (`HomeSettings`, `DEFAULT_HOME_SETTINGS`)
- Modify: `src/store.ts` (`MemoryStore.readHomeSettings`), `src/workerd/session-do.ts` (`readHomeSettings`)
- Modify: `src/memory.ts` (`setMemoryCapture` becomes `setMemorySettings`)
- Modify: `src/http/me.ts` (the PUT body)
- Test: `tests/helpers/store-contract.ts` ("home memory" block), `tests/http-app.test.ts` ("GET and PUT /me/memory")

**Interfaces:**
- Produces: `HomeSettings { capture: boolean; paused: boolean }`; `DEFAULT_HOME_SETTINGS = { capture: false, paused: false }`.
- Produces: `setMemorySettings(store, actor, patch: Partial<HomeSettings>): Promise<HomeSettings>` in `src/memory.ts`, replacing `setMemoryCapture`. Reads the row, spreads the patch, writes, returns the result.
- Produces: `PUT /me/memory` accepts an object whose keys are a non-empty subset of `capture`, `paused`, each a boolean; 400 otherwise. `GET /me/memory` returns the full `HomeSettings`.

- [ ] **Step 1: Write the failing contract test**

In the "home memory" describe of `tests/helpers/store-contract.ts`, change the settings case's expectations from `{ capture: false }` to `{ capture: false, paused: false }` throughout, and add:

```ts
it("reads paused false from a row written before the field existed", async () => {
  await store.writeHomeSettings(id, { capture: true } as HomeSettings);
  expect(await store.readHomeSettings(id)).toEqual({ capture: true, paused: false });
  await store.writeHomeSettings(id, { capture: true, paused: true });
  expect(await store.readHomeSettings(id)).toEqual({ capture: true, paused: true });
});
```

- [ ] **Step 2: Write the failing route tests**

In `tests/http-app.test.ts`, "GET and PUT /me/memory": every `toEqual({ capture: … })` becomes `toEqual({ capture: …, paused: false })`. Add:

```ts
it("sets paused and capture independently, in either order", async () => {
  expect(await bodyOf(await dash({ paused: true }))).toEqual({ capture: false, paused: true });
  expect(await bodyOf(await dash({ capture: true }))).toEqual({ capture: true, paused: true });
  expect(await bodyOf(await dash({ paused: false, capture: false }))).toEqual({ capture: false, paused: false });
  for (const body of [{ paused: "yes" }, { paused: true, pause: true }]) expect((await dash(body)).status, JSON.stringify(body)).toBe(400);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run tests/store-contract.test.ts tests/http-app.test.ts -t "paused"`
Expected: FAIL (type error on `paused`, or `undefined` where `false` is expected).

- [ ] **Step 4: Implement**

- `src/types.ts`: add `paused: boolean` to `HomeSettings` with a doc line ("Pause (ADR 0047 decision 13): every `bellman_memory` op but `forget` and `unshare` is refused `paused`, and arrival reads no home titles. Only the dash sets it."); `DEFAULT_HOME_SETTINGS = { capture: false, paused: false }`.
- Both `readHomeSettings`: return `{ ...DEFAULT_HOME_SETTINGS, ...row }` when a row exists.
- `src/memory.ts`: replace `setMemoryCapture` with `setMemorySettings(store, actor, patch: Partial<HomeSettings>)`.
- `src/http/me.ts`: parse the body as an object whose every key is `capture` or `paused` with a boolean value and at least one key; call `setMemorySettings`. Update the file's header comment (the PUT's body and that `paused` is pause) and the 400 message: `send {"capture": boolean} and/or {"paused": boolean}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/store-contract.test.ts tests/http-app.test.ts tests/memory.test.ts tests/bridge-door.test.ts`
Expected: PASS. (`bridge-door` reads `/me/memory` through the bridge; the extra field must not break it.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store.ts src/workerd/session-do.ts src/memory.ts src/http/me.ts tests/helpers/store-contract.ts tests/http-app.test.ts
git commit -m "Memory controls: paused in the home settings row, set through PUT /me/memory (#531)"
```

---

### Task 2: Logged home reads and the lookup log in both stores

**Files:**
- Modify: `src/types.ts` (`LookupRow`, `LookupSource`)
- Modify: `src/store.ts` (`BellmanStore` interface; `MemoryStore`), `src/workerd/session-do.ts`, `src/workerd/store-do.ts`
- Test: `tests/helpers/store-contract.ts` ("home memory" block)

**Interfaces:**
- Produces, in `src/types.ts`:

```ts
/** One agent read of home memory (ADR 0047 decision 13): an `lk:` row in the home room, shown to the account only. */
export interface LookupRow {
  at: number;
  op: "read" | "list" | "share" | "arrival";
  /** The room and seat the read came from; null for a bare `recall`, which names no seat. */
  sessionId: string | null;
  memberId: string | null;
  /** The seat's brief agent, when the read named a seat. */
  agent: AgentInfo | null;
  /** `read` and `share`: the path asked for. `list`: the prefix. `arrival`: null. */
  query: string | null;
  /** The paths the read returned, in the order returned. */
  paths: string[];
}
export type LookupSource = Omit<LookupRow, "at" | "paths">;
export const LOOKUP_KEEP = 1000;
export const LOOKUP_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
```

- Produces, on `BellmanStore`:

```ts
/** `readFs` on a home room that also writes the lookup row, in one transaction; `paused` when the `hs` row says so, with nothing read or written. Rows older than LOOKUP_KEEP_MS are deleted in the same transaction. */
readHomeLogged(id: string, path: string, source: LookupSource): Promise<{ paused: true } | { paused: false; file: FsRow | null }>;
/** `listFs` with `newest: true` on a home room, logged the same way. */
listHomeLogged(id: string, prefix: string, cursor: string | undefined, source: LookupSource): Promise<{ paused: true } | { paused: false; page: FsPage }>;
/** The lookup log, newest first, at most LOOKUP_KEEP rows; rows past that are deleted. */
homeLookups(id: string): Promise<LookupRow[]>;
```

- `source.op` is what the caller says; the store stamps `at: Date.now()` and `paths` (the one path read when the file exists, or `[]`; a listing's page entries' paths).
- DO storage: key `lk:<at zero-padded to 14 digits>:<8 random hex>` so a reverse list reads newest first and two reads in one millisecond do not collide. `const LOOKUP_PREFIX = "lk:"` next to `NOTES_SHARING_PREFIX`; the key comment lists it as purged with the room.
- `MemoryStore`: `private lookups = new Map<string, LookupRow[]>()`, newest first.

- [ ] **Step 1: Write the failing contract tests**

```ts
it("logs each read in the home room, newest first, with the paths it returned, and nothing when paused", async () => {
  vi.setSystemTime(1_700_000_000_000);
  await store.writeHome(id, home(), note("/a.md", { op: "write", content: "a" }), 4096);
  await store.writeHome(id, home(), note("/b.md", { op: "write", content: "b" }), 4096);
  const bare: LookupSource = { op: "read", sessionId: null, memberId: null, agent: null, query: "/a.md" };
  expect(await store.readHomeLogged(id, "/a.md", bare)).toMatchObject({ paused: false, file: { path: "/a.md", content: "a" } });
  vi.advanceTimersByTime(1);
  expect(await store.readHomeLogged(id, "/nope.md", { ...bare, query: "/nope.md" })).toEqual({ paused: false, file: null });
  vi.advanceTimersByTime(1);
  const seat: LookupSource = { op: "list", sessionId: "qs_room", memberId: "m_1", agent: { provider: "anthropic", model: "claude", client: "claude-code" }, query: "/" };
  const listed = await store.listHomeLogged(id, "/", undefined, seat);
  expect(listed).toMatchObject({ paused: false, page: { next: null } });
  expect((listed as { page: FsPage }).page.entries.map((e) => e.path)).toEqual(["/b.md", "/a.md"]);
  const log = await store.homeLookups(id);
  expect(log.map((r) => [r.op, r.query, r.paths])).toEqual([["list", "/", ["/b.md", "/a.md"]], ["read", "/nope.md", []], ["read", "/a.md", ["/a.md"]]]);
  expect(log[0]).toMatchObject({ sessionId: "qs_room", memberId: "m_1", agent: { client: "claude-code" }, at: 1_700_000_000_002 });
  await store.writeHomeSettings(id, { capture: false, paused: true });
  expect(await store.readHomeLogged(id, "/a.md", bare)).toEqual({ paused: true });
  expect(await store.listHomeLogged(id, "/", undefined, bare)).toEqual({ paused: true });
  expect((await store.homeLookups(id)).length).toBe(3);
  expect(await store.homeLookups(homeRoomId("u_other"))).toEqual([]);
});

it("keeps the newest 1,000 lookup rows and 90 days", async () => {
  vi.setSystemTime(1_700_000_000_000);
  const bare: LookupSource = { op: "read", sessionId: null, memberId: null, agent: null, query: "/a.md" };
  await store.readHomeLogged(id, "/a.md", bare);
  vi.advanceTimersByTime(LOOKUP_KEEP_MS + 1);
  await store.readHomeLogged(id, "/a.md", bare);
  expect((await store.homeLookups(id)).map((r) => r.at)).toEqual([1_700_000_000_000 + LOOKUP_KEEP_MS + 1]);
  for (let i = 0; i < LOOKUP_KEEP + 5; i++) { vi.advanceTimersByTime(1); await store.readHomeLogged(id, "/a.md", bare); }
  const kept = await store.homeLookups(id);
  expect(kept.length).toBe(LOOKUP_KEEP);
  expect(kept[0].at).toBeGreaterThan(kept[kept.length - 1].at);
  expect((await store.homeLookups(id)).length).toBe(LOOKUP_KEEP);
});
```

The contract already runs under `vi.useFakeTimers()`; check the block's `beforeEach` and reuse it. The 1,005-read loop runs on the Durable Object too; it is a few seconds there and acceptable.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store-contract.test.ts -t "lookup"`
Expected: FAIL, `readHomeLogged is not a function`.

- [ ] **Step 3: Implement both stores**

- `MemoryStore`: `readHomeLogged` and `listHomeLogged` check `this.homeSettings.get(id)?.paused`, perform the read as `readFs` / `listFs(..., { newest: true, cursor })` do, unshift the row, then filter rows older than `now - LOOKUP_KEEP_MS`. `homeLookups` slices to `LOOKUP_KEEP` and stores the slice.
- `SessionDO`: one `this.ctx.storage.transaction` per logged read: `txn.get<HomeSettings>("hs")`, return `{ paused: true }` if paused; read as `readFs` / `listFs` do (the list reads `fsm:` rows through `#fsRows`, which takes a storage; pass `txn`); `txn.put(lookupKey(at), row)`; `txn.list({ prefix: LOOKUP_PREFIX, end: lookupKey(at - LOOKUP_KEEP_MS, "") })` and delete each key. `homeLookups`: `storage.list<LookupRow>({ prefix: LOOKUP_PREFIX, reverse: true })`, delete keys past `LOOKUP_KEEP`, return the first `LOOKUP_KEEP` values. A `// ponytail:` comment on `homeLookups` naming the ceiling: the whole log is read to cap it; a count row if logs grow past a few thousand before the dash reads them.
- `DurableObjectStore`: delegate the three methods.

- [ ] **Step 4: Run both test programs**

Run: `npx vitest run tests/store-contract.test.ts && npm run test:worker -- store-contract`
(Check `package.json` for the Workers pool's script name; `npm run verify` runs both.) Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts src/workerd/session-do.ts src/workerd/store-do.ts tests/helpers/store-contract.ts
git commit -m "Memory controls: logged home reads and the lk: lookup log in both stores (#531)"
```

---

### Task 3: Pause and the lookup log in `bellman_memory`

**Files:**
- Modify: `src/store.ts` (`HomeAppend`, `writeHome` in `MemoryStore`), `src/workerd/session-do.ts` (`writeHome`)
- Modify: `src/rooms.ts` (`RoomFailure` gains `"paused"`)
- Modify: `src/memory.ts` (`writeHome`, `readHome`, `listHome`, `shareHome`)
- Modify: `src/tools/memory.ts` (description, refusals)
- Modify: `docs/ARCHITECTURE.md` §11 budget table
- Test: `tests/helpers/store-contract.ts`, `tests/memory.test.ts`, `tests/tools/memory.test.ts`

**Interfaces:**
- Consumes: Task 2's `readHomeLogged`, `listHomeLogged`, `homeLookups`, `LookupSource`.
- Produces: `HomeAppend` gains `{ outcome: "paused" }`; `writeHome` in both stores returns it for a `write` op when `hs.paused`, never for a `delete`.
- Produces, in `src/memory.ts`: `readHome(store, actor, raw, source: LookupSource)`, `listHome(store, actor, prefix, cursor, source)`; both refuse `paused` with reason `paused: your human paused home memory in the dash; forget still works.` `shareHome` passes `{ op: "share", sessionId, memberId, agent, query: path }` where `agent` is `(await store.getBriefs(sessionId, [memberId]))[memberId]?.agent ?? null`. `writeHome` maps `outcome: "paused"` to `refuse("paused", …)`.
- The tool: `recall` with `path` passes `{ op: "read", sessionId: null, memberId: null, agent: null, query: path }`; `recall` alone passes `op: "list"`, `query: prefix ?? "/"`. The description's refusal list gains `paused`; nothing else in the text changes.

- [ ] **Step 1: Write the failing tests**

Contract (`tests/helpers/store-contract.ts`, home block):

```ts
it("refuses a write while paused and still deletes", async () => {
  await store.writeHome(id, home(), note("/a.md", { op: "write", content: "a" }), 4096);
  await store.writeHomeSettings(id, { capture: false, paused: true });
  expect(await store.writeHome(id, home(), note("/b.md", { op: "write", content: "b" }), 4096)).toEqual({ outcome: "paused" });
  expect(await store.writeHome(id, home(), note("/a.md", { op: "delete", baseRev: 1 }), 4096)).toMatchObject({ outcome: "ok", rev: 2 });
  expect(await store.readFs(id, "/a.md")).toBeNull();
});
```

Tool (`tests/tools/memory.test.ts`):

```ts
it("while paused: remember, recall and share are refused paused; forget and unshare work; nothing is logged", async () => {
  await p.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
  await h.store.writeHomeSettings(homeRoomId(p.creator.identity.userId), { capture: false, paused: true });
  for (const args of [{ op: "remember", path: "/b.md", content: "b" }, { op: "recall", path: "/a.md" }, { op: "recall" }, { op: "share", session_id: p.sessionId, member_id: p.creatorMemberId, path: "/a.md", to: "notes" }]) {
    const r = await p.creator.call("bellman_memory", args);
    expect([r.isError, r.text], JSON.stringify(args)).toEqual([true, expect.stringContaining("paused")]);
  }
  expect((await p.creator.call("bellman_memory", { op: "unshare", session_id: p.sessionId, member_id: p.creatorMemberId })).isError).toBe(false);
  expect((await p.creator.call("bellman_memory", { op: "forget", path: "/a.md", base_rev: 1 })).isError).toBe(false);
  expect(await h.store.homeLookups(homeRoomId(p.creator.identity.userId))).toEqual([]);
});

it("logs a bare recall with no seat, and a share with its seat and agent", async () => {
  await p.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
  await p.creator.call("bellman_memory", { op: "recall", path: "/a.md" });
  await p.creator.call("bellman_memory", { op: "recall", prefix: "/" });
  await p.creator.call("bellman_memory", { op: "share", session_id: p.sessionId, member_id: p.creatorMemberId, path: "/a.md", to: "notes" });
  const log = await h.store.homeLookups(homeRoomId(p.creator.identity.userId));
  expect(log.map((r) => [r.op, r.query, r.paths, r.sessionId, r.memberId])).toEqual([
    ["share", "/a.md", ["/a.md"], p.sessionId, p.creatorMemberId],
    ["list", "/", ["/a.md"], null, null],
    ["read", "/a.md", ["/a.md"], null, null],
  ]);
  expect(log[0].agent).toEqual(expect.objectContaining({ client: expect.any(String) }));
  expect(log[2].agent).toBeNull();
});
```

`PairedSession` (`tests/helpers/flows.ts`) carries `sessionId`, `creatorMemberId` and `joinerMemberId`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store-contract.test.ts tests/tools/memory.test.ts -t "paused|logs"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `HomeAppend` union gains `{ outcome: "paused" }`; both `writeHome`s read `hs` (the DO inside its transaction, `txn.get("hs")`) and return it for `w.write.op === "write"` when paused.
- `RoomFailure` gains `"paused"`.
- `src/memory.ts` as the Interfaces block says; `homeTitles` is left for Task 4.
- `src/tools/memory.ts`: pass the sources; add `paused` to the description's refusals (`Refusals: stale (current_rev, content), too_large, over_quota, paused, forbidden, …`).
- `docs/ARCHITECTURE.md` §11: measure as the budget test does (run `npx vitest run tests/tool-budget.test.ts`; it prints the measured figure on failure), add a row `| Memory controls: \`bellman_memory\`'s \`paused\` refusal | +N | total | #531 (ADR 0047, 13) |` and move the "Tool definitions" figure.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/store-contract.test.ts tests/memory.test.ts tests/tools/memory.test.ts tests/tool-budget.test.ts && npm run docs:gen && npx vitest run tests/docs-reference.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ docs/ARCHITECTURE.md docs-site/src/content/docs/reference tests/
git commit -m "Memory controls: bellman_memory refuses paused and logs every home read (#531)"
```

---

### Task 4: Pause and the log on arrival

**Files:**
- Modify: `src/memory.ts` (`homeTitles`), `src/tools/confirm.ts` (the `recall` block)
- Test: `tests/tools/join-budget.test.ts`

**Interfaces:**
- Consumes: Task 2's `listHomeLogged`.
- Produces: `homeTitles(store, actor, source: LookupSource): Promise<{ titles: string[]; paused: boolean }>`; a failed read logs and returns `{ titles: [], paused: false }`. `confirm.ts` passes `{ op: "arrival", sessionId: joined.id, memberId, agent: brief.agent, query: null }` (the joiner's brief is the tool's `brief` argument; use the variable the handler already holds) and renders `recall: { home, home_omitted, paused }`.

- [ ] **Step 1: Write the failing tests**

In `tests/tools/join-budget.test.ts`, change the `toEqual({ home: [], home_omitted: 0 })` assertion to include `paused: false`, and add:

Add `paused: boolean` to the file's `Reply.recall` type and `session_id: string; member_id: string` to `Reply`, then:

```ts
it("arrival logs a lookup with the room, seat and agent, and a paused account gets no titles and no row", async () => {
  const jesse = await h.connect(DEV_KEY.jesse);
  await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
  const roomA = await roomWith([member()], 0, "");
  const first = await join(jesse);
  expect(first.data.recall).toEqual({ home: ["/a.md"], home_omitted: 0, paused: false });
  const log = await h.store.homeLookups(homeRoomId(jesse.identity.userId));
  expect(log.map((r) => [r.op, r.sessionId, r.memberId, r.query, r.paths])).toEqual([["arrival", roomA, first.data.member_id, null, ["/a.md"]]]);
  expect(log[0].agent).toEqual(brief({ goal: "the joiner's" }).agent);
  await h.store.writeHomeSettings(homeRoomId(jesse.identity.userId), { capture: false, paused: true });
  const other = await h.connect(DEV_KEY.jesse);
  await roomWith([member({ memberId: "m_other", label: "other@x" })], 0, "");
  const second = await join(other);
  expect(second.data.recall).toEqual({ home: [], home_omitted: 0, paused: true });
  expect((await h.store.homeLookups(homeRoomId(jesse.identity.userId))).length).toBe(1);
});
```

`roomWith` and `join` are this file's helpers (`join` connects with the seeded code `BELL-TEST-01`, so each `roomWith` room must carry it; read `swarmSession` in the file's imports for how the first case seeds the code, and give the second room a code of its own if one code cannot be live in two rooms). `member` and `brief` come from `tests/helpers/fixtures.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tools/join-budget.test.ts`
Expected: FAIL on the `paused` key.

- [ ] **Step 3: Implement** as the Interfaces block says. `recallOf` in `confirm.ts` becomes `(k) => ({ home: titles.slice(0, k), home_omitted: titles.length - k, paused })`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tools/join-budget.test.ts tests/tools/memory.test.ts tests/tool-budget.test.ts`
Expected: PASS. If `bellman_confirm`'s description names the `recall` fields, add `paused` there and extend Task 3's budget row rather than adding a second.

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts src/tools/confirm.ts tests/tools/join-budget.test.ts docs/ARCHITECTURE.md
git commit -m "Memory controls: arrival says paused and logs the home read (#531)"
```

---

### Task 5: `GET /me/memory/lookups`

**Files:**
- Modify: `src/memory.ts` (`memoryLookups`), `src/http/me.ts`, `src/app.ts`, `src/workerd/worker.ts`
- Test: `tests/http-app.test.ts`

**Interfaces:**
- Consumes: Task 2's `homeLookups`.
- Produces: `memoryLookups(store, actor): Promise<LookupShown[]>` in `src/memory.ts`, where

```ts
export interface LookupShown {
  at: number; op: LookupRow["op"];
  /** The room as the account sees it; null for a bare recall, and `{ session_id, room: null }` for a room since purged. */
  room: { session_id: string; room: string | null } | null;
  member_id: string | null; agent: AgentInfo | null; query: string | null; paths: string[];
}
```

  One `getSession` per distinct room id in the page; `room` is `session.manifest.room`.
- Produces: `GET /me/memory/lookups` → 200 `{ lookups: LookupShown[] }`. Dash session only: a bearer is 403 `dash_session_required` ("the lookup log is read by the person signed in to the dash"). 405 for any other method, `allow: GET`.
- Routing: `src/app.ts` already mounts `/me/memory` with `app.use`, which matches sub-paths; `src/workerd/worker.ts` tests `/^\/me\/(rooms|memory)\/?$/`, which must become `/^\/me\/(rooms|memory)(\/|$)/`. In `meRoutes`, dispatch on the path after `/me/memory`.

- [ ] **Step 1: Write the failing test**

```ts
describe("GET /me/memory/lookups", () => {
  it("lists the account's lookup rows newest first with the room's name, to the dash alone", async () => {
    const pair = await pairUp(h);
    await pair.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    await pair.creator.call("bellman_memory", { op: "recall", path: "/a.md" });
    await pair.creator.call("bellman_memory", { op: "share", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/a.md", to: "notes" });
    const res = await call(null, "/me/memory/lookups", { cookie: DEV_KEY.jesse });
    expect(res.status).toBe(200);
    const { lookups } = (await bodyOf(res)) as { lookups: LookupShown[] };
    expect(lookups.map((l) => [l.op, l.room?.session_id ?? null, l.room?.room ?? null, l.paths])).toEqual([
      ["share", pair.sessionId, "pair", ["/a.md"]],
      ["read", null, null, ["/a.md"]],
    ]);
    expect((await call(DEV_KEY.jesse, "/me/memory/lookups")).status).toBe(403);
    expect((await call(null, "/me/memory/lookups", { cookie: DEV_KEY.peer }))).toMatchObject({ status: 200 });
    expect(await bodyOf(await call(null, "/me/memory/lookups", { cookie: DEV_KEY.peer }))).toEqual({ lookups: [] });
    expect((await call(null, "/me/memory/lookups", { method: "PUT", cookie: DEV_KEY.jesse, body: {} })).headers.get("allow")).toBe("GET");
  });
});
```

`"pair"` is the manifest's `room` for `pairUp`'s room; confirm in `tests/helpers/flows.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/http-app.test.ts -t lookups`
Expected: FAIL, 404 or `undefined` response.

- [ ] **Step 3: Implement** as the Interfaces block says. Update `src/http/me.ts`'s header comment with the new route.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/http-app.test.ts && npm run typecheck:worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts src/http/me.ts src/app.ts src/workerd/worker.ts tests/http-app.test.ts
git commit -m "Memory controls: GET /me/memory/lookups for the dash (#531)"
```

---

### Task 6: Hard delete: everything, one note, and the operator's route

**Files:**
- Modify: `src/store.ts` (interface; `MemoryStore`), `src/workerd/session-do.ts`, `src/workerd/store-do.ts`
- Modify: `src/memory.ts` (`deleteMemory`, `forgetNote`), `src/http/me.ts`, `src/oauth/routes.ts`
- Modify: `src/oauth/EGM.md` only if it lists the admin routes (it does; add the new one)
- Test: `tests/helpers/store-contract.ts`, `tests/http-app.test.ts`, `tests/http-admin.test.ts`

Read `EGM.md`, `src/EGM.md` and `src/oauth/EGM.md` before editing `src/oauth/routes.ts` (repo rule).

**Interfaces:**
- Produces, on `BellmanStore`:

```ts
/** Empties a home room (ADR 0047 decisions 13 and 14): every fs:, fsm:, fsh:, hk:, lk: row, the hs settings row and the record. Idempotent; a home id that was never written is a no-op. Never called on a room id. */
purgeHome(id: string): Promise<void>;
/** Deletes one home note as `forget` does, at its current revision, and scrubs `path` from every lookup row (a row left with no paths is deleted). `false` when there is no live note at `path`. */
forgetHomeNote(id: string, path: string): Promise<boolean>;
```

  DO `purgeHome`: `storage.deleteAll()` then `storage.deleteAlarm()` (a home room arms none; the call is for the same reason `#purgeIfDue` keeps it). No registry, audit, blob or outbox work: a home room has none. `forgetHomeNote` in one transaction: read `fs:` row; if none or deleted return false; write the tombstone through `decideFsWrite` exactly as `writeHome` does for a delete at `baseRev: current.rev` (reuse: call `writeHome` from inside, or factor the shared tail; the implementer chooses the smaller diff), then rewrite the `lk:` rows whose `paths` include the path.
  `MemoryStore.purgeHome`: delete the id from `sessions`, `files`, `homeKeys`, `homeSettings`, `lookups`, `sends`, and settle `waiters` as `purgeNow` does.
- Produces, in `src/memory.ts`: `deleteMemory(store, actor): Promise<void>` → `purgeHome(homeRoomId(actor.userId))`; `forgetNote(store, actor, raw): Promise<RoomResult<null>>` (`homePath` check, then `forgetHomeNote`; `not_found` when false).
- Produces, routes in `src/http/me.ts`, dash session plus CSRF, bearer 403 `dash_session_required`:
  - `DELETE /me/memory` → 204.
  - `DELETE /me/memory/notes?path=<encoded>` → 204, 404 `not_found`, 400 `invalid_request` when `path` is missing or invalid.
  - `GET, PUT, DELETE` is `/me/memory`'s allow list now; `/me/memory/notes` allows `DELETE`.
- Produces, in `src/oauth/routes.ts`: `DELETE /admin/accounts/:userId/memory` behind `operatorGate(request, config, "deleting an account's memory")`, `const ADMIN_ACCOUNT_MEMORY = /^\/admin\/accounts\/([^/]+)\/memory$/`, the segment decoded with `decodeURIComponent`, `config.plans.purgeHome(homeRoomId(userId))`, 204. 501 `unsupported` when `config.plans` is unset, as `/admin/handles` answers. `purgeHome` must be on whatever type `config.plans` is declared as; if that is a narrower interface than `BellmanStore`, add the method to it.

- [ ] **Step 1: Write the failing tests**

Contract:

```ts
it("purgeHome empties the home room: notes, history, keys, settings and lookups, and the next write starts clean", async () => {
  await store.writeHome(id, home(), note("/a.md", { op: "write", content: "a" }, "k1"), 4096);
  await store.writeHome(id, home(), note("/a.md", { op: "write", content: "a2", baseRev: 1 }), 4096);
  await store.writeHomeSettings(id, { capture: true, paused: false });
  await store.readHomeLogged(id, "/a.md", { op: "read", sessionId: null, memberId: null, agent: null, query: "/a.md" });
  await store.purgeHome(id);
  expect(await store.readFs(id, "/a.md")).toBeNull();
  expect(await store.fsHistory(id, "/a.md")).toEqual([]);
  expect(await store.listFs(id, "/")).toEqual({ entries: [], next: null });
  expect(await store.readHomeSettings(id)).toEqual({ capture: false, paused: false });
  expect(await store.homeLookups(id)).toEqual([]);
  expect(await store.writeHome(id, home(), note("/a.md", { op: "write", content: "again" }, "k1"), 4096)).toEqual({ outcome: "ok", path: "/a.md", rev: 1 });
  await store.purgeHome(homeRoomId("u_never"));
});

it("forgetHomeNote deletes the note with its history and scrubs it from the lookup log", async () => {
  await store.writeHome(id, home(), note("/a.md", { op: "write", content: "a" }), 4096);
  await store.writeHome(id, home(), note("/b.md", { op: "write", content: "b" }), 4096);
  const src = { op: "list" as const, sessionId: null, memberId: null, agent: null, query: "/" };
  await store.listHomeLogged(id, "/", undefined, src);
  await store.readHomeLogged(id, "/a.md", { ...src, op: "read", query: "/a.md" });
  expect(await store.forgetHomeNote(id, "/a.md")).toBe(true);
  expect(await store.forgetHomeNote(id, "/a.md")).toBe(false);
  expect(await store.readFs(id, "/a.md")).toBeNull();
  expect(await store.fsHistory(id, "/a.md")).toEqual([]);
  expect((await store.homeLookups(id)).map((r) => [r.op, r.paths])).toEqual([["list", ["/b.md"]]]);
});
```

Routes (`tests/http-app.test.ts`):

```ts
describe("DELETE /me/memory and /me/memory/notes", () => {
  it("deletes everything from the dash and nothing with a bearer", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    await dash({ capture: true });
    expect((await call(DEV_KEY.jesse, "/me/memory", { method: "DELETE" })).status).toBe(403);
    expect((await call(null, "/me/memory", { method: "DELETE", cookie: DEV_KEY.jesse })).status).toBe(403); // no Origin
    expect((await call(null, "/me/memory", { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(204);
    expect((await jesse.call("bellman_memory", { op: "recall" })).data).toMatchObject({ entries: [] });
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: false, paused: false });
  });
  it("deletes one note by path, 404 for a note that is not there, 400 without a path", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    const del = (q: string) => call(null, `/me/memory/notes${q}`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect((await del("?path=%2Fa.md")).status).toBe(204);
    expect((await del("?path=%2Fa.md")).status).toBe(404);
    expect((await del("")).status).toBe(400);
    expect((await jesse.call("bellman_memory", { op: "recall", path: "/a.md" })).isError).toBe(true);
  });
});
```

Operator (`tests/http-admin.test.ts`), with this file's `send`, `bearer`, `OPERATOR`, `TEAM_ADMIN` and `store`:

```ts
describe("/admin/accounts/:userId/memory", () => {
  it("empties the account's home room for an operator, and for no one else", async () => {
    const id = homeRoomId("u_target");
    await store.writeHome(id, homeSession({ userId: "u_target", orgId: null, plan: "free", role: "member", label: "t@x" }, Date.now()), { path: "/a.md", write: { op: "write", content: "a" }, memberId: HOME_MEMBER_ID, userId: "u_target", label: "t@x", key: null }, 4096);
    expect((await send("DELETE", "/admin/accounts/u_target/memory", await bearer(TEAM_ADMIN))).status).toBe(403);
    const sid = await seedSession(/* as the file's "Fail closed" case does, around its line 116 */);
    expect((await send("DELETE", "/admin/accounts/u_target/memory", { cookie: `${COOKIE}=${sid}`, origin: PANEL })).status).toBe(401);
    expect((await send("DELETE", "/admin/accounts/u_target/memory", await bearer(OPERATOR))).status).toBe(204);
    expect(await store.readFs(id, "/a.md")).toBeNull();
    expect((await send("GET", "/admin/accounts/u_target/memory", await bearer(OPERATOR))).status).toBe(405);
  });
});
```

`homeRoomId`, `homeSession` and `HOME_MEMBER_ID` come from `src/home.js`; `seedSession` is already imported from `tests/helpers/panel.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/store-contract.test.ts tests/http-app.test.ts tests/http-admin.test.ts -t "purgeHome|forgetHomeNote|DELETE /me/memory|accounts"`
Expected: FAIL.

- [ ] **Step 3: Implement** as the Interfaces block says. In `src/oauth/EGM.md`'s interface list add the route beside `/admin/handles/:handle`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run verify`
Expected: PASS, both test programs.

- [ ] **Step 5: Commit**

```bash
git add src/ tests/ docs/
git commit -m "Memory controls: hard delete of everything, one note, and the operator's route (#531)"
```

---

### Task 7: Markdown export

**Files:**
- Create: `src/memory-export.ts` (runtime-free)
- Modify: `src/memory.ts` (`exportMemory`), `src/http/me.ts`
- Test: `tests/memory-export.test.ts`, `tests/http-app.test.ts`

**Interfaces:**
- Produces, in `src/memory-export.ts`:

```ts
export interface ExportRoom { sessionId: string; room: string; notes: FsRow[] }
/** The one Markdown document `GET /me/memory/export` returns. Note content is verbatim; headings carry the path, revision and time. */
export function renderExport(input: { label: string; at: number; home: FsRow[]; rooms: ExportRoom[] }): string;
```

  Layout, exactly:

```
# Bellman memory export

Account: <label>
Exported: <ISO 8601 of at>

## Home memory

### <path>

Revision <rev> · <ISO of row.at>

<content>

---

### <next path> …

## Room notes

### <room> (<sessionId>)

#### <path>

Revision <rev> · <ISO of row.at>

<content>

---
```

  "## Home memory" with no notes renders `_No home notes._`; "## Room notes" with no rooms renders `_No room notes._`. Notes are in path order inside a section. A `---` follows every note.

- Produces, in `src/memory.ts`: `exportMemory(store, actor): Promise<string>`. Home notes: page `listFs(home, "/")` to the end, `readFs` each. Rooms: the id set `liveRooms` builds (`sessionsCreatedBy(userId, ROOMS_LIMIT)` ∪ `sessionsJoinedBy(userId, JOINED_SCAN)`; export the two constants or a `roomIdsOf(store, identity)` helper from `src/rooms.ts`), `getSession` each, skip closed rooms and rooms with no active seat of the account's, `memoryIdOf(id, userId)`, skip when null, page `listFs(id, \`/members/${memoryId}/\`)`, `readFs` each; rooms in the order the id set yields. `room` is `manifest.room`.
- Produces: `GET /me/memory/export` → 200, `content-type: text/markdown; charset=utf-8`, `content-disposition: attachment; filename="bellman-memory-<YYYY-MM-DD>.md"`, CORS headers as `json` sets them. Dash session only (bearer 403 `dash_session_required`). 405 otherwise.

- [ ] **Step 1: Write the failing tests**

`tests/memory-export.test.ts`:

```ts
const row = (path: string, content: string, rev = 1): FsRow => ({ path, rev, content, size: content.length, writerMemberId: "home", writerLabel: "j", at: 1_700_000_000_000, deleted: false });
it("renders home notes then room notes, verbatim, with the empty markers", () => {
  const md = renderExport({ label: "jesse@x", at: 1_700_000_000_000, home: [row("/b.md", "second"), row("/a.md", "# first\n\nbody", 3)], rooms: [{ sessionId: "qs_1", room: "swarm", notes: [row("/members/mid/n.md", "note")] }] });
  expect(md).toBe(`# Bellman memory export\n\nAccount: jesse@x\nExported: 2023-11-14T22:13:20.000Z\n\n## Home memory\n\n### /a.md\n\nRevision 3 · 2023-11-14T22:13:20.000Z\n\n# first\n\nbody\n\n---\n\n### /b.md\n\nRevision 1 · 2023-11-14T22:13:20.000Z\n\nsecond\n\n---\n\n## Room notes\n\n### swarm (qs_1)\n\n#### /members/mid/n.md\n\nRevision 1 · 2023-11-14T22:13:20.000Z\n\nnote\n\n---\n`);
  expect(renderExport({ label: "j", at: 0, home: [], rooms: [] })).toContain("_No home notes._\n\n## Room notes\n\n_No room notes._\n");
});
```

`tests/http-app.test.ts`:

```ts
describe("GET /me/memory/export", () => {
  it("returns one Markdown document of home notes and the account's room notes, to the dash alone", async () => {
    const pair = await pairUp(h);
    await pair.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "home note" });
    await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/r.md", content: "room note" });
    await pair.joiner.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md", content: "peer note" });
    const res = await call(null, "/me/memory/export", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect([res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual([200, "text/markdown; charset=utf-8", expect.stringMatching(/^attachment; filename="bellman-memory-\d{4}-\d{2}-\d{2}\.md"$/)]);
    const md = await res.text();
    expect(md).toContain("### /a.md");
    expect(md).toContain("home note");
    expect(md).toContain(`### pair (${pair.sessionId})`);
    expect(md).toContain("room note");
    expect(md).not.toContain("peer note");
    expect((await call(DEV_KEY.jesse, "/me/memory/export")).status).toBe(403);
  });
});
```

Check `bellman_fs`'s write arguments in `src/tools/fs.ts` and adjust the calls.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/memory-export.test.ts tests/http-app.test.ts -t export`
Expected: FAIL.

- [ ] **Step 3: Implement** as the Interfaces block says. `tests/projections.test.ts` asserts the runtime-free layer imports no SDK; `src/memory-export.ts` imports only `./types.js`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/memory-export.test.ts tests/http-app.test.ts tests/projections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory-export.ts src/memory.ts src/http/me.ts src/rooms.ts tests/memory-export.test.ts tests/http-app.test.ts
git commit -m "Memory controls: GET /me/memory/export, one Markdown document (#531)"
```

---

### Task 8: Deleting the account's room notes in one room

**Files:**
- Modify: `src/http/notes-sharing.ts` (rename nothing; add `NOTES = /^\/rooms\/([^/]+)\/notes$/` and its handler in the same dispatcher), `src/http/rooms.ts` only if the dispatcher there needs the new pattern
- Modify: `src/memory.ts` (`deleteRoomNotes`)
- Test: `tests/http-app.test.ts` or the file that tests `/rooms/:id/notes-sharing` (find it with `grep -rl notes-sharing tests/`)

**Interfaces:**
- Produces, in `src/memory.ts`: `deleteRoomNotes(store, actor, sessionId): Promise<RoomResult<{ deleted: string[]; refused: { path: string; code: RoomFailure } | null }>>`. `not_found` when the room is missing or the account holds no active seat. Picks the first active seat of the account's (`membersOfUser`, filtered by `isActiveMember`), reads `memoryIdOf`; none → `{ deleted: [], refused: null }`. Pages `listFs(sessionId, \`/members/${memoryId}/\`)`, and for each live file calls `writeFs(store, actor, sessionId, memberId, { path, write: { op: "delete", baseRev: row.rev } })` from `src/rooms.ts`; on the first refusal stops and reports it.
- Produces: `DELETE /rooms/:id/notes`, dash session plus CSRF, bearer 403 `dash_session_required`; 200 `{ deleted, refused }`; 404 as `notes-sharing` answers.

- [ ] **Step 1: Write the failing test**

```ts
it("DELETE /rooms/:id/notes removes the account's room notes and no one else's, with the room's events saying so", async () => {
  const pair = await pairUp(h);
  await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/a.md", content: "a" });
  await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/b.md", content: "b" });
  await pair.joiner.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md", content: "p" });
  const res = await call(null, `/rooms/${pair.sessionId}/notes`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
  expect(res.status).toBe(200);
  const body = await bodyOf(res) as { deleted: string[]; refused: unknown };
  expect(body.deleted.map((p) => p.split("/").pop()).sort()).toEqual(["a.md", "b.md"]);
  expect(body.refused).toBeNull();
  expect((await pair.creator.call("bellman_fs", { op: "list", session_id: pair.sessionId, member_id: pair.creatorMemberId, prefix: "/members/me/" })).data).toMatchObject({ entries: [] });
  expect((await pair.joiner.call("bellman_fs", { op: "read", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md" })).isError).toBe(false);
  expect((await call(DEV_KEY.jesse, `/rooms/${pair.sessionId}/notes`, { method: "DELETE" })).status).toBe(403);
  expect((await call(null, `/rooms/qs_nope/notes`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/http-app.test.ts -t "rooms/:id/notes"`
Expected: FAIL.

- [ ] **Step 3: Implement** as the Interfaces block says.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/http-app.test.ts tests/http-rooms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/notes-sharing.ts src/http/rooms.ts src/memory.ts tests/
git commit -m "Memory controls: DELETE /rooms/:id/notes removes the account's room notes in a room (#531)"
```

---

### Task 9: Docs, the ADR amendment, verify, PR

**Files:**
- Modify: `docs/adr/0047-bellman-memory.md` (decision 13), `src/http/EGM.md`, `docs-site/src/content/docs/guides/room-files.md`
- Modify: `docs/superpowers/plans/2026-11-07-memory-controls.md` (this file: tick what shipped)

- [ ] **Step 1: ADR 0047 decision 13**

Rewrite the *Pause*, *Lookup log*, *Hard delete* and *Export* bullets to the routes and calls this plan made (the "Decisions this plan makes" list above, each in one sentence), and add to the header: `revised 2026-11-07 for #531`. Keep the *Capture switch* bullet. Update decision 14's first sentence to name `lk:` and `hs` among what `DELETE /me/memory` removes.

- [ ] **Step 2: `src/http/EGM.md`**

In the Interface section, beside the `/me/memory` line: `PUT` takes `{capture?, paused?}`; `DELETE /me/memory` (204); `DELETE /me/memory/notes?path=` (204 | 404); `GET /me/memory/lookups` `{lookups}`; `GET /me/memory/export` (text/markdown); `DELETE /rooms/:id/notes` `{deleted, refused}`, each with its `[src/http/me.ts:meRoutes]` or `[src/http/notes-sharing.ts:notesSharingRoutes]` citation, and the rule that every one but `GET /me/memory` is dash-session only.

- [ ] **Step 3: The docs site**

In `docs-site/src/content/docs/guides/room-files.md`, after the paragraph that points to home memory, add one paragraph "Controls": pause (what an agent sees: `paused`, and that `forget` and `unshare` still work), the lookup log (what a row records), delete (one note, everything; that everything includes the capture switch) and export, each as a thing done from the control panel. No route names. Then `npm run docs:gen` and `npm --prefix docs-site run build` (`npm --prefix docs-site ci` first on a fresh clone).

- [ ] **Step 4: Verify**

Run: `npm run verify && npm run typecheck:worker && npx wrangler deploy --dry-run`
Expected: all green. If `verify` fails on `test:mod`, read the output: this branch touches nothing under `mod/`, so that failure is pre-existing on main; say so in the PR.

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs/ src/http/EGM.md docs-site/src/content/docs
git commit -m "Memory controls: ADR 0047 decision 13 as shipped, routes in the http EGM, the guide's controls paragraph (#531)"
git push -u origin mcfearsome/memory-controls
```

Then the pr skill writes the body. It names `Closes #531`, the routes, decisions 1 to 9 above, the §11 budget row, and that the dash UI is a dash issue (open it with `gh issue create --repo bellman-sh/dash`: title "Memory controls page: pause, lookup log, delete, export (bellman#531)", body listing the six routes with their methods, status codes and the dash-session-only rule). After merge, the /compare/dray page's "no lookup log or pause yet" line (bellman.sh#64) is stale; say so in the PR body under follow-ups.
