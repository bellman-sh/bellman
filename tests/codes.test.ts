import { describe, it, expect } from "vitest";
import {
  generateConnectToken, generateSessionId, normalizeJoinCode, renderJoinCode,
} from "../src/codes.js";

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
