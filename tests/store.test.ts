import { describe, it, expect } from "vitest";
import { MemoryStore, hydrateSession } from "../src/store.js";
import { describeStoreContract } from "./helpers/store-contract.js";

describeStoreContract("MemoryStore", () => new MemoryStore());

/**
 * Records written before a field existed.
 *
 * `frozenAt` post-dates every session now in production, and the guards are
 * written `frozenAt !== null`. Without a default on read, deploying would
 * report every existing room as frozen and refuse every write in it — the same
 * shape as the pre-`identity_keys` refresh tokens on #44.
 */
describe("hydrating a session written before frozenAt existed", () => {
  it("reads a record with no frozenAt as not frozen", () => {
    const legacy = { id: "qs_old", closed: false } as Parameters<typeof hydrateSession>[0];

    expect(hydrateSession(legacy).frozenAt).toBeNull();
  });

  it("leaves a real freeze alone", () => {
    expect(hydrateSession({ frozenAt: 1_790_000_000 }).frozenAt).toBe(1_790_000_000);
    expect(hydrateSession({ frozenAt: null }).frozenAt).toBeNull();
  });
});
