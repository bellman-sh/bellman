/**
 * skills/room-manifest/SKILL.md is the authoring guide a Claude Code session loads when
 * someone asks for a .bellman/room.yaml. It restates the closed verb set, the preset
 * catalog and the server's validation rules — all of which live in src/manifest.ts, and
 * all of which will change. A guide that drifts is worse than no guide: it tells a model
 * to write a manifest the server then rejects, confidently.
 *
 * So nothing here checks prose. Every assertion ties a sentence in the skill to the value
 * it claims, and the yaml examples are run through the real resolver rather than read.
 * Sibling of tests/extension.test.ts, which does the same for the Desktop bundle's
 * hand-written tool list.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { MAX_ROLE_KEY_LENGTH, PRESET_NAMES, VERBS, resolveManifest } from "../src/manifest.js";

const SKILL = readFileSync(
  new URL("../skills/room-manifest/SKILL.md", import.meta.url),
  "utf8"
);

const plugin: { version: string } = JSON.parse(
  readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")
);

const pkg: { version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

/** Every ```yaml block in the skill, in order. */
function yamlExamples(): string[] {
  return [...SKILL.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * The slice of the skill describing one preset: from its bold heading to the next bold
 * heading or section, whichever comes first. Scoping the role table this way is what
 * lets the per-preset assertions below fail when a role moves between presets, rather
 * than passing because the name appears somewhere in the file.
 */
function presetSection(preset: string): string {
  const start = SKILL.indexOf(`**\`${preset}\`**`);
  expect(start, `no section for preset "${preset}"`).toBeGreaterThan(-1);
  const rest = SKILL.slice(start + 1);
  const end = rest.search(/\n\*\*`|\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Role keys named in a markdown table's first column, as `key`. */
function tabulatedRoles(section: string): string[] {
  return [...section.matchAll(/^\| `([a-z_][a-z0-9_]*)` \|/gm)].map((m) => m[1]);
}

/** The row describing one role, from a preset's table. */
function roleRow(section: string, key: string): string | undefined {
  return section.split("\n").find((line) => line.startsWith(`| \`${key}\` |`));
}

describe("the room-manifest skill's frontmatter", () => {
  it("declares the name the plugin loads it under", () => {
    expect(SKILL).toMatch(/^---\n(?:.*\n)*?name: room-manifest\n/);
  });

  // The description is the only part always in context, so it is the whole triggering
  // mechanism. Each of these is a phrase someone uses while meaning "room.yaml" without
  // saying it; a rewrite that drops them makes the skill invisible, silently.
  it("names the surfaces that should trigger it", () => {
    const description = /\ndescription: (.*)\n/.exec(SKILL)?.[1] ?? "";
    for (const cue of ["room.yaml", ".bellman", "bellman_start", "preset", "verbs"]) {
      expect(description, cue).toContain(cue);
    }
  });
});

describe("what the skill says about verbs", () => {
  it("documents every verb the server accepts", () => {
    for (const verb of VERBS) {
      expect(SKILL, verb).toContain(`\`${verb}\``);
    }
  });

  // The count as an assertion, not prose. A verb added to VERBS without a row here
  // leaves the skill quietly teaching an incomplete set.
  it("tabulates each verb exactly once", () => {
    const tabulated = [...SKILL.matchAll(/^\| `([a-z_]+)` \| [^|]*\|$/gm)]
      .map((m) => m[1])
      .filter((name) => (VERBS as readonly string[]).includes(name));
    expect(tabulated.sort()).toEqual([...VERBS].sort());
  });

  // resolveManifest rejects both, and the skill says so. If either ever becomes a verb,
  // this fails and the paragraph explaining their absence has to go with it.
  it("is right that audit and close_room are not verbs", () => {
    expect(VERBS as readonly string[]).not.toContain("audit");
    expect(VERBS as readonly string[]).not.toContain("close_room");
    expect(SKILL).toContain("There is no `audit` verb and no `close_room` verb");
  });
});

describe("what the skill says about presets", () => {
  it("documents every preset the server offers, and no others", () => {
    const documented = [...SKILL.matchAll(/^\*\*`([a-z]+)`\*\* — mode/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...PRESET_NAMES].sort());
  });

  for (const preset of PRESET_NAMES) {
    describe(`the ${preset} preset`, () => {
      const resolved = resolveManifest({ room: "t", preset });
      const section = presetSection(preset);

      it("lists exactly the roles the preset expands to", () => {
        expect(tabulatedRoles(section).sort()).toEqual(Object.keys(resolved.roles).sort());
      });

      it("states the mode the preset carries", () => {
        expect(section).toContain(`mode \`${resolved.mode}\``);
      });

      it("gives each role every verb it actually holds", () => {
        for (const [key, def] of Object.entries(resolved.roles)) {
          const row = roleRow(section, key);
          expect(row, `no row for role "${key}"`).toBeDefined();
          for (const verb of def.can) {
            expect(row, `${key} holds ${verb}`).toContain(verb);
          }
          // A role with no verbs must not be shown holding one.
          if (def.can.length === 0) {
            for (const verb of VERBS) expect(row, `${key} holds nothing`).not.toContain(verb);
          }
        }
      });

      it("marks the creator and default seats", () => {
        expect(roleRow(section, resolved.creatorRole)).toContain("creator");
        expect(roleRow(section, resolved.defaultRole)).toContain("default");
      });
    });
  }
});

describe("the skill's yaml examples", () => {
  const examples = yamlExamples();

  it("has examples to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
  });

  // The point of the file. An example that no longer resolves is a model being taught to
  // write a manifest the server rejects.
  it.each(examples.map((src, i) => [i, src] as const))(
    "example %i resolves against the real manifest shape",
    (_i, src) => {
      expect(() => resolveManifest(parseYaml(src))).not.toThrow();
    }
  );

  it("shows both input arms: one citing a preset, one authoring roles", () => {
    const cited = examples.map((src) => resolveManifest(parseYaml(src)).preset !== null);
    expect(cited).toContain(true);
    expect(cited).toContain(false);
  });
});

describe("the limits the skill quotes", () => {
  it("quotes the real role-key shape", () => {
    expect(SKILL).toContain(`[a-z][a-z0-9_]{0,${MAX_ROLE_KEY_LENGTH - 1}}`);
    expect(SKILL).toContain(`${MAX_ROLE_KEY_LENGTH} characters max`);
  });

  it("quotes the real role ceiling", () => {
    // MAX_ROLES is not exported. Resolve a manifest well over it and read the ceiling out
    // of the error, which is the same sentence an author would see.
    const roles = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`r${i}`, { can: [] }])
    );
    let ceiling = "";
    try {
      resolveManifest({
        room: "t", mode: "swarm", roles, default_role: "r0", creator_role: "r0",
      });
    } catch (e) {
      ceiling = /at most (\d+) roles/.exec((e as Error).message)?.[1] ?? "";
    }
    expect(ceiling, "the roles ceiling is no longer reported in that wording").not.toBe("");
    expect(SKILL).toContain(`at most **${ceiling}**`);
  });

  it("quotes the reserved role keys the server refuses", () => {
    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      expect(SKILL, reserved).toContain(`\`${reserved}\``);
      expect(() =>
        resolveManifest({
          room: "t",
          mode: "pair",
          roles: { [reserved]: { can: [] }, ok: { can: [] } },
          default_role: "ok",
          creator_role: "ok",
        }),
        reserved
      ).toThrow();
    }
  });
});

describe("the plugin manifest", () => {
  it("carries the package's version", () => {
    expect(plugin.version).toBe(pkg.version);
  });
});
