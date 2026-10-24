# Invites by email (#54)

**Date:** 2026-10-23 · **Closes:** #54 · **ADR:** 0036 (amends 0027) · **Builds on:** ADR 0024 (orgs), 0025 (SSO), 0027 (seat consent), 0029 (SCIM)

## The problem

ADR 0027 built most of #54 before #54 was read against it: an invite record apart from the
grants, a pending state the roster lists, withdrawal, and an acceptance page at the next
sign-in. What is still missing is what the issue leads with: nothing tells the invited person.
An admin who types `email:ana@example.com` creates a row that only applies when Ana signs in
with a provider that reports that address, and Ana hears nothing. An admin cannot send it again,
and an invite never lapses.

## Decisions

### D1. Delivery goes through a `send_email` binding, as the reports' does

`src/reports.ts` has `MailBinding`, the builder form of Cloudflare's `send_email` binding, and a
mailer that logs and swallows a failed send. Invites take a binding of their own, `INVITE_EMAIL`,
with no destination fixed (the reports' `SEND_EMAIL` reaches support@ alone), through a second
mailer, `inviteMailer(binding, issuer)` in a new runtime-free module `src/invite-mail.ts`:

```ts
export const INVITE_FROM = "invites@bellman.sh";
export function inviteMail(org: Org, role: OrgRole, link: string, expiresAt: number): { subject: string; text: string };
export type InviteMailer = (to: string, org: Org, invite: OrgInvite, link: string) => Promise<boolean>;
export function inviteMailer(binding: MailBinding | undefined): InviteMailer;
```

The subject is `Join <org> on Bellman`; the text names the org and the role, carries the link
on its own line, says when it expires, and says to ignore it if unexpected. The org's name is
`drawnOrgName(org)` with any CR or LF removed, so an admin's text cannot reach a header. The
mailer answers `true` when the binding accepted the message and `false` when there is no binding
or the send threw; both are logged as the report mailer logs, naming the org and the key, never
the address. The Node server (`src/app.ts`) passes no binding, as it does for reports.

What makes the binding send to any address: the sending domain onboarded to Cloudflare Email
Service. Email Routing alone sends only to verified destinations (the reports' support@), and a
send to anyone else fails with `E_SENDER_NOT_VERIFIED`, which the log line names. Until the
domain is onboarded, every invite is created and answered with `mailed: false` and the link, so
an admin can pass it on by hand. No SMTP, no provider, no new secret.

### D2. The link: a signed token that opens the invite, and a sign-in that carries it

`POST /org/members` with an `email:<address>` key mails a link to the address:

`<issuer>/invite/<token>`, where `token` is a JWT signed with the server's secret, audience
`bellman:invite`, `bellman: { orgId, key, at }`, where `at` is the invite's `invitedAt`,
expiring when the invite does (D3). The token is not stored: the invite row is the single-use
part, and a link opens only the row whose `invitedAt` it names. A withdrawn or accepted invite
makes every link to it dead, and so does a resend (D4), which moves `invitedAt`; a withdrawn
invite issued again is a new row that no earlier link opens.

`GET /invite/<token>` (in `src/oauth/routes.ts`, beside `/auth/signin`) verifies the token,
reads the invite (`invitesFor([key])` narrowed to the org) and the org, and shows one page:
the org's name (`drawnName`), the role, what joining means (the invites page's paragraph), and
the provider buttons of `/auth/signin`, each starting a panel sign-in whose `SessionRequest`
carries the token's verified claim, never the token: that state is sent to the provider. The page sets the sign-in nonce cookie as `/auth/signin` does. A token
that fails to verify, an invite that is gone, or one that has expired answers one page, 410:
"This invitation has expired or was withdrawn. Ask the person who invited you to send it
again." No panel origin configured answers 503 as `/auth/signin` does.

At the callback, `invitesHeld` reads `session.invite`: a token that verifies and names a live
invite is added to the offers (first, before the keys' own), and the held sign-in carries
`inviteKey`, the invite's key, so that Join and Decline and every redraw pass
`[...grantKeys(identityKeys(profile)), inviteKey]` to the store. `acceptOrgInvite` is unchanged:
it finds the invite under that key and writes the grant on the subject key, so the person who
clicked the link joins whatever their provider reported. A token that does not verify at the
callback is ignored: the sign-in carries on as one without a link.

A signed-in person who opens the link signs in again. One page and one path, and the invite is
attached only after a provider has just asserted who this is and the nonce cookie has bound that
to this browser: the link alone attaches nothing.

The declined-orgs filter applies to a link's offer as to any other: a resend after a decline
asks again because it moves `invitedAt` (D4).

### D3. Every invite expires

`OrgInvite` gains `expiresAt: number`. `INVITE_TTL_MS` is 14 days; `putOrgInvite` and the
route set `expiresAt = invitedAt + INVITE_TTL_MS`. A row written before the field reads as
`invitedAt + INVITE_TTL_MS` (lifted at the read in both stores, as `Org.policy` was).

`inviteLive(invite, now)` in `src/orgs.ts` is the one rule. `offersFor` drops an expired
invite; `acceptOrgInvite` answers `"gone"` for one, in both stores, inside the transaction. The
roster still lists it, with `status: "expired"` in place of `"invited"`, and every view carries
`expires_at`, so an admin can resend or withdraw it; it counts toward `MAX_PENDING_INVITES`
until withdrawn. No sweeper: an expired row costs one listing slot and nothing else.

This amends ADR 0027's consequence that invites do not expire. The seats ADR 0027 reads as
offers (an unowned seat an org no longer owns by form) are grants, not invites, and do not
expire.

### D4. Resend

`POST /org/members/<key>/resend` (admin, behind the org router's CSRF gate) renews the invite:
`invitedAt = now`, `expiresAt = now + INVITE_TTL_MS`, `invitedBy = this admin`, and mails a
fresh link when the key is an address. Store method, both stores and the contract suite:

```ts
renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing">;
```

It appends `invite_resent` `{ key }` to the org's stream (a new audit action beside
`member_invited`). The route answers 404 `missing` when no invite holds the key, 429 `cooldown`
when the invite was issued or renewed less than `RESEND_COOLDOWN_MS` (10 minutes) ago, read
before the renewal (two admins resending at once mail twice, which is harmless), and otherwise
200 with the same body as a 202 (D6).

### D5. A full org refuses to invite

The invite path of `POST /org/members` answers 409 `full` when `countOrgMembers(orgId) >=
org.seats`, before writing. An invite still takes no seat (ADR 0027): acceptance re-checks, and
two invites to one free seat race at the Join as they do today. The check spares the person a
mail whose link can only say "full".

### D6. What the API answers

`inviteView` gains `expires_at` and the `"expired"` status. The 202 of an invite and the 200 of
a resend are:

```json
{ "member": { "key": "email:ana@example.com", "user_id": null, "role": "member", "status": "invited",
              "invited_at": "…", "invited_by": "u_github_1", "expires_at": "…" },
  "link": "https://mcp.bellman.sh/invite/eyJ…", "mailed": true }
```

`link` is always returned, for an address or any other key: the admin who made the invite may
hand its link on, and a `github:` invite reaches its person the same way. `mailed` is `false`
for a key that is not an address, and for an address the binding could not send to. The roster
(`GET /org/members`) never carries links.

### D7. What stands from ADR 0027

- A seat on a key the org owns by its form (a verified domain, its own IdP) still takes effect
  without an invite. Domain capture beyond that is not added: a verified domain already owns
  its addresses, and a personal account under an unverified one is nobody's to absorb.
- Accepting never moves a grant another org or a purchase holds: `"taken"`, as today. The
  link's key joins the keys read, so an address another org seated by its form answers
  `"taken"` to a link accepted under a provider that reports no address.
- An `email:` invite still applies at a sign-in whose provider reports the address, with no
  link: the link is a second way to the same row.
- An org that requires SSO still answers `"sso"` at the Join; the link page for such an org says
  to sign in through the organisation's single sign-on and shows no provider buttons.

## Out of scope

The dash's invite form, pending list with resend and withdraw, and link copy (a dash issue after
merge). Bounce handling: Email Service reports none to the Worker. A sweeper for expired rows.
HTML mail.

## Docs

`docs-site/src/content/docs/guides/teams.md`, "Your org and its seats": the email invite, the
link, expiry, resend, and the `mailed: false` case. ADR 0036. `docs/ARCHITECTURE.md` names the
second mailer where it names the first, if it does.
