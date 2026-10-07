# Surface Blobs: Documents and Images — Design

Issue: [#129](https://github.com/bellman-sh/bellman/issues/129), piece 2 of 4
Status: approved design, pending implementation plan
Depends on: piece 1 — [the working surface](2026-10-06-working-surface-design.md) — for the item, the verb and the event
Feeds: piece 3 — [the canvas UI](2026-10-06-surface-canvas-ui-design.md) — which uploads through the panel; piece 4 — [HTML artifacts](2026-10-06-surface-html-artifacts-design.md) — which stores an artifact as one of these
Related: #49 (the HTTP room routes this starts), #65 (retention — deliberately not decided here), #158 (who may read a room — the download rule is membership, and nothing wider)

## Problem

Piece 1 gives a room a surface of items, and an item's body is 8,000
characters of text. A document, an image, or anything binary has nowhere to go:
an event payload is 20,000 characters of JSON, a row in the room object is
bounded at 2 MB with its key, and a hosted MCP connector has no binary channel
at all — a tool argument is a JSON string.

The surface needs a home for bytes, a door to put them through, and a way for
an agent on every surface to reach that door.

## Scope

**In scope:**

1. An R2 bucket for a room's bytes, keyed by room.
2. Two HTTP routes on the Worker: upload and download, authenticated as every
   other route is, gated by membership and by the `write_surface` verb.
3. Two item kinds, `file` and `image`, that reference a blob.
4. A bridge tool, `bellman_upload`, that reads a local file, uploads it and
   places it, in one call.
5. A per-file cap and a per-room quota by plan.

**Out of scope:** deleting a blob and retention (#65), virus scanning, a
public read, multipart or resumable uploads, image resizing or thumbnails,
rendering anything (piece 3).

## Decisions

### D1 — Bytes live in R2, keyed by room. No index row.

One bucket, bound as `BLOBS`. An object's key is `rooms/<sessionId>/<blobId>`,
with `blobId` sixteen random bytes as hex.

The key prefix is the ownership. A download route for room A can only `get`
under `rooms/A/`, so a blob id from another room does not resolve, and nothing
has to check a table to know whose bytes these are. The object's own metadata
is the metadata: `httpMetadata.contentType` as validated at upload, and
`customMetadata` carrying `name`, `by` (the uploading member) and `at`. No row
in the room object describes a blob, because a row and an object are two
systems with no transaction between them, and the one that holds the bytes is
the one that cannot lie about them.

What that costs: a blob the surface no longer references is invisible from the
room. `list({ prefix: "rooms/<id>/" })` is how a sweep finds them, and that
sweep is #65's.

### D2 — The door is HTTP, not MCP.

```
POST /rooms/:id/blobs?member_id=<handle>&name=<filename>
  Authorization: Bearer …     or the panel cookie
  Content-Type: <what the client says>
  Content-Length: <bytes>     required
  <raw body>
→ 201 { blob_id, bytes, type, name }
```

Raw body, not multipart: it streams straight into `BLOBS.put(key, request.body)`
with nothing buffered in the Worker, and both the bridge (a `Buffer`) and a
browser (a `File`) send one that way. `Content-Length` is required (411 without
it) because the cap is enforced from the header before a byte is read (413
over it), and because R2 needs the length to stream a body in.

Authenticated as `/mcp` and `/account` are, composed: `resolveCaller` for an
OAuth access token or a static `BELLMAN_KEY` bearer, then the OAuth `caller`
for the panel cookie — so what counts as a caller cannot differ between a tool
and a route, and the bridge's key reaches the route as it reaches the tools. The
handle must be the caller's (`findMember`), in the room, and its seat must hold
`write_surface`: uploading is the storing half of placing a file, and a seat
that cannot place one should not fill the bucket. A cookie caller passes the
CSRF check every cookie-authenticated mutation passes (`csrfRefusal`, the
`Origin` allowlist). Frozen and closed rooms refuse, as every write does.

A new `src/http/rooms.ts` holds this route and the download, and is where
piece 3's room routes go. `src/worker.ts` dispatches `/rooms/` to it ahead of
the OAuth routes. The `caller` function in `src/oauth/routes.ts` is exported
for it.

### D3 — Put, then charge. The quota is a record on the room.

Entitlements gain `blobBytesPerRoom`, and the session gains two numbers:
`blobBytesCeiling`, stamped at creation from the creator's plan the way
`maxMembers` and `expiresAt` are, and `blobBytes`, the sum charged so far. The
ceiling is the room's, not the uploader's: a free member in a team room shares
the team room's allowance, because a room is what a plan rations. A room
written before the field existed reads the free ceiling until it expires. One
new store method decides the charge inside the room object, reading the
room's own ceiling:

```ts
chargeBlobBytes(sessionId, bytes): Promise<
  | { ok: true; used: number }
  | { ok: false; reason: "over_quota" | "frozen" | "closed" | "not_found"; used: number }
>
```

The route pre-checks the ceiling against the record it already read (a
courtesy, so a hopeless upload is refused before the bytes move), puts the
object, then charges. A refused charge — over quota, or a room that froze or
closed while the bytes were in flight — deletes the object and answers 413 or
409. A delete that fails leaves an orphan.

Put-then-charge rather than charge-then-put, deliberately. A charge reserved
before an upload that never completes — the client dies mid-body — is a phantom
that locks quota with nothing anywhere to list; an orphan object costs storage
only and the prefix list finds it. Both are the cross-system window
[ARCHITECTURE.md §9](../../ARCHITECTURE.md) names, and this is the side on which
the loss is findable.

The numbers, every one a `ponytail:` constant: 25 MB per file (the zone's own
request bound is 100 MB); 50 MB per room on `free`, 500 MB on `pro`, 5 GB on
`team`. A room's bytes do not count against any monthly figure, because a room
is what a plan already rations.

### D4 — Download is membership, served as a download.

```
GET /rooms/:id/blobs/:blobId
→ 200, the bytes
```

Who: an identity that holds a member handle in the room that a `/ws` watch
would admit — in the room, left of its own accord, or timed out. A member a
creator removed is refused, as `/ws` refuses it: the cut (#113) bounds what it
reads, and comparing a blob's upload against the cut would need the index D1
declined. A removed member keeps the `file` item in its history and not the
bytes. A closed room serves its blobs, because reads stay open to a closed
room and the surface outlives the session (piece 1, D5). An unknown room and a
room the caller is no member of both answer 404, so a stranger learns nothing.

How: `Content-Type` as stored only for the image allowlist — `image/png`,
`image/jpeg`, `image/gif`, `image/webp` — and `application/octet-stream` for
everything else, with `Content-Disposition: attachment; filename*=UTF-8''…`
on everything that is not an image; `X-Content-Type-Options: nosniff` always;
`Content-Security-Policy: sandbox` always, so a browser that ever renders one
of these top-level runs nothing in it; `ETag` from R2 and `If-None-Match`
honoured through `onlyIf`; `Cache-Control: private, max-age=300`. CORS for the
panel origin through `corsHeaders`, so the panel can `fetch` an artifact's
bytes with credentials (piece 4); an `<img>` from the panel needs none, since
the cookie is same-site and rides a subresource request on its own.

**Nothing from this route is ever served as `text/html`.** An HTML artifact
(piece 4) is bytes here, fetched by the panel and rendered elsewhere; a user
who opens its URL gets a download. SVG is not on the image allowlist for the
same reason: it is scriptable.

### D5 — Two kinds, blob-backed: `file` and `image`.

```ts
{ key, kind: "file" | "image", blob: { id }, title?, placement? }
```

The writer names only the id. At write time the handler `head`s
`rooms/<sessionId>/<id>`: a missing object is refused, and for `image` a stored
type outside the allowlist is refused. The item stored and shown carries
`blob: { id, bytes, type, name }` **from the object's metadata, not from the
payload**: a client's claims about a blob are not what readers get, and the
server's record is one source rather than two.

The kind table in `src/surface.ts` grows by two; `SurfaceItem` gains
`blob: BlobRef | null`, null for the four kinds piece 1 ships. Removing or
replacing the item leaves the blob where it is — the event that placed it still
names it, and that history is piece 1's whole argument.

The handler reaches the bucket through a seam, not a binding. `BlobStore`
(`src/blobs.ts`, runtime-free: `put`, `head`, `get`, `delete`, keyed by room
and id) has `MemoryBlobStore` for tests and `npm start`, and `R2BlobStore`
(`src/blobs-r2.ts`, Workers-only, excluded from the Node build as
`store-do.ts` is). `buildServer` takes it beside the `BellmanStore`. The same
split the store has, for the same reason: a tool test runs with no R2, and a
seam with one implementation is what makes the memory one honest.

### D6 — Images are what they claim, and names are what they say.

An upload that claims `image/*` has its first bytes read against the four
signatures. A mismatch stores `application/octet-stream`, not the claim: a body
that is not a PNG is not served as one, whatever its header said. Ten lines,
and the difference between an allowlist and a suggestion.

`name` is bounded at 200 characters, stripped of path separators and control
characters, and what comes back in `Content-Disposition` is that, encoded. It
is the client's word and is treated as a label, never as a path.

### D7 — The bridge uploads and places in one call.

```ts
bellman_upload({ session_id, member_id, path, key, kind?, title?, placement? })
→ { blob_id, bytes, type, cursor, room_members }
```

Local to the bridge, like `bellman_wait` and `bellman_whoami`, so the server's
tool count stays at nine. It reads `path` — a regular file, not a symlink, under
the cap — types it from the extension (a short table; unknown is
`application/octet-stream`), `POST`s it with the bearer the bridge already
holds (`BELLMAN_KEY`, or the cached sign-in's access token), then calls the
upstream `bellman_send` with the `surface` item. `kind` defaults from the type:
an allowlisted image is `image`, anything else `file`.

Reading a path on the user's machine is not a new capability: the agent
driving the bridge already has that filesystem. The tool is `readOnlyHint:
false`, so a host that asks before writes asks here too.

`extension/manifest.json` gains the tool; `tests/extension.test.ts` fails until
it does. A hosted connector with no bridge uploads through the panel (piece 3),
which is the same route with a file picker in front of it.

### D8 — Nothing deletes.

No `DELETE /rooms/:id/blobs/:id`. A deletion is a retention decision — the
event log names the blob, so deleting it leaves history pointing at nothing —
and retention is #65. When that lands it has D1's prefix to sweep and D3's
`blobBytes` to credit, and neither needs anything here to change.

## Schema

```ts
// src/types.ts
export interface BlobRef {
  id: string;        // [a-f0-9]{32}
  bytes: number;
  type: string;      // as stored, after D6
  name: string;      // as stored, after D6
}
// SurfaceItem gains `blob: BlobRef | null`; SurfaceKind gains "file" | "image"
// Session gains `blobBytesCeiling: number`, stamped by bellman_start from the
// creator's entitlements; StoredSession gains `blobBytes?: number`, lifted to 0
// by hydrateStoredSession, which lifts a missing ceiling to the free plan's
// Entitlements gains `blobBytesPerRoom: number`

// src/blobs.ts — runtime-free
export interface BlobMeta { bytes: number; type: string; name: string; by: string; at: number; etag: string }
export interface BlobObject extends BlobMeta { body: ReadableStream }
export interface BlobStore {
  put(sessionId: string, id: string, body: ReadableStream | ArrayBuffer, meta: BlobMeta): Promise<void>;
  head(sessionId: string, id: string): Promise<BlobMeta | null>;
  get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobObject | "unchanged" | null>;
  delete(sessionId: string, id: string): Promise<void>;
}
```

`wrangler.toml` gains the binding:

```toml
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "bellman-blobs"
```

## Security

- **The bucket is private.** No public URL, no presigned URL: every byte leaves
  through the download route, under membership. That is also why there is no
  S3 credential anywhere.
- **Type is decided by the server** (D6) and **HTML is never renderable from
  here** (D4). The two together are what let piece 4 store an artifact as a
  blob without this route becoming an XSS vector on `mcp.bellman.sh`.
- **Quota is per room and the charge is decided in the room object** (D3).
  The pre-check is a courtesy; the charge is the bound.
- **An upload is a mutation** and a cookie caller passes the CSRF check.
- **Names are labels** (D6). The key is never derived from one.

## Testing

- **`tests/helpers/blob-store-contract.ts`** — the `BlobStore` contract: put
  then head returns the metadata; get streams the bytes; a foreign room's id
  does not resolve; delete then head is null; `ifNoneMatch` answers
  `"unchanged"`. Runs against `MemoryBlobStore` in the root program and
  `R2BlobStore` in `worker-tests/`, which has a real R2 binding under
  `vitest-pool-workers`.
- **`tests/helpers/store-contract.ts`** — `chargeBlobBytes` charges to the
  ceiling and refuses past it, refuses a frozen and a closed room, answers
  `not_found` for an unknown one; `blobBytes` lifts to 0 on an old row.
- **`tests/http-blobs.test.ts`** — the routes over `MemoryStore` and
  `MemoryBlobStore`: 401 without a credential; 404 for a stranger and for an
  unknown room alike; 403 for a seat without `write_surface`; 411 without a
  length and 413 over the cap, before any byte is stored; CSRF refusal on a
  cookie upload without an allowlisted `Origin`; an over-quota upload leaves no
  object behind; a claimed PNG that is not one is stored and served as
  `application/octet-stream`; an SVG is served as an attachment; every download
  carries `nosniff` and `sandbox`; a removed member is refused and a departed
  one is served; a closed room serves.
- **`tests/tools/working-surface.test.ts`** — a `file` item names a blob that
  exists and comes back with the object's metadata, not the payload's; a
  missing blob is refused; an `image` over a non-image blob is refused.
- **`tests/bridge-upload.test.ts`** — `bellman_upload` against
  `tests/helpers/fake-bellman.ts`, which gains the blob route: a regular file
  is uploaded and placed in one call; a symlink and an oversized file are
  refused locally with nothing sent; the kind defaults from the type.
- **`tests/extension.test.ts`** — fails until the bundle's list carries
  `bellman_upload`.

Two rules this repo has paid for apply to every test above: run each new
assertion against a broken implementation before trusting it, and give every
check a positive control.

## Files

| File | Change |
|---|---|
| `wrangler.toml` | the `BLOBS` binding |
| `src/types.ts` | `BlobRef`; `SurfaceKind` += `file`, `image`; `SurfaceItem.blob`; `Entitlements.blobBytesPerRoom` |
| `src/auth.ts` | the per-plan quota |
| `src/stored-session.ts` | `blobBytes?`, lifted to 0 |
| `src/surface.ts` | the two kinds, the image allowlist, the signatures, name sanitising |
| `src/blobs.ts` | **new**, runtime-free — `BlobStore`, `MemoryBlobStore` |
| `src/blobs-r2.ts` | **new**, Workers-only — `R2BlobStore` |
| `src/store.ts`, `src/store-do.ts` | `chargeBlobBytes` |
| `src/http/rooms.ts` | **new** — upload and download routes |
| `src/worker.ts` | dispatch `/rooms/`; the bucket into the store seam |
| `src/oauth/routes.ts` | export `caller` |
| `src/server.ts`, `src/app.ts`, `src/index.ts` | `buildServer(identity, store, blobs)` |
| `src/tools/send.ts` | the `file` and `image` branch: head, metadata from the object |
| `src/bridge.ts` | `bellman_upload` |
| `extension/manifest.json` | the tool |
| `README.md`, `skills/room-manifest/SKILL.md`, `docs/ARCHITECTURE.md` | the kinds, the routes, §5 and §9 |
| tests | as above |

## Out of scope

- **Deleting, sweeping, retention** — #65, over D1's prefix and D3's charge.
- **Thumbnails, resizing, transcoding** — a renderer's concern, and piece 3
  shows the original.
- **Multipart and resumable uploads** — 25 MB in one request is the ceiling,
  and raising it is a different route.
- **A public read** — #158's consent model first.
- **Scanning uploads for malware** — a `file` is served as a download under
  membership; the next step is an operator decision.
