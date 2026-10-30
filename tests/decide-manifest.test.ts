/**
 * How a room declares consensus (ADR 0040, #403): the `vote` verb, a role's `veto`, and the `decide` block. Pure:
 * resolveManifest, checkPreset and roomPreview, no store. The electorate a store snapshots is in the store contract.
 */
import { describe, expect, it } from "vitest";
import { ManifestError, ManifestShape, resolveManifest } from "../src/manifest.js";
import { asManifest, checkPreset } from "../src/presets.js";
import { roomPreview } from "../src/projections.js";
import type { StoredSession } from "../src/stored-session.js";
import { member, session } from "./helpers/fixtures.js";

const authored = (over: Record<string, unknown> = {}) => ({
  room: "budget",
  mode: "swarm",
  roles: {
    maintainer: { can: ["send", "request_actions", "write_surface", "vote"] },
    security: { can: ["send", "vote"], veto: ["surface_proposal"] },
    guest: { can: ["send"] },
  },
  default_role: "guest",
  creator_role: "maintainer",
  decide: { surface_proposal: "majority" },
  ...over,
});
const refusal = (input: unknown): string => {
  try {
    resolveManifest(input);
  } catch (e) {
    if (e instanceof ManifestError) return e.message;
    throw e;
  }
  throw new Error("resolved");
};

describe("the decide block", () => {
  it("resolves the short form, the object form and the room's defaults", () => {
    expect(resolveManifest(authored()).decide).toEqual({ rules: { surface_proposal: { rule: "majority", quorum: null } }, expiresMs: null });
    expect(resolveManifest(authored({ decide: { surface_proposal: { rule: "supermajority", quorum: "60%" }, expires: "2h" } })).decide)
      .toEqual({ rules: { surface_proposal: { rule: "supermajority", quorum: 60 } }, expiresMs: 7_200_000 });
    // The room's quorum is folded into each kind that does not set its own, so the record needs no second lookup.
    expect(resolveManifest(authored({ decide: { surface_proposal: "unanimous", quorum: "100%" } })).decide!.rules)
      .toEqual({ surface_proposal: { rule: "unanimous", quorum: 100 } });
    expect(resolveManifest(authored({ decide: { surface_proposal: { rule: "majority", quorum: "1%" }, quorum: "50%" } })).decide!.rules)
      .toEqual({ surface_proposal: { rule: "majority", quorum: 1 } });
  });

  it("is accepted by bellman_start's own schema", () => {
    expect(ManifestShape.safeParse(authored({ decide: { surface_proposal: { rule: "majority", quorum: "60%" }, expires: "30m" } })).success).toBe(true);
  });

  it("refuses an unknown rule, naming the valid set", () => {
    expect(refusal(authored({ decide: { surface_proposal: "plurality" } })))
      .toBe('decide.surface_proposal: unknown rule "plurality" (valid: single, majority, supermajority, unanimous)');
    expect(refusal(authored({ decide: { surface_proposal: { rule: "most" } } })))
      .toBe('decide.surface_proposal: unknown rule "most" (valid: single, majority, supermajority, unanimous)');
  });

  it.each(["0%", "101%", "60", "-5%", "6.5%"])("refuses the quorum %s", (quorum) => {
    expect(refusal(authored({ decide: { surface_proposal: { rule: "majority", quorum } } })))
      .toBe(`decide.surface_proposal.quorum must be a percentage from 1% to 100% (got "${quorum}")`);
    expect(refusal(authored({ decide: { surface_proposal: "majority", quorum } })))
      .toBe(`decide.quorum must be a percentage from 1% to 100% (got "${quorum}")`);
  });

  it("refuses a quorum on single, and leaves single out of the room's default", () => {
    expect(refusal(authored({ decide: { surface_proposal: { rule: "single", quorum: "60%" } } })))
      .toBe("decide.surface_proposal: single takes no quorum: one approval decides it");
    expect(resolveManifest(authored({ decide: { surface_proposal: "single", quorum: "60%" } })).decide!.rules)
      .toEqual({ surface_proposal: { rule: "single", quorum: null } });
  });

  it("bounds expires to five minutes and seven days", () => {
    expect(resolveManifest(authored({ decide: { surface_proposal: "majority", expires: "7d" } })).decide!.expiresMs).toBe(604_800_000);
    expect(refusal(authored({ decide: { surface_proposal: "majority", expires: "4m" } })))
      .toBe('decide.expires must be between 5m and 7d (got "4m")');
  });

  it("has no relay field, and reserves require for phase 2", () => {
    expect(refusal(authored({ decide: { surface_proposal: "majority", relay: true } }))).toMatch(/^decide: Unrecognized key: "relay"/);
    expect(refusal(authored({ decide: { surface_proposal: { rule: "majority", relay: true } } }))).toMatch(/relay/);
    expect(refusal(authored({ decide: { surface_proposal: { rule: "majority", require: "dash_session" } } })))
      .toBe("decide.surface_proposal.require: dash_session is reserved for phase 2, and nothing enforces it yet; omit it");
  });

  it("refuses a kind no role can open", () => {
    const noRequester = authored({ roles: { maintainer: { can: ["send", "vote"] }, guest: { can: ["send"] } } });
    expect(refusal(noRequester)).toBe('decide.surface_proposal: no role holds "request_actions", the verb that opens one');
    // The kinds whose effects have not landed are not in the schema at all (#409, #410).
    for (const kind of ["data_grant", "primitive"]) {
      expect(refusal(authored({ decide: { [kind]: "majority" } }))).toBe(`decide: Unrecognized key: "${kind}"`);
    }
  });

  it("refuses a block no role can vote in", () => {
    const silent = authored({ roles: { maintainer: { can: ["send", "request_actions"] }, guest: { can: ["send"] } } });
    expect(refusal(silent)).toBe('decide: no role holds "vote", so no decision could ever be carried');
  });

  it("is absent from a room that declares none, and an empty block declares none", () => {
    const plain = resolveManifest({ ...authored(), roles: { maintainer: { can: ["send"] }, guest: { can: ["send"] } }, decide: undefined });
    expect("decide" in plain).toBe(false);
    expect(Object.values(plain.roles).some((r) => "veto" in r)).toBe(false);
    expect("decide" in resolveManifest({ ...authored(), roles: { maintainer: { can: ["send", "vote"] }, guest: { can: ["send"] } }, decide: {} })).toBe(false);
    expect("decide" in resolveManifest({ room: "r", preset: "topic" })).toBe(false);
  });
});

describe("vote and veto on a role", () => {
  it("records a role's veto, and only on the roles that name one", () => {
    const m = resolveManifest(authored());
    expect(m.roles.security).toMatchObject({ can: ["send", "vote"], veto: ["surface_proposal"] });
    expect("veto" in m.roles.maintainer).toBe(false);
  });

  it("refuses a veto on a role without vote, a repeated kind, and a kind decide does not declare", () => {
    const roles = (security: Record<string, unknown>) => authored({ roles: { ...authored().roles, security } });
    expect(refusal(roles({ can: ["send"], veto: ["surface_proposal"] })))
      .toBe('role "security" holds a veto but not the verb "vote" (it holds: send)');
    expect(refusal(roles({ can: ["send", "vote"], veto: ["surface_proposal", "surface_proposal"] })))
      .toBe("roles.security.veto: Too big: expected array to have <=1 items");
    const undeclared = authored({ decide: undefined, roles: { ...authored().roles, maintainer: { can: ["send", "vote"] } } });
    expect(refusal(undeclared)).toBe('role "security" vetoes surface_proposal, which decide does not declare');
    expect(refusal(roles({ can: ["send", "vote"], veto: ["budget"] }))).toMatch(/^roles\.security\.veto\.0: Invalid input/);
  });

  it("refuses vote on the role a public room's permanent code seats", () => {
    const open = authored({ public: true, roles: { ...authored().roles, guest: { can: ["send", "vote"] } } });
    expect(refusal(open)).toBe(
      'role "guest" holds the verb "vote", but it is this public room\'s default_role, which a permanent code seats for anyone with ' +
      "the link; give vote only to roles seated by invitation",
    );
    // A private room's default seat is reached only by a code that expires, so it may vote.
    expect(resolveManifest({ ...open, public: false }).roles.guest.can).toContain("vote");
    // And a public room may give vote to a seat no permanent code reaches.
    expect(resolveManifest(authored({ public: true })).roles.security.can).toContain("vote");
  });

  it("refuses vote on the host role, which holds exactly send", () => {
    const hosted = authored({
      roles: { ...authored().roles, host: { can: ["send", "vote"] } },
      host: { role: "host" }, heartbeat: "1h",
    });
    expect(refusal(hosted)).toBe('host role "host" must hold exactly the verb "send" (it holds: send, vote)');
  });

  it("is granted by no built-in preset", () => {
    for (const preset of ["pair", "swarm", "review", "social", "topic"]) {
      const m = resolveManifest({ room: "r", preset });
      expect(Object.values(m.roles).flatMap((r) => r.can), preset).not.toContain("vote");
    }
  });
});

describe("a saved preset", () => {
  it("keeps decide and veto, and starts the room it describes", () => {
    const { room: _room, ...body } = authored({ decide: { surface_proposal: { rule: "majority", quorum: "60%" }, expires: "1h" } });
    const check = checkPreset("council", body, 0);
    if (!check.ok) throw new Error(check.description);
    expect(check.preset.decide).toEqual({ surface_proposal: { rule: "majority", quorum: "60%" }, expires: "1h" });
    expect(check.preset.roles.security.veto).toEqual(["surface_proposal"]);
    expect("veto" in check.preset.roles.guest).toBe(false);
    const m = resolveManifest(asManifest(check.preset, "Q3 budget", null));
    expect(m.decide).toEqual({ rules: { surface_proposal: { rule: "majority", quorum: 60 } }, expiresMs: 3_600_000 });
    expect(m.roles.security.veto).toEqual(["surface_proposal"]);
  });

  it("is refused in the words resolveManifest uses", () => {
    const { room: _room, ...body } = authored({ decide: { surface_proposal: "plurality" } });
    expect(checkPreset("council", body, 0)).toMatchObject({ ok: false, description: expect.stringContaining('unknown rule "plurality"') });
  });
});

describe("the joiner's preview", () => {
  const preview = (manifest: ReturnType<typeof resolveManifest>, role: string) => {
    const creator = member({ memberId: "m_creator", roomRole: "maintainer", joinedAt: 0 });
    return roomPreview(session({ manifest, members: [creator] }) as unknown as StoredSession, role);
  };

  it("shows each kind's rule, the expiry, each role's veto and the viewer's vote", () => {
    const p = preview(resolveManifest(authored({ decide: { surface_proposal: { rule: "majority", quorum: "60%" }, expires: "1h" } })), "security");
    expect(p.your_verbs).toEqual(["send", "vote"]);
    expect(p.roles.security).toContain("vote");
    expect(p.decide).toEqual({ rules: { surface_proposal: { rule: "majority", quorum_percent: 60 } }, expires_seconds: 3600 });
    expect(p.veto).toEqual({ security: ["surface_proposal"] });
  });

  it("is byte for byte what it was for a room that declares no decide block", () => {
    const plain = { ...authored(), roles: { maintainer: { can: ["send"] }, guest: { can: ["send"] } }, decide: undefined };
    const p = preview(resolveManifest(plain), "guest");
    expect("decide" in p).toBe(false);
    expect("veto" in p).toBe(false);
    expect(Object.keys(p)).toEqual([
      "preset", "mode", "public", "public_name", "your_role", "your_verbs", "heartbeat_seconds", "housekeeping",
      "your_heartbeat_on", "creator_role", "roles", "heartbeat_on", "host", "text",
    ]);
  });
});
