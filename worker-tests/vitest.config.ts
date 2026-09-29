import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// 0.22.0 dropped the `@cloudflare/vitest-pool-workers/config` subpath and
// `defineWorkersConfig`; the pool is a plain Vite plugin now.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
