# docs-site/src

## Overview

The source of docs.bellman.sh's pages. `content.config.ts` declares the one
Starlight content collection; `content/docs/` holds the pages as Markdown. Part of
that tree is generated from the tools themselves by `npm run docs:gen` at the
repository root, and the rest is written by hand.

## Interface

- `[content.config.ts:collections]` exports one collection,
  `docs: defineCollection({ loader: docsLoader(), schema: docsSchema() })`, with
  `docsLoader` from `@astrojs/starlight/loaders` and `docsSchema` from
  `@astrojs/starlight/schema`. Every page under `content/docs/` is an entry in it.
- `content/docs/` (Markdown pages, no contract file; the published site): `index.md`
  and the directories `start/`, `guides/`, `concepts/`, `help/`, `reference/`. The
  sidebar in [`../astro.config.mjs`](../astro.config.mjs) autogenerates a group from
  each directory, except `reference/`, which it lists explicitly.
- `content/docs/reference/`: `bellman-command.md` (hand-written),
  `bridge-tools.md` (generated) and `tools/` (generated, one page per server tool).

## Invariants

- `reference/tools/*.md` and `reference/bridge-tools.md` are written only by
  `npm run docs:gen` (`[scripts/docs-gen.ts:header]`), into
  `CONTENT_DIR`/`TOOLS_DIR` (`[scripts/docs-reference.ts:CONTENT_DIR,TOOLS_DIR]`).
  Never edit them by hand: `[tests/docs-reference.test.ts:'the reference']` fails
  until the committed pages match what the generator writes, so a change to a
  tool's title, description, schema or annotations needs a `docs:gen` run in the
  same change.
- Every page, the generated reference included, must pass the wording sweep in
  `[tests/docs-writing.test.ts:BANNED]` over `CONTENT_DIR`, any case and across a
  line break: no phrasing that casts a room as a pair of sessions. A room holds
  many members.
- A page linked from the sidebar by explicit slug must exist, and every internal
  link must resolve, or `astro build` fails (`[../astro.config.mjs:sidebar]`,
  `[../astro.config.mjs:plugins]`).

## Side Effects

- `npm run docs:gen` (`[package.json(root):docs:gen]`, which runs `build:ui` first)
  writes every reference page under `content/docs/` (`[scripts/docs-gen.ts:writeFileSync]`)
  and deletes any `.md` in `reference/tools/` that the run did not write, so a
  removed or renamed tool loses its page (`[scripts/docs-gen.ts:rmSync loop]`).
- `content.config.ts` itself has none: it declares the collection that
  `astro build` reads.

## Verification

- Run: `npm test` (repository root; `tests/docs-reference.test.ts` and
  `tests/docs-writing.test.ts` check the pages)
- Run: `npm run docs:gen` after any tool change, then `npm test`
- Run: `npm --prefix docs-site ci && npm --prefix docs-site run build` (fails on a
  broken link)
