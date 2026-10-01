# Bellman for Claude Desktop

A one-click bundle that installs Bellman as a local MCP server in Claude
Desktop. Every release carries one as an asset — take it from
[the latest release](https://github.com/bellman-sh/bellman/releases/latest) and
skip the build. To build one yourself, from the repository root:

```bash
./extension/build.sh                   # latest published release → extension/dist/bellman.mcpb
./extension/build.sh --version 0.2.0   # a specific release
./extension/build.sh --from .          # this checkout, unreleased
```

The default build takes the server from npm, so it packs released code without
compiling this checkout — only `npm` is needed. `--from .` is the contributor
path, for testing a bundle before the package is published; it is also what the
release workflow runs, so the asset attached to a release is packed from that
release's own commit.

Then drag `extension/dist/bellman.mcpb` onto Claude Desktop, or use
**Settings → Extensions → Advanced settings → Install extension**. There is
nothing to paste: the first time Desktop starts the bridge it opens a browser
to sign you in, and caches the credential on this machine.

> `extension/manifest.json` is the bundle manifest, the thing Claude Desktop
> reads. `src/manifest.ts` is the unrelated *room* manifest — the roles and
> verbs a room declares. The names collide; nothing else about them does.

---

## The format moved. Use `.mcpb`.

Anthropic shipped this as **Desktop Extensions** with a `.dxt` extension in
June 2025, then renamed it to **MCP Bundles** (`.mcpb`) in September 2025.

| | Then | Now |
|---|---|---|
| Extension | `.dxt` | `.mcpb` |
| Repository | `anthropics/dxt` | [`modelcontextprotocol/mcpb`](https://github.com/modelcontextprotocol/mcpb) |
| CLI | `@anthropic-ai/dxt` (stale, 0.2.6) | `@anthropic-ai/mcpb` (2.1.2) |

Existing `.dxt` files still install. New bundles should be `.mcpb`. This
manifest targets `manifest_version` **0.3**, which is what the current CLI
validates against — `mcpb pack` prints *"Manifest schema validation passes"*
and refuses to pack otherwise, so a stale manifest fails loudly rather than
shipping broken. CI runs that same check (`mcpb validate`) on every push, so a
manifest that could not pack fails there rather than during a release.

## What a Bellman bundle needs

A bundle is a zip containing a manifest, a built stdio MCP server, and the
server's runtime dependencies. Bellman's is:

```
manifest.json           manifest_version 0.3, version synced to the package
package.json            pins @modelcontextprotocol/sdk only
server/                 dist/ — from the npm tarball, or from this checkout
  channel.js            entry point — the stdio bridge
node_modules/           the SDK and its transitive deps
```

Four decisions are worth explaining.

**1. It bundles the SDK and nothing else.** The published package declares
`express` and `zod` as dependencies, but `dist/channel.js` reaches only for
`@modelcontextprotocol/sdk` — express serves the standalone server and zod
builds its schemas, neither of which this stdio bridge runs. Installing all
three roughly triples the bundle, so `build.sh` writes a minimal
`package.json` for the staging directory rather than installing the package
itself. The SDK range is read from the package, never hardcoded here.

**2. `BELLMAN_DELIVERY` is set to `hook`, not `channel`.** The bridge has two
delivery modes. `channel` pushes peer events into the session as
`notifications/claude/channel`, which only Claude Code understands; in Claude
Desktop those notifications go nowhere *and* the mode's instructions tell the
agent it does not need to poll — which would be wrong. `hook` mode queues
incoming events and exposes `bellman_wait`, so the agent can block on the
queue and drain it. The Stop hook that Claude Code uses to flush that queue at
the end of a turn does not exist in Desktop, so nothing arrives unprompted —
but nothing is lost either.

**3. There is no key to paste.** The bridge signs itself in: with `BELLMAN_KEY`
unset, `src/channel.ts` opens a browser and caches the credential under
`~/.config/bellman/`. The manifest declared a *required*
`user_config.bellman_key` and fed it to the server's environment for two
releases after that stopped being necessary — an install field collecting a
secret for nothing. Only `bellman_url` remains, for pointing the bundle at your
own deployment.

One consequence worth stating plainly: the bridge proxies `tools/list`, and
proxying it means connecting, so on a machine with no cached credential the
browser opens when **Claude Desktop launches** rather than at the first
`bellman_*` call. Sign-in binds `127.0.0.1` on the first free port in
51004–51008, so it has to be a browser on the same machine.

**4. The manifest's `tools` list is held to the real surface by a test.**
Claude Desktop renders that list during install, which makes it the first
description of Bellman a Desktop user reads — and it is hand-written, so
nothing stopped it going stale. `tests/extension.test.ts` stands up a hook-mode
bridge over the real tool handlers and asserts the manifest names exactly what
that bridge lists. It found the bug it was written for: the list had been
missing `bellman_whoami` since the bridge grew it.

That surface is the server's eight tools plus the bridge's own two, and *which*
of its own depends on the delivery mode — `bellman_wait` exists under `hook`
and not under `channel`. So the test asserts the declared mode as well; without
that, the comparison would be circular.

Descriptions are not compared. The manifest's one-liners are deliberately
shorter than the tool descriptions the model is shown, and holding them
identical would push install-screen copy into a tool schema.

## Bundle or remote connector?

Claude Desktop has two ways to reach Bellman, and since OAuth shipped both work
and both sign you in the same way:

- **Remote custom connector** — add `https://mcp.bellman.sh/mcp` under
  Settings → Connectors and complete OAuth. Nothing to build, nothing to
  update, and the client registers itself. Anthropic publishes no deep-link
  scheme for this, so it is paste-a-URL by hand.
  [bellman#7](https://github.com/bellman-sh/bellman/issues/7) is closed.
- **This bundle** — runs the bridge locally over stdio.

The difference that survives is **where the bridge runs**, not who holds a
credential. A local bridge keeps a queue of peer events and the cursor into it,
which is what lets it offer `bellman_wait`; it is also the only shape in which
push delivery could ever work. A connector dialled from Anthropic's cloud
cannot push anything into a session and never will — see
[#27](https://github.com/bellman-sh/bellman/issues/27).

Against that, the connector needs no build, no update and no
unsigned-extension warning. It is the shorter road, and most people should
still take it.

## What it does not do

- **No push delivery.** Peer events queue; the agent retrieves them with
  `bellman_wait` or `bellman_sync`. Ask for a check and you get one. Walk away
  and nothing interrupts you. Push is a Claude Code feature and rides Claude
  Code channels.
- **Not signed.** Releases carry the bundle, but no certificate signs it yet,
  so Claude Desktop shows the unsigned-extension warning. That warning is
  correct and should not be worked around.

## Verifying a build

From the repository root:

```bash
npx @anthropic-ai/mcpb validate extension/manifest.json  # schema check, no build
npm test -- tests/extension.test.ts                      # tool list matches the bridge
./extension/build.sh --from .                            # stage and pack
npx @anthropic-ai/mcpb info extension/dist/bellman.mcpb   # inspect the result
```

Last known-good build: **3.8 MB**, 2,388 files, v0.2.0 from this checkout,
manifest schema validation passes.

To sign it once there is a certificate to sign with, `mcpb sign` and
`mcpb verify` are in the same CLI.
