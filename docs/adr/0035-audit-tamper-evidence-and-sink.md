# ADR 0035 — Audit tamper evidence and delivery: a hash chain, org-set retention, a signed sink

**Date:** 2026-10-23 · **Status:** accepted · **Closes:** #58 · **Spec:** `docs/superpowers/specs/2026-10-23-audit-siem-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-audit-siem.md`

## Context

The audit trail (ADR 0025's spec) gave an org a stream it can page and export, and left three things
to #58: streaming to a SIEM, a way to tell that rows were not edited after the fact, and a retention
window with a sweep. #61 turned the second into a requirement: once operator reads are audited into
a customer's stream, an entry the operator could quietly delete is not an audit entry. The
entitlement `auditRetentionMs` has been `null` on every plan since D9, with no sweep behind it.

## Decision

1. **Every row is chained.** `append` computes `hash = sha256(seq, prev_hash, record)` inside the
   same synchronous transaction that writes the row, with `node:crypto`'s `createHash` because
   `crypto.subtle` is async and would let another append land between the read of the previous hash
   and the write. Rows from before this change stay unhashed; the chain starts at the first hashed
   row. The hash is on every read (page, export, sink), and `GET /audit/verify` walks the chain and
   names the first break.
2. **Retention lives with the stream, not on the org.** The window and the sink are keys in the
   `AuditDO`, written in the same transaction as the audit row that records the change. A sweep that
   read its window from the registry would be a cross-object read of exactly the kind ARCHITECTURE
   warns about; and `PATCH /org`'s field list stays what ADR 0031 left it. The org sets
   `retention_days` as `null` or an integer of at least 30: an audit log an admin can shorten to a
   day is a deletion tool with a different name. The sweep deletes in seq order from the oldest row
   and stops at the first row young enough, never by `at` alone, so the surviving prefix of the chain
   is intact; it records the newest deleted row's `(seq, hash)` as the anchor the next verification
   starts from, and appends `audit_swept` as the system actor.
3. **The sweep does not wait for the sink.** A sink that has been down for a week does not hold the
   window open. The sink's `delivered_through` beside the anchor's `seq` says exactly which rows were
   swept undelivered; the export always exists.
4. **One sink per org, batched, signed, at least once.** `append` arms a named alarm five seconds
   out so a burst is one POST of up to 100 rows in seq order. The body is signed Stripe-style
   (`Bellman-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`) with a secret the admin sees once on
   `PUT /audit/sink`; the receiver dedupes on `(org_id, seq)`. Failure backs off with the outbox's
   curve and parks the sink as dead after 24 hours of continuous failure, recorded in the stream as
   `audit_sink_dead`; `POST /audit/sink/resume` restarts it from its cursor.
5. **`detail` ships.** It is the object the export already hands the same org; it holds ids,
   lengths and counts, never message or brief content (audit spec, Security). The guide says so.

## Consequences

- `AuditEntryView` gains `hash`. The dash's Audit page can show it; a verify button and a settings
  card (retention, sink status, resume) are a dash issue.
- `Entitlements.auditRetentionMs` is unchanged and still `null`: the plan's default. The org's own
  window is `GET /audit/settings`'s `retention_days`; the dash follows in its own issue.
- Verification proves the stream was not edited since each row was written, not that every event
  was written: the writer is still the Worker. The sink's signed copy is what lets an org hold a
  record the operator cannot rewrite without the copy disagreeing.
- `BellmanStore` grows eight methods, every one in the conformance suite; the delivery leg is
  injected (`post`) so the suite needs no HTTP and the Worker's is covered with `fetchMock`.
- Operator reads (`operator_read`, `impersonatedBy`) stay with #61 and #67.
