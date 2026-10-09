# Saved presets and the room designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person saves room shapes as presets in dash, an agent starts a room from one by name with `bellman_start`, and a preset exports as a `room.yaml` that starts the same room for anyone.

**Architecture:** The server gains a runtime-free `src/presets.ts` (what may be saved, and a saved preset as the author arm `resolveManifest` reads), four `BellmanStore` methods kept per person under `pr:<userId>:<name>` in `RegistryDO`, and `src/http/presets.ts` beside the room routes. `bellman_start` looks a non-built-in name up among the caller's presets before resolving, so the room is expanded at start as every room is. Dash gets a Presets page: pure rules in `src/lib/presets.ts`, a presentational editor and list, and three routes.

**Tech Stack:** TypeScript, zod 4, the MCP SDK 1.x, Cloudflare Workers and Durable Objects, vitest (Node and workerd programs); dash: Vite, React 19, TanStack Router, Tailwind, vitest with jsdom and Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-09-room-designer-design.md`

## Rulings against the spec

- **R1. One flat shape on the wire.** D5 nests a preset's body under `preset` in the `GET` answer while D2 makes the `PUT` body flat. This plan uses the flat `SavedPreset` for both, so a clone is a `GET` item minus `name` and `updated_at`. Cost if wrong: a reshaping in dash.
- **R2. `/presets/new` and `/presets/edit/$name`, not `/presets/$name` with `new`.** `new` is a legal preset name, so D7's routes would collide for anyone who saves one. Cost if wrong: two route paths.
- **R3. The built-ins' one-line descriptions live in `src/manifest.ts`,** beside `PRESETS`, which stays unexported. Cost if wrong: three strings.

## Global Constraints

- Preset names follow the role-key grammar `[a-z][a-z0-9_]{0,30}` (`slugShape("preset names")`) and may not be `pair`, `swarm` or `review`.
- `MAX_PRESETS = 20` per person; a description is at most 300 characters; a `PUT` body is at most `MAX_PRESET_BYTES = 32 * 1024` bytes.
- Registry key `pr:<userId>:<name>`; every read and write is keyed by the caller's own `userId`.
- Every `BellmanStore` method is async, and `tests/helpers/store-contract.ts` runs on both stores (`tests/store.test.ts` for `MemoryStore`, `worker-tests/store-contract.test.ts` for `DurableObjectStore` under `npm run test:worker`).
- A room is expanded at start. The stored manifest's `preset` stays `PresetName | null`, and a room started from a saved preset records `null`.
- A refusal carries the validator's message word for word (`ManifestError`'s message, or `describeIssue` of the first zod issue).
- Role descriptions are creator text; dash renders every field as text.
- Bellman: `npm run verify` before every commit that touches `src/`. Dash: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; dash has no CI.
- Commits are plain git, staged by name, never `git commit -a`, and signed: `git cat-file commit HEAD | grep -c '^gpgsig'` prints 1. Never edit `CLAUDE.md`: a tool injects an uncommitted block into it.
- Bellman work is on branch `mcfearsome/room-designer` in this worktree. Dash work is in a new worktree of `bellman-sh/dash` on `mcfearsome/presets` from `origin/main`, created in Task 6; the main dash checkout belongs to another session.

## Review Focus

1. A preset saved earlier that today's validator refuses: `bellman_start` refuses it with the validator's message rather than throwing. Test in Task 4.
2. Two saves racing for the last place under the cap: exactly one lands. Test in Task 2.
3. A name typed with capitals or a hyphen: the server refuses it in the grammar's words, and the editor shows the refusal beside the name. Tests in Tasks 1 and 6.
4. A role renamed or removed while the default or creator picker names it: the pickers follow the rename, or move to the first role left. Tests in Task 6.
5. A preset edited or deleted while a room started from it runs: the room keeps its roles. Test in Task 4.

---

### Task 1: What may be saved, and a saved preset as a manifest

**Files:**
- Modify: `src/types.ts` (add `SavedPreset`)
- Modify: `src/manifest.ts` (export `describeIssue`; add `PresetNameShape`, `PresetShape`, `builtinPresets`)
- Create: `src/presets.ts`
- Test: `tests/presets.test.ts`

**Interfaces:**
- Produces, in `src/types.ts`:
  ```ts
  export interface SavedPreset {
    name: string;
    description: string | null;
    mode: SessionMode;
    heartbeat_on: string | null;
    roles: Record<string, { can: Verb[]; description: string | null; reports: boolean }>;
    default_role: string;
    creator_role: string;
    updated_at: string | null;
  }
  ```
- Produces, in `src/manifest.ts`: `describeIssue(i)`, `PresetNameShape`, `PresetShape`, `PresetInput`, `builtinPresets(): SavedPreset[]`.
- Produces, in `src/presets.ts`: `MAX_PRESETS = 20`, `PresetCheck`, `checkPreset(name: string, body: unknown, now: number): PresetCheck`, `asManifest(p: SavedPreset, room: string, purpose: string | null | undefined): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Create `tests/presets.test.ts`:

```ts
/**
 * What a person may save as a preset (designer spec D2, D3), and a saved preset
 * as the manifest bellman_start resolves (D6). Pure: no store.
 */
import { describe, expect, it } from "vitest";
import { asManifest, checkPreset } from "../src/presets.js";
import { builtinPresets, resolveManifest } from "../src/manifest.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");

const body = (over: Record<string, unknown> = {}) => ({
  description: "Review where the reviewer may ask too",
  mode: "pair",
  heartbeat_on: "5m",
  roles: {
    author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
    reviewer: { can: ["send", "request_actions", "respond_actions"] },
  },
  default_role: "reviewer",
  creator_role: "author",
  ...over,
});

describe("checkPreset", () => {
  it("saves a legal body under the path's name, every optional field filled in", () => {
    expect(checkPreset("my_review", body(), NOW)).toEqual({
      ok: true,
      preset: {
        name: "my_review",
        description: "Review where the reviewer may ask too",
        mode: "pair",
        heartbeat_on: "5m",
        roles: {
          author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
          reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
        },
        default_role: "reviewer",
        creator_role: "author",
        updated_at: "2026-10-09T12:00:00.000Z",
      },
    });
  });

  it("refuses a name outside the grammar, in the grammar's words", () => {
    expect(checkPreset("My-Review", body(), NOW)).toMatchObject({
      ok: false, status: 400, error: "invalid_request", description: expect.stringContaining("preset names must match"),
    });
  });

  it.each(["pair", "swarm", "review"])("refuses the built-in name %s with its own error", (name) => {
    expect(checkPreset(name, body(), NOW)).toMatchObject({ ok: false, status: 409, error: "builtin" });
  });

  it("refuses a body that names another preset, and takes one that names this one", () => {
    expect(checkPreset("my_review", body({ name: "other" }), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(checkPreset("my_review", body({ name: "my_review" }), NOW)).toMatchObject({ ok: true });
  });

  it("refuses room and purpose, which stay per room, and any key the author arm does not have", () => {
    for (const extra of [{ room: "r" }, { purpose: "p" }, { preset: "pair" }, { color: "red" }]) {
      expect(checkPreset("my_review", body(extra), NOW), JSON.stringify(extra)).toMatchObject({ ok: false, status: 400, error: "invalid_request" });
    }
  });

  it("refuses what the room validator refuses, in the validator's words", () => {
    expect(checkPreset("my_review", body({ creator_role: "boss" }), NOW)).toEqual({
      ok: false, status: 400, error: "invalid_manifest",
      description: 'creator_role "boss" is not defined in roles (defined: author, reviewer)',
    });
    const mute = body({ roles: { lead: { can: [], reports: true } }, default_role: "lead", creator_role: "lead" });
    expect(checkPreset("my_review", mute, NOW)).toMatchObject({
      ok: false, error: "invalid_manifest", description: expect.stringContaining('role "lead" sets reports: true but does not hold the verb "send"'),
    });
    expect(checkPreset("my_review", body({ heartbeat_on: "10s" }), NOW)).toMatchObject({
      ok: false, error: "invalid_manifest", description: expect.stringContaining("heartbeat_on must be between"),
    });
  });

  it("gives a saved preset that resolves to the room it describes", () => {
    const check = checkPreset("my_review", body(), NOW);
    if (!check.ok) throw new Error(check.description);
    const m = resolveManifest(asManifest(check.preset, "Q3 review", null));
    expect(m).toMatchObject({
      room: "Q3 review", purpose: null, mode: "pair", preset: null, defaultRole: "reviewer", creatorRole: "author", heartbeatOnMs: 300_000,
    });
    expect(m.roles.reviewer.can).toEqual(["send", "request_actions", "respond_actions"]);
  });
});

describe("builtinPresets", () => {
  it("lists the three built-ins in a saved preset's form, each of which saves under a new name", () => {
    const all = builtinPresets();
    expect(all.map((p) => p.name)).toEqual(["pair", "swarm", "review"]);
    for (const p of all) {
      expect(p.updated_at).toBeNull();
      expect(typeof p.description).toBe("string");
      const clone = { description: p.description, mode: p.mode, heartbeat_on: p.heartbeat_on, roles: p.roles, default_role: p.default_role, creator_role: p.creator_role };
      expect(checkPreset(`my_${p.name}`, clone, NOW), p.name).toMatchObject({ ok: true });
    }
  });

  it("hands out fresh copies: changing one leaves the next call alone", () => {
    builtinPresets()[0].roles.peer_a.can.push("send");
    expect(builtinPresets()[0].roles.peer_a.can.filter((v) => v === "send")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/presets.test.ts`
Expected: FAIL: `Cannot find module '../src/presets.js'`.

- [ ] **Step 3: Add the type and the shapes**

In `src/types.ts`, after the `RoomManifest` interface, add:

```ts
/**
 * A preset a person saved (designer spec D2, D4): a room shape without the room,
 * in the author arm's own field names, so citing it hands these fields to
 * `resolveManifest`. Stored and served in this one form (plan ruling R1), and a
 * built-in is shown in it too, with `updated_at` null.
 */
export interface SavedPreset {
  name: string;
  description: string | null;
  mode: SessionMode;
  heartbeat_on: string | null;
  roles: Record<string, { can: Verb[]; description: string | null; reports: boolean }>;
  default_role: string;
  creator_role: string;
  /** ISO 8601 when it was saved; null for a built-in, which never was. */
  updated_at: string | null;
}
```

In `src/manifest.ts`:

1. Add `SavedPreset` to the type import from `./types.js`.
2. Change `function describeIssue(` to `export function describeIssue(`.
3. Directly after `export const RoleKeyShape = slugShape("role keys");`, add:

```ts
/** A saved preset's name (designer spec D2): the role-key grammar, refused with its own noun. */
export const PresetNameShape = slugShape("preset names");
```

4. Directly after `export type ManifestInput = z.input<typeof ManifestShape>;`, add:

```ts
/**
 * A preset a person saves (designer spec D2): the author arm without `room` and
 * `purpose`, which stay per room, plus an optional description. `name` is
 * optional because the route's path names the preset; a body naming another is
 * refused there. Built as a fresh strict object, so a key the author arm does not
 * have is refused as the arms refuse one.
 */
export const PresetShape = z.strictObject({
  ...AuthorShape.omit({ room: true, purpose: true }).shape,
  name: z.string().max(MAX_ROLE_KEY_LENGTH).optional(),
  description: z.string().max(300).nullish(),
});
export type PresetInput = z.input<typeof PresetShape>;
```

5. Directly after the `PRESETS` object, before the `// Resolution` banner, add:

```ts
/** What each built-in is for, in a line, for the panel's list (designer spec D5, plan ruling R3). */
const BUILTIN_DESCRIPTIONS: Record<PresetName, string> = {
  pair: "Two peers. The creator controls who joins and writes the surface.",
  swarm: "A lead who runs the room, helpers who work it, and observers who read it.",
  review: "An author who brought the work, and a reviewer who answers but does not ask.",
};

/**
 * The built-ins in a saved preset's form, fresh copies on every call, for the
 * panel to show and clone (designer spec D5). PRESETS itself stays unexported:
 * its `can` arrays are mutable.
 */
export function builtinPresets(): SavedPreset[] {
  return PRESET_NAMES.map((name) => {
    const body = PRESETS[name];
    return {
      name,
      description: BUILTIN_DESCRIPTIONS[name],
      mode: body.mode,
      heartbeat_on: null,
      roles: structuredClone(body.roles),
      default_role: body.defaultRole,
      creator_role: body.creatorRole,
      updated_at: null,
    };
  });
}
```

- [ ] **Step 4: Write `src/presets.ts`**

```ts
/**
 * Saved presets (designer spec): the rule for what may be saved, and a saved
 * preset as the manifest bellman_start resolves. Runtime-free, like
 * manifest.ts, so the routes, the tool and both test programs import it.
 */
import { ManifestError, PRESET_NAMES, PresetNameShape, PresetShape, describeIssue, resolveManifest } from "./manifest.js";
import type { SavedPreset } from "./types.js";

// ponytail: twenty a person, not tuned. The first person past it wants a reason, not a bigger number.
export const MAX_PRESETS = 20;

export type PresetCheck =
  | { ok: true; preset: SavedPreset }
  | { ok: false; status: 400 | 409; error: "invalid_request" | "invalid_manifest" | "builtin"; description: string };

/** A saved preset as the author arm `resolveManifest` reads, for a room called `room` (D6). */
export function asManifest(p: SavedPreset, room: string, purpose: string | null | undefined): Record<string, unknown> {
  return {
    room,
    purpose: purpose ?? null,
    mode: p.mode,
    heartbeat_on: p.heartbeat_on,
    roles: p.roles,
    default_role: p.default_role,
    creator_role: p.creator_role,
  };
}

/**
 * What a PUT for `name` may save (D2, D3): a legal name that is not a built-in's,
 * a body of the preset's shape that names no other preset, and a room the
 * validator would start. A refusal carries the validator's message word for
 * word, so the designer shows what bellman_start would have said.
 */
export function checkPreset(name: string, body: unknown, now: number): PresetCheck {
  const named = PresetNameShape.safeParse(name);
  if (!named.success) return { ok: false, status: 400, error: "invalid_request", description: describeIssue(named.error.issues[0]) };
  if ((PRESET_NAMES as readonly string[]).includes(name)) {
    return { ok: false, status: 409, error: "builtin", description: `"${name}" is a built-in preset; clone it under another name` };
  }
  const parsed = PresetShape.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_request", description: describeIssue(parsed.error.issues[0]) };
  const v = parsed.data;
  if (v.name !== undefined && v.name !== name) {
    return { ok: false, status: 400, error: "invalid_request", description: `the body names preset ${JSON.stringify(v.name)} but the path names "${name}"` };
  }
  const roles: SavedPreset["roles"] = {};
  for (const [key, def] of Object.entries(v.roles)) {
    roles[key] = { can: [...def.can], description: def.description ?? null, reports: def.reports ?? false };
  }
  const preset: SavedPreset = {
    name,
    description: v.description ?? null,
    mode: v.mode,
    heartbeat_on: v.heartbeat_on ?? null,
    roles,
    default_role: v.default_role,
    creator_role: v.creator_role,
    updated_at: new Date(now).toISOString(),
  };
  try {
    resolveManifest(asManifest(preset, name, preset.description));
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, status: 400, error: "invalid_manifest", description: e.message };
    throw e;
  }
  return { ok: true, preset };
}
```

- [ ] **Step 5: Run the tests and both typechecks**

Run: `npm test -- tests/presets.test.ts tests/manifest.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS, every case in both files; both typechecks clean. If the refusal of `{ color: "red" }` passes the shape, `PresetShape` lost its strictness: it must be `z.strictObject` around the omitted shape, as written.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/manifest.ts src/presets.ts tests/presets.test.ts
git commit -m "What may be saved as a preset: the shape, the name, the room validator's verdict, and the built-ins in the same form"
```

---

### Task 2: Presets in both stores

**Files:**
- Modify: `src/store.ts` (`BellmanStore`, `MemoryStore`)
- Modify: `src/store-do.ts` (`RegistryDO`, `DurableObjectStore`)
- Test: `tests/helpers/store-contract.ts` (a `saved presets` block, run by `tests/store.test.ts` and `worker-tests/store-contract.test.ts`)

**Interfaces:**
- Consumes: `SavedPreset` (Task 1).
- Produces, on `BellmanStore`:
  ```ts
  listPresets(userId: string): Promise<SavedPreset[]>;
  getPreset(userId: string, name: string): Promise<SavedPreset | undefined>;
  putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full">;
  deletePreset(userId: string, name: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing contract cases**

In `tests/helpers/store-contract.ts`, add `SavedPreset` to the type import from `../../src/types.js`, and directly after the `// ---- quotas` case ("counts creates within the current calendar month only"), add:

```ts
    // --------------------------------------------- saved presets (designer)
    describe("saved presets", () => {
      const preset = (name: string, over: Partial<SavedPreset> = {}): SavedPreset => ({
        name,
        description: null,
        mode: "pair",
        heartbeat_on: null,
        roles: { lead: { can: ["send"], description: null, reports: false } },
        default_role: "lead",
        creator_role: "lead",
        updated_at: "2026-03-15T12:00:00.000Z",
        ...over,
      });

      it("lists a person's presets in name order, and none for a person with none", async () => {
        expect(await store.listPresets("u_jesse")).toEqual([]);
        for (const name of ["b", "a_x", "a"]) expect(await store.putPreset("u_jesse", preset(name), 20)).toBe("saved");
        expect((await store.listPresets("u_jesse")).map((p) => p.name)).toEqual(["a", "a_x", "b"]);
      });

      it("gets one by name as a copy the caller cannot change in the store, and none for a name not saved", async () => {
        await store.putPreset("u_jesse", preset("a", { description: "first" }), 20);
        const got = (await store.getPreset("u_jesse", "a"))!;
        expect(got).toEqual(preset("a", { description: "first" }));
        got.roles.lead.can.push("invite");
        expect((await store.getPreset("u_jesse", "a"))!.roles.lead.can).toEqual(["send"]);
        expect(await store.getPreset("u_jesse", "b")).toBeUndefined();
      });

      it("replaces by name", async () => {
        await store.putPreset("u_jesse", preset("a", { description: "first" }), 20);
        await store.putPreset("u_jesse", preset("a", { description: "second" }), 20);
        expect((await store.listPresets("u_jesse")).map((p) => p.description)).toEqual(["second"]);
      });

      it("refuses a new name at the cap, and still replaces one already saved", async () => {
        expect(await store.putPreset("u_jesse", preset("a"), 2)).toBe("saved");
        expect(await store.putPreset("u_jesse", preset("b"), 2)).toBe("saved");
        expect(await store.putPreset("u_jesse", preset("c"), 2)).toBe("full");
        expect(await store.putPreset("u_jesse", preset("a", { description: "again" }), 2)).toBe("saved");
        expect((await store.listPresets("u_jesse")).map((p) => p.name)).toEqual(["a", "b"]);
      });

      it("lets one of two new names racing for the last place land, never both", async () => {
        await store.putPreset("u_jesse", preset("a"), 2);
        const verdicts = await Promise.all([
          store.putPreset("u_jesse", preset("b"), 2),
          store.putPreset("u_jesse", preset("c"), 2),
        ]);
        expect([...verdicts].sort()).toEqual(["full", "saved"]);
        expect(await store.listPresets("u_jesse")).toHaveLength(2);
      });

      it("keeps each person's presets apart", async () => {
        await store.putPreset("u_jesse", preset("a"), 1);
        expect(await store.putPreset("u_peer", preset("a", { description: "theirs" }), 1)).toBe("saved");
        expect((await store.getPreset("u_jesse", "a"))!.description).toBeNull();
        expect(await store.deletePreset("u_peer", "a")).toBe(true);
        expect(await store.getPreset("u_jesse", "a")).toBeDefined();
      });

      it("deletes one, and says false for one it does not have", async () => {
        await store.putPreset("u_jesse", preset("a"), 20);
        expect(await store.deletePreset("u_jesse", "a")).toBe(true);
        expect(await store.getPreset("u_jesse", "a")).toBeUndefined();
        expect(await store.deletePreset("u_jesse", "a")).toBe(false);
      });
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/store.test.ts -t "saved presets"`
Expected: FAIL, all seven: `store.listPresets is not a function` (or `putPreset`).

- [ ] **Step 3: The interface and `MemoryStore`**

In `src/store.ts`, add `SavedPreset` to the type import from `./types.js`. In `BellmanStore`, directly after `recordCreate(userId: string): Promise<void>;`, add:

```ts

  /** A person's saved presets (designer spec D4), in name order. Keyed by the person: nothing here reads another's. */
  listPresets(userId: string): Promise<SavedPreset[]>;
  getPreset(userId: string, name: string): Promise<SavedPreset | undefined>;
  /**
   * Save or replace by name. "full" when a new name would pass `cap`; replacing
   * one never counts against it. The count and the write are one operation, so
   * two saves racing for the last place cannot both land.
   */
  putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full">;
  /** True when there was one to delete. */
  deletePreset(userId: string, name: string): Promise<boolean>;
```

In `MemoryStore`, beside `private creates = ...`, add:

```ts
  private presets = new Map<string, Map<string, SavedPreset>>(); // userId -> name -> preset
```

and directly after `MemoryStore.recordCreate`, add:

```ts
  async listPresets(userId: string): Promise<SavedPreset[]> {
    const mine = this.presets.get(userId);
    if (!mine) return [];
    // Code-unit order, which is the registry's key order.
    return detach([...mine.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    const p = this.presets.get(userId)?.get(name);
    return p && detach(p);
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    const mine = this.presets.get(userId) ?? new Map<string, SavedPreset>();
    if (!mine.has(preset.name) && mine.size >= cap) return "full";
    mine.set(preset.name, detach(preset));
    this.presets.set(userId, mine);
    return "saved";
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.presets.get(userId)?.delete(name) ?? false;
  }
```

- [ ] **Step 4: Run the Node contract**

Run: `npm test -- tests/store.test.ts -t "saved presets"`
Expected: PASS, 7 cases.

- [ ] **Step 5: The registry and the Durable Objects facade**

In `src/store-do.ts`, add `SavedPreset` to the type import from `./types.js`. In `RegistryDO`, directly after `recordCreate` (its last method), add:

```ts

  /**
   * `pr:<userId>:<name>` — a person's saved presets (designer spec D4).
   * Injective for the reason `us:` is: a user id is `u_[A-Za-z0-9_-]+` and a name
   * is a slug, so neither holds the separator. Storage lists keys in order, which
   * is the names' code-unit order.
   */
  async listPresets(userId: string): Promise<SavedPreset[]> {
    const map = await this.ctx.storage.list<SavedPreset>({ prefix: `pr:${userId}:` });
    return [...map.values()];
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.ctx.storage.get<SavedPreset>(`pr:${userId}:${name}`);
  }

  /**
   * The count and the write in one call. The object's input gate holds every
   * other request while this one awaits storage, so a second save cannot count
   * between this one's count and its write.
   */
  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    const key = `pr:${userId}:${preset.name}`;
    if ((await this.ctx.storage.get(key)) === undefined) {
      const held = await this.ctx.storage.list({ prefix: `pr:${userId}:`, limit: cap });
      if (held.size >= cap) return "full";
    }
    await this.ctx.storage.put(key, preset);
    return "saved";
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.ctx.storage.delete(`pr:${userId}:${name}`);
  }
```

In `DurableObjectStore`, directly after its `recordCreate`, add:

```ts

  async listPresets(userId: string): Promise<SavedPreset[]> {
    return this.registry.listPresets(userId);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.registry.getPreset(userId, name);
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    return this.registry.putPreset(userId, preset, cap);
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.registry.deletePreset(userId, name);
  }
```

- [ ] **Step 6: Run both programs**

Run: `npm run typecheck && npm run typecheck:worker && npm test -- tests/store.test.ts && npm run test:worker`
Expected: both typechecks clean; the Node contract passes; the worker suite passes, including the seven `saved presets` cases under `BellmanStore contract: DurableObjectStore`.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git commit -m "Presets in both stores: per person in the registry under pr:, the cap counted and written as one"
```

---

### Task 3: The preset routes

**Files:**
- Modify: `src/http/rooms.ts` (export `json`, `problem`, `methodNotAllowed`)
- Create: `src/http/presets.ts`
- Modify: `src/worker.ts`, `src/app.ts` (mount)
- Test: `tests/http-presets.test.ts`, `tests/http.test.ts` (one case), `worker-tests/preset-routes.test.ts`

**Interfaces:**
- Consumes: `checkPreset`, `MAX_PRESETS` (Task 1); `builtinPresets` (Task 1); the four store methods (Task 2); `RoomRouteDeps`, `RoomCaller` from `src/http/rooms.ts`.
- Produces: `presetRoutes(request: Request, deps: PresetRouteDeps): Promise<Response | undefined>`, `PresetRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">`, `MAX_PRESET_BYTES = 32 * 1024`. Wire: `GET /presets` answers `{ builtin: SavedPreset[], mine: SavedPreset[] }`; `PUT /presets/:name` answers the stored `SavedPreset`; `DELETE /presets/:name` answers 204.

- [ ] **Step 1: Write the failing route tests**

Create `tests/http-presets.test.ts`:

```ts
/**
 * The saved-preset routes (designer spec D5), driven as both servers drive them:
 * a Request in, a Response out, over a MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MAX_PRESET_BYTES, presetRoutes, type PresetRouteDeps } from "../src/http/presets.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MAX_PRESETS } from "../src/presets.js";
import { MemoryStore } from "../src/store.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

let store: MemoryStore;
let deps: PresetRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value. The room routes' tests use the same. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(() => {
  store = new MemoryStore();
  deps = { store, caller, panelOrigins: [PANEL] };
});

interface CallOptions { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; cookie?: string }

function call(key: string | null, path: string, over: CallOptions = {}) {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  let body: string | undefined;
  if (over.rawBody !== undefined) body = over.rawBody;
  else if (over.body !== undefined) body = JSON.stringify(over.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return presetRoutes(new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers, body }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

const preset = (over: Record<string, unknown> = {}) => ({
  description: "Review where the reviewer may ask too",
  mode: "pair",
  roles: {
    author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work." },
    reviewer: { can: ["send", "request_actions", "respond_actions"] },
  },
  default_role: "reviewer",
  creator_role: "author",
  ...over,
});

const put = (key: string, name: string, body: unknown = preset()) => call(key, `/presets/${name}`, { method: "PUT", body });

describe("the preset routes", () => {
  it("leave a path outside /presets to the next module", async () => {
    expect(await call(DEV_KEY.jesse, "/rooms")).toBeUndefined();
  });

  it("refuse without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/presets", { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("list the three built-ins expanded, and the caller's own presets and nobody else's", async () => {
    let body = await bodyOf(await call(DEV_KEY.jesse, "/presets"));
    expect((body.builtin as { name: string }[]).map((p) => p.name)).toEqual(["pair", "swarm", "review"]);
    expect(body.mine).toEqual([]);
    expect((await put(DEV_KEY.jesse, "my_review"))!.status).toBe(200);
    body = await bodyOf(await call(DEV_KEY.jesse, "/presets"));
    expect((body.mine as { name: string }[]).map((p) => p.name)).toEqual(["my_review"]);
    expect((await bodyOf(await call(DEV_KEY.peer, "/presets"))).mine).toEqual([]);
  });

  it("save a preset and answer with it as stored", async () => {
    const res = (await put(DEV_KEY.jesse, "my_review"))!;
    expect(res.status).toBe(200);
    const saved = await bodyOf(res);
    expect(saved).toMatchObject({ name: "my_review", mode: "pair", heartbeat_on: null, default_role: "reviewer", creator_role: "author" });
    expect(saved.roles).toEqual({
      author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: false },
      reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
    });
    expect(typeof saved.updated_at).toBe("string");
    expect(await store.getPreset("u_jesse", "my_review")).toEqual(saved);
  });

  it("refuse what the room validator refuses, in its words", async () => {
    const res = (await put(DEV_KEY.jesse, "my_review", preset({ creator_role: "boss" })))!;
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({
      error: "invalid_manifest",
      error_description: 'creator_role "boss" is not defined in roles (defined: author, reviewer)',
    });
  });

  it("refuse a name outside the grammar, a built-in's name, and a body naming another preset", async () => {
    expect((await put(DEV_KEY.jesse, "My-Review"))!.status).toBe(400);
    const builtin = (await put(DEV_KEY.jesse, "review"))!;
    expect(builtin.status).toBe(409);
    expect(await bodyOf(builtin)).toMatchObject({ error: "builtin" });
    expect((await put(DEV_KEY.jesse, "my_review", preset({ name: "other" })))!.status).toBe(400);
  });

  it("refuse a new name past the cap, and still replace one already saved", async () => {
    for (let i = 0; i < MAX_PRESETS; i++) expect((await put(DEV_KEY.jesse, `p${i}`))!.status).toBe(200);
    const full = (await put(DEV_KEY.jesse, "one_more"))!;
    expect(full.status).toBe(409);
    expect(await bodyOf(full)).toMatchObject({ error: "full" });
    expect((await put(DEV_KEY.jesse, "p0", preset({ description: "again" })))!.status).toBe(200);
  });

  it("refuse a cookie write without the panel's Origin, and take one with it", async () => {
    const bare = (await call(null, "/presets/my_review", { method: "PUT", body: preset(), cookie: DEV_KEY.jesse }))!;
    expect(bare.status).toBe(403);
    const fromPanel = (await call(null, "/presets/my_review", { method: "PUT", body: preset(), cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(fromPanel.status).toBe(200);
    expect(fromPanel.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("refuse a body over the bound before reading it, and a body that is not a JSON object", async () => {
    const over = (await call(DEV_KEY.jesse, "/presets/my_review", {
      method: "PUT", rawBody: "not json", headers: { "content-length": String(MAX_PRESET_BYTES + 1) },
    }))!;
    expect(over.status).toBe(413);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "PUT", rawBody: "not json" }))!.status).toBe(400);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "PUT", body: ["a"] }))!.status).toBe(400);
  });

  it("delete the caller's own, and answer 404 for one they do not have, another person's included", async () => {
    await put(DEV_KEY.jesse, "my_review");
    expect((await call(DEV_KEY.peer, "/presets/my_review", { method: "DELETE" }))!.status).toBe(404);
    expect(await store.getPreset("u_jesse", "my_review")).toBeDefined();
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "DELETE" }))!.status).toBe(204);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "DELETE" }))!.status).toBe(404);
  });

  it("answer the panel's preflight, and 405 for a method a path does not take", async () => {
    const pre = (await call(null, "/presets/my_review", { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect((await call(DEV_KEY.jesse, "/presets", { method: "POST", body: {} }))!.status).toBe(405);
    expect((await call(DEV_KEY.jesse, "/presets/my_review"))!.status).toBe(405);
  });
});
```

In `tests/http.test.ts`, inside its first `describe`, add:

```ts
  it("serves the preset routes beside the room routes", async () => {
    const res = await fetch(`${base}/presets`, { headers: { authorization: "Bearer qk_dev_jesse" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { builtin: unknown[] }).builtin).toHaveLength(3);
  });
```

Create `worker-tests/preset-routes.test.ts`:

```ts
/**
 * The Worker mounts the preset routes over the real registry (designer spec D5).
 * The routes' rules are pinned in tests/http-presets.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the preset routes through the Worker", () => {
  it("list the built-ins, save a preset into the registry, and list it back", async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    const list = await call("/presets", { headers: auth });
    expect(list.status, await list.clone().text()).toBe(200);
    expect(((await list.json()) as { builtin: unknown[] }).builtin).toHaveLength(3);
    const body = { mode: "pair", roles: { lead: { can: ["send"] } }, default_role: "lead", creator_role: "lead" };
    const saved = await call("/presets/solo_lead", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const mine = ((await (await call("/presets", { headers: auth })).json()) as { mine: { name: string }[] }).mine;
    expect(mine.map((p) => p.name)).toEqual(["solo_lead"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/http-presets.test.ts tests/http.test.ts`
Expected: FAIL: `Cannot find module '../src/http/presets.js'` for the first file; in the second, the new case answers 404.

- [ ] **Step 3: Share three helpers from the room routes**

In `src/http/rooms.ts`, change `const json = (`, `const problem = (` and `const methodNotAllowed = (` to `export const json = (`, `export const problem = (` and `export const methodNotAllowed = (`.

- [ ] **Step 4: Write `src/http/presets.ts`**

```ts
/**
 * The saved-preset routes (designer spec D5), beside the room routes and on
 * their rules: the same caller, CORS for the panel's origins, the same
 * preflight, and the CSRF check on every write a cookie makes. Every read and
 * write is keyed by the caller's own user id.
 */
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { builtinPresets } from "../manifest.js";
import { MAX_PRESETS, checkPreset } from "../presets.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type PresetRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

// ponytail: 32 KB, not tuned. Sixteen roles of six verbs and 300-character descriptions is a few KB.
export const MAX_PRESET_BYTES = 32 * 1024;

const LIST = /^\/presets$/;
const ONE = /^\/presets\/([^/]+)$/;

/** `undefined` for a path outside `/presets`, so the server carries on; everything under it is answered here. */
export async function presetRoutes(request: Request, deps: PresetRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/presets" && !path.startsWith("/presets/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    if (LIST.test(path)) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await listPresets(request, origin, deps);
    }
    const one = ONE.exec(path);
    if (one) {
      if (request.method !== "PUT" && request.method !== "DELETE") return methodNotAllowed("PUT, DELETE", origin);
      return await writePreset(request, one[1], origin, deps);
    }
    return problem(404, "not_found", "no such route", origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server; nothing was saved", origin);
  }
}

async function listPresets(request: Request, origin: string | undefined, deps: PresetRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  return json(200, { builtin: builtinPresets(), mine: await deps.store.listPresets(who.identity.userId) }, origin);
}

async function writePreset(request: Request, rawName: string, origin: string | undefined, deps: PresetRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return problem(400, "invalid_request", "the name is not valid percent-encoding", origin);
  }
  const userId = who.identity.userId;

  if (request.method === "DELETE") {
    if (!(await deps.store.deletePreset(userId, name))) {
      return problem(404, "not_found", `you have no preset named ${JSON.stringify(name)}`, origin);
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // The length before the body, as the surface write checks it: a present length must be a digit string.
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) {
    return problem(400, "invalid_request", "Content-Length must be a non-negative integer", origin);
  }
  if (Number(length ?? "0") > MAX_PRESET_BYTES) {
    return problem(413, "too_large", `a preset is at most ${MAX_PRESET_BYTES} bytes of JSON`, origin);
  }
  const notObject = () => problem(400, "invalid_request", "the body must be a JSON object: the preset", origin);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return notObject();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return notObject();

  const check = checkPreset(name, body, Date.now());
  if (!check.ok) return problem(check.status, check.error, check.description, origin);
  if ((await deps.store.putPreset(userId, check.preset, MAX_PRESETS)) === "full") {
    return problem(409, "full", `you have ${MAX_PRESETS} presets, the most one person keeps; delete one first`, origin);
  }
  return json(200, check.preset, origin);
}
```

- [ ] **Step 5: Mount it in both servers**

In `src/worker.ts`, import `import { presetRoutes } from "./http/presets.js";` beside the `roomRoutes` import, and directly after the room routes' `if (url.pathname === "/rooms" || ...) { ... }` block, add:

```ts
    // The saved presets (designer spec D5), on the room routes' rules and behind the same guard.
    if (url.pathname === "/presets" || url.pathname.startsWith("/presets/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await presetRoutes(request, {
        store,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }
```

In `src/app.ts`, import `import { presetRoutes } from "./http/presets.js";` beside the `roomRoutes` import, and add `type Response as ExpressResponse` to the `express` import. Replace the whole `app.use("/rooms", async (req, res) => { ... });` statement (keep the doc comment above it, and change its first sentence to "The room routes (#183) and the preset routes, mounted ahead of the JSON body parser") with:

```ts
  /** One shared route module, translated: Node's request in as the web one it reads, its Response out. */
  const serve = (routes: (request: Request) => Promise<Response | undefined>) =>
    async (req: ExpressRequest, res: ExpressResponse) => {
      const answer = await routes(toRequest(req));
      if (!answer) {
        res.status(404).send("Not found");
        return;
      }
      res.status(answer.status);
      answer.headers.forEach((value, name) => res.setHeader(name, value));
      if (!answer.body) {
        res.end();
        return;
      }
      Readable.fromWeb(answer.body as unknown as NodeReadableStream).pipe(res);
    };
  const caller = async (request: Request) => {
    const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
    return identity ? { identity, via: "bearer" as const } : null;
  };
  app.use("/rooms", serve((request) => roomRoutes(request, { store, blobs, caller, panelOrigins: [] })));
  app.use("/presets", serve((request) => presetRoutes(request, { store, caller, panelOrigins: [] })));
```

- [ ] **Step 6: Run the tests, both typechecks, and the worker suite**

Run: `npm test -- tests/http-presets.test.ts tests/http.test.ts tests/http-rooms.test.ts && npm run typecheck && npm run typecheck:worker && npm run test:worker`
Expected: PASS, the room routes' tests unchanged; both typechecks clean; the worker suite passes with `the preset routes through the Worker`.

- [ ] **Step 7: Commit**

```bash
git add src/http/rooms.ts src/http/presets.ts src/worker.ts src/app.ts tests/http-presets.test.ts tests/http.test.ts worker-tests/preset-routes.test.ts
git commit -m "The preset routes beside the room routes: list, save through the room validator, delete, per person, on both servers"
```

---

### Task 4: `bellman_start` cites a saved preset

**Files:**
- Modify: `src/manifest.ts` (`CiteShape`, `resolveManifest`'s cite branch)
- Modify: `src/tools/start.ts`
- Test: `tests/tools/start-presets.test.ts`

**Interfaces:**
- Consumes: `PresetNameShape` (Task 1), `asManifest` (Task 1), `getPreset` and `listPresets` (Task 2).
- Produces: `bellman_start` accepting `manifest: { room, purpose?, preset: <any preset name> }`; the refusal `invalid manifest — unknown preset "<name>" (built-in: pair, swarm, review; yours: <names or none>)`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/start-presets.test.ts`:

```ts
/**
 * bellman_start citing a preset its caller saved (designer spec D6): looked up
 * before resolving, expanded at start like every room, and refused by name when
 * it is nobody's the caller can cite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import type { SavedPreset } from "../../src/types.js";

let h: Harness;
let jesse: Peer;
beforeEach(async () => {
  h = new Harness();
  jesse = await h.connect(DEV_KEY.jesse);
});
afterEach(async () => {
  await h.close();
});

const saved = (name: string, over: Partial<SavedPreset> = {}): SavedPreset => ({
  name,
  description: null,
  mode: "pair",
  heartbeat_on: null,
  roles: {
    author: { can: ["send", "invite", "revoke", "write_surface"], description: "Brought the work.", reports: false },
    reviewer: { can: ["send", "request_actions"], description: null, reports: false },
  },
  default_role: "reviewer",
  creator_role: "author",
  updated_at: "2026-10-09T12:00:00.000Z",
  ...over,
});

const start = (preset: string) => jesse.call("bellman_start", { manifest: { room: "Q3 review", preset }, brief: brief() });

describe("bellman_start citing a saved preset", () => {
  it("starts a room whose roles are the preset's, recorded as authored", async () => {
    await h.store.putPreset("u_jesse", saved("my_review"), 20);
    const out = await start("my_review");
    expect(out.isError, out.text).toBe(false);
    const room = out.data.room as { preset: string | null; your_role: string; roles: Record<string, string[]> };
    expect(room.preset).toBeNull();
    expect(room.your_role).toBe("author");
    expect(room.roles).toEqual({ author: ["send", "invite", "revoke", "write_surface"], reviewer: ["send", "request_actions"] });
  });

  it("leaves a started room alone when its preset is edited, then deleted", async () => {
    await h.store.putPreset("u_jesse", saved("my_review"), 20);
    const id = String((await start("my_review")).data.session_id);
    await h.store.putPreset("u_jesse", saved("my_review", {
      roles: { solo: { can: ["send"], description: null, reports: false } }, default_role: "solo", creator_role: "solo",
    }), 20);
    await h.store.deletePreset("u_jesse", "my_review");
    expect(Object.keys((await h.store.getSession(id))!.manifest.roles).sort()).toEqual(["author", "reviewer"]);
  });

  it("refuses a name it cannot find, naming the built-ins and the caller's own", async () => {
    await h.store.putPreset("u_jesse", saved("alpha"), 20);
    await h.store.putPreset("u_jesse", saved("beta"), 20);
    const out = await start("gamma");
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — unknown preset "gamma" (built-in: pair, swarm, review; yours: alpha, beta)');
  });

  it("does not let one person cite another's preset", async () => {
    await h.store.putPreset("u_peer", saved("theirs"), 20);
    const out = await start("theirs");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("yours: none");
  });

  // Passes before the change too: the guard that the built-ins still win.
  it("still resolves a built-in by name", async () => {
    const out = await start("review");
    expect(out.isError, out.text).toBe(false);
    expect((out.data.room as { preset: string }).preset).toBe("review");
  });

  it("refuses a saved preset the validator no longer accepts, in the validator's words", async () => {
    await h.store.putPreset("u_jesse", saved("stale", { creator_role: "gone" }), 20);
    const out = await start("stale");
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — creator_role "gone" is not defined in roles');
  });

  it("tells the agent it may cite a saved preset, and where they are made", async () => {
    const { tools } = await jesse.listTools();
    expect(tools.find((t) => t.name === "bellman_start")!.description)
      .toContain("or the name of a preset you saved at dash.bellman.sh/presets");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- tests/tools/start-presets.test.ts`
Expected: FAIL on every case but "still resolves a built-in by name": the SDK's input validation refuses `preset: "my_review"` (`Invalid option: expected one of "pair"|"swarm"|"review"`), and the description lacks the clause.

- [ ] **Step 3: Let the cite arm carry any name**

In `src/manifest.ts`, in `CiteShape`, change `preset: z.enum(PRESET_NAMES),` to `preset: PresetNameShape,`. In `resolveManifest`'s cite branch (`if ("preset" in v) {`), the check above it has already refused any name that is not a built-in, so narrow it for the compiler: change `const body = PRESETS[v.preset];` to `const body = PRESETS[v.preset as PresetName];` and `preset: v.preset,` to `preset: v.preset as PresetName,`.

- [ ] **Step 4: Look a saved name up in `bellman_start`**

In `src/tools/start.ts`, change the manifest import to `import { ManifestError, ManifestShape, PRESET_NAMES, resolveManifest } from "../manifest.js";` and add `import { asManifest } from "../presets.js";`.

In the description, change the line

```
    { room, purpose?, preset: "pair" | "swarm" | "review" } — or author roles:
```

to

```
    { room, purpose?, preset: "pair" | "swarm" | "review", or the name of a preset you saved at dash.bellman.sh/presets } — or author roles:
```

In the handler, replace `manifest = resolveManifest(manifestInput);` (inside the existing `try`) with:

```ts
        // A cited name that is not a built-in is one of the caller's saved presets
        // (designer spec D6): the room is authored from it here, so resolveManifest
        // only ever sees a built-in cite or an author arm and stays pure. Unknown
        // everywhere, the refusal names both lists.
        let input: unknown = manifestInput;
        if ("preset" in manifestInput && !(PRESET_NAMES as readonly string[]).includes(manifestInput.preset)) {
          const saved = await s.getPreset(identity.userId, manifestInput.preset);
          if (!saved) {
            const yours = (await s.listPresets(identity.userId)).map((p) => p.name);
            throw new ManifestError(
              `unknown preset "${manifestInput.preset}" (built-in: ${PRESET_NAMES.join(", ")}; yours: ${yours.length > 0 ? yours.join(", ") : "none"})`,
            );
          }
          input = asManifest(saved, manifestInput.room, manifestInput.purpose);
        }
        manifest = resolveManifest(input);
```

The existing `catch` turns the `ManifestError` into `invalid manifest — <message>`.

- [ ] **Step 5: Run the new tests and the ones that pin the start tool**

Run: `npm test -- tests/tools/start-presets.test.ts tests/tools/surface.test.ts tests/manifest.test.ts tests/room-manifest-skill.test.ts tests/tools/handshake.test.ts`
Expected: PASS, every file.

- [ ] **Step 6: Commit**

```bash
git add src/manifest.ts src/tools/start.ts tests/tools/start-presets.test.ts
git commit -m "bellman_start cites a saved preset by name: looked up before resolving, expanded at start, refused naming both lists"
```

---

### Task 5: The export's format, the docs, and the bellman PR

**Files:**
- Create: `tests/room-yaml-export.test.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `skills/room-manifest/SKILL.md`

**Interfaces:**
- Consumes: `loadRoomManifest(cwd: string)` in `src/bridge.ts`; `resolveManifest`.
- Produces: the `EXPORTED` text, which dash's `src/lib/presets.test.ts` (Task 6) repeats byte for byte.

- [ ] **Step 1: Pin the export the panel writes**

Create `tests/room-yaml-export.test.ts`:

```ts
/**
 * The room.yaml the panel's Copy button writes (designer spec D8) loads through
 * the bridge's loader and starts the room it spells out. EXPORTED is the dash
 * repo's src/lib/presets.test.ts fixture byte for byte: change one, change both.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoomManifest } from "../src/bridge.js";
import { resolveManifest } from "../src/manifest.js";

const EXPORTED = `room: "my_review"
purpose: "Review where the reviewer may ask too"
mode: "pair"
heartbeat_on: "5m"
roles:
  "author":
    can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"]
    description: "Brought the work."
    reports: true
  "reviewer":
    can: ["send", "request_actions", "respond_actions"]
    reports: false
default_role: "reviewer"
creator_role: "author"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the panel's room.yaml export", () => {
  it("loads through the bridge and starts the room it spells out", () => {
    const dir = mkdtempSync(join(tmpdir(), "bellman-export-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".bellman"));
    writeFileSync(join(dir, ".bellman", "room.yaml"), EXPORTED);
    const m = resolveManifest(loadRoomManifest(dir));
    expect(m).toMatchObject({
      room: "my_review", purpose: "Review where the reviewer may ask too", mode: "pair", preset: null,
      defaultRole: "reviewer", creatorRole: "author", heartbeatOnMs: 300_000,
    });
    expect(m.roles).toEqual({
      author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
      reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
    });
  });
});
```

- [ ] **Step 2: Run it, then make it fail on purpose**

Run: `npm test -- tests/room-yaml-export.test.ts`
Expected: PASS. It pins a format and changes no code, so give it its control: change `"respond_actions"]` on the reviewer's `can` line to `"respond"]`, run it again, see it FAIL with `roles.reviewer.can.2: Invalid option`, and restore the line.

- [ ] **Step 3: Measure the start tool's cost**

The method §11 documents. From the repo root:

```bash
npx tsx -e '
(async () => {
  const { Harness, DEV_KEY } = await import("./tests/helpers/harness.js");
  const h = new Harness(); const p = await h.connect(DEV_KEY.jesse);
  const { tools } = await p.listTools();
  process.stdout.write(JSON.stringify(tools));
  await h.close();
})();
' > /tmp/bellman-tools-presets.json
python3 -c '
import json, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
tools = json.load(open("/tmp/bellman-tools-presets.json"))
count = lambda t: len(enc.encode(json.dumps(t, separators=(",", ":"))))
print("total", sum(count(t) for t in tools))
print("bellman_start", count(next(t for t in tools if t["name"] == "bellman_start")))
'
```

Run the same at `git merge-base origin/main HEAD` in a temporary worktree (`git worktree add --detach /tmp/base-presets <sha>`, link `node_modules`, `npm run build:ui`, run, then `git worktree remove --force /tmp/base-presets`) for the figure before. Write both totals and `bellman_start`'s change down.

- [ ] **Step 4: The docs**

`README.md`, the tool table's `bellman_start` row: after "Create a room from a manifest" add ", or from a preset you saved in the panel". Under the panel's routes (the list of `GET /rooms...` bullets), add:

```markdown
- `GET /presets` lists the built-in presets and your saved ones; `PUT /presets/:name` saves one, refused in the room validator's words when `bellman_start` would refuse it; `DELETE /presets/:name` deletes one. At most 20 a person, names in the role-key grammar, never a built-in's. An agent starts a room from one with `bellman_start { manifest: { room, preset: "<name>" } }`; the room is expanded at start, so editing a preset never changes a room that exists.
```

`docs/ARCHITECTURE.md`:
- The panel's route paragraph (the one listing `GET /rooms/:id/surface`): add "`GET /presets`, `PUT`/`DELETE /presets/:name` for a person's saved presets (designer spec), on the same caller and CSRF rules".
- The `RDO` node's label in the storage diagram: add `saved presets` to its list (`create counts, creator index,<br/>joined-rooms index, saved presets`).
- §11: the Tool definitions row gets the total Step 3 measured. Before the newest re-measurement paragraph, add one in the same form: the date, the total, the difference from Step 3's figure at the merge base, and that all of it is `bellman_start`'s, whose `preset` is now any name rather than three, plus the clause naming the panel. Frontmatter: `last-updated` today, `last-verified-against-source` to `git rev-parse --short HEAD`.

`skills/room-manifest/SKILL.md`, the Step 2a block: change `preset: review                  # pair | swarm | review` to `preset: review                  # pair | swarm | review, or one you saved at dash.bellman.sh/presets`.

- [ ] **Step 5: Verify, then push and open the PR**

Run: `npm run verify && npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
Expected: green; the dry run bundles.

```bash
git add tests/room-yaml-export.test.ts README.md docs/ARCHITECTURE.md skills/room-manifest/SKILL.md
git commit -m "The export's format pinned against the bridge's loader, and the docs for saved presets"
git push -u origin mcfearsome/room-designer
gh pr create --repo bellman-sh/bellman --base main --head mcfearsome/room-designer --title "Saved presets: per-person room shapes, an API for the panel, and bellman_start citing them by name" --body-file /tmp/presets-pr-body.md
```

Write `/tmp/presets-pr-body.md` first: what it adds, the three rulings (R1 to R3), the trust note from the spec, the measured token change, the verify totals, and that dash's Presets page (Tasks 6 to 8) needs this deployed first.

---

### Task 6: Dash: the client and the designer's rules

**Files:**
- Modify: `src/lib/api.ts` (types, `listPresets`, `putPreset`, `deletePreset`)
- Create: `src/lib/presets.ts`
- Modify: `src/test-fixtures.ts` (`preset`)
- Test: `src/lib/presets.test.ts`

**Interfaces:**
- Consumes: the wire from Task 3.
- Produces, in `src/lib/api.ts`: `Preset`, `PresetList`, `PresetBody`, `listPresets(): Promise<PresetList>`, `putPreset(name, body): Promise<Preset>`, `deletePreset(name): Promise<void>`.
- Produces, in `src/lib/presets.ts`: `VERBS`, `Verb`, `Draft`, `DraftRole`, `Field`, `NAME_MAX = 31`, `draftFrom(p: Preset, clone?: boolean): Draft`, `emptyDraft(): Draft`, `bodyOf(d: Draft): PresetBody`, `renameRole(d, from, to): Draft`, `removeRole(d, index): Draft`, `joinerRows(d)`, `fieldOf(message): Field | null`, `toYaml(p): string`.

- [ ] **Step 1: Make the dash worktree**

```bash
D=/Users/mcfearsome/src/github.com/bellman-sh/dash
DASH="${TMPDIR:-/tmp}/dash-presets"
git -C "$D" fetch -q origin
git -C "$D" worktree add -b mcfearsome/presets "$DASH" origin/main
ln -s "$D/node_modules" "$DASH/node_modules"
```

Every dash path below is relative to `$DASH`. Never stage `node_modules`.

- [ ] **Step 2: Write the failing tests**

In `src/test-fixtures.ts`, add `Preset` to the type import from `@/lib/api`, and append:

```ts
export const preset = (over: Partial<Preset> = {}): Preset => ({
  name: "my_review",
  description: "Review where the reviewer may ask too",
  mode: "pair",
  heartbeat_on: "5m",
  roles: {
    author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
    reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
  },
  default_role: "reviewer",
  creator_role: "author",
  updated_at: "2026-10-09T12:00:00.000Z",
  ...over,
});
```

Create `src/lib/presets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bodyOf, draftFrom, emptyDraft, fieldOf, joinerRows, removeRole, renameRole, toYaml } from "@/lib/presets";
import { preset } from "@/test-fixtures";

/** Byte for byte the bellman repo's tests/room-yaml-export.test.ts EXPORTED: change one, change both. */
const EXPORTED = `room: "my_review"
purpose: "Review where the reviewer may ask too"
mode: "pair"
heartbeat_on: "5m"
roles:
  "author":
    can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"]
    description: "Brought the work."
    reports: true
  "reviewer":
    can: ["send", "request_actions", "respond_actions"]
    reports: false
default_role: "reviewer"
creator_role: "author"
`;

describe("draftFrom and bodyOf", () => {
  it("hold a preset as the editor shows it, and give back the body a PUT carries", () => {
    const d = draftFrom(preset());
    expect(d).toEqual({
      name: "my_review",
      description: "Review where the reviewer may ask too",
      mode: "pair",
      heartbeat: { on: true, amount: 5, unit: "m" },
      roles: [
        { key: "author", description: "Brought the work.", can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], reports: true },
        { key: "reviewer", description: "", can: ["send", "request_actions", "respond_actions"], reports: false },
      ],
      default_role: "reviewer",
      creator_role: "author",
    });
    const p = preset();
    expect(bodyOf(d)).toEqual({
      description: p.description, mode: p.mode, heartbeat_on: p.heartbeat_on, roles: p.roles, default_role: p.default_role, creator_role: p.creator_role,
    });
  });

  it("name a clone after its source, within the grammar's 31 characters", () => {
    expect(draftFrom(preset({ name: "review" }), true).name).toBe("review_copy");
    expect(draftFrom(preset({ name: "a".repeat(31) }), true).name).toHaveLength(31);
  });

  it("put a role's verbs in the server's order", () => {
    const d = draftFrom(preset({ roles: { lead: { can: ["write_surface", "send"], description: null, reports: false } }, default_role: "lead", creator_role: "lead" }));
    expect(d.roles[0].can).toEqual(["send", "write_surface"]);
  });

  it("send blanks as null, and a heartbeat that is off as null", () => {
    const d = { ...emptyDraft(), description: "  ", roles: [{ key: "lead", description: " ", can: ["send" as const], reports: false }] };
    expect(bodyOf(d)).toEqual({
      description: null, mode: "pair", heartbeat_on: null,
      roles: { lead: { can: ["send"], description: null, reports: false } },
      default_role: "lead", creator_role: "lead",
    });
  });
});

describe("renameRole and removeRole", () => {
  it("carry the default and creator pickers with a renamed role", () => {
    const d = renameRole(draftFrom(preset()), "reviewer", "critic");
    expect(d.roles.map((r) => r.key)).toEqual(["author", "critic"]);
    expect([d.default_role, d.creator_role]).toEqual(["critic", "author"]);
  });

  it("move a picker that named a removed role to the first role left", () => {
    const d = removeRole(draftFrom(preset()), 0);
    expect(d.roles.map((r) => r.key)).toEqual(["reviewer"]);
    expect([d.default_role, d.creator_role]).toEqual(["reviewer", "reviewer"]);
  });
});

describe("joinerRows", () => {
  it("show who reports only when the room has a heartbeat, as the join screen does", () => {
    const d = draftFrom(preset());
    expect(joinerRows(d)).toEqual([
      { role: "author", may: "send, invite, revoke, request_actions, respond_actions, write_surface", reports: true, joinsAs: false, creator: true },
      { role: "reviewer", may: "send, request_actions, respond_actions", reports: false, joinsAs: true, creator: false },
    ]);
    expect(joinerRows({ ...d, heartbeat: { ...d.heartbeat, on: false } })[0].reports).toBe(false);
    expect(joinerRows({ ...d, roles: [{ ...d.roles[0], can: [] }] })[0].may).toBe("read only");
  });
});

describe("fieldOf", () => {
  it.each([
    ["preset names must match [a-z][a-z0-9_]{0,30}", "name"],
    ['"review" is a built-in preset; clone it under another name', "name"],
    ["description: Too big: expected string to have <=300 characters", "description"],
    ['heartbeat_on must be between 30s and 1h (got "10s")', "heartbeat"],
    ['role "lead" sets reports: true but does not hold the verb "send" (it holds: none)', "roles"],
    ["roles.lead.can.1: Invalid option", "roles"],
    ['default_role "x" is not defined in roles (defined: lead)', "default_role"],
    ['creator_role "x" is not defined in roles (defined: lead)', "creator_role"],
    ["you have 20 presets, the most one person keeps; delete one first", null],
  ])("puts %j at %s", (message, field) => {
    expect(fieldOf(message)).toBe(field);
  });
});

describe("toYaml", () => {
  it("writes the author arm with every role spelled out: the export the bridge loads", () => {
    expect(toYaml(preset())).toBe(EXPORTED);
  });

  it("leaves out a purpose, a heartbeat and a role description that are not there", () => {
    const yaml = toYaml(preset({ description: null, heartbeat_on: null }));
    expect(yaml).not.toContain("purpose:");
    expect(yaml).not.toContain("heartbeat_on:");
    expect(yaml.match(/description:/g)).toHaveLength(1);
  });

  it("keeps any string inside its own quoted scalar", () => {
    const yaml = toYaml(preset({ description: 'a": b\n- c' }));
    expect(yaml).toContain('purpose: "a\\": b\\n- c"');
    expect(yaml.split("\n")).toHaveLength(EXPORTED.split("\n").length);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/lib/presets.test.ts`
Expected: FAIL: `Failed to resolve import "@/lib/presets"`.

- [ ] **Step 4: The client**

In `src/lib/api.ts`, after `upgradeUrl`, append:

```ts
/** Mirrors `SavedPreset` in the Worker's src/types.ts: a room shape without the room. `updated_at` is null for a built-in. */
export interface Preset {
  name: string;
  description: string | null;
  mode: "pair" | "swarm";
  heartbeat_on: string | null;
  roles: Record<string, { can: string[]; description: string | null; reports: boolean }>;
  default_role: string;
  creator_role: string;
  updated_at: string | null;
}

/** Mirrors `GET /presets`. */
export interface PresetList {
  builtin: Preset[];
  mine: Preset[];
}

/** What a PUT carries: a preset without its name, which the path gives, or its time. */
export type PresetBody = Omit<Preset, "name" | "updated_at">;

export const listPresets = (): Promise<PresetList> => request<PresetList>("/presets").then((r) => r.body);

export const putPreset = (name: string, body: PresetBody): Promise<Preset> =>
  request<Preset>(`/presets/${enc(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.body);

export const deletePreset = (name: string): Promise<void> =>
  request<void>(`/presets/${enc(name)}`, { method: "DELETE" }).then(() => undefined);
```

- [ ] **Step 5: The rules**

Create `src/lib/presets.ts`:

```ts
/**
 * The designer's rules, pure (designer spec D7, D8): a preset as the draft the
 * editor holds, a draft back to the body a PUT carries, the joiner's view, which
 * field a server refusal names, and the room.yaml a preset exports as.
 */
import type { Preset, PresetBody } from "@/lib/api";

/** The six verbs, in the server's VERBS order. */
export const VERBS = ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"] as const;
export type Verb = (typeof VERBS)[number];

/** The longest name the server takes: the role-key grammar's 31. */
export const NAME_MAX = 31;

export interface DraftRole {
  key: string;
  description: string;
  can: Verb[];
  reports: boolean;
}

export interface Draft {
  name: string;
  description: string;
  mode: "pair" | "swarm";
  heartbeat: { on: boolean; amount: number; unit: "s" | "m" | "h" };
  roles: DraftRole[];
  default_role: string;
  creator_role: string;
}

export type Field = "name" | "description" | "mode" | "heartbeat" | "roles" | "default_role" | "creator_role";

const DURATION = /^(\d{1,4})(s|m|h)$/;

/** A preset as the editor holds it. A clone is named `<name>_copy`, clipped to the grammar's length. */
export function draftFrom(p: Preset, clone = false): Draft {
  const beat = p.heartbeat_on ? DURATION.exec(p.heartbeat_on) : null;
  return {
    name: clone ? `${p.name}_copy`.slice(0, NAME_MAX) : p.name,
    description: p.description ?? "",
    mode: p.mode,
    heartbeat: beat ? { on: true, amount: Number(beat[1]), unit: beat[2] as "s" | "m" | "h" } : { on: false, amount: 5, unit: "m" },
    roles: Object.entries(p.roles).map(([key, r]) => ({
      key,
      description: r.description ?? "",
      can: VERBS.filter((v) => r.can.includes(v)),
      reports: r.reports,
    })),
    default_role: p.default_role,
    creator_role: p.creator_role,
  };
}

export const emptyDraft = (): Draft => ({
  name: "",
  description: "",
  mode: "pair",
  heartbeat: { on: false, amount: 5, unit: "m" },
  roles: [{ key: "lead", description: "", can: ["send"], reports: false }],
  default_role: "lead",
  creator_role: "lead",
});

/** The body a PUT carries: blanks become null, and a heartbeat that is off is null. */
export function bodyOf(d: Draft): PresetBody {
  const roles: PresetBody["roles"] = {};
  for (const r of d.roles) roles[r.key] = { can: [...r.can], description: r.description.trim() || null, reports: r.reports };
  return {
    description: d.description.trim() || null,
    mode: d.mode,
    heartbeat_on: d.heartbeat.on ? `${d.heartbeat.amount}${d.heartbeat.unit}` : null,
    roles,
    default_role: d.default_role,
    creator_role: d.creator_role,
  };
}

/** Rename a role, and the default and creator pickers with it, so a rename never leaves them naming nothing. */
export function renameRole(d: Draft, from: string, to: string): Draft {
  return {
    ...d,
    roles: d.roles.map((r) => (r.key === from ? { ...r, key: to } : r)),
    default_role: d.default_role === from ? to : d.default_role,
    creator_role: d.creator_role === from ? to : d.creator_role,
  };
}

/** Remove a role; a picker that named it moves to the first role left. */
export function removeRole(d: Draft, index: number): Draft {
  const gone = d.roles[index]?.key;
  const roles = d.roles.filter((_, i) => i !== index);
  const first = roles[0]?.key ?? "";
  return {
    ...d,
    roles,
    default_role: d.default_role === gone ? first : d.default_role,
    creator_role: d.creator_role === gone ? first : d.creator_role,
  };
}

/** What a joiner is shown, seat by seat. A seat reports only when the room has a heartbeat: the cadence and the seat, as the join screen reads it. */
export function joinerRows(d: Draft): { role: string; may: string; reports: boolean; joinsAs: boolean; creator: boolean }[] {
  return d.roles.map((r) => ({
    role: r.key,
    may: r.can.length > 0 ? r.can.join(", ") : "read only",
    reports: r.reports && d.heartbeat.on,
    joinsAs: r.key === d.default_role,
    creator: r.key === d.creator_role,
  }));
}

const FIELDS: [RegExp, Field][] = [
  [/^preset names |built-in preset|^the body names preset /, "name"],
  [/^description\b/, "description"],
  [/^mode\b/, "mode"],
  [/^heartbeat_on\b/, "heartbeat"],
  [/^default_role\b/, "default_role"],
  [/^creator_role\b/, "creator_role"],
  [/^roles?\b/, "roles"],
];

/** Which field a server refusal is about, by what it names first; null for the top of the form. */
export function fieldOf(message: string): Field | null {
  return FIELDS.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The room.yaml a preset exports as (D8): the author arm with every role spelled
 * out, never `preset: <name>`, because the file is read by teammates who do not
 * hold the preset. Every string and key double-quoted, which YAML reads as JSON
 * reads it. The bellman repo's tests/room-yaml-export.test.ts loads this output
 * with the bridge's loader.
 */
export function toYaml(p: Pick<Preset, "name" | "description" | "mode" | "heartbeat_on" | "roles" | "default_role" | "creator_role">): string {
  const lines = [`room: ${q(p.name)}`];
  if (p.description) lines.push(`purpose: ${q(p.description)}`);
  lines.push(`mode: ${q(p.mode)}`);
  if (p.heartbeat_on) lines.push(`heartbeat_on: ${q(p.heartbeat_on)}`);
  lines.push("roles:");
  for (const [key, r] of Object.entries(p.roles)) {
    lines.push(`  ${q(key)}:`, `    can: [${r.can.map(q).join(", ")}]`);
    if (r.description) lines.push(`    description: ${q(r.description)}`);
    lines.push(`    reports: ${r.reports ? "true" : "false"}`);
  }
  lines.push(`default_role: ${q(p.default_role)}`, `creator_role: ${q(p.creator_role)}`);
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run src/lib/presets.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/presets.ts src/lib/presets.test.ts src/test-fixtures.ts
git commit -m "The designer's rules: a preset as a draft and back, the joiner's view, where a refusal goes, and the room.yaml export"
```

---

### Task 7: Dash: the Presets page and the editor

**Files:**
- Create: `src/components/presets/preset-editor.tsx`, `src/components/presets/preset-list.tsx`
- Create: `src/routes/presets.tsx`, `src/routes/preset-edit.tsx`
- Modify: `src/router.tsx`, `src/components/layout/app-shell.tsx`
- Test: `src/components/presets/preset-editor.test.tsx`, `src/components/presets/preset-list.test.tsx`

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: `PresetEditor(props: PresetEditorProps)`, `PresetList({ presets, onClone, onEdit, onDelete })`; routes `/presets`, `/presets/new?from=<name>`, `/presets/edit/$name` (plan ruling R2); route objects `presetsRoute`, `presetNewRoute`, `presetEditRoute`.

- [ ] **Step 1: Write the failing component tests**

Create `src/components/presets/preset-editor.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PresetEditor, type PresetEditorProps } from "@/components/presets/preset-editor";
import { bodyOf, draftFrom, emptyDraft, toYaml, type Draft } from "@/lib/presets";
import { preset } from "@/test-fixtures";

function setup(over: Partial<PresetEditorProps> = {}) {
  const onChange = vi.fn<(d: Draft) => void>();
  const onSave = vi.fn();
  const draft = over.draft ?? draftFrom(preset());
  render(<PresetEditor draft={draft} onChange={onChange} onSave={onSave} saving={false} error={null} nameLocked={false} {...over} />);
  return { onChange, onSave, draft, last: () => onChange.mock.calls.at(-1)![0] };
}

describe("the preset editor", () => {
  it("shows each role's verbs as checkboxes", () => {
    setup();
    expect(screen.getByLabelText("Role 1 may write_surface")).toBeChecked();
    expect(screen.getByLabelText("Role 2 may invite")).not.toBeChecked();
  });

  it("adds a ticked verb in the server's order", () => {
    const { last } = setup();
    fireEvent.click(screen.getByLabelText("Role 2 may invite"));
    expect(last().roles[1].can).toEqual(["send", "invite", "request_actions", "respond_actions"]);
  });

  it("carries the default role with a rename", () => {
    const { last } = setup();
    fireEvent.change(screen.getByLabelText("Role 2 key"), { target: { value: "critic" } });
    expect(last().default_role).toBe("critic");
  });

  it("adds a role, and removes one", () => {
    const { last } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a role" }));
    expect(last().roles).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove role 1" }));
    expect(last().roles.map((r) => r.key)).toEqual(["reviewer"]);
  });

  it("never removes the last role", () => {
    setup({ draft: emptyDraft() });
    expect(screen.getByRole("button", { name: "Remove role 1" })).toBeDisabled();
  });

  it("shows a refusal beside the field it names", () => {
    setup({ error: 'creator_role "boss" is not defined in roles (defined: author, reviewer)' });
    expect(screen.getByRole("alert").closest("[data-field]")?.getAttribute("data-field")).toBe("creator_role");
  });

  it("shows a refusal that names no field at the top", () => {
    setup({ error: "you have 20 presets, the most one person keeps; delete one first" });
    expect(screen.getByRole("alert").closest("[data-field]")).toBeNull();
  });

  it("shows what a joiner sees", () => {
    setup();
    const preview = screen.getByRole("region", { name: "What a joiner sees" });
    expect(within(preview).getAllByRole("row")).toHaveLength(3);
    expect(preview).toHaveTextContent("send, request_actions, respond_actions");
  });

  it("saves on Save, and holds Save while saving", () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables Save while a save is in flight", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("copies the room.yaml the draft exports as", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { draft } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy room.yaml" }));
    expect(writeText).toHaveBeenCalledWith(toYaml({ name: draft.name, ...bodyOf(draft) }));
  });

  it("locks the name when editing a saved preset", () => {
    setup({ nameLocked: true });
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });
});
```

Create `src/components/presets/preset-list.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PresetList } from "@/components/presets/preset-list";
import { preset } from "@/test-fixtures";

describe("the preset list", () => {
  it("offers the built-ins to clone and yours to edit or delete", () => {
    const onClone = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<PresetList presets={{ builtin: [preset({ name: "review", updated_at: null })], mine: [preset()] }} onClone={onClone} onEdit={onEdit} onDelete={onDelete} />);
    const mine = screen.getByRole("region", { name: "Yours" });
    fireEvent.click(within(mine).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(mine).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Built-in" })).getByRole("button", { name: "Clone" }));
    expect([onEdit.mock.calls, onDelete.mock.calls, onClone.mock.calls]).toEqual([[["my_review"]], [["my_review"]], [["review"]]]);
  });

  it("says how to start when you have none", () => {
    render(<PresetList presets={{ builtin: [], mine: [] }} onClone={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("No presets yet. Clone a built-in to start one.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/presets`
Expected: FAIL: `Failed to resolve import "@/components/presets/preset-editor"` and `.../preset-list`.

- [ ] **Step 3: The list**

Create `src/components/presets/preset-list.tsx`:

```tsx
/** The Presets page's list (designer spec D7): the built-ins to clone, and yours to edit or delete. Every string renders as text. */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Preset, PresetList as Presets } from "@/lib/api";

export function PresetList({ presets, onClone, onEdit, onDelete }: {
  presets: Presets;
  onClone: (name: string) => void;
  onEdit: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const row = (p: Preset, actions: ReactNode) => (
    <li key={p.name} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-mono font-medium">{p.name}</div>
        {p.description ? <div className="text-sm text-muted-foreground">{p.description}</div> : null}
        <div className="text-xs text-muted-foreground">{p.mode} · {Object.keys(p.roles).join(", ")}</div>
      </div>
      {actions}
    </li>
  );
  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Yours">
        <h2 className="mb-2 text-sm font-medium">Yours</h2>
        {presets.mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No presets yet. Clone a built-in to start one.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {presets.mine.map((p) =>
              row(p, (
                <>
                  <Button size="sm" variant="outline" onClick={() => onEdit(p.name)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(p.name)}>Delete</Button>
                </>
              )),
            )}
          </ul>
        )}
      </section>
      <section aria-label="Built-in">
        <h2 className="mb-2 text-sm font-medium">Built-in</h2>
        <ul className="flex flex-col gap-2">
          {presets.builtin.map((p) => row(p, <Button size="sm" variant="outline" onClick={() => onClone(p.name)}>Clone</Button>))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: The editor**

Create `src/components/presets/preset-editor.tsx`:

```tsx
/**
 * The designer (designer spec D7): a draft in, changes out. Presentational: the
 * route holds the draft, saves it, and hands back the server's refusal, which is
 * shown beside the field it names, or at the top. Every value renders as text.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VERBS, bodyOf, fieldOf, joinerRows, removeRole, renameRole, toYaml, type Draft, type DraftRole, type Field, type Verb } from "@/lib/presets";

export interface PresetEditorProps {
  draft: Draft;
  onChange: (next: Draft) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  /** Editing a saved preset: its name is its key, so it stays. */
  nameLocked: boolean;
}

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

export function PresetEditor({ draft, onChange, onSave, saving, error, nameLocked }: PresetEditorProps) {
  const at = error ? fieldOf(error) : null;
  const errorAt = (f: Field) => (error && at === f ? <p role="alert" className="text-xs text-destructive">{error}</p> : null);
  const setRole = (i: number, patch: Partial<DraftRole>) =>
    onChange({ ...draft, roles: draft.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const toggle = (i: number, verb: Verb) => {
    const can = draft.roles[i].can;
    setRole(i, { can: can.includes(verb) ? can.filter((v) => v !== verb) : VERBS.filter((v) => v === verb || can.includes(v)) });
  };
  const keys = draft.roles.map((r) => r.key);
  const copy = () => void navigator.clipboard?.writeText(toYaml({ name: draft.name, ...bodyOf(draft) }));

  return (
    <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      {error && at === null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      <div data-field="name" className="grid gap-1.5">
        <Label htmlFor="preset-name">Name</Label>
        <Input id="preset-name" value={draft.name} disabled={nameLocked} maxLength={31} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        <p className="text-xs text-muted-foreground">Lowercase letters, digits and underscores, starting with a letter. An agent cites it by this name.</p>
        {errorAt("name")}
      </div>

      <div data-field="description" className="grid gap-1.5">
        <Label htmlFor="preset-description">Description</Label>
        <Textarea id="preset-description" value={draft.description} maxLength={300} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
        {errorAt("description")}
      </div>

      <div className="flex flex-wrap gap-6">
        <div data-field="mode" className="grid gap-1.5">
          <Label htmlFor="preset-mode">Mode</Label>
          <select id="preset-mode" className={SELECT} value={draft.mode} onChange={(e) => onChange({ ...draft, mode: e.target.value as Draft["mode"] })}>
            <option value="pair">pair: two members</option>
            <option value="swarm">swarm: as many as you invite</option>
          </select>
          {errorAt("mode")}
        </div>
        <div data-field="heartbeat" className="grid gap-1.5">
          <Label htmlFor="preset-heartbeat">Heartbeat</Label>
          <div className="flex items-center gap-2">
            <input id="preset-heartbeat" type="checkbox" checked={draft.heartbeat.on} onChange={(e) => onChange({ ...draft, heartbeat: { ...draft.heartbeat, on: e.target.checked } })} />
            <Input aria-label="Heartbeat every" type="number" min={1} className="w-20" disabled={!draft.heartbeat.on} value={draft.heartbeat.amount}
              onChange={(e) => onChange({ ...draft, heartbeat: { ...draft.heartbeat, amount: Number(e.target.value) } })} />
            <select aria-label="Heartbeat unit" className={SELECT} disabled={!draft.heartbeat.on} value={draft.heartbeat.unit}
              onChange={(e) => onChange({ ...draft, heartbeat: { ...draft.heartbeat, unit: e.target.value as Draft["heartbeat"]["unit"] } })}>
              <option value="s">seconds</option>
              <option value="m">minutes</option>
              <option value="h">hours</option>
            </select>
          </div>
          {errorAt("heartbeat")}
        </div>
      </div>

      <fieldset data-field="roles" className="grid gap-2">
        <legend className="text-sm font-medium">Roles</legend>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1">Role</th>
                <th>Description</th>
                {VERBS.map((v) => <th key={v} className="px-1 font-mono">{v}</th>)}
                <th className="px-1">reports</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.roles.map((r, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2"><Input aria-label={`Role ${i + 1} key`} value={r.key} onChange={(e) => onChange(renameRole(draft, r.key, e.target.value))} /></td>
                  <td className="pr-2"><Input aria-label={`Role ${i + 1} description`} value={r.description} maxLength={300} onChange={(e) => setRole(i, { description: e.target.value })} /></td>
                  {VERBS.map((v) => (
                    <td key={v} className="text-center">
                      <input type="checkbox" aria-label={`Role ${i + 1} may ${v}`} checked={r.can.includes(v)} onChange={() => toggle(i, v)} />
                    </td>
                  ))}
                  <td className="text-center">
                    <input type="checkbox" aria-label={`Role ${i + 1} reports`} checked={r.reports} onChange={(e) => setRole(i, { reports: e.target.checked })} />
                  </td>
                  <td>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove role ${i + 1}`} disabled={draft.roles.length === 1}
                      onClick={() => onChange(removeRole(draft, i))}>
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button type="button" variant="outline" size="sm"
            onClick={() => onChange({ ...draft, roles: [...draft.roles, { key: `role_${draft.roles.length + 1}`, description: "", can: ["send"], reports: false }] })}>
            <Plus /> Add a role
          </Button>
        </div>
        {errorAt("roles")}
      </fieldset>

      <div className="flex flex-wrap gap-6">
        <div data-field="default_role" className="grid gap-1.5">
          <Label htmlFor="preset-default">Joiners take</Label>
          <select id="preset-default" className={SELECT} value={draft.default_role} onChange={(e) => onChange({ ...draft, default_role: e.target.value })}>
            {keys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {errorAt("default_role")}
        </div>
        <div data-field="creator_role" className="grid gap-1.5">
          <Label htmlFor="preset-creator">Creator role</Label>
          <select id="preset-creator" className={SELECT} value={draft.creator_role} onChange={(e) => onChange({ ...draft, creator_role: e.target.value })}>
            {keys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {errorAt("creator_role")}
        </div>
      </div>

      <section aria-label="What a joiner sees" className="grid gap-2">
        <h2 className="text-sm font-medium">What a joiner sees</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground"><th className="py-1">Role</th><th>May</th><th>Reports</th></tr>
          </thead>
          <tbody>
            {joinerRows(draft).map((row) => (
              <tr key={row.role}>
                <td className="py-1 font-mono">
                  {row.role}
                  {row.joinsAs ? <span className="ml-2 text-xs text-muted-foreground">joiners</span> : null}
                  {row.creator ? <span className="ml-2 text-xs text-muted-foreground">creator</span> : null}
                </td>
                <td>{row.may}</td>
                <td>{row.reports ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="outline" onClick={copy}>Copy room.yaml</Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Run the component tests**

Run: `npx vitest run src/components/presets`
Expected: PASS, every case in both files.

- [ ] **Step 6: The routes and the nav**

Create `src/routes/presets.tsx`:

```tsx
import { useState } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { Page } from "@/components/layout/app-shell"
import { PresetList } from "@/components/presets/preset-list"
import { Button } from "@/components/ui/button"
import { deletePreset } from "@/lib/api"
import { presetsRoute } from "@/router"

export function Presets() {
  const presets = presetsRoute.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name}? Rooms already started from it keep their roles.`)) return
    try {
      await deletePreset(name)
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Page title="Presets" description="Room shapes to start rooms from. An agent cites one by name in bellman_start.">
      <div className="mb-4">
        <Button onClick={() => void navigate({ to: "/presets/new" })}>New preset</Button>
      </div>
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      <PresetList
        presets={presets}
        onClone={(name) => void navigate({ to: "/presets/new", search: { from: name } })}
        onEdit={(name) => void navigate({ to: "/presets/edit/$name", params: { name } })}
        onDelete={(name) => void remove(name)}
      />
    </Page>
  )
}
```

Create `src/routes/preset-edit.tsx`:

```tsx
import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Page } from "@/components/layout/app-shell"
import { PresetEditor } from "@/components/presets/preset-editor"
import { putPreset } from "@/lib/api"
import { bodyOf, draftFrom, emptyDraft, type Draft } from "@/lib/presets"
import { presetEditRoute, presetNewRoute } from "@/router"

function Editor({ initial, nameLocked, title }: { initial: Draft; nameLocked: boolean; title: string }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await putPreset(draft.name, bodyOf(draft))
      await navigate({ to: "/presets" })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page title={title}>
      <PresetEditor draft={draft} onChange={setDraft} onSave={() => void save()} saving={saving} error={error} nameLocked={nameLocked} />
    </Page>
  )
}

/** A new preset, or a clone of the one `?from` names. */
export function PresetNew() {
  const { builtin, mine } = presetNewRoute.useLoaderData()
  const { from } = presetNewRoute.useSearch()
  const source = [...mine, ...builtin].find((p) => p.name === from)
  return <Editor initial={source ? draftFrom(source, true) : emptyDraft()} nameLocked={false} title={source ? `Clone ${source.name}` : "New preset"} />
}

/** One of yours; the loader has already answered not-found for a name you do not have. */
export function PresetEdit() {
  const { name } = presetEditRoute.useParams()
  const { mine } = presetEditRoute.useLoaderData()
  const found = mine.find((p) => p.name === name)!
  return <Editor initial={draftFrom(found)} nameLocked title={`Edit ${name}`} />
}
```

In `src/router.tsx`: add `listPresets` to the `@/lib/api` import; import `{ Presets } from "@/routes/presets"` and `{ PresetEdit, PresetNew } from "@/routes/preset-edit"`; after `auditRoute`, add:

```ts
export const presetsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/presets",
  component: Presets,
  loader: ({ location }) => orSignIn(location.href, listPresets),
})

/** `/presets/new` and `/presets/edit/$name` rather than `/presets/$name`: `new` is a legal preset name (plan ruling R2). */
export const presetNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/presets/new",
  component: PresetNew,
  loader: ({ location }) => orSignIn(location.href, listPresets),
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" ? { from: search.from } : {},
})

export const presetEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/presets/edit/$name",
  component: PresetEdit,
  loader: ({ params, location }) =>
    orSignIn(location.href, async () => {
      const list = await listPresets()
      if (!list.mine.some((p) => p.name === params.name)) throw notFound()
      return list
    }),
})
```

and add `presetsRoute, presetNewRoute, presetEditRoute,` to `shellRoute.addChildren([...])` after `auditRoute`.

In `src/components/layout/app-shell.tsx`, add `Shapes` to the `lucide-react` import and, after the Rooms entry in `NAV`, add `{ to: "/presets", label: "Presets", icon: Shapes },`.

- [ ] **Step 7: The whole dash suite, typecheck, lint, build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: every file passes; typecheck clean; lint adds no warning in the files this plan wrote; the build emits.

- [ ] **Step 8: Commit**

```bash
git add src/components/presets/preset-editor.tsx src/components/presets/preset-editor.test.tsx src/components/presets/preset-list.tsx src/components/presets/preset-list.test.tsx src/routes/presets.tsx src/routes/preset-edit.tsx src/router.tsx src/components/layout/app-shell.tsx
git commit -m "The Presets page: built-ins to clone, yours to edit or delete, and the designer with the joiner's view and the room.yaml copy"
```

---

### Task 8: The dash PR

**Files:**
- Modify: `README.md` (dash)

- [ ] **Step 1: README**

In dash's `README.md`, after the paragraph on the room canvas, add:

```markdown
The Presets page (`/presets`) keeps a person's saved room shapes: clone a
built-in, set the roles, their verbs and who reports, see what a joiner is
shown, and save. An agent starts a room from one by name with `bellman_start`;
Copy room.yaml gives the same room as a file for a repo. Needs the Worker's
`/presets` routes (bellman-sh/bellman, saved presets).
```

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add README.md
git commit -m "Say what the Presets page is for"
git push -u origin mcfearsome/presets
gh pr create --repo bellman-sh/dash --base main --head mcfearsome/presets --title "The Presets page: design room shapes, clone the built-ins, and export room.yaml" --body-file /tmp/dash-presets-pr-body.md
```

Write `/tmp/dash-presets-pr-body.md` first: what the page does, the routes (ruling R2), that every value renders as text, the test files, that it needs the bellman PR deployed first, and that dash has no CI: after merge, deploy with `npm run build && npx wrangler deploy` from main.
