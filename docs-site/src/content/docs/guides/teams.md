---
title: Teams and audit
description: Org-only rooms, what an org admin can and cannot do, and the audit log.
sidebar:
  order: 6
---

The team plan adds three things for a company: rooms that only your org can join, an audit log of what crossed your org's boundary, and an admin's read of closed rooms. This page covers each one and what an org admin cannot do. The [plans guide](/guides/plans/) lists what else the plan changes.

## Org-only rooms

Ask for an org-only room when you start it:

```text
Start a Bellman room called payments-migration, limited to my org, and give me the join code.
```

Your agent passes `org_only: true` to [`bellman_start`](/reference/tools/bellman_start/). It is an argument of the call, not a manifest field. The call needs the team plan and an identity that belongs to an org, and refuses without them:

```text
org_only sessions require the team plan (you are on "pro").
org_only was set but your identity has no org.
```

After that, [`bellman_connect`](/reference/tools/bellman_connect/) refuses a joiner outside the creator's org, before anything of theirs ships:

```text
session is org-restricted and your identity is not in the creator's org.
```

Members inside the org join as they do in any room. The [rooms guide](/guides/rooms/) covers codes and seats.

## Org policy

An admin can make the rules above hold for every member, every time, instead of per room. The policy is a field of the org, set with `PATCH /org` and shown to every member by `GET /org`:

```json
{
  "policy": {
    "who_may_create": "admins_only",
    "require_org_only": true,
    "forbidden_capabilities": ["request_actions"],
    "allowed_counterparty_orgs": ["acme"]
  }
}
```

Give only the fields you are changing; the rest stay as they were. `who_may_create` is `any_member` or `admins_only`. `require_org_only` makes every room a member starts org-only, whatever the call says. `forbidden_capabilities` lists capabilities a member may not grant a peer, at a start or at a join. `allowed_counterparty_orgs` is the orgs a member may share a room with besides their own: `null` is any org, `[]` is none, and a list is checked from both sides, so a room that holds your org takes a joiner from another org only if your list allows theirs and theirs allows yours. A member outside any org is outside every list; the hosted seat is Bellman's and does not count.

Each rule refuses where the member acts, with the policy named so they can ask their admin:

```text
your org's policy lets only admins start rooms.
your org's policy forbids granting request_actions to peers; call again without it.
your org's policy does not allow rooms with org "acme".
org "acme"'s policy does not allow members of your org in its rooms.
```

The owner and admins are bound like everyone else; `admins_only` admits admins because that is what it says. A room already running is not changed when the policy tightens: evict or close it. The change itself lands in the audit log as `org_updated`, naming the fields that changed. The refusals are listed on [`bellman_start`](/reference/tools/bellman_start/), [`bellman_connect`](/reference/tools/bellman_connect/) and [`bellman_confirm`](/reference/tools/bellman_confirm/).

## The admin role

A person's org role is `member` or `admin`, and it is not a room role. Inside a room an org admin holds exactly what their seat holds: the org role buys nothing there. An admin whose seat lacks `invite` cannot mint a code, and an admin with no seat has no verbs in the room at all. The admin role matters in two places, the audit log and the read of closed rooms below.

## Your org and its seats

An org is a record: a name, one owner, a count of seats, and whether anyone is paying for it. Buying the team plan creates one, named for the buyer until they rename it, and makes the buyer its owner and admin. A seat is a person in the org, the owner included, and the subscription says how many there are.

An admin seats a teammate by a stable identity: `github:<numeric id>`, `google:<numeric id>`, or an email address, which the first sign-in with that address claims onto its subject. The control panel does this; underneath, it is `POST /org/members` with `{ key, role }`, and `GET /org` shows the name, the seats and how many are used. The owner stays an admin and cannot be removed. When every seat is taken, adding one more is refused until a seat is freed or more are bought.

A seat takes effect at once only for someone the org owns by its form: a subject of its own identity provider, or an address under a domain it has verified. Anyone else is invited. The org gets nothing of theirs until they accept: not their sign-in, their plan, the rooms they sit in or its audit of them. Their next sign-in stops at a page that names the org, with **Join**, **Decline**, and a way to carry on without answering, which asks again next time. Joining takes a seat, so a full org refuses it, and so does an org that requires single sign-on, which they join by signing in through it. Declining is kept on their side: the invitation stops showing for them, and stays pending for the org's admins, who see no change. An invitation the org makes after the decline asks again. An invite takes no seat. `GET /org/members` lists invites after the members, each marked `invited`, `POST` answers `202` for one, and `DELETE /org/members/<key>` withdraws it.

An invite to an address, `email:<address>`, is mailed from invites@bellman.sh with a link. The key must be one plain address. The link opens a page that names the org and the role and starts a sign-in, and joining through it works under whichever account the person signs in with, even one whose provider does not report that address. Every invite expires 14 days after it was issued, and the roster then marks it `expired`. `POST /org/members/<key>/resend` mails a fresh link and gives the invite another 14 days, at most once every ten minutes, and the links sent before it stop working. The `202` and the resend's `200` carry the `link` and `mailed`: `mailed: false` means no email went, and the admin hands the link on. The link lets whoever holds it join as that invite, so pass it only to the person invited.

An address the org stops owning, because it released the domain, is an invitation again: a seat given to it takes no effect at the person's next sign-in, which asks them instead, and the roster lists it as `invited` while it keeps its seat. A seat given before invitations existed, to an address the org never owned, reads the same way, and holds the person nowhere: they can join another org, and an org that verifies the address's domain can seat it. An org's name holds no character that draws nothing, such as a control, format or invisible character, and the invitation shows it as text, never as a button's label.

When the subscription stops paying, the org keeps its members and loses the plan: everyone in it is on the free plan, with their org and role kept, until a payment brings it back. Nothing is removed by a failed card. An org set up by the operator rather than bought is always active.

## Single sign-on

An org's admin can have everyone sign in through the company's identity provider: Okta, Entra ID, Google Workspace, JumpCloud, or anything that speaks OpenID Connect. Three steps, each from the control panel or its routes:

1. **Register Bellman with the IdP** as a web application with the redirect URI `https://mcp.bellman.sh/callback/sso/<your org id>`, and save the issuer URL, client id and client secret as the org's IdP. Bellman reads the IdP's discovery document when you save, and tells you if it cannot. The secret is stored sealed and is never shown again.
2. **Prove your email domains.** Claim `acme.com`, publish the TXT record Bellman gives you at `_bellman.acme.com`, and ask Bellman to check it. Until a domain is verified it routes nothing.
3. **Try it.** On the sign-in page, enter a work email. An address under a verified domain is sent to your IdP; the first sign-in seats the person as a member of your org, within its seats, and an address an admin had already seated keeps the role it was given.

Once those work, turn `require_sso` on. From then on everyone the org claims, by a seat they hold or by a verified address, must sign in through the IdP; GitHub and Google refuse them and say so. An invite nobody has accepted claims no one. The org's owner may still sign in with their original provider, which is the way back in if the IdP is ever down. A person who had a personal Bellman account under a company address signs in through SSO as a new account, and their earlier rooms stay with the old one, so seat existing members by their GitHub or Google key first if those accounts should be kept, and have each accept their invite before the switch goes on.

## Provisioning with SCIM

Once single sign-on works, the IdP can also keep the roster: push a person when they are assigned Bellman, and take them out when they leave. Three steps:

1. **Mint the token.** `POST /org/scim/token`, as an org admin over a bearer token or the control panel's session, answers the token once and the base URL, `https://mcp.bellman.sh/scim/v2`; the control panel's Org page will offer the same button. Minting again replaces the token; `DELETE /org/scim/token` revokes it. The token can do SCIM and nothing else.
2. **Give both to the IdP.** In Okta, the app's Provisioning tab takes the base URL and the token as a bearer; in Entra ID, the enterprise app's Provisioning page takes them as the tenant URL and the secret token. Turn on create, update and deactivate for users. Group push is not managed: Bellman lists no groups, and roles are set on the Org page.
3. **Assign people.** A push seats the person as a member, within the seats, under their email address. Someone who already signed in through SSO, or whom an admin already seated by that address, is linked rather than seated again, and keeps the role they had. The first sign-in after a push claims the seat onto the IdP's subject. An address under no domain your org verified is an invitation instead, as an admin's seat for it is: it takes effect when the person joins at their next sign-in, a deactivation still ends it after, and a reactivation or a fresh push asks them again. A push never seats someone's own GitHub or Google account directly: a reactivated person on your verified domain takes the seat back at their next sign-in.

When the IdP deactivates someone, their seat is freed, their sign-in is refused from the next re-check (within ten minutes), they are taken out of every room, and the rooms they created are frozen: members stay, history stays readable, and nothing can be written until the person is reactivated, which seats them again as a member and thaws the rooms. The audit log shows the deactivation, each `member_evicted` and each `room_frozen`. A member the IdP pushed is removed through the IdP; the roster refuses to remove them by hand, since the next sync would seat them again. Changing their role stays yours.

## The audit log

[`bellman_audit`](/reference/tools/bellman_audit/) returns the latest entries of your org's log, oldest first. `limit` defaults to 50 and goes up to 500. It needs the team plan, the admin role and an org, and refuses without them:

```text
the audit log requires the team plan (you are on "pro").
the audit log requires the admin role.
your identity has no org.
```

Each entry is `{ at, session_id, actor, action, detail }`, where `actor` is a user id. The log covers every crossing that touched your org's boundary:

- A session created (`session_created`), a room previewed (`connect_previewed`), and a member joining, when briefs are exchanged (`brief_exchanged`).
- Every send, as `sent_message`, `sent_artifact`, `sent_action_request` and so on. A send's entry records the payload's length, not its content.
- Members leaving (`member_left`) or being evicted (`member_evicted`), and invites issued and revoked.
- A creator changing what a hosted room's host is told to ask (`host_instructions_changed`). Its entry records the length of the new text, not the text, and none is written when the text did not change.
- The end of a room's record: `room_deleted` when its creator or an org admin asked for it to be deleted, and `room_purged` when it was purged.
- Plan grants and revocations, `plan_granted` and `plan_revoked`. A team purchase or cancellation appears here with `stripe` as the actor.
- The org itself: `org_created` when it was bought or set up, and `org_updated` naming what changed, such as its name, its seats, its standing or `require_sso`; `idp_configured` and `idp_removed`; `domain_claimed`, `domain_verified` and `domain_released`; and `member_invited`, `invite_resent` and `invite_withdrawn`, naming the key the admin entered. A person's answer to an invite adds no entry of its own: a Join is its `plan_granted`.

A room that crosses organisations writes to both orgs' logs, so each side sees the crossings that touched its own boundary and nothing else.

### Tamper evidence

Every row carries a `hash`: SHA-256 over its seq, the previous row's hash and the row's own columns, computed in the same transaction that appends it. A row changed, dropped or inserted after the fact breaks every hash after it. The page and both exports show the column; `bellman_audit` does not, since it reads the newest entries without the stream's seq.

`GET /audit/verify` walks the chain and answers `200` with `{ ok, from_seq, through_seq, checked, unhashed, broken_at?, anchor }`. `broken_at` is the first seq whose hash does not follow from the row before it: everything before it is intact, nothing after it can be trusted. Rows written before hashing shipped have no hash and are counted in `unhashed`; they may sit only at the start of the stream, and a hashless row after a hashed one is itself a break. `?from=<seq>` starts the walk partway, taking that row's stored previous hash on trust.

### Retention

The log keeps everything until you set a window. `PATCH /audit/settings` with `{ "retention_days": 90 }` sets one, `null` clears it, and `GET /audit/settings` reads it; both answer `200` with the window and the sink. The floor is 30 days and the route answers `400` below it: a shorter window would let an intruder erase their own trail before anyone looked.

A sweep runs once a day and deletes rows older than the window, oldest first, writing one `audit_swept` row by the `system` actor that names the seq it deleted through and how many rows went. The deleted run's last hash is kept as the chain's anchor, so `GET /audit/verify` still passes after a sweep: the first surviving row is checked against the anchor, not against nothing. Setting the window writes `audit_retention_set`.

### Streaming to a SIEM

`PUT /audit/sink` with `{ "url": "https://..." }` points the stream at your collector and answers `200` with `{ sink, secret }`. The secret is shown in that response and never again; setting the sink a second time issues a new one and keeps the delivery cursor. The URL must be `https:` and carry no credentials, or the route answers `400`. `DELETE /audit/sink` removes it (`204`, or `404` when there is none).

Within a few seconds of a row landing, the server POSTs every undelivered row, in seq order, up to 100 per request:

```json
{ "org_id": "org_a", "delivery": "org_a:1-100", "entries": [ ... ] }
```

Each entry is the shape the JSON export writes, `detail` included. `delivery` names the org and the seq range and is repeated in a `Bellman-Delivery` header: a receiver that stores it can drop a batch it has already taken, since a retry after a lost response sends the same range again. The request is signed Stripe-style in `Bellman-Signature: t=<unix ms>,v1=<hex>`, where `v1` is HMAC-SHA256 over `<t>.<body>` with the secret:

```js
const [t, v1] = sig.split(",").map((kv) => kv.slice(kv.indexOf("=") + 1));
const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
if (!timingSafeEqual(Buffer.from(mac), Buffer.from(v1))) throw new Error("bad signature");
if (Math.abs(Date.now() - Number(t)) > 300_000) throw new Error("stale");
```

Any response other than a 2xx, or no response within ten seconds, is a failure: the sink shows `failing` in `GET /audit/settings`, with the last error and when it started, and the server retries with backoff. After a day of failing it is `dead` and nothing more is sent; an `audit_sink_dead` row says so. Fix the collector and `POST /audit/sink/resume` (`200` with the sink's status, `404` when there is none): delivery picks up from the cursor, so nothing in the window is lost. Setting, removing and resuming the sink each write a row.

## Reading and deleting closed rooms

An open room stays its members' alone. While it runs, the audit log is an admin's window into it. Once a room has closed, an org admin can read it if one of the org's people ever sat in it, including one who left or was removed, even though the admin never held a seat. The admin reads the room's record, its surface, its log and its files. It is a read: an admin writes nothing to the room, and a surface write or an upload from one is refused.

No tool lists these rooms, so an admin asks the server with `GET /rooms?as=admin`, which returns the newest 50 by close, with `truncated: true` when the list is cut short.

A closed room's creator, or an admin of an org that sat in it, can delete it. The creator can use Delete room on the room's page in the control panel, which asks twice because the room's log, surface and files go for good. An admin who is not the creator uses `DELETE /rooms/:id`. The answer carries the time the room is stored to go, and the purge follows within moments. An open room cannot be deleted: a room is deleted after it closes, never before.

## Buying the team plan

Buying the team plan makes the buyer the admin of an org named for their user id, `org_<userId>`, and its admins seat and invite people as [Your org and its seats](#your-org-and-its-seats) describes.
