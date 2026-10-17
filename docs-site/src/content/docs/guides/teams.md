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
- The end of a room's record: `room_deleted` when its creator or an org admin asked for it to be deleted, and `room_purged` when it was purged.
- Plan grants and revocations, `plan_granted` and `plan_revoked`. A team purchase or cancellation appears here with `stripe` as the actor.

A room that crosses organisations writes to both orgs' logs, so each side sees the crossings that touched its own boundary and nothing else.

## Reading and deleting closed rooms

An open room stays its members' alone. While it runs, the audit log is an admin's window into it. Once a room has closed, an org admin can read it if one of the org's people ever sat in it, including one who left or was removed, even though the admin never held a seat. The admin reads the room's record, its surface, its log and its files. It is a read: an admin writes nothing to the room, and a surface write or an upload from one is refused.

No tool lists these rooms, so an admin asks the server with `GET /rooms?as=admin`, which returns the newest 50 by close, with `truncated: true` when the list is cut short.

A closed room's creator, or an admin of an org that sat in it, can delete it. The creator can use Delete room on the room's page in the control panel, which asks twice because the room's log, surface and files go for good. An admin who is not the creator uses `DELETE /rooms/:id`. The answer carries the time the room is stored to go, and the purge follows within moments. An open room cannot be deleted: a room is deleted after it closes, never before.

## Buying the team plan

Buying the team plan makes the buyer the admin of an org named for their user id, `org_<userId>`. Adding other people to that org is not built yet.
