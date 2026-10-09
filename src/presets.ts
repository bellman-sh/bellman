/**
 * Saved presets (designer spec): the rule for what may be saved, and a saved
 * preset as the manifest bellman_start resolves. Runtime-free, like
 * manifest.ts, so the routes, the tool and both test programs import it.
 */
import { ManifestError, PRESET_NAMES, PresetNameShape, PresetShape, describeIssue, resolveManifest, roleBeat, roomBeat } from "./manifest.js";
import type { HousekeepingInput } from "./manifest.js";
import type { SavedPreset, Verb } from "./types.js";

// ponytail: twenty a person, not tuned. The first person past it wants a reason, not a bigger number.
export const MAX_PRESETS = 20;

export type PresetCheck =
  | { ok: true; preset: SavedPreset }
  | { ok: false; status: 400 | 409; error: "invalid_request" | "invalid_manifest" | "builtin"; description: string };

/**
 * A saved preset as the author arm `resolveManifest` reads, for a room called `room` (D6).
 * `host` goes with it, so a room started from a preset with a host meets bellman_start's
 * plan refusal and hosted-room slot exactly as an inline `host` block does. A cite's
 * frequency, either spelling, which checkCiteCadence admits only for a preset with a host, replaces
 * the preset's own; absent or null, the preset's stands, as for a built-in. A cite's
 * `housekeeping` (#66, D5) follows the same rule, so null means one thing on a cite
 * whichever field it is on: absent or null, the preset's own block stands, and a block
 * replaces it whole. An empty one says none, as it does in an authored manifest. A
 * preset saved before the field existed has no such key, which reads as none.
 */
export function asManifest(
  p: SavedPreset, room: string, purpose: string | null | undefined, heartbeat?: string | null,
  housekeeping?: HousekeepingInput | null,
): Record<string, unknown> {
  return {
    room,
    purpose: purpose ?? null,
    mode: p.mode,
    heartbeat: heartbeat ?? p.heartbeat,
    housekeeping: housekeeping ?? p.housekeeping,
    roles: p.roles,
    default_role: p.default_role,
    creator_role: p.creator_role,
    host: p.host ?? null,
  };
}

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

/**
 * The block as saved (#66): the keys it sets, durations as written, and null when it sets
 * none, so "no housekeeping" has one spelling in a row as it has in a resolved manifest.
 * A bound is not checked here. checkPreset resolves the preset the way a room would, and the
 * validator refuses what is out of range, in its own words.
 */
function savedHousekeeping(h: HousekeepingInput | null | undefined): SavedPreset["housekeeping"] {
  const set = Object.entries(h ?? {}).filter(([, duration]) => duration != null);
  return set.length > 0 ? (Object.fromEntries(set) as NonNullable<SavedPreset["housekeeping"]>) : null;
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
  return { ok: true, preset };
}
