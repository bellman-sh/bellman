# The Canvas UI in dash — Design

Issue: [#129](https://github.com/bellman-sh/bellman/issues/129), piece 3 of 4; the first real consumer of [#49](https://github.com/bellman-sh/bellman/issues/49)
Status: approved design, pending implementation plan
Depends on: piece 1 — [the working surface](2026-10-06-working-surface-design.md); piece 2 — [blobs](2026-10-06-surface-blobs-design.md); #48 (landed — [a browser session for dash](2026-10-02-dash-browser-session-design.md))
Feeds: piece 4 — [HTML artifacts](2026-10-06-surface-html-artifacts-design.md) — which supplies the sandbox this page embeds for `diagram` and `html`
Repos: `bellman-sh/bellman` (the routes) and `bellman-sh/dash` (the page)

## Problem

Agents read the surface as JSON. The human in the room has no view of it, a
hosted connector's human has no way to put a document on it, and nothing
renders an image, a diagram or the lines between items. `dash` is an app shell
with a placeholder at `/rooms/$roomId`, a cookie session, and no route to call.

Two things are missing, in two repos: room routes on the Worker that answer a
browser, and a page that draws the surface as the infinite canvas it is.

## Scope

**In scope:**

1. The room routes piece 3 needs, under `/rooms/*` beside piece 2's blob
   routes: list, detail, surface read, surface write.
2. The canvas page: pan, zoom, items as nodes, connectors as edges, a node per
   kind, attribution on every node.
3. Human writes: add text and links, move items, connect items, remove items,
   upload a document or image.
4. Live updates by polling, cheap when nothing changed.
5. A content security policy for the panel, because this is the first page
   that renders peer content.

**Out of scope:** the rest of #49 (events timeline, audit filters and export,
close, invite and evict from the panel), the `/ws` socket for the panel,
rendering `diagram` and `html` (piece 4 — this page shows a diagram's source
until then), multi-select and grouping, presence cursors.

## Decisions

### D1 — Routes first, and only the ones this page calls.

```
GET    /rooms                              rooms I created or hold a handle in
GET    /rooms/:id                          the room as my seat sees it
GET    /rooms/:id/surface                  every item, in envelopes; ETag = surface cursor
PUT    /rooms/:id/surface/:key             write an item (the body is the item)
DELETE /rooms/:id/surface/:key             remove an item
```

All in `src/http/rooms.ts`, with piece 2's blob routes. Every one authenticates
through `caller` (bearer or cookie), answers with `corsHeaders` for the panel
origin, and a cookie mutation passes `csrfRefusal`. Tenant scoping is
membership: a room the caller holds no handle in is 404, the same answer as a
room that does not exist, so the route never confirms a room id to a stranger.

**The write routes call the operation the tool calls.** Piece 1 is amended to
put `writeSurface` in `src/rooms.ts`, the way `issueInvite` lives there, and
`bellman_send`'s `surface` branch and `PUT /rooms/:id/surface/:key` both call
it. That is what `rooms.ts` exists for: a second transport re-typing the
sequence would be a second chance to skip the verb guard or the audit row. A
route maps the `RoomResult` to a status — `forbidden` is 403, `invalid` is 400,
`frozen` is 409 — and nothing else.

`GET /rooms` resolves each id from `sessionsCreatedBy` and `sessionsJoinedBy`
with a `getSession` and returns `{ id, room, mode, status, members, mine,
expires_at }`, bounded at 50. That is the cost #49 warns about and it is paid
here as #49 would pay it; a summary index is that issue's work when the list is
long enough to need one.

`GET /rooms/:id` returns `roomPreview` for the caller's seat, the roster through
`publicMember`, `session_status`, and `my_handles: [{ member_id, room_role,
verbs }]` — the handles this identity owns here, which is what the page needs to
know whether to show the write affordances at all.

### D2 — The surface read carries an ETag, so polling is cheap.

`GET /rooms/:id/surface` answers `{ surface_cursor, items }` with the same
projection `bellman_sync surface: true` returns — envelopes intact, the #49
rule that peer content stays framed. The log's own `cursor` is not in it: the
record carries the surface cursor and not the log's head, so it would cost the
row read the ETag exists to avoid, and the page has no use for it until the
timeline (#49). `ETag: "<surface_cursor>"`, and a
request carrying `If-None-Match` that matches answers 304 from the session
record alone, with no row read. The page polls every four seconds and most
polls cost one record read. A removed member is served to its cut, as the tool
is.

The `/ws` socket is the upgrade: it already carries every event to a bearer
caller, and admitting the panel's cookie is one change to `resolveCaller` plus
the `Origin` check a handshake can carry. It is not done here because polling
with an ETag is a page's worth less code and the first room will not notice
the difference.

### D3 — React Flow draws the canvas.

`@xyflow/react` (v12): a controlled `ReactFlow` with `nodes` and `edges` from
the surface, `onNodesChange` through `applyNodeChanges`, `onNodeDragStop`
writing the placement back, `onConnect` writing a connector, custom node types
per kind, `fitView`, `Background`, `Controls`, `MiniMap`.

The ladder was climbed. Pan, zoom to cursor, drag, selection, edge routing,
keyboard and touch are not a few lines; they are the library, and the first
version without it is a month of edge cases that every node-editor has already
solved. It is MIT, maintained, and this is exactly its shape.

Items map to nodes: `id` is the key, `type` is the kind, `position` is the
placement, `data` is the envelope. Connectors map to edges by their `ends`; an
edge whose end names no item is dropped from the render, which is piece 1's D2
read from the other side. An item with no placement gets a slot in a grid by
key order, computed on the client and **not written back** — every viewer
derives the same grid, and a write would make every viewer a writer. The first
drag writes it.

### D4 — Every kind renders without executing anything.

| kind | node |
|---|---|
| `text` | markdown through `react-markdown` with no raw HTML and the default URL transform, so a `javascript:` href renders inert; links open in a new tab with `rel="noopener noreferrer nofollow"` |
| `link` | the title, the host, an anchor with the same attributes; the server already bounds the scheme |
| `image` | `<img loading="lazy">` from the download route; the cookie is same-site and rides the request |
| `file` | name, size, type, and a download link |
| `diagram` | the source in a `<pre>`, until piece 4 swaps in the sandbox frame |
| `html` | a placeholder naming the artifact, until piece 4 |
| `connector` | an edge, labelled |

Every node shows who wrote it and when, read off the envelope's `origin` and
the item's `at`: the data is peer content, and attribution is the one thing
the page must never let the content hide.

No `dangerouslySetInnerHTML` anywhere in `dash`, and `react/no-danger` in the
lint config pins it. Nothing on this page runs a peer's script; piece 4 is where
that becomes possible, somewhere else.

### D5 — The panel gets a content security policy.

`dash` has none today. This page is the first that renders peer content, and the
panel holds the account cookie, so the policy lands with it, as a `_headers`
file Cloudflare Pages serves:

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self' https://mcp.bellman.sh;
  img-src 'self' https://mcp.bellman.sh data:;
  frame-src <the sandbox origin, piece 4>;
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`style-src 'unsafe-inline'` because React Flow positions nodes with inline
`style` attributes, and a nonce cannot reach an attribute. Scripts are
`'self'` only, which is what makes an injected `<script>` inert and is the
line the whole page stands on. The sandbox origin in `frame-src` is piece 4's
one hook into this policy.

### D6 — Human writes go through the seat the human holds.

A person is an identity; a member is a handle; the handle is what holds the
verb. The page takes `my_handles` from `GET /rooms/:id`, picks the handle whose
`verbs` include `write_surface`, and sends it as `?member_id=` on every write.
With no such handle the write affordances are hidden, which is a courtesy; the
server refuses either way.

The writes: a dialog for a `text` item (title, body) and a `link` (title, URL);
drag to move; connect two nodes to write a `connector`, keyed `conn_` plus six
random characters; remove from a node's menu; a file picker that `POST`s to
piece 2's upload route and then writes a `file` or `image` item keyed from the
filename, slugified, with a short suffix so two uploads of `plan.pdf` do not
collide. An upload is the one human-only path on this page: a hosted
connector's human has no bridge, and this is how their document reaches the
room.

### D7 — The page and its client.

`src/routes/room-detail.tsx` becomes the canvas, full-bleed inside the shell,
with a collapsible side panel: the roster with presence, and the item list
with a "locate" that pans to a node. `src/lib/api.ts` is one typed client over
`fetch` with `credentials: "include"` against `VITE_API_ORIGIN`, defaulting to
`https://mcp.bellman.sh`, carrying the wire types this page reads with a
comment naming the projection each one mirrors.

The hand-copied types are the debt #49 named. The fix it proposed — a
types-only subpath export of `@bellman-sh/mcp-server` — is the right one and is
not done here; it is the follow-up to take before a third consumer copies them
again.

## Security

- **Peer content never executes in the panel's origin** (D4, D5). Markdown
  renders to React elements, images and files come through the download
  route's headers, and a diagram is text here.
- **The policy is the line** (D5). An XSS on this page is account takeover,
  the architecture's own words, and `script-src 'self'` is what turns an
  injected script into nothing.
- **Membership is the tenant boundary** (D1). A stranger gets 404 everywhere;
  an org admin with no handle in a room reads nothing of it.
- **Writes are the seat's** (D6). The page chooses a handle; the server checks
  the verb.
- **Links open elsewhere** with `noopener`, so a peer's page gets no handle on
  this one.

## Testing

Worker, over `MemoryStore` and `MemoryBlobStore` (`tests/http-rooms.test.ts`):

- 401 without a credential; 404 for a stranger and an unknown room alike;
  cookie mutations refused without an allowlisted `Origin`.
- `GET /rooms` lists created and joined rooms, marks `mine`, and omits a room
  the caller holds no handle in.
- `GET /rooms/:id` carries `my_handles` with the verbs the seat holds.
- `GET /rooms/:id/surface` returns envelopes; `If-None-Match` matching the
  surface cursor answers 304; a write moves the ETag.
- `PUT` through the route and a read through `bellman_sync surface: true` agree,
  and the reverse; a `PUT` from a seat without the verb is refused and the log
  is unchanged — one operation, two transports.
- A removed member's read stops at its cut.

Dash gains `vitest` and `@testing-library/react`, and tests the parts that are
logic (`src/routes/room-detail.test.tsx`, `src/lib/canvas.test.ts`):

- items to nodes and edges: a dangling connector is dropped, unplaced items
  take deterministic grid slots, and placed items keep their placement.
- a `text` body with a `javascript:` link renders an anchor with no such
  `href`, and every anchor carries `noopener`.
- the handle chosen for a write is the one holding `write_surface`, and with
  none the affordances are absent.
- the `_headers` policy string contains `script-src 'self'` and no
  `'unsafe-inline'` for scripts — a pin, so a convenience edit cannot loosen
  it silently.

Manual, before calling it done: `npm run dev` in `dash` against `wrangler dev`
in `bellman`, a room with a text, a link, an image and a connector, dragged,
reloaded, and read back through `bellman_sync surface: true` from a second
session.

## Files

**`bellman-sh/bellman`**

| File | Change |
|---|---|
| `src/http/rooms.ts` | the five routes, beside piece 2's |
| `src/rooms.ts` | `writeSurface` (the piece 1 amendment) called by both transports |
| `src/tools/send.ts` | the `surface` branch calls `writeSurface` |
| `src/projections.ts` | `roomSummary` for the list |
| `docs/ARCHITECTURE.md` | §4 gains the panel as a surface; §8 |
| `tests/http-rooms.test.ts` | **new** |

**`bellman-sh/dash`**

| File | Change |
|---|---|
| `package.json` | `@xyflow/react`, `react-markdown`; `vitest`, `@testing-library/react` |
| `public/_headers` | **new** — the policy |
| `src/lib/api.ts` | **new** — the client and wire types |
| `src/lib/canvas.ts` | **new** — items to nodes and edges, the grid |
| `src/routes/room-detail.tsx` | the canvas page |
| `src/components/canvas/*` | one node component per kind, the side panel, the dialogs |
| `src/routes/rooms.tsx` | the list, from `GET /rooms` |
| `oxlint` config | `react/no-danger` |

## Out of scope

- **The rest of #49** — events timeline, audit, close, invite, evict from the
  panel. The routes here are the shape it proposed, and they leave the rest to
  it.
- **The `/ws` socket for the panel** — D2 names the change; polling first.
- **Rendering `diagram` and `html`** — piece 4.
- **Shipping the wire types** — D7's follow-up.
- **Presence cursors, multi-select, grouping, z-order** — the first room that
  needs them.
