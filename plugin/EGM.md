# plugin

## Overview

The `bellman` Claude Code plugin, listed by the repository's marketplace
(`.claude-plugin/marketplace.json`, from `./plugin`). It runs the Bellman
bridge in hook delivery and the hooks that deliver peer events and seat status,
and carries two skills. `.claude-plugin/plugin.json` names it `bellman`, at
`package.json`'s version.

- `.mcp.json`: the `bellman` MCP server is
  `node ${CLAUDE_PLUGIN_ROOT}/bridge/channel.mjs` with
  `BELLMAN_DELIVERY=hook`, `BELLMAN_INSTALL=plugin`. It is `node` itself, not
  `npx` or a shell, because the inbox is keyed by the bridge's parent PID
  [tests/plugin.test.ts:starts the bridge with node itself, in hook delivery, as the plugin's install]
- `hooks/hooks.json`: `SessionStart` runs `join-hook.mjs` (timeout 30),
  `Stop` runs `stop-hook.mjs` (60), `UserPromptSubmit` and `Notification` run
  `status-hook.mjs` (10) [plugin/hooks/hooks.json:hooks]
- `plugin/` holds no `package.json` and no lockfile at any depth: Claude Code
  would install their dependencies into its cache copy (ADR 0019)
  [tests/plugin.test.ts:holds no package.json and no lockfile]

## Subdirectories & Boundaries

- bridge: [`./bridge/EGM.md`](./bridge/EGM.md) - the four generated bundles
  (`channel.mjs`, `join-hook.mjs`, `stop-hook.mjs`, `status-hook.mjs`) built
  from `src/` by `npm run build:plugin`, and their third-party notices.
- canvas skill: [`./skills/canvas/SKILL.md`](./skills/canvas/SKILL.md) -
  write, arrange and read a room's working surface (`bellman_send` type
  `surface`, `bellman_upload`, `bellman_sync` with `surface: true`).
- room-manifest skill:
  [`./skills/room-manifest/SKILL.md`](./skills/room-manifest/SKILL.md) -
  author, review or fix `.bellman/room.yaml`, which `bellman_start` picks up
  through the bridge.
