import { describe, expect, it } from "vitest";
import {
  CONFIG_NAMES, CONFIG_RESERVE_BYTES, bodyBytes, bodyHash, getGovernedConfig, isNarrowing, parseConfigBody, restrictive,
  truncateForDelivery,
} from "../src/config.js";
import { type BellmanStore } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import type { ConfigRow } from "../src/types.js";

describe("getGovernedConfig", () => {
  const governance = { approvedBy: "u_jesse", approverMemberId: "m_1", approverLabel: "jesse", via: "dash_session" as const, atRev: 1, at: "2026-11-01T00:00:00.000Z" };
  const good: ConfigRow = {
    name: "room_instructions", rev: 3, body: { markdown: "Be terse." }, sha256: "h", bytes: 24, governance,
    changedBy: "m_1", changedAt: "2026-11-01T00:00:00.000Z",
  };
  /** A store whose only row is `row`: the reader's rules, apart from how a row got there. */
  const holding = (row: ConfigRow | null) => ({ getConfigRow: async () => row }) as unknown as BellmanStore;

  it("reads a missing row as no instructions, at revision 0", async () => {
    expect(await getGovernedConfig(holding(null), "qs_x", "room_instructions")).toEqual({ value: null, rev: 0, approver: null, clamped: [] });
    expect(await getGovernedConfig(new MemoryStore(), "qs_none", "room_instructions")).toMatchObject({ value: null, rev: 0 });
  });

  it("reads a valid row with its approver's seat and label, and never the approver's user id", async () => {
    const got = await getGovernedConfig(holding(good), "qs_x", "room_instructions");
    expect(got).toEqual({ value: { markdown: "Be terse." }, rev: 3, approver: { memberId: "m_1", label: "jesse" }, clamped: [] });
    expect(JSON.stringify(got)).not.toContain("u_jesse");
  });

  it("reads an invalid body as no instructions", async () => {
    expect((await getGovernedConfig(holding({ ...good, body: { markdown: 7 } }), "qs_x", "room_instructions")).value).toBeNull();
    expect((await getGovernedConfig(holding({ ...good, body: { markdown: "x", extra: 1 } }), "qs_x", "room_instructions")).value).toBeNull();
  });

  it("reads a row with no server-written governance as no instructions", async () => {
    const { governance: _, ...bare } = good;
    expect((await getGovernedConfig(holding(bare as ConfigRow), "qs_x", "room_instructions")).value).toBeNull();
    expect((await getGovernedConfig(holding({ ...good, governance: { ...governance, approvedBy: "" } }), "qs_x", "room_instructions")).value).toBeNull();
    expect((await getGovernedConfig(holding({ ...good, governance: { ...governance, via: "mcp" as "dash_session" } }), "qs_x", "room_instructions")).value).toBeNull();
  });

  it("reads cleared instructions as none", async () => {
    expect((await getGovernedConfig(holding({ ...good, body: { markdown: "" } }), "qs_x", "room_instructions")).value).toBeNull();
  });
});

describe("parseConfigBody", () => {
  it("accepts room_instructions as { markdown }", () => {
    expect(parseConfigBody("room_instructions", { markdown: "hi" })).toEqual({
      ok: true, name: "room_instructions", body: { markdown: "hi" },
    });
  });

  it("refuses a body that carries governance fields: governance is written by the server only", () => {
    expect(parseConfigBody("room_instructions", { markdown: "hi", governance: { approvedBy: "u_x" } }).ok).toBe(false);
  });

  it("refuses unknown keys", () => {
    expect(parseConfigBody("room_instructions", { markdown: "hi", extra: 1 }).ok).toBe(false);
  });

  it("refuses a name outside the closed set", () => {
    const r = parseConfigBody("judge.consent", {});
    expect(r).toMatchObject({ ok: false });
    expect(CONFIG_NAMES).toEqual(["room_instructions"]);
  });

  it("refuses markdown over 64 KiB", () => {
    expect(parseConfigBody("room_instructions", { markdown: "a".repeat(65_536) }).ok).toBe(true);
    expect(parseConfigBody("room_instructions", { markdown: "a".repeat(65_537) }).ok).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    expect(parseConfigBody("room_instructions", "hi").ok).toBe(false);
    expect(parseConfigBody("room_instructions", null).ok).toBe(false);
  });
});

describe("isNarrowing", () => {
  it("counts only clearing room_instructions as narrowing", () => {
    expect(isNarrowing("room_instructions", { markdown: "x" }, { markdown: "" })).toBe(true);
    expect(isNarrowing("room_instructions", null, { markdown: "x" })).toBe(false);
    expect(isNarrowing("room_instructions", { markdown: "long text" }, { markdown: "x" })).toBe(false);
  });
});

describe("restrictive", () => {
  it("is no instructions", () => {
    expect(restrictive("room_instructions")).toBeNull();
  });
});

describe("bodyHash and bodyBytes", () => {
  it("hash alike whatever the key order", () => {
    expect(bodyHash({ a: 1, b: 2 })).toBe(bodyHash({ b: 2, a: 1 }));
    expect(bodyHash({ markdown: "x" })).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash({ markdown: "x" })).not.toBe(bodyHash({ markdown: "y" }));
  });

  it("measures UTF-8 bytes of the canonical body", () => {
    expect(bodyBytes({ markdown: "é" })).toBe(Buffer.byteLength('{"markdown":"é"}', "utf8"));
    expect(CONFIG_RESERVE_BYTES).toBe(64 * 1024);
  });
});

describe("truncateForDelivery", () => {
  it("leaves 8,192 bytes untouched", () => {
    expect(truncateForDelivery("a".repeat(8192))).toEqual({ content: "a".repeat(8192), truncated: false });
  });

  it("cuts past 8 KiB and says how much more there is", () => {
    const r = truncateForDelivery("a".repeat(8193));
    expect(r.truncated).toBe(true);
    expect(r.content.startsWith("a".repeat(8192))).toBe(true);
    expect(r.content).toContain("[truncated: 1 bytes more; read the full text in the dash]");
  });

  it("never splits a multi-byte character", () => {
    const r = truncateForDelivery("😀".repeat(2049)); // 8,196 bytes
    const kept = r.content.split("\n\n[truncated")[0];
    expect(kept).toBe("😀".repeat(2048));
    expect(r.content).toContain("[truncated: 4 bytes more;");
  });
});
