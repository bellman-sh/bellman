# The heartbeat's vocabulary: frequency per room, heartbeat_on per role. Design

**Date:** 2026-10-09
**Status:** approved in conversation (two sections); implementation plan to follow
**Builds on:** #111 (the heartbeat), #229 (per-role report instructions, live), #232 (room housekeeping, live)
**Replaces:** dash#25, the designer half of #229, which closes unmerged when this one's dash PR opens
**Citations:** by symbol, of the code on main at `a1bcce7`.

## Problem

A room's manifest says how often the heartbeat ticks with a top-level `heartbeat_on`,
and which seats answer it with a per-role `reports: true`, which #229 joined with a
per-role `report`. The name says the opposite of what it holds: `heartbeat_on` reads
as "this is on the heartbeat", which is a fact about a role, and it sits at the top
holding a frequency. Three fields spell what is one per-role setting.

The words should match the model: **the heartbeat's frequency is the room's; whether a
seat is on the heartbeat, and what it reports, is the role's.**

## Decisions

**D1. What an author writes.**

```yaml
heartbeat: 5m                     # the room's: how often the server ticks
roles:
  reviewer:
    can: [send]
    heartbeat_on: "What you reviewed and what blocks you"
  lead:
    can: [send, invite]
    heartbeat_on: true            # on, with the server's default ask
  observer:
    can: []                       # absent or false: off
```

- `heartbeat` (top level, both arms of the manifest, saved presets): the same durations
  `heartbeat_on` takes today, with its bounds and the hosted seat's floor
  (`parseHeartbeatOn`, `checkHost`, `checkCiteCadence` unchanged in substance).
- `roles.<key>.heartbeat_on`: `true`, `false`, or an instruction. An instruction is
  trimmed and is 1 to 300 characters after trimming; a blank one is refused
  (`heartbeat_on: give true, false, or what this seat reports`). A role that is on must
  hold `send`, as a reporting role must today. Absent means off.

**D2. Nothing inside moves.** `resolveManifest` reads the new words into today's model:
`RoomManifest.heartbeatOnMs` from `heartbeat`; `RoleDef.reports` true and `RoleDef.report`
null for `true`; `reports` true and `report` the trimmed text for a string; `reports`
false and `report` null for `false` or absent. Stored rooms, `withManifestDefaults`, the
tick (`snapshotOf`, `nextTickAt`), the monitor's beats and every reader of `reports` and
`report` stay as they are. No stored data is migrated.

**D3. The old words keep working, everywhere they could have been written.** A top-level
`heartbeat_on: <duration>`, a role's `reports: true|false` and a role's `report: "…"` are
still accepted: inline in `bellman_start`, in `.bellman/room.yaml`, in a cite of a hosted
preset, and in a saved preset stored before this. Old and new are read into the same model.
An old `report` is trimmed as an instruction is, and a blank one reads as none, which
settles the three-way handling of blanks #229's review deferred. #229's rule stands for the
old words, in its words: a `report` on a role whose `reports` is false is refused.

**D4. One thing, one spelling.** A manifest that spells one thing both ways is refused,
naming the field to drop: `heartbeat` with a top-level `heartbeat_on`; a role's
`heartbeat_on` with its `reports` or its `report`.

**D5. Errors speak the words the author wrote.** A rule broken in the new words is named
in them, `role "lead" sets heartbeat_on but does not hold the verb "send"`; in the old
words, today's messages stand unchanged, `role "lead" sets reports: true but does not hold
the verb "send"`. The same for the hosted seat's rules (`a room with a host must set
heartbeat (at least 1h)`, `host role "x" must not be on the heartbeat`) and the cite rule.

**D6. Only the new words are written out.** Saved presets are stored and served in them:
`SavedPreset` gains `heartbeat` and `roles.<key>.heartbeat_on` in place of `heartbeat_on`,
`reports` and `report`. A preset saved before this is read through the same translation
(D3) when it is read, and the built-ins (`builtinPresets`) are shown in the new words.
Copy room.yaml, the room-manifest skill, the README, `docs/ARCHITECTURE.md` and the tool
descriptions use only the new words, so an agent learns one vocabulary.

**D7. The join preview speaks the new words** (`roomPreview`):
- `heartbeat_on_seconds` becomes `heartbeat_seconds`;
- the per-role `reports` map becomes `heartbeat_on`, true where that seat is asked (the
  cadence and the seat, as today);
- `you_report` becomes `your_heartbeat_on`, beside `your_role` and `your_verbs`;
- `report_instructions`, in the creator's untrusted text, becomes `instructions`, the word
  the tick uses.

The trusted part still holds only booleans and numbers. `bellman_start`, `bellman_connect`,
`bellman_confirm`, `bellman_rooms`, `bellman_surface` and `GET /rooms/:id` all send the
preview, so all change together, and their `Returns:` lines say so. #229's names went live
hours before this, so nothing depends on them yet.

**D8. The tick keeps its shape.** `cadence_seconds`, `instructions`, `ask` and the member
rows are unchanged: ticks are stored in a room's log and replayed, and an old tick must read
as a new one does.

**D9. The MCP App** (served by the server, so it moves in step): the join screen's
"Reports" column reads "Heartbeat", yes or no, with "creator asks: …" muted beneath; the
seat line reads "Your seat is on the heartbeat, every 5m." in the cadence's own units. The
monitor is unchanged.

**D10. Dash's designer** (a new PR replacing dash#25):
- the room's heartbeat reads "Heartbeat: every [5] [minutes]", with its on and off;
- each role has a "Heartbeat on" checkbox, and while it is checked an instruction field,
  300 characters, empty meaning the server's default ask;
- the joiner's view shows "yes" and "creator asks: …" as the join screen does;
- saves and Copy room.yaml write `heartbeat` and `heartbeat_on` only.

Dash deploys right after bellman: between the two, the live designer reads presets served in
the new words and shows them without a heartbeat. Saving from it in that window still works,
because its old words are accepted (D3).

## Testing

Every assertion runs against a broken version first and must fail there.

- Manifest: the new words on both arms; `true`, `false`, a string, absent; a blank and a
  301-character instruction refused; `heartbeat_on` without `send` refused in the new words.
- Old words: a top-level `heartbeat_on`, `reports` and `report` accepted inline, in a cite,
  in room.yaml and in a saved preset stored before this; each resolves to the model its new
  spelling does; today's error messages unchanged for old spellings.
- Both spellings of one thing refused, naming the field to drop.
- Presets: stored and served in the new words; an old stored preset served in the new words;
  the built-ins in the new words; the export round-trips through the bridge's loader.
- Preview: the four renamed fields, the trusted part's key set, and the creator's
  `instructions` inside the envelope.
- Tick: unchanged; a test pins its keys.
- MCP App: the column, the line, and the instruction as text.
- Dash: the designer's controls, the body it saves, the export, the joiner's view.
- Cost: §11 re-measured; the schema lists the old words as well, so a small rise is expected.

## Out of scope

- A frequency per role: the frequency is the room's.
- Renaming the model's internals (`heartbeatOnMs`, `reports`, `report`) or migrating stored
  rooms.
- Removing the old words.
