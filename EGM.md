# Bellman Blueprint

## System Overview

Bellman lets agent sessions, across providers, collaborate in rooms over MCP. A
room holds many members; its event log in the store is the truth, and every
push path to a member (the `bellman_sync` long poll, a `/ws` frame, the Stop-hook
fallback) is transport that may be late or dropped.

Three surfaces ship from this repository:

- **The server** (`src/`): one `McpServer` per request
  ([src/server.ts:buildServer]), plain-HTTP routes beside `/mcp`
  (`src/http/`), A2A for outside agents (`src/a2a/`), an OAuth 2.1
  authorization server (`src/oauth/`), Stripe billing (`src/billing/`) and SCIM
  provisioning (`src/scim/`). Production runs on Cloudflare Workers with five
  Durable Object classes ([src/worker.ts:fetch] re-exports `SessionDO`,
  `RegistryDO`, `AuditDO`, `AuthDO`, `HostDO`); `npm start` runs the Node
  entry over `MemoryStore` ([src/index.ts], [src/app.ts:createApp]).
- **The Claude Code client**: the local bridge ([src/bridge.ts:createBridge]),
  shipped as generated bundles in the `bellman` plugin (`plugin/`), its hooks,
  and `bellman-mod` (`mod/`), a hooks module that reads the bridge through a
  per-bridge Unix-socket door ([src/door.ts:startDoor]).
- **The Claude Desktop bundle** (`extension/`): the same bridge packed as an
  `.mcpb` in queue delivery.

`ui/` is the MCP Apps page, built into the server as a string constant;
`docs-site/` is docs.bellman.sh. `docs/ARCHITECTURE.md` is the whole-system view.

## Local Interface & Invariants

- [vitest.config.ts:default] the Node test program: `include` is
  `tests/**/*.test.ts` and `ui/test/**/*.test.ts`, `environment: "node"`,
  `pool: "forks"`, 15 s test and hook timeouts. `mod/tests/` and
  `worker-tests/` never run under `npm test`; they have `test:mod` and
  `test:worker`.
- `bin/bellman-claude`: a POSIX shell wrapper (published through
  `package.json` `bin`) that launches `claude` with
  `--dangerously-load-development-channels server:bellman` and passes every
  other argument through; `BELLMAN_CHANNEL_SERVER` overrides the channel entry.
- `wrangler.toml`, `tsconfig.json`, `tsconfig.test.json`,
  `tsconfig.worker.json`: build and deploy configuration. Workers-only files
  are excluded from the Node program by `tsconfig.json`.

## Subdirectories & System Boundaries

- src: [./src/EGM.md](./src/EGM.md) - the server, the storage boundary
  (`BellmanStore`, `MemoryStore`, `DurableObjectStore`), room operations shared
  by tools and routes, runtime-free rule modules, the hosted seat, blobs, and
  the local client (bridge, channel, inbox, bus, door, hooks, sign-in, CLI).
  - a2a: [./src/a2a/EGM.md](./src/a2a/EGM.md) - A2A JSON-RPC (v1.0 and v0.3)
    answered only by public, open rooms; AgentCards.
  - billing: [./src/billing/EGM.md](./src/billing/EGM.md) - signature-verified
    Stripe webhook, serialized ledger, purchase-sourced plan grants.
  - http: [./src/http/EGM.md](./src/http/EGM.md) - runtime-free HTTP routers:
    rooms, audit, orgs, SCIM, moderation, public reads.
  - mod: [./src/mod/EGM.md](./src/mod/EGM.md) - bellman-mod's pure logic
    (approval gate, wake limiter, view), bundled into `mod/hooks/register.mjs`.
  - oauth: [./src/oauth/EGM.md](./src/oauth/EGM.md) - the OAuth 2.1
    authorization server; `store.ts` (`AuthDO`) is Workers-only.
  - scim: [./src/scim/EGM.md](./src/scim/EGM.md) - SCIM 2.0 parsers, resource
    shapes, and the deprovision/reprovision walk over a person's rooms.
  - tools: [./src/tools/EGM.md](./src/tools/EGM.md) - one MCP tool per file
    plus `kit.ts`.
  - ui: [./src/ui/EGM.md](./src/ui/EGM.md) - the one `ui://` resource;
    `assets.ts` is generated and gitignored.
- ui: [./ui/EGM.md](./ui/EGM.md) - the MCP Apps page as a Vite single-file
  build; source contract at [./ui/src/EGM.md](./ui/src/EGM.md).
- mod: [./mod/EGM.md](./mod/EGM.md) - bellman-mod, the second plugin in the
  marketplace: [./mod/src/EGM.md](./mod/src/EGM.md) (the wiring) and
  [./mod/hooks/EGM.md](./mod/hooks/EGM.md) (the generated bundle).
- plugin: [./plugin/EGM.md](./plugin/EGM.md) - the `bellman` Claude Code
  plugin: generated bridge bundles
  ([./plugin/bridge/EGM.md](./plugin/bridge/EGM.md)), hooks, and two skills.
- extension: [./extension/EGM.md](./extension/EGM.md) - the Claude Desktop
  `.mcpb` bundle; its tool list is declared by hand.
- scripts: [./scripts/EGM.md](./scripts/EGM.md) - build, docs generation,
  smoke test, and operator tooling (key rotation, plan grants).
- docs-site: [./docs-site/EGM.md](./docs-site/EGM.md) - docs.bellman.sh, an
  Astro Starlight site with its own package; pages in
  [./docs-site/src/EGM.md](./docs-site/src/EGM.md).
- tests, worker-tests: test programs, no contract. `tests/` runs under vitest
  in Node (`tests/helpers/store-contract.ts` is the conformance suite every
  `BellmanStore` must pass); `worker-tests/` runs the same suite against the
  Durable Objects store in workerd ([worker-tests/README.md](./worker-tests/README.md)).
- docs: design records, no code ([docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md),
  `docs/adr/`).

## Global Invariants

- Every `BellmanStore` method returns a Promise, including ones `MemoryStore`
  answers at once, because the Durable Objects port crosses objects by RPC
  [src/store.ts:BellmanStore].
- `waitForEvents` reads events and registers its waiter in the same turn, in
  both stores [src/store-do.ts:SessionDO.waitForEvents],
  [src/store.ts:MemoryStore.waitForEvents].
- No transaction spans two Durable Objects; cross-object writes go through a
  FIFO outbox written in the mutation's transaction [src/outbox.ts:drain].
- Peer content is untrusted everywhere: wrapped on the server
  [src/projections.ts:untrusted], escaped by the client
  [src/inbox.ts:safeJson], cleaned before display in the mod
  [src/mod/view.ts:drawingOf], and rendered only as text nodes or in a
  sandboxed iframe on the page [ui/src/artifact.ts:FRAME_SANDBOX].
- A tool's return states what the call established: `bellman_send`'s
  `room_members` is the roster read before the append, not a read receipt
  [src/tools/send.ts:registerSend].
- Workers-only files (those importing `cloudflare:workers`) stay out of the
  Node build and out of vitest; their runtime-free shapes live in sibling
  modules [src/oauth/storage.ts:AuthStorage].
- Generated files are never edited by hand: `src/ui/assets.ts`
  ([scripts/wrap-ui.ts]), `plugin/bridge/*.mjs` and `mod/hooks/register.mjs`
  ([scripts/build-plugin.ts], [scripts/build-mod.ts:buildMod]), and the docs
  site's tool reference ([scripts/docs-gen.ts]).
- A new tool also edits `extension/manifest.json`, asserted by
  `tests/extension.test.ts`, and runs `npm run docs:gen`, asserted by
  `tests/docs-reference.test.ts`.

## Global Side Effects

- Cloudflare: Durable Object storage for rooms, the registry, audit, auth and
  the hosted seat; the R2 `BLOBS` bucket [src/blobs-r2.ts:R2BlobStore]; email
  bindings; the docs site's assets-only Worker (`docs-site/wrangler.toml`).
- Outbound HTTP: Stripe [src/billing/subscription.ts:readSubscription];
  GitHub, Google and OIDC identity providers and DNS-over-HTTPS
  [src/oauth/providers.ts], [src/oauth/dns.ts:domainVerified]; the Anthropic
  Messages API for the hosted seat [src/host.ts:callMessages]; org SIEM sinks
  [src/audit-sink.ts:deliverBatch].
- Client machine: `~/.config/bellman/credentials.json`, and inbox, bus and door
  sockets under `~/.claude/bellman/`; a loopback sign-in listener on
  127.0.0.1:51004-51008 [src/signin.ts:connectSignedIn].
- Operator scripts write Worker secrets through `wrangler secret put`
  [scripts/rotate-key.ts], [scripts/grant-plan.ts].

## System Verification

- Run: `npm run verify` (typecheck:ui, typecheck, typecheck:worker, build,
  `npm test`, `npm run test:worker`, `npm run test:mod`).
- Docs site: `npm --prefix docs-site ci && npm --prefix docs-site run build`.
- End to end against a deployment: `BELLMAN_URL=<url> npm run smoke`.
