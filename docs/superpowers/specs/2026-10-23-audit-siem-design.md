# Audit for a SIEM: tamper evidence, retention, and a signed sink

**Issue:** #58. **Builds on:** `docs/superpowers/specs/2026-10-09-audit-trail-design.md` (D1–D12 shipped: the stream, the page, the export). **ADR:** 0035.

The audit trail spec ended with a list of what it did not do and left to #58: stream to a SIEM, sign or chain rows, set and sweep a retention window. #61 then made the first of those a requirement rather than an option: once operator reads are audited to a customer's stream, "an audit entry an operator can delete is not an audit entry", so the stream needs tamper evidence a customer can check from a copy they hold.

This spec adds three things to the stream an org already has, and nothing to what is written into it:

1. **A hash chain** over the rows, computed when a row is appended, carried on every read, and verifiable by the org.
2. **A retention window the org sets**, swept by the stream's own object, with the chain anchored across the sweep.
3. **A sink**: one HTTPS endpoint per org that receives every row in order, batched, signed, retried, and parked as dead after a day of failure.

## What is already true, and stays true

- A row is written once, by `AuditDO.append`, in one synchronous transaction, at most once per outbox intent (audit spec D5, D6). Nothing here changes how a row arrives.
- The page (`GET /audit`) and the export (`GET /audit/export`) are the org's own reads, on the team plan, the admin role and an org (`auditRefusal`). Every route below sits behind the same check.
- The org in an audit route is always the caller's own. No route here takes an org id.
- Reads are not audited. `bellman_sync`, the page, the export and the public pages write no row. Operator reads will be audited to the customer's stream when the operator console exists (#61, #67); the `operator_read` action and `impersonatedBy` are that issue's, not this one's.
- `Entitlements.auditRetentionMs` stays as D9 left it: `null` on every plan, read by the dash as the plan's default. The window an org sets (D2 below) is a separate field, on the audit settings, and the dash follows in its own issue.

## D1. The hash chain

Every row appended from this change on carries two new columns:

| column | value |
| --- | --- |
| `prev_hash` | the `hash` of the row with the previous `seq`, or `""` when there is none |
| `hash` | SHA-256, hex, of `${seq}\n${prev_hash}\n${JSON.stringify(recordOf(entry))}` |

`recordOf` binds the row's columns in `AUDIT_COLUMNS` order, so the hashed string is the row as stored, with its position. A row moved, edited, removed from the middle, or inserted after the fact changes every hash after it.

The hash is computed **inside `append`'s `transactionSync`**, with `createHash("sha256")` from `node:crypto` (`nodejs_compat` is on; `src/bus.ts` already hashes this way). `crypto.subtle` is async and cannot run inside the transaction without letting another append interleave between reading the previous hash and writing this row. Reading the previous row's hash is one `SELECT hash FROM entries ORDER BY seq DESC LIMIT 1` in the same transaction.

Rows written before this change have `hash` and `prev_hash` null. The chain starts at the first hashed row, whose `prev_hash` is `""`. Rows the KV migration moved keep their seqs and are unhashed; nothing rewrites history.

**On the wire.** `AuditEntryView` gains `hash: string | null` (the page and both export formats). A SIEM that keeps the rows keeps the hashes; the org can later check its copy against the stream, or the stream against itself.

**Verification.** `GET /audit/verify?from=<seq>` walks the chain from `from` (default: the oldest row) in pages of 500 and returns:

```json
{ "ok": true, "from_seq": 1, "through_seq": 4120, "checked": 4120, "anchor": { "seq": 0, "hash": "" } }
{ "ok": false, "from_seq": 1, "through_seq": 2207, "checked": 2207, "broken_at": 2208, "anchor": { "seq": 0, "hash": "" } }
```

The walk recomputes each row's hash and compares it to the stored one and to the next row's `prev_hash`. The first row's `prev_hash` must equal the anchor (D2). An unhashed row before the first hashed one is skipped and counted in `unhashed`; an unhashed row after a hashed one is a break. ponytail: one request walks the whole stream; a stream too long for one request resumes with `from`.

`MemoryStore` chains the same way, in `recordAudit`, so the conformance suite proves both stores produce the same hash for the same row.

## D2. Retention the org sets

`AuditSettings` lives with the stream, in the `AuditDO`'s own storage, not on the `Org` record in the registry: a sweep that read its window from another object would be the cross-object gap ARCHITECTURE warns about, and every write to the settings is audited into the same stream in the same transaction.

```ts
interface AuditSettings { retentionDays: number | null; sink: AuditSinkStatus | null }
```

- `retentionDays` is `null` (kept with no expiry, as today) or an integer **≥ 30**. The floor is the point: an audit log an admin can set to one day is a deletion tool, and 30 days is the shortest window a reviewer would accept. There is no ceiling.
- `PATCH /audit/settings { "retention_days": 90 | null }` sets it, 400 below 30 or not an integer, and appends `audit_retention_set { days }` by the caller.
- `GET /audit/settings` returns `{ retention_days, sink }`.

**The sweep.** When a window is set, the object arms a named alarm `sweep` (`due:sweep`, the outbox's named-alarm rows, `dueNames` / `earliestDue` / `mergeDue` reused) for now, and after each run for 24 hours later. A run deletes rows from the oldest upward while `at < now - days × 86 400 000`, 500 at a time, **in seq order and stopping at the first row that is young enough**: a delete by `at` alone could remove a row from the middle of the chain, since `at` is the writer's clock and `seq` the insertion order. Rows in `delivered` at or below the last deleted seq go with them.

**The anchor.** In the same transaction as the delete, the object stores `chain_anchor = { seq, hash }` of the newest row deleted. The oldest surviving row's `prev_hash` equals that hash, so verification still starts from a known value. Before any sweep the anchor is `{ seq: 0, hash: "" }`.

A sweep that deleted anything appends `audit_swept { through_seq, count }` as `SYSTEM_ACTOR`, so the stream and the sink both record what left it. Setting the window to `null` disarms the alarm and deletes nothing.

The sweep does not wait for the sink. A row the sink never delivered is swept on schedule like any other; the sink's `delivered_through` and the anchor's `seq` together say what was lost, and the export is always there. A dead sink that could hold retention open would grow the stream without bound.

## D3. The sink

One endpoint per org. The org's admin gives a URL; the stream posts every row to it, in seq order, signed with a secret the admin sees once.

```ts
interface AuditSink { url: string; secret: string; createdAt: number; deliveredThrough: number; attempts: number; failingSince: number | null; lastError: string | null; dead: boolean }
interface AuditSinkStatus { url: string; created_at: string; delivered_through: number; pending: number; status: "ok" | "failing" | "dead"; failing_since: string | null; last_error: string | null; attempts: number }
```

**Routes** (all on `auditRefusal`):

| route | does | audits |
| --- | --- | --- |
| `PUT /audit/sink { url }` | sets or replaces the sink; a new secret every time; `delivered_through` kept when a sink already existed, 0 when not. Returns `{ sink, secret }`; the secret is never returned again. 400 unless `url` parses and is `https:`. | `audit_sink_set { url }` |
| `DELETE /audit/sink` | removes it, secret and cursor. 404 when there is none. | `audit_sink_removed { url }` |
| `POST /audit/sink/resume` | clears `dead`, `attempts`, `failingSince`, `lastError`; arms delivery now. 404 when there is none. Returns the status. | `audit_sink_resumed { url, delivered_through }` |
| `GET /audit/settings` | the status, with retention | — |

**Delivery.** `append` arms the named alarm `sink` for `now + 5 000 ms` when a sink exists and none is armed, so a burst of rows goes as one batch. The handler:

1. Reads up to 100 rows with `seq > deliveredThrough`, oldest first. None: stops, arms nothing.
2. Builds the body: `{ "org_id", "delivery": "<orgId>:<firstSeq>-<lastSeq>", "entries": [AuditEntryView...] }`. Each entry carries its `seq` and `hash`. `seq` with `org_id` is the idempotency key the receiver dedupes on: delivery is at least once, and a batch acknowledged after the cursor write was lost is sent again.
3. Signs: `Bellman-Signature: t=<unix ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, the Stripe shape, so a receiver bounds replay by `t` and verifies with one line. `crypto.subtle` is fine here: the alarm is not a transaction. Also sends `Bellman-Delivery: <delivery>` and `Content-Type: application/json`.
4. `POST`s with a 10 s timeout. Any 2xx: `deliveredThrough = lastSeq`, `attempts = 0`, `failingSince = null`; more rows remain → arms the alarm for now. Anything else (a non-2xx, a throw, the timeout): `attempts += 1`, `failingSince ??= now`, `lastError = "<status>"` or the error's message, arms for `now + backoffMs(attempts)` (the outbox's: 1 s doubling, capped at 5 minutes).
5. When `now - failingSince ≥ 24 h`: `dead = true`, arms nothing, appends `audit_sink_dead { url, failing_since, last_error }` as `SYSTEM_ACTOR`. The row itself is not delivered until the admin resumes; it is what the page shows them.

The sink's state is one KV key `sink` in the object. The cursor write and the `delivered` dedupe are unrelated: `delivered` is the inbound at-most-once marker, `deliveredThrough` the outbound cursor.

**`detail` ships.** A row's `detail` holds ids, lengths, counts and keys, never message or brief content (audit spec, Security; the guide lists each action's detail). The export already hands the org the same object as a file; the sink hands the same org the same rows over a channel it chose and signed for. The guide says so beside the sink, and the DPA question the issue raised is answered there: nothing crosses that the org could not already download.

**A cross-org room's row** is in both orgs' streams (audit spec, D2), so both sinks receive their own copy; neither sees the other's.

**What the endpoint is not checked for.** The URL must be `https:` and carry no username or password: `fetch` refuses a credentialed URL, and the URL is written into audit rows the stream keeps. It is not resolved or range-checked: a Worker's `fetch` reaches public hosts, and a customer pointing their own stream at their own collector is the feature. A receiver that wants to be sure the sender is Bellman verifies the signature.

## D4. The conformance seam

New `BellmanStore` methods, every one async, both stores, the contract suite asserting them identically:

```ts
auditSettings(orgId): Promise<AuditSettings>
setAuditRetention(orgId, days: number | null, audit: AuditIntent): Promise<AuditSettings>
setAuditSink(orgId, url: string, audit: AuditIntent): Promise<{ sink: AuditSinkStatus; secret: string }>
removeAuditSink(orgId, audit: AuditIntent): Promise<boolean>
resumeAuditSink(orgId, audit: AuditIntent): Promise<AuditSinkStatus | undefined>
verifyAudit(orgId, from?: number): Promise<AuditVerification>
sweepAudit(orgId, now: number): Promise<number>          // rows deleted; what the alarm calls
pumpAuditSink(orgId, now: number): Promise<AuditSinkStatus | undefined>   // one delivery attempt; what the alarm calls
```

`sweepAudit` and `pumpAuditSink` are the alarm handlers' bodies, exposed so a test can run one tick without a clock. The HTTP leg of `pumpAuditSink` goes through `post: typeof fetch`: a `MemoryStore` option (default `fetch`), and in the Worker the global. The pure parts, runtime-free in `src/audit-sink.ts`: `chainHash`, the signature header, the batch body, `nextSinkState(state, outcome, now)`, and `sweepPlan(rows, cutoff)`; vitest-tested on their own. The Worker's delivery is covered in `worker-tests/` with `fetchMock`, as `host.test.ts` does.

## D5. Docs and the ADR

- The guide's "The audit log" section gains "Tamper evidence" (the hash, verify, what a break means), "Retention" (the floor, the sweep row, the anchor) and "Streaming to a SIEM" (the sink, the signature with a verification snippet, the idempotency key, what `detail` carries, dead and resume).
- ADR 0035 records the three decisions and the two refusals (retention lives with the stream, not the org; the sweep does not wait for the sink).
- No tool changes: `bellman_audit` is untouched, so `docs:gen` and `extension/manifest.json` are not.

## Security

- Routes are the org's own, behind `auditRefusal`; the sink secret is shown once and stored in the stream's object, which only the Worker reads.
- The chain proves the stream was not edited since a row was written. It does not prove a row was written: the writer is still the Worker. A copy at the sink, signed on the way out, is what gives the org a record the operator cannot later rewrite without the org's copy disagreeing.
- `detail` is the object the export already ships; the sink introduces no new content.

## Follow-ups, not this spec

- Dash: an audit settings card (retention, sink with its status and resume, a Verify button), and the Audit page reading `retention_days` from `/audit/settings` instead of the plan's entitlement.
- Operator reads and `impersonatedBy` (#61, #67).
- A per-row signature by a key the org could verify offline, rather than a chain plus a signed delivery, if a customer's auditor asks for it.
