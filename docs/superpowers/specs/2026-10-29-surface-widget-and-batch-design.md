# Surface: a widget kind and a batch write

**Date:** 2026-10-29
**Status:** Approved decisions D1 and D2 (Jesse, 2026-10-29); the rest is drafted for review
**Source:** colony-nerve `docs/plans/2026-10-28-bellman-room-plugin-design.md`, Part 1 ("The `widget` kind") and Part 2
("Writes", batch), and its "Bellman changes" table. Colony Nerve draws a room's surface as its canvas. It needs
a kind for its widgets, and a way to write 40 moved cards without spending 40 of a seat's 30 sends a minute.

## D1. A batch is N `surface` events appended in one operation

A batch of N writes appends N ordinary `surface` events at consecutive cursors. They go in one store transaction:
all of them land or none does, and the batch counts as **one send** against the member's minute (ADR 0022).

A locked frame's move does this already: `appendSurface` writes the mover's event and then one carried event per
card. Every reader of a `surface` event keeps working unchanged: restore by cursor, history, `/ws`, `bellman_sync`,
the dash, the MCP App, search and the frame carry all see one key per event. The Nerve spec's "one event" wording
gives way to this. What Nerve needed from it was atomicity and one send, and both still hold.

## D2. Over MCP, a batch is a `bellman_send` surface payload

`bellman_send type: "surface"` with `payload: { items: [ … ] }`. Each entry is what a single surface payload is
today: an item, or `{ key, remove: true }`. There is no new tool, so `extension/manifest.json` does not change. The
description grows by one sentence (≤ 40 tokens, measured in ARCHITECTURE §11).

Over HTTP, `PUT /rooms/:id/surface` takes the same `{ items: [ … ] }` body, up to 1 MiB. It is a sibling of
`PUT /rooms/:id/surface/:key` and takes the same auth. The Nerve spec asked whether that includes a bearer token,
and it does: `deps.caller` accepts the panel cookie or a bearer. Like the single-key routes, it counts no send
(ADR 0022, R6). Only the `bellman_send` path counts, and it counts the batch as one.

### Rules

- **1 to 100 entries.** `items: []` is refused, and so is a 101st entry.
- **No restores.** `{ key, restore }` stays single-write. A restore's event is authored by the version's author, so
  restores in a batch would split its authorship and its idempotency scope (`writeSurface`'s R23).
- **Each key once.** A key named twice in one batch is refused by name. Last write wins within one call would have
  no reader who wants it.
- **Checked as if applied in order.** Entry *i* is checked against the room as entries 0..*i*−1 leave it. A
  connector may name two cards created earlier in the same batch, which a paste of a diagram does. A card without
  a placement takes a slot clear of the cards before it. The item cap counts the new keys of the whole batch, and
  so does the frame cap.
- **All or nothing.** The first refusal refuses the batch, writes nothing and spends no send. It names the entry:
  `items[7]: surface text "plan": …`, the single write's own words after the prefix.
- **Frames.** Placement among frames, the overlap refusal and the locked carry all run per entry inside the
  transaction, against the rows as the earlier entries left them. A carried card's event follows its frame's
  event, as it does now.
- **Idempotency.** One `idempotency_key` names the whole batch. Its fingerprint covers every entry in order. A replay
  returns the original result and appends nothing.
- **Result.** `{ room_members, cursor, count, replayed? }`. `cursor` is the last event's cursor, which is the room's
  surface cursor after the batch, carried cards included. `count` is the number of entries. One audit row,
  `sent_surface_batch`, carries `{ count, keys }`, with keys capped at 100 because entries are.

The bridge door's batch route (#465 deferred it until this landed) is a follow-up, not part of this spec.

## D3. The `widget` kind

```jsonc
{ "key": "n-2f1c…", "kind": "widget", "title": "Stripe", "placement": { … },
  "widget": { "plugin": "stripe", "locality": "credential_bound", "owner": "<member_id>", "seat": "<member_id>" },
  "body": "{\"range\":\"7d\"}" }
```

- `widget` is required on a widget and refused on every other kind, as `shape` is. On a stored row it is absent
  for every other kind, as `locked` is, so no existing row changes.
- `plugin`: `[a-z0-9][a-z0-9._-]{0,63}`. Nerve's plugin ids (`stripe`, `whiteboard-ink`, `zone`, `terminal`).
- `locality`: one of `shared`, `credential_bound`, `local_with_remote_input`, `proximity_collaborative`. Nerve's
  `localOnly` has no value here: a local-only widget is never written to a room, so the shape refuses it with
  `a local-only widget stays on its Mac and is never written to a room`.
- `owner`: a member id. It must be a seat of the **writing account** when the key is new, and when a write changes
  it. A write that keeps the stored owner passes from any seat holding `write_surface`, so a peer can move your
  card but cannot make a card say it is yours. The card's "Stripe on Jesse's Mac" label comes from the owner, so
  the owner has to be one the writer holds. Checked in `writeSurface`, where the session and the account are.
- `seat`: optional member id, the Bellman seat running inside a terminal. Checked only for its form. The card shows
  that seat's state if the room has it, and "unknown seat" if not.
- `body`: optional. When present it is JSON text (`JSON.parse` succeeds) of at most 8,000 characters. It is peer
  content like every field (ADR 0008).
- `widget` joins `PLACED_KINDS`, so it is placed when it arrives without a placement, and `frame: n` puts it in a
  frame.
- Nothing in Bellman runs a widget. Nerve's run-live rule (Nerve spec, "Running widgets safely") also needs the
  item's writer (`byMemberId`), which Bellman stamps and the writer cannot set.

**Viewers.** The MCP App (`ui/`) and the dash (bellman-sh/dash, its own PR) draw a widget as a card showing the
plugin id, the title, the owner's label, and for `local_with_remote_input` the bound seat's state (role, model,
last progress note). They never render `body`.

## What changes

| Area | Change |
|---|---|
| `src/types.ts`, `src/surface.ts` | `SurfaceKind` gains `widget`; `SurfaceItem` gains `widget`; the zod shape, `normalizeSurfaceWrite`'s rule, `PLACED_KINDS` |
| `src/surface.ts` | a batch normaliser: `{ items }`, 1..100 entries, keys unique, no restores, each entry through `normalizeSurfaceWrite` |
| `src/rooms.ts` | `resolveSurfaceBatch` (each entry checked over facts updated in order); the owner rule; `writeSurfaceBatch`, which `bellman_send` calls for an `{ items }` payload |
| `src/store.ts`, `src/store-do.ts` | `appendSurface` takes a list of writes, placed and applied in order in one transaction; both stores; the contract suite |
| `src/tools/send.ts` | one sentence in the description; the result's `count` |
| `src/http/rooms.ts` | `PUT /rooms/:id/surface` |
| `src/projections.ts`, `ui/` | the `widget` field on the wire; the MCP App card |
| docs | an ADR beside 0015 and 0038 (numbered when the PR opens); `npm run docs:gen`; the docs site's surface page |

## Testing

- Contract suite, both stores: a batch lands as N events at consecutive cursors with N rows; a refusal at entry *k*
  leaves the log, the rows, the key record and the minute as they were; a connector names cards made earlier in the
  batch; unplaced cards in one batch take distinct slots; a locked frame move inside a batch carries its cards after
  its own event; a keyed batch replays.
- Tool: a 40-entry batch is one send (the 31st single send in a minute is refused, a 40-entry batch is not); the
  refusal names `items[i]`; 101 entries, an empty list, a duplicate key and a restore entry are each refused.
- Widget: each locality round-trips; `local_only` is refused; `widget` on another kind is refused; an owner that is
  another account's seat is refused on a new key and on a change, and accepted on an unchanged rewrite from a peer;
  a non-JSON body is refused.
- Every new assertion is run once against a broken implementation and seen to fail.
