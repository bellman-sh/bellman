# mod

## Overview

The runtime-free logic of `bellman-mod`, the Claude Code mod, bundled into `mod/hooks/register.mjs` by
`npm run build:mod`; `mod/src/` is the wiring that calls it. It decides which of the mod's own permission checks
the mod answers itself (`calls.ts`), which `bellman_send` `action_response` calls only the person may make
(`gate.ts`), when to wake a session for waiting peer events (`wake.ts`), and how events, toasts, pending
requests, the canvas, room names and links are drawn (`view.ts`). Every function is pure.

## Interface

- `isOwnCall(tool, origin)`: true only for `/^mcp__.+__bellman_whoami$/` with `origin.plugin === "bellman-mod"`
  [src/mod/calls.ts:isOwnCall]
- `SendCall`, `sendCallOf(tool, args)` (a `bellman_send` call under any server prefix, or `undefined`),
  `approvalKey(sessionId, refId)`, `GateContext {shut, paneRooms, approved}`, `GateVerdict`,
  `judgeSend(call, ctx)`, `GATE_REASON` [src/mod/gate.ts:judgeSend]
- `WAKE_LIMIT = 3`, `WAKE_TEXT`, `WakeState`, `IDLE_WAKE`, `WakeInput` (tick | person), `WakeAct`
  (submit | append | none), `isPaused(state)`, `stepWake(state, input)` [src/mod/wake.ts:stepWake]
- Layout: `chooseLayout(p)` (`"sidebar" | "band"`), `sidebarMove(p)`; constants `SIDEBAR_COLUMNS`,
  `PANE_COLUMNS`, `COMPACT_BELOW`, `PANE_ID`, `DOOR_POLL_MS` 2000, `ROOMS_POLL_MS` 15000
  [src/mod/view.ts:chooseLayout]
- Events: `Seat`, `KeptEvent`, `DoorRead`, `kept(e)`, `lineOf(e)`, `toastFor(events, p)`, `unreadCount`
  [src/mod/view.ts:toastFor]
- Requests: `PendingRequest`, `pendingRequests(log, p)`, `drawingOf(payload)`, `REQUEST_TTL_MS`
  (= `ACTION_REQUEST_TTL_MS`), `REQUEST_DRAWN_MAX` [src/mod/view.ts:pendingRequests]
- `fitLogs(byRoom, waiting, max)`, `LOGS_MAX` 1,000,000 [src/mod/view.ts:fitLogs]
- `memberLine`, `roomLabel`, `noteLine`, `NAME_MAX` 40; `CanvasItem`, `canvasOf(answer)`, `CANVAS_MAX` 250,000;
  `bellRows()`; `safeLinks(markdown)` [src/mod/view.ts:canvasOf]

## Invariants

- The mod allows only its own `bellman_whoami` call; a call from the model or another plugin keeps its
  permission check [src/mod/calls.ts:isOwnCall]
- When `ctx.shut` is set for a room in `paneRooms`, an `action_response` passes only as an approval
  (`approved === true`) whose `approvalKey` the person approved; a decline from Claude never passes, since the
  person's Deny goes through the bridge's door [src/mod/gate.ts:judgeSend]
- The gate reads the room as `session_id`, else `room_id`, so the alias cannot slip past; wrong-typed values read
  as absent [src/mod/gate.ts:sendCallOf]
- `GATE_REASON` and `WAKE_TEXT` are fixed text, so nothing a peer wrote reaches Claude through them
  [src/mod/gate.ts:GATE_REASON]
- At most `WAKE_LIMIT` wakes in a row without input from the person; an `append` into a running turn is not
  counted; person input resets the count; `stepWake` never mutates state (`IDLE_WAKE` is shared)
  [src/mod/wake.ts:stepWake]
- Every peer-controlled string (labels, room names, notes, titles) goes through `cleanText` or `cleanBlock`
  before display [src/mod/view.ts:toastFor]
- Action-request text spells out control, format and invisible characters as `\u{..}` before display, so hidden
  text is visible to the approving person [src/mod/view.ts:drawingOf]
- `pendingRequests` lists nothing for a seat without `respond_actions`, and excludes the seat's own requests,
  requests answered by an exact `String(cursor)` `ref_id`, and requests older than `REQUEST_TTL_MS`
  [src/mod/view.ts:pendingRequests]
- `toastFor` skips ambient events, the session's own seats, events already seen, and the room whose log is open
  [src/mod/view.ts:toastFor]
- `fitLogs` drops old line-only events first (each room's newest kept), then trims waiting requests' payloads;
  `canvasOf` stops at `CANVAS_MAX` [src/mod/view.ts:fitLogs]
- `sidebarMove` closes the pane only when a door was read, none failed and none lists a seat, and never reopens
  a pane the person refused [src/mod/view.ts:sidebarMove]
- `safeLinks` turns non-http(s) links into text [src/mod/view.ts:safeLinks]
- Runtime-free: no Node, Claude Code or network imports; `view.ts` imports only `door-protocol`, `action-state`
  and `payload` [src/mod/view.ts:drawingOf]

## Side Effects

- None

## Verification

- Run: `npm test -- tests/mod-` (`mod-calls`, `mod-gate`, `mod-view`, `mod-wake`)
- Run: `npm run build:mod && npm run test:mod` for the bundled hooks and the kit tests in `mod/tests/`
- Full gate: `npm run verify`
