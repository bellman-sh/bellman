# ADR 0017 — The Desktop bundle is built and checked in this repo

**Date:** 2026-10-01 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #108

## Context

The Claude Desktop bundle, an `.mcpb` holding a manifest, the built stdio bridge
and its dependencies, lived in the site repo, `bellman-sh/bellman.sh`, and
nothing tied it to the code it wrapped (#108). Its manifest named nine tools and
had lacked `bellman_whoami` since the bridge grew it; its template version sat
at 0.1.0 through two releases; and it required a `bellman_key` a release
after the bridge began signing itself in (#36, #76). Claude Desktop shows the
manifest's tool list at install, so the stale list was the first description of
Bellman a Desktop user read.

## Decision

1. **The bundle lives in `extension/` and ships with the server.** A published
   release packs it from its own commit (`./extension/build.sh --from .`, the
   `bundle` job in `publish.yml`) and attaches `bellman.mcpb` to that release.
   `build.sh` writes the packed package's version into the bundle's manifest,
   and `tests/extension.test.ts` holds the committed template to `package.json`.
2. **The tool list is written by hand and held to the bundle's real surface.**
   `tests/extension.test.ts` starts a hook-mode bridge (`createBridge`) over the
   real handlers (`buildServer`) and asserts the manifest names exactly the tools
   it lists: fourteen, the server's eleven and the bridge's `bellman_wait`,
   `bellman_whoami` and `bellman_upload`. It asserts `BELLMAN_DELIVERY=hook`
   too, because the bridge lists `bellman_wait` only under `hook`. Descriptions
   are not compared: the manifest's are install-screen copy. So a new tool means
   editing `extension/manifest.json`, as `CLAUDE.md` says.
3. **The bundle runs the bridge in `hook` delivery and asks for no key.** Claude
   Desktop does nothing with `notifications/claude/channel`, and `hook` queues
   events behind `bellman_wait` instead. The bridge signs itself in when Desktop
   first starts it, and the test refuses a `bellman_key` setting or a
   `BELLMAN_KEY` in the bundle's environment. The settings left are the server
   URL and the upload folder.
4. **The packed artifact is checked, not only the manifest (PR #212).** The
   v0.3.0 bundle died at its first import: its staging `package.json` named the
   SDK alone, the bridge had begun importing `yaml`, and Claude Desktop said only
   "Server disconnected". `build.sh` now copies the package's `dependencies`
   whole, and `extension/check-deps.mjs` refuses to pack when an import of the
   staged server does not resolve. CI packs a bundle on every PR, where #109 had
   validated the manifest alone, because the release job runs after
   `npm publish` has succeeded.

## Consequences

- A tool added to the server or to the bridge fails `tests/extension.test.ts`
  until the manifest names it. The list was ten at the move and is fourteen now.
- The bundle carries the server's `dist/` whole, so the MCP Apps page ships in it
  and reaches Desktop through the bridge's resource proxy (ADR 0016).
- Nothing arrives unprompted in Desktop, which has no channel and no Stop hook
  (ADR 0005): the agent drains the queue with `bellman_wait` or `bellman_sync`.
- The remote connector needs nothing installed and signs in over OAuth
  (ADR 0013). What the bundle adds is a local bridge holding the queue of peer
  events, which a connector dialled from Anthropic's cloud cannot hold.
- The bundle is not signed, so Claude Desktop shows its unsigned-extension
  warning until a certificate exists for `mcpb sign`.
