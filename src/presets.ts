/**
 * Saved presets (designer spec): the rule for what may be saved, and a saved
 * preset as the manifest bellman_start resolves. Runtime-free, like
 * manifest.ts, so the routes, the tool and both test programs import it.
 */
import { ManifestError, PRESET_NAMES, PresetNameShape, PresetShape, describeIssue, resolveManifest } from "./manifest.js";
import type { HousekeepingInput } from "./manifest.js";
import type { SavedPreset } from "./types.js";

// ponytail: twenty a person, not tuned. The first person past it wants a reason, not a bigger number.
export const MAX_PRESETS = 20;

export type PresetCheck =
  | { ok: true; preset: SavedPreset }
  | { ok: false; status: 400 | 409; error: "invalid_request" | "invalid_manifest" | "builtin"; description: string };

/**
 * A saved preset as the author arm `resolveManifest` reads, for a room called `room` (D6).
 * `host` goes with it, so a room started from a preset with a host meets bellman_start's
 * plan refusal and hosted-room slot exactly as an inline `host` block does. A cite's
 * `heartbeat_on`, which checkCiteCadence admits only for a preset with a host, replaces
 * the preset's own; absent or null, the preset's stands, as for a built-in. A cite's
 * `housekeeping` (#66, D5) is the caller's say for this room and replaces the preset's
 * block whole: null or {} says none, as in an authored manifest, and only absent leaves
 * the preset's.
 */
export function asManifest(
  p: SavedPreset, room: string, purpose: string | null | undefined, heartbeatOn?: string | null,
  housekeeping?: HousekeepingInput | null,
): Record<string, unknown> {
  return {
    room,
    purpose: purpose ?? null,
    mode: p.mode,
    heartbeat_on: heartbeatOn ?? p.heartbeat_on,
    housekeeping: housekeeping !== undefined ? housekeeping : p.housekeeping,
    roles: p.roles,
    default_role: p.default_role,
    creator_role: p.creator_role,
    host: p.host ?? null,
  };
}

/**
 * A row read back from the registry, in the form the type promises. Stored rows outlive
 * the code that wrote them: one saved before `housekeeping` existed has no such key, and
 * is a preset that sets none.
 */
export const liftPreset = (p: SavedPreset): SavedPreset => ({ ...p, housekeeping: p.housekeeping ?? null });

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
  const roles: SavedPreset["roles"] = {};
  for (const [key, def] of Object.entries(v.roles)) {
    roles[key] = { can: [...def.can], description: def.description ?? null, reports: def.reports ?? false };
  }
  const preset: SavedPreset = {
    name,
    description: v.description ?? null,
    mode: v.mode,
    heartbeat_on: v.heartbeat_on ?? null,
    housekeeping: savedHousekeeping(v.housekeeping),
    roles,
    default_role: v.default_role,
    creator_role: v.creator_role,
    host: v.host == null ? null : { role: v.host.role, model: v.host.model, instructions: v.host.instructions ?? null },
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
