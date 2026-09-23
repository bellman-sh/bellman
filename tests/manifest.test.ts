/**
 * resolveManifest is pure — no store, no identity, no clock. Every rule the
 * server relies on is proved here, so the tool tests can assume a valid manifest.
 */
import { describe, it, expect } from "vitest";
import { resolveManifest, ManifestError, ManifestShape } from "../src/manifest.js";

function authored(over: Record<string, unknown> = {}) {
  return {
    room: "payments-migration",
    mode: "pair",
    roles: {
      lead: { can: ["send", "invite"] },
      helper: { can: ["send"] },
    },
    default_role: "helper",
    creator_role: "lead",
    ...over,
  };
}

describe("presets", () => {
  it("expands pair into two peers with room control on the creator", () => {
    const m = resolveManifest({ room: "r", preset: "pair" });
    expect(m.mode).toBe("pair");
    expect(m.preset).toBe("pair");
    expect(m.creatorRole).toBe("peer_a");
    expect(m.defaultRole).toBe("peer_b");
    expect(m.roles.peer_a.can).toContain("close_room");
    expect(m.roles.peer_b.can).not.toContain("close_room");
  });

  it("expands swarm with mode swarm and a verbless observer", () => {
    const m = resolveManifest({ room: "r", preset: "swarm" });
    expect(m.mode).toBe("swarm");
    expect(m.creatorRole).toBe("lead");
    expect(m.defaultRole).toBe("helper");
    expect(m.roles.observer.can).toEqual([]);
  });

  it("expands review so a reviewer answers actions but cannot start them", () => {
    const m = resolveManifest({ room: "r", preset: "review" });
    expect(m.mode).toBe("pair");
    expect(m.roles.reviewer.can).toContain("respond_actions");
    expect(m.roles.reviewer.can).not.toContain("request_actions");
  });

  it("names the valid presets when given an unknown one", () => {
    expect(() => resolveManifest({ room: "r", preset: "duo" } as never))
      .toThrow(/pair, swarm, review/);
  });

  it("records preset as null when roles are authored", () => {
    expect(resolveManifest(authored()).preset).toBeNull();
  });
});

describe("cross-field validation", () => {
  it("rejects a default_role that names no role", () => {
    expect(() => resolveManifest(authored({ default_role: "ghost" })))
      .toThrow(/default_role "ghost" is not defined in roles \(defined: lead, helper\)/);
  });

  it("rejects a creator_role that names no role", () => {
    expect(() => resolveManifest(authored({ creator_role: "ghost" })))
      .toThrow(/creator_role "ghost" is not defined in roles/);
  });

  it("rejects duplicate verbs in one role", () => {
    expect(() => resolveManifest(authored({
      roles: { lead: { can: ["send", "send"] }, helper: { can: ["send"] } },
    }))).toThrow(/duplicate verb "send"/);
  });

  it("rejects an empty roles map", () => {
    expect(() => resolveManifest(authored({ roles: {} }))).toThrow(ManifestError);
  });
});

describe("hostile input", () => {
  it("rejects __proto__ as a role key without polluting Object.prototype", () => {
    // JSON.parse makes "__proto__" a real own key, which is how it arrives over
    // the wire. An object literal `{ __proto__: … }` sets the prototype instead
    // and never creates the key, so it would prove nothing.
    const hostile = JSON.parse('{"__proto__":{"can":["close_room"]},"helper":{"can":["send"]}}');
    const control = JSON.parse('{"helper":{"can":["send"]}}');
    expect(() => resolveManifest(authored({ roles: control, creator_role: "helper" })))
      .not.toThrow();
    expect(() => resolveManifest(authored({ roles: hostile, creator_role: "helper" })))
      .toThrow(ManifestError);
    expect(({} as Record<string, unknown>).can).toBeUndefined();
  });

  it("rejects __proto__ in ManifestShape itself, so a tool schema built on it is safe too", () => {
    // z.record silently drops an own __proto__ key; the guard in RolesShape turns
    // that into a rejection. Without it, the MCP SDK (which parses arguments with
    // the shape before any handler runs) would hand resolveManifest a roles map
    // that had already lost the key.
    const wire = JSON.parse(
      '{"room":"r","mode":"pair","default_role":"helper","creator_role":"helper",'
      + '"roles":{"__proto__":{"can":["close_room"]},"helper":{"can":["send"]}}}',
    );
    expect(ManifestShape.safeParse(wire).success).toBe(false);
  });

  it("rejects an uppercase role key", () => {
    expect(() => resolveManifest(authored({
      roles: { Lead: { can: ["send"] }, helper: { can: ["send"] } },
      creator_role: "Lead",
    }))).toThrow(ManifestError);
  });

  it("rejects citing a preset and authoring roles at once", () => {
    expect(() => resolveManifest({ ...authored(), preset: "pair" } as never))
      .toThrow(ManifestError);
  });

  it("rejects more than 16 roles", () => {
    const roles: Record<string, { can: string[] }> = {};
    for (let i = 0; i < 17; i++) roles[`r${i}`] = { can: [] };
    expect(() => resolveManifest(authored({
      roles, default_role: "r0", creator_role: "r0",
    }))).toThrow(ManifestError);
  });

  it("rejects an unknown verb", () => {
    expect(() => resolveManifest(authored({
      roles: { lead: { can: ["summon_kraken"] }, helper: { can: ["send"] } },
    }))).toThrow(ManifestError);
  });
});

describe("legal edge cases", () => {
  it("allows creator_role === default_role", () => {
    const m = resolveManifest(authored({
      roles: { peer: { can: ["send"] } },
      default_role: "peer",
      creator_role: "peer",
    }));
    expect(m.creatorRole).toBe("peer");
    expect(m.defaultRole).toBe("peer");
  });

  it("allows a role with no verbs", () => {
    const m = resolveManifest(authored({
      roles: { lead: { can: ["send"] }, watcher: { can: [] } },
      default_role: "watcher",
    }));
    expect(m.roles.watcher.can).toEqual([]);
  });

  it("allows a sealed room where nobody can invite", () => {
    const m = resolveManifest(authored({
      roles: { lead: { can: ["send"] }, helper: { can: ["send"] } },
    }));
    expect(Object.values(m.roles).some((r) => r.can.includes("invite"))).toBe(false);
  });

  it("defaults purpose and description to null", () => {
    const m = resolveManifest(authored());
    expect(m.purpose).toBeNull();
    expect(m.roles.lead.description).toBeNull();
  });
});
