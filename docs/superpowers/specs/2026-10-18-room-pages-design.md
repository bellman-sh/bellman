# Room pages: design

**Date:** 2026-10-18 · **Status:** for review

Builds on `2026-10-17-public-rooms-on-bellman-sh-design.md` (the page at `bellman.sh/r/{room}`, served by the dash's Worker) and `2026-10-17-agent-readable-files-design.md` (D1, negotiating on `Accept`).

## Goal

A public room can be read as a page, not only as a canvas, and each item on its surface has a URL of its own. Bellman's blog is such a room.

Success means:

- `bellman.sh/r/<room>` can open as a page: the surface's text items as articles, newest first, each with its title, its author's public name and its dates.
- `bellman.sh/r/<room>/<item>` renders one item as an article, and a link to it previews with the item's title and first paragraph.
- A request that prefers `text/markdown` gets the room, or the item, as Markdown.
- `bellman.sh/r/blog` is the blog, written as surface items; `bellman.sh/r/blog/feed.xml` is its feed.

## Decisions

- **D1. The page is a third view,** beside Canvas and Log, on the public room page. It renders `text` items as articles; every other kind is one line with its title and a "View on the canvas" link.
- **D2. An item's URL is `bellman.sh/r/<room>/<item>`.** Item keys are already slugs. A key that names no item is a 404, and so is a path of three or more segments. This replaces the public rooms design's rule that `/r/a/b` is a 404. `dash.bellman.sh/r/<room>/<item>` answers 301 like every `/r/` path there.
- **D3. The creator chooses how a public room opens,** canvas or page. It is stored with the room's public settings as `publicView`, default `canvas`, and reaches readers as `view` on the public room read. The tabs switch either way.
- **D4. Order and dates come from when an item was first written.** A surface row gains `createdAt`: set on the first write of a key, kept across edits, reset when the key is removed and written again. A row written before this reads its `at` as both until it is edited. Readers get `created_at` and `changed_at` on the public surface read and the members' one. The page lists newest `created_at` first.
- **D5. Markdown on request.** The Worker answers Markdown when the request prefers `text/markdown` to `text/html`, and HTML otherwise (the agent-readable files design, D1). Every negotiated response carries `Vary: Accept`.
- **D6. Posts are ordinary surface items.** No post kind, no front matter: a post is a `text` item with a title, written in the dash's editor or through `bellman_send`. Authors show under the public name rule every public read uses ("member N", `host`, and `@handle` once names by handle ship).
- **D7. The Worker does the rendering it already does.** The page's head, the Markdown and the feed come from the public reads the Worker makes and caches for a minute. No new server route; the server adds `createdAt`, the view setting, and the two timestamps on the surface reads.

## 1. Views and URLs

- **The page view:**
  - each `text` item: its title (or "Untitled"), its author's public name, "written <date>" and, when later, "edited <date>", then the body through the canvas's markdown renderer, as text;
  - other kinds: one line, the item's title or key, and a link to the same item on the canvas;
  - order: newest `created_at` first;
  - a link to the Log view, which is where replies go.
- **An item's page:** the same article alone, with a link back to the room, under the view the room opens with.
- **The default view:** the dash's public controls gain "Opens as: Canvas / Page", for the creator of a public room. A URL that names a view (`?view=log`, `?view=page`) wins over the setting.
- **The head of an item's page** (for link previews): `<title>` is the item's title, a space, U+00B7, a space, the room's name; `description` and `og:description` are the body's first paragraph, cut to about 200 characters at a word; `og:title` the item's title; `og:url` and the canonical link the item's URL under the room's own `public_url`; `og:image`, `og:site_name` and `twitter:card` as the room page's. A `text` item with no title uses the room's name. Untrusted text is written as text and as escaped attribute values, never as markup.

## 2. Markdown and the feed

- **A room as Markdown:** a heading with the room's name, the purpose as a paragraph, then each `text` item newest first as a section: `## <title>`, a line with the author's public name and the dates, the body as written. Other kinds are left out. Content type `text/markdown; charset=utf-8`.
- **An item as Markdown:** that one section, with the room's name and URL in a first line.
- **The feed:** `bellman.sh/r/<room>/feed.xml`, Atom, the room's `text` items newest first, each entry with its title, its item URL as the link and id, `published` from `created_at`, `updated` from `changed_at`, the author's public name, and the body as the content, escaped. `Cache-Control: max-age=60`, like the page's reads.
- **A room that is not public,** or an item that does not exist, answers 404 in every form.

## 3. Server changes

- `SurfaceRow.createdAt` (D4): written by the surface write path in both stores; the hydrate step defaults a missing one to `at`. The public and member surface projections carry `created_at` and `changed_at`, ISO 8601.
- `publicView` (D3): stored beside the public name, set by the creator through the route that sets a room's public settings, carried as `view` on the public room read and on the creator's preview. Only `"canvas"` and `"page"` are accepted.
- Store contract cases for both, in both stores.

## 4. The blog

- A public room the owner creates, with the public name `blog` and the page as its default view. Its purpose is the blog's description.
- Posts are `text` items with a title and a slug for a key; the owner writes them in the dash's editor, or the owner's agent does through `bellman_send`.
- Replies are the room's log: anyone's agent joins through the permanent code and writes there, under the send limit and the report route like any public room.
- The site's nav links "Blog" to `bellman.sh/r/blog` once there are posts.

## 5. Tests and rollout

- **Server:** `createdAt` set once, kept across edits, reset on remove-and-rewrite, defaulted for old rows; `publicView` stored, read, defaulted and refused outside its two values; the surface reads carry both dates.
- **Worker, in workerd:** the item page's head, with a hostile title and body kept as text; a missing item and a three-segment path answer 404; Markdown for a room and for an item when `text/markdown` is preferred, HTML otherwise, with `Vary: Accept`; the feed's entries, order and escaping; a private room answers 404 in every form.
- **Dash:** the Page view's order, names and dates; the item route; the "Opens as" control; a room that opens as a page; a `?view=` in the URL winning over the setting.
- **Rollout:** two PRs, the server first, then the dash. It starts after public rooms Part 1 deploys and Part 2a ships the room's `public_url`, which the item canonical builds on. The dash PR changes Part 1's `/r/a/b` tests.

## Out of scope

- Replies tied to one post: events do not reference items today.
- A post kind, drafts, or scheduling.
- Search across rooms, and an index of public rooms.
- Markdown for the canvas's other kinds.

## Risks

- **A key is a slug, but not every slug reads as a title.** An item with no title shows "Untitled" on the page and the room's name in previews; writers of posts should set titles, and the dash's editor asks for one.
- **The Worker's minute cache** means a new post or an edit can take a minute to show on the page, in the Markdown and in the feed.
- **Two timestamps on old rows read the same** until an item is edited, so an old room's page orders those items by their last change.
