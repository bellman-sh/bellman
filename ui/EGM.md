# ui

## Overview

The MCP Apps page (join screen, room card, rooms monitor, surface canvas) as a
Vite project. `npm run build:ui` bundles it into one HTML file and
`scripts/wrap-ui.ts` turns that file into `src/ui/assets.ts`, a generated,
gitignored string constant the server imports. Edit `ui/`, never the generated
file.

## Interface

- [`./src/EGM.md`](./src/EGM.md): the page's code, its screens, and the two tools
  it reads.
- `[index.html:#root]` the mount point (shows "Waiting for Bellman…" until the
  first result); loads `./src/style.css` and the module `./src/main.ts`.
- `[vite.config.ts:default]` root is `ui/`, plugins `[viteSingleFile()]` from
  `vite-plugin-singlefile`, build `{ outDir: "dist", emptyOutDir: true, target: "es2022" }`.
- `[tsconfig.json:compilerOptions]` ES2022 with `DOM` and `DOM.Iterable` libs,
  `moduleResolution: "Bundler"`, `strict: true`, `noEmit: true`; `include` is
  `src`, `test` and `vite.config.ts`.
- `test/` (test-only, no contract): vitest suites for the renderers, page
  controller, layout math, artifact frame and screen choice, with shared
  `fixtures.ts`.

## Invariants

- The build is one self-contained HTML file (`[vite.config.ts:viteSingleFile]`):
  the Worker has no filesystem, so the page travels as a string
  (`[scripts/wrap-ui.ts:header]`).
- `src/ui/assets.ts` is written only by `build:ui`
  (`[package.json(root):build:ui]`, `vite build --config ui/vite.config.ts && tsx scripts/wrap-ui.ts`),
  and every script that compiles, tests or deploys the server runs `build:ui`
  first. `[scripts/wrap-ui.ts]` refuses an output that is not an HTML document.
- `tsconfig.json` only type-checks (`noEmit`); `typecheck:ui` is separate from the
  server's program, and `verify` runs it first.

## Side Effects

- `[vite.config.ts:emptyOutDir]` clears and rewrites `ui/dist/` on each build.
- `[scripts/wrap-ui.ts]` writes `src/ui/assets.ts` (`APP_HTML` and
  `PACKAGE_VERSION`), and leaves it untouched when the content is unchanged.

## Verification

- Run: `npm run typecheck:ui`
- Run: `npm run build:ui`
- Run: `npm test` (the root vitest config's `include` names `ui/test/**/*.test.ts`)
