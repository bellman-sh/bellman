import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { describeStoreContract } from "./helpers/store-contract.js";
import { roomManifest, session } from "./helpers/fixtures.js";

describeStoreContract("MemoryStore", () => new MemoryStore());

describe("manifest persistence", () => {
  it("round-trips a manifest through the store unchanged", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest({ room: "persisted", purpose: "keep me" }) });
    await store.createSession(s);

    const back = await store.getSession(s.id);
    expect(back?.manifest).toEqual(s.manifest);
    expect(back?.manifest.roles.peer_a.can).toContain("close_room");
  });

  it("hands back a detached manifest that callers cannot mutate in place", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest() });
    await store.createSession(s);

    const first = await store.getSession(s.id);
    first!.manifest.roles.peer_b.can.push("close_room");

    const second = await store.getSession(s.id);
    expect(second?.manifest.roles.peer_b.can).not.toContain("close_room");
  });
});

/**
 * Records written before a field existed.
 *
 * Both fields post-date the sessions now in production, and they want opposite
 * treatment: a manifest cannot be invented, so those rows read as gone; a
 * freeze can be defaulted, and must be, or every existing room reports frozen
 * and refuses every write in it.
 */
describe("hydrating a session written before a field existed", () => {
  const stored = (over: Record<string, unknown> = {}) => {
    const { events, ...rest } = session();
    return { ...rest, ...over };
  };

  it("reads a row with no frozenAt as not frozen", () => {
    const { frozenAt, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)?.frozenAt).toBeNull();
  });

  it("leaves a real freeze alone", () => {
    expect(hydrateStoredSession(stored({ frozenAt: 1_790_000_000 }))?.frozenAt)
      .toBe(1_790_000_000);
  });

  /** A manifest is a declaration; inventing one would put words in a mouth. */
  it("treats a row with no manifest as gone rather than defaulting it", () => {
    const { manifest, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)).toBeUndefined();
    expect(hydrateStoredSession(stored({ manifest: { roles: undefined } }))).toBeUndefined();
    expect(hydrateStoredSession(undefined)).toBeUndefined();
  });
});
