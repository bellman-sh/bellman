# Join Links — Design

**Date:** 2026-10-06
**Status:** approved in conversation; implementation plan to follow
**Repos:** `bellman-sh/bellman.sh` (the page), `bellman-sh/bellman` (the field)

## Problem

A join code is a string: `BELL-7F3K-92-REVIEWER`. Pasted into Slack it is text
in a grey box, and the person reading it has to already know what Bellman is,
that this is an invitation, and what to say to their agent. Conductor's
multiplayer made the contrast plain: a workspace is shared as a link, and a
link is clickable, recognisable and unfurls with a title.

A link also has a property a code does not: it can carry instructions. Someone
who has never heard of Bellman can click it and be told what to do.

## The constraint that decides the design

**Slack, Discord and iMessage `GET` every pasted link to unfurl it.** Whatever
`/j/<code>` does, a bot does it first — before any human sees the message. A
join code is single-use and expires fifteen minutes after it is minted
(`JOIN_CODE_TTL`, `src/store.ts`). So the page must not consume the code,
must not call `bellman_connect`'s preview, and must not reveal anything an
unfurl cache should not hold.

The page is therefore **a pure function of the URL**. It makes no call to the
server. It cannot show the room's name or whether the code has expired; the
joining agent learns both on `bellman_connect`, exactly as today. This was
chosen over a live lookup (a public endpoint answering room, role and expiry to
anyone holding the code, including every unfurl cache) and recorded as the
upgrade path in *Out of scope*.

A deep link into the agent was considered and is not available: neither Claude
Code nor a Claude Desktop MCP server registers a URL scheme. The homepage's
principle stands — **the code is carried by a human on purpose** — and the link
exists to make that carry clickable, not to replace it.

## Decisions

### D1 — The page lives on the site, not the server

`bellman.sh/j/<code>` is rendered by the site's Cloudflare Worker from a
template beside the other pages. Nothing on `mcp.bellman.sh` changes for the
page to work, so a self-hosted server's codes get the same page, and the page
cannot be a vector into the registry because it never reaches it.

### D2 — The route accepts only the code shape

`GET /j/<code>` matches, after decoding and normalisation, exactly:

```
^BELL-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}(?:-[A-Z][A-Z0-9-]{0,30})?$
```

The two random groups use the code alphabet from `src/codes.ts`
(`23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no `0/O`, `1/I/L`), and the class above is
that alphabet, not `[A-Z2-9]`: a code containing `O` can never have been
minted, so the page should not pretend one exists. The role group is a
manifest role key upper-cased with `_` as `-`, so `[A-Z][A-Z0-9-]{0,30}` —
`MAX_ROLE_KEY_LENGTH` is 31. The grammar is the one
`2026-09-27-role-carrying-join-codes-design.md` fixed. Anything else is the
site's existing 404 page, status 404.

Only matched characters reach the HTML, and they are escaped regardless: the
one dynamic input is constrained twice.

### D3 — Non-canonical spellings redirect, so a code has one URL

`normalizeJoinCode` (`src/codes.ts`) trims, upper-cases, strips whitespace and
turns `_` into `-`. The worker percent-decodes the path segment, applies the
same rules and, if the result differs from what was requested, answers
**301** to the canonical URL. An
unfurl cache then holds one entry per code rather than one per spelling, and a
link retyped by hand still lands.

### D4 — The page tells a person what to do, and nothing about the room

Four things, in the site's chrome, using the homepage's `.keycard` for the code:

1. **The code**, large, with the role beneath it: *seats you as `reviewer`*.
   The role is read from the last group **for display only**. The server never
   parses a role out of a code (the registry resolves the whole string, see
   `renderJoinCode`'s doc comment) and nothing here changes that: the page
   shows the word; `bellman_connect` decides the seat.
2. **What to do**: *Tell your agent: join the Bellman room
   `BELL-7F3K-92-REVIEWER`*, with the site's existing copy button, copying the
   code.
3. **No Bellman yet?** The install one-liner, as on the homepage, and a link to
   `/#install`.
4. **Single use, fifteen minutes.** The homepage already states both on the
   example card; this page says them again where they matter.

No room name, no purpose, no creator, no brief. Those are what the unfurl
cache must not hold, and the page does not have them.

### D5 — The unfurl says what the link is

OpenGraph: `og:title` *Join a Bellman room as reviewer*, `og:description` a
sentence of the form *Open this with your agent and it joins the room. Single
use, fifteen minutes.*, `og:image` the existing `/og.png`. Twitter card as the
homepage. `<title>` *Join as reviewer — Bellman*.

### D6 — Not indexed

`<meta name="robots" content="noindex">` and an `X-Robots-Tag: noindex`
header. A code is an invitation. It expires in fifteen minutes, but a search
engine that indexed one would be indexing invitations as a class.

### D7 — The template is an asset the worker fills

`public/_join.html` is a static file with three text placeholders — `{{CODE}}`,
`{{ROLE}}`, and `{{ROLE_SUFFIX}}` (` as reviewer`, or empty, for the title and
OG tags) — and one marked block, `<!--role-->…<!--/role-->`, which the worker
removes whole when the code carries no role group. The worker fetches the
template through `env.ASSETS`, substitutes, and returns it. The chrome and
every piece of markup then live in a real HTML file, edited like every other
page; the worker holds strings and a regex. A direct request for `/_join.html`
is answered 404, so the raw placeholders are never served.

The substitution escapes every value. Given D2 this is belt and braces, and it
costs one function.

### D8 — Caching is harmless and short

The response is a pure function of the URL and reveals nothing that changes.
`Cache-Control: public, max-age=300`. Expiry of the code does not change the
page, so a stale cache is not a wrong page.

### D9 — The server returns the link beside the code

`src/codes.ts` gains:

```ts
export const JOIN_URL_BASE = "https://bellman.sh/j/";
export function joinUrl(code: string): string;
```

`bellman_start` and `bellman_invite` return `join_url` next to `join_code`,
and both tools' `Returns:` descriptions say so. `bellman_invite`'s
`share_instructions` leads with the link and keeps the code:

> Share this link with the joining session's human: `<join_url>`. The code in
> it, `<code>`, seats them as "`<role>`". Any code issued earlier for that
> role has stopped working; other roles' codes are unaffected.

The base is a constant, not configuration. A self-hosted server mints links to
`bellman.sh`, and by D1 that page works for its codes. An operator who wants
their own page changes one constant.

### D10 — The README says the link exists

One sentence where the README introduces the code, and the `bellman_invite`
row of the tool table says the link is returned. The homepage's keycard is
unchanged; it shows a code, and a code is still what crosses.

## Error handling

| Case | Site answers |
|---|---|
| Path does not match D2 | the existing `404.html`, status 404 |
| `/j/` or `/j` with no code | 404 |
| `/_join.html` requested directly | 404 |
| Non-canonical spelling | 301 to canonical |
| Template unreadable from assets | 500, `text/plain`; a test holds the template present |

The server gains no failure mode: `joinUrl` is concatenation.

## Testing

Every new assertion is run against a broken implementation before it counts.

**Site** — `tools/test_worker.mjs`, run with `node --test tools/`, importing
`worker.js` with a stub `env.ASSETS` whose `fetch` serves files from `public/`:

- a canonical code renders the page with the code, the role, the OG tags and
  `noindex`, status 200
- lowercase, underscores and surrounding whitespace each 301 to the canonical
  URL, and the canonical URL does not redirect
- a code with no role group renders with no role line
- `BELL-7F3K-92-RELEASE-AGENT` displays the role as `release_agent`
- bad shape, `/j/`, `/j`, and `/_join.html` are 404 with the site's 404 body
- `/j/<script>` and `/j/BELL-7F3K-92-%3Cscript%3E` are 404 and the string
  `<script` never appears in a 200 body
- the `www` redirect still works, so the new route did not shadow it

Wired into `.github/workflows/deploy.yml` ahead of the deploy step, beside the
Python suite if it is not already run there.

**Server** — `tests/codes.test.ts`: `joinUrl` prefixes the base and changes
nothing else. Through the harness (`tests/helpers/harness.ts`):
`bellman_start` returns `join_url === joinUrl(join_code)`; `bellman_invite`
likewise, and its `share_instructions` contains the link.

## Files

| Repo | File | Change |
|---|---|---|
| site | `worker.js` | the `/j/` route, normalisation, 301, 404, template fill |
| site | `public/_join.html` | new: the page, with `{{CODE}}` and `{{ROLE}}` |
| site | `tools/test_worker.mjs` | new |
| site | `.github/workflows/deploy.yml` | run `node --test tools/` |
| bellman | `src/codes.ts` | `JOIN_URL_BASE`, `joinUrl` |
| bellman | `src/tools/start.ts`, `src/tools/invite.ts` | `join_url`; `share_instructions` |
| bellman | `tests/codes.test.ts`, tool tests | as above |
| bellman | `README.md` | D10 |

No new tool, so `extension/manifest.json` is untouched.

## Out of scope

- **A live page.** `GET mcp.bellman.sh/j/<code>` answering room, role and
  expiry so the page can say *payments-migration · reviewer · 12 minutes left*.
  Same URL shape, so nothing here closes it off; it waits for a signed-in
  reader (#48, #166) and the visibility decision in #158, because a room name
  in every unfurl cache is a leak the inert page does not have.
- **Accepting a pasted link as a join code.** `normalizeJoinCode` could strip a
  leading `bellman.sh/j/`. Deferred: a URL has many spellings (scheme, `www`,
  trailing slash, query), it widens `bellman_connect`'s input bound, and the
  agent extracts the code from a link without help. Revisit if a real paste
  fails.
- **A deep link into the agent.** No URL scheme to target.
- **A configurable base.** One constant; see D9.
