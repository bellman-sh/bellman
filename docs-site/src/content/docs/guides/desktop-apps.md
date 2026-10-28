---
title: Desktop apps
description: How a desktop app or the control panel lists a person's rooms, keeps them live, and mints join codes.
sidebar:
  order: 8
---

A desktop app that shows a person's rooms, or the control panel, needs three things: the list of rooms with their seats, the changes inside each room as they happen, and a way to hand someone a join code. This page covers the calls for each.

## Signing in

An app signs in as its own OAuth client. It discovers the authorization server at `/.well-known/oauth-authorization-server`, registers itself at `POST /register`, and signs in with PKCE and a loopback redirect. It then sends the access token as `Authorization: Bearer <token>` on every call below. The control panel sends its session cookie instead, and every write it makes must carry the panel's `Origin`.

There are no per-user API keys. An app that can open a browser can sign in.

## The rooms list

```http
GET /me/rooms
```

This returns `{ rooms[] }`: the open rooms the caller holds a seat in, in the same shape [`bellman_rooms`](/reference/tools/bellman_rooms/) returns. Each room includes its members with `status` (`working`, `idle` or `needs_you`) and where that status came from, `needs_you_count`, your seats and what each may do, and the room's live join codes. Closed rooms, and rooms you left or were removed from, are not listed. Peer-written text arrives in untrusted envelopes. Render it as text, never as markup.

Call it:

- at launch
- on wake from sleep
- after a change the app made itself, such as joining or leaving a room
- on a slow reconcile, about every 60 seconds, which picks up a room joined from another machine

The response carries no ETag. Every call reads every room, so poll it slowly. For anything faster, use the room socket.

## Live changes in a room

Open one socket per room:

```http
GET /ws?session=<session_id>&cursor=<last cursor you hold>
Upgrade: websocket
Authorization: Bearer <token>
```

Each frame is one event of the room's log, in JSON, starting after `cursor`. A seat's status change is a `progress` event and an action request is an `action_request` event, so the frames that move a seat's status arrive here. Re-read `GET /me/rooms` when one does.

On reconnect, pass the last cursor you received. If more than 1,000 events have passed, the socket is refused with a 410. Catch up with `GET /rooms/<session_id>/events?after=<cursor>`, which returns up to 200 events per call and the cursor to pass next, then reconnect. If three reconnects in a row fail, poll that route instead.

The socket only receives. Every write goes through a tool call on `/mcp` or a route on this page. A socket can also be late or miss a frame, so `GET /me/rooms` is the authority and the socket is a convenience.

The control panel's cookie does not open a socket yet.

## Starting a session in a room

To start a Claude Code session already seated in a room, mint a code (below) and launch `claude` with it in the environment:

```sh
BELLMAN_JOIN_CODE=<join_code> claude
```

The session's Bellman bridge previews the room and joins it with a brief that names only the project folder. It never joins a public room on its own. The code stays in the bridge's memory and is not written to disk or into the transcript.

With the Bellman plugin installed, a SessionStart hook prints one line saying what happened: the room, the role and what that role may do, or why the bridge did not join. The reasons are an expired, used or refused code, a public room, a sign-in that did not finish, or no Bellman bridge in the session. Codes last 15 minutes, so mint one when you launch the session, not ahead of time.

`BELLMAN_JOIN_CODE` is the only setting. The code already names the room and the role.

## Minting a join code

```http
POST /rooms/<session_id>/codes
Content-Type: application/json

{ "member_id": "<your seat in the room>", "role": "reviewer" }
```

This mints a join code exactly as [`bellman_invite`](/reference/tools/bellman_invite/) does. The seat named by `member_id` must hold the `invite` verb. Replacing a role's live code also needs `revoke`. Leave out `role` to mint for the room's default seat. A code minted here expires after 15 minutes.

It answers `201` with `{ join_code, join_url, expires_at, role, replaced_previous }`. Hand the `join_url` to the person joining.

| Status | When |
|---|---|
| 400 | The body is anything but `member_id` and an optional `role` |
| 401 | No credential |
| 403 | The seat lacks the verb, the `member_id` is not yours, or a cookie call carries no panel `Origin` |
| 404 | No such room |
| 409 | The role's live code is the public room's permanent link (change that with `bellman_invite`), or the room is full, frozen or closed |
