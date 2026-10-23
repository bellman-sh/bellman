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

## The admin role

A person's org role is `member` or `admin`, and it is not a room role. Inside a room an org admin holds exactly what their seat holds: the org role buys nothing there. An admin whose seat lacks `invite` cannot mint a code, and an admin with no seat has no verbs in the room at all. The admin role matters in two places, the audit log and the read of closed rooms below.

## Your org and its seats

An org is a record: a name, one owner, a count of seats, and whether anyone is paying for it. Buying the team plan creates one, named for the buyer until they rename it, and makes the buyer its owner and admin. A seat is a person in the org, the owner included, and the subscription says how many there are.

An admin seats a teammate by a stable identity: `github:<numeric id>`, `google:<numeric id>`, or an email address, which the first sign-in with that address claims onto its subject. The control panel does this; underneath, it is `POST /org/members` with `{ key, role }`, and `GET /org` shows the name, the seats and how many are used. The owner stays an admin and cannot be removed. When every seat is taken, adding one more is refused until a seat is freed or more are bought.

A seat takes effect at once only for someone the org owns by its form: a subject of its own identity provider, or an address under a domain it has verified. Anyone else is invited. The org gets nothing of theirs until they accept: not their sign-in, their plan, the rooms they sit in or its audit of them. Their next sign-in stops at a page that names the org, with **Join**, **Decline**, and a way to carry on without answering, which asks again next time. Joining takes a seat, so a full org refuses it, and so does an org that requires single sign-on, which they join by signing in through it. Declining is kept on their side: the invitation stops showing for them, and stays pending for the org's admins, who see no change. An invitation the org makes after the decline asks again. An invite takes no seat. `GET /org/members` lists invites after the members, each marked `invited`, `POST` answers `202` for one, and `DELETE /org/members/<key>` withdraws it.

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
3. **Assign people.** A push seats the person as a member, within the seats, under their email address. Someone who already signed in through SSO, or whom an admin already seated by that address, is linked rather than seated again, and keeps the role they had. The first sign-in after a push claims the seat onto the IdP's subject.

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
- The org itself: `org_created` when it was bought or set up, and `org_updated` naming what changed, such as its name, its seats, its standing or `require_sso`; `idp_configured` and `idp_removed`; `domain_claimed`, `domain_verified` and `domain_released`; and `member_invited` and `invite_withdrawn`, naming the key the admin entered. A person's answer to an invite adds no entry of its own: a Join is its `plan_granted`.

A room that crosses organisations writes to both orgs' logs, so each side sees the crossings that touched its own boundary and nothing else.

## Reading and deleting closed rooms

An open room stays its members' alone. While it runs, the audit log is an admin's window into it. Once a room has closed, an org admin can read it if one of the org's people ever sat in it, including one who left or was removed, even though the admin never held a seat. The admin reads the room's record, its surface, its log and its files. It is a read: an admin writes nothing to the room, and a surface write or an upload from one is refused.

No tool lists these rooms, so an admin asks the server with `GET /rooms?as=admin`, which returns the newest 50 by close, with `truncated: true` when the list is cut short.

A closed room's creator, or an admin of an org that sat in it, can delete it. The creator can use Delete room on the room's page in the control panel, which asks twice because the room's log, surface and files go for good. An admin who is not the creator uses `DELETE /rooms/:id`. The answer carries the time the room is stored to go, and the purge follows within moments. An open room cannot be deleted: a room is deleted after it closes, never before.

## Buying the team plan

Buying the team plan makes the buyer the admin of an org named for their user id, `org_<userId>`, and its admins seat and invite people as [Your org and its seats](#your-org-and-its-seats) describes.
