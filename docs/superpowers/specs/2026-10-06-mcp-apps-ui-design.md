# MCP Apps: a UI for joining and monitoring rooms. Design

**Date:** 2026-10-06
**Status:** approved in conversation; implementation plan to follow
**Closes:** #28
**Related:** #49 (the HTTP API, which shares the projections this adds), #114
(why `projections.ts` is runtime-free), #111 and #145 (heartbeat ticks and
`progress`), #147 (`lastReportAt` made durable), #7 (Claude Desktop connects
as a connector), #27 (channels are not exposed in Desktop or VS Code)
**Extension targeted:** MCP Apps, spec 2026-01-26, `io.modelcontextprotocol/ui`
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

Two things a Bellman user needs to see are readable only as JSON today.

Joining. `bellman_connect` returns the creator's brief, the room's roles and the
seat the code grants, and the agent is told to show it to its human before
`bellman_confirm` ships anything. Shown as a tool result it is a JSON blob the
human skims, and the decision the two-phase handshake exists for, "here is what
they said before you shipped anything", is a paragraph where it should be a
screen.

Monitoring. Which rooms am I in, who is in each, which role each member holds,
when the room and its codes expire, and since #145, which members answered the
last heartbeat tick and what they said. The only way to see any of it is to
call tools and read JSON. In the consumer Claude Desktop app, which has no
channel and no Stop hook (#7, #27), there is no push either: the human asks
the agent to sync and reads what comes back.

MCP Apps lets a server attach a UI resource to a tool. The host renders it in a
sandboxed iframe in place of the result, the iframe can call the server's tools
through the host, and a host without the extension shows the text result it
always showed.

## The rule this changes

README states: *Tools only. No MCP resources, sampling or elicitation (spotty
support elsewhere).* `tests/tools/surface.test.ts` pins it as invariant 4:
`advertises tools and nothing else`.

The reason was support. The Apps extension now renders in Claude (web), Claude
Desktop, ChatGPT, Cursor, VS Code Copilot, Microsoft 365 Copilot and Goose, and
a UI resource is additive: a host that does not know the extension never reads
`_meta.ui`, never calls `resources/read`, and receives the text result it
received before.

The rule becomes **tools first**:

> Every capability is a tool, and every tool's text result stands on its own.
> UI resources (MCP Apps) are additive: a host that renders them shows a
> screen, and one that does not loses nothing. Still no sampling and no
> elicitation.

README, the surface test and `docs/ARCHITECTURE.md` change together. The test
keeps `prompts`, `completions` and `logging` absent and now requires
`resources` present.

## Decisions

**D1. The UI calls tools; the server grows no second read path.** The iframe
reaches data only through `tools/call`, proxied by the host over the connection
the agent already holds. Same identity, same guards, same audit rows. `/ws`
stays receive-only and the UI never touches it.

**D2. One new tool, `bellman_rooms`, visible to the model.** The monitor needs
"which rooms am I in", and no tool answers it; the store already indexes it
(`sessionsCreatedBy`, `sessionsJoinedBy` in `RegistryDO`). The Apps spec
allows `visibility: ["app"]`, which hides a tool from the model on hosts that
know the extension. Not used: a host without the extension lists the tool
anyway, and after a restart the agent has no other way to recover its rooms.
The description is kept short, and the tool's share of the per-request listing
is measured when it lands, the way §11 of the architecture doc records the
others.

**D3. The monitor never calls `bellman_sync`.** Through the bridge, `observe()`
reads a `bellman_sync` result as the agent having seen those events:
`seenThrough` moves the watcher's cursor and `discardThrough` deletes them
from the hook inbox. A monitor polling `bellman_sync` would silently eat the
agent's messages. `observe()` has no case for `bellman_rooms`, and that tool
nests `session_id` under `rooms[]`, so the bridge does nothing with its result.

**D4. "Unread" is "new since you opened this view".** The server keeps no read
cursor per member; the bridge tracks delivery, deliberately. So the server
cannot say what the agent has seen. `bellman_rooms` returns each room's
`last_event` (cursor, type, at); the UI remembers the first cursor it saw and
counts from there. The same shape serves #49's panel.

**D5. The join screen decides; the agent confirms.** Confirm and Decline each
send one `ui/message` into the conversation. The agent then calls
`bellman_confirm` with the brief it composes about its own session, or
discards the token. The UI does not call `bellman_confirm`: the brief describes
the agent's session, which the human did not write and the UI does not know,
and the agent needs the returned `member_id` and `cursor` in its own context.
Through the bridge this also keeps `observe()`'s `bellman_confirm` case arming
the watcher.

**D6. A `ui/message` carries only server-validated identifiers.** The host adds
it to the conversation as a *user* message. A creator's room name or purpose
inside it would be peer prose speaking with the human's voice: prompt injection
with a signature. The message names the role key (`RoleKeyShape`,
`[a-z][a-z0-9_]{0,30}`), the capability enum values, and "the connect_token
from this preview". Never `room`, `purpose`, a role description or a brief
field.

**D7. A join code string is shown only to a seat holding `invite`.**
`bellman_invite` hands a code only to a seat with that verb; the monitor must
not be a cheaper route to the same authority. Every member sees which roles
have a live code and when each expires. The string and `join_url` appear only
when `verbsOfRole(manifest, me.roomRole)` includes `invite`.

**D8. The beat is the tick's computation.** `snapshotOf` in `heartbeat.ts`
decides `silent_for_seconds` and `silent` (two cadences) for a tick. The
monitor shows the same numbers through the same function, factored so both
call it. A dashboard that said silent where the tick did not would be a second
rule for one fact, the drift `verbsOfRole` exists to prevent for verbs. The row
gains `asked` (whether the room asks this seat at all) and the member's latest
`progress` note.

**D9. One bounded tail read: `recentEvents(sessionId, limit)`.** The last note
per member and `last_event` need the end of the log. `eventsAfter(id, 0)`
reads all of it, which `bellman_sync` tolerates for `outstanding` because a
stamp guards the read; a dashboard polling every 15 s has no such guard.
`SessionDO` keys events `e:<padded cursor>` (`eventKey`), so the tail is one
`list({ prefix, reverse: true, limit })`; `MemoryStore` slices its array.
This crosses the `BellmanStore` seam, so both stores and one case in
`tests/helpers/store-contract.ts`.

**D10. One resource, one bundle, two screens.** `ui://bellman/app.html`, served
by one `resources/read`, dispatches on the result it is handed: a
`connect_token` key renders the join screen, a `rooms` key the monitor. Both
tools point at the same URI. Half the bundle, half the build, one resource to
list.

**D11. The iframe uses the ext-apps `App` class; the server uses the SDK it
has.** `@modelcontextprotocol/ext-apps` 2.x peer-depends on the v2 split
packages. `react`, `react-dom` and `@modelcontextprotocol/server` are optional
peers; `@modelcontextprotocol/client` (and through it `core`) is required.
Installing it as a devDependency adds those two beside
`@modelcontextprotocol/sdk` 1.x: different package names, no conflict, and
nothing in `src/` imports them. Its `./server` helpers expect a v2 `McpServer`
and are not used. The installed SDK's `registerTool` already takes `_meta`,
`registerResource` exists, and registering one resource switches the
`resources` capability on. The mimeType `text/html;profile=mcp-app` is written
once, as a constant beside the registration.

**D12. The UI is built the way the SDK documents it, into a generated
TypeScript module.** Vite with `vite-plugin-singlefile` emits one
self-contained HTML file. A short script wraps it into `src/ui/assets.ts`
(`export const APP_HTML: string`), which is gitignored. tsc, vitest and
wrangler then import plain TypeScript, and no runtime reads a file, which the
Worker could not. Every script that compiles or runs the server runs
`build:ui` first.

**D13. The bridge proxies resources.** It declares `resources`, forwards
`resources/list` and `resources/read` to the remote, and the `Remote` seam
gains the two calls. Tool `_meta` already passes through `advertised()`. This
is what lights the UI up for the Desktop `.mcpb` bundle, whose host talks to
the bridge over stdio.

**D14. No writes from the UI.** The monitor reads; the join screen hands the
decision to the agent (D5). A later screen that writes goes through a tool
with its verb check, like every write.

## `bellman_rooms`

Arguments: none.

Rooms: the union of `sessionsCreatedBy(userId, LIMIT)` and
`sessionsJoinedBy(userId, LIMIT)`, each read with `getSession`. A room is
listed when it is not closed and the caller holds a member with
`leftAt === null`. Closed rooms are over. Frozen rooms are listed with
`status: "frozen"`, because paying fixes those. A member who left, or was
removed, does not see that room here; its history stays readable through
`bellman_sync` as before. `LIMIT` is 50 per index. A hub user past that needs
a bigger listing, which is #49's.

Per room:

- `session_id`, `status` (`sessionStatus`), `expires_at`, `max_members`,
  `active_members`
- `room`: `roomPreview(session, me.roomRole)`. Your role, your verbs and
  whether you report come through the accessors the server enforces with, and
  `text` inside it is the untrusted envelope the preview already uses for the
  room's name, purpose and role descriptions
- `your_member_id`
- `members[]`: `publicMember(m, connected)`, which carries `room_role` and
  `presence`, plus `beat`: `{ asked, last_report_at, silent_for_seconds,
  silent, note }`. `note` is `untrusted(origin, { note, step?, eta_seconds? })`
  from the member's latest `progress` in the tail, or `null`. `silent` is
  false when the seat is not asked or the room has no cadence
- `join_codes[]`: `{ role, expires_at }`, plus `code` and `join_url` when the
  caller's seat holds `invite` (D7)
- `last_event`: `{ cursor, type, at }` from the tail, or `null`

Text result: `UNTRUSTED_PREAMBLE` when any room is listed, then the JSON,
through `ok()`. Annotations: `readOnlyHint: true`. It writes nothing, and
unlike `bellman_sync` it does not touch `lastSeenAt`, so a UI polling it does
not hold a dead agent's seat. `_meta: { ui: { resourceUri } }`.

Shaping lives in `projections.ts` (`roomSummary`, `beatOf`) with no runtime
import, so #49's `GET /api/rooms` reuses it. The tail read and
`connectedMembers` are per room, so N rooms cost about 3N object calls per
poll. `ponytail:` acceptable at a 15 s cadence over tens of rooms; a
registry-side summary is the upgrade if the panel polls the same way.

## The join screen

Rendered when `bellman_connect` returns. Reads `structuredContent`:

- the creator's label (server-stamped), and the creator brief's goal, state,
  constraints, open questions and agent (provider, model, client), in a frame
  captioned as the creator's words, unverified
- `room.text` (name, purpose, role descriptions) in the same frame
- a roles table: each role's verbs and whether it reports, with **your seat**
  highlighted: `your_role`, `your_verbs`, `you_report`, `heartbeat_on_seconds`
- `session`: active members over max, mode, org_only
- `connect_token_expires_at` as a countdown
- three capability checkboxes, each with one line of meaning: `read_context`
  and `receive_messages` checked, `request_actions` unchecked
- Confirm sends, through `app.sendMessage`: "Confirm joining the room previewed
  by bellman_connect as role `<your_role>`, with capabilities `<list>`. Call
  bellman_confirm with the connect_token from that preview and a brief about
  this session." Decline sends: "Do not join the room previewed by
  bellman_connect. Discard its connect_token." Both buttons disable after one
  click and the screen says the message went to the agent.

## The monitor

Rendered when `bellman_rooms` returns, and re-rendered from its own
`callServerTool({ name: "bellman_rooms" })` every 15 s while
`document.visibilityState` is `visible`, plus a Refresh button. Per room: name
and status, mode and preset, expires-in, your seat (role, verbs), a members
table (label, role, presence, and the beat: last report as relative time, the
note, quiet-for, a silent marker), join codes (role, expiry, the string when
visible), the last event, and "N new since you opened this" from the first
`last_event.cursor` seen. Theme from `getHostContext()` and
`onhostcontextchanged`, through `applyDocumentTheme`.

## Trust

- Every peer-authored string reaches the DOM through `textContent` or
  `createTextNode`. No `innerHTML` with data in it anywhere under `ui/`. A test
  renders hostile strings (`<img onerror>`, `</script>`, `<channel>`) and
  asserts they appear as text.
- The host's iframe is the sandbox. The resource declares `prefersBorder: true`
  and no `csp` domains: the UI loads nothing external and calls only tools.
- D6: no peer prose in a `ui/message`.
- D14: no writes.
- The untrusted envelope is unchanged on the wire. The UI is one more reader
  that frames peer content as peer content, the job `renderEvent` does for the
  bridge.

## Bridge

- `capabilities.resources: {}` beside `tools`.
- `ListResourcesRequestSchema` forwards to `remote.listResources()`;
  `ReadResourceRequestSchema` forwards to `remote.readResource(params)`.
  `Remote` gains both, `connectRemote` implements them, and the test fakes
  grow two one-line methods.
- `observe()` is unchanged (D3).
- `extension/manifest.json` adds `bellman_rooms`; `tests/extension.test.ts`
  moves to twelve.

## Build

```
ui/
  index.html          the one entry
  src/main.ts         App setup; dispatches on the result's shape (D10)
  src/join.ts         render functions, pure: data in, DOM out
  src/monitor.ts      render functions, pure
  src/shared.ts       DOM helpers that only ever set text; relative time
  src/style.css
  vite.config.ts      viteSingleFile, outDir ui/dist
  tsconfig.json       DOM lib; outside the root programs
  test/render.test.ts
scripts/wrap-ui.ts    ui/dist/index.html to src/ui/assets.ts
src/ui/assets.ts      generated, gitignored
src/ui/resource.ts    APP_RESOURCE_URI, APP_MIME_TYPE, registerAppResource(server)
```

devDependencies: `@modelcontextprotocol/ext-apps`, `vite`,
`vite-plugin-singlefile`. Vite is already in the tree through vitest, and is
listed because `ui/` imports it. `build`, `test`, `typecheck`,
`typecheck:worker`, `dev:worker`, `deploy` and `verify` run `build:ui` first,
and `typecheck:ui` joins `verify`. The `.mcpb` copies `dist/` wholesale, so
`dist/ui/assets.js` ships with it and `extension/build.sh` does not change.

## Documentation

- README: the rule above; a `bellman_rooms` row in the tool table; a line in
  *Claude Desktop* saying the join screen and the monitor render there.
- `docs/ARCHITECTURE.md`: §2 says ten tools and the resource; §4's Claude
  Desktop row loses "until MCP Apps (#28)"; §8 marks C3 shipped; §11 gains the
  measured cost of the new tool.
- `CLAUDE.md`: "A new tool means editing `extension/manifest.json`" stands.
  Add that `ui/` is built into `src/ui/assets.ts` and never committed.

## Testing

Every assertion runs against a deliberately broken version first and must fail
there.

Server, `tests/tools/rooms.test.ts`, through the harness:

1. Lists a room the caller created and one it joined; omits a closed room;
   lists a frozen one with its status.
2. A member who left, and one who was evicted, does not see that room.
3. `your_member_id` and `room.your_role` are the caller's seat, not the
   room's default.
4. `code` and `join_url` present for a seat with `invite`, absent for one
   without; `role` and `expires_at` present for both.
5. `beat` matches the tick: after one member's `progress` and a tick,
   `silent_for_seconds` and `silent` equal the rows `snapshotOf` produced at
   the same `now`; `asked` is false for an observer; `note` is an untrusted
   envelope whose origin is the sender.
6. `last_event` is the newest event, and `null` on a room with none.
7. The text result opens with `UNTRUSTED_PREAMBLE` when a room is listed.
8. `readOnlyHint` is true; `_meta.ui.resourceUri` equals the resource URI; a
   call does not move the caller's `lastSeenAt`.

Surface, `tests/tools/surface.test.ts`: ten tools; `resources` present,
`prompts`, `completions` and `logging` absent; `resources/list` returns one
`ui://` resource with the mimeType; `resources/read` returns an HTML document;
`bellman_connect` and `bellman_rooms` carry `_meta.ui.resourceUri` and no
other tool does.

Store, `tests/helpers/store-contract.ts`: `recentEvents` returns the last
`limit` events in cursor order, fewer when the log is shorter, and nothing for
an unknown room. Both stores.

Bridge, `tests/bridge.test.ts`: lists and reads the remote's resource through
the bridge; a `bellman_rooms` result arms no watcher.

Extension, `tests/extension.test.ts`: twelve.

UI, `ui/test/render.test.ts`, vitest with jsdom: the join and monitor
renderers, given fixture results, show the role, verbs, members and beat; the
hostile strings appear as text; the Confirm message contains the role key and
the capabilities and does not contain the room name or purpose.

Manual, recorded in the PR: both screens rendered in claude.ai or Claude
Desktop against the deployed Worker, and the `.mcpb` bundle rendering through
the bridge in Desktop.

## Out of scope

- A room card on `bellman_start` (the code and link as a screen). Same bundle,
  later.
- Any write from the UI: approving an `action_request` from the monitor,
  reissuing a code.
- `visibility: ["app"]` and extension negotiation (D2).
- Outstanding action requests in the monitor; they ride `bellman_sync`.
- The dash panel. It shares `projections.ts`, not this iframe.
- The working surface as a canvas: `2026-10-08-mcp-apps-canvas-design.md`
  (2026-10-08), which added `bellman_surface` and the third screen.
- Claude Code's terminal, which keeps the text.

## Acceptance

From #28:

- [ ] A Claude Desktop connector user who asks to join with a code sees the
      creator's brief in a frame marked as the creator's, the roles, the seat
      the code grants, chooses what to grant, and Confirm leads to the agent
      calling `bellman_confirm` with that role and those capabilities.
- [ ] A user who asks for their rooms sees each room, its members with their
      roles, presence, each member's last beat (when, what it said, how long
      quiet), the room's and the codes' expiry, and the count of events since
      the view opened.
- [ ] A text-only host sees exactly the results it saw before, plus the
      `bellman_rooms` tool.
- [ ] README states the new rule and the surface test pins it.
- [ ] Rendering confirmed in Claude Desktop as a connector and in the `.mcpb`
      bundle, recorded in the PR.
