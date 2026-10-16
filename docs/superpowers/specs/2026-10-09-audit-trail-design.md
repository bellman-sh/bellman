# The audit trail: cross-org crossings, filters and export

**Issues:** bellman-sh/dash#11, and the audit part of #49 (`GET /audit` and its
export). It is also the query and export half of #58; streaming, retention
sweeps and tamper evidence stay there. Builds on the per-org `AuditDO`, on
`auditEntries` in `src/rooms.ts`, and on the reader conditions `bellman_audit`
and the durable room record (#65, D4) already use.

**Status:** design agreed 2026-10-09; implemented on the audit-trail branches,
bellman first.

**Scope:** every audit row records who acted, from which org, in which room,
and which orgs the room held at that moment. A row reaches every one of those
orgs, and says from its reader's side whether it crossed a boundary and in
which direction. `AuditDO` keeps its rows in SQL, so one query serves filters,
paging and export. The Worker serves `GET /audit` and `GET /audit/export`, and
dash's Audit page reads them. Two PRs, this repo's first (D12).

## Problem

dash#11 asks for the human view of `bellman_audit`: a chronological log of
boundary crossings that a compliance reviewer can filter, trust and export, in
which a cross-org crossing is visible from both orgs' views with the right
direction. Four things in the Worker stand in the way.

- **No read beyond a limit.** `auditForOrg(orgId, limit)` is the whole query
  interface: no cursor, no date range, no filter, no export, and no HTTP route.
- **A row cannot say what crossed.** `AuditEntry` is `{ at, orgId, sessionId,
  actorUserId, action, detail }`. Each org's copy carries only its own `orgId`,
  so nothing records the actor's org, the room's org or the room's name. B's
  copy of something A's member did looks exactly like a row about B's own
  people.
- **The fan-out misses the crossing that matters most.** `auditEntries` writes
  to the room's org, the actor's org and `alsoOrgs`. When Ana (org A) sends a
  message in A's room while Bo (org B) is in it, A's context reaches B, but A's
  row looks internal and B gets no row at all.
- **Retention is undefined.** Rows are kept forever and nothing says so.

## Decisions

### D1. A crossing is decided by the roster

A row goes to every org that is a party to the action:

- the room's org;
- the actor's org;
- every org in `alsoOrgs` (an eviction's or a timeout's subject);
- the org of every person still in the room (`isActivePerson`) when the
  action happens.

The hosted seat is not a party: it acts for the room. An act nobody in the room
sees, a preview of the room before joining (`connect_previewed`), has as parties
only the room's org and the actor's: the people in the room were shown nothing,
and a previewer who never joins is not named to them. A person with no org is
a party with no stream: they make a room cross-org for everyone else, and
receive no row.

So when Ana sends in A's room with Bo present, A's row and B's row both
record the send. B learns who did what, when and in which room, never the
content, about a room its own member already sits in.

### D2. A row records what it was about, as of then

`AuditEntry` gains six fields, each optional because rows written before this
change have none of them:

```ts
// src/types.ts, AuditEntry
actorLabel?: string | null;            // the actor's display name at the time
actorOrgId?: string | null;            // the actor's org; the hosted seat's is the room's
roomName?: string | null;              // manifest.room, so the name outlives a purge; null off a room
parties?: (string | null)[];           // D1's orgs, sorted, null last; null stands for a person with no org
crossing?: "internal" | "cross_org";   // D3, from this row's stream
direction?: "outbound" | "inbound" | null;  // D3, on cross_org rows only
```

Every builder fills them in: `auditEntries` (`src/rooms.ts`),
`hostSentEntries` (`src/store.ts`), `roomPurgedEntry` and `roomDeletedEntry`
(`src/retention.ts`) and the grant entries (`src/grant-audit.ts`). One function
in a new `src/audit.ts` takes a stream's org, the parties and the actor, and
returns `crossing` and `direction`. Every builder calls it, so the rule lives
in one place.

The purge and delete rows already go to `orgsOnRoster`. Their parties are that
roster, departed members included. A grant row is about an org's own plan:
its parties are its org, it is internal, and it has no room.

Members, as the page shows them, are the actor and, where `detail` names one,
the subject of an eviction or a timeout. The roster's orgs are recorded; the
roster's people are not.

A delete names its asker by user id, label and org: `schedulePurge` takes the
asker, not only an id. An admin's grant intent carries the admin's label and
org.

### D3. Crossing and direction belong to the stream

A row's copies differ by stream. In stream X:

- `crossing` is `cross_org` when `parties` holds anything but X, and
  `internal` otherwise.
- `direction` is `outbound` when the actor's org is X, `inbound` when it is not,
  and `null` when the row is internal or the actor is `system`.

Ana's send is `outbound` in A's stream and `inbound` in B's. An eviction of B's
member by A's creator is `outbound` for A and `inbound` for B. Each `AuditDO`
is one org's stream, so both values are computed once, by the builder, for the
copy it addresses. They are stored as columns, and the scope filter is a plain
`WHERE`.

### D4. Rows written before this record no crossing

A row from before D2 has no parties, crossing or direction, and nothing
backfills it: the roster today is not the roster then. Such rows show in an
unfiltered view as "not recorded". A scope filter leaves them out, and the
response counts what it left out (`unrecorded`, D7), so the page can say so.

### D5. `AuditDO` keeps its rows in SQL

`AuditDO` was declared in `new_sqlite_classes` from the start but uses only
the KV API: `a:<padded seq>` per row, a `seq` counter and `d:<intent>`
delivery markers. It moves to two tables in the same database:

```sql
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  org_id TEXT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT,
  actor_org TEXT,
  room_name TEXT,
  parties TEXT,          -- JSON array; null before D2
  crossing TEXT,         -- null before D2
  direction TEXT,
  detail TEXT NOT NULL   -- JSON object
);
CREATE INDEX IF NOT EXISTS entries_at ON entries (at);
CREATE TABLE IF NOT EXISTS delivered (intent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
```

`AUTOINCREMENT` never reuses a seq, so a cursor once handed out never names
another row. Each row keeps its `org_id`, as the entry it was written from
carries it, so `recent` and the query hand an entry back whole.

**Append** is one `transactionSync`: look up the intent in `delivered`, insert
the row, record the intent. `sql.exec` and `ctx.storage.kv` are synchronous in
a SQLite-backed object, so nothing can come between the look and the write.
That is the guarantee the async transaction's comment defends today, now held
by construction.

**Migration** runs in the constructor, under `blockConcurrencyWhile`, as one
`transactionSync`. It creates the tables, copies every `a:` row and every `d:`
marker, and deletes the `a:`, `d:` and `seq` keys. An interruption leaves the
KV state or the SQL state, never half of each. Into an empty table each row
keeps the seq in its key, which keeps every cursor already handed out valid,
and that is the only time the key seqs are kept. A later wake can find KV rows
beside rows already in the table: an older Worker wrote them during a
rollback, reading the `seq` counter the move deleted as 0 and counting again
from 1. Those are appended in key order with fresh seqs, so nothing collides
and the object still wakes. `ponytail:` one transaction is fine for thousands
of rows. A stream far larger than any team holds today would batch it.

### D6. One query, in both stores

```ts
// src/audit.ts
export interface AuditQuery {
  from?: number;     // epoch ms, inclusive
  to?: number;       // epoch ms, exclusive
  actor?: string;    // actor user id
  room?: string;     // session id
  org?: string;      // matches any entry of `parties`
  action?: string;
  scope?: "internal" | "cross_org";
  before?: number;   // seq: rows older than this
  through?: number;  // seq: rows at or below this
  limit: number;
}

export interface AuditPage {
  entries: (AuditEntry & { seq: number })[];  // newest first
  next: number | null;     // pass as `before` for the next page; null at the end
  through: number | null;  // the highest seq the query covered; null for an empty stream
  total: number;           // rows matching the filters, at or below `through`
  unrecorded: number;      // rows matching every filter but scope, with no crossing; 0 without scope
}

export interface AuditFacets {
  actors: { id: string; label: string | null }[];
  rooms: { id: string; name: string | null }[];
  orgs: string[];          // other orgs named in parties; never the reader's own
  actions: string[];
}
```

`BellmanStore` gains `queryAudit(orgId, query)` and `auditFacets(orgId)`.
`auditForOrg(orgId, limit)` stays as it is, the newest `limit` oldest first:
`bellman_audit` reads it, and so do about 130 test assertions, which would
churn for no behaviour.

Without `through`, a query covers rows up to the newest seq when it runs, and
says which seq that was. Paging passes it back, so a row written meanwhile
cannot shift a page, the total or an export.

In `AuditDO`, the query is one `SELECT … WHERE … ORDER BY seq DESC LIMIT ?`
built from bound parameters only. The org filter is
`EXISTS (SELECT 1 FROM json_each(parties) WHERE value = ?)`. `total` and
`unrecorded` are two `COUNT`s over the same `WHERE`. Facets are four
`GROUP BY` reads ordered by `MAX(seq) DESC`, up to 200 each, so a label or a
room name comes from its newest row. `ponytail:` `at` is the only index;
filters on actor, room and action read backwards by seq, and gain indexes when
a stream is large enough to feel it. `MemoryStore` keeps a seq per org and
filters an array. `tests/helpers/store-contract.ts` holds both to the same
answers.

### D7. `GET /audit`

A new module, `src/http/audit.ts`, mounted in `src/worker.ts` as `/presets` is:
behind `unconfigured`, with the same caller (cookie or bearer), CORS for the
panel's origins and the same preflight. It is a read, so it needs no CSRF check.

The gate is `auditRefusal` in `src/audit.ts` (team plan, admin role, an org),
which names the condition that failed. `bellman_audit` and the room routes'
`isOrgAdmin` ask it too, so the three conditions cannot drift apart. The org is
always the caller's own, never a parameter. A refusal is a 403 in
`bellman_audit`'s words for the first condition that fails: the plan, the role
or the org.

Query parameters, all optional, combine with AND:

| Parameter | Value |
|---|---|
| `from`, `to` | ISO 8601 instants; the date must be a real calendar date: 2026-02-30 is refused, not rolled over. `from` inclusive, `to` exclusive |
| `actor`, `room`, `org`, `action` | an id or action name, 1 to 200 characters |
| `scope` | `internal` or `cross_org` |
| `before`, `through` | a seq: a whole number, 0 or more |

Anything else is a 400 `invalid_request` that names the parameter. A page is
100 rows. The answer:

```json
{
  "org_id": "org_a",
  "entries": [{
    "seq": 1234, "at": "2026-10-09T14:02:11.000Z", "action": "sent_message",
    "room": { "id": "qs_…", "name": "q3-plan" },
    "actor": { "id": "u_github_1", "label": "Ana", "org_id": "org_a" },
    "parties": ["org_a", "org_b"], "crossing": "cross_org", "direction": "outbound",
    "detail": { "chars": 812 }
  }],
  "next": 1100, "through": 1234, "total": 1873, "unrecorded": 0,
  "facets": { "actors": [], "rooms": [], "orgs": [], "actions": [] }
}
```

`room` is null on a grant row, whose session id is `grant:<key>`. On a row from
before D2, `parties`, `crossing` and `direction` are null and the actor's
label and org are absent. `facets` comes with the first page only, the one
with no `before`, and covers the whole stream, so a filter's options do not
disappear as the filters narrow.

### D8. `GET /audit/export`

The same module, gate and filters, plus `format`, `csv` or `json`, which is
required. `before` is refused, and `through` is optional: the panel always
sends the one its first page returned, and a caller who sends none is pinned
to the newest row when the export starts. The route walks `queryAudit` in
pages of 500 and streams what it reads, newest first, the order the page
shows.

- **Headers:** `Content-Disposition`, written by `attachmentDisposition` in the
  RFC 8187 form `attachment;
  filename*=UTF-8''bellman-audit-<org>-<through>.<csv|json>`, with any
  character of the org id outside `[A-Za-z0-9_.-]` written as `_`, so no id can
  break the header; `Cache-Control: no-store`; and
  `Access-Control-Expose-Headers: Content-Disposition`, without which the
  panel's fetch could not read the filename.
- **CSV:** one header row, then `seq, at, action, room_id, room_name,
  actor_id, actor_label, actor_org, parties, crossing, direction, detail`.
  `parties` is joined with `;`, with `(no org)` for null. `detail` is its
  JSON. Fields are quoted per RFC 4180. A cell that begins with `=`, `+`, `-`,
  `@`, a tab or a carriage return gets a leading `'`: room names and labels
  are written by users, and a spreadsheet would otherwise run them as
  formulas.
- **JSON:** `{ "org_id", "filter", "through", "entries": […] }`, with the same
  entry objects as `GET /audit`.
- **A failure partway** errors the stream instead of closing it. A reader sees a
  failed body, never a file that is cut short and looks complete.

`ponytail:` an export is one request over the whole filtered stream. A stream
large enough to strain that wants #58's push, not a longer request.

### D9. Retention is an entitlement the page reads

`Entitlements` gains `auditRetentionMs: number | null`, `null` on every plan:
audit rows are kept with no expiry, which is what happens today. `/account`
sends the whole entitlements object, so the panel reads it with no route
change. The page says "Kept with no expiry." for `null` and "Kept for N
days." for a number, and says nothing when a Worker that predates the field
omits it. When #58 decides a window and a sweep, the page follows without a
panel change.

### D10. The Audit page

`/audit` in dash replaces its placeholder:

```
Audit                                          Kept with no expiry.
Every crossing that touched your org's boundary.

[From] [To] [Member▾] [Room▾] [Org▾] [Event▾]   All | Internal | Cross-org
1,873 entries                                 [Export CSV] [Export JSON]

TIME          EVENT          ROOM     MEMBER  ORG          DIRECTION
▌Oct 9 14:02  sent_message   q3-plan  Ana     org_a (you)  → out  A⇄B
▌Oct 9 14:03  sent_message   q3-plan  Bo      org_b        ← in   A⇄B
 Oct 9 13:40  invite_issued  standup  Ana     org_a (you)  internal
                                                         [Load older]
```

- **The URL holds the filters.** The route's `validateSearch` takes `from, to,
  actor, room, org, action, scope`, so a filtered view is a link and Back
  undoes a filter. The loader reads `/account` and, only for an account the
  gate admits (D11), the first page of `GET /audit`.
- **Filters:** native date inputs, in which the "to" day counts in full;
  native selects filled from `facets`; and a segmented scope control like the
  Rooms status filter. When `unrecorded` is above 0, a line says how many
  earlier entries the scope filter left out.
- **Rows:** a cross-org row carries a brass rule and its parties, so it reads
  as one at a glance. Member is the actor; the detail names the subject of an
  eviction or a timeout. Times are local, with the ISO instant in `title`.
  Direction reads "→ out", "← in", "internal" or "not recorded". "Load older"
  appends the next page with `before=next` and the first page's `through`.
- **Detail:** a row expands inline, as a button the keyboard reaches, to its
  ids, parties and `detail`, all shown as text and never as markup. Expanding
  a room's row asks `GET /rooms/:id` once. A 200 offers **Open room**. A 404
  says the room has been deleted, or is still open and the reader is not in
  it, since an admin reads a closed room (#65, D4) and not an open one.
- **Export:** a `fetch` with credentials, carrying the filters, the format
  and the first page's `through`. It is saved only after `response.blob()`
  resolves, under the server's filename. A refusal or a failed stream shows
  inline as "Export failed; nothing was saved." A line says the export holds
  all `total` entries matching the filters as of the page's load, so the file
  can be checked against the count.

### D11. A reader the log does not admit sees why, never a 403 screen

The page decides from `/account`, and the Worker still refuses on its own
(D7). The gate reads `entitlements.audit`, not `plan === "team"`, so a plan
that gains audit later is admitted without a panel change.

1. **No audit on the plan:** what the audit trail is, and #10's upgrade path:
   the Team payment link and Compare plans. A plan set by the operator gets
   Billing's sentence and no purchase link. The links move from
   `src/routes/billing.tsx` into `src/lib/account.ts` so both pages read one
   copy.
2. **On a plan with audit, not an admin:** "Only an org admin can read the
   audit trail. Ask one."
3. **No org:** "Your account has no org, so there is no audit stream to read."

### D12. Two PRs, this repo's first

The Worker PR lands and deploys before the dash PR merges. The order matters:
until the Worker serves `/audit`, a cross-origin fetch of it gets no
`Access-Control-Allow-Origin`, and the browser reports that as a network
failure, which the panel cannot tell from the Worker being down. Settings
could merge in either order because it read one more field on a route that
already existed. This adds routes.

## What this does not do

- Stream to a SIEM, sign rows, chain hashes, or set and sweep a retention
  window. Those are #58.
- Audit reads. `bellman_sync` and a public room's anonymous reads still leave no
  row; whether they should is #58's completeness question.
- Give `bellman_audit` the filters. The tool keeps its limit.
- Backfill rows written before D2 (D4).
- Record the full roster on each row. The roster's orgs are recorded, its
  people are not.
- Name orgs. Orgs show by id until #53 makes them objects.

## Security

- **Tenant.** The org is the caller's own, from the identity `auditRefusal`
  admits. The `org` parameter only narrows the caller's own stream, and no
  parameter reaches another org's object.
- **What a party learns.** Under D1, B's stream records A's member's actions in
  a room B's member sits in: the actor's id, label and org, the room's id and
  name, the action and `detail`. `detail` holds counts, keys, roles and ids,
  never message content, and B's member could already see each of these in
  the room. The README's promise holds: each side sees the crossings that
  touched its own boundary and nothing else.
- **SQL.** Every value is a bound parameter. The `WHERE` clause is assembled
  from fixed fragments only.
- **CSV.** The formula guard (D8). Peer-written strings (labels, room names,
  `detail.agent`) are data in every format.
- **The panel.** Every field renders as text. The export is a read under the
  cookie, so it needs no CSRF check, and CORS names the panel's origins only.

## Errors

- **Worker:** 401 without a caller; 403 naming the failed condition; 400
  naming the bad parameter; 405 for another method; 500 in the module's usual
  words. A migration that throws leaves the KV state, and the next wake runs it
  again.
- **Panel:** a 401 from a loader goes to sign-in; anything else from the loader
  shows the route's error screen and its retry. An export or a room check that
  fails says so inline and keeps the page.

## Testing

Worker:

- **Store contract**, against both stores: each filter alone and combined;
  `before` and `through` paging returns no row twice, skips none, and leaves
  out a row written after `through`; `total`, `unrecorded` and facets; and
  `auditForOrg` unchanged.
- **Fan-out**, in `tests/rooms.test.ts`: Ana's send in A's room with Bo present
  is `outbound` in A's stream and `inbound` in B's; a person with no org makes
  the room cross-org and receives no row; the hosted seat does not; an
  eviction reaches the evicted member's org as `inbound`; a `connect_previewed`
  row reaches only the room's org and the previewer's; purge, delete and
  grant rows carry their parties.
- **`AuditDO`**, in `worker-tests/`: a stream seeded in the KV shape (`a:`,
  `d:`, `seq`) wakes into SQL with its seqs; a redelivered intent that was
  delivered before the migration appends nothing; the next append takes the
  next seq.
- **Routes**, in `tests/http-audit.test.ts`: 401; each 403; each 400; 405;
  CORS and the exposed header; the list's shape and facets on the first page
  only. Each acceptance check of dash#11 runs through HTTP: a crossing read by
  both orgs carries the right direction for each, and the CSV and JSON exports
  hold exactly the rows the list pages through, for a filter that combines
  scope, actor and a date range. The CSV's quoting and formula guard. A stream
  that fails partway is errored, not closed.

Dash:

- `src/lib/audit.test.ts`: search params to query and back, with the "to" day
  counted in full; the direction and retention text.
- `src/lib/api.test.ts`: `getAudit`'s query string; the export sends the same
  filters, the format and `through`.
- The page, against the stubbed Worker: each gate state (free shows the Team
  link; operator shows no purchase link; not an admin; no org); a cross-org
  row's marker; a filter change updates the URL; Load older appends; the room
  check's 200 and 404; an export failure shows inline.
- `src/router.test.tsx`: `/audit` asks for the log only for an admitted account,
  and joins the case that sends a refused loader to sign-in.
- The PR's before and after screenshots, from a stub Worker that also serves
  `/account` and `/audit`.

## Files

bellman:

- `src/types.ts`: `AuditEntry`'s fields, `Entitlements.auditRetentionMs`
- `src/auth.ts`: `auditRetentionMs` on each plan
- `src/audit.ts` (new): the crossing rule, `AuditQuery`, `AuditPage`,
  `AuditFacets` and `auditRefusal`, the gate
- `src/rooms.ts`: `auditEntries`' fan-out and fields
- `src/store.ts`: `hostSentEntries`' fields; `BellmanStore.queryAudit` and
  `auditFacets`; `MemoryStore`
- `src/retention.ts`, `src/grant-audit.ts`: their entries' fields
- `src/store-do.ts`: `AuditDO`'s tables, migration, append, query and facets;
  the facade
- `src/http/audit.ts` (new): the routes, the entry's projection and the CSV
  and JSON formatting; `src/http/rooms.ts` and `src/tools/audit.ts` ask
  `auditRefusal`; `src/worker.ts` mounts the module
- `tests/helpers/store-contract.ts`, `tests/rooms.test.ts`,
  `tests/http-audit.test.ts` (new), `worker-tests/` for `AuditDO`
- `README.md` (the audit trail and the two routes),
  `docs/ARCHITECTURE.md` (`AuditDO` in SQL, the fan-out rule)

dash:

- `src/lib/api.ts`: the audit types, `getAudit`, `exportAudit`,
  `AccountInfo.entitlements.auditRetentionMs`
- `src/lib/audit.ts` (new), `src/lib/account.ts` (the upgrade links)
- `src/routes/audit.tsx`, `src/components/audit/filters.tsx`,
  `src/components/audit/table.tsx`, `src/routes/billing.tsx`
- `src/router.tsx`, `src/test-fixtures.ts`, and the tests above
- `README.md`: the Audit page needs the Worker's `/audit` routes

## Follow-ups, not this spec

- **`bellman_audit` with filters**, so an agent asks the question a reviewer
  asks.
- **Org names** once #53 makes orgs objects.
- **Indexes** on actor, room and action when a stream is large enough to feel
  the scan.
- **A bearer key for the export** (#234), so a SIEM can pull it without a
  browser.
