# ui/src

## Overview

The MCP Apps page that a host renders through the server's one `ui://`
resource. One page, several screens: the join screen for a `bellman_connect`
preview, the room card for `bellman_start`, the rooms monitor for
`bellman_rooms`, and the surface canvas for `bellman_surface`. It talks to the
host only through the `@modelcontextprotocol/ext-apps` `App`; it reads data by
calling tools, and it renders every peer string as text.

## Interface

- `[main.ts:(entry)]` exports nothing. Creates `new App({ name: "Bellman", ... })`,
  hands `createPage` four host calls (`callTool` via `app.callServerTool`,
  `sendMessage` via `app.sendMessage` as one user-role text message, `openLink`
  via `app.openLink`, `nestedFrames` via `probeNestedFrames()`), routes
  `app.ontoolresult` to `page.render`, applies the host theme on connect and on
  `app.onhostcontextchanged`, then `await app.connect()`.
- `[page.ts:createPage, PageDeps, Page, POLL_MS]` the controller. `render(result)`
  is a navigation; `rooms()` calls `bellman_rooms` with `{}`; `surface(id)` calls
  `bellman_surface` with `{ session_id }`; `stop()` ends polling. `POLL_MS` is
  `15_000`.
- `[screen.ts:pickScreen, ToolOutcome, Screen]` classifies a tool result into
  `join`, `card`, `monitor`, `canvas`, `error` or `none`.
- `[join.ts:renderJoin, verdictMessage, CAPABILITIES, Verdict, Delivery]` the join
  screen built from a `ConnectResult`: brief, roles, capability checkboxes
  (`read_context` and `receive_messages` on, `request_actions` off), Join and
  Decline; `verdictMessage` builds the text sent to the agent.
- `[card.ts:renderCard]` the room card for a `StartResult`: join code, countdown,
  Open buttons for `join_url` and `public_url`.
- `[monitor.ts:renderMonitor]` the rooms list: members per room, join codes, a
  count of events new since the view opened, Refresh and Surface buttons.
- `[canvas.ts:createCanvas, Canvas, CanvasDeps, dashRoomUrl, DASH_ORIGIN, httpUrl]`
  the surface canvas: cards, SVG connector lines, zoom, pan and fit, Rooms and
  Refresh controls, and an open-in-dash link to
  `https://dash.bellman.sh/rooms/{id}`.
- `[canvas-layout.ts:GRID, ZOOM, FIT_MARGIN, gridSlot, layout, centerOf, borderPoint, clampZoom, fit, zoomAbout]`
  pure layout math with no DOM.
- `[artifact.ts:artifactFrame, probeNestedFrames, fromFrame, clampHeight, FRAME_SANDBOX, MIN_FRAME_HEIGHT, MAX_FRAME_HEIGHT, PROBE_TIMEOUT_MS, OPAQUE_ORIGIN, REPORT_HEIGHT]`
  the sandboxed frame for an `html` surface item, and the probe for whether the
  host allows nested frames at all.
- `[shared.ts:el, text, duration, relative, countdown, seatsLine, coalesce]` the
  DOM builder and formatting helpers (`coalesce` is exported but unused here).
- `[types.ts:ConnectResult, StartResult, RoomsResult, SurfaceResult, SurfaceItemWire, Untrusted, ...]`
  the tool results' wire shapes, typed by hand.
- `style.css`: the page's styles, imported by `../index.html`.

## Invariants

- The page calls exactly two server tools, `bellman_rooms` and `bellman_surface`
  (`[page.ts:rooms,surface]`), and never `bellman_sync`: through the bridge, a
  sync from the page would count as the agent having read those events, and they
  would never reach it (`[page.ts:header]`). A new screen that needs data calls a
  tool, never `bellman_sync`.
- Screen choice reads `structuredContent` in a fixed order (`[screen.ts:pickScreen]`):
  `isError` first, then `connect_token` (join), `join_code` with `session_id`
  (card), `rooms` (monitor), `surface` (canvas), else the first text content.
  `connect_token` must stay ahead of `surface`, since a `bellman_connect` result
  carries both.
- One read per key (`"rooms"` or a session id) is in flight at a time; a timer
  read reuses the pending one (`[page.ts:read]`). Every host navigation and every
  user-started read bumps `generation`, and an answer that arrives after a bump is
  dropped, so a late poll cannot restore a screen the person left
  (`[page.ts:read,render]`).
- Peer content is untrusted and lands as text: `el` turns string children into
  text nodes (`[shared.ts:el]`), connector labels use `textContent`
  (`[canvas.ts:renderLines]`), and nothing in this directory uses `innerHTML`,
  `outerHTML` or `insertAdjacentHTML`. Attributes carry page-chosen values only.
- An `html` item renders only inside an iframe `srcdoc` with
  `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`
  (`[artifact.ts:artifactFrame, FRAME_SANDBOX]`); a message from it counts only if
  its origin is `"null"` and its source is that frame's window
  (`[artifact.ts:fromFrame]`), and a reported height is clamped to 80..1200
  (`[artifact.ts:clampHeight]`).
- A link item opens only for an `http:` or `https:` URL; anything else gets a
  disabled button (`[canvas.ts:httpUrl]`). A kind becomes a class name only if it
  matches `/^[a-z]{1,16}$/` (`[canvas.ts:kindClass]`). A card header shows the
  envelope's `origin.label`, never one from the body (`[canvas.ts:renderCard]`).
- The verdict sent to the agent carries identifiers only (the role key and
  capability names), never room prose or brief fields (`[join.ts:verdictMessage]`),
  and can be sent once (`[join.ts:settle]`).
- The canvas redraws its cards only when `surface.cursor` changes
  (`[canvas.ts:update]`); layout sorts by code-unit order, not `localeCompare`
  (`[canvas-layout.ts:keyOrder]`).

## Side Effects

- `[page.ts:startPolling]` `window.setInterval` every `POLL_MS` (15 s) on the
  monitor and canvas screens, skipping ticks unless
  `document.visibilityState === "visible"`; every other screen clears it.
- `[page.ts:show]` replaces the root's children on each screen change.
- `[main.ts:(entry)]` host calls over the ext-apps transport:
  `app.callServerTool`, `app.sendMessage` (the join verdict; if the host refuses,
  `[join.ts:renderJoin]` shows the text for the human to relay), and
  `app.openLink` (card Open buttons, canvas link items, open-in-dash).
- `[artifact.ts:probeNestedFrames]` appends a hidden sandboxed iframe and a
  `message` listener, removed after `PROBE_TIMEOUT_MS` (1000 ms).
  `[artifact.ts:artifactFrame]` adds a `message` listener tied to an `AbortSignal`
  that `[canvas.ts:update]` aborts on each redraw.
- `[canvas.ts:createCanvas]` wheel (non-passive, `preventDefault`), pointer drag
  with pointer capture, and arrow-key pan set the layer's CSS transform.
- `[monitor.ts:roomCard]` records the first cursor seen per room in the page's
  `seen` map.
- No `fetch` or other direct network access, and no model-context update.

## Verification

- Run: `npm run typecheck:ui`
- Run: `npm test` (runs `build:ui` first; `../test/*.test.ts` cover the renderers,
  the page controller, the layout math and the artifact frame, some under
  `// @vitest-environment jsdom`)
