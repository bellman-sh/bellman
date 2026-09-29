import { describe, it, expect } from "vitest";
import {
  generateConnectToken, generateSessionId, normalizeJoinCode, renderJoinCode, MAX_JOIN_CODE_LENGTH,
} from "../src/codes.js";
import { MAX_ROLE_KEY_LENGTH } from "../src/manifest.js";

describe("join codes", () => {
  /** Codes get read aloud and retyped, so the ambiguous glyphs are excluded. */
  it("never emits 0, O, 1, I or L in the random groups", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of renderJoinCode("reviewer").split("-").slice(1, 3).join("")) {
        seen.add(ch);
      }
    }
    for (const banned of ["0", "O", "1", "I", "L"]) {
      expect([...seen], `alphabet should exclude ${banned}`).not.toContain(banned);
    }
    expect(seen.size).toBeGreaterThan(20); // the generator is actually varying
  });

  it("does not repeat itself across a large sample", () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => renderJoinCode("reviewer")));
    expect(codes.size).toBe(2_000);
  });

  it("normalizes case and whitespace from a relayed code", () => {
    expect(normalizeJoinCode("  bell-7f3k-92 ")).toBe("BELL-7F3K-92");
    expect(normalizeJoinCode("QRA 7F3K 92")).toBe("QRA7F3K92");
  });

  it("renders the role as a third group", () => {
    expect(renderJoinCode("reviewer")).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-REVIEWER$/);
  });

  /** RoleKeyShape allows `_` but not `-`, so the mapping back is unambiguous. */
  it("renders an underscore in a role name as a hyphen", () => {
    expect(renderJoinCode("peer_a")).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-PEER-A$/);
  });

  /** Review Focus 3: the longest role RoleKeyShape permits. */
  it("renders a 31-character role name whole", () => {
    const longest = "a" + "b".repeat(30);
    expect(longest).toMatch(/^[a-z][a-z0-9_]{0,30}$/);
    expect(renderJoinCode(longest).endsWith(`-${longest.toUpperCase()}`)).toBe(true);
  });

  /**
   * Ties MAX_JOIN_CODE_LENGTH to MAX_ROLE_KEY_LENGTH directly, rather than to
   * today's numbers on each side. A future edit that grows either constant
   * without the other breaks THIS assertion, instead of shipping a code that
   * renderJoinCode can produce and bellman_connect's own input schema refuses
   * (see the Critical #1 regression test in tests/tools/handshake.test.ts).
   */
  it("caps the join code long enough for the longest legal role name", () => {
    const longest = renderJoinCode("a".repeat(MAX_ROLE_KEY_LENGTH));
    expect(MAX_JOIN_CODE_LENGTH).toBeGreaterThanOrEqual(longest.length);
  });

  it("keeps two roles distinct when only one has an underscore", () => {
    const group = (role: string) => renderJoinCode(role).split("-").slice(3).join("-");
    expect(group("peer_a")).toBe("PEER-A");
    expect(group("peera")).toBe("PEERA");
  });

  /** Review Focus 2: relayed from memory with the wrong separator throughout. */
  it("folds an underscore-separated relay onto the canonical form", () => {
    expect(normalizeJoinCode(" bell_7f3k_92_peer_a ")).toBe("BELL-7F3K-92-PEER-A");
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
