# ADR 0019 — Claude Code installs Bellman through a plugin

**Date:** 2026-10-12 · **Status:** accepted

## Context

Bellman reached a Claude Code session in pieces: the curl installer put the
bridge on PATH and registered it at user scope, which `npm install -g` and `claude mcp
add` do by hand, hook delivery needed a Stop hook
written into `settings.json` by hand, and the two skills sat in a plugin at the
repository root that no marketplace listed. A plugin installs an MCP server, hooks and
skills in one step, from a marketplace a repository declares in
`.claude-plugin/marketplace.json`. Claude Code copies the plugin's directory into its
cache, and when that directory holds a `package.json` beside a lockfile it installs the
dependencies there. No setting or environment variable turns that install off.

## Decision

1. **The repository is a marketplace, `bellman`, and the plugin is `plugin/`.** Rooted
   at the repository, the plugin would carry the server's `package.json` and
   `package-lock.json`, and every install would pull the server's dependency tree into
   the user's cache for a plugin that runs bundles. `plugin/` holds neither, and
   `tests/plugin.test.ts` keeps it so.
2. **The plugin runs the bridge in hook delivery, as the Desktop bundle does (ADR 0017);
   ADR 0005 records both modes.** Claude Code gives an MCP server no
   signal that channels are on, and when they are off it drops the server's pushes
   without an error. Bellman's channel is on only in a session launched with
   `--dangerously-load-development-channels`, which a plugin cannot add, so in most
   sessions Claude Code would drop every push from a bridge in channel delivery, whose
   instructions tell the agent it need not poll, and the bridge could not tell.
   `plugin/.mcp.json` starts `node` itself, since the inbox is keyed by the bridge's
   parent PID, and the Stop hook keeps the README's 60-second timeout.
3. **The plugin runs committed bundles.** `npm run build:plugin` bundles
   `src/channel.ts` and `src/stop-hook.ts` with esbuild into `plugin/bridge/`, and
   writes `package.json`'s version into the bridge, which has no `package.json` beside
   it to read. Two builds of one tree are byte-identical.
4. **Release PRs rebuild the bundles, and no other PR does.** `plugin.json` pins the
   version, and Claude Code replaces a cached copy only when the version changes, so a
   bundle rebuilt between releases would reach new installs alone, under a version
   that names a different build. `tests/plugin.test.ts` fails when `package.json`'s
   version moves and the bundle's does not. CI fails a PR that moves the version with
   bundles that differ from a fresh build, since the marketplace serves `main` and the
   plugin ships at that merge. `publish.yml` checks again before `npm publish`.

## Consequences

- A bridge fix reaches plugin users at the next release, as it reaches npm users.
- Live push still needs the npm install, launched with `bellman-claude`. The curl and
  npm paths stay documented, and a session with both lists every tool twice.
- The plugin's server is `plugin:bellman:bellman`, so its tools are named
  `mcp__plugin_bellman_bellman__*`, and a permission rule written for `mcp__bellman__*`
  does not cover them.
- The one-command install needs Claude Code 2.1.292 or later, and the plugin needs
  Node 22 or later on PATH.
- Turn-end delivery is POSIX only, as ADR 0005 records for every hook-mode bridge.
- Skills under `plugin/skills/` change on `main` between releases: a new install gets
  them at once, an existing one at the next version.
- The bundles carry MIT, ISC and BSD-3-Clause code. The build writes each package's
  notice to `plugin/bridge/THIRD-PARTY-NOTICES.txt`, and `plugin/LICENSE` is Bellman's.
