# Per-role heartbeat instructions. Design

**Date:** 2026-10-09
**Status:** approved in conversation; implementation plan to follow
**Builds on:** #111 (the heartbeat: one cadence a room, `reports` a role), #145 (`progress`), #224 and dash#21 (saved presets and the designer)
**Related:** #227 (the hosted seat, which asks the room questions on a tick and answers none)
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

A room with a heartbeat asks every reporting seat the same thing. The tick's
`ask` (`snapshotOf` in `src/heartbeat.ts`) is one line for the whole room:
"one line on where you are". Rooms whose seats do different work want
different answers: a reviewer's is what it reviewed and what blocks it, a lead's
is what was decided and what comes next. The only place to say so today is a
role's description, which nobody is asked to act on.

The designer also hides the heartbeat: the cadence sits apart from the roles,
and the per-role column is a bare "reports".

## Decisions

**D1. A role gains `report`, an optional instruction.** At most 300
characters, saying what this seat reports when the heartbeat ticks. Manifest
input `roles.<key>.report` (`RoleDefShape`, nullish). Stored `RoleDef.report:
string | null`, read as `null` for a room written before it
(`withHeartbeatDefaults` in `src/stored-session.ts`, beside `reports`).

**D2. Only where it can be asked.** A role with a `report` must have
`reports: true`; `resolveManifest` refuses otherwise, in its own words: `role
"x" sets a report instruction but does not answer the heartbeat (reports is
false)`. A room with no cadence may still carry one, as it may carry `reports:
true`: it is inert until a cadence ticks, and the preview's `you_report`
already says so.

**D3. Creator text, attributed to the creator, everywhere.** An instruction
is the room creator's words and never the server's. In the join preview it
travels in the untrusted text block `roomPreview` already sends
(`room.text`, attributed to the creator), as `report_instructions: { <role>:
string | null }` beside `descriptions`. The trusted spine is unchanged.

**D4. The tick carries them.** `HeartbeatPayload` gains `instructions`: an
untrusted envelope attributed to the room's creator holding `{ <role>:
instruction }` for each role that has one, or `null` when none does. Each
`ReportRow` gains `room_role`, so an agent finds its own row and its own
instruction. The server's `ask` stays the server's words and gains one clause:
"Where your role has an instruction from the room's creator in `instructions`,
your note answers it."

**D5. The trust trade, stated.** A role's instruction is creator text that
another member's agent is asked to act on. It is shown at the consent point,
the join preview and the join screen, before a joiner's human accepts the seat;
it arrives inside an untrusted envelope attributed to the creator; and the only
thing it can shape is the content of a `progress` note. It cannot ask for a
tool call, an action or anything outside the note, and an agent that read it as
more would be following peer content, which the channel's instructions already
forbid. It stands where a role description stands, plus the consent.

**D6. The designer.** The cadence moves beside the roles table, as
"Heartbeat: every <n> <unit>" with its on and off. The per-role column reads
"Answers the heartbeat". A role that answers gets an instruction field under
its row, 300 characters, shown only while it answers. The joiner preview shows
the instruction beside the seat. Saved presets carry it (`PresetShape` inherits
`RoleDefShape`; `SavedPreset.roles[].report`), and Copy room.yaml writes
`report:` under a role that has one.

**D7. The MCP App's join screen** shows a seat's instruction in its Reports
cell, as the creator's words: "yes: <instruction>".

**D8. Cost.** `bellman_start`'s schema gains one optional field inside a
role. §11 records it.

**D9. The hosted seat is unaffected.** It asks the room a question on each
tick (#227) and holds no reporting seat.

## Testing

Every assertion runs against a broken version first and must fail there.

- Manifest: `report` accepted on a reporting role and refused on one that does
  not report, in the validator's words; bounded at 300; a stored role with no
  `report` reads as `null`.
- Preview: `room.text.data.report_instructions` names each role's instruction or
  `null`, inside the creator's envelope; the trusted spine has no new field.
- Tick: `instructions` is an envelope whose origin is the creator, holding only
  the roles that have one; each row carries `room_role`; the `ask` names
  `instructions`; a room whose roles have none sends `null`.
- Presets: a preset with an instruction saves, is served back, and starts a room
  whose role carries it; the export writes it and the bridge's loader reads it.
- Dash: the editor shows the instruction field only for an answering role, the
  body carries it, the preview shows it, and the YAML fixture holds it.
- MCP App: the join screen shows "yes: <instruction>" as text.

## Out of scope

- A cadence per role: the tick is one event a room (#111).
- Instructions for a seat that does not answer the heartbeat.
- Changing a running room's instructions: a manifest is immutable.
