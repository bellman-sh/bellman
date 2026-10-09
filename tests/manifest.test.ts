/**
 * resolveManifest is pure — no store, no identity, no clock. Every rule the
 * server relies on is proved here, so the tool tests can assume a valid manifest.
 */
import { describe, it, expect } from "vitest";
import {
  resolveManifest, ManifestError, ManifestShape, PRESET_NAMES, RoleKeyShape, VERBS,
  MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS, MIN_HOUSEKEEPING_MS, MAX_HOUSEKEEPING_MS, builtinPresets,
} from "../src/manifest.js";
import * as manifestModule from "../src/manifest.js";
import type { PresetName } from "../src/types.js";

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
    expect(m.roles.peer_a.can).toEqual(expect.arrayContaining(["invite", "revoke"]));
    expect(m.roles.peer_b.can).not.toContain("invite");
    expect(m.roles.peer_b.can).not.toContain("revoke");
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
      .toThrow(/pair, swarm, review, social/);
  });

  it("records preset as null when roles are authored", () => {
    expect(resolveManifest(authored()).preset).toBeNull();
  });

  // PRESETS is a module-level object, private to manifest.ts, so what a caller can
  // reach is the copies resolveManifest hands out. If a copy shared anything with
  // it, one room's edit would change every later room cited from that preset, and
  // #2 or #3 may well edit a manifest (promoting a member is a verb pushed onto a
  // role). Nothing in src/ mutates a manifest today, so this is the only test that
  // fails when the clone in resolveManifest is dropped or made shallow. The
  // mutation is deep on purpose: a shallow copy shares the role objects, and a
  // per-role copy still shares each `can` array.
  it.each(PRESET_NAMES)("hands each %s room its own copy of the preset's roles", (name) => {
    const expected = structuredClone(resolveManifest({ room: "before", preset: name }).roles);

    const first = resolveManifest({ room: "first", preset: name });
    for (const def of Object.values(first.roles)) {
      def.can.push("revoke");
      def.description = "poisoned";
    }
    first.roles.intruder = { can: ["revoke"], description: null, reports: false };

    expect(resolveManifest({ room: "second", preset: name }).roles).toEqual(expected);
  });

  // The other way in is the module's own exports, and the test above cannot see it: it only
  // mutates the copies. Exported, the catalog's nested `can` arrays are open to any importer,
  // each of whom could change every later resolution. Nothing imports it, so it stays private;
  // this is what keeps it so. (A re-export under another name is beyond a name check, which is
  // why the catalog should not be handed out at all.)
  it("keeps the preset catalog out of the module's exports", () => {
    expect(Object.keys(manifestModule)).not.toContain("PRESETS");
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

  // The catalog is a decision, so it is written out. The verbs each role holds are what a joiner's
  // human reads before agreeing to a room, and the design's preset tables say the same; a verb that
  // leaves or joins a role should show up as an edit to this table, not only to the catalog.
  const catalog: Record<PresetName, Record<string, string[]>> = {
    pair: {
      peer_a: ["send", "request_actions", "respond_actions", "invite", "revoke", "write_surface"],
      peer_b: ["send", "request_actions", "respond_actions"],
    },
    swarm: {
      lead: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
      helper: ["send", "request_actions", "respond_actions"],
      observer: [],
    },
    review: {
      author: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
      reviewer: ["send", "respond_actions"],
    },
    social: {
      lead: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
      guest: ["send"],
      host: ["send"],
    },
  };
  it.each(PRESET_NAMES)("%s holds the verbs the design's table gives it, and no other roles", (name) => {
    const sorted = (verbs: readonly string[]) => [...verbs].sort();
    const held = Object.fromEntries(
      Object.entries(resolveManifest({ room: "r", preset: name }).roles).map(([key, def]) => [key, sorted(def.can)]),
    );
    const expected = Object.fromEntries(
      Object.entries(catalog[name]).map(([key, verbs]) => [key, sorted(verbs)]),
    );
    expect(held).toEqual(expected);
  });
});

describe("the verb enum", () => {
  // The enum is closed so that every verb a connect preview shows maps to a guard that can exist.
  // `audit` and `close_room` were in it once and are not now, because neither names an operation
  // that exists room-scoped: bellman_audit takes no session, so it is org-wide and no room role can
  // gate it, and no tool closes a room on a member's say-so (a room ends when its last member
  // leaves). Each verb returns in the PR that adds its operation, and this list changes in that
  // PR, not before.
  it("holds exactly the six verbs whose operations exist room-scoped", () => {
    expect([...VERBS]).toEqual([
      "send", "invite", "revoke", "request_actions", "respond_actions", "write_surface",
    ]);
  });

  it.each(["audit", "close_room"])("rejects %s from a role, and from the tool's own schema", (verb) => {
    const input = authored({ roles: { lead: { can: ["send", verb] }, helper: { can: ["send"] } } });
    expect(() => resolveManifest(input)).toThrow(/^roles\.lead\.can\.1: Invalid option: expected one of/);
    expect(ManifestShape.safeParse(input).success).toBe(false);
  });

  // A preset's words about a role reach the joiner beside the verbs it holds, so they cannot name an
  // operation the enum lacks either: "runs the room: invites, audits, closes" told them what no verb
  // could. The pattern is the two removed verbs' stems; a verb that returns takes its stem out of it.
  it.each(PRESET_NAMES)("%s's role descriptions do not describe a removed verb", (name) => {
    for (const [key, def] of Object.entries(resolveManifest({ room: "r", preset: name }).roles)) {
      expect(def.description ?? "", key).not.toMatch(/\baudit|\bclose/i);
    }
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

  /**
   * A seat that may not speak may not report either: `SEND_VERB.progress` is
   * `send`, deliberately. A manifest that asks a verbless seat for reports shows
   * that seat an obligation, lists it in every heartbeat snapshot, and then
   * refuses the one reply that would answer it. Refused where it is authored,
   * because there is no runtime state that makes it work.
   */
  it("rejects reports: true on a role that cannot send", () => {
    expect(() => resolveManifest(authored({
      roles: { lead: { can: ["send"] }, helper: { can: ["invite"], reports: true } },
    }))).toThrow(
      /role "helper" sets reports: true but does not hold the verb "send" \(it holds: invite\)/,
    );
  });

  /**
   * The cadence is the room's and `reports` is the seat's, and the contradiction
   * is in the seat alone. A room with no `heartbeat_on` never ticks, so this
   * manifest asks nothing of anybody — but it is still unanswerable the day a
   * cadence is added, and the author is here now.
   */
  it("rejects it with no cadence too, since the seat is what cannot answer", () => {
    expect(() => resolveManifest({
      room: "r",
      mode: "swarm",
      roles: { lead: { can: ["send"] }, watcher: { can: [], reports: true } },
      default_role: "watcher",
      creator_role: "lead",
    })).toThrow(/role "watcher" sets reports: true but does not hold the verb "send" \(it holds: none\)/);
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
    const hostile = JSON.parse('{"__proto__":{"can":["invite"]},"helper":{"can":["send"]}}');
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
      const wire = (key: string) => JSON.parse(
        '{"room":"r","mode":"pair","default_role":"helper","creator_role":"helper",'
        + `"roles":{"${key}":{"can":["invite"]},"helper":{"can":["send"]}}}`,
      );
      // The same payload under a legal key is valid, so the key is the only thing that can
      // be rejecting the other. Without this control, a role definition that was itself
      // invalid (a verb the enum no longer holds, say) would make the test pass for nothing.
      expect(ManifestShape.safeParse(wire("lead")).success).toBe(true);
      expect(ManifestShape.safeParse(wire(name)).success).toBe(false);
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

describe("heartbeat_on", () => {
  const authored = (over: Record<string, unknown> = {}) => ({
    room: "migration-swarm",
    mode: "swarm",
    roles: {
      lead: { can: ["send", "invite"], reports: true },
      observer: { can: [] },
    },
    default_role: "observer",
    creator_role: "lead",
    ...over,
  });

  it("parses s, m and h to milliseconds", () => {
    expect(resolveManifest(authored({ heartbeat_on: "30s" })).heartbeatOnMs).toBe(30_000);
    expect(resolveManifest(authored({ heartbeat_on: "5m" })).heartbeatOnMs).toBe(300_000);
    expect(resolveManifest(authored({ heartbeat_on: "1h" })).heartbeatOnMs).toBe(3_600_000);
  });

  it("defaults to no cadence, and to a role that is not asked", () => {
    const m = resolveManifest(authored());
    expect(m.heartbeatOnMs).toBe(null);
    expect(m.roles.observer.reports).toBe(false);
    expect(m.roles.lead.reports).toBe(true);
  });

  it("expects nothing of any preset role", () => {
    for (const preset of ["pair", "swarm", "review"] as const) {
      const m = resolveManifest({ room: "r", preset });
      expect(m.heartbeatOnMs).toBe(null);
      for (const def of Object.values(m.roles)) expect(def.reports).toBe(false);
    }
  });

  // Review Focus 5 — the raw value reaches a tool error and the audit log.
  it.each(["5 minutes", "0m", "99h", "-5m", "", "5", "m", "5M"])(
    "refuses %o with a message naming the shape",
    (bad) => {
      const attempt = () => resolveManifest(authored({ heartbeat_on: bad }));
      expect(attempt).toThrow(ManifestError);
      // Pin the field, so a refusal for some other reason cannot satisfy this.
      expect(attempt).toThrow(/^heartbeat_on/);
    },
  );

  it("refuses a duration outside the bounds, naming them", () => {
    expect(() => resolveManifest(authored({ heartbeat_on: "10s" })))
      .toThrow(/between 30s and 1d/);
    expect(() => resolveManifest(authored({ heartbeat_on: "25h" })))
      .toThrow(/between 30s and 1d/);
    expect(MIN_HEARTBEAT_MS).toBe(30_000);
    expect(MAX_HEARTBEAT_MS).toBe(86_400_000);
  });

  /**
   * The two assertions above pin the message's literal text, which is exactly
   * what lets a bound change leave it lying: move MAX_HEARTBEAT_MS to 30m and a
   * hardcoded "1h" keeps the regex above satisfied while telling every caller a
   * bound that no longer exists.
   *
   * So this reads the bounds back OUT of the message and makes the parser judge
   * them. Rendered from the constants, each one is a duration the parser accepts
   * and resolves to the constant it came from; hardcoded, the first bound change
   * breaks one of these two lines.
   */
  it("names bounds the parser itself accepts, so the message cannot outlive them", () => {
    let message = "";
    try {
      resolveManifest(authored({ heartbeat_on: "10s" }));
    } catch (e) {
      message = (e as Error).message;
    }
    const named = /between (\S+) and (\S+) /.exec(message);
    expect(named, message).not.toBe(null);
    const [, low, high] = named!;

    expect(resolveManifest(authored({ heartbeat_on: low })).heartbeatOnMs)
      .toBe(MIN_HEARTBEAT_MS);
    expect(resolveManifest(authored({ heartbeat_on: high })).heartbeatOnMs)
      .toBe(MAX_HEARTBEAT_MS);
  });

  it("bounds the echoed value so a long string cannot reach the audit log", () => {
    let message = "";
    try {
      resolveManifest(authored({ heartbeat_on: "9".repeat(500) + "m" }));
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      message = (e as Error).message;
    }
    // Without the shape's bound, parseHeartbeatOn refuses this too — and echoes all
    // 501 characters. Throwing is not enough; what the message carries is the claim.
    expect(message).toMatch(/^heartbeat_on: /);
    expect(message).not.toContain("9999");
  });
});

describe("housekeeping (#66)", () => {
  const FIELDS = ["quiet_after", "answer_within", "idle_after", "repeat_after"] as const;

  const withHousekeeping = (housekeeping: unknown) => authored({ housekeeping });

  /**
   * The message a refused manifest throws, whole. These tests pin the sentence an
   * author reads, not a fragment of it that some other refusal could also contain.
   */
  const refusal = (manifest: unknown): string => {
    try {
      resolveManifest(manifest);
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      return (e as Error).message;
    }
    throw new Error("expected resolveManifest to refuse this manifest");
  };

  it("resolves an authored manifest's thresholds to milliseconds", () => {
    const m = resolveManifest(withHousekeeping({ quiet_after: "2h", answer_within: "30m", idle_after: "1d" }));
    expect(m.housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null,
    });
  });

  it("resolves a cited preset's housekeeping too, and still expands the preset", () => {
    const m = resolveManifest({ room: "r", preset: "swarm", housekeeping: { quiet_after: "2h" } });
    expect(m.preset).toBe("swarm");
    expect(m.roles.lead).toBeDefined();
    expect(m.housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: null, idleAfterMs: null, repeatAfterMs: null,
    });
  });

  it("is null when the manifest does not mention it, and for every preset in the catalog", () => {
    expect(resolveManifest(authored()).housekeeping).toBeNull();
    for (const preset of PRESET_NAMES) {
      expect(resolveManifest({ room: "r", preset }).housekeeping, preset).toBeNull();
    }
  });

  // The catalog has a second face: the listing the panel shows and clones (designer D5).
  // A built-in that carried a block there would start rooms that name members quiet for
  // everyone who cloned it, which is why no preset sets one (D5).
  it("is null in the saved-preset form of every built-in too", () => {
    const listed = builtinPresets();
    expect(listed.map((p) => p.name)).toEqual([...PRESET_NAMES]);
    for (const p of listed) expect(p.housekeeping, p.name).toBeNull();
  });

  // An empty object disables every finding exactly as an absent one does. Both are null,
  // so the rules and the stored row have one representation of "off" to read.
  it("is null for an empty object and for an explicit null", () => {
    expect(resolveManifest(withHousekeeping({})).housekeeping).toBeNull();
    expect(resolveManifest(withHousekeeping(null)).housekeeping).toBeNull();
  });

  it("is null when only repeat_after is given, because there is no finding to repeat", () => {
    expect(resolveManifest(withHousekeeping({ repeat_after: "1h" })).housekeeping).toBeNull();
  });

  it("still refuses a bad repeat_after when it stands alone", () => {
    expect(refusal(withHousekeeping({ repeat_after: "soon" })))
      .toBe('housekeeping.repeat_after must be a duration like "30s", "5m", "1h" or "2d" (got "soon")');
  });

  // Review Focus 4: repeating faster than the threshold is a choice, not a mistake.
  it("accepts a repeat_after shorter than the threshold it repeats", () => {
    const m = resolveManifest(withHousekeeping({ quiet_after: "2h", repeat_after: "5m" }));
    expect(m.housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: null, idleAfterMs: null, repeatAfterMs: 300_000,
    });
  });

  // A valueless `idle_after:` in YAML is null. heartbeat_on reads that as off, and an
  // author who comments a value out leaves exactly that behind.
  it("reads a valueless key as off, as heartbeat_on does", () => {
    const m = resolveManifest(withHousekeeping({ quiet_after: "2h", idle_after: null }));
    expect(m.housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: null, idleAfterMs: null, repeatAfterMs: null,
    });
  });

  it("is declared beside heartbeat_on without either changing the other", () => {
    const m = resolveManifest(authored({ heartbeat_on: "5m", housekeeping: { idle_after: "1d" } }));
    expect(m.heartbeatOnMs).toBe(300_000);
    expect(m.housekeeping?.idleAfterMs).toBe(86_400_000);
  });

  it("refuses a key it does not know, so a misspelt threshold is not silently off", () => {
    expect(refusal(withHousekeeping({ quiet_after: "2h", quite_after: "1h" })))
      .toMatch(/Unrecognized key.*quite_after/);
  });

  describe("the bounds", () => {
    it("names the floor and the ceiling in the notation the author writes", () => {
      expect(refusal(withHousekeeping({ quiet_after: "1m" })))
        .toBe('housekeeping.quiet_after must be between 5m and 7d (got "1m")');
      expect(refusal(withHousekeeping({ idle_after: "8d" })))
        .toBe('housekeeping.idle_after must be between 5m and 7d (got "8d")');
    });

    // Each key goes through the one parser with the one pair of bounds. The two cases
    // above would pass for a key wired to other bounds, or to none.
    const outside = FIELDS.flatMap((field) => ["1m", "8d"].map((raw) => [field, raw] as [string, string]));
    it.each(outside)("refuses %s at %s", (field, raw) => {
      expect(refusal(withHousekeeping({ [field]: raw })))
        .toBe(`housekeeping.${field} must be between 5m and 7d (got "${raw}")`);
    });

    it("holds the constants the messages are rendered from", () => {
      expect(MIN_HOUSEKEEPING_MS).toBe(300_000);
      expect(MAX_HOUSEKEEPING_MS).toBe(604_800_000);
    });

    it("accepts the floor and the ceiling exactly, in any unit that reaches them", () => {
      const cases: Array<[string, number]> = [
        ["5m", MIN_HOUSEKEEPING_MS], ["300s", MIN_HOUSEKEEPING_MS],
        ["7d", MAX_HOUSEKEEPING_MS], ["168h", MAX_HOUSEKEEPING_MS],
      ];
      for (const [raw, ms] of cases) {
        expect(resolveManifest(withHousekeeping({ quiet_after: raw })).housekeeping?.quietAfterMs, raw).toBe(ms);
      }
    });

    it("refuses a step past either", () => {
      for (const raw of ["299s", "4m", "169h", "8d"]) {
        expect(refusal(withHousekeeping({ quiet_after: raw })), raw).toMatch(/must be between 5m and 7d/);
      }
    });

    // The same argument as heartbeat_on's: pinning the literal text lets a bound change
    // leave the message lying, so read the bounds back OUT of it and let the parser judge.
    it("names bounds the parser itself accepts, so the message cannot outlive them", () => {
      const named = /between (\S+) and (\S+) /.exec(refusal(withHousekeeping({ quiet_after: "1m" })));
      expect(named).not.toBeNull();
      const [, low, high] = named!;
      expect(resolveManifest(withHousekeeping({ quiet_after: low })).housekeeping?.quietAfterMs)
        .toBe(MIN_HOUSEKEEPING_MS);
      expect(resolveManifest(withHousekeeping({ quiet_after: high })).housekeeping?.quietAfterMs)
        .toBe(MAX_HOUSEKEEPING_MS);
    });
  });

  describe("the form", () => {
    it("names the form, with days among the examples", () => {
      expect(refusal(withHousekeeping({ quiet_after: "soon" })))
        .toBe('housekeeping.quiet_after must be a duration like "30s", "5m", "1h" or "2d" (got "soon")');
    });

    // Eight characters at most: anything longer is refused by the shape before the parser
    // sees it, which the test after this one covers.
    it.each(["5 min", "", "5", "m", "5M", "-5m", "1.5h"])("refuses %o as a shape, not a bound", (raw) => {
      expect(refusal(withHousekeeping({ answer_within: raw })))
        .toMatch(/^housekeeping\.answer_within must be a duration like /);
    });

    it("bounds the echoed value so a long string cannot reach the audit log", () => {
      const message = refusal(withHousekeeping({ quiet_after: "9".repeat(500) + "m" }));
      expect(message).toMatch(/^housekeeping\.quiet_after: /);
      expect(message).not.toContain("9999");
    });
  });

  // The parser is shared, and a day is now a unit it reads. heartbeat_on must not move.
  describe("the parser it shares with heartbeat_on", () => {
    it("leaves heartbeat_on's shape message as it was, without days among the examples", () => {
      expect(refusal(authored({ heartbeat_on: "soon" })))
        .toBe('heartbeat_on must be a duration like "30s", "5m" or "1h" (got "soon")');
    });

    // The hosted seat raised heartbeat_on's ceiling to a day (hosted seat spec, D3), so a day is
    // legal for it and two are not. The message renders the bound in the largest unit that divides it.
    it("refuses 2d by heartbeat_on's own ceiling, not housekeeping's week", () => {
      expect(refusal(authored({ heartbeat_on: "2d" })))
        .toBe('heartbeat_on must be between 30s and 1d (got "2d")');
    });
  });
});

describe("a hosted seat in the manifest (hosted seat spec, D1)", () => {
  const hosted = (over: Record<string, unknown> = {}) => authored({
    mode: "swarm",
    heartbeat_on: "1h",
    roles: {
      lead: { can: ["send", "invite", "revoke"] },
      guest: { can: ["send"] },
      host: { can: ["send"] },
    },
    default_role: "guest",
    creator_role: "lead",
    host: { role: "host", model: "haiku", instructions: "Ask about the week." },
    ...over,
  });

  it("resolves a host block with its model and instructions", () => {
    const m = resolveManifest(hosted());
    expect(m.host).toEqual({ role: "host", model: "haiku", instructions: "Ask about the week." });
  });

  it("defaults the model to haiku and the instructions to null", () => {
    const m = resolveManifest(hosted({ host: { role: "host" } }));
    expect(m.host).toEqual({ role: "host", model: "haiku", instructions: null });
  });

  it("resolves to no host when the block is absent", () => {
    expect(resolveManifest(hosted({ host: undefined })).host).toBeNull();
  });

  it("refuses a host role the manifest does not declare, listing the ones it does", () => {
    expect(() => resolveManifest(hosted({ host: { role: "butler" } })))
      .toThrow(/host\.role "butler" is not defined in roles \(defined: lead, guest, host\)/);
  });

  it("refuses a host role that holds any verb but send", () => {
    expect(() => resolveManifest(hosted({ roles: {
      lead: { can: ["send", "invite", "revoke"] }, guest: { can: ["send"] }, host: { can: ["send", "invite"] },
    } }))).toThrow(/host role "host" must hold exactly the verb "send" \(it holds: send, invite\)/);
    expect(() => resolveManifest(hosted({ roles: {
      lead: { can: ["send", "invite", "revoke"] }, guest: { can: ["send"] }, host: { can: [] },
    } }))).toThrow(/host role "host" must hold exactly the verb "send" \(it holds: none\)/);
  });

  it("refuses a host role that reports", () => {
    expect(() => resolveManifest(hosted({ roles: {
      lead: { can: ["send", "invite", "revoke"] }, guest: { can: ["send"] }, host: { can: ["send"], reports: true },
    } }))).toThrow(/host role "host" must not report/);
  });

  it("refuses a model it does not know, listing the names", () => {
    expect(() => resolveManifest(hosted({ host: { role: "host", model: "gpt" } })))
      .toThrow(/host\.model/);
  });

  it("refuses a host with no heartbeat, and one faster than an hour", () => {
    expect(() => resolveManifest(hosted({ heartbeat_on: undefined })))
      .toThrow(/a room with a host must set heartbeat_on \(at least 1h\)/);
    expect(() => resolveManifest(hosted({ heartbeat_on: "30m" })))
      .toThrow(/a room with a host must tick no faster than 1h \(got "30m"\)/);
  });

  it("refuses a host in a pair room", () => {
    expect(() => resolveManifest(hosted({ mode: "pair", roles: {
      lead: { can: ["send"] }, host: { can: ["send"] },
    }, default_role: "lead" }))).toThrow(/a pair room cannot have a host: its two seats are its members'/);
  });

  it("bounds the instructions like purpose", () => {
    expect(() => resolveManifest(hosted({ host: { role: "host", instructions: "x".repeat(301) } })))
      .toThrow(/host\.instructions/);
  });

  it("allows a daily beat now that a host can be slow", () => {
    expect(resolveManifest(hosted({ heartbeat_on: "24h" })).heartbeatOnMs).toBe(86_400_000);
    expect(() => resolveManifest(authored({ heartbeat_on: "25h" }))).toThrow(/between 30s and 1d/);
    expect(MAX_HEARTBEAT_MS).toBe(86_400_000);
  });

  it("expands the social preset with a host, an hourly beat, and guests who can only send", () => {
    const m = resolveManifest({ room: "the square", purpose: "What people are building this week", preset: "social" });
    expect(m.mode).toBe("swarm");
    expect(m.heartbeatOnMs).toBe(3_600_000);
    expect(m.host).toEqual({ role: "host", model: "haiku", instructions: null });
    expect(m.roles.host.can).toEqual(["send"]);
    expect(m.roles.guest.can).toEqual(["send"]);
    expect(m.defaultRole).toBe("guest");
    expect(m.creatorRole).toBe("lead");
  });

  it("lets a social cite slow the beat but not speed it past the floor", () => {
    expect(resolveManifest({ room: "r", preset: "social", heartbeat_on: "6h" }).heartbeatOnMs).toBe(21_600_000);
    expect(() => resolveManifest({ room: "r", preset: "social", heartbeat_on: "5m" }))
      .toThrow(/a room with a host must tick no faster than 1h/);
  });

  // M8: main's strict cite refused the key; a preset with no host has nothing to tick for.
  it.each(["pair", "swarm", "review"])("refuses heartbeat_on on a cite of %s, a preset with no host", (preset) => {
    expect(() => resolveManifest({ room: "r", preset, heartbeat_on: "5m" } as never)).toThrow(/heartbeat_on/);
    expect(() => resolveManifest({ room: "r", preset, heartbeat_on: null } as never)).toThrow(/heartbeat_on/);
    expect(resolveManifest({ room: "r", preset } as never).heartbeatOnMs).toBeNull();
  });

  it("gives the other presets no host and, as before, no beat", () => {
    expect(resolveManifest({ room: "r", preset: "pair" }).host).toBeNull();
    expect(resolveManifest({ room: "r", preset: "pair" }).heartbeatOnMs).toBeNull();
  });

  // `host` is an object in the private catalog, as `roles` is, so it leaves the module cloned too:
  // an edit to one room's host must not reach the next room cited from the same preset.
  it("hands each social room its own host, not the catalog's", () => {
    const first = resolveManifest({ room: "first", preset: "social" });
    first.host!.model = "opus";
    first.host!.instructions = "poisoned";
    expect(resolveManifest({ room: "second", preset: "social" }).host)
      .toEqual({ role: "host", model: "haiku", instructions: null });
  });
});
