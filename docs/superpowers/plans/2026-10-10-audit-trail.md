# The Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org admin sees, filters and exports every crossing that touched their org's boundary, from both sides of a shared room, on dash's Audit page.

**Architecture:** Every audit row records who acted, from which org, in which room, and which orgs the room held, and it reaches every one of those orgs. `src/audit.ts` holds that rule once. `AuditDO` moves its rows into a SQL table, so one query serves filters, paging and export, and `MemoryStore` mirrors it under the store contract. `GET /audit` and `GET /audit/export` serve the panel, and dash's `/audit` route reads them.

**Tech Stack:** Cloudflare Workers and Durable Objects (SQLite storage), TypeScript, vitest in Node and in workerd (`@cloudflare/vitest-pool-workers`). For dash: Vite, React 19, TanStack Router, Tailwind, and vitest with Testing Library in jsdom.

**Spec:** `docs/superpowers/specs/2026-10-09-audit-trail-design.md` in bellman. Read it before Task 1. Each task names the decisions (D1 to D12) it implements.

**Worktrees:**
- bellman (Tasks 1 to 9): `/Users/mcfearsome/orca/workspaces/bellman/audit-trail`, branch `mcfearsome/audit-trail`.
- dash (Tasks 10 to 14): `/Users/mcfearsome/orca/workspaces/dash/audit-trail-cross-org-crossings-filters-export`, branch `mcfearsome/audit-trail-cross-org-crossings-filters-export`.

`package-lock.json` in the bellman worktree shows as modified because Orca's setup ran `npm install`. Never stage it.

## Global Constraints

- Two PRs. The bellman PR merges and deploys before the dash PR merges (D12).
- Paging: `GET /audit` returns 100 rows a page. The export reads 500 rows per page. Each facet list holds at most 200 values, newest first.
- Query parameters:
  - `from` and `to` are ISO 8601 instants; `from` is inclusive and `to` exclusive.
  - `actor`, `room`, `org` and `action` are 1 to 200 characters.
  - `scope` is `internal` or `cross_org`.
  - `before` and `through` are whole numbers, 0 or more.
  - An unknown or repeated parameter is a 400 that names it.
  - `/audit/export` requires `format` (`csv` or `json`) and refuses `before`.
- Refusals use `bellman_audit`'s exact words:
  - `the audit log requires the team plan (you are on "<plan>").`
  - `the audit log requires the admin role.`
  - `your identity has no org.`
- CSV columns, in this order: `seq,at,action,room_id,room_name,actor_id,actor_label,actor_org,parties,crossing,direction,detail`.
  - `parties` is joined with `;`, with `(no org)` written for null.
  - A string cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`.
- Export filename: `bellman-audit-<org>-<through>.<csv|json>`.
  - Any character of the org id outside `[A-Za-z0-9_.-]` becomes `_`.
  - It is sent through `attachmentDisposition` (`src/blobs.ts`), with `access-control-expose-headers: content-disposition`.
- `Entitlements.auditRetentionMs` is `null` on every plan. The page says `Kept with no expiry.` for null, `Kept for N days.` for a number, and nothing when the field is absent.
- Page copy, verbatim:
  - `The audit trail is part of the Team plan`
  - `Only an org admin can read the audit trail. Ask one.`
  - `Your account has no org, so there is no audit stream to read.`
  - `Export failed; nothing was saved: <reason>`
  - `This room cannot be opened from here: it has been deleted, or it is still open and you are not in it.`
- Code style: match the surrounding code.
  - Doc comments say why.
  - Commit messages are sentences, with no `feat:` prefixes.
  - A deliberate ceiling gets a `ponytail:` comment.
  - Every SQL value is a bound parameter.
  - No new dependencies in either repo.
- Commands:
  - bellman unit tests: `npx vitest run <files>`
  - bellman full suite: `npm test`
  - workerd tests: `npm run test:worker -- <name filter>`
  - types: `npm run typecheck` and `npm run typecheck:worker`
  - everything: `npm run verify`
  - dash: `npx vitest run <files>`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`

## Review Focus

1. **A filter value that spells SQL** (`' OR 1=1 --`, `%`, `_`) matches literally and never errors. Test: Task 5 contract case.
2. **`from` after `to`, or a range that holds no rows,** returns an empty page with `total: 0`, not an error. Test: Task 5 contract case.
3. **Rows that land out of `at` order** (an outbox delivering late) still filter by `at` and page by `seq`, with nothing lost or doubled. Test: Task 5 contract case.
4. **A session that lapses while the page is open** sends Load older, Export and the room check to sign-in instead of failing inline. Tests: Task 12 (Load older) and Task 13 (export and room check).
5. **Peer-written strings with markup** (labels, room names) render as text on the page, and stay data in a CSV. Tests: Task 12 router test and Task 7's formula guard.

## File structure

bellman:
- `src/audit.ts` (new, no runtime dependencies) holds the audit trail's rules:
  - who a row is about and which orgs it reaches (D1 to D3)
  - the table row mapping (D5)
  - the query semantics for `MemoryStore` and their SQL for `AuditDO` (D6)
  - the reader gate
- `src/http/audit.ts` (new) holds the wire: parameter parsing, the entry projection, CSV, the filename, and the two routes (D7, D8).
- Changed: `src/types.ts`, `src/rooms.ts`, `src/store.ts`, `src/retention.ts`, `src/grant-audit.ts`, `src/store-do.ts`, `src/http/rooms.ts`, `src/tools/audit.ts`, `src/oauth/routes.ts`, `src/worker.ts`, `src/auth.ts`, `README.md`, `docs/ARCHITECTURE.md`, and the spec.

dash:
- `src/lib/audit.ts` (new) holds the URL's filters as the Worker's, the page's words, the gate, and the loader.
- `src/components/audit/filters.tsx` and `src/components/audit/table.tsx` (new).
- Changed: `src/lib/api.ts`, `src/lib/account.ts`, `src/routes/billing.tsx`, `src/routes/audit.tsx`, `src/router.tsx`, `src/test-fixtures.ts`, and `README.md`.

---

## Part 1: bellman

### Task 1: One rule for an audit row (D1 to D3)

**Files:**
- Create: `src/audit.ts`
- Modify: `src/types.ts` (`AuditEntry`)
- Test: `tests/audit.test.ts` (new)

**Interfaces:**
- Produces:
  - `interface AuditActor { userId: string; label: string | null; orgId: string | null }`
  - `const SYSTEM_ACTOR: AuditActor`
  - `interface AuditFacts { at: number; sessionId: string; action: string; roomName: string | null; detail: Record<string, unknown> }`
  - `partiesOf(orgs: readonly (string | null)[]): (string | null)[]`
  - `auditRow(orgId: string, parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry`
  - `auditRows(parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry[]`
  - `AuditEntry` gains optional `actorLabel`, `actorOrgId`, `roomName`, `parties`, `crossing` and `direction`.

- [ ] **Step 1: Write the failing test** — create `tests/audit.test.ts`:

```ts
/**
 * The audit trail's rules (audit trail spec). First the one every row comes through (D1 to
 * D3): the parties to an action, the streams a row reaches, and from each stream's side
 * whether it crossed and which way.
 */
import { describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, auditRow, auditRows, partiesOf } from "../src/audit.js";

const facts = { at: 7, sessionId: "qs_q3", action: "sent_message", roomName: "q3-plan", detail: { chars: 5 } };
const ana = { userId: "u_ana", label: "Ana", orgId: "org_a" };
const bo = { userId: "u_bo", label: "Bo", orgId: "org_b" };

describe("partiesOf", () => {
  it("names each org once, sorted, with a person who has no org last", () => {
    expect(partiesOf(["org_b", null, "org_a", "org_b", ""])).toEqual(["org_a", "org_b", null]);
  });

  it("has no null when everyone has an org", () => {
    expect(partiesOf(["org_a", "org_a"])).toEqual(["org_a"]);
  });
});

describe("auditRows", () => {
  it("writes Ana's send in A's room with Bo present to both orgs: outbound for A, inbound for B", () => {
    const rows = auditRows(["org_a", "org_b"], facts, ana);
    expect(rows.map((r) => [r.orgId, r.crossing, r.direction])).toEqual([
      ["org_a", "cross_org", "outbound"],
      ["org_b", "cross_org", "inbound"],
    ]);
    expect(rows[1]).toEqual({
      at: 7, orgId: "org_b", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message", detail: { chars: 5 },
      actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a", "org_b"],
      crossing: "cross_org", direction: "inbound",
    });
  });

  it("is internal, with no direction, when every party is the stream's own org", () => {
    expect(auditRows(["org_a"], facts, ana).map((r) => [r.crossing, r.direction])).toEqual([["internal", null]]);
  });

  it("gives a person with no org no row, and makes the room cross-org for everyone else", () => {
    const rows = auditRows(["org_a", null], facts, { userId: "u_solo", label: "solo", orgId: null });
    expect(rows.map((r) => [r.orgId, r.crossing, r.direction])).toEqual([["org_a", "cross_org", "inbound"]]);
  });

  it("gives the system no direction, even across orgs", () => {
    expect(auditRows(["org_a", "org_b"], facts, SYSTEM_ACTOR).map((r) => r.direction)).toEqual([null, null]);
  });
});

describe("auditRow", () => {
  it("addresses one stream, reading the parties from that stream's side", () => {
    expect(auditRow("org_b", ["org_a", "org_b"], facts, bo).direction).toBe("outbound");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/audit.test.ts`
Expected: FAIL, because `../src/audit.js` cannot be found.

- [ ] **Step 3: Give `AuditEntry` its six fields** — in `src/types.ts`, replace the `AuditEntry` interface with:

```ts
export interface AuditEntry {
  at: number;
  orgId: string | null;
  sessionId: string;
  actorUserId: string;
  action: string;
  detail: Record<string, unknown>;
  /**
   * What the row was about, as of the action (audit trail spec, D2). The six are absent
   * together on a row written before they existed and present together on every row
   * written since, so `crossing` is the one to test. `actorOrgId` null is an actor with
   * no org; absent is a row that never said.
   */
  actorLabel?: string | null;
  actorOrgId?: string | null;
  roomName?: string | null;
  /** The orgs the action involved (D1), sorted, with null last for a person with no org. */
  parties?: (string | null)[];
  /** From this row's stream (D3): whether a party other than this org was involved. */
  crossing?: "internal" | "cross_org";
  /** From this row's stream (D3): this org acted, or another did. Null on an internal row and for the system. */
  direction?: "outbound" | "inbound" | null;
}
```

- [ ] **Step 4: Write the rule** — create `src/audit.ts`:

```ts
/**
 * The audit trail's rules (audit trail spec). This module starts with the one every
 * builder of an audit row comes through: who the row is about, which orgs it reaches, and
 * whether, from each org's side, it crossed that org's boundary and which way (D1 to D3).
 * One rule, so no row can reach one org saying something its copy in another contradicts.
 *
 * Runtime-free, as grant-audit.ts is: store-do.ts imports `cloudflare:workers`, which no
 * vitest test can import, so a rule written there could not be tested in Node.
 */
import type { AuditEntry } from "./types.js";

/** Who acted, as a row records them. */
export interface AuditActor {
  userId: string;
  label: string | null;
  orgId: string | null;
}

/** The server acting on its own clock: a purge nobody asked for (#65, D2). It has no org and no direction. */
export const SYSTEM_ACTOR: AuditActor = { userId: "system", label: null, orgId: null };

/** What a row says about itself, before it is addressed to a stream. */
export interface AuditFacts {
  at: number;
  sessionId: string;
  action: string;
  roomName: string | null;
  detail: Record<string, unknown>;
}

/**
 * The parties to an action (D1), once each, sorted, with `null` last for a person with no
 * org. A falsy org is no org (ARCHITECTURE.md section 9, runtime fact 4), so "" counts as
 * null: a stream named "" is one nobody reads.
 */
export function partiesOf(orgs: readonly (string | null)[]): (string | null)[] {
  const named = [...new Set(orgs.filter((o): o is string => Boolean(o)))].sort();
  return orgs.some((o) => !o) ? [...named, null] : named;
}

/**
 * The row stream `orgId` keeps (D3). It is cross-org when the parties hold anyone but this
 * org. A cross-org row is outbound when this org acted and inbound when anyone else did; the
 * system acts for nobody, and an internal row has no direction.
 */
export function auditRow(orgId: string, parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry {
  const crossing = parties.some((p) => p !== orgId) ? "cross_org" : "internal";
  const direction = crossing === "internal" || actor.userId === SYSTEM_ACTOR.userId
    ? null
    : actor.orgId === orgId ? "outbound" : "inbound";
  return {
    at: facts.at, orgId, sessionId: facts.sessionId, actorUserId: actor.userId, action: facts.action,
    detail: facts.detail, actorLabel: actor.label, actorOrgId: actor.orgId, roomName: facts.roomName,
    parties, crossing, direction,
  };
}

/** One row for each org among the parties (D1). A person with no org is a party with no stream, and gets none. */
export function auditRows(parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry[] {
  return parties.filter((p): p is string => p !== null).map((orgId) => auditRow(orgId, parties, facts, actor));
}
```

- [ ] **Step 5: Run it to see it pass, and typecheck**

Run: `npx vitest run tests/audit.test.ts`
Expected: PASS, 7 tests.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/audit.ts src/types.ts tests/audit.test.ts
git commit -m "One rule for an audit row: the parties to an action, and from each org's side whether it crossed and which way"
```

### Task 2: Every person in the room is a party (D1)

**Files:**
- Modify: `src/rooms.ts`. That covers `auditEntries` and its doc comment, the comment above `retire:` in `evictMember`, and the import from `./store.js`.
- Modify: `src/store.ts` (`hostSentEntries`)
- Test: `tests/rooms.test.ts` (`describe("audit")`), `tests/store.test.ts`

**Interfaces:**
- Consumes: `partiesOf` and `auditRows` (Task 1); `isActivePerson` and `HOST_USER_ID` (`src/store.ts`).
- Produces: `auditEntries(session, actor, action, detail, alsoOrgs?)` keeps its signature, and its rows now carry the six fields. `hostSentEntries(s: Pick<StoredSession, "id" | "orgId" | "members" | "manifest">, e, now)`.

- [ ] **Step 1: Write the failing tests** — in `tests/rooms.test.ts`:
  1. Change the store import to `import { HOST_USER_ID, MemoryStore, ROOM_MEMBER_CEILING } from "../src/store.js";`.
  2. Add these cases at the end of the existing `describe("audit", ...)` block:

```ts
  const ana: Identity = { userId: "u_ana", orgId: "org_a", plan: "team", role: "member", label: "Ana" };
  const anaSeat = member({ memberId: "m_ana", userId: "u_ana", label: "Ana", orgId: "org_a" });
  const boSeat = member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" });
  const inA = (members: Member[]) => session({ id: "qs_cross", orgId: "org_a", members });

  it("writes a send in A's room with B's member present to both orgs: outbound for A, inbound for B", async () => {
    const room = inA([anaSeat, boSeat]);
    await audit(store, room, ana, "sent_message", { chars: 5 });

    expect((await store.auditForOrg("org_a", 10)).map((r) => [r.crossing, r.direction])).toEqual([["cross_org", "outbound"]]);
    expect(await store.auditForOrg("org_b", 10)).toEqual([{
      at: expect.any(Number), orgId: "org_b", sessionId: "qs_cross", actorUserId: "u_ana", action: "sent_message",
      detail: { chars: 5 }, actorLabel: "Ana", actorOrgId: "org_a", roomName: room.manifest.room,
      parties: ["org_a", "org_b"], crossing: "cross_org", direction: "inbound",
    }]);
  });

  it("makes a room with a person who has no org cross-org, and writes that person no row", async () => {
    const solo = member({ memberId: "m_solo", userId: "u_solo", label: "solo", orgId: null, roomRole: "peer_b" });
    const written = vi.spyOn(store, "appendAudit");
    await audit(store, inA([anaSeat, solo]), ana, "sent_message", {});

    expect(written.mock.calls.map(([e]) => [e.orgId, e.crossing, e.parties])).toEqual([["org_a", "cross_org", ["org_a", null]]]);
  });

  it("counts people still in the room: a member who left and the hosted seat are not parties", async () => {
    const left = { ...boSeat, leftAt: Date.now() };
    const host = member({ memberId: "m_host", userId: HOST_USER_ID, label: "host@bellman", orgId: null, roomRole: "host" });
    await audit(store, inA([anaSeat, left, host]), ana, "sent_message", {});

    expect((await store.auditForOrg("org_a", 10)).map((r) => [r.crossing, r.parties])).toEqual([["internal", ["org_a"]]]);
    expect(await store.auditForOrg("org_b", 10)).toEqual([]);
  });

  it("reaches an evicted member's org, which is no longer in the room, as inbound", async () => {
    await audit(store, inA([anaSeat]), ana, "member_evicted", { user_id: "u_bo" }, ["org_b"]);

    expect((await store.auditForOrg("org_a", 10)).map((r) => r.direction)).toEqual(["outbound"]);
    expect((await store.auditForOrg("org_b", 10)).map((r) => [r.crossing, r.direction])).toEqual([["cross_org", "inbound"]]);
  });
```

  In `tests/store.test.ts`:
  1. Add `HOST_USER_ID` and `hostSentEntries` to its import from `../src/store.js`.
  2. Make sure `member` and `session` are imported from `./helpers/fixtures.js`.
  3. Add:

```ts
describe("hostSentEntries", () => {
  it("records a host's send for the room's org and every org with a person present, as the room's org acting", () => {
    const s = session({
      id: "qs_hosted", orgId: "org_a",
      members: [
        member({ orgId: "org_a" }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" }),
        member({ memberId: "m_host", userId: HOST_USER_ID, label: "host@bellman", orgId: null, roomRole: "host" }),
      ],
    });
    const rows = hostSentEntries(s, {
      type: "message", fromMemberId: "m_host", fromUserId: HOST_USER_ID, fromLabel: "host@bellman",
      payload: { text: "hi" }, refId: null,
    }, 9);

    expect(rows.map((r) => [r.orgId, r.actorOrgId, r.direction, r.parties])).toEqual([
      ["org_a", "org_a", "outbound", ["org_a", "org_b"]],
      ["org_b", "org_a", "inbound", ["org_a", "org_b"]],
    ]);
    expect(rows[0]).toMatchObject({ action: "sent_message", actorLabel: "host@bellman", roomName: s.manifest.room, detail: { chars: 13 } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/rooms.test.ts tests/store.test.ts`
Expected: the new cases FAIL. B's stream is empty, the rows have no `crossing`, and `hostSentEntries` writes nothing for org B.

- [ ] **Step 3: Write the roster fan-out** — in `src/rooms.ts`:
  1. Add `isActivePerson` to the import from `./store.js`.
  2. Add `import { auditRows, partiesOf } from "./audit.js";` below the other imports.
  3. Replace `auditEntries` and its doc comment with:

```ts
/**
 * Which orgs get a row for this action, and what it says (audit trail spec, D1 and D2). One
 * rule, in one place, for the callers that write it themselves and the ones that hand it to
 * a store operation to commit with the mutation it records.
 *
 * The parties are the room's org, the actor's, any named in `alsoOrgs`, and the org of every
 * person still in the room. The last is what makes a crossing visible from both sides: when a
 * member of org A sends in A's room while a member of org B is in it, A's context reaches B, so
 * B's stream records it too. `alsoOrgs` is for an actor acting on someone else: an eviction
 * touches the evicted member's org, which need be neither the room's nor the creator's, and
 * that member is no longer in the room to be counted. The hosted seat is not a party; it acts
 * for the room. A person with no org is a party with no stream: the room is cross-org for
 * everyone else, and no row is written for them.
 *
 * It lives here rather than in a transport because a transport that writes its own row is a
 * transport that will one day write it for one org and not the other.
 */
export function auditEntries(
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): AuditEntry[] {
  const parties = partiesOf([
    session.orgId, actor.orgId, ...alsoOrgs, ...session.members.filter(isActivePerson).map((m) => m.orgId),
  ]);
  return auditRows(
    parties,
    { at: Date.now(), sessionId: session.id, action, roomName: session.manifest.room, detail },
    { userId: actor.userId, label: actor.label, orgId: actor.orgId },
  );
}
```

  4. In the comment above `retire:` in `evictMember`, replace its last four lines, starting at `` `invite_revoked` would find half of them. The row goes to the room's org and ``, with:

```ts
    // `invite_revoked` would find half of them. The row goes where revokeInvite's
    // goes, to the orgs `auditEntries` names, and the departed member's org is not
    // added to them: it names a role and no person, so that org could not tell whom
    // it concerned, and a row an org cannot resolve to anyone is worse than none.
```

- [ ] **Step 4: Write the host's rows** — in `src/store.ts`:
  1. Add `import { auditRows, partiesOf } from "./audit.js";`.
  2. Replace `hostSentEntries` and its doc comment with:

```ts
/**
 * The audit rows a host's send owes (C1): the `sent_<type>` row `bellman_send` writes for a
 * member, so a team org's stream sees the host as it sees members. The host belongs to no org
 * and acts for the room, so the parties are the room's org and the orgs of the people in it
 * (audit trail spec, D1), and the row says the room's org acted. Both stores queue them in the
 * send's own write.
 */
export function hostSentEntries(
  s: Pick<StoredSession, "id" | "orgId" | "members" | "manifest">,
  e: Omit<SessionEvent, "cursor" | "at">,
  now: number,
): AuditEntry[] {
  return auditRows(
    partiesOf([s.orgId, ...s.members.filter(isActivePerson).map((m) => m.orgId)]),
    {
      at: now, sessionId: s.id, action: `sent_${e.type}`, roomName: s.manifest.room,
      detail: { chars: JSON.stringify(e.payload).length, ...(e.refId ? { ref_id: e.refId } : {}) },
    },
    { userId: e.fromUserId, label: e.fromLabel, orgId: s.orgId },
  );
}
```

- [ ] **Step 5: Run the new tests, then everything**

Run: `npx vitest run tests/rooms.test.ts tests/store.test.ts tests/audit.test.ts`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS.

Some failures here are expected and correct. If an existing assertion counts or reads one org's rows and now sees a row D1 adds (an org with a person present who was not the actor), that is D1 working:
- Change the expectation to the D1 result.
- Add the comment `// D1 (audit trail spec): every org with a person in the room gets the row.`
- Touch only assertions that fail for this reason.

Any other failure is a bug in this task. Fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/rooms.ts src/store.ts tests/rooms.test.ts tests/store.test.ts
git add -u tests worker-tests   # D1 expectation updates from Step 5, if any
git commit -m "Write an audit row to every org with a person in the room, so a crossing reaches both sides"
```

### Task 3: Purge, delete and grant rows say what they concerned, and a delete names its asker (D2)

`roomDeletedEntry` only knows the asker's user id. That can't say whether a delete was outbound or inbound for a stream, so `schedulePurge` takes the asker (`AuditActor`) instead of an id. An admin's grant intent carries the admin's label and org.

**Files:**
- Modify: `src/retention.ts` (`roomPurgedEntry`, `roomDeletedEntry`)
- Modify: `src/store.ts`:
  - add `rosterParties`
  - `BellmanStore.schedulePurge`'s `by`
  - `MemoryStore.schedulePurge` and the purge's `roomPurgedEntry` call
- Modify: `src/store-do.ts`:
  - `SessionDO.schedulePurge`
  - the purge's `roomPurgedEntry` append
  - `DurableObjectStore.schedulePurge`
  - imports
- Modify: `src/http/rooms.ts` (`deleteRoom` passes the asker)
- Modify: `src/grant-audit.ts` (`AuditIntent`, `entry`)
- Modify: `src/oauth/routes.ts` (the two `{ actorUserId: identity.userId }` intents)
- Test:
  - `tests/retention.test.ts`, `tests/store.test.ts`, `tests/grant-audit.test.ts`
  - `tests/helpers/fixtures.ts` (`jesseActor`, `peerActor`)
  - `tests/helpers/store-contract.ts`
  - the `schedulePurge` call sites in `tests/http-public.test.ts`, `tests/tools/purged-room.test.ts`, `worker-tests/purge.test.ts` and `worker-tests/host.test.ts`

**Interfaces:**
- Consumes: `auditRow`, `partiesOf`, `SYSTEM_ACTOR`, `AuditActor` (Task 1); `isHostMember` (`src/store.ts`).
- Produces:
  - `rosterParties(s: Pick<StoredSession, "members">): (string | null)[]`
  - `roomPurgedEntry(s, orgId, parties, at)`
  - `roomDeletedEntry(s, orgId, parties, by: AuditActor | null, at)`
  - `BellmanStore.schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule>`
  - `AuditIntent { actorUserId: string; actorLabel?: string; actorOrgId?: string | null; detail?: Record<string, unknown> }`
  - `jesseActor` and `peerActor` in `tests/helpers/fixtures.ts`

- [ ] **Step 1: Write the failing tests**

  In `tests/helpers/fixtures.ts`, add an import beside the others and the two actors at the end:

```ts
import type { AuditActor } from "../../src/audit.js";

/** The fixture people as an audit row names an actor: who asked for a delete, in the purge tests. */
export const jesseActor: AuditActor = { userId: "u_jesse", label: "jesse@codenerd", orgId: "org_codenerd" };
export const peerActor: AuditActor = { userId: "u_peer", label: "peer@other", orgId: "org_other" };
```

  In `tests/retention.test.ts`, replace `describe("the entries a purge files", ...)` with:

```ts
describe("the entries a purge files", () => {
  const room = session({ id: "qs_entry" });
  const detail = { session_id: "qs_entry", room: room.manifest.room };
  const parties = ["org_codenerd", "org_other"];
  const said = { roomName: room.manifest.room, parties, crossing: "cross_org" };

  it("room_purged says the window ran out, and names the system as the actor, with no direction", () => {
    expect(roomPurgedEntry(room, "org_codenerd", parties, 7)).toEqual({
      at: 7, orgId: "org_codenerd", sessionId: "qs_entry", actorUserId: "system", action: "room_purged", detail,
      actorLabel: null, actorOrgId: null, direction: null, ...said,
    });
  });

  it("room_deleted names who asked: outbound for the asker's org, inbound for the others", () => {
    const jesse = { userId: "u_jesse", label: "jesse@codenerd", orgId: "org_codenerd" };
    expect(roomDeletedEntry(room, "org_codenerd", parties, jesse, 7)).toEqual({
      at: 7, orgId: "org_codenerd", sessionId: "qs_entry", actorUserId: "u_jesse", action: "room_deleted", detail,
      actorLabel: "jesse@codenerd", actorOrgId: "org_codenerd", direction: "outbound", ...said,
    });
    expect(roomDeletedEntry(room, "org_other", parties, jesse, 7).direction).toBe("inbound");
  });

  it("room_deleted names the system when nobody did", () => {
    expect(roomDeletedEntry(room, "org_codenerd", parties, null, 7)).toMatchObject({ actorUserId: "system", direction: null });
  });
});
```

  In `tests/store.test.ts`, add `rosterParties` to the import from `../src/store.js`, then add:

```ts
describe("rosterParties", () => {
  it("is everyone the room seated, departed included, with the hosted seat left out", () => {
    const s = session({ members: [
      member({ orgId: "org_b" }),
      member({ memberId: "m_gone", userId: "u_gone", orgId: "org_a", leftAt: 1 }),
      member({ memberId: "m_solo", userId: "u_solo", orgId: null }),
      member({ memberId: "m_host", userId: HOST_USER_ID, orgId: null }),
    ] });
    expect(rosterParties(s)).toEqual(["org_a", "org_b", null]);
  });

  it("has no null when the only member with no org is the hosted seat", () => {
    const s = session({ members: [member({ orgId: "org_a" }), member({ memberId: "m_host", userId: HOST_USER_ID, orgId: null })] });
    expect(rosterParties(s)).toEqual(["org_a"]);
  });
});
```

  In `tests/grant-audit.test.ts`:
  1. Add this helper below `const admin`:

```ts
/** What every grant row now says of itself (audit trail spec, D2): an org's own plan, so internal, with no room. */
const internal = (orgId: string, actor: { label?: string; orgId?: string | null } = {}) => ({
  actorLabel: actor.label ?? null, actorOrgId: actor.orgId ?? null, roomName: null,
  parties: [orgId], crossing: "internal", direction: null,
});
```

  2. In each of the five `toEqual([{ ... }])` expectations of whole entries (they follow `grantAuditEntries(` or `revokeAuditEntries(`, or name `entries`), add `...internal("<that object's orgId>")` as the expected object's last line. For example, the first becomes `{ at: NOW, orgId: "org_mine", ..., detail: { ... }, ...internal("org_mine") }`.
  3. Add a case inside `describe("grantAuditEntries", ...)`:

```ts
  it("names the admin who granted, and their org, when the intent carries them", () => {
    const named: AuditIntent = { actorUserId: "u_admin", actorLabel: "admin@mine", actorOrgId: "org_mine" };
    expect(grantAuditEntries(undefined, grant(), named, NOW)[0]).toMatchObject({
      actorLabel: "admin@mine", actorOrgId: "org_mine", crossing: "internal", direction: null,
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/retention.test.ts tests/store.test.ts tests/grant-audit.test.ts`
Expected: FAIL. The retention builders take the old arguments, `rosterParties` doesn't exist, and grant rows lack the six fields.

- [ ] **Step 3: Write the retention builders** — in `src/retention.ts`:
  1. Add `import { SYSTEM_ACTOR, auditRow, type AuditActor } from "./audit.js";`.
  2. Replace both builders:

```ts
/** The window ran out (#65, D2): nobody asked, so the system is the actor. `parties` is the room's roster (`rosterParties`). */
export const roomPurgedEntry = (s: Room, orgId: string, parties: (string | null)[], at: number): AuditEntry =>
  auditRow(orgId, parties, {
    at, sessionId: s.id, action: "room_purged", roomName: s.manifest.room,
    detail: { session_id: s.id, room: s.manifest.room },
  }, SYSTEM_ACTOR);

/** A delete asked for the purge (#65, D6): `by` is who asked, or null when the caller was not a person. */
export const roomDeletedEntry = (
  s: Room, orgId: string, parties: (string | null)[], by: AuditActor | null, at: number,
): AuditEntry =>
  auditRow(orgId, parties, {
    at, sessionId: s.id, action: "room_deleted", roomName: s.manifest.room,
    detail: { session_id: s.id, room: s.manifest.room },
  }, by ?? SYSTEM_ACTOR);
```

- [ ] **Step 4: Add `rosterParties`, and pass the asker in `MemoryStore`** — in `src/store.ts`:
  1. Add `import type { AuditActor } from "./audit.js";`. You can merge it with the Task 2 import as `import { auditRows, partiesOf, type AuditActor } from "./audit.js";`.
  2. Add this below `isActivePerson`:

```ts
/**
 * Everyone a room ever seated, the hosted seat left out, as an audit row's parties (audit trail
 * spec, D2): what a purge's and a delete's rows say the room held. The roster keeps a member who
 * left, as `orgsOnRoster` does, because their org sat in the room.
 */
export const rosterParties = (s: Pick<StoredSession, "members">): (string | null)[] =>
  partiesOf(s.members.filter((m) => !isHostMember(m)).map((m) => m.orgId));
```

  3. In the `BellmanStore` interface, change `schedulePurge`'s `by` parameter to `by: AuditActor | null`.
  4. In `MemoryStore`:
     - `schedulePurge` becomes `async schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule>`. Its record line becomes:

```ts
    this.recordAudit(orgsOnRoster(s).map((orgId) => roomDeletedEntry(s, orgId, rosterParties(s), by, Date.now())));
```

     - The purge's record line becomes:

```ts
    this.recordAudit(orgsOnRoster(s).map((orgId) => roomPurgedEntry(s, orgId, rosterParties(s), now)));
```

- [ ] **Step 5: Pass the asker in `src/store-do.ts`**
  1. Add `rosterParties` to the value import from `./store.js`.
  2. Add `import type { AuditActor } from "./audit.js";`.
  3. `SessionDO.schedulePurge` becomes `async schedulePurge(at: number, by: AuditActor | null): Promise<PurgeSchedule>`, and its enqueue builds `auditIntent(roomDeletedEntry(s, orgId, rosterParties(s), by, now))`.
  4. The purge's direct append becomes `.append(roomPurgedEntry(s, orgId, rosterParties(s), now), \`purge:${s.id}:${orgId}\`)`.
  5. `DurableObjectStore.schedulePurge` becomes `async schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule>`. It forwards `by` unchanged.

- [ ] **Step 6: Name the asker of a delete** — in `src/http/rooms.ts` `deleteRoom`, the store call becomes:

```ts
  const asker = { userId: who.identity.userId, label: who.identity.label, orgId: who.identity.orgId };
  const scheduled = await deps.store.schedulePurge(sessionId, Date.now(), asker);
```

- [ ] **Step 7: Grant rows** — in `src/grant-audit.ts`:
  1. Add `import { auditRow } from "./audit.js";`.
  2. Replace `AuditIntent`:

```ts
/** What a caller contributes: who is acting, and anything extra to record. */
export interface AuditIntent {
  actorUserId: string;
  /** The acting admin's name and org (audit trail spec, D2). Billing acts as `stripe`, which has neither. */
  actorLabel?: string;
  actorOrgId?: string | null;
  detail?: Record<string, unknown>;
}
```

  3. Replace `entry`'s body (keep its doc comment):

```ts
function entry(
  orgId: string,
  key: string,
  action: "plan_granted" | "plan_revoked",
  intent: AuditIntent,
  detail: Record<string, unknown>,
  now: number
): AuditEntry {
  // An org's own plan: its only party is the org, so the row is internal and has no room (D2).
  return auditRow(orgId, [orgId], {
    at: now, sessionId: `grant:${key}`, action, roomName: null, detail: { ...detail, ...intent.detail, key },
  }, { userId: intent.actorUserId, label: intent.actorLabel ?? null, orgId: intent.actorOrgId ?? null });
}
```

  4. In `src/oauth/routes.ts`, both `{ actorUserId: identity.userId }` intents (around lines 1288 and 1304) become `{ actorUserId: identity.userId, actorLabel: identity.label, actorOrgId: identity.orgId }`.

- [ ] **Step 8: Move the test call sites to the asker, and fix the purge expectation**

```bash
sed -i '' -E '/schedulePurge\(/ s/, "u_jesse"\)/, jesseActor)/; /schedulePurge\(/ s/, "u_peer"\)/, peerActor)/' \
  tests/helpers/store-contract.ts tests/http-public.test.ts tests/tools/purged-room.test.ts \
  worker-tests/purge.test.ts worker-tests/host.test.ts
grep -n 'schedulePurge(' tests worker-tests -r | grep -E '"u_(jesse|peer)"'   # expect no output
```

Then add the imports:
- `tests/helpers/store-contract.ts`: add `jesseActor` and `peerActor` to the import from `./fixtures.js`.
- `tests/http-public.test.ts`, `worker-tests/purge.test.ts`, `worker-tests/host.test.ts`: add `jesseActor` to the existing fixtures import.
- `tests/tools/purged-room.test.ts`: add `import { jesseActor } from "../helpers/fixtures.js";`.

In `tests/helpers/store-contract.ts`, the case `files one room_purged for each org on the roster, and none for a member with no org` now expects the six fields. Replace its `toEqual([{ ... }])` with:

```ts
          expect(filed, org).toEqual([{
            at: expect.any(Number), orgId: org, sessionId: s.id, actorUserId: "system",
            action: "room_purged", detail: { session_id: s.id, room: s.manifest.room },
            actorLabel: null, actorOrgId: null, roomName: s.manifest.room,
            parties: ["org_codenerd", "org_other", null], crossing: "cross_org", direction: null,
          }]);
```

- [ ] **Step 9: Run the tests, the types and both suites**

Run: `npx vitest run tests/retention.test.ts tests/store.test.ts tests/grant-audit.test.ts`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS. Any remaining `"u_jesse"` passed as `by` is now a type error; change it to `jesseActor`.

- [ ] **Step 10: Commit**

```bash
git add src/retention.ts src/store.ts src/store-do.ts src/http/rooms.ts src/grant-audit.ts src/oauth/routes.ts
git add tests/retention.test.ts tests/store.test.ts tests/grant-audit.test.ts tests/helpers/fixtures.ts \
  tests/helpers/store-contract.ts tests/http-public.test.ts tests/tools/purged-room.test.ts \
  worker-tests/purge.test.ts worker-tests/host.test.ts
git commit -m "Say who a purge, a delete and a grant concerned and whether it crossed, and name a delete's asker by org"
```

### Task 4: `AuditDO` keeps its rows in SQL (D5)

This moves storage only, with no change in behaviour: `append` and `recent` answer as before. Task 5 adds the query.

Spec note: D5 says the object stores no org. This plan keeps an `org_id` column instead, so that `recent` hands an entry back whole: the existing workerd tests compare entries that carry `orgId`. Task 8 corrects the spec's line.

**Files:**
- Modify: `src/audit.ts` (the table row mapping)
- Modify: `src/store-do.ts`:
  - the `AuditDO` class
  - new `AUDIT_SCHEMA`, `insertAuditRow` and `migrateAudit`
  - remove `auditKey` and `deliveredKey`, which only `AuditDO` used
- Modify: `worker-tests/audit-dedupe.test.ts` (its hooks wrapped KV `get`/`put`/`transaction`, which the SQL path never calls)
- Create: `worker-tests/audit-migration.test.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Produces, in `src/audit.ts`:
  - `type SeqEntry = AuditEntry & { seq: number }`
  - `AUDIT_COLUMNS`
  - `type AuditRecord`
  - `recordOf(e: AuditEntry): (string | number | null)[]`
  - `entryOf(r: AuditRecord): SeqEntry`
- `AuditDO.append(entry, intentId?)` and `AuditDO.recent(limit)` keep their signatures.

- [ ] **Step 1: Write the failing mapping tests** — in `tests/audit.test.ts`:
  1. Extend the import:

```ts
import { AUDIT_COLUMNS, SYSTEM_ACTOR, auditRow, auditRows, entryOf, partiesOf, recordOf, type AuditRecord } from "../src/audit.js";
import type { AuditEntry } from "../src/types.js";
```

  2. Add:

```ts
describe("the entries table's rows", () => {
  const record = (e: AuditEntry, seq: number): AuditRecord =>
    Object.fromEntries([["seq", seq], ...AUDIT_COLUMNS.map((c, i) => [c, recordOf(e)[i]])]) as AuditRecord;

  it("hands back a recorded row whole, with its seq", () => {
    const row = auditRows(["org_a", "org_b"], facts, ana)[0]!;
    expect(entryOf(record(row, 4))).toEqual({ ...row, seq: 4 });
  });

  it("hands back a row from before the six fields without them", () => {
    const old: AuditEntry = { at: 1, orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {} };
    expect(entryOf(record(old, 1))).toEqual({ ...old, seq: 1 });
  });

  it("keeps an actor with no org apart from a row that never said", () => {
    const row = auditRows(["org_a", null], facts, { userId: "u_solo", label: null, orgId: null })[0]!;
    expect(entryOf(record(row, 2))).toMatchObject({ actorOrgId: null, actorLabel: null, crossing: "cross_org" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/audit.test.ts`
Expected: FAIL, because `AUDIT_COLUMNS` is not exported from `../src/audit.js`.

- [ ] **Step 3: Write the mapping** — append to `src/audit.ts`:

```ts
/** An entry with its place in its org's stream: the cursor `before` and `through` count in (D6). */
export type SeqEntry = AuditEntry & { seq: number };

/** The `entries` table's columns after `seq`, in the order `recordOf` binds them (D5). */
export const AUDIT_COLUMNS = [
  "at", "org_id", "session_id", "action", "actor_id", "actor_label", "actor_org",
  "room_name", "parties", "crossing", "direction", "detail",
] as const;

/** One row of the `entries` table, as `sql.exec` hands it back. A type, not an interface: `exec`'s row type must be indexable. */
export type AuditRecord = {
  seq: number;
  at: number;
  org_id: string | null;
  session_id: string;
  action: string;
  actor_id: string;
  actor_label: string | null;
  actor_org: string | null;
  room_name: string | null;
  parties: string | null;
  crossing: string | null;
  direction: string | null;
  detail: string;
};

/**
 * An entry as the table's columns, in AUDIT_COLUMNS order. A row from before D2 has no
 * `crossing`, and its five companions are stored null beside it, so it reads back as it was.
 */
export function recordOf(e: AuditEntry): (string | number | null)[] {
  const recorded = e.crossing !== undefined;
  return [
    e.at, e.orgId, e.sessionId, e.action, e.actorUserId,
    recorded ? e.actorLabel ?? null : null,
    recorded ? e.actorOrgId ?? null : null,
    recorded ? e.roomName ?? null : null,
    recorded ? JSON.stringify(e.parties ?? []) : null,
    e.crossing ?? null,
    recorded ? e.direction ?? null : null,
    JSON.stringify(e.detail ?? {}),
  ];
}

/** A table row as an entry: with the six fields when it recorded a crossing, without them when it is from before (D4). */
export function entryOf(r: AuditRecord): SeqEntry {
  const base: SeqEntry = {
    seq: r.seq, at: r.at, orgId: r.org_id, sessionId: r.session_id, actorUserId: r.actor_id, action: r.action,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  };
  if (r.crossing === null) return base;
  return {
    ...base,
    actorLabel: r.actor_label,
    actorOrgId: r.actor_org,
    roomName: r.room_name,
    parties: JSON.parse(r.parties ?? "[]") as (string | null)[],
    crossing: r.crossing as "internal" | "cross_org",
    direction: r.direction as "outbound" | "inbound" | null,
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run tests/audit.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the workerd tests**

  In `worker-tests/audit-dedupe.test.ts`:
  1. Keep the imports, `afterEach`, `entry`, and the first three cases.
  2. Delete the `Hooks` type, `hook`, and the two `it.each` cases.
  3. Add:

```ts
/**
 * An inline drain racing an alarm hands the same row over twice at once. The look at the
 * marker and the writes are one synchronous transaction, so no second delivery can come
 * between them: eight arriving together land once.
 */
it("applies an entry once when the same delivery arrives eight times at once", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));
  await Promise.all(Array.from({ length: 8 }, () => audit.append(entry("plan_granted"), "intent-1")));
  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

/**
 * A delivery that stops part-way must leave nothing a redelivery mishandles. Fail the Nth
 * INSERT one delivery makes (1 is the row, 2 its marker): the transaction rolls both back,
 * so the redelivery appends the row once, and a later entry lands after it.
 */
it.each([1, 2])("holds each entry once when insert %i of a delivery is interrupted", async (failAt) => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));
  let inserts = 0;
  let failOn = failAt;
  await runInDurableObject(audit, (_i: AuditDO, ctx) => {
    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      configurable: true,
      value: (query: string, ...bindings: SqlStorageValue[]) => {
        if (/^\s*INSERT/i.test(query) && ++inserts === failOn) throw new Error("interrupted");
        return exec(query, ...bindings);
      },
    });
  });

  await expect(audit.append(entry("plan_revoked"), "intent-1")).rejects.toThrow(/interrupted/);
  failOn = 0;
  // The hook sat in front of the delivery's writes. Without this the case proves nothing.
  expect(inserts).toBe(failAt);

  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");
  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});
```

  If `expect(inserts).toBe(failAt)` fails with `inserts` at 0, `ctx.storage.sql` is a fresh object on each access. Install the hook on its prototype instead, and restore it in `afterEach`:

```ts
    const proto = Object.getPrototypeOf(ctx.storage.sql) as { exec: (q: string, ...b: SqlStorageValue[]) => unknown };
    const exec = proto.exec;
    Object.defineProperty(proto, "exec", {
      configurable: true,
      value: function (this: unknown, query: string, ...bindings: SqlStorageValue[]) {
        if (/^\s*INSERT/i.test(query) && ++inserts === failOn) throw new Error("interrupted");
        return exec.call(this, query, ...bindings);
      },
    });
    restore = () => Object.defineProperty(proto, "exec", { configurable: true, value: exec });
```

  Here `let restore = () => {}` is declared at file level, and `afterEach` calls `restore()` before `reset()`.

  Create `worker-tests/audit-migration.test.ts`:

```ts
/**
 * AuditDO's move from KV rows to its SQL tables (audit trail spec, D5): a stream written in
 * the KV shape wakes into the table with every row's seq and every delivery mark.
 */
import { afterEach, expect, it } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuditDO } from "../src/store-do.js";
import type { AuditEntry } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const entry = (action: string): AuditEntry => ({
  at: 1_000, orgId: "org_old", sessionId: "qs_old", actorUserId: "u_old", action, detail: { n: 1 },
});

/** A stream in the KV shape, in a fresh object's storage, and the object dropped so the next call builds it anew. */
async function legacyStream() {
  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  await runInDurableObject(stub, async (_i: AuditDO, ctx) => {
    ctx.storage.sql.exec("DROP TABLE entries");
    ctx.storage.sql.exec("DROP TABLE delivered");
    await ctx.storage.put<unknown>({
      "a:000000000001": entry("member_left"), "a:000000000002": entry("invite_issued"),
      seq: 2, "d:intent-2": 2,
    });
  });
  await abortAllDurableObjects();
  return env.AUDIT.get(env.AUDIT.idFromName("org_old"));
}

const seqs = (stub: DurableObjectStub<AuditDO>) =>
  runInDurableObject(stub, (_i: AuditDO, ctx) =>
    ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM entries ORDER BY seq").toArray().map((r) => r.seq));

it("moves every row into the table with the seq its key carried, and leaves no KV row behind", async () => {
  const stub = await legacyStream();
  expect(await stub.recent(10)).toEqual([entry("member_left"), entry("invite_issued")]);
  expect(await seqs(stub)).toEqual([1, 2]);
  expect(await runInDurableObject(stub, (_i: AuditDO, ctx) => [...ctx.storage.kv.list()].map(([key]) => key))).toEqual([]);
});

it("keeps the delivery marks, so a redelivered intent appends nothing, and the next row takes the next seq", async () => {
  const stub = await legacyStream();
  await stub.append(entry("invite_issued"), "intent-2");
  await stub.append(entry("sent_message"), "intent-3");
  expect((await stub.recent(10)).map((e) => e.action)).toEqual(["member_left", "invite_issued", "sent_message"]);
  expect(await seqs(stub)).toEqual([1, 2, 3]);
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `npm run test:worker -- audit-dedupe audit-migration`
Expected: FAIL. The interrupted case sees `inserts` at 0, and the migration cases throw `no such table: entries`.

- [ ] **Step 7: Move `AuditDO` to SQL** — in `src/store-do.ts`:
  1. Delete `auditKey`, `deliveredKey`, and the comment on `deliveredKey`.
  2. Add `import { AUDIT_COLUMNS, entryOf, recordOf, type AuditRecord } from "./audit.js";` (Task 3 already imports `AuditActor` from there; merge the two).
  3. Replace the `AuditDO` section, from its `// AuditDO — one per org` banner to the end of the class, with:

```ts
// ---------------------------------------------------------------------------
// AuditDO — one per org
// ---------------------------------------------------------------------------

/** The stream's tables (audit trail spec, D5). `AUTOINCREMENT` never reuses a seq, so a cursor once handed out names one row for good. */
const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    org_id TEXT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_label TEXT,
    actor_org TEXT,
    room_name TEXT,
    parties TEXT,
    crossing TEXT,
    direction TEXT,
    detail TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS entries_at ON entries (at)",
  "CREATE TABLE IF NOT EXISTS delivered (intent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)",
];

/** Insert one entry and return its seq: the one given, for a row moved from the KV shape, or the next. */
function insertAuditRow(sql: SqlStorage, e: AuditEntry, seq: number | null = null): number {
  return sql.exec<{ seq: number }>(
    `INSERT INTO entries (seq, ${AUDIT_COLUMNS.join(", ")}) VALUES (?, ${AUDIT_COLUMNS.map(() => "?").join(", ")}) RETURNING seq`,
    seq, ...recordOf(e),
  ).one().seq;
}

/**
 * The tables, and a stream written in the KV shape (`a:<seq>` rows, the `seq` counter,
 * `d:<intent>` markers) moved into them: each row with the seq its key carries, so every
 * cursor already handed out still names its row. Run inside one `transactionSync`, so it
 * lands whole or not at all.
 * ponytail: one transaction, fine for thousands of rows; a stream far past any team's would batch it.
 */
function migrateAudit(storage: DurableObjectStorage): void {
  for (const ddl of AUDIT_SCHEMA) storage.sql.exec(ddl);
  const rows = [...storage.kv.list<AuditEntry>({ prefix: "a:" })];
  const marks = [...storage.kv.list<number>({ prefix: "d:" })];
  for (const [key, entry] of rows) insertAuditRow(storage.sql, entry, Number(key.slice(2)));
  for (const [key, seq] of marks) {
    storage.sql.exec("INSERT OR IGNORE INTO delivered (intent_id, seq) VALUES (?, ?)", key.slice(2), seq);
  }
  for (const [key] of [...rows, ...marks]) storage.kv.delete(key);
  storage.kv.delete("seq");
}

export class AuditDO extends DurableObject {
  constructor(...args: ConstructorParameters<typeof DurableObject>) {
    super(...args);
    // Before any call is let in: the tables, and a stream still in the KV shape moved into them.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => migrateAudit(this.ctx.storage));
    });
  }

  /**
   * Append an audit entry, at most once per intent.
   *
   * The outbox that feeds this delivers at least once: a row is deleted only after this
   * call returns, so an acknowledgement lost in flight redelivers. The `delivered` row is
   * what makes that safe. The look at it, the entry and the marker are one synchronous
   * transaction, so no second delivery can come between the look and the writes, and a
   * throw anywhere in it rolls all of it back: an audit log that could drop or double the
   * record of a privilege change would not be one. Callers with no intent to redeliver pass
   * no id and always append.
   */
  async append(entry: AuditEntry, intentId?: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (intentId !== undefined && sql.exec("SELECT 1 FROM delivered WHERE intent_id = ?", intentId).toArray().length > 0) {
        return;
      }
      const seq = insertAuditRow(sql, entry);
      if (intentId !== undefined) sql.exec("INSERT INTO delivered (intent_id, seq) VALUES (?, ?)", intentId, seq);
    });
  }

  /** The newest `limit` entries, oldest first: `bellman_audit`'s read. */
  async recent(limit: number): Promise<AuditEntry[]> {
    return this.ctx.storage.sql
      .exec<AuditRecord>("SELECT * FROM entries ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .reverse()
      .map(entryOf)
      .map(({ seq: _seq, ...entry }) => entry);
  }
}
```

- [ ] **Step 8: Run everything that touches the stream**

Run: `npm run test:worker -- audit`
Expected: PASS. This covers audit-dedupe, audit-migration, grant-audit-outbox and session-audit-outbox.
Run: `npm run typecheck:worker && npm run test:worker && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/audit.ts src/store-do.ts tests/audit.test.ts worker-tests/audit-dedupe.test.ts worker-tests/audit-migration.test.ts
git commit -m "Keep an org's audit stream in SQL, moved over from its KV rows in one transaction on the first wake"
```

### Task 5: One query, in both stores (D6)

**Files:**
- Modify: `src/audit.ts` (`AuditQuery`, `AuditPage`, `AuditFacets`, `FACET_LIMIT`, `pageOf`, `facetsOf`, `auditWhere`)
- Modify: `src/store.ts`:
  - `BellmanStore.queryAudit` and `auditFacets`
  - `MemoryStore`'s seq per org and the two methods
- Modify: `src/store-do.ts` (`AuditDO.query`, `AuditDO.facets`, and the facade's two methods)
- Test: `tests/helpers/store-contract.ts` (a new `describe`), `tests/audit.test.ts` (`auditWhere`)

**Interfaces:**
- Consumes: `SeqEntry`, `AuditRecord`, `entryOf` (Task 4).
- Produces:
  - `interface AuditQuery { from?: number; to?: number; actor?: string; room?: string; org?: string; action?: string; scope?: "internal" | "cross_org"; before?: number; through?: number; limit: number }`
  - `interface AuditPage { entries: SeqEntry[]; next: number | null; through: number | null; total: number; unrecorded: number }`
  - `interface AuditFacets { actors: { id: string; label: string | null }[]; rooms: { id: string; name: string | null }[]; orgs: string[]; actions: string[] }`
  - `FACET_LIMIT = 200`
  - `pageOf(rows: readonly SeqEntry[], q: AuditQuery): AuditPage`
  - `facetsOf(rows: readonly SeqEntry[], orgId: string): AuditFacets`
  - `auditWhere(q: AuditQuery, through: number | null, use: { scope: boolean; before: boolean }): { clause: string; params: (string | number)[] }`
  - `BellmanStore.queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage>`
  - `BellmanStore.auditFacets(orgId: string): Promise<AuditFacets>`

- [ ] **Step 1: Write the failing contract cases**

In `tests/helpers/store-contract.ts`, first extend the imports:

```ts
import type { AuditFacets, AuditPage, AuditQuery } from "../../src/audit.js";
import type { AuditEntry, SavedPreset, Session, SessionEvent, SurfaceItem } from "../../src/types.js";
```

Then, inside `describeStoreContract`'s `describe`, after the sessions cases, add:

```ts
    // ------------------------------------------------------------- the audit query (audit trail spec, D6)
    describe("the audit query", () => {
      const day = (d: string) => Date.parse(`2026-03-${d}T00:00:00Z`);
      const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
        at: Date.now(), orgId: "org_a", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message", detail: {},
        actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a"], crossing: "internal", direction: null,
        ...over,
      });
      const legacy = (over: Partial<AuditEntry> = {}): AuditEntry => ({
        at: Date.now(), orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {}, ...over,
      });
      const boInbound = { actorUserId: "u_bo", actorLabel: "Bo", actorOrgId: "org_b", parties: ["org_a", "org_b"], crossing: "cross_org", direction: "inbound" } as const;
      /** Six rows in org A's stream, seq 1 to 6, and one in org B's that no read of A's may see. */
      const fill = async () => {
        await store.appendAudit(legacy({ at: day("10") }));                                              // 1
        await store.appendAudit(row({ at: day("11") }));                                                 // 2
        await store.appendAudit(row({ at: day("12"), ...boInbound }));                                   // 3
        await store.appendAudit(row({ at: day("13"), sessionId: "qs_other", roomName: "other",
          parties: ["org_a", "org_c", null], crossing: "cross_org", direction: "outbound" }));           // 4
        await store.appendAudit(row({ at: day("14"), action: "invite_issued" }));                        // 5
        await store.appendAudit(row({ at: day("15"), sessionId: "grant:github:1", roomName: null,
          action: "plan_granted", actorUserId: "stripe", actorLabel: null, actorOrgId: null }));         // 6
        await store.appendAudit(row({ orgId: "org_b", parties: ["org_a", "org_b"], crossing: "cross_org", direction: "outbound" }));
      };
      const q = (over: Partial<AuditQuery> = {}): AuditQuery => ({ limit: 100, ...over });
      const seqs = (page: AuditPage) => page.entries.map((e) => e.seq);
      const read = async (over: Partial<AuditQuery>) => seqs(await store.queryAudit("org_a", q(over)));

      it("reads one org's stream newest first, covering it up to its newest row", async () => {
        await fill();
        const page = await store.queryAudit("org_a", q());
        expect(seqs(page)).toEqual([6, 5, 4, 3, 2, 1]);
        expect(page).toMatchObject({ next: null, through: 6, total: 6, unrecorded: 0 });
      });

      it("answers an empty stream with nothing, and no seq to pin", async () => {
        expect(await store.queryAudit("org_none", q())).toEqual({ entries: [], next: null, through: null, total: 0, unrecorded: 0 });
      });

      it("filters by each field, and combines filters with AND", async () => {
        await fill();
        expect(await read({ from: day("12"), to: day("14") })).toEqual([4, 3]);
        expect(await read({ actor: "u_bo" })).toEqual([3]);
        expect(await read({ room: "qs_other" })).toEqual([4]);
        expect(await read({ action: "invite_issued" })).toEqual([5]);
        expect(await read({ org: "org_c" })).toEqual([4]);
        expect(await read({ scope: "cross_org" })).toEqual([4, 3]);
        expect(await read({ scope: "internal" })).toEqual([6, 5, 2]);
        expect(await read({ scope: "cross_org", room: "qs_q3" })).toEqual([3]);
        expect(await read({ scope: "internal", from: day("14") })).toEqual([6, 5]);
      });

      it("counts the rows a scope filter left out because they record no crossing", async () => {
        await fill();
        expect((await store.queryAudit("org_a", q({ scope: "cross_org" }))).unrecorded).toBe(1);
        expect((await store.queryAudit("org_a", q({ scope: "cross_org", from: day("11") }))).unrecorded).toBe(0);
        expect((await store.queryAudit("org_a", q())).unrecorded).toBe(0);
      });

      it("pages with before and through: no row twice, none skipped, and none written after through", async () => {
        await fill();
        const first = await store.queryAudit("org_a", q({ limit: 4 }));
        expect(seqs(first)).toEqual([6, 5, 4, 3]);
        expect(first).toMatchObject({ next: 3, through: 6, total: 6 });
        await store.appendAudit(row()); // 7, written after the first page
        const second = await store.queryAudit("org_a", q({ limit: 4, before: first.next!, through: first.through! }));
        expect(seqs(second)).toEqual([2, 1]);
        expect(second).toMatchObject({ next: null, through: 6, total: 6 });
        expect(await read({ through: 6 })).not.toContain(7);
      });

      it("hands back a recorded row with its fields, and a row from before them without", async () => {
        await fill();
        const entries = (await store.queryAudit("org_a", q())).entries;
        expect(entries[3]).toEqual({ seq: 3, ...row({ at: day("12"), ...boInbound }) });
        expect(entries[5]).toEqual({ seq: 1, ...legacy({ at: day("10") }) });
      });

      it("offers the stream's actors, rooms, other orgs and actions, newest first", async () => {
        await fill();
        expect(await store.auditFacets("org_a")).toEqual({
          actors: [{ id: "stripe", label: null }, { id: "u_ana", label: "Ana" }, { id: "u_bo", label: "Bo" }, { id: "u_old", label: null }],
          rooms: [{ id: "qs_q3", name: "q3-plan" }, { id: "qs_other", name: "other" }, { id: "qs_old", name: null }],
          orgs: ["org_c", "org_b"],
          actions: ["plan_granted", "invite_issued", "sent_message", "member_left"],
        } satisfies AuditFacets);
      });

      // Review Focus 1: a value is bound, never spliced, so SQL in it is only text.
      it("matches a filter value literally, whatever SQL it spells", async () => {
        await fill();
        for (const actor of ["' OR 1=1 --", "%", "_", "u_%"]) expect(await read({ actor }), actor).toEqual([]);
      });

      // Review Focus 2.
      it("answers a range that holds nothing, or ends before it starts, with an empty page", async () => {
        await fill();
        expect(await store.queryAudit("org_a", q({ from: day("14"), to: day("12") })))
          .toEqual({ entries: [], next: null, through: 6, total: 0, unrecorded: 0 });
      });

      // Review Focus 3: the outbox can land a row after newer ones.
      it("filters by when a row happened and pages by when it landed, when the two disagree", async () => {
        await fill();
        await store.appendAudit(row({ at: Date.parse("2026-03-11T12:00:00Z"), action: "late" })); // 7
        const range = { from: day("11"), to: day("12") };
        expect(await read(range)).toEqual([7, 2]);
        const first = await store.queryAudit("org_a", q({ ...range, limit: 1 }));
        expect(seqs(first)).toEqual([7]);
        expect(await read({ ...range, limit: 1, before: first.next!, through: first.through! })).toEqual([2]);
      });
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/store.test.ts -t "the audit query"`
Expected: FAIL, because `store.queryAudit is not a function`.

- [ ] **Step 3: Write the failing `auditWhere` test** — in `tests/audit.test.ts`, add `auditWhere` to the import, and:

```ts
describe("auditWhere", () => {
  it("binds every value, and builds the clause from fixed fragments only", () => {
    const w = auditWhere({ limit: 1, actor: "' OR 1=1 --", org: "org_b", scope: "cross_org", before: 9 }, 12, { scope: true, before: true });
    expect(w.clause).toBe(
      "WHERE seq <= ? AND seq < ? AND actor_id = ? AND EXISTS (SELECT 1 FROM json_each(entries.parties) WHERE value = ?) AND crossing = ?",
    );
    expect(w.params).toEqual([12, 9, "' OR 1=1 --", "org_b", "cross_org"]);
  });

  it("leaves scope and before out when told to, and is empty with nothing to filter", () => {
    expect(auditWhere({ limit: 1, scope: "internal", before: 3 }, null, { scope: false, before: false })).toEqual({ clause: "", params: [] });
  });
});
```

- [ ] **Step 4: Write the query's semantics** — append to `src/audit.ts`:

```ts
/** A read of one org's stream (D6). Every field but `limit` narrows it; together they are an AND. */
export interface AuditQuery {
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, exclusive. */
  to?: number;
  actor?: string;
  room?: string;
  /** Matches any entry of `parties`. */
  org?: string;
  action?: string;
  scope?: "internal" | "cross_org";
  /** A seq: only rows older than it. */
  before?: number;
  /** A seq: only rows at or below it. */
  through?: number;
  limit: number;
}

export interface AuditPage {
  /** Newest first. */
  entries: SeqEntry[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
  /** The highest seq the read covered: its `through`, or the stream's newest when it named none; null for an empty stream. */
  through: number | null;
  /** Rows matching the filters at or below `through`: what an export of them holds. */
  total: number;
  /** Rows matching every filter but scope that record no crossing (D4); 0 without a scope. */
  unrecorded: number;
}

/** What the panel's filters offer (D7), newest first, up to FACET_LIMIT each. `orgs` never holds the reader's own. */
export interface AuditFacets {
  actors: { id: string; label: string | null }[];
  rooms: { id: string; name: string | null }[];
  orgs: string[];
  actions: string[];
}

// ponytail: 200 a list, not tuned. A stream with more distinct values offers its newest 200, and a filter still takes any value by URL.
export const FACET_LIMIT = 200;

const matches = (e: SeqEntry, q: AuditQuery, through: number | null, scope: boolean): boolean =>
  (through === null || e.seq <= through)
  && (q.from === undefined || e.at >= q.from)
  && (q.to === undefined || e.at < q.to)
  && (q.actor === undefined || e.actorUserId === q.actor)
  && (q.room === undefined || e.sessionId === q.room)
  && (q.action === undefined || e.action === q.action)
  && (q.org === undefined || (e.parties ?? []).includes(q.org))
  && (!scope || q.scope === undefined || e.crossing === q.scope);

/** The query over rows in memory: MemoryStore's read, held to AuditDO's SQL by the store contract. */
export function pageOf(rows: readonly SeqEntry[], q: AuditQuery): AuditPage {
  const through = q.through ?? (rows.length > 0 ? rows.reduce((max, r) => Math.max(max, r.seq), 0) : null);
  const all = rows.filter((r) => matches(r, q, through, true)).sort((a, b) => b.seq - a.seq);
  const older = q.before === undefined ? all : all.filter((r) => r.seq < q.before!);
  const entries = older.slice(0, q.limit);
  return {
    entries,
    next: older.length > q.limit ? entries.at(-1)!.seq : null,
    through,
    total: all.length,
    unrecorded: q.scope === undefined ? 0 : rows.filter((r) => r.crossing === undefined && matches(r, q, through, false)).length,
  };
}

/** The facets over rows in memory, newest first. Ties among orgs first seen in one row go in the row's sorted order, as the SQL's do. */
export function facetsOf(rows: readonly SeqEntry[], orgId: string): AuditFacets {
  const newestFirst = [...rows].sort((a, b) => b.seq - a.seq);
  const firstBy = (key: (e: SeqEntry) => string | undefined): [string, SeqEntry][] => {
    const seen = new Map<string, SeqEntry>();
    for (const e of newestFirst) {
      const k = key(e);
      if (k !== undefined && !seen.has(k)) seen.set(k, e);
    }
    return [...seen].slice(0, FACET_LIMIT);
  };
  return {
    actors: firstBy((e) => e.actorUserId).map(([id, e]) => ({ id, label: e.actorLabel ?? null })),
    rooms: firstBy((e) => (e.sessionId.startsWith("grant:") ? undefined : e.sessionId)).map(([id, e]) => ({ id, name: e.roomName ?? null })),
    orgs: [...new Set(newestFirst.flatMap((e) => (e.parties ?? []).filter((p): p is string => p !== null && p !== orgId)))]
      .slice(0, FACET_LIMIT),
    actions: firstBy((e) => e.action).map(([action]) => action),
  };
}

/**
 * The query as SQL for AuditDO's `entries` table: a WHERE clause built from fixed fragments,
 * with every value a bound parameter. `use.scope` and `use.before` leave those out, for the
 * counts: `total` ignores `before`, and `unrecorded` ignores the scope.
 */
export function auditWhere(
  q: AuditQuery, through: number | null, use: { scope: boolean; before: boolean },
): { clause: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, value: string | number) => {
    parts.push(sql);
    params.push(value);
  };
  if (through !== null) add("seq <= ?", through);
  if (use.before && q.before !== undefined) add("seq < ?", q.before);
  if (q.from !== undefined) add("at >= ?", q.from);
  if (q.to !== undefined) add("at < ?", q.to);
  if (q.actor !== undefined) add("actor_id = ?", q.actor);
  if (q.room !== undefined) add("session_id = ?", q.room);
  if (q.action !== undefined) add("action = ?", q.action);
  if (q.org !== undefined) add("EXISTS (SELECT 1 FROM json_each(entries.parties) WHERE value = ?)", q.org);
  if (use.scope && q.scope !== undefined) add("crossing = ?", q.scope);
  return { clause: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "", params };
}
```

- [ ] **Step 5: Give both stores the query** — in `src/store.ts`:
  1. Extend the audit import to `import { auditRows, facetsOf, pageOf, partiesOf, type AuditActor, type AuditFacets, type AuditPage, type AuditQuery, type SeqEntry } from "./audit.js";`.
  2. In `BellmanStore`, replace the two audit lines with:

```ts
  appendAudit(a: AuditEntry): Promise<void>;
  /** The newest `limit` rows of an org's stream, oldest first: `bellman_audit`'s read, and the tests'. */
  auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]>;
  /** One page of an org's stream under the filters, newest first (audit trail spec, D6). */
  queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage>;
  /** What the panel's filters offer: the stream's actors, rooms, other orgs and actions, newest first (D6). */
  auditFacets(orgId: string): Promise<AuditFacets>;
```

  3. In `MemoryStore`:
     - Replace `private audit: AuditEntry[] = [];` with:

```ts
  /** Each org's stream, with each row's seq: one counter per org, as each AuditDO keeps its own. */
  private audit: { seq: number; entry: AuditEntry }[] = [];
  private auditSeq = new Map<string, number>();
```

     - Replace `recordAudit`, `appendAudit` and `auditForOrg` with:

```ts
  private recordAudit(entries: AuditEntry[]): void {
    for (const entry of entries) {
      // No org, no stream: DurableObjectStore drops it too (ARCHITECTURE.md section 9, runtime fact 4).
      if (!entry.orgId) continue;
      const seq = (this.auditSeq.get(entry.orgId) ?? 0) + 1;
      this.auditSeq.set(entry.orgId, seq);
      this.audit.push({ seq, entry: detach(entry) });
    }
  }
```

```ts
  async appendAudit(a: AuditEntry): Promise<void> {
    this.recordAudit([a]);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return detach(this.audit.filter((r) => r.entry.orgId === orgId).slice(-limit).map((r) => r.entry));
  }

  async queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage> {
    return detach(pageOf(this.streamOf(orgId), query));
  }

  async auditFacets(orgId: string): Promise<AuditFacets> {
    return detach(facetsOf(this.streamOf(orgId), orgId));
  }

  private streamOf(orgId: string): SeqEntry[] {
    return this.audit.filter((r) => r.entry.orgId === orgId).map((r) => ({ ...r.entry, seq: r.seq }));
  }
```

- [ ] **Step 6: Give `AuditDO` the query** — in `src/store-do.ts`:
  1. Extend the audit import with `FACET_LIMIT, auditWhere, type AuditFacets, type AuditPage, type AuditQuery`.
  2. Add these two methods to `AuditDO`, after `recent`:

```ts
  /** One page under the filters, newest first (D6): the same answer `pageOf` gives over memory. */
  async query(q: AuditQuery): Promise<AuditPage> {
    const sql = this.ctx.storage.sql;
    const through = q.through ?? sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries").one().seq;
    const page = auditWhere(q, through, { scope: true, before: true });
    const rows = sql.exec<AuditRecord>(
      `SELECT * FROM entries ${page.clause} ORDER BY seq DESC LIMIT ?`, ...page.params, q.limit + 1,
    ).toArray();
    const all = auditWhere(q, through, { scope: true, before: false });
    const total = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM entries ${all.clause}`, ...all.params).one().n;
    let unrecorded = 0;
    if (q.scope !== undefined) {
      const rest = auditWhere(q, through, { scope: false, before: false });
      unrecorded = sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries ${rest.clause ? `${rest.clause} AND` : "WHERE"} crossing IS NULL`, ...rest.params,
      ).one().n;
    }
    const entries = rows.slice(0, q.limit).map(entryOf);
    return { entries, next: rows.length > q.limit ? entries.at(-1)!.seq : null, through, total, unrecorded };
  }

  /**
   * What the filters offer (D6), newest first. A label or a room's name comes from its newest
   * row: SQLite reads a bare column of a MAX() group from the row that holds the max.
   * ponytail: `at` is the only index; these and the filters on actor, room and action read the
   * table by seq, and gain indexes when a stream is large enough to feel the scan.
   */
  async facets(): Promise<AuditFacets> {
    const sql = this.ctx.storage.sql;
    return {
      actors: sql.exec<{ id: string; label: string | null; newest: number }>(
        "SELECT actor_id AS id, actor_label AS label, MAX(seq) AS newest FROM entries GROUP BY actor_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, label }) => ({ id, label })),
      rooms: sql.exec<{ id: string; name: string | null; newest: number }>(
        "SELECT session_id AS id, room_name AS name, MAX(seq) AS newest FROM entries WHERE session_id NOT LIKE 'grant:%' GROUP BY session_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, name }) => ({ id, name })),
      orgs: sql.exec<{ org: string; newest: number }>(
        "SELECT p.value AS org, MAX(e.seq) AS newest FROM entries e, json_each(e.parties) p WHERE p.value IS NOT NULL AND p.value != e.org_id GROUP BY p.value ORDER BY newest DESC, org ASC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ org }) => org),
      actions: sql.exec<{ action: string; newest: number }>(
        "SELECT action, MAX(seq) AS newest FROM entries GROUP BY action ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ action }) => action),
    };
  }
```

  3. In `DurableObjectStore`, after `auditForOrg`, add:

```ts
  async queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage> {
    return this.audit(orgId).query(query);
  }

  async auditFacets(orgId: string): Promise<AuditFacets> {
    return this.audit(orgId).facets();
  }
```

- [ ] **Step 7: Run the contract in both stores**

Run: `npx vitest run tests/audit.test.ts tests/store.test.ts`
Expected: PASS. That includes 10 `the audit query` cases for MemoryStore.
Run: `npm run test:worker -- store-contract audit`
Expected: PASS. That includes the same 10 cases for DurableObjectStore.
Run: `npm test && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/audit.ts src/store.ts src/store-do.ts tests/audit.test.ts tests/helpers/store-contract.ts
git commit -m "Read an org's audit stream by date, member, room, org, event and crossing, a page at a time under a pinned seq, the same in both stores"
```

### Task 6: `GET /audit` (D7)

Spec note: D7 says the gate is `isOrgAdmin`, exported from `src/http/rooms.ts`. To name the condition that failed, the gate needs the reason, not a boolean. So it becomes `auditRefusal` in `src/audit.ts`. The route, `isOrgAdmin` and `bellman_audit` all call it, so the three conditions live in one place. Task 8 corrects the spec's line.

**Files:**
- Modify: `src/audit.ts` (`auditRefusal`)
- Create: `src/http/audit.ts` (`AUDIT_PAGE`, `AuditParams`, `parseAuditQuery`, `AuditEntryView`, `entryView`, `auditRoutes`)
- Modify:
  - `src/http/rooms.ts`: `isOrgAdmin` calls `auditRefusal`; drop the `entitlementsFor` import
  - `src/tools/audit.ts`: calls `auditRefusal`
  - `src/worker.ts`: mounts `/audit`
- Test: `tests/http-audit.test.ts` (new), `worker-tests/audit-routes.test.ts` (new)

**Interfaces:**
- Consumes: `AuditQuery`, `AuditPage`, `SeqEntry` (Task 5); `json`, `problem`, `methodNotAllowed`, `RoomRouteDeps` (`src/http/rooms.ts`); `allowedOrigin`, `corsHeaders`, `preflightResponse` (`src/oauth/browser.ts`).
- Produces:
  - `auditRefusal(identity: Identity): string | null`
  - `AUDIT_PAGE = 100`
  - `type AuditParams = Omit<AuditQuery, "limit">`
  - `parseAuditQuery(params: URLSearchParams, exporting: boolean): { query: AuditParams; format?: "csv" | "json" } | { invalid: string }`
  - `interface AuditEntryView` and `entryView(e: SeqEntry): AuditEntryView`
  - `type AuditRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">`
  - `auditRoutes(request: Request, deps: AuditRouteDeps): Promise<Response | undefined>`

- [ ] **Step 1: Write the gate** — append to `src/audit.ts` (and add `import { entitlementsFor } from "./auth.js";` and `Identity` to the types import):

```ts
/**
 * Why `identity` may not read an org's audit stream, or null when it may: the team plan,
 * which is what pays for the log, the admin role, and an org, in that order and in
 * `bellman_audit`'s words. The tool, the room routes' admin read and the audit routes all
 * ask this, so the three conditions cannot drift apart.
 */
export function auditRefusal(identity: Identity): string | null {
  if (!entitlementsFor(identity).audit) return `the audit log requires the team plan (you are on "${identity.plan}").`;
  if (identity.role !== "admin") return "the audit log requires the admin role.";
  if (!identity.orgId) return "your identity has no org.";
  return null;
}
```

  In `src/http/rooms.ts`, keep `isOrgAdmin`'s doc comment, and make its body:

```ts
const isOrgAdmin = (identity: Identity): identity is Identity & { orgId: string } => auditRefusal(identity) === null;
```

  Add `import { auditRefusal } from "../audit.js";`, and remove `import { entitlementsFor } from "../auth.js";`; nothing else in the file uses it.

  In `src/tools/audit.ts`:
  1. Replace the three `if` lines and the read that follows them with:

```ts
      const refused = auditRefusal(identity);
      if (refused) return fail(refused);
      const orgId = identity.orgId as string; // auditRefusal refuses an identity with no org

      const entries = (await s.auditForOrg(orgId, limit)).map((a) => ({
```

  2. Change the return to `return ok({ org_id: orgId, count: entries.length, entries });`.
  3. Replace the `entitlementsFor` import with `import { auditRefusal } from "../audit.js";`.

- [ ] **Step 2: Write the wire's pieces** — create `src/http/audit.ts` with the pure parts. Step 4 adds the route below them.

```ts
/**
 * The audit routes (audit trail spec, D7 and D8): an org admin reads their own org's stream, a
 * page at a time or whole as a file. On the room routes' rules: the same caller, CORS for the
 * panel's origins and the same preflight. Both are reads, so neither needs a CSRF check. The
 * org is always the caller's own, never a parameter.
 */
import { auditRefusal, type AuditQuery, type SeqEntry } from "../audit.js";
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type AuditRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

/** Rows in one page of `GET /audit`. */
export const AUDIT_PAGE = 100;

export type AuditParams = Omit<AuditQuery, "limit">;

const LIST_PARAMS = ["from", "to", "actor", "room", "org", "action", "scope", "before", "through"];
const EXPORT_PARAMS = ["from", "to", "actor", "room", "org", "action", "scope", "through", "format"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_FILTER_CHARS = 200;

/**
 * The query string as a filter, or the sentence a 400 says. Every parameter is one this route
 * takes, given once, in its form: a filter an auditor mistyped must not be dropped quietly, or
 * an export holds rows its reader believes were left out.
 */
export function parseAuditQuery(
  params: URLSearchParams, exporting: boolean,
): { query: AuditParams; format?: "csv" | "json" } | { invalid: string } {
  const route = exporting ? "/audit/export" : "/audit";
  const known = exporting ? EXPORT_PARAMS : LIST_PARAMS;
  const given = new Map<string, string>();
  for (const [name, value] of params) {
    if (!known.includes(name)) return { invalid: `${name} is not a parameter of ${route}` };
    if (given.has(name)) return { invalid: `${name} is given more than once` };
    given.set(name, value);
  }
  const query: AuditParams = {};
  for (const name of ["from", "to"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    const t = Date.parse(v);
    if (!ISO_INSTANT.test(v) || !Number.isFinite(t)) return { invalid: `${name} must be an ISO 8601 instant, such as 2026-10-09T00:00:00Z` };
    query[name] = t;
  }
  for (const name of ["actor", "room", "org", "action"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    if (v.length < 1 || v.length > MAX_FILTER_CHARS) return { invalid: `${name} must be 1 to ${MAX_FILTER_CHARS} characters` };
    query[name] = v;
  }
  const scope = given.get("scope");
  if (scope !== undefined) {
    if (scope !== "internal" && scope !== "cross_org") return { invalid: "scope must be internal or cross_org" };
    query.scope = scope;
  }
  for (const name of ["before", "through"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return { invalid: `${name} is a seq: a whole number, 0 or more` };
    query[name] = Number(v);
  }
  if (!exporting) return { query };
  const format = given.get("format");
  if (format !== "csv" && format !== "json") return { invalid: "format is required: csv or json" };
  return { query, format };
}

/** One row as the panel and an export read it (D7). A row from before D2 says it recorded no crossing. */
export interface AuditEntryView {
  seq: number;
  at: string;
  action: string;
  room: { id: string; name: string | null } | null;
  /** `label` and `org_id` are absent on a row from before D2: not recorded, which is not the same as no org. */
  actor: { id: string; label?: string | null; org_id?: string | null };
  parties: (string | null)[] | null;
  crossing: "internal" | "cross_org" | null;
  direction: "outbound" | "inbound" | null;
  detail: Record<string, unknown>;
}

export function entryView(e: SeqEntry): AuditEntryView {
  const recorded = e.crossing !== undefined;
  return {
    seq: e.seq,
    at: new Date(e.at).toISOString(),
    action: e.action,
    // A grant row is about an org's plan, filed under `grant:<key>`, not about a room.
    room: e.sessionId.startsWith("grant:") ? null : { id: e.sessionId, name: recorded ? e.roomName ?? null : null },
    actor: recorded ? { id: e.actorUserId, label: e.actorLabel ?? null, org_id: e.actorOrgId ?? null } : { id: e.actorUserId },
    parties: recorded ? e.parties ?? [] : null,
    crossing: e.crossing ?? null,
    direction: recorded ? e.direction ?? null : null,
    detail: e.detail,
  };
}
```

- [ ] **Step 3: Write the failing route tests** — create `tests/http-audit.test.ts`:

```ts
/**
 * The audit routes (audit trail spec, D7 and D8), driven as the Worker drives them: a Request
 * in, a Response out, over a MemoryStore, with rows written by the rooms' own audit rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_PAGE, auditRoutes, type AuditEntryView, type AuditRouteDeps } from "../src/http/audit.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { audit } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { AuditEntry, Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

/** The callers, by bearer token: two org admins, and one of each reason to be refused. */
const people: Record<string, Identity> = {
  "admin-a": { userId: "u_ana", orgId: "org_a", plan: "team", role: "admin", label: "Ana" },
  "admin-b": { userId: "u_bo", orgId: "org_b", plan: "team", role: "admin", label: "Bo" },
  "member-a": { userId: "u_al", orgId: "org_a", plan: "team", role: "member", label: "Al" },
  "free-a": { userId: "u_fi", orgId: "org_a", plan: "free", role: "admin", label: "Fi" },
  "no-org": { userId: "u_nn", orgId: null, plan: "team", role: "admin", label: "Nn" },
};

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const identity = token === undefined ? undefined : people[token];
  return identity ? { identity, via: "bearer" } : null;
};

let store: MemoryStore;
let deps: AuditRouteDeps;
beforeEach(() => {
  store = new MemoryStore();
  deps = { store, caller, panelOrigins: [PANEL] };
});

const call = (who: string | null, path: string, method = "GET") =>
  auditRoutes(new Request(`${ISSUER}${path}`, {
    method,
    headers: { origin: PANEL, ...(who ? { authorization: `Bearer ${who}` } : {}) },
  }), deps);

interface ListBody {
  org_id: string;
  entries: AuditEntryView[];
  next: number | null;
  through: number | null;
  total: number;
  unrecorded: number;
  facets?: Record<string, unknown[]>;
}
const list = async (path: string, who = "admin-a") => (await (await call(who, path))!.json()) as ListBody;
const said = async (res: Response | undefined) => ((await res!.json()) as { error_description: string }).error_description;

/** A row in org A's stream as a builder writes one; override any field. */
const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  at: Date.parse("2026-10-01T00:00:00Z"), orgId: "org_a", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message",
  detail: {}, actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a"], crossing: "internal", direction: null,
  ...over,
});

describe("GET /audit", () => {
  it("leaves a path outside /audit to the next module", async () => {
    expect(await call("admin-a", "/rooms")).toBeUndefined();
    expect(await call("admin-a", "/auditing")).toBeUndefined();
  });

  it("refuses without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/audit"))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("refuses a caller the log does not admit, naming the condition in bellman_audit's words", async () => {
    expect((await call("member-a", "/audit"))!.status).toBe(403);
    expect(await said(await call("free-a", "/audit"))).toBe('the audit log requires the team plan (you are on "free").');
    expect(await said(await call("member-a", "/audit"))).toBe("the audit log requires the admin role.");
    expect(await said(await call("no-org", "/audit"))).toBe("your identity has no org.");
  });

  it("answers GET only, and nothing under /audit but the export", async () => {
    const post = (await call("admin-a", "/audit", "POST"))!;
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect((await call("admin-a", "/audit/everything"))!.status).toBe(404);
  });

  it.each([
    ["from=yesterday", "from must be an ISO 8601 instant"],
    ["to=2026-10-09", "to must be an ISO 8601 instant"],
    ["scope=both", "scope must be internal or cross_org"],
    ["before=-1", "before is a seq"],
    ["through=1.5", "through is a seq"],
    [`actor=${"x".repeat(201)}`, "actor must be 1 to 200 characters"],
    ["room=", "room must be 1 to 200 characters"],
    ["actr=u_ana", "actr is not a parameter of /audit"],
    ["format=csv", "format is not a parameter of /audit"],
    ["action=a&action=b", "action is given more than once"],
  ])("refuses %s, naming the parameter", async (query, words) => {
    const res = (await call("admin-a", `/audit?${query}`))!;
    expect(res.status).toBe(400);
    expect(await said(res)).toContain(words);
  });

  // dash#11's first acceptance check.
  it("shows a crossing to both orgs: outbound for the actor's, inbound for the other's", async () => {
    const room = session({
      id: "qs_q3", orgId: "org_a",
      members: [
        member({ memberId: "m_ana", userId: "u_ana", label: "Ana", orgId: "org_a" }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" }),
      ],
    });
    await audit(store, room, people["admin-a"]!, "sent_message", { chars: 5 });

    const seen = {
      seq: 1, at: expect.any(String), action: "sent_message", room: { id: "qs_q3", name: room.manifest.room },
      actor: { id: "u_ana", label: "Ana", org_id: "org_a" }, parties: ["org_a", "org_b"], crossing: "cross_org", detail: { chars: 5 },
    };
    expect((await list("/audit", "admin-a")).entries).toEqual([{ ...seen, direction: "outbound" }]);
    expect((await list("/audit", "admin-b")).entries).toEqual([{ ...seen, direction: "inbound" }]);
  });

  it("reads newest first a page at a time, with the filters' options on the first page only", async () => {
    for (let i = 0; i < AUDIT_PAGE + 5; i++) await store.appendAudit(row({ detail: { i } }));
    const first = await list("/audit");
    expect(first).toMatchObject({ org_id: "org_a", next: 6, through: 105, total: 105, unrecorded: 0 });
    expect(first.entries.map((e) => e.seq)).toEqual(Array.from({ length: AUDIT_PAGE }, (_, k) => 105 - k));
    expect(first.facets).toEqual({ actors: [{ id: "u_ana", label: "Ana" }], rooms: [{ id: "qs_q3", name: "q3-plan" }], orgs: [], actions: ["sent_message"] });

    const second = await list(`/audit?before=${first.next}&through=${first.through}`);
    expect(second.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(second).toMatchObject({ next: null, through: 105, total: 105 });
    expect(second.facets).toBeUndefined();
  });

  it("never shows another org's rows, whatever the org filter names", async () => {
    await store.appendAudit(row({ orgId: "org_b", actorUserId: "u_bo", parties: ["org_b"] }));
    await store.appendAudit(row({ parties: ["org_a", "org_b"], crossing: "cross_org", direction: "outbound" }));
    expect((await list("/audit?org=org_b")).entries.map((e) => e.parties)).toEqual([["org_a", "org_b"]]);
    expect((await list("/audit")).total).toBe(1);
  });

  it("says a row from before crossings were recorded recorded none, and gives a grant row no room", async () => {
    await store.appendAudit({ at: 1_000, orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {} });
    await store.appendAudit(row({ sessionId: "grant:github:1", roomName: null, action: "plan_granted" }));
    const [grant, old] = (await list("/audit")).entries;
    expect(grant).toMatchObject({ room: null, crossing: "internal" });
    expect(old).toEqual({
      seq: 1, at: "1970-01-01T00:00:01.000Z", action: "member_left", room: { id: "qs_old", name: null },
      actor: { id: "u_old" }, parties: null, crossing: null, direction: null, detail: {},
    });
  });
});
```


- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run tests/http-audit.test.ts`
Expected: FAIL, because `auditRoutes` is not exported from `../src/http/audit.js`.

- [ ] **Step 5: Write the route** — append to `src/http/audit.ts`:

```ts
/** `undefined` for a path outside `/audit`, so the Worker carries on; everything under it is answered here. */
export async function auditRoutes(request: Request, deps: AuditRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/audit" && !path.startsWith("/audit/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    if (path !== "/audit") return problem(404, "not_found", "no such route", origin);
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const refused = auditRefusal(who.identity);
    if (refused) return problem(403, "forbidden", refused, origin);
    const orgId = who.identity.orgId as string; // auditRefusal refuses an identity with no org
    const parsed = parseAuditQuery(url.searchParams, false);
    if ("invalid" in parsed) return problem(400, "invalid_request", parsed.invalid, origin);
    return await readAudit(orgId, parsed.query, origin, deps);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}

/** One page (D7). The filters' options come with the first page only, and cover the whole stream. */
async function readAudit(orgId: string, query: AuditParams, origin: string | undefined, deps: AuditRouteDeps): Promise<Response> {
  const page = await deps.store.queryAudit(orgId, { ...query, limit: AUDIT_PAGE });
  const facets = query.before === undefined ? await deps.store.auditFacets(orgId) : undefined;
  return json(200, {
    org_id: orgId,
    entries: page.entries.map(entryView),
    next: page.next,
    through: page.through,
    total: page.total,
    unrecorded: page.unrecorded,
    ...(facets ? { facets } : {}),
  }, origin);
}
```

  Task 7 replaces `if (path !== "/audit") return problem(404, ...)` when it adds `/audit/export`.

- [ ] **Step 6: Mount it** — in `src/worker.ts`:
  1. Add `import { auditRoutes } from "./http/audit.js";`.
  2. Add this block after the presets block:

```ts
    // The org's audit stream (audit trail spec, D7 and D8), on the room routes' rules and behind the same guard.
    if (url.pathname === "/audit" || url.pathname.startsWith("/audit/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await auditRoutes(request, {
        store,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }
```

- [ ] **Step 7: Write the wiring test** — `src/worker.ts` is outside the Node program, so create `worker-tests/audit-routes.test.ts`:

```ts
/**
 * The Worker mounts the audit routes over the real stores (audit trail spec, D7 and D8). The
 * routes' rules are pinned in tests/http-audit.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test"; // team plan, admin, org_codenerd: worker-tests/vitest.config.ts
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${KEY}` } }), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the audit routes through the Worker", () => {
  it("serve the caller's own org's stream from its AuditDO", async () => {
    await new DurableObjectStore(env as never).appendAudit({
      at: 1_000, orgId: "org_codenerd", sessionId: "qs_1", actorUserId: "u_jesse", action: "session_created", detail: {},
    });
    const res = await call("/audit");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      org_id: "org_codenerd", total: 1, through: 1, entries: [{ seq: 1, action: "session_created" }],
    });
  });
});
```

- [ ] **Step 8: Run them, and everything**

Run: `npx vitest run tests/http-audit.test.ts`
Expected: PASS, 18 tests.
Run: `npm run test:worker -- audit-routes`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS. The `bellman_audit` tests still pass, because the refusals use the same words.

- [ ] **Step 9: Commit**

```bash
git add src/audit.ts src/http/audit.ts src/http/rooms.ts src/tools/audit.ts src/worker.ts tests/http-audit.test.ts worker-tests/audit-routes.test.ts
git commit -m "Serve an org admin their org's audit stream at GET /audit, refused in bellman_audit's words"
```

### Task 7: `GET /audit/export` (D8)

**Files:**
- Modify: `src/http/audit.ts` (`AUDIT_EXPORT_PAGE`, `CSV_COLUMNS`, `csvCell`, `csvRow`, `csvHeader`, `exportFilename`, `exportAudit`; the router branch)
- Test: `tests/http-audit.test.ts`, `worker-tests/audit-routes.test.ts`

**Interfaces:**
- Consumes: `entryView`, `AuditEntryView`, `parseAuditQuery`, `AuditParams` (Task 6); `attachmentDisposition` (`src/blobs.ts`); `corsHeaders` (`src/oauth/browser.ts`).
- Produces:
  - `AUDIT_EXPORT_PAGE = 500`
  - `CSV_COLUMNS`
  - `csvCell(value: string | number | null | undefined): string`
  - `csvRow(v: AuditEntryView): string`
  - `csvHeader: string`
  - `exportFilename(orgId: string, through: number | null, format: "csv" | "json"): string`

- [ ] **Step 1: Write the failing tests** — in `tests/http-audit.test.ts`:
  1. Change the vitest import to `import { beforeEach, describe, expect, it, vi } from "vitest";`.
  2. Extend the `../src/http/audit.js` import with `AUDIT_EXPORT_PAGE, CSV_COLUMNS, csvCell, csvRow, entryView, exportFilename`.
  3. Add:

```ts
describe("the CSV", () => {
  it("quotes a cell that holds a comma, a quote or a line break, doubling its quotes", () => {
    expect(csvCell('Bo, "the" builder')).toBe('"Bo, ""the"" builder"');
    expect(csvCell("two\r\nlines")).toBe('"two\r\nlines"');
  });

  it("puts a ' before a string a spreadsheet would run as a formula", () => {
    expect(["=1+1", "+1", "-1", "@SUM(A1)", "\tx"].map(csvCell)).toEqual(["'=1+1", "'+1", "'-1", "'@SUM(A1)", "'\tx"]);
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it("writes nothing for null, and a number as itself", () => {
    expect([csvCell(null), csvCell(undefined), csvCell(12)]).toEqual(["", "", "12"]);
  });

  it("writes a row in the columns' order, the parties joined with ; and a person with no org named so", () => {
    const view = entryView({ seq: 3, ...row({ at: 7, parties: ["org_a", null], crossing: "cross_org", direction: "outbound", detail: { chars: 5 } }) });
    expect(csvRow(view)).toBe(`3,1970-01-01T00:00:00.007Z,sent_message,qs_q3,q3-plan,u_ana,Ana,org_a,org_a;(no org),cross_org,outbound,"{""chars"":5}"\r\n`);
  });

  it("writes an org id that would break a header as a safe file name", () => {
    expect(exportFilename('org/a b"c', 7, "json")).toBe("bellman-audit-org_a_b_c-7.json");
    expect(exportFilename("org_a", null, "csv")).toBe("bellman-audit-org_a-0.csv");
  });
});

/** `n` rows an hour apart in org A's stream: every 2nd by Ana, every 4th internal, every 3rd in another room. */
async function rows(n: number) {
  for (let i = 1; i <= n; i++) {
    const internal = i % 4 === 0;
    await store.appendAudit(row({
      at: Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000,
      sessionId: i % 3 === 0 ? "qs_other" : "qs_q3",
      actorUserId: i % 2 === 0 ? "u_ana" : "u_bo", actorLabel: i % 2 === 0 ? "Ana" : "Bo", actorOrgId: i % 2 === 0 ? "org_a" : "org_b",
      parties: internal ? ["org_a"] : ["org_a", "org_b"], crossing: internal ? "internal" : "cross_org",
      direction: internal ? null : i % 2 === 0 ? "outbound" : "inbound", detail: { i },
    }));
  }
}

describe("GET /audit/export", () => {
  // dash#11's second acceptance check: filters compose, and the export is what the screen pages through.
  it("exports exactly the rows the list pages through, as JSON and as CSV, under a filter of scope, member and dates", async () => {
    await rows(2_400);
    const filter = "scope=cross_org&actor=u_ana&from=2026-10-05T00:00:00Z&to=2027-01-10T00:00:00Z";
    const listed: AuditEntryView[] = [];
    let page = await list(`/audit?${filter}`);
    listed.push(...page.entries);
    while (page.next !== null) {
      page = await list(`/audit?${filter}&before=${page.next}&through=${page.through}`);
      listed.push(...page.entries);
    }
    expect(listed).toHaveLength(page.total);
    expect(listed.length).toBeGreaterThan(AUDIT_EXPORT_PAGE); // the export reads more than one page

    const json = (await (await call("admin-a", `/audit/export?${filter}&format=json&through=${page.through}`))!.json()) as {
      org_id: string; filter: Record<string, string>; through: number; entries: AuditEntryView[];
    };
    expect(json.entries).toEqual(listed);
    expect(json).toMatchObject({ org_id: "org_a", through: page.through, filter: { scope: "cross_org", actor: "u_ana" } });

    const csv = await (await call("admin-a", `/audit/export?${filter}&format=csv&through=${page.through}`))!.text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.slice(1).map((l) => Number(l.split(",")[0]))).toEqual(listed.map((e) => e.seq));
  });

  it("pins an export to the seq it is given, so rows written since are not in it", async () => {
    await rows(3);
    await store.appendAudit(row());
    const json = (await (await call("admin-a", "/audit/export?format=json&through=3"))!.json()) as { through: number; entries: AuditEntryView[] };
    expect([json.through, json.entries.map((e) => e.seq)]).toEqual([3, [3, 2, 1]]);
  });

  it("names the file for the org and its seq, sends it as a download, and lets the panel read the name", async () => {
    await rows(2);
    const res = (await call("admin-a", "/audit/export?format=csv"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''bellman-audit-org_a-2.csv");
    expect(res.headers.get("access-control-expose-headers")).toBe("content-disposition");
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["before=3&format=csv", "before is not a parameter of /audit/export"],
    ["", "format is required: csv or json"],
    ["format=xml", "format is required: csv or json"],
  ])("refuses %s", async (query, words) => {
    const res = (await call("admin-a", `/audit/export?${query}`))!;
    expect(res.status).toBe(400);
    expect(await said(res)).toBe(words);
  });

  it("refuses a caller the log does not admit, as the list does", async () => {
    expect((await call("member-a", "/audit/export?format=csv"))!.status).toBe(403);
  });

  it("errors the stream when a read fails partway, rather than ending a short file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await rows(AUDIT_EXPORT_PAGE + 1);
    const real = store.queryAudit.bind(store);
    vi.spyOn(store, "queryAudit").mockImplementationOnce(real).mockRejectedValueOnce(new Error("the stream went away"));
    const res = (await call("admin-a", "/audit/export?format=csv"))!;
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/http-audit.test.ts`
Expected: FAIL. `csvCell` and the others are not exported, and `/audit/export` answers 404.

- [ ] **Step 3: Write the CSV and the file's name** — in `src/http/audit.ts`:
  1. Add `import { attachmentDisposition } from "../blobs.js";`.
  2. Change the browser import to `import { allowedOrigin, corsHeaders, preflightResponse } from "../oauth/browser.js";`.
  3. Add `type AuditPage` to the `../audit.js` import.
  4. Add, below `entryView`:

```ts
/** Rows the export reads per page: one page per pull, so a long stream is never held whole. */
export const AUDIT_EXPORT_PAGE = 500;

export const CSV_COLUMNS = [
  "seq", "at", "action", "room_id", "room_name", "actor_id", "actor_label", "actor_org",
  "parties", "crossing", "direction", "detail",
] as const;

export const csvHeader = `${CSV_COLUMNS.join(",")}\r\n`;

// What a spreadsheet reads as the start of a formula. Room names and labels are written by users.
const FORMULA = /^[=+\-@\t\r]/;

/** One RFC 4180 cell. A string a spreadsheet would run as a formula gets a leading ', so it is only text. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" && FORMULA.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row, in CSV_COLUMNS order, ending in CRLF. */
export function csvRow(v: AuditEntryView): string {
  return `${[
    v.seq, v.at, v.action, v.room?.id, v.room?.name, v.actor.id, v.actor.label, v.actor.org_id,
    v.parties?.map((p) => p ?? "(no org)").join(";"), v.crossing, v.direction, JSON.stringify(v.detail),
  ].map(csvCell).join(",")}\r\n`;
}

/** The export's name (D8): the org, with anything outside a safe set written as `_` so no id can break the header, and its seq. */
export const exportFilename = (orgId: string, through: number | null, format: "csv" | "json"): string =>
  `bellman-audit-${orgId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${through ?? 0}.${format}`;
```

- [ ] **Step 4: Route the export** — in `auditRoutes`:
  1. Replace the lines from `if (path !== "/audit") return problem(404, ...)` through `return await readAudit(...)` with:

```ts
    const exporting = path === "/audit/export";
    if (path !== "/audit" && !exporting) return problem(404, "not_found", "no such route", origin);
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const refused = auditRefusal(who.identity);
    if (refused) return problem(403, "forbidden", refused, origin);
    const orgId = who.identity.orgId as string; // auditRefusal refuses an identity with no org
    const parsed = parseAuditQuery(url.searchParams, exporting);
    if ("invalid" in parsed) return problem(400, "invalid_request", parsed.invalid, origin);
    if (parsed.format) return await exportAudit(orgId, parsed.query, parsed.format, url.searchParams, origin, deps);
    return await readAudit(orgId, parsed.query, origin, deps);
```

  2. Add below `readAudit`:

```ts
/**
 * The whole filtered stream as a file (D8), newest first as the page shows it, pinned to one
 * seq so it holds what the page counted. A page of AUDIT_EXPORT_PAGE per pull, so a long stream
 * is never held whole. A failure partway errors the stream instead of closing it: the reader
 * sees a failed body, never a short file that looks complete.
 * ponytail: one request over the whole filtered stream; a stream big enough to strain it wants #58's push.
 */
async function exportAudit(
  orgId: string, query: AuditParams, format: "csv" | "json", params: URLSearchParams,
  origin: string | undefined, deps: AuditRouteDeps,
): Promise<Response> {
  let page: AuditPage | null = await deps.store.queryAudit(orgId, { ...query, limit: AUDIT_EXPORT_PAGE });
  const through = page.through;
  const filter = Object.fromEntries([...params].filter(([name]) => name !== "format" && name !== "through"));
  const encoder = new TextEncoder();
  let written = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(format === "csv"
        ? csvHeader
        : `{"org_id":${JSON.stringify(orgId)},"filter":${JSON.stringify(filter)},"through":${JSON.stringify(through)},"entries":[`));
    },
    async pull(controller) {
      try {
        if (page === null) {
          if (format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
          return;
        }
        let chunk = "";
        for (const e of page.entries) {
          const view = entryView(e);
          chunk += format === "csv" ? csvRow(view) : `${written++ > 0 ? "," : ""}${JSON.stringify(view)}`;
        }
        controller.enqueue(encoder.encode(chunk));
        page = page.next === null
          ? null
          : await deps.store.queryAudit(orgId, { ...query, through: through ?? undefined, before: page.next, limit: AUDIT_EXPORT_PAGE });
      } catch (err) {
        console.error(`the audit export for ${orgId} failed partway:`, err);
        controller.error(err);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": attachmentDisposition(exportFilename(orgId, through, format)),
      "cache-control": "no-store",
      // Without it a cross-origin fetch cannot read the name, and the panel would save under one of its own.
      "access-control-expose-headers": "content-disposition",
      ...corsHeaders(origin),
    },
  });
}
```

- [ ] **Step 5: Add the wiring case** — in `worker-tests/audit-routes.test.ts`, inside the `describe`:

```ts
  it("stream the export from the same store", async () => {
    const store = new DurableObjectStore(env as never);
    for (const action of ["session_created", "invite_issued"]) {
      await store.appendAudit({ at: 1_000, orgId: "org_codenerd", sessionId: "qs_1", actorUserId: "u_jesse", action, detail: {} });
    }
    const res = await call("/audit/export?format=json");
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { entries: { action: string }[] };
    expect(body.entries.map((e) => e.action)).toEqual(["invite_issued", "session_created"]);
  });
```

- [ ] **Step 6: Run them, and everything**

Run: `npx vitest run tests/http-audit.test.ts`
Expected: PASS.
Run: `npm run test:worker -- audit-routes`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/http/audit.ts tests/http-audit.test.ts worker-tests/audit-routes.test.ts
git commit -m "Export the filtered audit stream as CSV or JSON at GET /audit/export, a page at a time and pinned to the page's seq"
```

### Task 8: The retention the page states, and the docs (D9)

**Files:**
- Modify: `src/types.ts` (`Entitlements`), `src/auth.ts` (each plan)
- Test: `tests/auth.test.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-10-09-audit-trail-design.md`

**Interfaces:**
- Produces: `Entitlements.auditRetentionMs: number | null`. `/account` already sends `entitlements` whole (`src/oauth/routes.ts`, `entitlements: limits`), so no route changes.

- [ ] **Step 1: Write the failing test** — in `tests/auth.test.ts`, inside `describe("plan entitlements", ...)`:

```ts
  /** Audit rows are kept with no expiry on every plan (audit trail spec, D9); #58 decides a window. */
  it("keeps audit rows with no expiry on every plan", () => {
    for (const plan of plans) expect(ENTITLEMENTS[plan].auditRetentionMs, plan).toBeNull();
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/auth.test.ts -t "audit rows"`
Expected: FAIL, because `auditRetentionMs` is `undefined`, not `null`.

- [ ] **Step 3: Add the entitlement**
  1. In `src/types.ts`, add to `Entitlements` after `retainAfterCloseMs`:

```ts
  /**
   * How long an org's audit rows are kept (audit trail spec, D9): null keeps them with no
   * expiry, which is what happens today. `/account` sends it, and the panel's Audit page says it.
   */
  auditRetentionMs: number | null;
```

  2. In `src/auth.ts`, add `auditRetentionMs: null,` to each of the four plans. On `free`, put this comment above it:

```ts
    // Audit rows are kept with no expiry on every plan (audit trail spec, D9). #58 decides a window and the sweep.
```

- [ ] **Step 4: Run it to see it pass, and typecheck**

Run: `npx vitest run tests/auth.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS. The "max ... and nothing else" case is unchanged, because every plan has the same value.

- [ ] **Step 5: Say it in the docs**
  1. In `README.md`, replace the paragraph `A room that crosses organisations writes to **both** orgs' audit streams, so each side sees the crossings that touched its own boundary and nothing else.` with:

```markdown
An action in a room that holds people from more than one organisation is written to **every** one of their orgs' audit streams: the room's org, the actor's, and the org of each person in the room at that moment. Each copy says from its own org's side whether the action crossed and which way: `outbound` when one of its people acted, `inbound` when someone else did. So when a member of one org sends in a room another org's member sits in, both orgs' logs record it, and each side sees the crossings that touched its own boundary and nothing else. A row records who acted, by name and org, and the orgs in the room, never the content of what was sent.
```

  2. In `README.md`, add after the bullet that begins `` - On the team plan an org's admin can read any closed room ``:

```markdown
- An org's admin on the team plan reads the org's audit stream over HTTP. `GET /audit` answers a page of 100 rows, newest first, filtered by `from` and `to` (ISO instants), `actor`, `room`, `org`, `action` and `scope` (`internal` or `cross_org`), with `next` and `through` for the next page and, on the first page, the values each filter can take. `GET /audit/export?format=csv` or `format=json`, with the same filters, streams every matching row as a file. Rows are kept with no expiry; `/account` says so as `entitlements.auditRetentionMs: null`.
```

  3. In `docs/ARCHITECTURE.md`, in the control panel paragraph, change `saved presets, beside the blob routes (#183).` to `saved presets, and \`GET /audit\` and \`GET /audit/export\` for an org admin's read of the org's audit stream (dash#11), beside the blob routes (#183).`
  4. In `docs/ARCHITECTURE.md`, replace the `**\`AuditDO\` is per org**` bullet with:

```markdown
- **`AuditDO` is per org** because an action in a room that holds more than one org is written
  to every one of their streams (`auditEntries`, `src/rooms.ts`), and each side must see only
  the crossings that touched its own boundary. Its rows are a SQL table (`entries`, with the
  delivery marks in `delivered`), so one query serves the panel's filters, paging and export.
```

- [ ] **Step 6: Correct the spec where the plan departed from it** — in `docs/superpowers/specs/2026-10-09-audit-trail-design.md`:
  1. In D5's `CREATE TABLE`, add `org_id TEXT,` after `at INTEGER NOT NULL,`.
  2. Replace `The object is one org's stream and stores no org; the store facade names the org on the way out.` with `Each row keeps its \`org_id\`, as the entry it was written from carries it, so \`recent\` and the query hand an entry back whole.`
  3. In D7, replace `The gate is \`isOrgAdmin\` (team plan, admin role, an org), exported from \`src/http/rooms.ts\`.` with `The gate is \`auditRefusal\` in \`src/audit.ts\` (team plan, admin role, an org), which names the condition that failed. \`bellman_audit\` and the room routes' \`isOrgAdmin\` ask it too, so the three conditions cannot drift apart.`
  4. At the end of D2, add: `A delete names its asker by user id, label and org: \`schedulePurge\` takes the asker, not only an id. An admin's grant intent carries the admin's label and org.`
  5. Change `**Status:** design agreed 2026-10-09; this document is in review.` to `**Status:** design agreed 2026-10-09; implemented on the audit-trail branches, bellman first.`

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/auth.ts tests/auth.test.ts README.md docs/ARCHITECTURE.md docs/superpowers/specs/2026-10-09-audit-trail-design.md
git commit -m "Say the audit window on /account, and the audit trail in the README, the architecture and the spec"
```

### Task 9: Verify, and open the bellman PR

- [ ] **Step 1: Run the whole gate**

Run: `npm run verify`
Expected: every stage passes: UI types, types, worker types, build, `npm test` and `npm run test:worker`.

- [ ] **Step 2: Read the diff once, whole**

Run: `git diff origin/main --stat && git diff origin/main -- src`
Check three things:
- No `"u_jesse"` is passed as an asker.
- No SQL string is built with a value spliced into it.
- `package-lock.json` is not in the diff.

- [ ] **Step 3: Push and open the PR** with the `pr` skill. Push with `git push -u origin mcfearsome/audit-trail`.
  - Title: `The audit trail: every org in a room records its crossings, and an admin reads and exports them over HTTP`
  - The body covers:
    - D1 (the roster fan-out)
    - D5 (the SQL move and its one-transaction migration)
    - D6 to D8 (the query and the two routes)
    - D9 (the retention entitlement)
    - links to bellman-sh/dash#11, #49 and #58
  - The body must say: **merge and deploy this before the dash PR**. Until `/audit` is served, the panel's fetch of it fails as a network error (spec D12).

---

## Part 2: dash

Work in `/Users/mcfearsome/orca/workspaces/dash/audit-trail-cross-org-crossings-filters-export`. The wire types mirror the Worker's by hand, as `src/lib/api.ts` does for every route; each one names what it mirrors.

### Task 10: The client (D7, D8)

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts`

**Interfaces:**
- Produces:
  - `interface AuditEntry`, `interface AuditFacets`, `interface AuditRead`, `interface AuditFilter`
  - `getAudit(filter: AuditFilter, page?: { before?: number; through?: number }): Promise<AuditRead>`
  - `exportAudit(filter: AuditFilter, format: "csv" | "json", through: number | null): Promise<{ blob: Blob; filename: string }>`
  - `AccountInfo.entitlements.auditRetentionMs?: number | null`

- [ ] **Step 1: Write the failing tests** — in `src/lib/api.test.ts`:
  1. Add `exportAudit` and `getAudit` to the `@/lib/api` import.
  2. Add:

```ts
describe("the audit client", () => {
  it("asks for the log with the filters and the page, leaving out what is empty", async () => {
    next = answer(200, { org_id: "org_1", entries: [], next: null, through: null, total: 0, unrecorded: 0 });
    await getAudit({ actor: "u_ana", scope: "cross_org", room: "" }, { before: 5, through: 9 });
    expect(calls[0].url).toBe(`${API_ORIGIN}/audit?actor=u_ana&scope=cross_org&before=5&through=9`);
    expect(calls[0].init.credentials).toBe("include");
    await getAudit({});
    expect(calls[1].url).toBe(`${API_ORIGIN}/audit`);
  });

  it("exports with the same filters, the format and the page's through, and hands back the file under the server's name", async () => {
    next = new Response("seq,at\r\n", {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": "attachment; filename*=UTF-8''bellman-audit-org_1-9.csv" },
    });
    const file = await exportAudit({ actor: "u_ana" }, "csv", 9);
    expect(calls[0].url).toBe(`${API_ORIGIN}/audit/export?actor=u_ana&format=csv&through=9`);
    expect(calls[0].init.credentials).toBe("include");
    expect(file.filename).toBe("bellman-audit-org_1-9.csv");
    expect(await file.blob.text()).toBe("seq,at\r\n");
  });

  it("refuses an export in the server's words", async () => {
    next = answer(403, { error: "forbidden", error_description: "the audit log requires the admin role." });
    await expect(exportAudit({}, "json", null)).rejects.toMatchObject({ status: 403, message: "the audit log requires the admin role." });
  });

  it("rejects an export whose body broke partway, so nothing short is handed back", async () => {
    const broken = new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("seq\r\n"));
        c.error(new Error("cut"));
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => broken));
    await expect(exportAudit({}, "csv", 3)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/api.test.ts`
Expected: FAIL, because `getAudit` is not exported.

- [ ] **Step 3: Write the client** — in `src/lib/api.ts`:
  1. Replace `request` with this version, which shares its refusal with the export:

```ts
/** The server's refusal as an ApiError: its words, or the status when it gave none. */
async function refusal(res: Response): Promise<ApiError> {
  const e = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  return new ApiError(res.status, e.error ?? "error", e.error_description || res.statusText || `HTTP ${res.status}`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Answer<T>> {
  const res = await fetch(`${API_ORIGIN}${path}`, { ...init, credentials: "include" });
  if (res.status === 204 || res.status === 304) return { status: res.status, body: undefined as T, headers: res.headers };
  if (!res.ok) throw await refusal(res);
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: body as T, headers: res.headers };
}
```

  2. In `AccountInfo.entitlements`, add after `audit: boolean;`:

```ts
    /** How long the org's audit rows are kept: null is with no expiry. Absent from a Worker that predates it. */
    auditRetentionMs?: number | null;
```

  3. Append:

```ts
/** Mirrors `AuditEntryView` in the Worker's src/http/audit.ts: one row of an org's audit stream. */
export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  /** Null on a row about a plan, not a room. */
  room: { id: string; name: string | null } | null;
  /** `label` and `org_id` are absent on a row from before the Worker recorded them: not recorded, which is not no org. */
  actor: { id: string; label?: string | null; org_id?: string | null };
  /** Null on a row from before the Worker recorded crossings; a null inside is a person with no org. */
  parties: (string | null)[] | null;
  crossing: "internal" | "cross_org" | null;
  direction: "outbound" | "inbound" | null;
  detail: Record<string, unknown>;
}

/** Mirrors `AuditFacets` in the Worker's src/audit.ts: what each filter can take, newest first. */
export interface AuditFacets {
  actors: { id: string; label: string | null }[];
  rooms: { id: string; name: string | null }[];
  orgs: string[];
  actions: string[];
}

/** Mirrors `GET /audit`. `facets` comes with the first page only. */
export interface AuditRead {
  org_id: string;
  entries: AuditEntry[];
  next: number | null;
  through: number | null;
  total: number;
  unrecorded: number;
  facets?: AuditFacets;
}

/** The filters as the Worker takes them: instants as ISO strings, ids as given. */
export interface AuditFilter {
  from?: string;
  to?: string;
  actor?: string;
  room?: string;
  org?: string;
  action?: string;
  scope?: "internal" | "cross_org";
}

const auditQuery = (filter: AuditFilter, extra: Record<string, string | number | undefined> = {}): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...filter, ...extra })) {
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

/** A page of the org's audit stream under the filters: the first without `before`, then the next under the first's `through`. */
export const getAudit = (filter: AuditFilter, page: { before?: number; through?: number } = {}): Promise<AuditRead> =>
  request<AuditRead>(`/audit${auditQuery(filter, page)}`).then((r) => r.body);

/** The name in `filename*=UTF-8''…`, the form the Worker's `attachmentDisposition` writes. */
function filenameOf(disposition: string | null): string | null {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * `GET /audit/export` as a file. The body is read whole before anything is handed back, so a
 * stream the Worker broke partway rejects here and is never saved as a short file.
 */
export async function exportAudit(
  filter: AuditFilter, format: "csv" | "json", through: number | null,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_ORIGIN}/audit/export${auditQuery(filter, { format, through: through ?? undefined })}`, {
    credentials: "include",
  });
  if (!res.ok) throw await refusal(res);
  const blob = await res.blob();
  return { blob, filename: filenameOf(res.headers.get("content-disposition")) ?? `bellman-audit.${format}` };
}
```

- [ ] **Step 4: Run them, and the suite**

Run: `npx vitest run src/lib/api.test.ts && npm run typecheck`
Expected: PASS. The existing `never throws a refusal with no words` case still passes through `refusal`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "Read the audit trail from the Worker: a page under filters, and the export as a whole file"
```

### Task 11: The page's rules, and one copy of the upgrade links (D10, D11)

**Files:**
- Create: `src/lib/audit.ts`, `src/lib/audit.test.ts`
- Modify: `src/lib/account.ts` (`PRICING_URL`, `UPGRADES`, `teamUpgrade`), `src/routes/billing.tsx` (imports them)

**Interfaces:**
- Consumes: `AccountInfo`, `AuditEntry`, `AuditFilter` (Task 10).
- Produces:
  - `interface AuditSearch { from?: string; to?: string; actor?: string; room?: string; org?: string; action?: string; scope?: "internal" | "cross_org" }`
  - `validateAuditSearch(search: Record<string, unknown>): AuditSearch`
  - `filterOf(search: AuditSearch): AuditFilter`
  - `retentionText(ms: number | null | undefined): string | null`
  - `directionText(e: AuditEntry): string`
  - `orgText(org: string | null | undefined, own: string): string`
  - `partiesText(parties: (string | null)[]): string`
  - `countText(n: number): string`
  - `unrecordedText(n: number): string`
  - `type AuditGate = "open" | "upgrade" | "not_admin" | "no_org"`
  - `gateOf(account: Pick<AccountInfo, "entitlements" | "role" | "org_id">): AuditGate`
  - In `src/lib/account.ts`: `PRICING_URL`, `UPGRADES`, and `teamUpgrade(plan: string): { label: string; link: string }`

- [ ] **Step 1: Write the failing tests** — create `src/lib/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { teamUpgrade } from "@/lib/account";
import {
  countText, directionText, filterOf, gateOf, orgText, partiesText, retentionText, unrecordedText, validateAuditSearch,
} from "@/lib/audit";
import { account, auditEntry } from "@/test-fixtures";

describe("the audit page's search", () => {
  it("keeps the filters it knows, in their forms, and drops the rest", () => {
    expect(validateAuditSearch({
      from: "2026-10-01", to: "2026-02-31", actor: "u_ana", room: "x".repeat(201), org: 7, scope: "both", extra: "y",
    })).toEqual({ from: "2026-10-01", actor: "u_ana" });
    expect(validateAuditSearch({ scope: "cross_org", action: "sent_message" })).toEqual({ scope: "cross_org", action: "sent_message" });
  });

  it("asks the Worker from the start of 'from' to the start of the day after 'to', in the viewer's time", () => {
    expect(filterOf({ from: "2026-10-01", to: "2026-10-09", actor: "u_ana" })).toEqual({
      actor: "u_ana", from: new Date(2026, 9, 1).toISOString(), to: new Date(2026, 9, 10).toISOString(),
    });
    expect(filterOf({})).toEqual({});
  });
});

describe("the audit page's words", () => {
  it("states the retention the Worker sends, and nothing when it sends none", () => {
    expect([retentionText(null), retentionText(90 * 86_400_000), retentionText(undefined)]).toEqual([
      "Kept with no expiry.", "Kept for 90 days.", null,
    ]);
  });

  it("says a row's direction, and that a row from before crossings were recorded recorded none", () => {
    expect(directionText(auditEntry({ crossing: "cross_org", direction: "outbound" }))).toBe("→ out");
    expect(directionText(auditEntry({ crossing: "cross_org", direction: "inbound" }))).toBe("← in");
    expect(directionText(auditEntry({ crossing: "cross_org", direction: null }))).toBe("cross-org");
    expect(directionText(auditEntry({ crossing: "internal" }))).toBe("internal");
    expect(directionText(auditEntry({ crossing: null, parties: null, direction: null }))).toBe("not recorded");
  });

  it("marks the reader's own org, names no org, and says nothing of a row that never recorded one", () => {
    expect([orgText("org_1", "org_1"), orgText("org_2", "org_1"), orgText(null, "org_1"), orgText(undefined, "org_1")])
      .toEqual(["org_1 (you)", "org_2", "no org", "—"]);
    expect(partiesText(["org_1", "org_2", null])).toBe("org_1 ⇄ org_2 ⇄ no org");
  });

  it("counts entries in words", () => {
    expect([countText(1), countText(2)]).toEqual(["1 entry", "2 entries"]);
    expect(unrecordedText(1)).toBe("1 earlier entry does not record whether it crossed, and is left out by this filter.");
    expect(unrecordedText(4)).toBe("4 earlier entries do not record whether they crossed, and are left out by this filter.");
  });
});

describe("the gate", () => {
  const audited = { ...account().entitlements, audit: true };

  it("asks the Worker's three questions in its order: the plan, the role, the org", () => {
    expect(gateOf(account())).toBe("upgrade");
    expect(gateOf(account({ entitlements: audited, role: "member", org_id: null }))).toBe("not_admin");
    expect(gateOf(account({ entitlements: audited, role: "admin", org_id: null }))).toBe("no_org");
    expect(gateOf(account({ entitlements: audited, role: "admin", org_id: "org_1" }))).toBe("open");
  });

  it("offers Team in Billing's words for the plan", () => {
    expect(teamUpgrade("free")).toEqual({ label: "Start a Team", link: "team_seat_monthly" });
    expect(teamUpgrade("pro")).toEqual({ label: "Move to Team", link: "team_seat_monthly" });
    expect(teamUpgrade("max")).toEqual({ label: "Start a Team", link: "team_seat_monthly" });
  });
});
```

  In `src/test-fixtures.ts`:
  1. Add `AuditEntry` and `AuditRead` to the type import from `@/lib/api`.
  2. Append:

```ts
/** One row of `GET /audit`: an internal send by Ana in org_1's room. Override it to make it cross. */
export const auditEntry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  seq: 1,
  at: "2026-10-09T14:02:11.000Z",
  action: "sent_message",
  room: { id: "qs_1", name: "q3-plan" },
  actor: { id: "u_ana", label: "Ana", org_id: "org_1" },
  parties: ["org_1"],
  crossing: "internal",
  direction: null,
  detail: { chars: 5 },
  ...over,
});

/** `GET /audit`'s first page: empty, with nothing to filter by. Override the rows, the counts or the facets. */
export const auditRead = (over: Partial<AuditRead> = {}): AuditRead => ({
  org_id: "org_1",
  entries: [],
  next: null,
  through: null,
  total: 0,
  unrecorded: 0,
  facets: { actors: [], rooms: [], orgs: [], actions: [] },
  ...over,
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/audit.test.ts`
Expected: FAIL, because `@/lib/audit` cannot be resolved.

- [ ] **Step 3: Move the upgrade links into `src/lib/account.ts`.** Billing and the Audit page then read one copy. Append:

```ts
/** The site's plan comparison, linked from Billing and from the Audit page's way to Team. */
export const PRICING_URL = "https://bellman.sh/pricing";

/** The Payment Link names the Worker serves at /upgrade/<name>; the site's pricing page uses the same ones. */
export const UPGRADES: Record<string, { label: string; link: string }[]> = {
  free: [
    { label: "Upgrade to Pro", link: "pro_monthly" },
    { label: "Pro, paid yearly", link: "pro_annual" },
    { label: "Start a Team", link: "team_seat_monthly" },
  ],
  pro: [{ label: "Move to Team", link: "team_seat_monthly" }],
};

/** The way to Team from `plan`, in Billing's words for it: what the Audit page offers a plan without the audit trail. */
export function teamUpgrade(plan: string): { label: string; link: string } {
  return UPGRADES[plan]?.find((u) => u.link === "team_seat_monthly") ?? { label: "Start a Team", link: "team_seat_monthly" };
}
```

  In `src/routes/billing.tsx`:
  1. Delete its `PRICING_URL` constant and its `UPGRADES` constant, with their comments.
  2. Change the account import to `import { PRICING_URL, UPGRADES, sourceText } from "@/lib/account"`.

- [ ] **Step 4: Write the rules** — create `src/lib/audit.ts`:

```ts
/**
 * The Audit page's rules (audit trail spec, D10 and D11): the filters the URL holds and how
 * the Worker is asked for them, the gate, and the page's words for what a row says.
 */
import type { AccountInfo, AuditEntry, AuditFilter } from "@/lib/api";

/** What the URL holds, so a filtered view is a link and Back undoes a filter. Days are the date input's YYYY-MM-DD. */
export interface AuditSearch {
  from?: string;
  to?: string;
  actor?: string;
  room?: string;
  org?: string;
  action?: string;
  scope?: "internal" | "cross_org";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const IDS = ["actor", "room", "org", "action"] as const;
const SCOPES: readonly string[] = ["internal", "cross_org"];

/** Midnight beginning `day`, plus `days`, in the viewer's zone; null for a day that is not one, such as 2026-02-31. */
function dayStart(day: string, days = 0): Date | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return new Date(y, mo, d + days);
}

/** The route's `validateSearch`: a filter in its form is kept, and anything else is dropped, never guessed at. */
export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const out: AuditSearch = {};
  for (const name of IDS) {
    const v = search[name];
    if (typeof v === "string" && v.length >= 1 && v.length <= 200) out[name] = v;
  }
  for (const name of ["from", "to"] as const) {
    const v = search[name];
    if (typeof v === "string" && dayStart(v)) out[name] = v;
  }
  if (typeof search.scope === "string" && SCOPES.includes(search.scope)) out.scope = search.scope as AuditSearch["scope"];
  return out;
}

/** The search as the Worker's filter: from the start of `from` to the start of the day after `to`, so the `to` day counts in full. */
export function filterOf(search: AuditSearch): AuditFilter {
  const { from, to, ...rest } = search;
  const start = from ? dayStart(from) : null;
  const end = to ? dayStart(to, 1) : null;
  return { ...rest, ...(start ? { from: start.toISOString() } : {}), ...(end ? { to: end.toISOString() } : {}) };
}

/** The retention the Worker states (D9): null is no expiry; absent, from a Worker that predates it, says nothing. */
export function retentionText(ms: number | null | undefined): string | null {
  if (ms === undefined) return null;
  if (ms === null) return "Kept with no expiry.";
  return `Kept for ${Math.round(ms / 86_400_000)} days.`;
}

/** A row's direction from the reader's side (D3). A cross-org row the system wrote has none. */
export function directionText(e: AuditEntry): string {
  if (e.crossing === null) return "not recorded";
  if (e.crossing === "internal") return "internal";
  if (e.direction === "outbound") return "→ out";
  if (e.direction === "inbound") return "← in";
  return "cross-org";
}

/** The actor's org: the reader's own marked, none said, and a row that never recorded one says nothing. */
export function orgText(org: string | null | undefined, own: string): string {
  if (org === undefined) return "—";
  if (org === null) return "no org";
  return org === own ? `${org} (you)` : org;
}

export const partiesText = (parties: (string | null)[]): string => parties.map((p) => p ?? "no org").join(" ⇄ ");

export const countText = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "entry" : "entries"}`;

export const unrecordedText = (n: number): string =>
  n === 1
    ? "1 earlier entry does not record whether it crossed, and is left out by this filter."
    : `${n.toLocaleString()} earlier entries do not record whether they crossed, and are left out by this filter.`;

export type AuditGate = "open" | "upgrade" | "not_admin" | "no_org";

/**
 * Which page an account is shown (D11), on the Worker's three conditions in its order: the
 * plan, the role, the org. The entitlement and not the plan's name, so a plan that gains audit
 * is admitted without a panel change. A courtesy: the Worker refuses on its own.
 */
export function gateOf(account: Pick<AccountInfo, "entitlements" | "role" | "org_id">): AuditGate {
  if (!account.entitlements.audit) return "upgrade";
  if (account.role !== "admin") return "not_admin";
  if (!account.org_id) return "no_org";
  return "open";
}
```

- [ ] **Step 5: Run them, and the suite**

Run: `npx vitest run src/lib/audit.test.ts && npm test && npm run typecheck && npm run lint`
Expected: PASS. The billing cases in `src/router.test.tsx` still pass with the moved links.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audit.ts src/lib/audit.test.ts src/lib/account.ts src/routes/billing.tsx src/test-fixtures.ts
git commit -m "The audit page's rules: the URL's filters as the Worker's, the gate, and its words"
```

### Task 12: The page: the gate, the filters, the log and older pages (D10, D11)

**Files:**
- Modify: `src/router.tsx` (export `auditRoute`, with `validateSearch`, `loaderDeps` and `loader`), `src/lib/audit.ts` (`AuditLoad`, `loadAudit`)
- Modify: `src/routes/audit.tsx` (replaces the placeholder)
- Create: `src/components/audit/filters.tsx`, `src/components/audit/table.tsx`
- Test: `src/router.test.tsx`

**Interfaces:**
- Consumes:
  - Tasks 10 and 11
  - `orSignIn` and `signInFor` (`src/lib/session.ts`)
  - `Page` (`src/components/layout/app-shell.tsx`)
  - `Button` and `buttonVariants` (`src/components/ui/button.tsx`)
- Produces:
  - `type AuditLoad = { account: AccountInfo; gate: "open"; read: AuditRead } | { account: AccountInfo; gate: Exclude<AuditGate, "open">; read: null }`
  - `loadAudit(search: AuditSearch): Promise<AuditLoad>`
  - `auditRoute`
  - `AuditFilters({ search, facets })`
  - `AuditTable({ entries, orgId })`

- [ ] **Step 1: Teach the stub Worker the audit routes** — in `src/router.test.tsx`:
  1. Add `import type { AuditRead } from "@/lib/api";`.
  2. Add `auditEntry` and `auditRead as auditPage` to the `@/test-fixtures` import.
  3. Beside the other stub state, add:

```ts
/** What `GET /audit` answers: the first page, and the page past `before`. */
let auditFirst: AuditRead;
let auditOlder: AuditRead;
/** How `GET /audit/export` answers: the file, a failure, or a lapsed session. */
let exportMode: "ok" | "500" | "401";
```

  4. In `beforeEach`, set `auditFirst = auditPage(); auditOlder = auditPage(); exportMode = "ok";`.
  5. In `answer`, before `return Response.json(identity);`, add:

```ts
  const route = path.split("?")[0];
  if (route === "/audit") return Response.json(new URL(url).searchParams.has("before") ? auditOlder : auditFirst);
  if (route === "/audit/export") {
    if (exportMode !== "ok") {
      return Response.json(
        { error: exportMode === "401" ? "not_signed_in" : "internal", error_description: "the request failed on the server" },
        { status: Number(exportMode) },
      );
    }
    return new Response("seq,at\r\n3,2026-10-09T14:02:11.000Z\r\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename*=UTF-8''bellman-audit-org_1-3.csv" },
    });
  }
```

- [ ] **Step 2: Write the failing page tests** — append to `src/router.test.tsx`:

```ts
describe("the audit page, from the route", () => {
  const teamAdmin = () => account({
    plan: "team", role: "admin", org_id: "org_1", plan_source: "grant",
    entitlements: { ...account().entitlements, orgScoping: true, audit: true, auditRetentionMs: null },
  });
  const audited = { ...account().entitlements, audit: true };
  const auditUrls = () => calls.filter((c) => c.url.startsWith(`${API}/audit`)).map((c) => new URL(c.url));
  const crossOut = auditEntry({
    seq: 3, parties: ["org_1", "org_2"], crossing: "cross_org", direction: "outbound",
  });
  const internalRow = auditEntry({ seq: 2, action: "invite_issued", room: { id: "qs_2", name: "standup" } });

  it("explains the audit trail to a free plan and offers Team, without asking for the log", async () => {
    await boot("/audit");
    expect(await screen.findByRole("heading", { name: "The audit trail is part of the Team plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a Team" })).toHaveAttribute("href", `${API}/upgrade/team_seat_monthly`);
    expect(screen.getByRole("link", { name: "Compare plans" })).toHaveAttribute("href", "https://bellman.sh/pricing");
    expect(auditUrls()).toEqual([]);
  });

  it("offers no purchase when the operator set the plan", async () => {
    accountInfo = account({ plan: "pro", plan_source: "operator" });
    await boot("/audit");
    await screen.findByRole("heading", { name: "The audit trail is part of the Team plan" });
    expect(screen.queryByRole("link", { name: "Move to Team" })).toBeNull();
    expect(screen.getByText(/set by the operator, so a purchase would not change it/)).toBeInTheDocument();
  });

  it("tells a team member who is not an admin to ask one, without asking for the log", async () => {
    accountInfo = account({ plan: "team", role: "member", org_id: "org_1", entitlements: audited });
    await boot("/audit");
    expect(await screen.findByText("Only an org admin can read the audit trail. Ask one.")).toBeInTheDocument();
    expect(auditUrls()).toEqual([]);
  });

  it("tells an admin with no org why there is nothing to read", async () => {
    accountInfo = account({ plan: "team", role: "admin", org_id: null, entitlements: audited });
    await boot("/audit");
    expect(await screen.findByText("Your account has no org, so there is no audit stream to read.")).toBeInTheDocument();
    expect(auditUrls()).toEqual([]);
  });

  it("reads the log for an org admin with the cookie, says how long it is kept, and marks a cross-org row", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut, internalRow], through: 3, total: 2 });
    await boot("/audit");
    const cross = (await screen.findByText("→ out")).closest("tr")!;
    expect(cross).toHaveAttribute("data-crossing", "cross_org");
    expect(within(cross).getByText("org_1 ⇄ org_2")).toBeInTheDocument();
    expect(within(cross).getByText("org_1 (you)")).toBeInTheDocument();
    expect(screen.getByText("internal").closest("tr")).toHaveAttribute("data-crossing", "internal");
    expect(screen.getByText("Kept with no expiry.")).toBeInTheDocument();
    expect(screen.getByText("2 entries")).toBeInTheDocument();
    expect(calls).toContainEqual({ url: `${API}/audit`, method: "GET", credentials: "include" });
  });

  it("writes a filter to the URL and reads the log under it", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], total: 1, facets: { actors: [{ id: "u_ana", label: "Ana" }], rooms: [], orgs: ["org_2"], actions: ["sent_message"] } });
    await boot("/audit");
    fireEvent.change(await screen.findByRole("combobox", { name: "Member" }), { target: { value: "u_ana" } });
    await waitFor(() => expect(window.location.search).toBe("?actor=u_ana"));
    await waitFor(() => expect(auditUrls().at(-1)!.searchParams.get("actor")).toBe("u_ana"));
  });

  it("asks for the 'to' day in full: from the start of 'from' to the start of the day after 'to'", async () => {
    accountInfo = teamAdmin();
    await boot("/audit?from=2026-10-01&to=2026-10-09");
    await screen.findByText("No entries match these filters.");
    const asked = auditUrls()[0]!;
    expect(asked.searchParams.get("from")).toBe(new Date(2026, 9, 1).toISOString());
    expect(asked.searchParams.get("to")).toBe(new Date(2026, 9, 10).toISOString());
  });

  it("loads older entries under the first page's through, and stops when there are none", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], next: 3, through: 3, total: 2 });
    auditOlder = auditPage({ entries: [auditEntry({ seq: 1, action: "session_created" })], through: 3, total: 2, facets: undefined });
    await boot("/audit");
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("session_created")).toBeInTheDocument();
    const older = auditUrls().at(-1)!;
    expect([older.searchParams.get("before"), older.searchParams.get("through")]).toEqual(["3", "3"]);
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("says how many earlier entries a scope filter left out", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ unrecorded: 4 });
    await boot("/audit?scope=cross_org");
    expect(await screen.findByText("4 earlier entries do not record whether they crossed, and are left out by this filter.")).toBeInTheDocument();
  });

  it("says no crossings are recorded yet on an empty log with no filter", async () => {
    accountInfo = teamAdmin();
    await boot("/audit");
    expect(await screen.findByText("No crossings recorded yet. Rooms your org's people create or join will show here.")).toBeInTheDocument();
  });

  // Review Focus 5.
  it("draws a name and a room as text, whatever they say", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({
      entries: [auditEntry({ actor: { id: "u_x", label: "<img src=x onerror=alert(1)>", org_id: "org_2" }, room: { id: "qs_1", name: "<b>bold</b>" } })],
      total: 1,
    });
    await boot("/audit");
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  // Review Focus 4, for Load older.
  it("sends a lapsed session to sign-in from Load older", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], next: 3, through: 3, total: 2 });
    await boot("/audit");
    const older = await screen.findByRole("button", { name: "Load older" });
    mode = "401";
    fireEvent.click(older);
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/router.test.tsx -t "the audit page"`
Expected: FAIL, because the page is still the placeholder `Nothing here until #11.`.

- [ ] **Step 4: Write the loader** — append to `src/lib/audit.ts`:
  1. Change its import to `import { getAccount, getAudit, type AccountInfo, type AuditEntry, type AuditFilter, type AuditRead } from "@/lib/api";`.
  2. Append:

```ts
/** What the route loads: the account, and the log only when the gate is open, so a closed one never fetches a 403. */
export type AuditLoad =
  | { account: AccountInfo; gate: "open"; read: AuditRead }
  | { account: AccountInfo; gate: Exclude<AuditGate, "open">; read: null };

export async function loadAudit(search: AuditSearch): Promise<AuditLoad> {
  const account = await getAccount();
  const gate = gateOf(account);
  return gate === "open" ? { account, gate, read: await getAudit(filterOf(search)) } : { account, gate, read: null };
}
```

- [ ] **Step 5: Route it** — in `src/router.tsx`:
  1. Add `import { loadAudit, validateAuditSearch } from "@/lib/audit";`.
  2. Replace `const auditRoute = ...` with:

```ts
export const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/audit",
  component: Audit,
  // The filters live in the URL (spec D10): a filtered view is a link, and a new filter is a new read.
  validateSearch: validateAuditSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, location }) => orSignIn(location.href, () => loadAudit(deps)),
})
```

- [ ] **Step 6: Write the table** — create `src/components/audit/table.tsx`:

```tsx
import { cn } from "cn"
import type { AuditEntry } from "@/lib/api"
import { directionText, orgText, partiesText } from "@/lib/audit"

/** The log (spec D10): newest first, a cross-org row marked by a brass rule and its parties, so it reads as one at a glance. */
export function AuditTable({ entries, orgId }: { entries: AuditEntry[]; orgId: string }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="mono-caps text-muted-foreground">
          <th className="py-2 pl-3 font-normal">Time</th>
          <th className="py-2 font-normal">Event</th>
          <th className="py-2 font-normal">Room</th>
          <th className="py-2 font-normal">Member</th>
          <th className="py-2 font-normal">Org</th>
          <th className="py-2 font-normal">Direction</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => <Row key={entry.seq} entry={entry} orgId={orgId} />)}
      </tbody>
    </table>
  )
}

function Row({ entry, orgId }: { entry: AuditEntry; orgId: string }) {
  const cross = entry.crossing === "cross_org"
  return (
    <tr className="border-t border-border align-top" data-crossing={entry.crossing ?? "unrecorded"}>
      <td className={cn("border-l-2 py-2 pl-3", cross ? "border-l-brass" : "border-l-transparent")}>
        <time dateTime={entry.at} title={entry.at}>{new Date(entry.at).toLocaleString()}</time>
      </td>
      <td className="py-2 font-mono text-xs">{entry.action}</td>
      <td className="py-2">{entry.room ? (entry.room.name ?? entry.room.id) : "—"}</td>
      <td className="py-2">{entry.actor.label ?? entry.actor.id}</td>
      <td className="py-2">{orgText(entry.actor.org_id, orgId)}</td>
      <td className="py-2">
        {directionText(entry)}
        {cross && entry.parties ? (
          <span className="mono-caps ml-2 rounded-sm bg-brass/14 px-1.5 py-0.5 text-brass-deep">{partiesText(entry.parties)}</span>
        ) : null}
      </td>
    </tr>
  )
}
```

- [ ] **Step 7: Write the filters** — create `src/components/audit/filters.tsx`:

```tsx
import type { ReactNode } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import type { AuditFacets } from "@/lib/api"
import type { AuditSearch } from "@/lib/audit"

const SCOPES = [
  { value: undefined, label: "All" },
  { value: "internal", label: "Internal" },
  { value: "cross_org", label: "Cross-org" },
] as const

const FIELD = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"

/** The filter bar (spec D10). Every control writes the URL, so a filtered view is a link and Back undoes a filter. */
export function AuditFilters({ search, facets }: { search: AuditSearch; facets: AuditFacets }) {
  const navigate = useNavigate()
  const set = (patch: Partial<AuditSearch>) => {
    const next: AuditSearch = { ...search, ...patch }
    for (const name of Object.keys(next) as (keyof AuditSearch)[]) if (!next[name]) delete next[name]
    void navigate({ to: "/audit", search: next })
  }
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field label="From">
        <input type="date" aria-label="From" className={FIELD} value={search.from ?? ""} max={search.to} onChange={(e) => set({ from: e.target.value })} />
      </Field>
      <Field label="To">
        <input type="date" aria-label="To" className={FIELD} value={search.to ?? ""} min={search.from} onChange={(e) => set({ to: e.target.value })} />
      </Field>
      <Choice label="Member" value={search.actor} options={facets.actors.map((a) => ({ value: a.id, label: a.label ?? a.id }))} onChange={(actor) => set({ actor })} />
      <Choice label="Room" value={search.room} options={facets.rooms.map((r) => ({ value: r.id, label: r.name ?? r.id }))} onChange={(room) => set({ room })} />
      <Choice label="Org" value={search.org} options={facets.orgs.map((o) => ({ value: o, label: o }))} onChange={(org) => set({ org })} />
      <Choice label="Event" value={search.action} options={facets.actions.map((a) => ({ value: a, label: a }))} onChange={(action) => set({ action })} />
      <div role="group" aria-label="Scope" className="flex w-fit gap-0.5 rounded-lg bg-muted p-[3px]">
        {SCOPES.map((s) => (
          <Link
            key={s.label}
            to="/audit"
            search={{ ...search, scope: s.value }}
            className={cn(
              "mono-caps rounded-md px-3 py-1.5 transition-colors",
              search.scope === s.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.label}
          </Link>
        ))}
      </div>
      {Object.keys(search).length > 0 ? (
        <Link to="/audit" search={{}} className="pb-1.5 text-sm text-brass-deep underline-offset-4 hover:underline">
          Clear filters
        </Link>
      ) : null}
    </div>
  )
}

function Choice({ label, value, options, onChange }: {
  label: string
  value: string | undefined
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  // A value the URL names that the facets do not offer (past their 200, or a link from elsewhere) stays selected.
  const all = value && !options.some((o) => o.value === value) ? [{ value, label: value }, ...options] : options
  return (
    <Field label={label}>
      <select aria-label={label} className={FIELD} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono-caps text-muted-foreground" aria-hidden="true">{label}</span>
      {children}
    </div>
  )
}
```

- [ ] **Step 8: Write the page** — replace `src/routes/audit.tsx` with:

```tsx
import { useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { AuditFilters } from "@/components/audit/filters"
import { AuditTable } from "@/components/audit/table"
import { Page } from "@/components/layout/app-shell"
import { Button, buttonVariants } from "@/components/ui/button"
import { PRICING_URL, teamUpgrade } from "@/lib/account"
import { ApiError, getAudit, upgradeUrl, type AccountInfo, type AuditEntry, type AuditRead } from "@/lib/api"
import { countText, filterOf, retentionText, unrecordedText, type AuditGate, type AuditSearch } from "@/lib/audit"
import { signInFor } from "@/lib/session"
import { auditRoute } from "@/router"

const NO_FACETS = { actors: [], rooms: [], orgs: [], actions: [] }

/** The audit trail (dash#11): an org admin's read of every crossing that touched the org's boundary. */
export function Audit() {
  const data = auditRoute.useLoaderData()
  const search = auditRoute.useSearch()
  const retention = retentionText(data.account.entitlements.auditRetentionMs)
  return (
    <Page title="Audit" description="Every crossing that touched your org's boundary.">
      {retention ? <p className="-mt-4 mb-5 text-xs text-muted-foreground">{retention}</p> : null}
      {data.gate === "open" ? (
        // Keyed by the filters: a new filter is a new read, and the pages loaded under the last one go with it.
        <Log key={JSON.stringify(search)} read={data.read} search={search} />
      ) : (
        <Gate gate={data.gate} account={data.account} />
      )}
    </Page>
  )
}

/** Why there is no log here, and the way to one where there is a way (spec D11). Never a 403 screen. */
function Gate({ gate, account }: { gate: Exclude<AuditGate, "open">; account: AccountInfo }) {
  if (gate === "not_admin") return <Notice>Only an org admin can read the audit trail. Ask one.</Notice>
  if (gate === "no_org") return <Notice>Your account has no org, so there is no audit stream to read.</Notice>
  const team = teamUpgrade(account.plan)
  // An operator-set plan outranks any purchase, so offering one would sell nothing (as Billing says).
  const operator = account.plan_source === "operator"
  return (
    <section className="rounded-xl border border-border p-5">
      <h2 className="font-heading text-lg font-extrabold tracking-tight">The audit trail is part of the Team plan</h2>
      <p className="mt-2 text-sm">
        Every crossing that touched your org's boundary, from both sides of a room shared with another org: who acted, in
        which room, and which way it crossed. Filter it by date, member, room, org and event, and export what you see as CSV
        or JSON.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {operator ? null : <a href={upgradeUrl(team.link)} className={buttonVariants()}>{team.label}</a>}
        <a href={PRICING_URL} className={buttonVariants({ variant: "ghost" })}>Compare plans</a>
      </div>
      {operator ? (
        <p className="mt-3 text-xs text-muted-foreground">Your plan is set by the operator, so a purchase would not change it.</p>
      ) : null}
    </section>
  )
}

function Log({ read, search }: { read: AuditRead; search: AuditSearch }) {
  const navigate = useNavigate()
  const href = useLocation().href
  const [older, setOlder] = useState<AuditEntry[]>([])
  const [next, setNext] = useState(read.next)
  const [busy, setBusy] = useState<"older" | "csv" | "json" | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const entries = [...read.entries, ...older]

  /** One of the page's own reads. A lapsed session goes to sign-in, as every read in the panel does; anything else is said here. */
  const run = async (what: "older" | "csv" | "json", failure: string, work: () => Promise<void>) => {
    setBusy(what)
    setFailed(null)
    try {
      await work()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void navigate(signInFor(href))
        return
      }
      setFailed(`${failure}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const loadOlder = () => run("older", "Could not load older entries", async () => {
    const page = await getAudit(filterOf(search), { before: next ?? undefined, through: read.through ?? undefined })
    setOlder((rows) => [...rows, ...page.entries])
    setNext(page.next)
  })

  return (
    <>
      <AuditFilters search={search} facets={read.facets ?? NO_FACETS} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">{countText(read.total)}</p>
      </div>
      {read.unrecorded > 0 ? <p className="mb-3 text-xs text-muted-foreground">{unrecordedText(read.unrecorded)}</p> : null}
      {failed ? <p role="alert" className="mb-3 text-sm text-destructive">{failed}</p> : null}
      {entries.length === 0 ? (
        <Notice>
          {Object.keys(search).length > 0
            ? "No entries match these filters."
            : "No crossings recorded yet. Rooms your org's people create or join will show here."}
        </Notice>
      ) : (
        <AuditTable entries={entries} orgId={read.org_id} />
      )}
      {next !== null ? (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={busy !== null} onClick={() => void loadOlder()}>
            {busy === "older" ? "Loading…" : "Load older"}
          </Button>
        </div>
      ) : null}
    </>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">{children}</div>
}
```

  `run` takes `"csv"` and `"json"` already; Task 13 adds the export that uses them.

- [ ] **Step 9: Run them, and the suite**

Run: `npx vitest run src/router.test.tsx -t "the audit page"`
Expected: PASS, 12 tests.
Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/router.tsx src/lib/audit.ts src/routes/audit.tsx src/components/audit/filters.tsx src/components/audit/table.tsx src/router.test.tsx
git commit -m "Show an org admin the audit trail: filters in the URL, cross-org rows marked, older pages on demand, and the way to Team for a plan without it"
```

### Task 13: A row's detail and its room, and the export (D8, D10)

**Files:**
- Modify: `src/components/audit/table.tsx` (the row opens to `Detail`; `RoomCheck`)
- Modify: `src/routes/audit.tsx` (`save`, and the export buttons)
- Test: `src/router.test.tsx`

**Interfaces:**
- Consumes: `exportAudit`, `getRoom`, `ApiError` (`src/lib/api.ts`); `signInFor`; `run` in `Log` (Task 12).

- [ ] **Step 1: Write the failing tests** — append inside `describe("the audit page, from the route", ...)` in `src/router.test.tsx`:

```ts
  const openRow = async (entry: ReturnType<typeof auditEntry>) =>
    fireEvent.click(await screen.findByRole("button", { name: new Date(entry.at).toLocaleString() }));

  it("opens a row to its ids and detail, and offers the room when it opens from here", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], through: 3, total: 1 });
    await boot("/audit");
    await openRow(crossOut);
    expect(await screen.findByRole("link", { name: "Open room" })).toHaveAttribute("href", "/rooms/qs_1");
    expect(screen.getByText("detail.chars")).toBeInTheDocument();
    expect(calls).toContainEqual({ url: `${API}/rooms/qs_1`, method: "GET", credentials: "include" });
  });

  it("says a room cannot be opened from here when the Worker answers 404", async () => {
    accountInfo = teamAdmin();
    const gone = auditEntry({ room: { id: "missing", name: "gone" } });
    auditFirst = auditPage({ entries: [gone], total: 1 });
    await boot("/audit");
    await openRow(gone);
    expect(await screen.findByText(
      "This room cannot be opened from here: it has been deleted, or it is still open and you are not in it.",
    )).toBeInTheDocument();
  });

  it("exports the filters and the page's through, and saves the file under the server's name", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], through: 3, total: 1 });
    const created = vi.fn(() => "blob:audit");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: created });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const saved: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ href: this.href, download: this.download });
    });
    await boot("/audit?actor=u_ana");
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toEqual([{ href: "blob:audit", download: "bellman-audit-org_1-3.csv" }]));
    const asked = new URL(calls.find((c) => c.url.startsWith(`${API}/audit/export`))!.url);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ actor: "u_ana", format: "csv", through: "3" });
    expect(created).toHaveBeenCalledOnce();
    expect(screen.getByText("An export holds all 1 entry these filters match, as of when this page loaded.")).toBeInTheDocument();
  });

  it("says an export failed and saves nothing", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], through: 3, total: 1 });
    exportMode = "500";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await boot("/audit");
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export failed; nothing was saved: the request failed on the server");
    expect(click).not.toHaveBeenCalled();
  });

  // Review Focus 4, for the export and the room check.
  it("sends a lapsed session to sign-in from an export", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], through: 3, total: 1 });
    exportMode = "401";
    await boot("/audit");
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
  });

  it("sends a lapsed session to sign-in from a room check", async () => {
    accountInfo = teamAdmin();
    auditFirst = auditPage({ entries: [crossOut], through: 3, total: 1 });
    await boot("/audit");
    const button = await screen.findByRole("button", { name: new Date(crossOut.at).toLocaleString() });
    mode = "401";
    fireEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/router.test.tsx -t "the audit page"`
Expected: the six new cases FAIL. The time is not a button yet, and there are no export buttons.

- [ ] **Step 3: Open a row** — replace `src/components/audit/table.tsx` with:

```tsx
import { Fragment, useEffect, useState } from "react"
import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { buttonVariants } from "@/components/ui/button"
import { ApiError, getRoom, type AuditEntry } from "@/lib/api"
import { directionText, orgText, partiesText } from "@/lib/audit"
import { signInFor } from "@/lib/session"

/** The log (spec D10): newest first, a cross-org row marked by a brass rule and its parties, so it reads as one at a glance. */
export function AuditTable({ entries, orgId }: { entries: AuditEntry[]; orgId: string }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="mono-caps text-muted-foreground">
          <th className="py-2 pl-3 font-normal">Time</th>
          <th className="py-2 font-normal">Event</th>
          <th className="py-2 font-normal">Room</th>
          <th className="py-2 font-normal">Member</th>
          <th className="py-2 font-normal">Org</th>
          <th className="py-2 font-normal">Direction</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => <Row key={entry.seq} entry={entry} orgId={orgId} />)}
      </tbody>
    </table>
  )
}

function Row({ entry, orgId }: { entry: AuditEntry; orgId: string }) {
  const [open, setOpen] = useState(false)
  const cross = entry.crossing === "cross_org"
  return (
    <>
      <tr className="border-t border-border align-top" data-crossing={entry.crossing ?? "unrecorded"}>
        <td className={cn("border-l-2 py-2 pl-3", cross ? "border-l-brass" : "border-l-transparent")}>
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-left underline-offset-4 hover:underline">
            <time dateTime={entry.at} title={entry.at}>{new Date(entry.at).toLocaleString()}</time>
          </button>
        </td>
        <td className="py-2 font-mono text-xs">{entry.action}</td>
        <td className="py-2">{entry.room ? (entry.room.name ?? entry.room.id) : "—"}</td>
        <td className="py-2">{entry.actor.label ?? entry.actor.id}</td>
        <td className="py-2">{orgText(entry.actor.org_id, orgId)}</td>
        <td className="py-2">
          {directionText(entry)}
          {cross && entry.parties ? (
            <span className="mono-caps ml-2 rounded-sm bg-brass/14 px-1.5 py-0.5 text-brass-deep">{partiesText(entry.parties)}</span>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="bg-muted/40">
          <td colSpan={6} className="px-3 py-3"><Detail entry={entry} /></td>
        </tr>
      ) : null}
    </>
  )
}

/** A row's ids and its `detail`, as text and never as markup: a label or a room's name is a member's words. */
function Detail({ entry }: { entry: AuditEntry }) {
  const facts: [string, string][] = [
    ["seq", String(entry.seq)],
    ["at", entry.at],
    ...(entry.room ? [["room", entry.room.id] as [string, string]] : []),
    ["actor", entry.actor.id],
    ["parties", entry.parties ? entry.parties.map((p) => p ?? "no org").join(", ") : "not recorded"],
    ...Object.entries(entry.detail).map(([k, v]): [string, string] => [`detail.${k}`, typeof v === "string" ? v : JSON.stringify(v)]),
  ]
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {facts.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="mono-caps text-muted-foreground">{k}</dt>
            <dd className="font-mono break-all">{v}</dd>
          </Fragment>
        ))}
      </dl>
      {entry.room ? <RoomCheck id={entry.room.id} /> : null}
    </div>
  )
}

type Check = { kind: "checking" } | { kind: "open" } | { kind: "gone" } | { kind: "failed"; message: string }

/**
 * Whether the room opens from here (spec D10). Only `GET /rooms/:id` knows: an admin reads a
 * closed room their org sat in (#65, D4), not an open one, and a deleted room is no room.
 */
function RoomCheck({ id }: { id: string }) {
  const navigate = useNavigate()
  const href = useLocation().href
  const [check, setCheck] = useState<Check>({ kind: "checking" })
  useEffect(() => {
    let live = true
    getRoom(id).then(
      () => { if (live) setCheck({ kind: "open" }) },
      (err: unknown) => {
        if (!live) return
        if (err instanceof ApiError && err.status === 401) void navigate(signInFor(href))
        else if (err instanceof ApiError && err.status === 404) setCheck({ kind: "gone" })
        else setCheck({ kind: "failed", message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => { live = false }
  }, [id, navigate, href])

  if (check.kind === "checking") return <p className="text-xs text-muted-foreground">Checking the room…</p>
  if (check.kind === "open") {
    return <Link to="/rooms/$roomId" params={{ roomId: id }} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}>Open room</Link>
  }
  if (check.kind === "gone") {
    return <p className="text-xs text-muted-foreground">This room cannot be opened from here: it has been deleted, or it is still open and you are not in it.</p>
  }
  return <p className="text-xs text-destructive">Could not check this room: {check.message}</p>
}
```

- [ ] **Step 4: Export** — in `src/routes/audit.tsx`:
  1. Add `exportAudit` to the `@/lib/api` import.
  2. Add this function inside `Log`, after `loadOlder`:

```tsx
  /** The file is saved only once its whole body arrived (exportAudit), so a broken stream saves nothing. */
  const save = (format: "csv" | "json") => run(format, "Export failed; nothing was saved", async () => {
    const { blob, filename } = await exportAudit(filterOf(search), format, read.through)
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    // After the click has handed the file over: revoking in the same task can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  })
```

  3. Replace the count's `<div>` with the count, the buttons, and the note that says what an export holds:

```tsx
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">{countText(read.total)}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void save("csv")}>
            {busy === "csv" ? "Exporting…" : "Export CSV"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void save("json")}>
            {busy === "json" ? "Exporting…" : "Export JSON"}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        An export holds all {countText(read.total)} these filters match, as of when this page loaded.
      </p>
```

- [ ] **Step 5: Run them, and the suite**

Run: `npx vitest run src/router.test.tsx -t "the audit page"`
Expected: PASS, 18 tests.
Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/audit/table.tsx src/routes/audit.tsx src/router.test.tsx
git commit -m "Open an audit row to its detail and its room where the room opens from here, and export what the filters match"
```

### Task 14: README, screenshots, and the dash PR

**Files:**
- Modify: `README.md` (dash)

- [ ] **Step 1: Say what the page is** — in dash's `README.md`, add this paragraph after the Presets paragraph:

```markdown
The Audit page (`/audit`) is an org admin's read of the audit trail: every crossing that touched the org's boundary, from both sides of a room shared with another org, filtered by date, member, room, org, event and whether it crossed, with a cross-org row marked and opened to its room where the room still opens. It exports what the filters match as CSV or JSON. A plan without the audit trail is shown the way to Team instead. Needs the Worker's `/audit` routes (bellman-sh/bellman, the audit trail).
```

- [ ] **Step 2: Run the whole gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: everything passes.

- [ ] **Step 3: Take the screenshots**, as the `dash-pr-screenshots` memory describes.
  1. Run a throwaway stub Worker that also answers `GET /account` (a team admin, `auditRetentionMs: null`) and `GET /audit` (a page with one cross-org outbound row, one inbound row and one internal row, plus facets).
  2. Shoot at 1280x800:
     - before: the placeholder, from `main`
     - after: the log
     - after: a row opened to its detail
     - after: the free plan's gate
  3. Put the PNGs on the orphan branch `pr-assets/mcfearsome/audit-trail-cross-org-crossings-filters-export`.

- [ ] **Step 4: Push and open the PR** with the `pr` skill. Push with `git push -u origin mcfearsome/audit-trail-cross-org-crossings-filters-export`.
  - Title: `The audit trail: cross-org crossings, filters and export`
  - The body:
    - closes #11
    - links the bellman PR from Task 9
    - says **merge after the bellman PR has deployed** (spec D12)
    - shows the screenshots
