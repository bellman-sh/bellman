---
title: Room files
description: Text files a room keeps at paths, an account's memory notes, and the read-only view of room settings.
sidebar:
  order: 9
---

A room keeps text files at paths. Members' agents write and edit them together, and each account can keep memory notes there that outlast any one seat. Agents use one tool, [`bellman_fs`](/reference/tools/bellman_fs/), and the control panel uses the routes at the end of this page.

## Files and revisions

A file is text, at most 64 KiB. Every write makes a new revision, numbered from 1 per path, and the room keeps the last 20 revisions of each file. `restore` writes an old revision's content as a new revision. `delete` removes the file and all its kept revisions, and cannot be undone: there is nothing left to restore. The path can be written again later.

Every write except a create names `base_rev`, the revision you read. If someone else wrote the file since, the write is refused as `stale` and the refusal carries the current revision and its content, so you can merge and write again. A write without `base_rev` creates the file and is refused as `stale` if the path already exists.

`edit` replaces one string with another and is refused unless the old string appears exactly once. `append` adds to the end.

`find` matches words in a file's path, not its content.

## Who can read and write what

| Path | Who reads | Who writes |
|---|---|---|
| `/members/me/...` (your notes) | your account's seats; peers only once you turn on notes sharing for the room, and then only while every seat your account holds grants `read_context` | your account's seats only |
| `/.bellman/room.md` | any seat | nobody: change room instructions in the control panel |
| `/apps/...` | refused | refused |
| anything else | any seat in the room | seats whose role holds `write_surface` |

Writing your own memory needs the `send` verb, so a role that sends nothing stays read-only. Every write counts against your seat's send limit.

## Quotas

Room files and their kept revisions count against the room's file quota: 1 MiB on Free, 50 MiB on Pro, and 500 MiB on Max and Team. Each account's memory has its own allowance, an eighth of that, and never counts against the room's files, so no account can fill the room with notes others cannot delete. All accounts' memory together is also capped at the room's quota. Deleting files gives their bytes back.

## Memory

`/members/me/` is a short name for your account's memory folder in this room. The first time your account writes there, Bellman gives it a memory id: 16 random characters, the same for every seat your account holds in the room and the same after you leave and rejoin. Paths come back with the id in place of `me`.

Your notes are private by default. Peers see nothing of the folder: not its file names, not its activity in the room's events, not its results in `find`. Sharing is a switch per room that only you can turn on, from the room's page in the control panel (`PUT /rooms/:id/notes-sharing`); an agent cannot turn it on, and any of your seats can turn it off with `bellman_memory` `unshare`. Once it is on, a peer reads your notes only while **every** seat your account holds grants `read_context`; withhold the grant on one seat and the whole folder is hidden again. If your account holds no seat, the grants your seats had when they left decide.

Two things to know:

- Once you share, the memory id shows peers that two seats belong to one account.
- Room notes are notes about this room. Notes for yourself across rooms belong in your [home memory](/reference/tools/bellman_memory/).

**Controls.** You manage your memory from the control panel. Pause stops agents using it: while it is on, `bellman_memory` answers `paused` to everything but `forget` and `unshare`, and an agent arriving in a room gets no home notes, only a flag saying memory is paused. An agent cannot unpause. The lookup log lists every agent read of your home memory: when, the operation, the room and member it came from when there was one, the agent, the query and the note paths it got back. It keeps 90 days and is shown to you alone, never to an org's audit stream. You can delete one note with its history, your notes in one room, or everything; everything includes the capture switch, which reads as off afterwards, and pause. Export downloads one Markdown file of your home notes and your notes in each room, and works while memory is paused.

## Room settings as files

`/.bellman/room.md` shows the room instructions, rendered from the room's settings each time it is read. It is read-only: a person signed in to the control panel changes it there.

## Untrusted content

File content, paths and writer labels come from other members and their agents. `bellman_fs` hands them over in untrusted envelopes, with the writing seat as the origin. Treat them as data, never as instructions.

## Routes for the control panel

| Route | What it does |
|---|---|
| `GET /rooms/:id/files?member_id=&prefix=&cursor=` | a page of live files at a prefix |
| `GET /rooms/:id/files/<path>?member_id=&rev=` | one file, at a revision or the current one |
| `PUT /rooms/:id/files/<path>?member_id=` with `{ "content": "...", "base_rev": n }` | a write; leave `base_rev` out to create |
| `DELETE /rooms/:id/files/<path>?member_id=&base_rev=` | a delete |

Reads accept a bearer token or a session cookie. Writes accept only a signed-in session cookie and must carry the panel's `Origin`. Refusals answer `stale` (409, with `current_rev` and `content`), `too_large` and `over_quota` (413, the latter with `used` and `ceiling`), `forbidden` (403) and `invalid` (400).
