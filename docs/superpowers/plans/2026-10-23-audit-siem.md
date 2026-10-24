# Audit for a SIEM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hash chain over every org's audit stream, a retention window the org sets and the stream sweeps, and one signed HTTPS sink per org that receives every row in order.

**Architecture:** The pure parts (chain hash, chain walk, sweep plan, sink state machine, signature, batch body) live runtime-free in `src/audit-sink.ts` and are tested alone. Both `BellmanStore` implementations gain the same eight methods and the contract suite proves them identical; `AuditDO` grows a named-alarm loop (`sweep`, `sink`) over the outbox's `due:` rows, and `MemoryStore` runs the same handlers from `sweep(now)`. `src/http/audit.ts` adds the five routes behind the existing `auditRefusal`.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SQL + KV storage, `nodejs_compat`), vitest (`tests/`) and `@cloudflare/vitest-pool-workers` (`worker-tests/`).

**Spec:** `docs/superpowers/specs/2026-10-23-audit-siem-design.md` (ADR: `docs/adr/0035-audit-tamper-evidence-and-sink.md`).

## Global Constraints

- `hash = sha256 hex of "${seq}\n${prev_hash}\n${JSON.stringify(recordOf(entry))}"`; first hashed row's `prev_hash` is `""`; rows written before this change stay null, never rewritten.
- The hash is computed inside `append`'s `transactionSync` with `createHash("sha256")` from `node:crypto`, never `crypto.subtle`.
- Retention: `null` or an integer `>= 30` days; 400 otherwise. Sweep: seq order, oldest first, 500 a batch, stops at the first row with `at >= cutoff`; anchor `{ seq, hash }` of the newest deleted row written in the same transaction; default anchor `{ seq: 0, hash: "" }`.
- Sink: `https:` only; secret shown once; batches of 100; alarm `sink` armed at `now + 5_000` from `append`; backoff `backoffMs(attempts)` from `src/outbox.ts`; dead after `24 h` of failing; `Bellman-Signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
- Actions written: `audit_retention_set { days }`, `audit_swept { through_seq, count }`, `audit_sink_set { url }`, `audit_sink_removed { url }`, `audit_sink_resumed { url, delivered_through }`, `audit_sink_dead { url, failing_since, last_error }`. System rows use `SYSTEM_ACTOR`'s identity.
- Every `BellmanStore` method is async. Workers-only code stays in `src/store-do.ts`. No tool changes, so no `docs:gen`, no `extension/manifest.json` edit.
- Never describe Bellman as a thing for two sessions: say members, the room, peers.
- Commits: signed (`git -c commit.gpgsign=true commit -S`), on `mcfearsome/audit-siem`.

## Review Focus

1. A `PATCH /audit/settings` body that is not JSON, or `retention_days` as the string `"90"`: 400 `invalid_request`, never a 500 and never a window set. Test added in Task 4.
2. `verifyAudit` on an org that has no rows at all: `{ ok: true, checked: 0, from_seq: 0, through_seq: 0 }`, no throw. Test added in Task 3.
3. A sink URL with credentials or a fragment (`https://u:p@host/x#y`): accepted as given (the spec checks only the scheme), posted as given. Test added in Task 5 (URL stored verbatim).
4. A sweep whose cutoff falls past the whole stream (every row old): every row deleted, the anchor is the last row, the next append chains from the anchor so `verifyAudit` on the new stream is `ok`. Test added in Task 4.
5. A `pumpAuditSink` run while the sink is `dead`: no POST, status unchanged, nothing armed. Test added in Task 5.

---

### Task 1: The pure module

**Files:**
- Create: `src/audit-sink.ts`
- Test: `tests/audit-sink.test.ts`

**Interfaces:**
- Consumes: `AuditEntry` (`src/types.ts`), `recordOf`, `AuditRecord`, `SeqEntry` (`src/audit.ts`), `backoffMs` (`src/outbox.ts`), `AuditIntent` (`src/grant-audit.ts`).
- Produces (all exported from `src/audit-sink.ts`):
  - `RETENTION_FLOOR_DAYS = 30`, `SWEEP_BATCH = 500`, `SWEEP_EVERY_MS = 86_400_000`, `SINK_BATCH = 100`, `SINK_DELAY_MS = 5_000`, `SINK_TIMEOUT_MS = 10_000`, `SINK_DEAD_AFTER_MS = 86_400_000`, `VERIFY_PAGE = 500`.
  - `SYSTEM_INTENT: AuditIntent = { actorUserId: "system", actorLabel: null, actorOrgId: null }`.
  - `interface ChainAnchor { seq: number; hash: string }`, `NO_ANCHOR: ChainAnchor = { seq: 0, hash: "" }`.
  - `chainHash(seq: number, prevHash: string, entry: AuditEntry): string` (sync, `createHash` from `node:crypto`).
  - `interface ChainRow { seq: number; prevHash: string | null; hash: string | null; entry: AuditEntry }`.
  - `interface AuditVerification { ok: boolean; from_seq: number; through_seq: number; checked: number; unhashed: number; broken_at?: number; anchor: ChainAnchor }`.
  - `chainWalk(anchor: ChainAnchor, from?: number): { feed(rows: ChainRow[]): boolean; result(): AuditVerification }` — `feed` returns `false` once a break is found so a caller stops paging; `from_seq` is the first row fed (0 when none); `through_seq` the last row fed.
  - `sweepPlan(rows: { seq: number; at: number; hash: string | null }[], cutoff: number): { through: number; count: number; anchor: ChainAnchor } | null` — rows in seq order; stops at the first `at >= cutoff`; `null` when the first row is young; `anchor.hash` is the newest deleted row's hash (`""` when null).
  - `interface AuditSink { url: string; secret: string; createdAt: number; deliveredThrough: number; attempts: number; failingSince: number | null; lastError: string | null; dead: boolean }`.
  - `interface AuditSinkStatus { url: string; created_at: string; delivered_through: number; pending: number; status: "ok" | "failing" | "dead"; failing_since: string | null; last_error: string | null; attempts: number }`.
  - `interface AuditSettings { retentionDays: number | null; sink: AuditSinkStatus | null }`.
  - `newSink(url: string, now: number, secret: string, deliveredThrough = 0): AuditSink` (attempts 0, failingSince null, dead false).
  - `sinkStatus(sink: AuditSink, through: number): AuditSinkStatus` — `pending = max(0, through - deliveredThrough)`; status `dead` when `sink.dead`, `failing` when `failingSince !== null`, else `ok`.
  - `type SinkOutcome = { ok: true; through: number } | { ok: false; error: string }`.
  - `nextSinkState(sink: AuditSink, outcome: SinkOutcome, now: number, more: boolean): { sink: AuditSink; armAt: number | null; died: boolean }` — ok: cursor = through, attempts 0, failingSince null, lastError null, `armAt = more ? now : null`; failure: attempts + 1, `failingSince ??= now`, lastError set, `armAt = now + backoffMs(attempts)`; when `now - failingSince >= SINK_DEAD_AFTER_MS` after a failure: `dead = true`, `armAt = null`, `died = true`.
  - `batchBody(orgId: string, entries: unknown[], first: number, last: number): { delivery: string; body: string }` — `delivery = "<orgId>:<first>-<last>"`, `body = JSON.stringify({ org_id, delivery, entries })`.
  - `signBatch(secret: string, t: number, body: string): Promise<string>` — the `Bellman-Signature` header value, HMAC via `crypto.subtle`.
  - `retentionDaysOf(value: unknown): number | null | "invalid"` — `null` → null; integer `>= RETENTION_FLOOR_DAYS` → that; anything else `"invalid"`.
  - `sinkUrlOf(value: unknown): string | "invalid"` — a string that `new URL` parses with protocol `https:` → the string as given (Review Focus 3); else `"invalid"`.

- [ ] **Step 1: Write the failing tests**

`tests/audit-sink.test.ts`, one `describe` per export:

```ts
it("chainHash is sha256 hex over seq, prev_hash and the record", () => {
  const entry = { at: 1, orgId: "org_a", sessionId: "qs_1", actorUserId: "u", action: "x", detail: { n: 1 } };
  const expected = createHash("sha256").update(`7\nabc\n${JSON.stringify(recordOf(entry))}`).digest("hex");
  expect(chainHash(7, "abc", entry)).toBe(expected);
});
it("chainWalk: an intact chain is ok, counts unhashed rows before the first hashed one, and reports the first broken seq", ...)
  // rows 1 (unhashed), 2 (prev "" ok), 3 (prev = hash2) → ok, checked 2, unhashed 1, from_seq 1, through_seq 3
  // row 3 with a wrong stored hash → ok false, broken_at 3; feed returns false
  // row 3 with prev_hash not equal to row 2's hash → broken_at 3
  // an unhashed row after a hashed one → broken_at that seq
  // first hashed row's prev_hash must equal anchor.hash: anchor { seq: 2, hash: "h2" }, row 3 prev "h2" → ok
it("chainWalk over no rows is ok with zero counts", ...)   // Review Focus 2
it("sweepPlan stops at the first young row in seq order, even when an older-looking row follows", ...)
  // rows at [1, 2, 10, 3] cutoff 5 → through 2, count 2, anchor { seq: 2, hash: rows[1].hash }
it("sweepPlan is null when nothing is old", ...)
it("nextSinkState: success resets failure fields and arms now only when more remain", ...)
it("nextSinkState: a failure counts, keeps the first failingSince and arms by backoffMs", ...)
it("nextSinkState: a failure 24h after the first marks the sink dead and arms nothing", ...)
it("sinkStatus: pending, and status by dead/failing/ok", ...)
it("batchBody names the delivery and carries the entries", ...)
it("signBatch is t=,v1= over `${t}.${body}` with HMAC-SHA256", async () => { /* recompute with crypto.subtle, compare */ })
it("retentionDaysOf: null, 30, 365 pass; 29, 30.5, '90', undefined are invalid", ...)
it("sinkUrlOf: https passes verbatim (credentials and fragment kept); http, ftp, a bare word, a number are invalid", ...)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run tests/audit-sink.test.ts > .vitest/audit-sink.txt 2>&1; tail -5 .vitest/audit-sink.txt`
Expected: FAIL, "Failed to resolve import ../src/audit-sink.js".

- [ ] **Step 3: Implement `src/audit-sink.ts`** with the signatures above. Header comment: runtime-free (Node `crypto` only), shared by both stores.

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command. Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audit-sink.ts tests/audit-sink.test.ts
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 1/6: the pure module — chain hash and walk, sweep plan, sink state machine, batch body and signature"
```

---

### Task 2: The hash chain in both stores and on the wire

**Files:**
- Modify: `src/audit.ts` (`AuditRecord`, `SeqEntry`, `entryOf`), `src/store-do.ts` (`AUDIT_SCHEMA`, `migrateAudit`, `insertAuditRow`, `AuditDO.append`), `src/store.ts` (`MemoryStore.audit` rows, `recordAudit`, `streamOf`), `src/http/audit.ts` (`AuditEntryView`, `entryView`, `CSV_COLUMNS`, `csvRow`)
- Test: `tests/helpers/store-contract.ts`, `tests/http-audit.test.ts`, `worker-tests/audit-migration.test.ts`

**Interfaces:**
- Consumes: `chainHash` (Task 1).
- Produces: `SeqEntry = AuditEntry & { seq: number; hash: string | null; prevHash: string | null }`; `AuditRecord` gains `prev_hash: string | null; hash: string | null`; `entryOf` maps both. `insertAuditRow(sql, entry, seq?)` computes `prev_hash` from `SELECT hash FROM entries ORDER BY seq DESC LIMIT 1` (`""` when no row or null) and `hash` via `chainHash`, binding both. `MemoryStore.audit` rows become `{ seq, entry, prevHash, hash }`. `AuditEntryView.hash: string | null`; `CSV_COLUMNS` gains `"hash"` last; `csvRow` writes it.

- [ ] **Step 1: Write the failing contract case** in `tests/helpers/store-contract.ts`, inside the existing audit `describe`:

```ts
it("chains appended rows: hash over seq, prev_hash and the record, the first prev_hash empty", async () => {
  await store.appendAudit(row({ at: 1 })); await store.appendAudit(row({ at: 2 }));
  const [a, b] = (await store.queryAudit("org_a", { limit: 10 })).entries.slice().reverse();  // oldest first
  expect(a.prevHash).toBe("");
  expect(a.hash).toBe(chainHash(a.seq, "", stripSeq(a)));
  expect(b.prevHash).toBe(a.hash);
  expect(b.hash).toBe(chainHash(b.seq, a.hash!, stripSeq(b)));
});
```
where `stripSeq` drops `seq`, `hash`, `prevHash` (the `AuditEntry` as appended). Use the file's existing `row` fixture and org id.

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk proxy npx vitest run tests/store.test.ts -t "chains appended rows" > .vitest/chain.txt 2>&1; tail -8 .vitest/chain.txt`
Expected: FAIL, `expected undefined to be ""`.

- [ ] **Step 3: Implement the chain**: `src/audit.ts` types and `entryOf`; `MemoryStore.recordAudit` computing `prevHash` from the org's last row and `hash` with `chainHash`, `streamOf` carrying both; `AUDIT_SCHEMA` gains `prev_hash TEXT` and `hash TEXT` on `entries`, and `migrateAudit` runs `ALTER TABLE entries ADD COLUMN prev_hash TEXT` / `hash TEXT` guarded by `PRAGMA table_info(entries)` so an existing object gains them once; `insertAuditRow` as in Produces (the transaction is `append`'s, already open).

- [ ] **Step 4: Run the contract in both programs**

Run: `rtk proxy npx vitest run tests/store.test.ts > .vitest/chain.txt 2>&1; tail -5 .vitest/chain.txt` → PASS.
Run: `npm run test:worker -- store-contract audit-migration > .vitest/chain-w.txt 2>&1; tail -8 .vitest/chain-w.txt` → PASS.

- [ ] **Step 5: Write the failing migration case** in `worker-tests/audit-migration.test.ts`: an object whose `entries` table was created from the pre-change schema (run the old DDL by hand inside `runInDurableObject` before the first `append`) gets the two columns, its moved rows read back with `hash: null`, and the next `append` has `prevHash: ""`. Run: `npm run test:worker -- audit-migration` → FAIL on `prevHash`; then make it pass with the Step 3 guard if it does not already. Expected after: PASS.

- [ ] **Step 6: Write the failing wire tests** in `tests/http-audit.test.ts`: the page's entries carry `hash` (a 64-hex string), the CSV header ends in `,hash` and a row's last cell is the hash, the JSON export entry has `hash`. Run: `rtk proxy npx vitest run tests/http-audit.test.ts > .vitest/wire.txt 2>&1; tail -8 .vitest/wire.txt` → FAIL.

- [ ] **Step 7: Implement** `AuditEntryView.hash`, `entryView` (`hash: e.hash ?? null`), `CSV_COLUMNS` + `csvRow`. Run Step 6's command → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/audit.ts src/store-do.ts src/store.ts src/http/audit.ts tests/helpers/store-contract.ts tests/http-audit.test.ts worker-tests/audit-migration.test.ts
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 2/6: a hash chain over the stream, computed in append's transaction, carried on the page and both exports"
```

---

### Task 3: `verifyAudit` and `GET /audit/verify`

**Files:**
- Modify: `src/store.ts` (`BellmanStore` interface, `MemoryStore`), `src/store-do.ts` (`AuditDO.verify`, facade), `src/http/audit.ts`
- Test: `tests/helpers/store-contract.ts`, `tests/store.test.ts`, `worker-tests/audit-chain.test.ts` (create), `tests/http-audit.test.ts`

**Interfaces:**
- Consumes: `chainWalk`, `NO_ANCHOR`, `VERIFY_PAGE`, `AuditVerification` (Task 1); `SeqEntry` (Task 2).
- Produces: `BellmanStore.verifyAudit(orgId: string, from?: number): Promise<AuditVerification>`. `AuditDO.verify(from?)` pages `SELECT * FROM entries WHERE seq >= ? ORDER BY seq LIMIT VERIFY_PAGE` and feeds `chainWalk(anchor, from)` until `feed` returns false or a page is short; the anchor is KV `chain_anchor` (default `NO_ANCHOR`; written by Task 4). `MemoryStore.verifyAudit` feeds `streamOf(orgId)` once; anchor from the org's settings record (Task 4; `NO_ANCHOR` until then). Route: `GET /audit/verify?from=<seq>` → 200 with the verification; 400 `invalid_request` when `from` is present and not a positive integer.

- [ ] **Step 1: Write the failing contract cases**

```ts
it("verifyAudit over an intact stream is ok and counts every hashed row", ...)   // 3 rows → { ok: true, from_seq: 1, through_seq: 3, checked: 3, unhashed: 0, anchor: NO_ANCHOR }
it("verifyAudit resumes from a seq", ...)                                           // from: 2 → from_seq 2, checked 2
it("verifyAudit over an empty stream is ok with zero counts", ...)                  // Review Focus 2
```

- [ ] **Step 2: Run to verify failure**: `rtk proxy npx vitest run tests/store.test.ts -t verifyAudit > .vitest/verify.txt 2>&1; tail -5 .vitest/verify.txt` → FAIL, `store.verifyAudit is not a function`.

- [ ] **Step 3: Implement** in both stores and the interface. **Step 4:** Step 2's command → PASS; `npm run test:worker -- store-contract` → PASS.

- [ ] **Step 5: Tamper tests, one per store.** `tests/store.test.ts`: append 3 rows, reach into `(memory as unknown as { audit: { seq: number; entry: AuditEntry }[] }).audit[1].entry.action = "edited"`, expect `verifyAudit` `{ ok: false, broken_at: 2 }`. `worker-tests/audit-chain.test.ts`: append 3 through `DurableObjectStore`, `runInDurableObject(stub, (_i, ctx) => ctx.storage.sql.exec("UPDATE entries SET action = 'edited' WHERE seq = 2"))`, expect `broken_at: 2`; a second case deletes seq 2 and expects `broken_at: 3`. Run each; expected: PASS first time is acceptable here only because the walk's break detection was watched failing in Task 1; note it in the ledger.

- [ ] **Step 6: Route test** in `tests/http-audit.test.ts`: `GET /audit/verify` → 200 body `ok: true`; `?from=2` → `from_seq: 2`; `?from=x` and `?from=0` → 400; `member-a` → 403; `free-a` → 403. Run → FAIL 404 `not_found`. Implement the route in `auditRoutes` (the dispatch currently 404s anything but `/audit` and `/audit/export`; widen it to a `switch` on path). Run → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/store-do.ts src/http/audit.ts tests/helpers/store-contract.ts tests/store.test.ts tests/http-audit.test.ts worker-tests/audit-chain.test.ts
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 3/6: verifyAudit walks the chain from an anchor in both stores; GET /audit/verify"
```

---

### Task 4: Retention: settings, the sweep, the anchor, the AuditDO alarm

**Files:**
- Modify: `src/store.ts`, `src/store-do.ts` (`AuditDO`: KV `settings`, `chain_anchor`, `due:*`; `alarm()`; facade), `src/http/audit.ts`
- Test: `tests/helpers/store-contract.ts`, `tests/http-audit.test.ts`, `worker-tests/audit-sweep.test.ts` (create)

**Interfaces:**
- Consumes: `sweepPlan`, `SWEEP_BATCH`, `SWEEP_EVERY_MS`, `RETENTION_FLOOR_DAYS`, `SYSTEM_INTENT`, `AuditSettings`, `ChainAnchor` (Task 1); `orgEventEntry` (`src/grant-audit.ts`); `dueKey`, `dueNames`, `earliestDue`, `DUE_PREFIX` (`src/outbox.ts`).
- Produces:
  - `BellmanStore.auditSettings(orgId): Promise<AuditSettings>`; `setAuditRetention(orgId, days: number | null, audit: AuditIntent): Promise<AuditSettings>`; `sweepAudit(orgId, now: number): Promise<number>`.
  - `AuditDO` KV: `settings: { retentionDays: number | null }` (sink added in Task 5), `chain_anchor: ChainAnchor`, `due:sweep`, `due:sink`. Private `#arm(name, at)` (put the due row), `#disarm(name)`, `#reArm()` (list `DUE_PREFIX`, `earliestDue`, `setAlarm`/`deleteAlarm`), `alarm()` as RegistryDO's loop: for each `dueNames` name delete its row and run the handler (`sweep` → `this.sweep(Date.now())`, `sink` → Task 5), then `#reArm()`.
  - `AuditDO.setRetention(days, intent, now)`: one `transactionSync` writing `settings` and appending `audit_retention_set { days }`; then `#arm("sweep", now)` when `days !== null`, else `#disarm("sweep")`; returns settings.
  - `AuditDO.sweep(now)`: loop: read `SELECT seq, at, hash FROM entries ORDER BY seq LIMIT SWEEP_BATCH`, `sweepPlan(rows, now - days*86_400_000)`; null → stop; else one `transactionSync`: `DELETE FROM entries WHERE seq <= through`, `DELETE FROM delivered WHERE seq <= through`, put `chain_anchor`; accumulate; continue while the batch was full. After the loop, if anything was deleted append `audit_swept { through_seq, count }` with `SYSTEM_INTENT` (through `append`, so it chains from the anchor); `#arm("sweep", now + SWEEP_EVERY_MS)` when retention is still set. Returns the count.
  - `MemoryStore`: `private auditState = new Map<string, { retentionDays: number | null; anchor: ChainAnchor; sweepAt: number | null; sink: AuditSink | null; sinkAt: number | null }>()`; `sweepAudit` splices the org's rows by the same plan; `sweep(now)` runs `sweepAudit` for every org whose `sweepAt <= now` and re-dates it by `SWEEP_EVERY_MS`.
  - Routes: `GET /audit/settings` → `{ retention_days, sink }`; `PATCH /audit/settings` body `{ retention_days }` → 200 with the same shape, 400 `invalid_request` on a non-JSON body, a missing key, or `retentionDaysOf(...) === "invalid"`.
  - `tests/http-audit.test.ts` gains `send(who, path, method, body?: unknown)` (JSON body, `content-type: application/json`).

- [ ] **Step 1: Failing contract cases**

```ts
it("auditSettings defaults to no retention and no sink", ...)                         // { retentionDays: null, sink: null }
it("setAuditRetention stores the window and audits audit_retention_set by the caller", ...)  // last row action + detail { days: 90 }, actorUserId from the intent
it("sweepAudit deletes rows older than the window in seq order, stops at the first young row, anchors the chain and appends audit_swept", async () => {
  // rows at day(1), day(2), day(40), day(3) with retention 30 and now = day(40)+1h → deletes seq 1-2, returns 2
  // queryAudit newest-first: audit_swept { through_seq: 2, count: 2 } by "system", then day(3), day(40)
  // verifyAudit → ok, anchor { seq: 2, hash: <seq 2's hash> }, from_seq 3
})
it("sweepAudit with no window deletes nothing", ...)
it("sweepAudit past the whole stream leaves an empty stream whose next row chains from the anchor", ...)   // Review Focus 4
```

- [ ] **Step 2: Run to verify failure**: `rtk proxy npx vitest run tests/store.test.ts -t "auditSettings|setAuditRetention|sweepAudit" > .vitest/sweep.txt 2>&1; tail -5 .vitest/sweep.txt` → FAIL, not a function.

- [ ] **Step 3: Implement** the three methods in both stores, the AuditDO alarm loop and KV rows, the facade. **Step 4:** Step 2's command → PASS; `npm run test:worker -- store-contract` → PASS.

- [ ] **Step 5: Alarm test** `worker-tests/audit-sweep.test.ts`: `setAuditRetention("org_a", 30, by)` through `DurableObjectStore`, then `runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())` is non-null; `runDurableObjectAlarm(stub)` returns true and `due:sweep` is re-dated `SWEEP_EVERY_MS` ahead; `setAuditRetention(null)` → `getAlarm()` null. Run `npm run test:worker -- audit-sweep` → FAIL (no alarm); implement whatever Step 3 missed; → PASS.

- [ ] **Step 6: Route tests**: `GET /audit/settings` → `{ retention_days: null, sink: null }`; `PATCH` `{ retention_days: 90 }` → 200 `retention_days: 90` and the log's last row is `audit_retention_set`; `{ retention_days: 29 }`, `{ retention_days: "90" }`, body `not json`, `{}` → 400 (Review Focus 1); `null` → 200 null; `member-a` → 403; `PUT /audit/settings` → 405. Run → FAIL 404; implement; → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/store-do.ts src/http/audit.ts tests/helpers/store-contract.ts tests/http-audit.test.ts worker-tests/audit-sweep.test.ts
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 4/6: retention the org sets, swept in seq order by the stream's own alarm with the chain anchored across the sweep"
```

---

### Task 5: The sink: CRUD, the pump, the `sink` alarm

**Files:**
- Modify: `src/store.ts` (`MemoryStore` ctor option `post?: typeof fetch`), `src/store-do.ts`, `src/http/audit.ts`
- Test: `tests/helpers/store-contract.ts`, `tests/store.test.ts`, `tests/http-audit.test.ts`, `worker-tests/audit-sink.test.ts` (create)

**Interfaces:**
- Consumes: `newSink`, `sinkStatus`, `nextSinkState`, `batchBody`, `signBatch`, `sinkUrlOf`, `SINK_BATCH`, `SINK_DELAY_MS`, `SINK_TIMEOUT_MS`, `SYSTEM_INTENT` (Task 1); `randomId` (`src/oauth/tokens.ts`) for the secret; `entryView` (`src/http/audit.ts`) — move `AuditEntryView` and `entryView` into `src/audit.ts` (runtime-free; the route file re-exports them) so the store can build the batch without importing the HTTP layer.
- Produces:
  - `BellmanStore.setAuditSink(orgId, url, audit): Promise<{ sink: AuditSinkStatus; secret: string }>`; `removeAuditSink(orgId, audit): Promise<boolean>`; `resumeAuditSink(orgId, audit): Promise<AuditSinkStatus | undefined>`; `pumpAuditSink(orgId, now): Promise<AuditSinkStatus | undefined>`; `auditSettings().sink` populated.
  - `AuditDO`: KV `sink: AuditSink`. `append` after its transaction: when a sink exists, is not dead, and `due:sink` is absent, `#arm("sink", now + SINK_DELAY_MS)` and `#reArm()`. `pump(now)`: read sink (none or dead → return status / undefined, arm nothing: Review Focus 5); `SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT SINK_BATCH`; none → return status; build `batchBody(orgId, rows.map(entryView), first, last)`, `t = now`, headers `Bellman-Signature`, `Bellman-Delivery`, `Content-Type`; `fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(SINK_TIMEOUT_MS) })` in a try; outcome `ok` when `res.ok` with `through = last`, else `{ ok: false, error: String(res.status) }` or the thrown message; `nextSinkState(sink, outcome, now, more)` where `more = rows.length === SINK_BATCH`; put the sink; `armAt` → `#arm("sink", armAt)` else `#disarm("sink")`; `died` → append `audit_sink_dead { url, failing_since, last_error }` with `SYSTEM_INTENT`; `#reArm()`; return status. The alarm's `sink` handler calls `pump(Date.now())`.
  - `setSink(url, intent, now)`: secret `randomId(32)`, `deliveredThrough` kept from an existing sink; one `transactionSync` for the KV put and `audit_sink_set { url }`; then arm as `append` does. `removeSink`: delete KV and `due:sink`, append `audit_sink_removed { url }`, false when none. `resumeSink`: clear the four fields, append `audit_sink_resumed { url, delivered_through }`, `#arm("sink", now)`, undefined when none.
  - `MemoryStore`: the same over `auditState`, `post = this.options.post ?? fetch`; `sweep(now)` also pumps every org whose `sinkAt !== null && sinkAt <= now`; `appendAudit` dates `sinkAt = now + SINK_DELAY_MS` when a live sink has none.
  - Routes: `PUT /audit/sink` body `{ url }` → 200 `{ sink, secret }`, 400 when `sinkUrlOf` is invalid or the body is not JSON; `DELETE /audit/sink` → 204, 404 when none; `POST /audit/sink/resume` → 200 status, 404 when none.

- [ ] **Step 1: Failing contract cases**

```ts
it("setAuditSink returns the secret once, status ok with pending = rows not yet delivered, and audits audit_sink_set", ...)
it("setAuditSink again issues a new secret and keeps delivered_through", ...)
it("setAuditSink stores the url as given", ...)                                       // Review Focus 3: "https://u:p@collector.example/in#frag"
it("removeAuditSink is false when none, true once, and audits audit_sink_removed", ...)
it("resumeAuditSink is undefined when none and clears nothing on a healthy sink", ...)
it("pumpAuditSink is undefined when there is no sink", ...)
```

- [ ] **Step 2: Run to verify failure**: `rtk proxy npx vitest run tests/store.test.ts -t "AuditSink" > .vitest/sink.txt 2>&1; tail -5 .vitest/sink.txt` → FAIL, not a function.

- [ ] **Step 3: Implement** CRUD in both stores, the interface, the facade, the `AuditEntryView` move. **Step 4:** → PASS in both programs.

- [ ] **Step 5: Pump tests, MemoryStore** (`tests/store.test.ts`, `new MemoryStore({ post })` with a `post` that records requests and answers from a queue):
  - delivers rows after the cursor as one signed batch: body parses to `{ org_id, delivery: "org_a:1-3", entries: [3 views with seq and hash] }`, `Bellman-Delivery` matches, `Bellman-Signature` verifies against the secret with `crypto.subtle`; status `delivered_through: 3, pending: 0`.
  - a 500 reply: `status: "failing"`, `attempts: 1`, cursor unchanged; the next `sweep(now + backoffMs(1))` posts again, a 200 clears it.
  - a throw from `post`: same as a 500 with `last_error` the message.
  - 24 h of failure: `dead`, the log's last row `audit_sink_dead { url, failing_since, last_error }` by `system`, and the next `sweep` posts nothing (Review Focus 5).
  - `resumeAuditSink` after dead: `status: "ok"`, `attempts: 0`, the next `sweep(now)` posts.
  - more than `SINK_BATCH` rows: two posts in two sweeps, the second's delivery starting at 101.
  Run → FAIL; implement what is missing; → PASS.

- [ ] **Step 6: Pump test, Worker** (`worker-tests/audit-sink.test.ts`, stubbing `globalThis.fetch` the way `worker-tests/host.test.ts` does, restoring it in `afterEach`): `setAuditSink` then `appendAudit` → `getAlarm()` is set about `SINK_DELAY_MS` ahead; `runDurableObjectAlarm(stub)` → one POST captured with the three headers and a body whose `delivery` is `org_codenerd:<first>-<last>`; status `pending: 0`; a 503 reply → `status: "failing"` and `due:sink` dated `backoffMs(1)` ahead. Run → FAIL; implement; → PASS.

- [ ] **Step 7: Route tests**: `PUT /audit/sink { url: "https://c.example/in" }` → 200 `{ sink: { url, status: "ok", delivered_through: 0, pending: <n> }, secret: <string> }`; `{ url: "http://c.example" }`, `{}`, body `nope` → 400; `GET /audit/settings` now shows `sink`; `DELETE /audit/sink` → 204 then 404; `POST /audit/sink/resume` → 200 after a PUT, 404 after the DELETE; `member-a` → 403 on all three. Run → FAIL; implement; → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/audit.ts src/store.ts src/store-do.ts src/http/audit.ts tests/helpers/store-contract.ts tests/store.test.ts tests/http-audit.test.ts worker-tests/audit-sink.test.ts
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 5/6: one signed HTTPS sink per org — batched in seq order, retried with backoff, dead after a day, resumable"
```

---

### Task 6: Docs and the whole-suite run

**Files:**
- Modify: `docs-site/src/content/docs/guides/teams.md` (after the "A room that crosses organisations..." paragraph, before "## Reading and deleting closed rooms"), `docs/ARCHITECTURE.md` (the AuditDO row, one sentence: its alarm, its settings, its sink)

- [ ] **Step 1: Write the three subsections** under "The audit log" as `###` headings: "Tamper evidence" (the `hash` column, `GET /audit/verify`, what `broken_at` means, unhashed rows before the first hashed one), "Retention" (`PATCH /audit/settings`, the 30-day floor and why, the `audit_swept` row, the anchor and why verify still passes), "Streaming to a SIEM" (`PUT /audit/sink`, the secret shown once, the batch body with `delivery` as the idempotency key, the `Bellman-Signature` header with a four-line Node verification snippet, `detail` carries what the export carries, `failing`/`dead` and `POST /audit/sink/resume`). Each route named once with its status codes.

- [ ] **Step 2: Build the site**: `npm --prefix docs-site run build > .vitest/docs.txt 2>&1; tail -3 .vitest/docs.txt` → exit 0, no broken-link error.

- [ ] **Step 3: Whole suite**: `npm run verify > .vitest/verify-all.txt 2>&1; echo rc=$?; tail -15 .vitest/verify-all.txt` → `rc=0`.

- [ ] **Step 4: Commit**

```bash
git add docs-site/src/content/docs/guides/teams.md docs/ARCHITECTURE.md
git -c commit.gpgsign=true commit -S -m "Audit for a SIEM (#58), 6/6: the guide's tamper-evidence, retention and SIEM sections; ARCHITECTURE names the AuditDO's alarm"
```
