# The Claude Code mod. Design

**Date:** 2026-10-16
**Status:** approved in conversation; implementation plan to follow
**Builds on:** the room delivery spec (`2026-09-29-room-delivery-design.md`), the MCP Apps UI spec (`2026-10-06-mcp-apps-ui-design.md`, D3 and D4), the MCP Apps canvas spec (`2026-10-08-mcp-apps-canvas-design.md`, D1), and attention (#111, `src/attention.ts`)
**Citations:** Bellman by symbol, of the code as it stood when this was written. Claude Code's mod API by its names in the declaration file Claude Code 2.1.301 writes (`claude-code.d.ts`: `PaneOpenArgs`, `UiOpenResult` and the rest). That API is early access and changes between releases. The declaration file of the build in hand is the authority, and every claim here about the API is read from that file, not yet tested.

## Problem

In Claude Code a Bellman room is invisible until something is delivered. The
plugin runs the bridge in hook delivery (`BELLMAN_DELIVERY=hook` in
`plugin/.mcp.json`): the bridge queues peer events in a per-session inbox
(`enqueue`, `inboxDirFor`), and the Stop hook (`src/stop-hook.ts`) hands them to
Claude when a turn ends. So:

- a session nobody is typing into never hears its room: a peer's message waits
  until the person next types and that turn ends;
- nothing on screen says whether the session holds a seat, in which room, or
  who else is there;
- the log and the canvas are reachable only by asking Claude, or in the panel;
- an action request's human approval is an instruction to the model
  (`HOOK_INSTRUCTIONS`, `CHANNEL_INSTRUCTIONS`), and the model can answer
  `action_response` itself.

Channel delivery covers the first, behind `--dangerously-load-development-channels`.

A session reaches Bellman by any of three routes, and may use several at once:
the plugin's bridge (hook delivery); a bridge the person registered
themselves, often in channel delivery (`CHANNEL_INSTRUCTIONS`, no
`bellman_wait`); and the claude.ai connector, which has no local bridge.

A Claude Code **mod** is a plugin's hooks module: `hooks/hooks.json` names one
module under `modules`, exporting `register(on)`, and every hook has the shape
`($, e, next)`. A mod can draw a pane and a band above the prompt, raise
toasts, start a turn in an idle session (`$.prompt.submit`), add a row to a
running turn (`$.session.append`), call the session's connected MCP servers
with its own connection (`$.mcp.call`), and refuse tool calls (`tool.call`).
This design uses one for three things, in the person's order: **wake** on a
peer's message, a **gate** on action responses, and a **room view**.

## Goals

- The person can always see whether the session is in a room, which room, and
  who is there.
- A peer's message starts a Claude turn in an idle session and reaches a busy
  one at its next step.
- A toast shows the latest message.
- One click opens the room: its whole log, its canvas, its members, and the
  action requests waiting on the person.
- Only the person answers an action request in the rooms the mod shows, while
  it can show them.

## Anti-goals

Each of these makes the mod a failure even if everything else works.

- **Peer text reaching the model as the person's words.** Every
  peer-controlled string (message, room name, label, request text, canvas body)
  reaches the model only as it does today: inside a Bellman tool's result,
  marked untrusted. What the mod itself hands the model is fixed text (D7, D8).
- **The mod taking events from Claude.** It calls no `bellman_sync` (MCP Apps
  UI spec D3) and drains no inbox.
- **The mod taking the keyboard on its own.** Toasts and counts; focus only
  when the person clicks or keys into the mod's own surfaces.
- **The mod holding the person's Bellman credential.** The bridge keeps it.
- **A Claude Code that cannot load mods losing anything it has today.** The
  bridge, the Stop hook and the skills keep their roles.

## Decisions

Decisions the person made are marked *(person)*. The rest are the author's
calls, collected under "Calls to check" at the end.

**D1. A plugin of its own, serving every local bridge.** *(person: any local
bridge, in hook or channel delivery; the connector's rooms left out)* The mod
serves the rooms of every local bridge in the session, whatever name its server
is registered under: the plugin's, or one the person registered. Rooms joined
only through the claude.ai connector have no local bridge, so the mod shows
nothing of them and leaves their approvals as they are today (D8). A person who
registered their own bridge has no use for the plugin's, so the mod is a second
plugin in the same marketplace (`.claude-plugin/marketplace.json`), installed
on its own. It is built by `npm run build:plugin` beside the bridge bundles, so
it can share code with `src/`, and the CLAUDE.md rules for
`plugin/bridge/*.mjs` (generated, committed, rebuilt by every release PR,
checked by `tests/plugin.test.ts`) extend to its bundle.

**D2. The view follows the room the terminal has.** *(person)*

- **Wide.** When the terminal draws fullscreen and docks a pane
  (`RenderViewport.isFullscreen`; the Pane's `placement` is `dock`), the mod
  keeps a **sidebar** open: a docked pane about 20 columns wide
  (`PaneOpenArgs.columns`). It holds the bell; the connection; the room, with a
  picker (D3); the preset and member count; each peer with role and presence;
  the unread count; the pending approvals count; and Log, Canvas and Approve
  buttons, stacked top to bottom. Nothing sits above the prompt.
- **Otherwise** (the main-screen layout, tmux, or too narrow to dock): the
  **bell** floats over the transcript's right edge just above the prompt, and
  the **band** returns above the prompt with the same information in two lines:
  connection, room (picker), preset, count and buttons; then each peer with
  role and presence, and the unread count.
- The rule: the band shows whenever the sidebar is not on screen. A sidebar
  that is a tab behind another plugin's pane (`UiPane.isShown` false) counts
  as not on screen.
- Engine limits that shape this: a pane docks in fullscreen from 110 columns.
  A pane the mod opens on its own (at `session.start`) is placed only from 144
  columns, or from 110 once the person has opened that pane id themselves and
  not closed it by hand since (`UiOpenResult`). Below that it waits undrawn,
  and the band and bell cover the gap. `columns` is a request: a width the
  person drags the dock to wins.
- The bell is the Bellman icon (the site's `public/icon.svg`: a gold bell,
  `#D9A521`, on `#11161D`), drawn as pixel art about 10 columns by 4 rows so
  it reads square: each row a plain `Button` holding half-block `Text` cells,
  so the bell itself is what the person clicks. (Only a `Button` takes a press,
  and a `Button` holds only strings and `Text`, so a `Raster` or an `Image`
  could not be the click target.)
- Clicking the bell or a button opens the room pane (D5). In the wide layout
  the sidebar widens into it (the same pane id, opened again with more
  `columns`), and a control in the pane narrows it back. Elsewhere the pane
  opens inline above the prompt. It appears at once: the engine does not
  animate a pane's width, and the person knows.

**D3. Several rooms: a picker on every surface.** *(person)* When the session
holds seats in more than one room, the sidebar, the band and the pane each
carry a room picker. One choice drives all three (one value in `$.state`). The
room shown first is the one with the latest activity.

**D4. What the surfaces show, and from where.**

- **Rooms:** this session's: the seats its local bridges watch (a bridge
  learns them from tool traffic, `observe`). `bellman_rooms` answers for every
  seat the account holds, on any machine; the mod reads it only for the rooms
  this session holds. The person's seat in a room, for approvals, for telling
  their own events apart and for Deny's `member_id`, is the bridge's. After a
  restart or `--resume` a bridge watches nothing until Claude next uses the
  room, and the view says the session is not in a room until then.
- **Connection:** connected, reconnecting, signed out, no bridge (the mod
  cannot reach the bridge), or not in a room. The bridge reports it (D9). With
  no seat, no sidebar and no band: a dim status line entry
  (`$.ui.status`) says Bellman is not in a room.
- **Members and presence:** `bellman_rooms` (each room's `members[]` with
  `room_role`, `presence` and `beat`; `status`; `active_members`;
  `max_members`; `last_event`), called through `$.mcp.call`. It is a read that
  moves nobody's `lastSeenAt`. The mod polls it on the MCP Apps monitor's
  cadence (the interval constant in `ui/src/page.ts`). The list shows peers;
  the count includes the person's own seat.
- **Unread:** new since the person last opened that room's Log (MCP Apps UI
  spec D4: the server keeps no read state).
- **Pending approvals:** action requests in the room that the person's seat
  may act on (it granted `request_actions`), neither answered, declined nor
  expired (30 minutes, per `bellman_send`'s description).

**D5. The room pane: Log, Canvas, Members, Approve.** One pane id, with tabs
the mod draws. It opens on Log, or on Approve when opened from an approval
count or an approval toast.

- **Log:** the room's whole history, newest at the bottom, paged backwards,
  read through the bridge from `GET /rooms/:id/events` (`readEventsRoute`,
  `MAX_EVENTS_READ` a page), which moves no one's `lastSeenAt` and no bridge's
  cursor (D9). A row is the time, the sender's label and the event drawn by
  type: a message's text, a canvas edit as its key and version, a join, an
  action request with Approve and Deny while it is pending.
- **Canvas:** read-only, read with `bellman_surface` (MCP Apps canvas spec D1)
  and drawn per kind: `text` as `Markdown`; `link` as a `Link`; `diagram` as
  its mermaid source in a `Code`; `file` by name and size; `image` as an
  `Image` where the terminal speaks kitty graphics, else its name; `html` as a
  link to the panel, since a terminal does not run pages. `connector` and
  `shape` are the builder's.
- **Members:** each member's role, presence and beat (`silent_for_seconds`,
  `note`).
- **Approve:** *(person)* each pending request: who asked, what was asked (the
  request's payload, drawn as untrusted text, D10), the time left, and Approve
  and Deny.

**D6. Toasts.** *(person: a toast for the latest message; an action request
raises a toast and never takes the keyboard)*

- One toast per interrupting event (D7) from a peer: its sender, room and
  first line. Action requests toast too.
- No toast for the person's own events, for ambient events, or while the
  pane shows that room's Log.
- `$.ui.toast` replaces the mod's own previous toast, so a burst shows its
  newest. No toast or pane of the mod's asks for `focus` or `holdToasts`.

**D7. Wake.** *(person: wake on a peer's message, in every room; no room
stays asleep)*

- What wakes: a peer's event the server marks interrupting (`ambient` absent
  or false on `PeerEvent`; the posture table is `src/attention.ts`), in any
  room. Ambient events keep waiting for the turn end, as now.
- **Hook delivery only.** A bridge in channel delivery already starts a turn
  with its push, so the mod wakes nothing for it.
- **Idle** (no turn running, tracked from `turn.start` and `turn.complete`):
  the mod calls `$.prompt.submit` with fixed text, of the kind "New Bellman
  events are waiting. Read them with bellman_wait." One wake per burst.
- **Busy:** the mod calls `$.session.append` once per batch with a user-role
  row of the same fixed text; the model reads it at its next step.
- Claude reads the events through `bellman_wait`, and whatever it leaves the
  Stop hook still delivers at the turn's end. The trust path stays the
  bridge's, unchanged.
- The wake text contains nothing a peer controls: no room name, no label, no
  message text.
- The mod learns events are waiting without taking them (D9;
  `pendingCount` in `src/inbox.ts` already counts without draining).
- Every wake is a turn, and the person accepted that cost for every room.
- **The limit** *(person)*: after three wakes in a row with no input from the
  person, the mod stops waking until the person types a prompt or presses one
  of the mod's buttons, and the sidebar or band says it has paused. Members
  whose sessions all run the mod would otherwise wake each other on every
  reply with nobody involved. A heartbeat tick counts as a wake.

**D8. The gate.** *(person: Claude cannot answer an action request for the
person)*

- **Approve** is a press (`ui.press`, which only the person raises). The mod
  records the approval by room and cursor in `$.state`, then wakes or tells
  Claude with fixed text naming the request by its session id and cursor (both
  server-made): approved; carry it out; answer with `bellman_send` type
  `action_response`, that `ref_id`, `approved: true` and the result.
- **Deny** is answered by the mod itself: `bellman_send` type
  `action_response`, the `ref_id`, `{ approved: false }`, through
  `$.mcp.call`. Claude takes no turn for it; the mod appends a notice that the
  person declined, so Claude does not act on the request.
- **The gate** is a `tool.call` hook on every tool whose name ends in
  `bellman_send`, on any server, and an `mcp.call` hook on the same tools for
  another plugin calling through `$.mcp.call`. It acts on
  `type: "action_response"` in a room the pane shows (D1); an answer in any
  other room passes as today. In the pane's rooms it passes `approved: true`
  with a `ref_id` the person approved, and refuses every other action
  response, saying the person answers requests in the Bellman pane. It is
  registered with a `.catch` that refuses when the hook failed before calling
  `next`, so a broken gate stays shut.
- **Where it shuts** *(person)*: only while a terminal is attached
  (`$.session.surfaces()`) and the mod's Approve tab is drawing there. Wherever
  nothing draws Approve (the desktop app, VS Code, `claude -p`, the SDK, a pane
  broken by an API change), approval works in chat, as it does today.
- **What it is** *(person)*: a guard against Claude answering on its own, and
  no proof to the requester. A prompt-injected Claude could still read the
  bridge's saved sign-in and post an answer another way. Only the server can
  prove a person pressed Approve, and that is a separate issue.
- The gate guards the answer, not the act: Claude can still do what a request
  asks before the person approves. Claude Code's own permission rules guard
  the tools themselves.
- Approval comes only from a press. A slash command or a chat reply would be
  input the model can produce too (Claude can run some slash commands).
- `HOOK_INSTRUCTIONS` and `CHANNEL_INSTRUCTIONS` tell the model to ask the
  human in chat. While the gate is shut the mod tells the model instead,
  through a system-prompt section (`prompt.compose`), that approvals for the
  pane's rooms happen in the Bellman pane and that it will be told the answer.

**D9. The bridge grows a local door.** The mod needs three things the bridge
holds: whether events are waiting (counts per room, interrupting or ambient,
taken without draining), the room log (the events route needs the credential),
and the connection state. The bridge serves them on a **door**: a local,
per-bridge HTTP endpoint on a Unix socket, which the mod reaches with
`$.http.fetch(url, { socketPath })`. The mod finds each local bridge by the
bridge's own `bellman_whoami` tool, on whichever server lists it (the
connector lists none), and reads that bridge's door from a field added to the
tool's result, through `$.mcp.call`, so no new tool appears and
`extension/manifest.json` stays as it is. A bridge in channel delivery keeps no
inbox, so its door serves everything but the waiting counts, which only wake
uses. `$.http.fetch` resolves only once the body is read, so the mod polls the
door on a short timer; the polling is local, and the bridge's own connection to
the room (the bus) is unchanged. The builder may find a better way for the mod
to find its door. Whatever replaces it keeps all four properties: one door per
Claude Code session, the credential stays in the bridge, no new tool the model
sees, nothing drained.

**D10. Peer text is untrusted on screen too.** Every peer-controlled string the
mod draws has control characters stripped first; pane titles refuse them
anyway (`PaneOpenArgs.title`). Links from peers' canvas text open only when
they are `http` or `https`. Nothing peer-controlled is passed to
`$.prompt.submit`, `$.session.append` or a system-prompt section. This applies
CLAUDE.md's rule on peer content to a new surface, and the PR says so out
loud.

**D11. Terminal only.** *(person: the desktop app already draws Bellman through
the MCP Apps `ui://` page, `src/ui/resource.ts`, so it needs nothing from the
mod)* The mod's render hooks are raised on every attached surface. They draw on
`terminal` and pass `next(e)` on `desktop`, `vscode` and `mobile`, which keep
showing what they show today.

## Open questions for a spike

The builder answers these on the build in hand before planning around them.

1. What does a Claude Code build without mods do with a plugin that is only a
   hooks module: skip it quietly, or refuse it at install? (D1)
2. How narrow can a docked pane be? The sidebar wants about 20 columns. (D2)
3. How far above the band can a `Box` with `position: "absolute"` paint? The
   floating bell sits four to six rows up. (D2)
4. Does the mod's own `$.mcp.call` of `bellman_send` (Deny) pass through its
   own gate, and if so, is it let through? (D8)
5. How does `$.prompt.submit`'s text appear in the transcript (the
   `UserMessage` site), and can the mod make it read as a Bellman notice
   rather than as the person's typing? (D7)
6. Does Orca (`TERM_PROGRAM=Orca`, the person's terminal) draw the `Raster`
   bell, and does it speak kitty graphics? (D2)
7. The door, and finding every local bridge whatever its server is called.
   (D9)
8. How the gate tells that the Approve tab is drawing on an attached
   terminal. (D8)

## Testing

- The mod, with the engine's kit (`claude plugin test`), each test seen failing
  against a broken implementation first:
  - the gate refuses an action response the person did not approve, refuses
    Claude's `approved: false`, refuses when its hook throws, and passes an
    approved one;
  - the gate passes an action response in a room the pane does not show,
    stays open when no terminal draws Approve, and its `mcp.call` hook refuses
    another plugin's unapproved answer;
  - the wake limit: three wakes with no input from the person, then none until
    a prompt or a press, and the sidebar or band says it paused;
  - a bridge in channel delivery gets the view and the gate, and no wake;
  - wake: idle gives one `$.prompt.submit`, busy gives one `$.session.append`,
    an ambient event gives neither, and a burst gives one;
  - the band draws when the sidebar is not placed or not shown, and passes
    `next(e)` when it is;
  - no peer string reaches `$.prompt.submit`, `$.session.append` or a section:
    feed a hostile label, room name and message, and assert the texts handed
    to the model;
  - UI tests loop over `['terminal', 'desktop'] as const`; desktop expects
    `next(e)` (D11).
- The bridge's door, with vitest: counts read through the door leave the inbox
  holding every event; the log read carries the bridge's credential and never
  returns it.
- `claude plugin validate` on the plugin folder in `npm run verify`. Whether CI
  can run `claude plugin test` (it needs the Claude Code CLI) is the builder's
  to find out.

## Out of scope

- Editing the canvas from the pane.
- A per-room mute or quiet hours.
- Approving from chat or a slash command (D8).
- Drawing on desktop, VS Code and mobile (D11).
- Native OS notifications (`$.ui.notify`).
- Replacing the bridge, the Stop hook or channel delivery.
- Rooms joined only through the claude.ai connector (D1).
- Restoring a session's rooms after a restart or `--resume` (D4).
- Server-side proof that a person approved (D8): a separate issue.

## Left to the builder

The door's routes and the mod's polling cadence; the band's and the sidebar's
exact copy, glyphs and colors; the pixel map of the bell; the Log's page size
and scrolling; how `connector` and `shape` items show; the burst window for
wakes and toasts; the `$.state` contract's names; where the mod's tests live.

## Calls to check

The author made these without the person:

- D1: the mod is its own plugin in the Bellman marketplace, so it installs
  beside a bridge the person registered; built by `npm run build:plugin`.
- D2: a sidebar behind another plugin's pane counts as not on screen.
- D2: the bell is pixel art in half-block text, the clickable form; no crisp
  icon.
- D3: the room shown first is the one with the latest activity.
- D4: the view shows this session's rooms only; after a restart or resume,
  none until Claude uses the room again.
- D4: with no seat, only a status line entry; the members list shows peers.
- D4: unread is "since you last opened the Log".
- D5: the pane opens on Log, or on Approve from an approval; the canvas is
  read-only and drawn per kind as listed.
- D6: which events toast.
- D7: a press on one of the mod's buttons counts as the person's input for the
  wake limit.
- D8: Deny goes out without a Claude turn, with a notice to Claude; approval
  only by a press; the gate also hooks `mcp.call`; the system-prompt section.
- D9: a local door on the bridge, found through `bellman_whoami`.
