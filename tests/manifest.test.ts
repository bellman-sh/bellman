/**
 * resolveManifest is pure — no store, no identity, no clock. Every rule the
 * server relies on is proved here, so the tool tests can assume a valid manifest.
 */
import { describe, it, expect } from "vitest";
import {
  resolveManifest, ManifestError, ManifestShape, PRESET_NAMES, RoleKeyShape, VERBS,
} from "../src/manifest.js";

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

  // PRESETS is a module-level object. If a caller could reach it, one room's edit
  // would change every later room cited from that preset, and #2 or #3 may well
  // edit a manifest (promoting a member is a verb pushed onto a role). Nothing in
  // src/ mutates a manifest today, so this is the only test that fails when the
  // clone in resolveManifest is dropped or made shallow. The mutation is deep on
  // purpose: a shallow copy shares the role objects, and a per-role copy still
  // shares each `can` array.
  it.each(PRESET_NAMES)("hands each %s room its own copy of the preset's roles", (name) => {
    const expected = structuredClone(resolveManifest({ room: "before", preset: name }).roles);

    const first = resolveManifest({ room: "first", preset: name });
    for (const def of Object.values(first.roles)) {
      def.can.push("audit");
      def.description = "poisoned";
    }
    first.roles.intruder = { can: ["close_room"], description: null };

    expect(resolveManifest({ room: "second", preset: name }).roles).toEqual(expected);
  });

  // Presets bypass the shape and the cross-field checks, so nothing else stops a
  // catalog typo — or a reserved name — from reaching the store.
  it.each(PRESET_NAMES)("%s only holds legal role keys, real verbs, and roles that exist", (name) => {
    const m = resolveManifest({ room: "r", preset: name });
    for (const [key, def] of Object.entries(m.roles)) {
      expect(RoleKeyShape.safeParse(key).success, `role key ${key}`).toBe(true);
      for (const verb of def.can) expect(VERBS).toContain(verb);
      expect(new Set(def.can).size, `duplicate verbs in ${key}`).toBe(def.can.length);
    }
    expect(Object.hasOwn(m.roles, m.defaultRole)).toBe(true);
    expect(Object.hasOwn(m.roles, m.creatorRole)).toBe(true);
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
  it("rejects an own __proto__ role key arriving over the wire", () => {
    // MUST be built with JSON.parse: it makes "__proto__" a real own key, which is
    // how it arrives over the wire. An object literal's `__proto__:` sets the
    // prototype and creates no key, so a literal-based test proves nothing.
    const hostile = JSON.parse('{"__proto__":{"can":["close_room"]},"helper":{"can":["send"]}}');
    const control = JSON.parse('{"helper":{"can":["send"]}}');
    const resolve = (roles: unknown) => () =>
      resolveManifest(authored({ roles, creator_role: "helper" }));
    expect(resolve(control)).not.toThrow();
    expect(resolve(hostile)).toThrow(ManifestError);
    expect(resolve(hostile)).toThrow(/^roles\.__proto__: role keys must not be one of/);
    expect(({} as Record<string, unknown>).can).toBeUndefined();
  });

  it.each(["constructor", "prototype"])("rejects %s as a role key", (name) => {
    // Both match the key regex and are real own keys even in an object literal, so
    // only the reserved-name ban stops them. They must never enter the store: #2/#3
    // look roles up by name, and roles[name] on a plain object finds inherited
    // properties (roles["constructor"] is the Object function).
    const resolve = () => resolveManifest(authored({
      roles: { [name]: { can: ["send"] }, helper: { can: ["send"] } },
      creator_role: "helper",
    }));
    expect(resolve).toThrow(ManifestError);
    expect(resolve).toThrow(new RegExp(`^roles\\.${name}: role keys must not be one of`));
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects %s in ManifestShape itself, so a tool schema built on it is safe too",
    (name) => {
      // z.record silently drops an own __proto__ key; the guard in RolesShape turns
      // that into a rejection. Without it, the MCP SDK (which parses arguments with
      // the shape before any handler runs) would hand resolveManifest a roles map
      // that had already lost the key.
      const wire = JSON.parse(
        '{"room":"r","mode":"pair","default_role":"helper","creator_role":"helper",'
        + `"roles":{"${name}":{"can":["close_room"]},"helper":{"can":["send"]}}}`,
      );
      expect(ManifestShape.safeParse(wire).success).toBe(false);
    },
  );

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

  it.each(["default_role", "creator_role"])(
    "caps %s at 31 characters, so an oversized value is never echoed into an error",
    (field) => {
      // Both are echoed verbatim by the cross-field errors, which reach tool errors
      // and the audit log. 31 is the longest string RoleKeyShape accepts.
      const oversized = "g".repeat(32);
      let message = "";
      try {
        resolveManifest(authored({ [field]: oversized }));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(new RegExp(`^${field}: `));
      expect(message).not.toContain(oversized);
    },
  );
});

describe("shape errors name the offending field", () => {
  // A bare z.union reports one opaque "Invalid input". Zod hoists the best arm's
  // own issues where it can, and ManifestShape's error hook covers the rest, so
  // every message says which field is wrong.
  it("authored arm: an unknown verb names the role and position", () => {
    expect(() => resolveManifest(authored({
      roles: { lead: { can: ["summon_kraken"] }, helper: { can: ["send"] } },
    }))).toThrow(/^roles\.lead\.can\.0: /);
  });

  it("authored arm: a missing mode names mode", () => {
    const { mode: _mode, ...withoutMode } = authored();
    expect(() => resolveManifest(withoutMode)).toThrow(/^mode: /);
  });

  it("authored arm: a bad role key names the key", () => {
    expect(() => resolveManifest(authored({
      roles: { Lead: { can: ["send"] }, helper: { can: ["send"] } },
      creator_role: "helper",
    }))).toThrow(/^roles\.Lead: role keys must match /);
  });

  it("cite arm: an over-long room names room", () => {
    expect(() => resolveManifest({ room: "x".repeat(81), preset: "pair" }))
      .toThrow(/^room: /);
  });

  it("cite arm: a non-string preset names preset", () => {
    expect(() => resolveManifest({ room: "r", preset: 3 } as never))
      .toThrow(/^preset: /);
  });

  it("citing a preset and authoring roles at once names the extra keys", () => {
    expect(() => resolveManifest({ ...authored(), preset: "pair" } as never))
      .toThrow(/Unrecognized keys?: .*"roles"/);
  });

  it("authored roles plus a null preset call the preset key unrecognized, not invalid", () => {
    // A valueless `preset:` in YAML parses to exactly null, so this is the error the
    // bridge produces for a real authoring mistake. The caller authored roles, so
    // listing the valid preset names would be wrong advice: the fix is to drop the
    // key. Do not parse with a hand-picked arm here — that is what said "preset:
    // Invalid option" — parse with the union and let zod pick the arm.
    for (const preset of [null, undefined]) {
      const attempt = () => resolveManifest({ ...authored(), preset } as never);
      expect(attempt, `preset: ${preset}`).toThrow(/^Unrecognized key: "preset"/);
      expect(attempt, `preset: ${preset}`).not.toThrow(/expected one of/);
    }
  });

  it("says what was wrong with input that is not an object", () => {
    expect(() => resolveManifest("pair")).toThrow(/expected object/);
  });

  // The MCP SDK validates tool arguments with ManifestShape BEFORE any handler
  // runs, and shows the caller only each issue's message plus its path. If the
  // union collapsed to "Invalid input" there, resolveManifest's clear messages
  // would never reach a real user.
  describe("on ManifestShape itself", () => {
    const shapeMessage = (input: unknown): string => {
      const r = ManifestShape.safeParse(input);
      if (r.success) throw new Error("expected ManifestShape to reject this input");
      return r.error.issues[0].message;
    };

    it("authored arm: names the role and position of an unknown verb", () => {
      expect(shapeMessage(authored({
        roles: { lead: { can: ["summon_kraken"] }, helper: { can: ["send"] } },
      }))).toMatch(/^roles\.lead\.can\.0: /);
    });

    it("cite arm: names preset", () => {
      expect(shapeMessage({ room: "r", preset: 3 })).toMatch(/^preset: /);
    });

    it("authored roles plus a null preset: the unrecognized key, not preset advice", () => {
      expect(shapeMessage({ ...authored(), preset: null })).toMatch(/^Unrecognized key: "preset"/);
    });

    it("authored arm: an oversized default_role names the field and is not echoed", () => {
      // Zod hoists this issue out of the union, so the field is in `path`; the SDK
      // renders "<message> at manifest.default_role".
      const r = ManifestShape.safeParse(authored({ default_role: "g".repeat(100) }));
      if (r.success) throw new Error("expected ManifestShape to reject this input");
      expect(r.error.issues[0].path).toEqual(["default_role"]);
      expect(r.error.issues[0].message).not.toContain("ggg");
    });

    it("names a reserved role key", () => {
      const wire = JSON.parse(
        '{"room":"r","mode":"pair","default_role":"helper","creator_role":"helper",'
        + '"roles":{"__proto__":{"can":[]},"helper":{"can":["send"]}}}',
      );
      expect(shapeMessage(wire)).toMatch(/^roles\.__proto__: role keys must not be one of/);
    });
  });

  it("treats a symbol role key as a ManifestError, not a crash", () => {
    // Programmatic callers only — JSON cannot carry a symbol key — but a validator
    // must never throw anything except its own error type.
    expect(() => resolveManifest(authored({
      roles: { helper: { can: ["send"] }, [Symbol("sneaky")]: { can: [] } },
      creator_role: "helper",
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

  it("accepts a 31-character default_role and creator_role, the same bound as a role key", () => {
    const name = `a${"b".repeat(30)}`; // 31 characters: the longest legal role key
    const m = resolveManifest(authored({
      roles: { [name]: { can: ["send"] } },
      default_role: name,
      creator_role: name,
    }));
    expect([m.defaultRole, m.creatorRole]).toEqual([name, name]);

    // The two bounds must agree: a 32-character role key is not a legal role.
    const tooLong = `${name}c`;
    expect(() => resolveManifest(authored({
      roles: { [tooLong]: { can: ["send"] } },
      default_role: tooLong,
      creator_role: tooLong,
    }))).toThrow(ManifestError);
  });

  it("bans reserved role names exactly, not by substring", () => {
    const m = resolveManifest(authored({
      roles: {
        lead: { can: ["send"] },
        constructors: { can: [] },
        prototype_a: { can: [] },
        proto: { can: [] },
      },
      default_role: "proto",
    }));
    expect(Object.keys(m.roles)).toEqual(["lead", "constructors", "prototype_a", "proto"]);
  });
});
