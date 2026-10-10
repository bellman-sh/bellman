# The heartbeat's vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors write the room's frequency as `heartbeat` and each role's place on it as `heartbeat_on` (true, false, or what it reports); the old words keep working, the outputs speak the new ones, and dash's designer replaces the held dash#25.

**Architecture:** The manifest shapes accept both spellings. Two pure readers, `roomBeat` and `roleBeat`, turn either into today's model (`heartbeatOnMs`, `reports`, `report`) and refuse one thing spelled twice. Refusals name the word their author wrote. Saved presets are stored and served in the new words, with old rows translated on read. The join preview's four fields are renamed, the tick is unchanged, and dash writes only the new words.

**Tech Stack:** TypeScript, zod 4, vitest (Node and workerd); the MCP App (`ui/`); dash: React 19, vitest with Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-09-heartbeat-vocabulary-design.md`

## Rulings against the spec

- **R1. An instruction's 300-character bound is on the string as written**, which zod reports with its path (`roles.<key>.heartbeat_on: …`). A padded string over 300 that would trim to fewer is refused. Cost if wrong: an author trims by hand.
- **R2. "The words the author wrote" for a rule about the frequency, when the author wrote neither spelling:** the new word if the manifest uses any new word (`heartbeat`, or any role's `heartbeat_on`), else today's. Manifests in the old words, and every test that pins today's messages, keep them. Cost if wrong: a manifest using no heartbeat words at all keeps hearing `heartbeat_on`.
- **R3. Dash's PR is built on dash#25's head** (`mcfearsome/heartbeat-instructions`, `2899de1`), its layout kept and its words changed, and dash#25 closes unmerged when the new PR opens. Cost if wrong: one rebase.

## Global Constraints

- New words: `heartbeat` at the top of either arm and of a saved preset; `roles.<key>.heartbeat_on`: `true`, `false`, or an instruction, trimmed and not blank. Absent or null means off.
- Old words, read forever: a top-level `heartbeat_on`, a role's `reports`, a role's `report`.
- One thing in both spellings is refused: `heartbeat_on: drop it; it is the old name of heartbeat, which this manifest also sets`; `role "<key>": drop reports; heartbeat_on says whether this seat is on the heartbeat and what it reports` (or `drop report;`).
- New-word refusals: `role "<key>": heartbeat_on: give true, false, or what this seat reports`; `role "<key>" sets heartbeat_on but does not hold the verb "send" (it holds: <verbs>)`; `host role "<key>" must not be on the heartbeat`; `a room with a host must set heartbeat (at least 1h)`; `heartbeat: the "<preset>" preset has no host, so a cite of it cannot set a cadence; author the roles to set one`; `heartbeat must be between 30s and 24h (got "<raw>")`.
- Old-word refusals: today's text, unchanged.
- The model, stored rooms and the tick do not change. Nothing stored is migrated.
- The preview: `heartbeat_seconds`, `heartbeat_on` (per role), `your_heartbeat_on`, and `text.data.instructions`.
- Bellman: `npm run verify` before every commit touching `src/`; dash: `npm test && npm run typecheck && npm run lint && npm run build`. Plain git, staged by name, signed; never `CLAUDE.md`.
- Bellman on `mcfearsome/heartbeat-vocabulary` (the spec committed); dash in a scratchpad worktree with its own `npm ci`.
- Public rooms (bellman #233, dash#27, unmerged) change the same functions (`asManifest`, `checkPreset`, `SavedPreset`, the preview's key lists and `Returns:` lines, dash's presets and fixtures). Whichever lands second merges main and resolves them; neither branch waits for the other.

## Review Focus

1. A room.yaml in a repo, written in the old words, starts the same room it did, with today's messages. Test in Task 1.
2. A preset saved before this (old words in the registry) is served, edited and started in the new words. Test in Task 2.
3. A manifest that spells different things differently (an old top-level `heartbeat_on` with a new role `heartbeat_on`) is accepted; only one thing twice is refused. Test in Task 1.
4. YAML's valueless keys: `heartbeat:` means no frequency and a role's `heartbeat_on:` means off. Test in Task 1.
5. A cite of a saved preset with no host, setting either spelling, is refused in that spelling; a hosted one is slowed by either. Test in Task 2.

---

### Task 1: The manifest reads both spellings

**Files:**
- Modify: `src/manifest.ts` (`RoleDefShape`, `CiteShape`, `AuthorShape`, `parseHeartbeatOn`, `resolveManifest`, `checkCiteCadence`, `checkHost`; new `roomBeat`, `roleBeat`)
- Test: `tests/heartbeat-words.test.ts` (new), `tests/room-yaml-export.test.ts`

**Interfaces:**
- Produces: `roomBeat(v: { heartbeat?: string | null; heartbeat_on?: string | null }): { raw: string | null | undefined; word: "heartbeat" | "heartbeat_on" | null }`; `roleBeat(key: string, def: { heartbeat_on?: boolean | string | null; reports?: boolean | null; report?: string | null }): { reports: boolean; report: string | null; word: "heartbeat_on" | "reports" }`; `checkCiteCadence(preset, hasHost, heartbeatOn, word = "heartbeat_on")`.

- [ ] **Step 1: Write the failing tests**

Create `tests/heartbeat-words.test.ts`:

```ts
/**
 * The heartbeat's vocabulary (vocabulary spec): the room's frequency is `heartbeat`, a role's
 * place on it is `heartbeat_on`, and the old words keep working. Presets are Task 2's.
 */
import { describe, expect, it } from "vitest";
import { resolveManifest } from "../src/manifest.js";

const roles = (lead: Record<string, unknown> = {}, observer: Record<string, unknown> = {}) => ({
  lead: { can: ["send"], ...lead }, observer: { can: [], ...observer },
});
const authored = (over: Record<string, unknown> = {}) => ({
  room: "r", mode: "swarm", roles: roles(), default_role: "observer", creator_role: "lead", ...over,
});
const lead = (over: Record<string, unknown>) => resolveManifest(authored({ heartbeat: "5m", roles: roles(over) })).roles.lead;
const hosted = (host: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  room: "r", mode: "swarm", default_role: "lead", creator_role: "lead", host: { role: "host" },
  roles: { lead: { can: ["send"], ...over }, host: { can: ["send"], ...host } },
});

describe("the new words", () => {
  it("read heartbeat as the room's frequency, on both arms", () => {
    expect(resolveManifest(authored({ heartbeat: "5m" })).heartbeatOnMs).toBe(300_000);
    expect(resolveManifest({ room: "r", preset: "social", heartbeat: "2h" }).heartbeatOnMs).toBe(7_200_000);
    expect(() => resolveManifest(authored({ heartbeat: "1s" }))).toThrow(/^heartbeat must be between/);
  });

  it("read a role's heartbeat_on as true, false, an instruction, absent or valueless", () => {
    expect(lead({ heartbeat_on: true })).toMatchObject({ reports: true, report: null });
    expect(lead({ heartbeat_on: false })).toMatchObject({ reports: false, report: null });
    expect(lead({ heartbeat_on: "  What shipped  " })).toMatchObject({ reports: true, report: "What shipped" });
    expect(lead({})).toMatchObject({ reports: false, report: null });
    expect(lead({ heartbeat_on: null })).toMatchObject({ reports: false, report: null });
    expect(resolveManifest(authored({ heartbeat: null })).heartbeatOnMs).toBeNull();
  });

  it("refuse a blank instruction and one over 300 characters", () => {
    expect(() => lead({ heartbeat_on: "   " })).toThrow('role "lead": heartbeat_on: give true, false, or what this seat reports');
    expect(() => lead({ heartbeat_on: "x".repeat(301) })).toThrow(/roles\.lead\.heartbeat_on/);
  });

  it("name heartbeat_on when a seat on the heartbeat cannot send", () => {
    expect(() => resolveManifest(authored({ heartbeat: "5m", roles: roles({}, { heartbeat_on: true }) })))
      .toThrow('role "observer" sets heartbeat_on but does not hold the verb "send" (it holds: none)');
  });

  it("name heartbeat for the frequency a host needs, and heartbeat_on for a host role on it", () => {
    expect(() => resolveManifest(hosted({}, { heartbeat_on: true }))).toThrow("a room with a host must set heartbeat (at least 1h)");
    expect(() => resolveManifest({ ...hosted({ heartbeat_on: true }), heartbeat: "1h" })).toThrow('host role "host" must not be on the heartbeat');
  });

  it("name heartbeat when a cite of a preset with no host sets one", () => {
    expect(() => resolveManifest({ room: "r", preset: "pair", heartbeat: "5m" }))
      .toThrow('heartbeat: the "pair" preset has no host, so a cite of it cannot set a cadence; author the roles to set one');
  });
});

// Review Focus 1.
describe("the old words", () => {
  it("read the same room the new words do", () => {
    const old = resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ reports: true, report: "What shipped" }) }));
    const now = resolveManifest(authored({ heartbeat: "5m", roles: roles({ heartbeat_on: "What shipped" }) }));
    expect(old).toEqual(now);
  });

  it("keep today's messages", () => {
    expect(() => resolveManifest(authored({ heartbeat_on: "5m", roles: roles({}, { reports: true }) })))
      .toThrow('role "observer" sets reports: true but does not hold the verb "send" (it holds: none)');
    expect(() => resolveManifest(authored({ roles: roles({ reports: false, report: "x" }) })))
      .toThrow('role "lead" sets a report instruction but does not answer the heartbeat (reports is false)');
    expect(() => resolveManifest({ room: "r", preset: "pair", heartbeat_on: "5m" })).toThrow(/^heartbeat_on: the "pair" preset has no host/);
    expect(() => resolveManifest(hosted({}, { reports: true }))).toThrow("a room with a host must set heartbeat_on (at least 1h)");
    expect(() => resolveManifest({ ...hosted({ reports: true }), heartbeat_on: "1h" })).toThrow('host role "host" must not report');
    expect(() => resolveManifest(authored({ heartbeat_on: "1s" }))).toThrow(/^heartbeat_on must be between/);
  });

  it("read an old blank report as no instruction", () => {
    expect(resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ reports: true, report: "  " }) })).roles.lead.report).toBeNull();
  });
});

describe("one thing, one spelling", () => {
  it("refuses the frequency spelled both ways, naming the old one to drop", () => {
    expect(() => resolveManifest(authored({ heartbeat: "5m", heartbeat_on: "5m" })))
      .toThrow("heartbeat_on: drop it; it is the old name of heartbeat, which this manifest also sets");
    expect(() => resolveManifest({ room: "r", preset: "social", heartbeat: "2h", heartbeat_on: "2h" })).toThrow(/^heartbeat_on: drop it/);
  });

  it("refuses a role spelled both ways, naming the old field to drop", () => {
    expect(() => lead({ heartbeat_on: true, reports: true }))
      .toThrow('role "lead": drop reports; heartbeat_on says whether this seat is on the heartbeat and what it reports');
    expect(() => lead({ heartbeat_on: "x", report: "x" })).toThrow('role "lead": drop report;');
  });

  // Review Focus 3.
  it("accepts different things in different spellings", () => {
    const m = resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ heartbeat_on: "What shipped" }) }));
    expect([m.heartbeatOnMs, m.roles.lead.report]).toEqual([300_000, "What shipped"]);
  });
});
```

In `tests/room-yaml-export.test.ts`: rename the current `EXPORTED` constant to `OLD_WORDS` (its text unchanged), and add a new `EXPORTED`, which dash's fixture (Task 5) repeats byte for byte:

```ts
const EXPORTED = `room: "my_review"
purpose: "Review where the reviewer may ask too"
mode: "pair"
heartbeat: "5m"
roles:
  "author":
    can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"]
    description: "Brought the work."
    heartbeat_on: "What changed, and what \\"done\\" means\\nfor the next step"
  "reviewer":
    can: ["send", "request_actions", "respond_actions"]
default_role: "reviewer"
creator_role: "author"
`;
```

Keep the existing case loading `EXPORTED` unchanged, and add a case beside it:

```ts
  it("reads the old words a room.yaml was exported in before as the same room", () => {
    const load = (text: string) => {
      const dir = mkdtempSync(join(tmpdir(), "bellman-export-"));
      dirs.push(dir);
      mkdirSync(join(dir, ".bellman"));
      writeFileSync(join(dir, ".bellman", "room.yaml"), text);
      return resolveManifest(loadRoomManifest(dir));
    };
    expect(load(OLD_WORDS)).toEqual(load(EXPORTED));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/heartbeat-words.test.ts tests/room-yaml-export.test.ts`
Expected: FAIL. `Unrecognized key: "heartbeat"` at the top and `Unrecognized key: "heartbeat_on"` on a role, on every new-word case and the new export. The old-word cases pass already, as guards for what must not change; Step 6 breaks them on purpose.

- [ ] **Step 3: The shapes**

In `src/manifest.ts`, `RoleDefShape` gains, above `reports`:

```ts
  // Whether this seat is on the heartbeat, and what it reports (vocabulary spec D1): true,
  // false, or the instruction. `reports` and `report` below are the old words (D3).
  heartbeat_on: z.union([z.boolean(), z.string().max(300)]).nullish(),
```

`CiteShape` and `AuthorShape` each gain, above their `heartbeat_on`:

```ts
  // The room's frequency (vocabulary spec D1); the top-level `heartbeat_on` below is its old name (D3).
  heartbeat: DurationShape.nullish(),
```

`parseHeartbeatOn` takes the field's name:

```ts
const parseHeartbeatOn = (raw: string, field: "heartbeat" | "heartbeat_on" = "heartbeat_on"): number =>
  parseDuration(field, raw, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS, BEAT_UNITS);
```

- [ ] **Step 4: The two readers**

Add to `src/manifest.ts`, after `parseHeartbeatOn`:

```ts
/**
 * The room's frequency from either spelling (vocabulary spec D1, D3, D4): `heartbeat`, or the
 * top-level `heartbeat_on` it replaced. Both is refused, naming the old one to drop. `word` is the
 * spelling given, or null for neither, so a refusal can speak the author's words (D5).
 */
export function roomBeat(v: { heartbeat?: string | null; heartbeat_on?: string | null }): {
  raw: string | null | undefined; word: "heartbeat" | "heartbeat_on" | null;
} {
  if (v.heartbeat !== undefined && v.heartbeat_on !== undefined) {
    throw new ManifestError("heartbeat_on: drop it; it is the old name of heartbeat, which this manifest also sets");
  }
  if (v.heartbeat !== undefined) return { raw: v.heartbeat, word: "heartbeat" };
  if (v.heartbeat_on !== undefined) return { raw: v.heartbeat_on, word: "heartbeat_on" };
  return { raw: undefined, word: null };
}

/**
 * A role's place on the heartbeat from either spelling, as the model holds it (vocabulary spec
 * D1 to D4): `heartbeat_on` true, false or the instruction; or the old `reports` and `report`,
 * with #229's rule in its own words. Both spellings is refused, naming the old field to drop.
 * An instruction is trimmed: a blank new one is refused, and a blank old one reads as none.
 */
export function roleBeat(
  key: string,
  def: { heartbeat_on?: boolean | string | null; reports?: boolean | null; report?: string | null },
): { reports: boolean; report: string | null; word: "heartbeat_on" | "reports" } {
  if (def.heartbeat_on !== undefined) {
    const old = def.reports !== undefined ? "reports" : def.report !== undefined ? "report" : null;
    if (old) {
      throw new ManifestError(`role "${key}": drop ${old}; heartbeat_on says whether this seat is on the heartbeat and what it reports`);
    }
    if (typeof def.heartbeat_on === "string") {
      const report = def.heartbeat_on.trim();
      if (report === "") throw new ManifestError(`role "${key}": heartbeat_on: give true, false, or what this seat reports`);
      return { reports: true, report, word: "heartbeat_on" };
    }
    return { reports: def.heartbeat_on === true, report: null, word: "heartbeat_on" };
  }
  // An instruction for a seat that is never asked would be read by nobody, and shown at join as
  // if it were (#229, heartbeat instructions spec D2).
  if (def.report != null && !(def.reports ?? false)) {
    throw new ManifestError(`role "${key}" sets a report instruction but does not answer the heartbeat (reports is false)`);
  }
  return { reports: def.reports ?? false, report: def.report?.trim() || null, word: "reports" };
}
```

- [ ] **Step 5: `resolveManifest`, the cite rule and the host's rules**

`checkCiteCadence` takes the word and names it:

```ts
export function checkCiteCadence(preset: string, hasHost: boolean, heartbeatOn: unknown, word: "heartbeat" | "heartbeat_on" = "heartbeat_on"): void {
  if (heartbeatOn !== undefined && !hasHost) {
    throw new ManifestError(
      `${word}: the "${preset}" preset has no host, so a cite of it cannot set a cadence; author the roles to set one`,
    );
  }
}
```

`checkHost` takes the words its two messages name, defaulting to today's:

```ts
function checkHost(m: RoomManifest, words: { cadence: "heartbeat" | "heartbeat_on"; hostRole: "heartbeat_on" | "reports" } = { cadence: "heartbeat_on", hostRole: "reports" }): void {
```

and inside it, the two messages become:

```ts
  if (def.reports) {
    throw new ManifestError(words.hostRole === "heartbeat_on"
      ? `host role "${m.host.role}" must not be on the heartbeat`
      : `host role "${m.host.role}" must not report`);
  }
```

```ts
    throw new ManifestError(`a room with a host must set ${words.cadence} (at least ${floor})`);
```

In `resolveManifest`'s cite arm, replace the `checkCiteCadence` call and the `heartbeatOnMs` line with:

```ts
    const beat = roomBeat(v);
    checkCiteCadence(v.preset, body.host !== null, beat.raw, beat.word ?? "heartbeat_on");
```

and `heartbeatOnMs: beat.raw != null ? parseHeartbeatOn(beat.raw, beat.word ?? "heartbeat_on") : (body.heartbeatOnMs ?? null),`, and pass `checkHost(manifest, { cadence: beat.word ?? "heartbeat_on", hostRole: "reports" })`.

In the author arm, before the role loop:

```ts
  const beat = roomBeat(v);
  // The words a refusal about the frequency speaks when the author wrote neither (plan ruling R2).
  const spelledNew = beat.word === "heartbeat" || Object.values(v.roles).some((d) => d.heartbeat_on !== undefined);
  const roleWords: Record<string, "heartbeat_on" | "reports"> = {};
```

In the loop, replace the `reports` send check, #229's report check and the `roles[key]` literal with:

```ts
    const onBeat = roleBeat(key, def);
    roleWords[key] = onBeat.word;
    if (onBeat.reports && !def.can.includes("send")) {
      const holds = def.can.length > 0 ? def.can.join(", ") : "none";
      throw new ManifestError(onBeat.word === "heartbeat_on"
        ? `role "${key}" sets heartbeat_on but does not hold the verb "send" (it holds: ${holds})`
        : `role "${key}" sets reports: true but does not hold the verb "send" (it holds: ${holds})`);
    }
    roles[key] = { can: [...def.can], description: def.description ?? null, reports: onBeat.reports, report: onBeat.report };
```

keeping the comment block above the send check. Replace the manifest's `heartbeatOnMs` line with `heartbeatOnMs: beat.raw != null ? parseHeartbeatOn(beat.raw, beat.word ?? "heartbeat_on") : null,`, and the final `checkHost(manifest)` with:

```ts
  checkHost(manifest, {
    cadence: beat.word ?? (spelledNew ? "heartbeat" : "heartbeat_on"),
    hostRole: (v.host && roleWords[v.host.role]) ?? "reports",
  });
```

- [ ] **Step 6: Run the tests, then break the old words on purpose**

Run: `npm test -- tests/heartbeat-words.test.ts tests/room-yaml-export.test.ts tests/manifest.test.ts tests/report-instructions.test.ts tests/host.test.ts tests/tools/host-start.test.ts tests/room-manifest-skill.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS and clean.

Then, as the guards' positive control, change `roleBeat`'s last line to `return { reports: false, report: null, word: "reports" };` and run `npm test -- tests/heartbeat-words.test.ts tests/room-yaml-export.test.ts`. Expected: "the old words" cases and the old-words export case FAIL. Restore the line and rerun: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/manifest.ts tests/heartbeat-words.test.ts tests/room-yaml-export.test.ts
git commit -m "The manifest reads the heartbeat's new words, heartbeat for the room and heartbeat_on for a role, and keeps the old ones"
```

---

### Task 2: Saved presets in the new words

**Files:**
- Modify: `src/types.ts` (`SavedPreset`)
- Modify: `src/presets.ts` (`asManifest`, `checkPreset`; new `presetInNewWords`)
- Modify: `src/manifest.ts` (`builtinPresets`)
- Modify: `src/store.ts` (`MemoryStore.listPresets`, `getPreset`), `src/store-do.ts` (`RegistryDO.listPresets`, `getPreset`)
- Modify: `src/tools/start.ts` (the saved-preset cite)
- Test: `tests/presets.test.ts`, `tests/http-presets.test.ts`, `tests/tools/start-presets.test.ts`, `tests/report-instructions.test.ts`, `tests/helpers/store-contract.ts`, and every other `SavedPreset` literal in the tests (`tests/tools/host-switch.test.ts`, `worker-tests/preset-routes.test.ts`)

**Interfaces:**
- Consumes: `roomBeat`, `roleBeat`, `checkCiteCadence(…, word)` (Task 1).
- Produces: `SavedPreset.heartbeat: string | null`; `SavedPreset.roles[key]: { can: Verb[]; description: string | null; heartbeat_on: boolean | string }`; `presetInNewWords(p: unknown): SavedPreset`; `asManifest(p, room, purpose, heartbeat?, housekeeping?)` writing `heartbeat` and the roles' `heartbeat_on`.

- [ ] **Step 1: Write the failing tests**

Move every `SavedPreset` literal in the tests to the new words: `heartbeat_on: <x>` at the top becomes `heartbeat: <x>`, and a role's `reports: false` becomes `heartbeat_on: false`, `reports: true` becomes `heartbeat_on: true`, and `reports: true, report: "<text>"` becomes `heartbeat_on: "<text>"`. The typecheck finds the literals once Step 3 changes the type; the ones known now are the `saved` helper in `tests/tools/start-presets.test.ts`, the `preset` helper in `tests/helpers/store-contract.ts`, and the literals in `tests/tools/host-switch.test.ts` and `worker-tests/preset-routes.test.ts`.

Change the expected saved forms to the new words: in `tests/presets.test.ts`'s first `checkPreset` case, `heartbeat: "5m"` and roles `author: { can: [...], description: "Brought the work.", heartbeat_on: true }`, `reviewer: { can: [...], description: null, heartbeat_on: false }` (the body it saves stays in the old words: old in, new stored); in `tests/http-presets.test.ts`, `heartbeat: null` and `heartbeat_on: false` on both roles in "save a preset and answer with it as stored", `heartbeat: "5m"` in the housekeeping case, and the built-ins' expected form; in `tests/report-instructions.test.ts`'s "is saved with a preset and given back", `roles.lead.heartbeat_on` is `"What you shipped"` and `roles.observer.heartbeat_on` is `false`.

Add to `tests/presets.test.ts`:

```ts
describe("a preset in the heartbeat's words", () => {
  it("saves the new words as the old ones, and refuses each in its own words", () => {
    const now = checkPreset("my_review", body({ heartbeat_on: undefined, heartbeat: "5m", roles: {
      author: { can: ["send"], heartbeat_on: "What changed" }, reviewer: { can: ["send"] },
    } }), NOW);
    expect(now.ok && now.preset).toMatchObject({ heartbeat: "5m", roles: { author: { heartbeat_on: "What changed" }, reviewer: { heartbeat_on: false } } });
    expect(checkPreset("my_review", body({ heartbeat_on: undefined, heartbeat: "10s" }), NOW))
      .toMatchObject({ ok: false, description: expect.stringContaining("heartbeat must be between") });
    expect(checkPreset("my_review", body({ heartbeat_on: "10s" }), NOW))
      .toMatchObject({ ok: false, description: expect.stringContaining("heartbeat_on must be between") });
  });
});
```

In `tests/helpers/store-contract.ts`, beside the other preset cases (they call `store.putPreset(`), add:

```ts
      // Review Focus 2: a row saved before the vocabulary changed is read in its new words.
      it("reads a preset saved in the heartbeat's old words back in its new ones", async () => {
        const old = {
          name: "old_words", description: null, mode: "pair", heartbeat_on: "5m", housekeeping: null,
          roles: { lead: { can: ["send"], description: null, reports: true, report: "What shipped" }, quiet: { can: [], description: null, reports: false } },
          default_role: "quiet", creator_role: "lead", host: null, updated_at: "2026-03-15T12:00:00.000Z",
        };
        expect(await store.putPreset("u_jesse", old as unknown as SavedPreset, 20)).toBe("saved");
        const { heartbeat_on: _old, ...rest } = old;
        const now = {
          ...rest, heartbeat: "5m",
          roles: { lead: { can: ["send"], description: null, heartbeat_on: "What shipped" }, quiet: { can: [], description: null, heartbeat_on: false } },
        };
        expect(await store.getPreset("u_jesse", "old_words")).toEqual(now);
        expect((await store.listPresets("u_jesse")).find((p) => p.name === "old_words")).toEqual(now);
      });
```

In `tests/tools/start-presets.test.ts`, inside `describe("bellman_start citing a saved preset")`, add:

```ts
  // Review Focus 2.
  it("starts a room from a preset saved in the old words, its instruction and frequency kept", async () => {
    await h.store.putPreset("u_jesse", {
      ...saved("old_words"), heartbeat: undefined, heartbeat_on: "5m",
      roles: {
        author: { can: ["send", "invite", "revoke", "write_surface"], description: null, reports: true, report: "What changed" },
        reviewer: { can: ["send", "request_actions"], description: null, reports: false },
      },
    } as unknown as SavedPreset, 20);
    const out = await start("old_words");
    expect(out.isError, out.text).toBe(false);
    const m = (await h.store.getSession(String(out.data.session_id)))!.manifest;
    expect([m.heartbeatOnMs, m.roles.author.report]).toEqual([300_000, "What changed"]);
  });

  // Review Focus 5.
  it("refuses either spelling of a frequency on a cite of a preset with no host, in the spelling used", async () => {
    await h.store.putPreset("u_jesse", saved("plain_words"), 20);
    for (const word of ["heartbeat", "heartbeat_on"]) {
      const out = await jesse.call("bellman_start", { manifest: { room: "Q", preset: "plain_words", [word]: "6h" }, brief: brief() });
      expect(out.text).toContain(`invalid manifest — ${word}: the "plain_words" preset has no host`);
    }
  });
```

and in the existing hosted cite case that sends `cite("mornings", { heartbeat_on: "6h" })`, add after it a cite in the new word, `cite("mornings", { heartbeat: "6h" })`, expected to start a room at the same 21,600 seconds.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/presets.test.ts tests/http-presets.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts tests/store.test.ts tests/tools/host-switch.test.ts`
Expected: FAIL. Saved forms still read `heartbeat_on` and `reports`; the old-words row reads back in its old words; the saved preset in new words is refused (`Unrecognized key` is not raised by the shapes any more, but `asManifest` still writes `heartbeat_on` from `p.heartbeat_on`, now undefined, so the frequency is lost).

- [ ] **Step 3: The saved form**

In `src/types.ts`, in `SavedPreset`, replace `heartbeat_on: string | null;` with:

```ts
  /** How often the room ticks, as written (vocabulary spec D6); null for no heartbeat. */
  heartbeat: string | null;
```

and its `roles` with:

```ts
  /** Each role's place on the heartbeat (vocabulary spec D6): false, true, or what it reports. */
  roles: Record<string, { can: Verb[]; description: string | null; heartbeat_on: boolean | string }>;
```

- [ ] **Step 4: Presets read, write and translate the new words**

In `src/presets.ts`, import `roleBeat` and `roomBeat` from `./manifest.js` and `type Verb` from `./types.js`. Add:

```ts
/**
 * A stored preset in the heartbeat's new words (vocabulary spec D6). A row saved before them
 * holds a top-level `heartbeat_on` and roles' `reports` and `report`, and is translated as the
 * manifest reads those words (D3); a row already in the new words is returned as it is. Both
 * stores read every preset through this.
 */
export function presetInNewWords(p: unknown): SavedPreset {
  const row = p as SavedPreset & { heartbeat_on?: string | null };
  if (row.heartbeat !== undefined || row.heartbeat_on === undefined && Object.values(row.roles).every((r) => "heartbeat_on" in r)) {
    return row;
  }
  const { heartbeat_on, roles, ...rest } = row as unknown as Omit<SavedPreset, "roles"> & {
    heartbeat_on?: string | null;
    roles: Record<string, { can: Verb[]; description: string | null; reports?: boolean; report?: string | null }>;
  };
  return {
    ...rest,
    heartbeat: heartbeat_on ?? null,
    roles: Object.fromEntries(Object.entries(roles).map(([key, r]) => {
      const onBeat = roleBeat(key, { reports: r.reports ?? false, report: r.report ?? null });
      return [key, { can: r.can, description: r.description, heartbeat_on: onBeat.report ?? onBeat.reports }];
    })),
  };
}
```

In `asManifest`, rename the parameter `heartbeatOn` to `heartbeat`, write `heartbeat: heartbeat ?? p.heartbeat,` in place of the `heartbeat_on` line, and keep `roles: p.roles` (already in the role shape's new words). Update its doc comment's "A cite's `heartbeat_on`" to "A cite's frequency, either spelling,".

In `checkPreset`, replace everything from `const roles: SavedPreset["roles"] = {};` to the end of the `try`/`catch` with:

```ts
  // Validated as written, so a refusal speaks the words its author used (vocabulary spec D5).
  const { name: _name, description, ...arm } = v;
  try {
    resolveManifest({ ...arm, room: name, purpose: description ?? null });
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, status: 400, error: "invalid_manifest", description: e.message };
    throw e;
  }
  // Stored in the new words (D6), whichever the body used.
  const roles: SavedPreset["roles"] = {};
  for (const [key, def] of Object.entries(v.roles)) {
    const onBeat = roleBeat(key, def);
    roles[key] = { can: [...def.can], description: def.description ?? null, heartbeat_on: onBeat.report ?? onBeat.reports };
  }
  const preset: SavedPreset = {
    name,
    description: description ?? null,
    mode: v.mode,
    heartbeat: roomBeat(v).raw ?? null,
    housekeeping: savedHousekeeping(v.housekeeping),
    roles,
    default_role: v.default_role,
    creator_role: v.creator_role,
    host: v.host == null ? null : { role: v.host.role, model: v.host.model, instructions: v.host.instructions ?? null },
    updated_at: new Date(now).toISOString(),
  };
```

keeping the function's final `return { ok: true, preset };`.

In `src/manifest.ts`'s `builtinPresets`, replace the `heartbeat_on:` line with `heartbeat: body.heartbeatOnMs === undefined ? null : duration(body.heartbeatOnMs, BEAT_UNITS),` and `roles: structuredClone(body.roles),` with:

```ts
      roles: Object.fromEntries(Object.entries(body.roles).map(([key, def]) => [
        key, { can: [...def.can], description: def.description, heartbeat_on: def.report ?? def.reports },
      ])),
```

- [ ] **Step 5: Both stores read through the translation, and the saved cite**

In `src/store.ts` (`import { presetInNewWords } from "./presets.js";`), `MemoryStore.listPresets` returns `detach([...].sort(...)).map(presetInNewWords)` and `getPreset` returns `p && presetInNewWords(detach(p))`. In `src/store-do.ts` (the same import), `RegistryDO.listPresets` ends `.map(([, p]) => presetInNewWords(p))` and `getPreset` returns `p && p.name === name ? presetInNewWords(p) : undefined`.

In `src/tools/start.ts`, import `roomBeat` from `../manifest.js`, and replace the saved cite's `checkCiteCadence` call and `asManifest` call with:

```ts
          // Either spelling of a cite's frequency (vocabulary spec D3), refused in the one it used (D5).
          const beat = roomBeat(manifestInput);
          checkCiteCadence(manifestInput.preset, saved.host != null, beat.raw, beat.word ?? "heartbeat_on");
          // A block the cite carries (#66, D5) replaces the preset's whole; asManifest says how.
          input = asManifest(saved, manifestInput.room, manifestInput.purpose, beat.raw, manifestInput.housekeeping);
```

- [ ] **Step 6: Run the tests, both stores, both typechecks**

Run: `npm test -- tests/presets.test.ts tests/http-presets.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts tests/store.test.ts tests/tools/host-switch.test.ts tests/heartbeat-words.test.ts && npm run typecheck && npm run typecheck:worker && npm run build:ui && npm --prefix worker-tests run test -- store-contract preset-routes`
Expected: PASS and clean. A test still naming the old saved form fails the typecheck or its `toEqual`; move it to the new words.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/presets.ts src/manifest.ts src/store.ts src/store-do.ts src/tools/start.ts tests/presets.test.ts tests/http-presets.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts tests/helpers/store-contract.ts tests/tools/host-switch.test.ts worker-tests/preset-routes.test.ts
git commit -m "Saved presets in the heartbeat's new words: stored and served in them, old rows translated on read, and a cite refused in the spelling it used"
```

---

### Task 3: The preview, the MCP App and the tools speak the new words

**Files:**
- Modify: `src/projections.ts` (`roomPreview`)
- Modify: `ui/src/types.ts`, `ui/src/join.ts`
- Modify: `src/tools/start.ts`, `src/tools/connect.ts` (descriptions)
- Test: `tests/tools/handshake.test.ts`, `tests/projections.test.ts`, `tests/http-rooms.test.ts`, `tests/tools/start-presets.test.ts`, `tests/report-instructions.test.ts`, `ui/test/fixtures.ts`, `ui/test/render.test.ts`

**Interfaces:**
- Produces: the preview's `heartbeat_seconds: number | null`, `heartbeat_on: Record<string, boolean>`, `your_heartbeat_on: boolean`, `text.data.instructions: Record<string, string | null>`.

- [ ] **Step 1: Write the failing tests**

Every test that reads the preview's heartbeat fields reads the new names: `heartbeat_on_seconds` becomes `heartbeat_seconds`, the preview's per-role `reports` map becomes `heartbeat_on`, `you_report` becomes `your_heartbeat_on`, and `text.data.report_instructions` becomes `text.data.instructions`. A manifest a test sends keeps whatever words it uses: only what comes back changes. The files: `tests/tools/handshake.test.ts` (both sorted key lists become `["creator_role", "heartbeat_on", "heartbeat_seconds", "host", "housekeeping", "mode", "preset", "roles", "text", "your_heartbeat_on", "your_role", "your_verbs"]`, and the `toMatchObject` reads), `tests/projections.test.ts`, `tests/http-rooms.test.ts`, `tests/tools/start-presets.test.ts`, `tests/report-instructions.test.ts`, `ui/test/fixtures.ts` and `ui/test/render.test.ts`.

In `ui/test/render.test.ts`, the case that checks the header list for `"Reports"` checks for `"Heartbeat"`, and add inside `describe("renderJoin")`:

```ts
  it("says a seat on the heartbeat is asked every so often, in the cadence's own units", () => {
    const r = connectFixture();
    r.room.heartbeat_seconds = 300;
    r.room.your_heartbeat_on = true;
    expect(renderJoin(r, () => {}, NOW).textContent).toContain("Your seat is on the heartbeat, every 5m.");
  });
```

In `tests/report-instructions.test.ts`'s `describe("the tick")`, pin the tick's shape (vocabulary spec D8):

```ts
  it("keeps its shape: ticks are stored and replayed", () => {
    expect(Object.keys(snapshotOf(room({ report: "x" }), 10 * 60_000)).sort()).toEqual(["ask", "cadence_seconds", "instructions", "members"]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/tools/handshake.test.ts tests/projections.test.ts tests/http-rooms.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts ui/test/render.test.ts`
Expected: FAIL on every renamed read (the preview still sends the old names), the column header and the seat line. The tick's shape case passes, as the guard D8 asks for.

- [ ] **Step 3: The preview**

In `src/projections.ts`'s `roomPreview`: rename the local `reports` to `heartbeat_on` and `report_instructions` to `instructions`; in the returned object, `heartbeat_on_seconds:` becomes `heartbeat_seconds:`, `you_report:` becomes `your_heartbeat_on:`, `reports,` becomes `heartbeat_on,`, and the text block carries `{ room: m.room, purpose: m.purpose, descriptions, instructions }`. Update the doc comment's names to match.

- [ ] **Step 4: The MCP App**

In `ui/src/types.ts`'s `RoomBlock`: `heartbeat_seconds: number | null;`, `your_heartbeat_on: boolean;`, `heartbeat_on: Record<string, boolean>;`, and the text's `instructions?: Record<string, string | null>` in place of `report_instructions`. In `ui/src/join.ts`, import `duration` from `./shared.js` beside `countdown` and `el`; the role rows read `r.room.heartbeat_on[role]` and `prose.instructions?.[role]`; the header cell `"Reports"` becomes `"Heartbeat"`; and the seat line becomes:

```ts
  const seat = `You may: ${r.room.your_verbs.length > 0 ? r.room.your_verbs.join(", ") : "read only"}.` +
    (r.room.your_heartbeat_on && r.room.heartbeat_seconds !== null
      ? ` Your seat is on the heartbeat, every ${duration(r.room.heartbeat_seconds)}.`
      : "");
```

- [ ] **Step 5: What the tools say**

In `src/tools/start.ts`'s and `src/tools/connect.ts`'s `Returns:` lines, replace `heartbeat_on_seconds, you_report, creator_role, roles, reports (per role, whether that seat is asked to report)` with `heartbeat_seconds, your_heartbeat_on, creator_role, roles, heartbeat_on (per role, whether that seat is asked to report)`. In `bellman_start`'s description, on the host line (it begins ``A manifest may declare a``), replace the escaped `heartbeat_on` in "of at least 1h" with `heartbeat`, and directly after the line that begins `    { room, purpose?, mode, roles:` add:

```
    heartbeat: <duration, 30s to 24h> sets how often the room's heartbeat ticks; a role's heartbeat_on: true puts that seat on it, and heartbeat_on: "<what to report>" does so with your instruction. The older top-level heartbeat_on and a role's reports/report still work.
```

- [ ] **Step 6: Run the tests and the UI's typecheck**

Run: `npm test -- tests/tools/handshake.test.ts tests/projections.test.ts tests/http-rooms.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts ui/test/render.test.ts tests/extension.test.ts && npm run typecheck:ui && npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add src/projections.ts ui/src/types.ts ui/src/join.ts src/tools/start.ts src/tools/connect.ts tests/tools/handshake.test.ts tests/projections.test.ts tests/http-rooms.test.ts tests/tools/start-presets.test.ts tests/report-instructions.test.ts ui/test/fixtures.ts ui/test/render.test.ts
git commit -m "The join preview, the MCP App and the tools speak the heartbeat's new words; the tick keeps its shape"
```

---

### Task 4: The docs, the cost, and the bellman PR

**Files:**
- Modify: `README.md`, `skills/room-manifest/SKILL.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: The docs in the new words**

Every place these three files tell an author what to write, or name a preview field, moves to the new words: a top-level `heartbeat_on` becomes `heartbeat`, `reports: true` and `report:` become a role's `heartbeat_on`, and `heartbeat_on_seconds`, `you_report` and the preview's `reports` take their new names. Quoted refusals take their new-word text. History stays as written: §11's earlier measurements and anything naming what #111 or #229 added. Each file says once that the old words still work. Today's places: `README.md`'s heartbeat paragraph (it begins "A room can also ask its members to report"), its hosted-seat paragraphs and their YAML example; `SKILL.md`'s cite paragraph on slowing a host, its rules bullet on report instructions, the hosted-seat section, its YAML example and its quoted refusals; `ARCHITECTURE.md`'s heartbeat paragraph (the sentence on `report`) and its hosted-seat summary. Then run `npm test -- tests/room-manifest-skill.test.ts`: the skill's YAML examples still resolve.

- [ ] **Step 2: Measure what connecting costs**

```bash
S=<scratchpad>
git worktree add --detach "$S/vocab-base" origin/main
ln -s "$PWD/node_modules" "$S/vocab-base/node_modules"
measure() { (cd "$1" && npm run -s build:ui >/dev/null 2>&1 && npx tsx -e 'import("./tests/helpers/harness.ts").then(async ({ Harness, DEV_KEY }) => { const h = new Harness(); const p = await h.connect(DEV_KEY.jesse); console.log(JSON.stringify((await p.listTools()).tools)); await h.close(); process.exit(0); });') > "$2"; }
measure "$S/vocab-base" "$S/tools-vocab-base.json" && measure "$PWD" "$S/tools-vocab-head.json"
python3 - "$S/tools-vocab-base.json" "$S/tools-vocab-head.json" <<'EOF'
import json, sys, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
count = lambda x: len(enc.encode(json.dumps(x, separators=(",", ":"))))
(b, bt), (h, ht) = [(count(t), {x["name"]: count(x) for x in t}) for t in (json.load(open(p)) for p in sys.argv[1:])]
print("main", b, "head", h, "diff", h - b, {k: (bt.get(k), v) for k, v in ht.items() if v != bt.get(k)})
EOF
rm "$S/vocab-base/node_modules" && git worktree remove "$S/vocab-base"
```

Expected: the two totals and the tools that changed. In `docs/ARCHITECTURE.md` §11, set the table's tool-definitions figure to main's figure plus the difference, and add a paragraph above the newest "Re-measured" one: the date, the difference by tool, and why (the schema lists both spellings, and the descriptions name the new ones).

- [ ] **Step 3: Verify, commit, push, PR**

Run: `npm run verify && npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
Expected: green; the dry run bundles.

```bash
git add README.md skills/room-manifest/SKILL.md docs/ARCHITECTURE.md
git commit -m "Say the heartbeat in its new words: heartbeat for how often, heartbeat_on for who and what; the old words still work"
git push -u origin mcfearsome/heartbeat-vocabulary
gh pr create --repo bellman-sh/bellman --base main --head mcfearsome/heartbeat-vocabulary --draft --title "The heartbeat's vocabulary: heartbeat for the room's frequency, heartbeat_on for each role" --body-file <scratchpad>/vocab-pr-body.md
```

The body: the model in two lines, the old words that keep working, the preview's four renames, the rulings, the measured cost, the verify totals, and that dash's PR follows and deploys right after this one.

---

### Task 5: Dash: the designer in the new words, and the dash PR

**Files:**
- Modify: `src/lib/api.ts` (`Preset`), `src/lib/presets.ts` (`draftFrom`, `bodyOf`, `toYaml`, `fieldOf`), `src/components/presets/preset-editor.tsx`, `src/test-fixtures.ts`
- Test: `src/lib/presets.test.ts`, `src/components/presets/preset-editor.test.tsx`

**Interfaces:**
- Consumes: the served `Preset` in the new words (Task 2); Task 1's `EXPORTED`.
- Produces: bodies and exports that carry only `heartbeat` and `heartbeat_on`.

- [ ] **Step 1: The worktree, from dash#25's head (plan ruling R3)**

```bash
D=/Users/mcfearsome/src/github.com/bellman-sh/dash
DASH=<scratchpad>/dash-vocabulary
git -C "$D" fetch -q origin
git -C "$D" worktree add -b mcfearsome/heartbeat-vocabulary "$DASH" origin/mcfearsome/heartbeat-instructions
cd "$DASH" && npm ci --no-audit --no-fund
```

- [ ] **Step 2: Write the failing tests**

In `src/test-fixtures.ts`, `preset()` speaks the new words: `heartbeat: "5m"` in place of `heartbeat_on`, the author `heartbeat_on: "What changed, and what \"done\" means\nfor the next step"` in place of `reports` and `report`, and the reviewer `heartbeat_on: false`.

In `src/lib/presets.test.ts`, `EXPORTED` becomes Task 1's text byte for byte. The pinned bodies take the new words: `bodyOf` results carry `heartbeat` and roles `{ can, description, heartbeat_on }`, an off role `heartbeat_on: false`, an on role with no instruction `heartbeat_on: true`. Add:

```ts
describe("the heartbeat's words", () => {
  it("reads a served preset's heartbeat_on into the draft, and writes it back", () => {
    const d = draftFrom(preset());
    expect([d.heartbeat, d.roles[0].reports, d.roles[0].report, d.roles[1].reports]).toEqual([
      { on: true, amount: 5, unit: "m" }, true, "What changed, and what \"done\" means\nfor the next step", false,
    ]);
    const roles = bodyOf({ ...d, roles: [{ ...d.roles[0], report: "  " }, d.roles[1]] }).roles;
    expect([roles.author.heartbeat_on, roles.reviewer.heartbeat_on]).toEqual([true, false]);
  });

  it("exports only the new words", () => {
    const yaml = toYaml(preset());
    expect(yaml).toContain('\nheartbeat: "5m"\n');
    expect(yaml).not.toMatch(/reports:|report:|^heartbeat_on:/m);
  });
});
```

In `src/components/presets/preset-editor.test.tsx`, the labels `Role N answers the heartbeat` become `Role N heartbeat on`, the header text "Answers the heartbeat" becomes "Heartbeat on", and the first heartbeat case also checks `expect(screen.getByRole("group", { name: "Roles" })).toHaveTextContent("every")`.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/lib/presets.test.ts src/components/presets`
Expected: FAIL: the draft reads `heartbeat_on` and `reports`, bodies and the export write the old words, and the labels are dash#25's.

- [ ] **Step 4: The client and the rules**

In `src/lib/api.ts`'s `Preset`: `heartbeat: string | null;` in place of `heartbeat_on`, and `roles: Record<string, { can: string[]; description: string | null; heartbeat_on: boolean | string }>;`.

In `src/lib/presets.ts`:
- `draftFrom` reads `p.heartbeat` for the duration, and each role `reports: r.heartbeat_on === true || typeof r.heartbeat_on === "string"`, `report: typeof r.heartbeat_on === "string" ? r.heartbeat_on : ""`.
- `bodyOf` writes the room and each role as:

```ts
    heartbeat: d.heartbeat.on ? `${d.heartbeat.amount}${d.heartbeat.unit}` : null,
```

```ts
    [r.key, { can: [...r.can], description: r.description.trim() || null, heartbeat_on: r.reports ? (r.report.trim() || true) : false }]
```
- `toYaml`'s `Pick` names `"heartbeat"` in place of `"heartbeat_on"`; it writes `heartbeat:` at the top when set, and under a role, after the description, only:

```ts
    if (r.heartbeat_on !== false) lines.push(`    heartbeat_on: ${r.heartbeat_on === true ? "true" : q(r.heartbeat_on)}`);
```

with no `reports:` or `report:` line.
- `FIELDS`' `[/^heartbeat_on\b/, "heartbeat"]` becomes `[/^heartbeat(_on)?\b/, "heartbeat"]`.

- [ ] **Step 5: The editor's words**

In `src/components/presets/preset-editor.tsx`: the heartbeat block's row reads `[checkbox] every [amount] [unit]` (a `<span>every</span>` before the amount) and its line reads "Every role with heartbeat on is asked on this cadence."; the column header "Answers the heartbeat" becomes "Heartbeat on" and the checkbox's `aria-label` becomes `` `Role ${i + 1} heartbeat on` ``; the instruction field's placeholder becomes "What this role reports; empty for the server's default ask".

- [ ] **Step 6: The whole suite, typecheck, lint, build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: green.

- [ ] **Step 7: Commit, push, PR, and close dash#25**

```bash
git add src/lib/api.ts src/lib/presets.ts src/lib/presets.test.ts src/components/presets/preset-editor.tsx src/components/presets/preset-editor.test.tsx src/test-fixtures.ts
git commit -m "The designer speaks the heartbeat's new words: heartbeat for how often, and each role's heartbeat on, with what it reports"
git push -u origin mcfearsome/heartbeat-vocabulary
gh pr create --repo bellman-sh/dash --base main --head mcfearsome/heartbeat-vocabulary --draft --title "The designer in the heartbeat's new words, with the cadence beside the roles" --body-file <scratchpad>/dash-vocab-pr-body.md
gh pr close 25 --repo bellman-sh/dash --comment "Replaced by the designer in the heartbeat's new words: <the new PR's URL>."
```

The body: what changed against main (dash#25's layout and instruction field, in the new words), that bellman's PR deploys first and dash right after it, the tests, and that dash deploys by hand.
