# scripts

## Overview

Build, release and operator tooling, run with `tsx` through `package.json`
scripts. Four build generated artifacts (the plugin's bridge bundles, the mod's
bundle, the UI asset module, the docs site's tool reference); `test-mod.ts`
checks the mod in isolation; `smoke.ts` runs end-to-end checks against a live
server; `rotate-key.ts` and `grant-plan.ts` rebuild and upload Worker secrets
from a local source of truth under `~/.config/bellman`.

## Interface

| File | npm script | Kind |
| --- | --- | --- |
| `build-mod.ts` | `build:mod` | module + CLI |
| `build-plugin.ts` | `build:plugin` | CLI |
| `wrap-ui.ts` | `build:ui` (after `vite build`) | CLI |
| `docs-gen.ts` | `docs:gen` | CLI |
| `docs-reference.ts` | none | module |
| `test-mod.ts` | `test:mod` (part of `verify`) | CLI |
| `smoke.ts` | `smoke` | CLI |
| `rotate-key.ts` | `rotate-key` | module + CLI |
| `grant-plan.ts` | `grant-plan` | module + CLI |

- `build-mod.ts`: `buildMod(outfile = "mod/hooks/register.mjs")`, entry
  `mod/src/register.tsx`; imported by `build-plugin.ts` and `test-mod.ts`
  [build-mod.ts:buildMod]
- `build-plugin.ts`: `src/client/channel.ts`, `src/client/stop-hook.ts`,
  `src/client/status-hook.ts`, `src/client/join-hook.ts` to `plugin/bridge/*.mjs`, plus
  `THIRD-PARTY-NOTICES.txt`, then `buildMod()` [build-plugin.ts:(top-level CLI)]
- `wrap-ui.ts`: `ui/dist/index.html` and the package version to
  `src/ui/assets.ts` (`APP_HTML`, `PACKAGE_VERSION`) [wrap-ui.ts:(top-level CLI)]
- `docs-reference.ts`: `CONTENT_DIR`, `TOOLS_DIR` (`reference/tools`),
  `BRIDGE_PAGE` (`reference/bridge-tools.md`), `JsonSchema`, `escapeProse`,
  `labelOf`, `typeOf`, `toolPage`, `bridgePage`, `referencePages`; shared by
  `docs-gen.ts` and `tests/docs-reference.test.ts`; tools come from
  `listServerTools`/`listHookBridgeTools` in `tests/helpers/tool-lists.ts`
  [docs-reference.ts:CONTENT_DIR,TOOLS_DIR,BRIDGE_PAGE,JsonSchema,escapeProse,labelOf,typeOf,toolPage,bridgePage,referencePages]
- `docs-gen.ts`: writes `referencePages()` under
  `docs-site/src/content/docs/` [docs-gen.ts:(top-level CLI)]
- `test-mod.ts`: copies `mod/.claude-plugin/plugin.json`,
  `mod/hooks/hooks.json`, `mod/types`, `mod/tests` into a temp dir, builds the
  bundle there, runs `claude plugin validate` and `claude plugin test`; reads
  `CI` [test-mod.ts:(top-level CLI)]
- `smoke.ts`: `BELLMAN_URL` (default `http://localhost:3900/mcp`); dev keys
  `qk_dev_jesse`, `qk_dev_peer`, `qk_dev_outsider`, `qk_not_a_real_key`
  [smoke.ts:main]
- `rotate-key.ts`: `IdentitySpec`, `newKey`, `parseIdentities`,
  `buildKeyMap`, `keyFor`; flags `--dry-run`, `--print`, `--no-claude`,
  `--url` (default `https://mcp.bellman.sh/mcp`); env `BELLMAN_CONFIG_DIR`
  (default `~/.config/bellman`); reads `identities.json`, writes `keys.json`
  [rotate-key.ts:IdentitySpec,newKey,parseIdentities,buildKeyMap,keyFor]
- `grant-plan.ts`: `Subject`, `Grant`, `ResolvedGrant`, `parseSubject`,
  `parseGrant`, `parseUsers`, `resolveSubjectKey`, `resolveKey`, `mergeGrant`,
  `removeGrant`, `formatUsers`; flags `--github`, `--key`, `--email`,
  `--plan`, `--role`, `--org` (`none` for null), `--label`, `--user-id`,
  `--list`, `--revoke`, `--dry-run`, `--url`; env `BELLMAN_CONFIG_DIR`; file
  `users.json` [grant-plan.ts:flag]

## Invariants

- Bridge bundles get a `createRequire` banner and inline the package version as
  `BELLMAN_BUNDLE_VERSION` [build-plugin.ts:banner]
  [build-plugin.ts:define.BELLMAN_BUNDLE_VERSION]
- Notices are one per bundled package, keyed `name@version`, sorted by code
  point; a package with no license file gets `(no license file)`
  [build-plugin.ts:notices]
- The mod bundle keeps only `claude-code` external and ignores
  `mod/tsconfig.json` [build-mod.ts:external]
- `wrap-ui.ts` throws unless the HTML starts with `<!doctype html>`, and
  writes `src/ui/assets.ts` only when its content changed, so the wrangler
  watcher is not retriggered [wrap-ui.ts:html] [wrap-ui.ts:next]
- `docs-gen.ts` deletes any `.md` in `reference/tools/` the run did not
  produce [docs-gen.ts:removed]
- A tool with no title throws; the label is Reads for `readOnlyHint: true`,
  Writes for `destructiveHint: false`, Destructive otherwise; the bridge page
  lists only hook-bridge tools that are not server tools
  [docs-reference.ts:titleOf] [docs-reference.ts:labelOf]
  [docs-reference.ts:referencePages]
- `test-mod.ts` skips and succeeds only when `CI` is set and `claude` is
  missing; anywhere else a spawn error throws [test-mod.ts:CI]
- `smoke.ts` asserts, among others: exactly 9 tools, the free plan refused the
  swarm preset, an outsider refused as `org-restricted`, `UNTRUSTED` in the
  preview, a join code consumed once the pair fills, the long poll resolving on
  send; `/ws` checks run only when `/healthz` reports runtime `workers`
  [smoke.ts:assert] [smoke.ts:runtime]
- `rotate-key.ts` mints a fresh `bk_` + 24-byte hex key for every identity;
  identities must be non-empty with a valid plan and role, and a team or admin
  identity needs an org [rotate-key.ts:newKey] [rotate-key.ts:parseIdentities]
- `grant-plan.ts` needs exactly one of `--github`, `--key`, `--email`; a team
  plan or admin role with `--org none` throws; `--revoke` of an absent key
  throws [grant-plan.ts:parseSubject] [grant-plan.ts:parseGrant]
  [grant-plan.ts:removeGrant]
- `users.json` keys must start with `github:`, `google:` or `email:`
  [grant-plan.ts:parseUsers]

## Side Effects

- Build scripts write `plugin/bridge/*`, `mod/hooks/register.mjs`,
  `src/ui/assets.ts` and `docs-site/src/content/docs/reference/` (deleting stale
  tool pages) [build-plugin.ts:build] [build-mod.ts:build]
  [wrap-ui.ts:writeFileSync] [docs-gen.ts:rmSync/writeFileSync]
- `test-mod.ts` creates and removes a temp dir and spawns the `claude` CLI; the
  committed `mod/hooks/register.mjs` is untouched [test-mod.ts:mkdtempSync]
- `smoke.ts` creates real sessions, messages, an action request and audit
  entries on the target server over MCP HTTP, `/healthz` and `/ws`; a failed
  check sets exit code 1 [smoke.ts:connect] [smoke.ts:assert]
- `rotate-key.ts` backs up `keys.json`, runs
  `npx wrangler secret put BELLMAN_KEYS`, writes `keys.json` (mode 600), probes
  `--url` with the new key and the old one, and unless `--no-claude` replaces
  the user-scope `bellman` MCP server in Claude Code's config
  [rotate-key.ts:main] [rotate-key.ts:verify] [rotate-key.ts:run(claude)]
- `grant-plan.ts` calls the GitHub users API for `--github`, backs up
  `users.json`, runs `npx wrangler secret put BELLMAN_USERS`, writes
  `users.json` (mode 600), then probes `--url` expecting 401; `--list` and
  `--dry-run` upload nothing [grant-plan.ts:resolveSubjectKey]
  [grant-plan.ts:main] [grant-plan.ts:verifyHealthy]

## Verification

- Run: `npm run verify` (exercises `build:ui`, `test:mod` and, through
  `tests/docs-reference.test.ts`, `docs-reference.ts`)
- Run: `npm run build:plugin`, then `npx vitest run tests/plugin.test.ts`
