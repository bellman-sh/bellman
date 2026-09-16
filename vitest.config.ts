import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration tests bind ephemeral ports and hold long-polls; give them room
    // but keep the suite honest about hangs.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Store tests use fake timers and module-level singletons; isolate files.
    pool: "forks",
  },
});
