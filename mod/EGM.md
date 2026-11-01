# mod

## Overview

`bellman-mod`, the second plugin in the repository's marketplace
(`.claude-plugin/marketplace.json` lists it from `./mod`): a Claude Code mod
that shows Bellman rooms, their members and their pending action requests in
the terminal. `.claude-plugin/plugin.json` names it and moves with
`package.json`'s version on every release. It calls no Bellman tool but
`bellman_whoami`; everything else reaches the bridge through that bridge's door.

Two directories here hold no contract of their own:

- `types/index.d.ts`: the mod's contract for its `$.state` values; it repeats
  the door's shapes by hand, because the kit tests run where `src/` is absent.
- `tests/`: the kit tests and their harness, run only by `npm run test:mod`
  (`scripts/test-mod.ts`) from a temp copy holding what the plugin ships. CI
  runs none of them.

## Subdirectories & Boundaries

- src: [`./src/EGM.md`](./src/EGM.md) - the mod's source: hook wiring, door
  reads (`/status`, `/rooms`, `/rooms/<id>/events`, `/rooms/<id>/surface`) and
  its one write (`POST /rooms/<id>/decline`), the band, sidebar and room pane,
  the approval gate on `action_response` sends, and the wake for an idle
  session.
- hooks: [`./hooks/EGM.md`](./hooks/EGM.md) - `hooks.json` and the generated
  `register.mjs` bundle Claude Code loads; built by `npm run build:mod`, never
  edited by hand.
