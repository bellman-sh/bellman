# HTML Artifacts, and the Sandbox That Renders Them — Design

Issue: [#129](https://github.com/bellman-sh/bellman/issues/129), piece 4 of 4
Status: approved design, pending implementation plan
Depends on: piece 1 — [the working surface](2026-10-06-working-surface-design.md); piece 2 — [blobs](2026-10-06-surface-blobs-design.md), which stores an artifact; piece 3 — [the canvas UI](2026-10-06-surface-canvas-ui-design.md), which embeds the frame
Related: #28 (MCP Apps, which has its own sandbox and would reuse the bytes, not this frame)
Repos: `bellman-sh/bellman` (the kind) and `bellman-sh/dash` (the frame and the sandbox deployable)

## Problem

An agent produces a working thing — a prototype, a chart, an interactive
explainer — as HTML with its script and style inline. A diagram is mermaid
source, which is text until something draws it. Both are executable content
from an untrusted peer, and the panel that would show them holds the account
cookie. The architecture says what a script running in that origin is: account
takeover.

So the content needs somewhere to run that holds nothing — not the cookie, not
the panel's DOM, not the panel's network position — and the panel needs a way
to hand it the bytes without handing it anything else.

## Scope

**In scope:**

1. An `html` kind, inline for small artifacts and blob-backed for large ones.
2. A sandbox origin, cross-site to `bellman.sh`, serving one static frame.
3. The frame's protocol: the panel posts the content in, the frame renders it
   in a nested sandboxed document, no content is fetched.
4. `diagram` rendered in the same frame, so mermaid never runs in the panel.
5. The contract an artifact gets: what it can and cannot do, stated where an
   agent reads it.

**Out of scope:** artifacts that load libraries from a CDN, artifacts that
talk to a network, artifacts that read the room, a gallery or an editor,
rendering outside the panel (#28).

## Decisions

### D1 — The `html` kind: inline or a blob, never both.

```ts
{ key, kind: "html", title?, body?, blob?, placement? }   // exactly one of body, blob
```

`body` is the artifact inline, under piece 1's body bound, and it exists for a
hosted connector that has no bridge and cannot upload: a small artifact still
has a way onto the surface. `blob` is a piece 2 upload whose stored type is
`text/html`, for everything larger, under the per-file cap. The handler refuses
both and neither, and refuses a `blob` whose stored type is anything else.

Piece 2's download route serves it as bytes, as an attachment, and never as a
renderable `text/html`. That rule is what makes storing an artifact on
`mcp.bellman.sh` safe: a URL to it is a download, not a page.

### D2 — A separate origin, cross-site, serving one static page.

The frame is served from a second, tiny Worker, `bellman-sandbox`, with static
assets and no logic, on a `workers.dev` hostname — a different registrable
domain from `bellman.sh`.

Why cross-site and not `sandbox.bellman.sh`: `SameSite` is evaluated on the
registrable domain, so a document on any `*.bellman.sh` host makes same-site
requests to `mcp.bellman.sh` and the panel's `Lax` cookie rides them. The
`Origin` allowlist would still refuse a mutation, but a read would execute
with the cookie attached, and the architecture's own CSRF argument — "an XSS on
the marketing site would otherwise POST here" — applies to a sandbox on the
same site exactly. A different registrable domain sends no cookie at all, and
nothing has to be argued.

`workers.dev` rather than a bought domain because it is cross-site, free, and
already there; the main Worker turned `workers_dev` off for its own reasons
(one hostname, so a token minted for it is accepted nowhere else), none of
which apply to a static page. If a nicer name is wanted later, it is a DNS
change and a rebuild of the panel's policy, and nothing in this design moves.

### D3 — The frame protocol: posted in, rendered nested, never fetched.

The panel embeds

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"
        src="https://<sandbox>/frame.html">
```

and on `load` posts `{ kind: "html", html }` or `{ kind: "diagram", source }`
to the frame's `contentWindow`. The frame accepts a message only when
`event.origin` is the panel origin baked in at build and `event.source` is the
parent window, and ignores everything else.

The outer frame is sandboxed without `allow-same-origin`, so its document's
origin is opaque and reads `"null"`. Two things follow. The panel cannot name it
as a target: it posts with `"*"` to the exact `contentWindow` it created, which
is safe because that window is the panel's own and a nested artifact cannot
navigate its parent frame (no `allow-top-navigation` on either frame). And the
panel accepts a reply only from that window, whose `event.origin` is `"null"`,
never by origin alone. The frame's own module script is a cross-origin fetch
from an opaque origin, so the sandbox serves its assets with
`Access-Control-Allow-Origin: *` (static script, nothing else). Measured in
Chromium: without these, the module script is refused by CORS and the post is
dropped with 'The target origin provided does not match the recipient window's
origin (null)'.

For `html` the frame writes the content into a nested
`<iframe sandbox="allow-scripts" srcdoc>`; for `diagram` it renders mermaid —
bundled into the frame at a pinned version, `securityLevel: "strict"` — and
shows the SVG. The artifact may post `{ type: "resize", height }` up through
the frame, and the panel sizes the node to it.

**The frame fetches no content.** The panel is the authenticated party: it
reads an inline body off the item, or fetches a blob through the download route
with its credentials, and posts the bytes. The sandbox origin holds no
credential and requests nothing but its own script, so there is nothing on it
to steal and no route it has to be trusted with.

**Nested, not direct**, for two reasons. An artifact written straight into the
frame's own document would replace the frame's script (that is what
`document.write` does), and a nested `srcdoc` document gets a fresh opaque
origin of its own under the frame's policy. The `sandbox` attribute on both
frames omits `allow-same-origin`, so every artifact runs as an opaque origin
whatever hostname served the frame — the second line, behind D2's first.

### D4 — The frame's policy, which the artifact inherits.

Served on `frame.html`:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'unsafe-inline';
  style-src 'unsafe-inline';
  img-src data: blob:;
  font-src data:;
  connect-src 'none';
  frame-src 'self' data: blob:;
  frame-ancestors https://dash.bellman.sh;
  base-uri 'none'; form-action 'none'
```

The frame's assets are served with `Access-Control-Allow-Origin: *` (D3): the
module script is fetched cross-origin by an opaque origin, and the assets are
static script and nothing else.

A `srcdoc` document inherits its parent's policy, which is the point: the
artifact's inline script and style run (`'unsafe-inline'` on a page that holds
nothing is the price of running artifacts at all), it loads no script from
anywhere else, it makes no request (`connect-src 'none'`), it submits no form,
and it can be embedded by the panel and by nothing else. A top-level visit to
`frame.html` shows an empty frame waiting for a message it will never get.

### D5 — What an artifact may do, said where an agent reads it.

The `html` line in `bellman_send`'s description states the contract: a
self-contained page; inline script and style; `data:` images; no network, no
cookies, no parent, no navigation, no popups, no downloads, no forms.
Interaction inside the artifact works. An artifact that needs a library inlines
it.

A CDN allowlist — `script-src https://cdnjs.cloudflare.com …` — is the obvious
follow-up and is not in this design. It widens what an artifact can reach, and
it should be widened on purpose, once, with the list written down, rather than
arrive because the first artifact somebody wrote imported a chart library.

### D6 — Diagrams move into the frame.

Piece 3 shows a diagram's source. This piece replaces that node with the
frame, posted `{ kind: "diagram", source }`. Mermaid parses untrusted text into
SVG and runs in the page that renders it; here that page is the frame, so the
panel never runs it. `securityLevel: "strict"` is mermaid's own sanitiser and
stays on as the second layer.

### D7 — The sandbox is built and deployed beside the panel.

`bellman-sh/dash` gains `sandbox/` — `frame.html`, `frame.ts`, mermaid as a
dependency, its own `wrangler.toml` with an assets binding and `workers_dev =
true`, and a build that bakes the panel origin in. Same toolchain as the
panel, one more deploy, no server code. The panel's `_headers` policy names the
sandbox origin in `frame-src`, which is the one place the two meet.

## Security

- **Two lines, independent.** D2 puts the artifact on a different site, so no
  cookie is ever sent; D3's `sandbox` without `allow-same-origin` makes its
  origin opaque, so even a same-site deployment would send none. Either alone
  would hold; both are kept because the cost is an attribute.
- **No network from an artifact** (D4). `connect-src 'none'` and no
  `allow-same-origin`: an artifact that calls `fetch` gets a refusal, and an
  artifact that tries `parent.document` gets a `SecurityError`. Both are in the
  manual check below, and both must fail.
- **The frame holds nothing** (D3). No credential, no content fetch, no
  storage. A compromise of the sandbox origin yields an empty page.
- **Only the panel can speak to it** (D3, D4). `event.origin` is the panel's,
  `event.source` is the parent window, and `frame-ancestors` names the panel.
- **The bytes are never a page on the API host** (D1). A download, always.

## Testing

Worker (`tests/tools/working-surface.test.ts`): an `html` item with both `body`
and `blob` is refused, with neither is refused, over a blob whose type is not
`text/html` is refused; an inline body past the bound is refused; the download
of an `html` blob carries `application/octet-stream`, `attachment`, `nosniff`
and `sandbox` (piece 2's assertions, kept).

Sandbox (`sandbox/frame.test.ts`, under the dash `vitest`): a message from the
wrong origin is ignored and nothing is rendered; the right origin renders a
nested frame whose `sandbox` attribute is exactly `allow-scripts`; a
`diagram` message renders an `<svg>`; the policy string served on `frame.html`
and the assets' CORS header are pinned — `connect-src 'none'`, no
`allow-same-origin` anywhere, `frame-ancestors` naming the panel, and
`Access-Control-Allow-Origin: *` on the assets.

Panel (`src/components/canvas/html-node.test.tsx`): the node posts the bytes
only after the frame has loaded, to the `contentWindow` it created with `"*"` as
the target, takes a reply only from that window, and never writes the content
anywhere in its own document.

Manual, before calling it done, with an artifact written for the purpose: a
`fetch` to `https://mcp.bellman.sh/auth/session` with credentials fails; a
read of `parent.document` throws; `document.cookie` is empty; a `<form>`
submission is blocked; the artifact's own button handlers run. All five, every
time the frame's policy changes.

## Files

**`bellman-sh/bellman`**

| File | Change |
|---|---|
| `src/types.ts`, `src/surface.ts` | the `html` kind; body-or-blob |
| `src/tools/send.ts` | the branch; the contract in the description |
| `src/tools/kit.ts` | `SurfaceShape` gains the kind |
| `README.md`, `docs/ARCHITECTURE.md` | the kind; §7 gains the sandbox as a trust boundary |

**`bellman-sh/dash`**

| File | Change |
|---|---|
| `sandbox/frame.html`, `sandbox/frame.ts`, `sandbox/wrangler.toml` | **new** — the frame and its deploy |
| `package.json` | `mermaid` (bundled into the frame only) |
| `public/_headers` | `frame-src` names the sandbox origin |
| `src/components/canvas/html-node.tsx`, `diagram-node.tsx` | the frame, posted to; replaces piece 3's `<pre>` |
| `src/lib/sandbox.ts` | the origin, the message types |

## Out of scope

- **A CDN allowlist for artifact scripts** — D5.
- **Artifacts that read or write the room** — an artifact with a network
  position is a different trust design, and the first one would want a token
  scoped to a room, which is #20's territory.
- **An editor for artifacts in the panel** — write them where they are written,
  upload them here.
- **MCP Apps** (#28) — reuses the bytes, not this frame.
