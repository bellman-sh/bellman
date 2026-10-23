# Org Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org admin sets a policy on the org record that binds every member at `bellman_start`, `bellman_connect` and `bellman_confirm`: org-only rooms always, capabilities members may not grant, which outside orgs they may share a room with, and who may start a room.

**Architecture:** `Org.policy` is a field of the existing record, lifted to `DEFAULT_POLICY` at the read for rows written before it. Pure functions in `src/orgs.ts` parse a patch, project the view and decide each refusal; the three tools call them after the entitlement refusals and before any write; `PATCH /org` takes `policy` beside `name`; `orgAuditEntries` diffs it into `org_updated`.

**Tech Stack:** TypeScript, zod, vitest, the in-memory MCP harness (`tests/helpers/harness.ts`), the store conformance suite (`tests/helpers/store-contract.ts`).

**Spec:** `docs/superpowers/specs/2026-10-23-org-policy-design.md`

## Global Constraints

- Every refusal before any write (ADR 0006); the policy checks sit after the entitlement refusals in each tool.
- A policy only tightens: no check grants anything an entitlement withholds.
- The policy read is `getOrg(identity.orgId)`, only for an identity that names an org.
- Refusal texts, verbatim from the spec: `your org's policy lets only admins start rooms.`; `your org's policy forbids granting request_actions to peers; call again without it.` (the capability named is the first forbidden one declared); `your org's policy does not allow rooms with org "acme".`; `org "acme"'s policy does not allow members of your org in its rooms.`
- `allowed_counterparty_orgs`: null is any, `[]` is none, at most 50 distinct ids by `isOrgId`.
- A room holds members, never "two sessions", in every comment and doc.
- ADR number is 0031 (0030 is PR #308's).
- `npm run docs:gen` after any tool description changes; never edit the generated pages.
- Commit with `git` from this worktree (no jj here); signed commits; read the diff stat before each push.

## Review Focus

1. A legacy org row with no `policy` read through `updateOrg` with a patch that names only `name` must write a record whose `policy` is `DEFAULT_POLICY` and record no `policy` change. (Task 1: `patchedOrg` and `orgAuditEntries` unit tests over a previous cast without the field.)
2. A joiner with no org meeting a room whose only org has `allowed_counterparty_orgs: []` must be refused by that org's rule, and a joiner whose org lists `[]` must be refused a room whose creator has no org. (Task 4: `joinRefusal` unit tests.)
3. A `PATCH /org` with `policy: {}` and nothing else must be a 400, and one with `policy: { who_may_create: "owner" }` a 400 naming the field. (Task 3.)
4. `requireOrgOnly` on a creator who passed `org_only: false` must create the room `orgOnly: true` and say so in the result and the audit detail. (Task 4.)
5. The capability check at confirm must run on the joiner's declared capabilities, not the creator's, so a creator's org that forbids nothing does not shield a joiner whose org forbids `request_actions`. (Task 4.)

---

### Task 1: The field, the lift, the merge and the audit diff

**Files:**
- Modify: `src/types.ts` (`Org`, `OrgPatch`, after `Capability`)
- Modify: `src/orgs.ts` (new `liftOrg`)
- Modify: `src/store.ts` (`patchedOrg`, `purchasedOrg`, `MemoryStore.getOrg`)
- Modify: `src/store-do.ts` (`getOrg` at ~3546, the `#updateOrgTxn` previous)
- Modify: `src/grant-audit.ts` (`orgAuditEntries`)
- Modify: `src/oauth/routes.ts:2008` (the operator's `Org` literal gains `policy: DEFAULT_POLICY`)
- Modify: every `Org` literal in tests: `tests/helpers/store-contract.ts` (`acme`), `tests/orgs.test.ts`, `tests/http-orgs.test.ts`, `tests/billing-grants.test.ts:310`, `tests/grant-audit.test.ts:412`
- Test: `tests/helpers/store-contract.ts`, `tests/grant-audit.test.ts`, `tests/orgs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts
  export interface OrgPolicy { requireOrgOnly: boolean; forbiddenCapabilities: Capability[]; allowedCounterpartyOrgs: string[] | null; whoMayCreate: "any_member" | "admins_only"; allowOperatorImpersonation: boolean; }
  export const DEFAULT_POLICY: OrgPolicy = { requireOrgOnly: false, forbiddenCapabilities: [], allowedCounterpartyOrgs: null, whoMayCreate: "any_member", allowOperatorImpersonation: true };
  export interface Org { ...; policy: OrgPolicy }
  export type OrgPatch = Partial<Pick<Org, "name" | "seats" | "requireSso">> & { policy?: Partial<OrgPolicy> };
  // src/orgs.ts
  export function liftOrg(org: Org): Org;   // policy ?? DEFAULT_POLICY, a fresh object
  ```
- `patchedOrg(previous, patch)` starts from `liftOrg(previous)` and merges `patch.policy` field by field over `previous.policy`.
- `orgAuditEntries(previous, next, ...)` diffs `liftOrg(previous).policy` against `next.policy` per field; a changed field lands under `policy: { <snake_case>: value }` in the `org_updated` detail; the `org_created` detail is unchanged.

- [ ] **Step 1: Write the failing contract test** in `tests/helpers/store-contract.ts`, in the orgs block, after "updates the name, the seats and the SSO switch":

```ts
it("updates the policy field by field, recording only the fields that changed, under policy", async () => {
  await store.createOrg(acme(), owner(), by);
  const tight = { requireOrgOnly: true, allowedCounterpartyOrgs: ["org_b"] };
  expect(await store.updateOrg("org_acme", { policy: tight }, by)).toEqual(acme({ policy: { ...DEFAULT_POLICY, ...tight } }));
  expect(await store.updateOrg("org_acme", { policy: { requireOrgOnly: true } }, by)).toMatchObject({ policy: { ...DEFAULT_POLICY, ...tight } });
  expect(await store.updateOrg("org_acme", { name: "Acme Ltd", policy: { whoMayCreate: "admins_only" } }, by)).toMatchObject({ name: "Acme Ltd", policy: { whoMayCreate: "admins_only", requireOrgOnly: true } });
  const rows = (await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "org_updated");
  expect(rows.map((e) => e.detail)).toEqual([
    { policy: { require_org_only: true, allowed_counterparty_orgs: ["org_b"] } },
    { name: "Acme Ltd", policy: { who_may_create: "admins_only" } },
  ]);
});
```
`acme()` gains `policy: DEFAULT_POLICY`; import `DEFAULT_POLICY` from `../../src/types.js`.

- [ ] **Step 2: Write the failing unit tests** in `tests/grant-audit.test.ts` (beside the existing `orgAuditEntries` cases) and `tests/orgs.test.ts`:

```ts
// grant-audit.test.ts
it("reads a row written before policy as the default, so a rename of it records no policy", () => {
  const legacy = { ...org(), policy: undefined } as unknown as Org;
  expect(orgAuditEntries(legacy, org({ name: "New" }), by, NOW)[0]!.detail).toEqual({ name: "New" });
  expect(orgAuditEntries(legacy, org(), by, NOW)).toEqual([]);
});
// orgs.test.ts
describe("liftOrg", () => {
  it("gives a row written before the field the default policy, and leaves a policy it has", () => {
    const legacy = { ...org, policy: undefined } as unknown as Org;
    expect(liftOrg(legacy).policy).toEqual(DEFAULT_POLICY);
    expect(liftOrg(legacy).policy).not.toBe(DEFAULT_POLICY);
    expect(liftOrg({ ...org, policy: { ...DEFAULT_POLICY, requireOrgOnly: true } }).policy.requireOrgOnly).toBe(true);
  });
});
```
and in `tests/orgs.test.ts` a `patchedOrg` case: a legacy previous with `{ policy: { whoMayCreate: "admins_only" } }` yields `{ ...DEFAULT_POLICY, whoMayCreate: "admins_only" }` and leaves `previous.policy` untouched.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/orgs.test.ts tests/grant-audit.test.ts tests/store-contract.test.ts`
Expected: FAIL, `DEFAULT_POLICY`/`liftOrg` not exported, typecheck of `policy` on `Org`.

- [ ] **Step 4: Implement** the Interfaces above. `MemoryStore.getOrg` returns `liftOrg(detach(org))`; DO `getOrg` returns the row through `liftOrg` when present; `purchasedOrg` writes `policy: DEFAULT_POLICY`. The DO's other `txn.get<Org>` reads touch no policy field and are left alone. Add `policy: DEFAULT_POLICY` to every `Org` literal listed under Files.

- [ ] **Step 5: Run the three files, then `npm run typecheck && npm run typecheck:worker`**
Expected: PASS, both typechecks clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/orgs.ts src/store.ts src/store-do.ts src/grant-audit.ts src/oauth/routes.ts tests/
git commit -S -m "An org carries a policy, read as the default on a row written before it, merged field by field and audited by the fields that changed"
```

---

### Task 2: Parse, view and decide

**Files:**
- Modify: `src/orgs.ts` (`OrgView`, `orgView`, new functions below)
- Test: `tests/orgs.test.ts`

**Interfaces:**
- Produces, all in `src/orgs.ts`:
  ```ts
  export const MAX_COUNTERPARTY_ORGS = 50;
  export interface PolicyView { require_org_only: boolean; forbidden_capabilities: Capability[]; allowed_counterparty_orgs: string[] | null; who_may_create: "any_member" | "admins_only"; allow_operator_impersonation: boolean }
  export function policyView(policy: OrgPolicy): PolicyView;
  /** The patch a PATCH /org body's `policy` names, or the text of the first fault. An empty object is a fault. */
  export function parsePolicyPatch(value: unknown): { patch: Partial<OrgPolicy> } | { error: string };
  /** The first forbidden capability a declaration holds, as the refusal text, or null. */
  export function forbiddenCapabilityRefusal(policy: OrgPolicy, capabilities: readonly string[]): string | null;
  /** Spec D3, both sides. `roomOrgs` is `session.orgs` plus `null` when the creator has no org (`session.orgId === null`). */
  export function joinRefusal(getOrg: (orgId: string) => Promise<Org | undefined>, joinerOrgId: string | null, roomOrgIds: readonly string[], creatorHasOrg: boolean): Promise<string | null>;
  ```
- `OrgView` gains `policy: PolicyView`; `orgView` fills it.
- `parsePolicyPatch` faults, verbatim: `policy must be an object`; `policy names no field`; `<field> is not a field of policy`; `require_org_only must be true or false` (same shape for `allow_operator_impersonation`); `forbidden_capabilities must list read_context, receive_messages or request_actions, each once`; `allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids`; `who_may_create must be any_member or admins_only`.
- `joinRefusal` order: the joiner's own org's list first (over every room org not its own, a no-org creator first), then each room org's list over the joiner's org, in `roomOrgIds` order. The joiner's own org in `roomOrgIds` is skipped on both sides.

- [ ] **Step 1: Write the failing tests** in `tests/orgs.test.ts`:

```ts
describe("policyView", () => {
  it("is the policy in snake case", () => {
    expect(policyView({ ...DEFAULT_POLICY, forbiddenCapabilities: ["request_actions"], allowedCounterpartyOrgs: [] }))
      .toEqual({ require_org_only: false, forbidden_capabilities: ["request_actions"], allowed_counterparty_orgs: [], who_may_create: "any_member", allow_operator_impersonation: true });
  });
});
describe("parsePolicyPatch", () => {
  it("takes each field by its type and leaves the rest out", () => {
    expect(parsePolicyPatch({ require_org_only: true, allowed_counterparty_orgs: ["org_b", "org_c"] })).toEqual({ patch: { requireOrgOnly: true, allowedCounterpartyOrgs: ["org_b", "org_c"] } });
    expect(parsePolicyPatch({ allowed_counterparty_orgs: null, who_may_create: "admins_only", forbidden_capabilities: [] })).toEqual({ patch: { allowedCounterpartyOrgs: null, whoMayCreate: "admins_only", forbiddenCapabilities: [] } });
  });
  it("names the first fault", () => {
    const faults: [unknown, string][] = [
      [null, "policy must be an object"], [[], "policy must be an object"], [{}, "policy names no field"],
      [{ max_ttl: 1 }, "max_ttl is not a field of policy"],
      [{ require_org_only: "yes" }, "require_org_only must be true or false"],
      [{ forbidden_capabilities: ["request_actions", "request_actions"] }, "forbidden_capabilities must list read_context, receive_messages or request_actions, each once"],
      [{ forbidden_capabilities: "request_actions" }, "forbidden_capabilities must list read_context, receive_messages or request_actions, each once"],
      [{ allowed_counterparty_orgs: ["acme"] }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ allowed_counterparty_orgs: ["org_b", "org_b"] }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ allowed_counterparty_orgs: Array.from({ length: 51 }, (_, i) => `org_${i}`) }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ who_may_create: "owner" }, "who_may_create must be any_member or admins_only"],
    ];
    for (const [value, error] of faults) expect(parsePolicyPatch(value), JSON.stringify(value)).toEqual({ error });
  });
});
describe("forbiddenCapabilityRefusal", () => {
  it("names the first forbidden capability the declaration holds", () => {
    const policy = { ...DEFAULT_POLICY, forbiddenCapabilities: ["request_actions", "read_context"] as Capability[] };
    expect(forbiddenCapabilityRefusal(policy, ["read_context", "request_actions"])).toBe("your org's policy forbids granting request_actions to peers; call again without it.");
    expect(forbiddenCapabilityRefusal(policy, ["receive_messages"])).toBeNull();
    expect(forbiddenCapabilityRefusal(DEFAULT_POLICY, ["request_actions"])).toBeNull();
  });
});
describe("joinRefusal", () => {
  const orgs: Record<string, Org> = {
    org_open: { ...org, orgId: "org_open" },
    org_b_only: { ...org, orgId: "org_b_only", policy: { ...DEFAULT_POLICY, allowedCounterpartyOrgs: ["org_b"] } },
    org_none: { ...org, orgId: "org_none", policy: { ...DEFAULT_POLICY, allowedCounterpartyOrgs: [] } },
    org_b: { ...org, orgId: "org_b" },
  };
  const getOrg = async (id: string) => orgs[id];
  it("allows a room of open orgs, and one the joiner's org lists", async () => {
    expect(await joinRefusal(getOrg, "org_b", ["org_open"], true)).toBeNull();
    expect(await joinRefusal(getOrg, "org_b_only", ["org_b"], true)).toBeNull();
    expect(await joinRefusal(getOrg, null, ["org_open"], true)).toBeNull();
    expect(await joinRefusal(getOrg, "org_none", ["org_none"], true)).toBeNull();
  });
  it("refuses from the joiner's side, naming the room's org, a no-org creator included", async () => {
    expect(await joinRefusal(getOrg, "org_b_only", ["org_open"], true)).toBe('your org\'s policy does not allow rooms with org "org_open".');
    expect(await joinRefusal(getOrg, "org_none", [], false)).toBe("your org's policy does not allow rooms with a creator outside any org.");
  });
  it("refuses from the room's side, naming the org whose rule refused", async () => {
    expect(await joinRefusal(getOrg, "org_open", ["org_b_only"], true)).toBe('org "org_b_only"\'s policy does not allow members of your org in its rooms.');
    expect(await joinRefusal(getOrg, null, ["org_open", "org_none"], true)).toBe('org "org_none"\'s policy does not allow members of your org in its rooms.');
  });
  it("reads a room org that has no record as open", async () => {
    expect(await joinRefusal(getOrg, "org_open", ["org_string"], true)).toBeNull();
  });
});
```
`org` is the file's existing fixture, given `policy: DEFAULT_POLICY` in Task 1. The no-org-creator refusal text is `your org's policy does not allow rooms with a creator outside any org.` (added to the Global Constraints list by this task). `orgView`'s existing test gains `policy: policyView(DEFAULT_POLICY)` in its expected object.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/orgs.test.ts`
Expected: FAIL, the four functions are not exported.

- [ ] **Step 3: Implement** the Interfaces. `isOrgId` from `src/grant-index.ts` validates each counterparty id. For a no-org joiner, a room org with a list (any array) refuses; for a no-org creator (`creatorHasOrg === false`), a joiner org with a list refuses.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/orgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orgs.ts tests/orgs.test.ts
git commit -S -m "The policy's view, its patch parser and the two refusals a join and a declaration can meet, as pure functions"
```

---

### Task 3: `PATCH /org` takes `policy`; `GET /org` shows it

**Files:**
- Modify: `src/http/orgs.ts:186-203`
- Test: `tests/http-orgs.test.ts` ("PATCH /org" and "GET /org" describes)

**Interfaces:**
- Consumes `parsePolicyPatch`, `policyView` (Task 2), `OrgPatch.policy` (Task 1).
- The stray-field check admits `policy`; the "nothing given" 400 reads `give a name, require_sso, policy, or any of them`; a `parsePolicyPatch` fault is a 400 `invalid_request` with its text.

- [ ] **Step 1: Write the failing tests**

```ts
it("sets policy fields for an admin, merging over the rest, and shows them to a member on GET", async () => {
  const res = (await call("owner", "/org", "PATCH", { policy: { require_org_only: true, forbidden_capabilities: ["request_actions"] } }))!;
  expect([res.status, (await json(res)).policy]).toEqual([200, { require_org_only: true, forbidden_capabilities: ["request_actions"], allowed_counterparty_orgs: null, who_may_create: "any_member", allow_operator_impersonation: true }]);
  await call("owner", "/org", "PATCH", { policy: { allowed_counterparty_orgs: ["org_b"] }, name: "Acme Ltd" });
  expect((await json(await call("member", "/org"))).policy).toMatchObject({ require_org_only: true, allowed_counterparty_orgs: ["org_b"] });
  expect((await store.auditForOrg("org_acme", 10)).at(-1)).toMatchObject({ action: "org_updated", detail: { name: "Acme Ltd", policy: { allowed_counterparty_orgs: ["org_b"] } } });
});
it("refuses a policy that is empty, names a stray field, or gives a field the wrong shape, and a member", async () => {
  for (const [body, error] of [
    [{ policy: {} }, "policy names no field"],
    [{ policy: { who_may_create: "owner" } }, "who_may_create must be any_member or admins_only"],
    [{ policy: { allowed_counterparty_orgs: ["acme"] } }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
    [{ policy: null }, "policy must be an object"],
  ] as [unknown, string][]) {
    const res = (await call("owner", "/org", "PATCH", body))!;
    expect([res.status, await said(res)], JSON.stringify(body)).toEqual([400, error]);
  }
  expect((await call("member", "/org", "PATCH", { policy: { require_org_only: true } }))!.status).toBe(403);
  expect((await store.getOrg("org_acme"))?.policy).toEqual(DEFAULT_POLICY);
});
```
`said` is the file's existing helper for a problem's description. The existing GET /org test's expected object gains `policy: policyView(DEFAULT_POLICY)` or the literal.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/http-orgs.test.ts`
Expected: FAIL, `policy is not a field of PATCH /org`, and GET lacks `policy`.

- [ ] **Step 3: Implement** in the PATCH branch: admit `policy` in the stray check; `const policy = body.policy === undefined ? undefined : parsePolicyPatch(body.policy)`; `"error" in policy` is the 400; pass `policy?.patch` to `updateOrg`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/http-orgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/orgs.ts tests/http-orgs.test.ts
git commit -S -m "PATCH /org takes the policy a field at a time, and GET /org shows it to every member"
```

---

### Task 4: The tools enforce it

**Files:**
- Modify: `src/tools/start.ts` (description's Errors list; after the `org_only` refusals at ~126-131; the `orgOnly` stamp and `session_created` detail; the result gains `org_only`)
- Modify: `src/tools/connect.ts` (description's Errors list; after the `session.orgOnly` refusal at ~80)
- Modify: `src/tools/confirm.ts` (description's Errors list; after the `isBannedByCreator` check, before `seatMember`)
- Create: `tests/tools/org-policy.test.ts`
- Regenerate: `docs-site/src/content/docs/reference/tools/` via `npm run docs:gen`

**Interfaces:**
- Consumes `forbiddenCapabilityRefusal`, `joinRefusal` (Task 2); `getOrg` on the store.
- `bellman_start`, after the two `org_only` refusals: `const org = identity.orgId ? await s.getOrg(identity.orgId) : undefined; const policy = org?.policy;` then, in order: `whoMayCreate === "admins_only" && identity.role !== "admin"` refuses; `forbiddenCapabilityRefusal(policy, capabilities)` refuses; `const orgOnly = org_only || policy.requireOrgOnly === true` replaces `org_only` at the stamp, in the audit detail and in the result as `org_only: orgOnly`.
- `bellman_connect`, after the `session.orgOnly` refusal: `joinRefusal((id) => s.getOrg(id), identity.orgId, session.orgs, session.orgId !== null)` refuses.
- `bellman_confirm`, after the creator ban check: the same `joinRefusal` over the session as read there; then `forbiddenCapabilityRefusal` over the joiner's org's policy and `capabilities`.
- Descriptions: `bellman_start`'s Errors list gains `"your org's policy lets only admins start rooms." and "your org's policy forbids granting ... to peers" (policy)`; `bellman_connect`'s and `bellman_confirm`'s gain `"your org's policy does not allow rooms with org ..." / "org ...'s policy does not allow members of your org" (policy, both sides of the join)`, and confirm's the capability one.

- [ ] **Step 1: Write the failing tests** in `tests/tools/org-policy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { DEFAULT_POLICY, type Identity, type Org, type OrgPolicy, type PlanGrant } from "../../src/types.js";

const org = (orgId: string, policy: Partial<OrgPolicy> = {}): Org => ({
  orgId, name: orgId, ownerUserId: `u_${orgId}`, seats: 10, source: "operator", active: true, createdAt: 1,
  requireSso: false, domains: [], policy: { ...DEFAULT_POLICY, ...policy },
});
const grant = (orgId: string): PlanGrant => ({ key: `github:${orgId}`, plan: "team", role: "admin", orgId, source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null });
const who = (orgId: string | null, role: "admin" | "member" = "member", n = 1): Identity => ({ userId: `u_${orgId ?? "none"}_${n}`, orgId, plan: "team", role, label: `${orgId ?? "nobody"} ${n}` });
const by = { actorUserId: "u_op" };

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const start = (peer: Awaited<ReturnType<Harness["connectAs"]>>, args: Record<string, unknown> = {}) =>
  peer.call("bellman_start", { manifest: manifestFixture(), brief: brief(), capabilities: ["read_context", "receive_messages"], ...args });
const join = async (peer: Awaited<ReturnType<Harness["connectAs"]>>, code: string, capabilities = ["read_context", "receive_messages"]) => {
  const c = await peer.call("bellman_connect", { join_code: code });
  if (c.isError) return c;
  return peer.call("bellman_confirm", { connect_token: JSON.parse(c.text).connect_token, brief: brief(), capabilities });
};

describe("who_may_create", () => {
  it("refuses a member and admits an admin when admins_only, and binds nobody by default", async () => {
    await h.store.createOrg(org("org_a", { whoMayCreate: "admins_only" }), grant("org_a"), by);
    const member = await start(await h.connectAs(who("org_a")));
    expect([member.isError, member.text]).toEqual([true, "your org's policy lets only admins start rooms."]);
    expect((await start(await h.connectAs(who("org_a", "admin")))).isError).toBe(false);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    expect((await start(await h.connectAs(who("org_b")))).isError).toBe(false);
  });
});

describe("require_org_only", () => {
  it("makes the room org-only whatever the call said, says so in the result and the audit row, and keeps outsiders out", async () => {
    await h.store.createOrg(org("org_a", { requireOrgOnly: true }), grant("org_a"), by);
    const started = await start(await h.connectAs(who("org_a")), { org_only: false });
    const body = JSON.parse(started.text);
    expect([started.isError, body.org_only]).toEqual([false, true]);
    expect((await h.store.getSession(body.session_id))?.orgOnly).toBe(true);
    expect((await h.store.auditForOrg("org_a", 10)).at(-1)).toMatchObject({ action: "session_created", detail: { org_only: true } });
    const outsider = await (await h.connectAs(who(null))).call("bellman_connect", { join_code: body.join_code });
    expect(outsider.text).toBe("session is org-restricted and your identity is not in the creator's org.");
  });
});

describe("forbidden_capabilities", () => {
  it("refuses the declaration at start and at confirm, on the declarer's own org, and creates nothing", async () => {
    await h.store.createOrg(org("org_a", { forbiddenCapabilities: ["request_actions"] }), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    const a = await h.connectAs(who("org_a"));
    const refused = await start(a, { capabilities: ["read_context", "request_actions"] });
    expect([refused.isError, refused.text]).toEqual([true, "your org's policy forbids granting request_actions to peers; call again without it."]);
    expect(await h.store.countCreatesThisMonth(a.identity.userId)).toBe(0);
    const started = JSON.parse((await start(await h.connectAs(who("org_b")))).text);
    const joined = await join(a, started.join_code, ["read_context", "request_actions"]);
    expect([joined.isError, joined.text]).toEqual([true, "your org's policy forbids granting request_actions to peers; call again without it."]);
    expect((await h.store.getSession(started.session_id))?.members).toHaveLength(1);
    expect((await join(a, started.join_code)).isError).toBe(false);
  });
});

describe("allowed_counterparty_orgs", () => {
  it("binds the joiner's side and the room's side, and a room with a creator outside any org", async () => {
    await h.store.createOrg(org("org_a", { allowedCounterpartyOrgs: ["org_b"] }), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    await h.store.createOrg(org("org_c"), grant("org_c"), by);
    const inA = JSON.parse((await start(await h.connectAs(who("org_a")))).text);
    expect((await join(await h.connectAs(who("org_b")), inA.join_code)).isError).toBe(false);
    const c = await join(await h.connectAs(who("org_c")), inA.join_code);
    expect(c.text).toBe('org "org_a"\'s policy does not allow members of your org in its rooms.');
    expect((await join(await h.connectAs(who(null)), inA.join_code)).text).toBe('org "org_a"\'s policy does not allow members of your org in its rooms.');
    const inC = JSON.parse((await start(await h.connectAs(who("org_c")))).text);
    expect((await join(await h.connectAs(who("org_a"), "member", 2), inC.join_code)).text).toBe('your org\'s policy does not allow rooms with org "org_c".');
    const noOrg = JSON.parse((await start(await h.connectAs(who(null, "member", 2)))).text);
    expect((await join(await h.connectAs(who("org_a"), "member", 3), noOrg.join_code)).text).toBe("your org's policy does not allow rooms with a creator outside any org.");
  });

  it("is read again at confirm, so a policy tightened between preview and seat refuses the seat", async () => {
    await h.store.createOrg(org("org_a"), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    const inA = JSON.parse((await start(await h.connectAs(who("org_a")))).text);
    const b = await h.connectAs(who("org_b"));
    const preview = await b.call("bellman_connect", { join_code: inA.join_code });
    expect(preview.isError).toBe(false);
    await h.store.updateOrg("org_a", { policy: { allowedCounterpartyOrgs: [] } }, by);
    const seat = await b.call("bellman_confirm", { connect_token: JSON.parse(preview.text).connect_token, brief: brief(), capabilities: ["read_context"] });
    expect(seat.text).toBe('org "org_a"\'s policy does not allow members of your org in its rooms.');
  });
});
```
`Peer.identity` exists on the harness's `Peer`; if it is private, read the user id from `who(...)` instead. The `start` quota assertion uses the store's `countCreatesThisMonth`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tools/org-policy.test.ts`
Expected: FAIL on the first assertion of each describe (no refusal, `org_only` absent).

- [ ] **Step 3: Implement** per the Interfaces, in the three tools, and update the three descriptions' Errors lists.

- [ ] **Step 4: Run the new file, the handshake and http suites, and regenerate the reference**

Run: `npx vitest run tests/tools/org-policy.test.ts tests/tools/handshake.test.ts tests/http-orgs.test.ts && npm run docs:gen && npx vitest run tests/docs-reference.test.ts tests/extension.test.ts`
Expected: PASS; `git status` shows the three regenerated tool pages changed.

- [ ] **Step 5: Commit**

```bash
git add src/tools/start.ts src/tools/connect.ts src/tools/confirm.ts tests/tools/org-policy.test.ts docs-site/src/content/docs/reference/tools/
git commit -S -m "An org's policy binds its members at a start, a preview and a seat: who may start, org-only always, the capabilities a member may not grant, and the orgs a room may hold, checked from both sides of a join"
```

---

### Task 5: ADR, architecture and the teams guide

**Files:**
- Create: `docs/adr/0031-org-policy.md`
- Modify: `docs/ARCHITECTURE.md` section 6 (a bullet 6 after the SSO bullet; renumber any that follow)
- Modify: `docs-site/src/content/docs/guides/teams.md` (a section "Org policy" after "Org-only rooms")
- Modify: `GLOSSARY.md` if it exists (an "org policy" entry)

- [ ] **Step 1: Write the ADR** in the format of `docs/adr/0029-*.md` (Status, Context, Decision, Consequences): D1 to D7 in prose, the dropped TTL knob, running rooms left alone, both-sides join rule, the policy read being one `getOrg` per org in the room.

- [ ] **Step 2: Write the architecture bullet**: an org's policy is a field of its record, lifted to the default at read; evaluated at `bellman_start`, `bellman_connect` and `bellman_confirm` after the entitlement refusals; a join is checked from both sides; running rooms are not revisited (ADR 0031).

- [ ] **Step 3: Write the guide section**: how an admin sets it (`PATCH /org` with a `policy` object, each field named with its shape), what a member sees when refused (the four texts), that the owner and admins are bound too, and that a running room is unchanged. Link the two tool reference pages.

- [ ] **Step 4: Verify**

Run: `npm run verify && npm --prefix docs-site run build`
Expected: both green; the site build reports no broken link.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0031-org-policy.md docs/ARCHITECTURE.md docs-site/src/content/docs/guides/teams.md GLOSSARY.md
git commit -S -m "ADR 0031 and the docs for an org's policy"
```

Then: one whole-branch review, `superpowers:finishing-a-development-branch`, PR with `Closes #57`, and a dash issue for the policy card.
