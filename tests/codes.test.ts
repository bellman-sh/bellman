import { describe, it, expect } from "vitest";
import {
  generateConnectToken, generateJoinCode, generateSessionId, normalizeJoinCode,
} from "../src/codes.js";

describe("join codes", () => {
  it("matches the human-relayable BELL-XXXX-XX shape", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateJoinCode()).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    }
  });

  /** Codes get read aloud and retyped, so the ambiguous glyphs are excluded. */
  it("never emits 0, O, 1, I or L", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of generateJoinCode().replace(/^BELL-/, "").replace("-", "")) {
        seen.add(ch);
      }
    }
    for (const banned of ["0", "O", "1", "I", "L"]) {
      expect([...seen], `alphabet should exclude ${banned}`).not.toContain(banned);
    }
    expect(seen.size).toBeGreaterThan(20); // the generator is actually varying
  });

  it("does not repeat itself across a large sample", () => {
    const codes = new Set(Array.from({ length: 2_000 }, generateJoinCode));
    expect(codes.size).toBe(2_000);
  });

  it("normalizes case and whitespace from a relayed code", () => {
    expect(normalizeJoinCode("  bell-7f3k-92 ")).toBe("BELL-7F3K-92");
    expect(normalizeJoinCode("QRA 7F3K 92")).toBe("QRA7F3K92");
  });
});

describe("identifiers", () => {
  it("prefixes session and connect-token ids distinctly", () => {
    expect(generateSessionId()).toMatch(/^qs_[0-9a-f-]{36}$/);
    expect(generateConnectToken()).toMatch(/^qct_[0-9a-f-]{36}$/);
  });

  it("mints unique identifiers", () => {
    const ids = new Set(Array.from({ length: 1_000 }, generateSessionId));
    expect(ids.size).toBe(1_000);
  });
});
