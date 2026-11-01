# extension

## Overview

The Claude Desktop `.mcpb` bundle. `manifest.json` declares how Claude Desktop
launches the Bellman bridge (`server/channel.js`, in queue delivery) and which
tools it shows at install. `build.sh` stages a published or local build of the
server with its runtime dependencies, `check-deps.mjs` confirms every bare
import resolves inside the stage, and `@anthropic-ai/mcpb` packs the result
into `extension/dist/bellman.mcpb`. Install and usage notes for people are in
[README.md](./README.md).

## Interface

- `manifest.json` (`manifest_version` "0.3", name `bellman`)
  - `server`: type `node`, `entry_point` `server/channel.js`; `mcp_config` runs
    `node ${__dirname}/server/channel.js` [extension/manifest.json:server]
  - `server.mcp_config.env`: `BELLMAN_URL=${user_config.bellman_url}`,
    `BELLMAN_UPLOAD_ROOT=${user_config.upload_root}`, `BELLMAN_DELIVERY=queue`,
    `BELLMAN_INSTALL=bundle` [extension/manifest.json:server.mcp_config.env]
  - `user_config.bellman_url`: string, optional, default
    `https://mcp.bellman.sh/mcp` [extension/manifest.json:user_config.bellman_url]
  - `user_config.upload_root`: directory, optional, no default
    [extension/manifest.json:user_config.upload_root]
  - `tools`: 17 entries, from `bellman_start` to `bellman_report`, including
    `bellman_decide` and the bridge's own `bellman_wait` and `bellman_upload`
    [extension/manifest.json:tools]
  - `compatibility`: `claude_desktop >=0.10.0`; darwin, win32, linux; Node
    `>=20.0.0` [extension/manifest.json:compatibility]
- `build.sh`: `./extension/build.sh` packs the latest npm release,
  `--version X` a named release, `--from <path>` a local checkout; `-h` prints
  usage [extension/build.sh:-h|--help case]. `BELLMAN_PKG` overrides the npm package,
  default `@bellman-sh/mcp-server` [extension/build.sh:PKG]. Output:
  `extension/dist/bellman.mcpb`; staging: `extension/build`
  [extension/build.sh:out]
- `check-deps.mjs`: `node check-deps.mjs <stage-dir> [entry]`, entry default
  `server/channel.js` [extension/check-deps.mjs:argv]. `packageOf` maps a
  specifier to its package name [extension/check-deps.mjs:packageOf]; `visit`
  walks the ESM import graph (static, re-export, string-literal dynamic),
  skipping `node:`/`cloudflare:` specifiers and builtins
  [extension/check-deps.mjs:visit]

## Invariants

- The manifest's tool list equals the tools a bridge in the manifest's
  `BELLMAN_DELIVERY` lists, exactly 17, each with a non-empty description. A
  new tool means editing `manifest.json` by hand
  [tests/extension.test.ts:declares every tool the bundle exposes, and no others]
  [tests/extension.test.ts:declares exactly seventeen tools]
  [tests/extension.test.ts:gives every declared tool a description]
- `manifest.version` equals the root `package.json` version; `build.sh` also
  overwrites the staged manifest's version with the server package's version
  [tests/extension.test.ts:carries the package's version as its template version]
  [extension/build.sh:manifest staging]
- The bundle runs in queue delivery from `server/channel.js` with
  `BELLMAN_INSTALL=bundle`, so update notices name a reinstall
  [tests/extension.test.ts:launches the bridge in queue delivery, which is the mode that surface assumes]
  [tests/extension.test.ts:tells the bridge it runs from the bundle, so an update notice names a reinstall]
- The bundle tells the agent to call `bellman_sync` at the start of each turn,
  and never mentions a Stop hook or polling
  [tests/extension.test.ts:tells the agent to collect its own peer events]
- No key is asked for: no `user_config.bellman_key`, no `BELLMAN_KEY` env; the
  bridge signs itself in
  [tests/extension.test.ts:asks for no key: the bridge signs itself in]
- Every `${user_config.X}` placeholder in env names a declared key
  [tests/extension.test.ts:exposes the upload root as a folder setting, and every placeholder it passes names a setting it declares]
- `build.sh` runs under `set -eu`; exit 1 on an unknown option or a missing
  `--from` directory, 2 when `npm` is absent, 3 when the build or pack yields
  no `dist/channel.js` [extension/build.sh:set -eu] [extension/build.sh:npm check]
  [extension/build.sh:--from] [extension/build.sh:npm pack branch]
- `check-deps.mjs` exits 1 when any imported bare package is missing from
  `<stage>/node_modules`, and that aborts `build.sh`
  [extension/check-deps.mjs:missing] [extension/build.sh:Checking imports]

## Side Effects

- `build.sh` deletes and recreates `extension/build` and `extension/dist`
  [extension/build.sh:rm -rf]
- `--from` runs `npm install` and `npm run build` in the named checkout, then
  copies its `dist/` into `build/server/` [extension/build.sh:--from]
- Otherwise `npm pack` downloads the package from the registry and unpacks its
  `dist/` into `build/server/` [extension/build.sh:npm pack branch]
- Writes `build/manifest.json` and `build/package.json` (private,
  `bellman-desktop-extension`, the server's dependencies)
  [extension/build.sh:package.json staging]
- `npm install --omit=dev` into `build/` (network), then
  `npx --yes @anthropic-ai/mcpb@2 pack build dist/bellman.mcpb` (network)
  [extension/build.sh:npm install] [extension/build.sh:Packing]
- `check-deps.mjs` only reads files; it writes nothing
  [extension/check-deps.mjs:visit]

## Verification

- Run: `npx vitest run tests/extension.test.ts`
- Run: `npm run verify`
