# ADR 0016 — One ui:// resource, and pages read through tools

**Date:** 2026-10-07 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #28 · **Spec:** `docs/superpowers/specs/2026-10-06-mcp-apps-ui-design.md`

## Context

Joining and watching a room were readable only as JSON, and the consumer Claude
Desktop app has no channel and no Stop hook, so nothing reaches it unless the
agent is asked (#28). MCP Apps lets a tool name a UI resource that a host
renders in a sandboxed iframe; the iframe calls the server's tools through the
host, and a host without the extension shows the text result as before. The
README's rule was tools only, with no resources, for patchy host support.
Through the bridge, a `bellman_sync` result counts as the agent having seen its
events: `observe()` moves the watcher's cursor past them and deletes them from
the hook inbox (`seenThrough`).

## Decision

1. **Tools first.** Every capability is a tool whose text result stands on its
   own; a UI resource is additive, and a host that does not render it loses
   nothing. Still no sampling and no elicitation. `tests/tools/surface.test.ts`
   pins tools and the one resource, and nothing else.
2. **One resource, one page.** `ui://bellman/app.html`, mimeType
   `text/html;profile=mcp-app` (`registerAppResource`, `src/ui/resource.ts`).
   `bellman_connect`, `bellman_confirm`, `bellman_rooms` and `bellman_surface`
   carry `APP_UI_META`, which names it, and no other tool does. The page picks
   its screen from the result it is handed (`pickScreen`): a `connect_token` is
   the join screen, `rooms` the monitor, `surface` the canvas (PR #214).
3. **The page reads through tools, and never through `bellman_sync`.** It
   reaches data only by `tools/call` through the host, on the agent's own
   connection: same identity, same guards, same audit rows. It re-reads
   `bellman_rooms` or `bellman_surface` every 15 seconds while visible; both are
   read-only and leave `lastSeenAt` alone, so a page left polling holds no seat
   alive (ADR 0007). It declares no `csp` domains and loads nothing external.
4. **The page writes nothing.** The join screen's Confirm and Decline each send
   one `ui/message` (`verdictMessage`), and the agent calls `bellman_confirm`
   itself. The host adds that message as the human's own, so it names only the
   role key and the capability names, never the room's name, purpose or a brief
   field (ADR 0008). Peer strings reach the DOM as text nodes.
5. **The page is built, never committed.** Vite with `vite-plugin-singlefile`
   bundles `ui/` into one HTML document, which `scripts/wrap-ui.ts` writes into
   `src/ui/assets.ts`, generated and gitignored. Every npm script that compiles
   or runs the server runs `build:ui` first, and the `[build]` hook in
   `wrangler.toml` runs it for every path that bundles the Worker.
6. **The bridge proxies resources.** It forwards `resources/list` and
   `resources/read` to the remote, so the page renders through the Desktop
   bundle (ADR 0017) as it does for a remote connector.

## Consequences

- #193 passed every check and failed to deploy: the deploy job called wrangler
  directly, and only npm scripts built the asset. PR #195 added the `[build]`
  hook, and CI runs `wrangler deploy --dry-run` on every PR.
- `bellman_rooms` and `bellman_surface` are listed to the model on every request.
  Neither is hidden with `visibility: ["app"]`: an agent should be able to call
  both, and a host without the extension lists them anyway.
- "New" on the monitor counts events since the view opened: the server keeps no
  read cursor per member, so it cannot say what the agent has seen.
- A host that renders no MCP Apps, Claude Code's terminal among them, shows the
  text results it showed before.
