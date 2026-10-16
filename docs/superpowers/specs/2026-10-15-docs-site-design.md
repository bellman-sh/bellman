# Docs site: design

**Date:** 2026-10-15 · **Status:** for review

## Goal

A documentation site at `docs.bellman.sh`. It serves people who use Bellman through their agents first, and a reference second. It replaces the single `bellman.sh/docs` page, and it becomes the documentation URL in Anthropic's connector directory.

Success means:

- `docs.bellman.sh` serves the page map below, with search.
- Every server tool has a reference page generated from its own definition, and changing a tool without regenerating its page fails `npm test`.
- A pull request that breaks an internal docs link fails CI.
- The connector directory's documentation URL points at `docs.bellman.sh`.

## Decisions

- **D1. Astro Starlight in the server repo.** The site lives in `docs-site/` at the repo root, with its own `package.json` and lockfile. The server's dependencies don't change. Starlight supplies the sidebar, search (Pagefind), dark mode and the 404 page.
- **D2. Served at `docs.bellman.sh`.** An assets-only Worker named `bellman-docs`, with no script, has `docs.bellman.sh` as its custom domain. Once it is live, a site PR redirects `bellman.sh/docs` there. Until then the single page stays.
- **D3. Pages are Markdown,** in `docs-site/src/content/docs/`, and they are reviewed in pull requests like code.
- **D4. The tool reference is generated** from the server's own tool list; see "The generated reference".
- **D5. Deploys run from `.github/workflows/docs.yml`** on pushes to main that touch `docs-site/**` or `src/tools/**`. The same paths trigger a build on pull requests. The workflow reuses the `CLOUDFLARE_API_TOKEN` secret the server deploy uses. If that token can't add a custom domain, the first deploy is one manual `wrangler deploy` by the owner.

## Page map

```
Start
  Introduction          what Bellman is, and how a room works
  Connect               Claude · Claude Code · Claude Desktop · other MCP clients
  Your first room       the walkthrough from the /docs page

Guides
  Rooms and join codes  pair and swarm, seats, roles and verbs, invite, evict, leave, room lifetime
  Room manifests        room.yaml in your repo, and saved presets
  The working surface   item kinds, who can write, the canvas view
  Messages and delivery send types, sync and wait, channels, the Stop hook
  Public rooms          make public, permanent codes, the public page
  Teams and audit       org scoping, the admin role, the audit log
  Plans and limits      what each plan allows

Concepts
  Trust model           untrusted envelopes, action requests, two-phase connect
  How it works          the room is its log; push is a convenience

Reference (generated)
  Tools                 one page per server tool
  Bridge tools          bellman_wait, bellman_upload, bellman_whoami
  The bellman command   update, feature-request, --version

Help
  Troubleshooting       nothing pushed into my session, sign-in, Windows and the Stop hook
```

The text comes from what already exists:

- the README's sections on the tool surface, what a send proves, the working surface, the trust model, what a plan gates, Claude Code, plans and room manifests;
- the site's `/how-it-works`, `/trust`, `/install` and `/docs` pages;
- the ADRs;
- the `room-manifest` and `canvas` plugin skills;
- the tools' own descriptions.

Out of scope for this version:

- an HTTP API reference;
- self-hosting (#211);
- the hosted seat, whose plan is not on sale;
- handles, which get a page when bylines ships.

## The generated reference

- **The generator.** `npm run docs:gen` at the repo root starts the server in memory through the in-memory MCP client the tests use. It lists the tools and writes one page per tool to `docs-site/src/content/docs/reference/tools/<name>.md`.
  - The script and the drift test share one render function, so both produce byte-identical output.
- **Each tool page** has:
  - frontmatter, with the tool's name as its title and its `title` annotation as its description;
  - a label, one of Reads, Writes or Destructive, from `readOnlyHint` and `destructiveHint`;
  - the tool's full description;
  - a parameters table from its input schema: name, type, whether it is required, description, enum values and default.
- **The bridge tools page** is generated the same way, from a hook-mode bridge's tool list minus the server's. That is the surface `tests/extension.test.ts` already reads.
- **The `bellman` command page** is written by hand. It has three subcommands and rarely changes.
- **Escaping.** The generator escapes `<` and `&` in tool text, so `<your key>` renders as written instead of disappearing as HTML. A test pins this.
- **Drift.** The generated pages are committed. `tests/docs-reference.test.ts` regenerates them in memory and fails with "run npm run docs:gen" when they differ from the committed files, the same way the plugin-bundle check works.

## Build, deploy and checks

- **Build:** `astro build` in `docs-site/` writes static pages, the search index and the 404 page.
- **Deploy:** `docs-site/wrangler.toml` names the `bellman-docs` Worker. It points `[assets]` at the build output with `not_found_handling = "404-page"`, and attaches `docs.bellman.sh` as a custom domain.
- **Checks:**
  1. **Drift:** the test in `npm test` fails when the generated pages are stale.
  2. **Escaping:** a test in `npm test` pins it.
  3. **Links:** `starlight-links-validator` fails the docs build on a broken internal link, on every pull request that touches `docs-site/`.
  4. **After deploy:** a smoke step fetches the home page and one tool page, and expects 200 from each.
  5. **Writing:** a test in `npm test` fails when a docs page says "two sessions" or "the other session". A room holds many members.

## Afterwards

These follow the plan; they are not part of it.

- A site PR redirects `bellman.sh/docs` to `docs.bellman.sh`.
- The owner changes the connector listing's documentation URL.
- The README's usage sections shrink to links into the docs.

## Risks

- **Cloudflare token:** if its scope doesn't cover custom domains, the first deploy waits on the owner.
- **New dependencies:** Astro and Starlight live only in `docs-site/`, so their dependency churn stays in that folder.
- **Writing volume:** fourteen hand-written pages, almost all drawn from text that already exists.
