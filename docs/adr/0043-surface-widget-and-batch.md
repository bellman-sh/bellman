# ADR 0043: The surface holds widgets, and takes a batch of writes

**Date:** 2026-10-29 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-29-surface-widget-and-batch-design.md` · **Plan:** `docs/superpowers/plans/2026-10-29-surface-widget-and-batch.md`

## Context

Colony Nerve draws a room's surface as its canvas (colony-nerve `docs/plans/2026-10-28-bellman-room-plugin-design.md`). Its widgets (terminals, Stripe panels, timers) had no surface kind. Moving 40 selected cards was 40 writes: 40 events with no atomicity, and through `bellman_send`, 40 of a seat's 30 sends a minute.

## Decision

1. **A batch is N `surface` events appended in one operation** (D1). `BellmanStore.appendSurfaces` places the writes in order in memory (`placeSurfaceBatch`), so a refusal at any entry is decided before anything is written. It then appends each write's event, with any cards a locked frame's move carries after it, at consecutive cursors in one transaction, or nothing. A locked frame's move already appended many events in one operation (ADR 0038), so every reader of a `surface` event (restore, history, `/ws`, `bellman_sync`, the dash, search) reads a batch with no change.
2. **A batch arrives as a `surface` payload** (D2): `{ items: [...] }` on `bellman_send`, or the body of `PUT /rooms/:id/surface`. It takes 1 to 100 entries, each an item or a removal, with each key at most once and no restores. Each entry is checked against the room as the entries before it leave it, and a refusal names `items[i]`. Through `bellman_send` a batch counts as one send. The routes count none, as the single-key routes count none (ADR 0022).
3. **A widget is a surface kind** (D3): `widget: { plugin, locality, owner, seat? }`, with its config as JSON text in `body`. A `local_only` widget is refused, because it never leaves its Mac. A write that names a new owner must name a seat of the writing account. A write that keeps the stored owner passes from any seat holding `write_surface`. Bellman runs no widget: viewers draw a card, and they never render the body.

## Consequences

- A batch of 100 writes adds 100 events to every member's `bellman_sync`, more if it moves a locked frame, as 100 single writes would.
- A peer can move a widget card it does not own, or make the card its own. It cannot make the card name another account's seat. What Nerve runs live also checks who wrote the item and which Mac made it, so taking over a card does not run a widget on the new owner's Mac.
- A keyed batch is recorded against its last event's cursor, so a replay answers that cursor and not the first. A
  retry with a recorded key is replayed without the room's checks, so a batch whose own removal left a connector's
  end gone still replays.
- Every position a batch writes is final: a locked frame's move carries only the cards no entry writes.
- A batch refused for placement among the frames has spent its send, as a single write refused there has. The
  refusal is decided in the store's transaction, after the count.
- A rollback is a revert while no room holds a widget. After that, the old code reads a widget row as an unknown kind, and the MCP App draws it by name.
