import { describe, expect, it } from "vitest";
import {
  CONFIG_NAMES, CONFIG_RESERVE_BYTES, bodyBytes, bodyHash, isNarrowing, parseConfigBody, restrictive,
  truncateForDelivery,
} from "../src/config.js";

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
