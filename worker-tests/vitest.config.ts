import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// 0.22.0 dropped the `@cloudflare/vitest-pool-workers/config` subpath and
// `defineWorkersConfig`; the pool is a plain Vite plugin now.

// The /ws route refuses to serve with no key map (src/worker.ts `unconfigured`),
// so ws-delivery.test.ts needs one. A binding here and not a var in
// wrangler.toml, which mirrors production's Durable Object topology and nothing
// else. The identity is the one tests/helpers/fixtures.ts seats in every room.
const BELLMAN_KEYS = JSON.stringify({
  qk_ws_test: { userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd" },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { bindings: { BELLMAN_KEYS } },
    }),
  ],
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
