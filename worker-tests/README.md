# worker-tests

The second test program. It exists to run one thing: the `BellmanStore` contract
suite (`../tests/helpers/store-contract.ts`) against `DurableObjectStore`, in
real workerd, with real Durable Objects — issue #12.

```bash
npm run test:worker      # from the repo root
```

## Why it is a separate package

`@cloudflare/vitest-pool-workers` peers on `vitest@^4.1.0`, and on
`@vitest/runner`/`@vitest/snapshot` at the same major. The root program runs
vitest 5. Forcing them together at the root does not work: `--legacy-peer-deps`
there removes `vite`, which vitest 5 imports internally, and the root suite dies
with `ERR_MODULE_NOT_FOUND` before the pool boots.

A nested `package.json` is not that. It gets its own `node_modules`, so the pool
gets a genuine vitest 4 tree with `vite` intact and the root keeps vitest 5. This
directory is therefore NOT an npm workspace of the root, and `npm install` here
is separate from `npm install` there.

## Three things that will bite whoever touches this

**`--legacy-peer-deps` is required to install, for an unrelated reason.** npm
10.9.2's arborist crashes with `Cannot read properties of null (reading
'edgesOut')` on vitest 4's optional peer cycle — `@vitest/browser-playwright@5`
peers back on `vitest`. The flag skips the peer walk that crashes. It is not
papering over a version conflict: the resolved tree is correct, all of vitest,
`@vitest/runner` and `@vitest/snapshot` at 4.1.11.

**`overrides` pins workerd forward, deliberately.** The pool pins
`miniflare@5.20260815.0-alpha`, whose workerd refuses a
`compatibility_date` past `2026-08-22`. Production is on `2026-09-01`. Lowering
the date in `wrangler.toml` would make the tests run on a different runtime
contract than production, which is the one thing this program exists to avoid —
so the override raises workerd instead. Bump both together.

**`evictAllDurableObjects()` is the teardown that keeps sockets.**
`abortAllDurableObjects()` closes an accepted WebSocket (1006, unclean), so it
cannot be used to simulate hibernation; `evictAllDurableObjects()` hibernates
them and is what `ws-delivery.test.ts` uses. The two are not
interchangeable — evict also drains in-flight long polls, so a test that needs
an in-memory waiter destroyed still wants abort.

**The pool's config API changed at 0.22.0.** There is no
`@cloudflare/vitest-pool-workers/config` subpath and no `defineWorkersConfig`;
it is a plain Vite plugin, `cloudflareTest()`. `isolatedStorage` is gone too,
replaced by `reset()` and `abortAllDurableObjects()` from `cloudflare:test`,
which `store-contract.test.ts` calls explicitly.

## What `wrangler.toml` here is for

The pool reads Durable Object bindings and migrations from a wrangler config.
This one mirrors the real `../wrangler.toml`'s DO topology and compatibility
settings and nothing else — no routes, no custom domain, no observability. When
the DO topology changes in the real file, change it here too.
