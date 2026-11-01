# ADR 0044: Governed room config: settings a human changes inside the manifest

**Date:** 2026-11-01 · **Status:** accepted · **Issue:** #414 · **Plan:** `docs/superpowers/plans/2026-11-01-governed-room-config.md`

## Context

A room's manifest is fixed when the room starts (ADR 0009), and no decision may change it (ADR 0040, decision 11).
Several planned features still need settings a person can change later. Room instructions are the first. The
judge's consent and policies, the data layer's envelope for rooms created before it, and the room filesystem's
`/.bellman/` view come after. Each draft proposed its own home for them. Authority must not move into editable
records: verbs, roles, grants, keys and credentials stay where they are.

## Decision

1. **Governed config is `cfg:<name>` rows in the room's object.** History is `cfgh:<name>:<rev>`, holding the last
   20 revisions. Names are a closed set in `src/config.ts`, each with a strict schema. A new name is one entry there,
   added with the code that reads it. v1 holds one name, `room_instructions` (`{ markdown }`, at most 64 KiB). The
   other names #414 lists ship with their readers (#421, #422, #385).
2. **One reader.** Every consumer calls `getGovernedConfig`; `tests/delivery-paths.test.ts` pins that nothing else
   reads a row. A missing row, a body its schema refuses, or a row without server-written governance reads as the
   name's most restrictive value. For room instructions that is none.
3. **Only a person in a dash session writes.** The route accepts a session cookie only, refusing a bearer token even
   on a seat that holds the verb. It checks the request's Origin, and the caller's own seat must hold `govern`. The
   server writes `governance` (approver, seat, `via: "dash_session"`, revision, time), and a body that carries it
   is refused. No decision effect writes config in v1.
4. **One verb, `govern`** (an amendment to ADR 0009). Every preset grants it to the creator's role only. A public
   room's `default_role` may not hold it, the rule `vote` follows (ADR 0040, decision 7).
5. **Writes carry `base_rev`.** A mismatch is refused `stale` with the current revision. Each write appends a
   `config_changed { name, rev, by }` event and a `config_write` audit row. Neither carries the body.
6. **A 64 KiB reserve per room**, across every name's current body. A narrowing write, which clears room
   instructions, is accepted past it.
7. **Room instructions reach agents as untrusted text.** `bellman_connect` and `bellman_confirm` return
   `room_instructions` inside the untrusted envelope, its origin the approving seat (never the approver's user id),
   cut at 8 KiB with a note. `bellman_sync` returns `room_instructions_rev`.

## Consequences

- The manifest is still never written after start. Config only tunes inside it.
- `room_instructions` is the most-read peer text in a room: every joining agent is handed it. It is human-written
  only, names its approver, and is delivered untrusted, so it grants nothing and cannot override an agent's own
  instructions (ADR 0008).
- Nothing clamps a value yet: no manifest block or org policy field covers room instructions. A name that needs a
  clamp adds it in its own entry, and org policy clamping lands with #397.
- History keeps 20 revisions. #414's "daily for 30 days" waits for a name that needs it.
- The Node server and the Durable Object store run the same rules through `decideConfigWrite`.
- Rollback: old code ignores `cfg:`/`cfgh:` rows and the `config_changed` event, and old clients ignore the new
  response fields. A room that held instructions loses their delivery and keeps the rows.
