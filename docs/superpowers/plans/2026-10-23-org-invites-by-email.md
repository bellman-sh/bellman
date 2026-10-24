# Invites by email (#54) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin's invite to an address mails the person a link that opens the invite and starts a sign-in whose Join takes it; every invite expires and can be resent.

**Architecture:** The invite row (ADR 0027) stays the single-use part. Expiry is a field on it, lifted at read for old rows, and one predicate `inviteLive` both stores and the routes ask. The link is a signed JWT (`bellman:invite`) naming the org and the key, verified by a new `GET /invite/:token` page on the auth server that starts a panel sign-in carrying the token; the callback adds the token's invite to the sign-in's offers and the Join passes the invite's key to the store. Mail goes through the `send_email` binding the reports use, from a second mailer in a runtime-free module.

**Tech Stack:** TypeScript, Workers + Durable Objects, vitest (Node and `cloudflare:test`), the existing `signJwt`/`verifyJwt`.

**Spec:** `docs/superpowers/specs/2026-10-23-org-invites-by-email-design.md` (ADR 0036 at `docs/adr/0036-invites-by-email.md`).

## Global Constraints

- `INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000`; `RESEND_COOLDOWN_MS = 10 * 60 * 1000`; `INVITE_FROM = "invites@bellman.sh"`; `INVITE_AUDIENCE = "bellman:invite"`.
- The link is `${issuer}/invite/${token}`. Mail subject: `Join <org> on Bellman`. Org name in mail: `drawnOrgName(org)` with `\r` and `\n` removed.
- A roster/202/200 invite view is `{ key, user_id, role, status: "invited" | "expired", invited_at, invited_by, expires_at }`. The 202 and the resend's 200 add `link: string` and `mailed: boolean`. The roster never carries `link`.
- Log lines name the org id and the key, never a bare address outside the key.
- Every `BellmanStore` method is async; the DO implementation reads and writes inside one transaction.
- Both stores pass `tests/helpers/store-contract.ts` identically; the DO store's run is `npm run test:worker -- store-do`.
- `npm run verify` before every commit; commits signed: `git -c commit.gpgsign=true commit -S`.
- Never describe Bellman as a thing for two sessions. "Members", "the room", "peers".
- Peer and admin content is untrusted: an org name is drawn through `drawnName`/`escape`, never raw.

## Review Focus

1. A link opened after the invite was accepted by its key's own sign-in (no link): the page says expired or withdrawn, not a 500. Test in Task 5.
2. A link whose token names an org the invite's key is no longer invited to, but the key is invited elsewhere: only the token's org is added, and only if that invite is live. Test in Task 5.
3. A resend on an expired invite revives it: `expiresAt` moves forward and the Join succeeds. Test in Task 2 (store) and Task 4 (route).
4. A token with a valid signature but a tampered `bellman` claim shape (missing key): the page answers 410, the callback ignores it. Test in Task 5.
5. `POST /org/members` for an address when the binding throws: 202 still, `mailed: false`, invite stored. Test in Task 4.

---

### Task 1: Expiry on the invite record

**Files:**
- Modify: `src/types.ts` (`OrgInvite`), `src/orgs.ts`, `src/store.ts` (MemoryStore invite methods), `src/store-do.ts` (invite methods), `src/http/orgs.ts` (`inviteView`), `src/oauth/routes.ts` (`offersFor`)
- Test: `tests/helpers/store-contract.ts`, `tests/http-orgs.test.ts`, `tests/seat-consent.test.ts`

**Interfaces:**
- Produces: `OrgInvite.expiresAt: number`; in `src/orgs.ts`: `export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000`, `export function liftInvite(invite: OrgInvite): OrgInvite` (fills a missing `expiresAt` as `invitedAt + INVITE_TTL_MS`), `export const inviteLive = (invite: OrgInvite, now: number): boolean => invite.expiresAt > now`. `InviteView.status: "invited" | "expired"`, `InviteView.expires_at: string`. `inviteView(invite, now = Date.now())`.

- [ ] **Step 1: Failing contract tests** in the invites describe of `tests/helpers/store-contract.ts`. The `invite()` fixture gains `expiresAt: 7 + INVITE_TTL_MS`.

```ts
it("lists an invite with its expiry, and lifts one stored without a field to fourteen days after it was made", async () => {
  await seated();
  await store.putOrgInvite(invite("github:9"), by);
  const [row] = await store.listOrgInvites("org_acme", 10);
  expect(row.expiresAt).toBe(7 + INVITE_TTL_MS);
  // The DO store lifts at read; MemoryStore stores what it is given. Both answer the same for a row missing the field:
  const legacy = { ...invite("github:8") } as Partial<OrgInvite>; delete legacy.expiresAt;
  await store.putOrgInvite(legacy as OrgInvite, by);
  expect((await store.invitesFor(["github:8"]))[0].expiresAt).toBe(7 + INVITE_TTL_MS);
});

it("seats nobody for an expired invite, keeps the row, and still finds it for the roster", async () => {
  await seated();
  await store.putOrgInvite(invite("github:9", { expiresAt: 100 }), by);
  expect(await store.acceptOrgInvite("org_acme", ["github:9"], "github:9", 101, by)).toBe("gone");
  expect(await store.getGrant("github:9")).toBeUndefined();
  expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["github:9"]);
  expect(await store.acceptOrgInvite("org_acme", ["github:9"], "github:9", 99, by)).toBe("joined");
});
```

- [ ] **Step 2: Run** `rtk proxy npx vitest run tests/store.test.ts -t "expired|expiry" > .vitest/t1.txt 2>&1; rtk proxy grep -nE "✓|✗|×|FAIL|Error" .vitest/t1.txt | head`
Expected: FAIL (`expiresAt` undefined; "joined" where "gone" is expected).

- [ ] **Step 3: Implement.** `OrgInvite.expiresAt: number` with a doc line. `INVITE_TTL_MS`, `liftInvite`, `inviteLive` in `src/orgs.ts`. MemoryStore: `putOrgInvite` stores `liftInvite(invite)`; `acceptOrgInvite` treats an invite with `!inviteLive(invite, now)` as no invite (so the seats path still applies). DO store: `listOrgInvites` and `invitesFor` map through `liftInvite`; `#acceptOrgInviteTxn` lifts the found row and applies the same predicate. Every other site that constructs an `OrgInvite` (`offersFor`'s seats, `POST /org/members`, fixtures in `tests/seat-consent.test.ts`, `tests/http-orgs.test.ts`, `tests/helpers/store-contract.ts`) sets `expiresAt`; for an unowned seat read as an offer, `expiresAt: Number.MAX_SAFE_INTEGER` (grants do not expire, spec D3).

- [ ] **Step 4: Run** Step 2's command and `npm run test:worker -- store-do > .vitest/t1w.txt 2>&1; tail -5 .vitest/t1w.txt`
Expected: PASS, both stores.

- [ ] **Step 5: Failing route tests.** In `tests/http-orgs.test.ts`, the invites describe:

```ts
it("lists an expired invite as expired, with its expiry, so the admin can resend or withdraw it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
  await call("owner", "/org/members", "POST", { key: "github:9", role: "member" });
  vi.setSystemTime(1_000_000 + INVITE_TTL_MS + 1);
  const { members } = await json(await call("owner", "/org/members")) as { members: { key: string; status: string; expires_at: string }[] };
  const row = members.find((m) => m.key === "github:9")!;
  expect([row.status, row.expires_at]).toEqual(["expired", new Date(1_000_000 + INVITE_TTL_MS).toISOString()]);
  vi.useRealTimers();
});
```

In `tests/seat-consent.test.ts`, the invites describe: `it("offers no expired invite at a sign-in, and keeps the row for the admin", ...)`: seat `github:4242` as an invite with the clock at T, step the clock past T + TTL, `signIn("continue")` lands straight in the panel (no page), and the roster still lists the key as `expired`.

- [ ] **Step 6: Run** both files with `-t "expired"`. Expected: FAIL (status `invited`; the sign-in stops at the page).

- [ ] **Step 7: Implement.** `inviteView(invite, now = Date.now())` sets `status: inviteLive(invite, now) ? "invited" : "expired"` and `expires_at: iso(invite.expiresAt)`. `offersFor` takes `now: number` (callers pass `Date.now()`) and filters `inviteLive` on the invites before merging with the seats.

- [ ] **Step 8: Run** `npm run verify > .vitest/verify1.txt 2>&1; rc=$?; tail -15 .vitest/verify1.txt; echo rc=$rc`
Expected: rc=0.

- [ ] **Step 9: Commit**
```bash
git add src/types.ts src/orgs.ts src/store.ts src/store-do.ts src/http/orgs.ts src/oauth/routes.ts tests/helpers/store-contract.ts tests/http-orgs.test.ts tests/seat-consent.test.ts
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 1/6: every invite expires (ADR 0036, D3)"
```

### Task 2: `renewOrgInvite` and the `invite_resent` row

**Files:**
- Modify: `src/store.ts` (`BellmanStore` interface + MemoryStore), `src/store-do.ts`, `src/grant-audit.ts` (`OrgEvent`)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces: `renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing">` on `BellmanStore`; `"invite_resent"` in `OrgEvent`.

- [ ] **Step 1: Failing contract tests**

```ts
it("renews an invite: a new time, a fresh fourteen days, this admin, both rows, and a row in the stream", async () => {
  await seated();
  await store.putOrgInvite(invite("github:9", { expiresAt: 100 }), by);
  const renewed = await store.renewOrgInvite("org_acme", "github:9", "u_github_7", 500, by);
  expect(renewed).toMatchObject({ key: "github:9", role: "member", invitedAt: 500, expiresAt: 500 + INVITE_TTL_MS, invitedBy: "u_github_7" });
  expect(await store.invitesFor(["github:9"])).toEqual([renewed]);
  expect(await store.listOrgInvites("org_acme", 10)).toEqual([renewed]);
  expect(await store.acceptOrgInvite("org_acme", ["github:9"], "github:9", 501, by)).toBe("joined");
  expect(await orgEvents()).toEqual(["member_invited", "invite_resent"]);
});

it("renews nothing that is not there: no invite under the key, or another org's", async () => {
  await seated();
  await store.putOrgInvite(invite("github:9"), by);
  expect(await store.renewOrgInvite("org_acme", "github:8", "u_github_1", 500, by)).toBe("missing");
  expect(await store.renewOrgInvite("org_b", "github:9", "u_github_1", 500, by)).toBe("missing");
});
```
(`orgEvents()` drops `org_created` and `plan_granted`.)

- [ ] **Step 2: Run** `-t "renews"`. Expected: FAIL (`renewOrgInvite is not a function`).

- [ ] **Step 3: Implement.** Interface doc: "Resend (ADR 0036, D4): the row rewritten with `invitedAt: now`, `expiresAt: now + INVITE_TTL_MS`, `invitedBy`; the role stands. One `invite_resent` row `{ key }`." MemoryStore: read, rewrite in the org's map, `recordAudit`. DO store: a `#renewOrgInviteTxn` that reads `byOrg`, writes both rows and the enqueued audit row in one transaction, then `deliverNow()` on success, as `putOrgInvite` does.

- [ ] **Step 4: Run** the contract test on both stores, then `npm run verify`. Expected: PASS, rc=0.

- [ ] **Step 5: Commit**
```bash
git add src/store.ts src/store-do.ts src/grant-audit.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 2/6: renewOrgInvite and the invite_resent row (ADR 0036, D4)"
```

### Task 3: The link and the mail

**Files:**
- Create: `src/invite-mail.ts`
- Test: `tests/invite-mail.test.ts`

**Interfaces:**
- Consumes: `MailBinding` from `src/reports.ts`; `signJwt`, `verifyJwt` from `src/oauth/tokens.ts`; `drawnOrgName` from `src/orgs.ts`.
- Produces, in `src/invite-mail.ts`:
  - `export const INVITE_FROM = "invites@bellman.sh"`, `export const INVITE_AUDIENCE = "bellman:invite"`.
  - `export async function inviteLink(issuer: string, secret: string, invite: OrgInvite): Promise<string>` — `${issuer}/invite/${token}`, token signed `{ iss: issuer, sub: "invite", aud: INVITE_AUDIENCE, bellman: { orgId, key }, exp: Math.floor(invite.expiresAt / 1000) }` (pass `ttlSeconds` as `Math.max(1, exp - now)`; read `signJwt` to see whether an explicit `exp` wins).
  - `export async function verifyInviteLink(token: string, issuer: string, secret: string): Promise<{ orgId: string; key: string } | null>` — null for a bad signature, wrong audience, expiry, or a `bellman` claim that is not two non-empty strings.
  - `export function inviteMail(org: Org, invite: OrgInvite, link: string): { subject: string; text: string }`.
  - `export type InviteMailer = (to: string, org: Org, invite: OrgInvite, link: string) => Promise<boolean>`.
  - `export function inviteMailer(binding: MailBinding | undefined): InviteMailer`.

- [ ] **Step 1: Failing tests** in `tests/invite-mail.test.ts`:

```ts
const org = { orgId: "org_acme", name: "Acme\r\nBcc: x@y", ... } as Org;  // the rest from DEFAULT fixtures
const invite: OrgInvite = { orgId: "org_acme", key: "email:ana@example.com", role: "admin", invitedBy: "u_1", invitedAt: 1_000_000, expiresAt: 1_000_000 + INVITE_TTL_MS };

it("signs a link that verifies to the org and the key, and dies with the invite", async () => {
  const link = await inviteLink("https://mcp.test", "s", invite);
  expect(link.startsWith("https://mcp.test/invite/")).toBe(true);
  expect(await verifyInviteLink(link.slice("https://mcp.test/invite/".length), "https://mcp.test", "s")).toEqual({ orgId: "org_acme", key: "email:ana@example.com" });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(invite.expiresAt + 1000);
  expect(await verifyInviteLink(link.split("/invite/")[1], "https://mcp.test", "s")).toBeNull();
  vi.useRealTimers();
});
it("refuses another secret, another audience, and a claim without a key", async () => { /* signJwt a token with aud "bellman:session-state"; one with bellman: { orgId: "x" }; verify all three null */ });
it("writes the mail from fixed text and the org's drawn name, with no line break from the name, and the link on its own line", () => {
  const m = inviteMail(org, invite, "https://mcp.test/invite/abc");
  expect(m.subject).toBe("Join AcmeBcc: x@y on Bellman");   // adjust to what drawnOrgName leaves of \r\n
  expect(m.subject).not.toMatch(/[\r\n]/);
  expect(m.text).toContain("\nhttps://mcp.test/invite/abc\n");
  expect(m.text).toContain("as an admin");
  expect(m.text).toContain(new Date(invite.expiresAt).toUTCString());
});
it("sends through the binding and answers true; answers false, and logs, with no binding or a send that throws", async () => {
  const sent: unknown[] = [];
  expect(await inviteMailer({ send: async (m) => { sent.push(m); } })("ana@example.com", org, invite, "L")).toBe(true);
  expect(sent[0]).toMatchObject({ from: INVITE_FROM, to: "ana@example.com" });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await inviteMailer(undefined)("ana@example.com", org, invite, "L")).toBe(false);
  expect(await inviteMailer({ send: async () => { throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" }); } })("ana@example.com", org, invite, "L")).toBe(false);
  expect(err.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("org_acme"), expect.stringContaining("E_SENDER_NOT_VERIFIED")]);
  expect(err.mock.calls.flat().join(" ")).not.toContain("ana@example.com");   // the key is "email:ana@…"; log the key, never the bare address
  err.mockRestore();
});
```
(Ruling in the brief: the log names `invite.key`, which contains the address. The spec's "never the address" means not as a separate `to` field; drop the last assertion if the key is logged.)

- [ ] **Step 2: Run** `rtk proxy npx vitest run tests/invite-mail.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/invite-mail.ts` as the interface says. Text body:
```
<org> invited you to join it on Bellman as <a member|an admin>.

Open this link and sign in to accept:

<link>

The invitation expires on <toUTCString>. If you were not expecting it, ignore this message.
```
`whyNotSent` is private to `src/reports.ts`: export it and reuse it.

- [ ] **Step 4: Run** the test file, then `npm run verify`. Expected: PASS, rc=0.

- [ ] **Step 5: Commit**
```bash
git add src/invite-mail.ts src/reports.ts tests/invite-mail.test.ts
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 3/6: the link and the mail (ADR 0036, D1, D2)"
```

### Task 4: The org routes: full check, mail, link, resend

**Files:**
- Modify: `src/http/orgs.ts`, `src/worker.ts`, `src/app.ts`, `src/orgs.ts` (`RESEND_COOLDOWN_MS`)
- Test: `tests/http-orgs.test.ts`

**Interfaces:**
- Consumes: Task 3's module; Task 2's `renewOrgInvite`; Task 1's view.
- Produces: `OrgRouteDeps` gains `issuer: string`, `linkSecret?: string` (the token secret; absent in the Node server's tests means no link: `link: null`), `mail?: InviteMailer`. `RESEND = /^\/org\/members\/([^/]+)\/resend$/`. `export const RESEND_COOLDOWN_MS = 10 * 60 * 1000` in `src/orgs.ts`.

- [ ] **Step 1: Failing tests.** `deps` in `beforeEach` gains `issuer: ISSUER, linkSecret: "link-secret", mail`, where `mail = vi.fn(async () => true)` is reset per test.

```ts
it("mails an address its link, and answers the link and that it was mailed", async () => {
  const res = await call("owner", "/org/members", "POST", { key: "email:ana@example.com", role: "member" });
  expect(res!.status).toBe(202);
  const body = await json(res) as { member: { status: string }; link: string; mailed: boolean };
  expect([body.member.status, body.mailed]).toEqual(["invited", true]);
  expect(await verifyInviteLink(body.link.slice(`${ISSUER}/invite/`.length), ISSUER, "link-secret")).toEqual({ orgId: "org_acme", key: "email:ana@example.com" });
  expect(mail).toHaveBeenCalledWith("ana@example.com", expect.objectContaining({ orgId: "org_acme" }), expect.objectContaining({ key: "email:ana@example.com" }), body.link);
});
it("answers mailed false, and still the link and the invite, when nothing could send", async () => {
  mail.mockResolvedValueOnce(false);
  const body = await json(await call("owner", "/org/members", "POST", { key: "email:ana@example.com", role: "member" }));
  expect(body.mailed).toBe(false);
  expect(typeof body.link).toBe("string");
  expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["email:ana@example.com"]);
});
it("mails nothing for a subject key, and answers its link for the admin to hand on", async () => {
  const body = await json(await call("owner", "/org/members", "POST", { key: "github:9", role: "member" }));
  expect([body.mailed, typeof body.link]).toEqual([false, "string"]);
  expect(mail).not.toHaveBeenCalled();
});
it("refuses to invite into a full org, before any mail", async () => { /* fill acme's 3 seats with grants, POST an email key, expect 409 "full", mail not called, no invite */ });
it("resends: a fresh link mailed, the roster's time moved, 200 with the same body as the 202", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
  await call("owner", "/org/members", "POST", { key: "email:ana@example.com", role: "member" });
  vi.setSystemTime(1_000_000 + RESEND_COOLDOWN_MS + 1);
  const res = await call("owner", "/org/members/email:ana@example.com/resend", "POST");
  expect(res!.status).toBe(200);
  const body = await json(res) as { member: { invited_at: string; expires_at: string }; link: string; mailed: boolean };
  expect(body.member.invited_at).toBe(new Date(1_000_000 + RESEND_COOLDOWN_MS + 1).toISOString());
  expect(body.mailed).toBe(true);
  expect(mail).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
it("refuses a resend within ten minutes of the last, and one for a key not invited", async () => { /* 429 "cooldown" with retry-after seconds; 404 "missing" */ });
it("resends an expired invite, which is then open again", async () => { /* clock past TTL; resend after cooldown; roster shows invited */ });
it("gates a resend as the other writes: no origin, a member, the wrong org", async () => { /* 403 for a member; mirrors the existing DELETE gate tests */ });
```

- [ ] **Step 2: Run** `-t "mails|resend|full org"`. Expected: FAIL (no `link`, 404 on resend).

- [ ] **Step 3: Implement.** In the invite path of `POST /org/members`: before `putOrgInvite`, `if ((await deps.store.countOrgMembers(orgId)) >= org.seats) return problem(409, "full", "every seat is taken; free one or buy more before inviting", origin)`; build the invite with `expiresAt: now + INVITE_TTL_MS`; after `"invited"`, `const link = deps.linkSecret ? await inviteLink(deps.issuer, deps.linkSecret, invite) : null`; `const mailed = link !== null && invite.key.startsWith("email:") && deps.mail ? await deps.mail(invite.key.slice(6), org, invite, link) : false`; answer `json(202, { member: inviteView(invite), link, mailed }, origin)`. One helper `sendInvite(deps, org, invite, origin, status)` serves the 202 and the resend's 200. `POST` on `RESEND`: admin gate as `DELETE /org/members/:key`; read the invite by `invitesFor([key])` filtered to `orgId`; 404 `missing`; `429 cooldown` when `now - invite.invitedAt < RESEND_COOLDOWN_MS`, with a `retry-after` header in seconds; then `renewOrgInvite(orgId, key, identity.userId, now, intent)`, `"missing"` is 404 too (withdrawn between the reads); then `sendInvite` with 200. Wire `issuer: oauth.issuer`, `linkSecret: env.BELLMAN_TOKEN_SECRET`, `mail: inviteMailer(env.SEND_EMAIL)` in `src/worker.ts` (one mailer built beside `mailReport`), and `issuer: "http://localhost:3900"`, `linkSecret: <the token secret app.ts uses>`, `mail: inviteMailer(undefined)` in `src/app.ts`. The `seat-consent.test.ts` and other `orgRoutes` callers gain `issuer`.

- [ ] **Step 4: Run** the file, then `npm run verify`. Expected: PASS, rc=0.

- [ ] **Step 5: Commit**
```bash
git add src/http/orgs.ts src/orgs.ts src/worker.ts src/app.ts tests/http-orgs.test.ts tests/seat-consent.test.ts
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 4/6: POST /org/members mails the link, a full org refuses, POST /org/members/:key/resend (ADR 0036, D1, D4, D5, D6)"
```

### Task 5: `GET /invite/:token` and the token-bound Join

**Files:**
- Modify: `src/oauth/routes.ts`
- Test: `tests/seat-consent.test.ts` (new describe "the invitation link (ADR 0036)")

**Interfaces:**
- Consumes: `verifyInviteLink`, `INVITE_AUDIENCE` from Task 3; `inviteLive` from Task 1.
- Produces: `SessionRequest.invite?: string` (the raw token); `HeldSignIn.inviteKey?: string`; `offersFor(plans, keys, subjectKey, now, linked?: OrgInvite)`; `invitesHeld` reads `next.session?.invite`; `/auth/invites` passes `[...keys, held.inviteKey]` when set, to `acceptInvite`, `declineInvite` and `offersFor`.

- [ ] **Step 1: Failing tests.** Helpers: `linkFor(key)` = seat the key as owner, read `link` from the 202; `openLink(link)` = `oauth(new URL(link).pathname)`; the sign-in through the page's GitHub button: parse `href="/authorize/github?req=…"` and the nonce cookie, then `githubCallback()` with that state (mirror `signIn()`'s steps; read it first).

```ts
it("opens a live invite: the org's name, the role, and provider buttons that start a panel sign-in", async () => {
  const link = await linkFor("email:nobody@example.org");   // an address GitHub does not report for 4242
  const page = await openLink(link);
  expect(page.status).toBe(200);
  const text = await page.text();
  expect(text).toContain("<bdi>Acme</bdi>");
  expect(text).toContain("as a member");
  expect(text).toMatch(/href="\/authorize\/github\?req=/);
  expect(page.headers.getSetCookie().join()).toContain(NONCE_COOKIE);
});
it("joins through the link under the subject, though the provider reports no such address", async () => {
  const link = await linkFor("email:nobody@example.org");
  const { page, cookie } = await signInThroughLink(link);   // stops at the invites page
  expect(buttons(page)).toEqual(["Join", "Decline", "Not now: continue signing in"]);
  const res = await answer(heldOf(page), "join", "org_acme", cookie);
  expect(res.status).toBe(302);
  expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_acme", role: "member", source: "invite" });
  expect(await plans.listOrgInvites("org_acme", 10)).toEqual([]);
});
it("answers 410 for a link whose invite was withdrawn, accepted, or has expired, and for a forged or malformed token", async () => {
  /* withdraw → 410 "expired or was withdrawn"; accept by the key's own sign-in → 410; clock past TTL → 410;
     signJwt with another secret → 410; signJwt with bellman: { orgId: "org_acme" } (no key) → 410 */
});
it("adds only the token's org, and only while that invite is live, when the key is invited elsewhere too", async () => {
  /* invite nobody@ to org_acme (link) and to org_b; expire acme's; sign in through acme's link: page shows Bee only */
});
it("attaches nothing to a sign-in whose token fails at the callback", async () => {
  /* a token signed with another secret inside SessionRequest.invite: sign-in completes as one without a link */
});
it("asks again through a resent link after a decline, and not through the old one", async () => {
  /* decline at T; resend at T+cooldown; open the new link → page; open the old link → page too (same row, invitedAt moved) */
});
it("shows an SSO-required org's link page with the SSO form and no provider buttons", async () => { /* PATCH acme requireSso; openLink → 200, no /authorize/github, the SSO form present */ });
it("sends a signed-in browser through a sign-in again: the link alone seats nobody", async () => {
  /* with a session cookie from a prior signIn(), openLink() still answers the page with provider buttons, and no grant exists */
});
```

- [ ] **Step 2: Run** `-t "link"`. Expected: FAIL (`/invite/…` is undefined from `handleOAuth`, so `oauth()`'s `!` throws).

- [ ] **Step 3: Implement.**
  - `GET /invite/:token` (`/^\/invite\/([^/]+)$/`) next to `/auth/signin`: panels empty → the same 503; `verifyInviteLink` null → `html(expiredPage, 410)`; `config.plans.invitesFor([key])` narrowed to `orgId` and `inviteLive(invite, Date.now())`, else 410; `getOrg` missing → 410; `org.requireSso` → page naming the org and "sign in through your organisation's single sign-on" with the SSO form only (reuse `signInBody` with `available = []`, `sso = true`); otherwise `signInBody("Join <drawn org> on Bellman", "<org> invited you to join it as <role>. Sign in to accept.", stateToken, available, false)` where `pending: SessionRequest = { return_to: panels[0], nonce, invite: token }`, signed and cookied exactly as `/auth/signin`. The heading takes the drawn name: check `signInBody` escapes its title; if it does, pass `drawnOrgName(org)` and let it escape.
  - `invitesHeld`: `const linked = await linkedOffer(config.plans, next.session?.invite, config)` (verify; `invitesFor([key])` narrowed to org, live; else undefined; errors → undefined with the existing log); `offersFor(plans, keys, subject, Date.now(), linked)` puts `linked` first in the merge; `held.inviteKey = linked?.key`.
  - `/auth/invites`: `const keys = [...grantKeys(identityKeys(held.profile)), ...(held.inviteKey ? [held.inviteKey] : [])]`; `offersFor` there passes `linked` re-read from `held.inviteKey` (an `invitesFor([inviteKey])` narrowed to live rows, any org named by it).
  - The expired page text: `<h1>This invitation has expired or was withdrawn</h1><p>Ask the person who invited you to send it again.</p>`.

- [ ] **Step 4: Run** the file, `tests/sso-flow.test.ts`, then `npm run verify`. Expected: PASS, rc=0.

- [ ] **Step 5: Commit**
```bash
git add src/oauth/routes.ts tests/seat-consent.test.ts
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 5/6: GET /invite/:token and the token-bound Join (ADR 0036, D2)"
```

### Task 6: Docs

**Files:**
- Modify: `docs-site/src/content/docs/guides/teams.md` ("Your org and its seats"; "The audit log" action list), `docs/ARCHITECTURE.md` (where it names the reports mailer, line ~1492), `wrangler.toml` (the `[[send_email]]` comment: the binding sends invites too, and reaches any address once bellman.sh is onboarded to Email Service).
- Test: `tests/docs-reference.test.ts` (no tool changed; run it), `npm --prefix docs-site run build`.

- [ ] **Step 1: Write** the guide paragraph after the invites paragraph: an address invite is mailed from invites@bellman.sh with a link; the link opens a page naming the org and role and starts a sign-in; joining through it works even when the provider does not report the address; every invite expires after 14 days and the roster marks it `expired`; `POST /org/members/<key>/resend` sends a fresh link and extends it, at most once every ten minutes; the 202 and the resend carry `link` and `mailed`, and `mailed: false` means the admin hands the link on. Add `invite_resent` to the audit actions. ARCHITECTURE: one sentence beside the reports mail. Verify no stray "two sessions" wording.

- [ ] **Step 2: Run** `npm run verify > .vitest/verify6.txt 2>&1; rc=$?; tail -8 .vitest/verify6.txt; echo rc=$rc` and `npm --prefix docs-site run build > .vitest/docs6.txt 2>&1; rc=$?; tail -3 .vitest/docs6.txt; echo rc=$rc`. Also `rtk proxy npx wrangler deploy --dry-run > .vitest/dry6.txt 2>&1; tail -3 .vitest/dry6.txt` (nothing new is bound, but the deploy path is not the check path).
Expected: all rc=0.

- [ ] **Step 3: Commit**
```bash
git add docs-site/src/content/docs/guides/teams.md docs/ARCHITECTURE.md wrangler.toml docs/adr/0036-invites-by-email.md docs/superpowers/specs/2026-10-23-org-invites-by-email-design.md docs/superpowers/plans/2026-10-23-org-invites-by-email.md
git -c commit.gpgsign=true commit -S -m "Invites by email (#54), 6/6: the teams guide, ADR 0036, spec and plan"
```
