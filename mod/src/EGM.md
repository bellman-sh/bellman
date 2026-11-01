# mod/src

## Overview

The wiring of `bellman-mod`, the Claude Code mod (a hooks module) that shows
Bellman rooms in the terminal: a band and bell above the prompt, a sidebar, a
wide room pane (Log, Canvas, Members, Approve tabs), toasts, a wake for an idle
session when a peer writes, and an approval gate on action responses.

It finds each local bridge with one `bellman_whoami` call, then reads and
writes only through that bridge's door, a Unix socket served by `src/door.ts`
with its protocol in `src/door-protocol.ts`. The pure logic it draws on lives in
`src/mod/` (`view.js`, `gate.js`, `wake.js`, `calls.js`) and is bundled in.
esbuild bundles this directory into [`../hooks/register.mjs`](../hooks/EGM.md)
(`npm run build:mod`); the committed bundle is what Claude Code runs.

## Interface

- `register.tsx`
  - `register`: a function declaration, not a `const`, because
    `claude plugin validate` refuses `var register`. Registers `session.start`,
    `turn.start`, `turn.complete`, `prompt.submit` and `tool.check`, then
    calls `startView`, `registerGate`, `registerWake` [register.tsx:register]
  - `tool.check` allows only the mod's own `bellman_whoami` call
    (`isOwnCall` from `src/mod/calls.js`); everything else goes to `next(e)`
    [register.tsx:on("tool.check")]
  - Re-exports for the kit tests: `CANVAS_MAX`, `DOOR_POLL_MS`, `LOGS_MAX`,
    `PANE_COLUMNS`, `PANE_ID`, `ROOMS_POLL_MS`, `SIDEBAR_COLUMNS`,
    `GATE_REASON`, `approvalKey`, `WAKE_TEXT`, `APPROVALS_SECTION`,
    `approvedText`, `declinedText` [register.tsx:export {...} lines 17-21]
- `doors.ts`: the only module that talks to a bridge
  - `findDoors`, `startDoors`, `onTick`, `readShownLog`, `readCanvas`,
    `decline`, `seatIn`, type `SeatAt` [doors.ts:findDoors] [doors.ts:startDoors]
    [doors.ts:onTick] [doors.ts:readShownLog] [doors.ts:readCanvas]
    [doors.ts:decline] [doors.ts:seatIn] [doors.ts:SeatAt]
  - Bridges are found by `$.tool.list()` filtered on
    `/^mcp__(.+)__bellman_whoami$/` [doors.ts:bridges]
  - Door routes called, all through `fromDoor` (`$.http.fetch` with
    `socketPath`, throws on non-2xx) [doors.ts:fromDoor]:

    | Route | Caller |
    | --- | --- |
    | `GET /status` | [doors.ts:pollDoors] |
    | `GET /rooms` | [doors.ts:readRooms] |
    | `GET /rooms/<id>/events[?after=<cursor>]` | [doors.ts:fetchLog] |
    | `GET /rooms/<id>/surface` | [doors.ts:readCanvas] |
    | `POST /rooms/<id>/decline` `{ref_id}` | [doors.ts:decline] |

    The protocol's `POST /seats/status` and `PUT`/`DELETE
    /rooms/<id>/surface/<key>` are not called from here
    [doors.ts:fromDoor callers]
- `drawn.ts`: `markDrawn`, `hasDrawn`, `markPaneWide`, `shownTab`
  [drawn.ts:shownTab]
- `gate.ts`: `APPROVALS_SECTION`, `gateShut`, `registerGate` (hooks
  `tool.call`, `mcp.call`, `prompt.compose`) [gate.ts:registerGate]
- `pane.tsx`: `drawPane`, `approvedText`, `declinedText`, `message`,
  `awaitingPerson` [pane.tsx:drawPane] [pane.tsx:awaitingPerson]
- `person.ts`: `onPerson`, `personActed` [person.ts:personActed]
- `state.ts`: `$.state` atoms keyed `{plugin: "bellman-mod", key}`: `doors`,
  `rooms`, `room`, `seen`, `openedThrough`, `layout`, `tab`, `wake`,
  `pending`, `request`, `approved`, `logs`, `canvas`
  [state.ts:doors|rooms|room|seen|openedThrough|layout|tab|wake|pending|request|approved|logs|canvas]
- `view.tsx`: `startView` (hooks `ui.close`, `ui.render` for `AbovePrompt`
  and for `Pane` with `requestId: PANE_ID`), `viewTick`, `openPane`, types
  `Shown`, `Pieces` [view.tsx:startView] [view.tsx:viewTick] [view.tsx:openPane]
- `waking.ts`: `turnStarted`, `turnEnded`, `promptSubmitted`,
  `registerWake`, `wakeTick` [waking.ts:wakeTick]
- The shapes the mod keeps in `$.state` are repeated by hand in
  `mod/types/index.d.ts`; see [the mod blueprint](../EGM.md)

## Invariants

- The mod calls one Bellman tool, `bellman_whoami`, at `doors.ts` `ask`, and
  only from the four hooks `session.start`, `turn.start`, `turn.complete`,
  `prompt.submit`: Claude Code refuses a mod's own tool call from timers and
  presses [doors.ts:ask] [register.tsx:register]
- Nothing here calls `bellman_sync` or takes from an inbox; those belong to
  Claude [doors.ts:header]
- `tool.check` auto-allows only the mod's own `bellman_whoami`; it has no
  `.catch`, so a failure costs only that allow [register.tsx:on("tool.check")]
- Only one `session.start` hook: validate refuses a second without a matcher
  [register.tsx:on("session.start")]
- A hook waits at most `FIND_WAIT_MS` (1,500 ms) for bridges; a later answer
  still lands in `doors` [doors.ts:findDoors]
- A door that already has a status takes only a new `socketPath` and keeps its
  status, so the gate stays shut on its rooms; an answer naming no door drops
  its seats [doors.ts:askBridges]
- An unreadable door keeps its socket and last status and gets an error; a
  door whose `socketPath` is null is not read [doors.ts:pollDoors]
- Bounds that keep `$.state` under the engine's limit: at most
  `MEMBERS_KEPT` = 25 members per room with names cleaned to `NAME_MAX`, and a
  log of at most `LOG_KEPT` = 500 events, each cursor once, oldest first
  [doors.ts:keptRoom] [doors.ts:merged]
- `canRespond` comes from `your_seats[member].verbs` including
  `respond_actions`; `room.your_verbs` only when `your_seats` is absent
  [doors.ts:verbsOf]
- A rooms refresh, a shown-log read and a tick never stack on a run already
  going [doors.ts:refreshing|readingLog|ticking]
- Peer content is untrusted: every string a peer controls is cleaned before
  display (`cleanText`, `cleanBlock`, `safeLinks`), and a Link is drawn only
  for an `http:`/`https:` URL of at most 2,048 characters [pane.tsx:header]
  [pane.tsx:webHref]
- Text sent to the model is fixed: `approvedText`/`declinedText` carry only a
  session id matching `/^[A-Za-z0-9_-]{1,64}$/` and a safe-integer cursor;
  `APPROVALS_SECTION` and `WAKE_TEXT` carry nothing a peer wrote
  [pane.tsx:serverMade] [gate.ts:APPROVALS_SECTION] [waking.ts:header]
- While a terminal draws the mod, Claude's `bellman_send` of an
  `action_response` in a pane room passes only if the person approved it; other
  sends and tools are untouched. A gate that fails before answering denies an
  `action_response` with `GATE_REASON` and lets the rest through
  [gate.ts:header] [gate.ts:registerGate .catch]
- Only the first press on a waiting request tells Claude; if `prompt.submit`
  fails, the approval is removed [pane.tsx:approve]
- A Deny goes only through the door, never a tool call, and Claude is told only
  after the door confirms; on failure the request stays waiting [pane.tsx:deny]
- An approved request draws no buttons; a request whose drawing is null (cut,
  over 90,000 characters, or trimmed) can only be denied [pane.tsx:drawPane]
- The Approve tab never switches request on its own; only the person's pick
  changes it [pane.tsx:lastDrawn]
- `$.ui.open` runs before the first `await` in `openPane`, so the engine counts
  it as the person's press [view.tsx:openPane]
- After the person closes the pane by hand, no sidebar opens unasked until
  `openPane` runs [view.tsx:refused]
- Render hooks draw only on the `terminal` surface and call `next(e)`
  otherwise [view.tsx:startView]
- Only doors in hook delivery count toward a wake, and a subagent's turn does
  not change `turnRunning` [waking.ts:wakeTick] [waking.ts:turnStarted|turnEnded]
- A listener that throws does not stop the press [person.ts:personActed]

## Side Effects

- One MCP tool call per bridge: `$.mcp.call(server, "bellman_whoami")`
  [doors.ts:ask]
- HTTP over each bridge's Unix socket: the five routes above [doors.ts:fromDoor]
- Timers for the session's life: `$.clock.every(DOOR_POLL_MS, tick)` and
  `$.clock.every(ROOMS_POLL_MS, refreshRooms)`; `$.clock.after(FIND_WAIT_MS)`
  per find [doors.ts:startDoors] [doors.ts:findDoors]
- `$.state` writes to every atom in `state.ts`
  [doors.ts:askBridges|tick|refreshRooms|readLogs|readShownLog|readCanvas]
- Prompts to Claude: `$.prompt.submit` of `approvedText` or `WAKE_TEXT`;
  `$.session.append` of `declinedText` or `WAKE_TEXT` [pane.tsx:approve]
  [pane.tsx:deny] [waking.ts:wakeTick]
- `prompt.compose` appends the section `bellman-mod:approvals` while the gate
  is shut [gate.ts:registerGate]
- UI: `$.ui.open`/`$.ui.close` of `PANE_ID`, `$.ui.toast`, `$.ui.status`,
  `$.ui.log(..., {to: "debug"})` on failures [view.tsx:viewTick] [doors.ts:*]
- Module-level mutable state in `doors.ts`, `drawn.ts`, `pane.tsx`,
  `person.ts`, `view.tsx`, `waking.ts`
- No `process.env` reads and no filesystem access [all files]

## Verification

- Run: `npm run test:mod` (kit tests in `mod/tests/`, local only; CI skips it)
- `verify` never type-checks `mod/src`; see the `plugin-authoring` route in
  `CLAUDE.md`
