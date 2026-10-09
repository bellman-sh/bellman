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
 * `housekeeping` (#66, D5) follows the same rule, so null means one thing on a cite
 * whichever field it is on: absent or null, the preset's own block stands, and a block
 * replaces it whole. An empty one says none, as it does in an authored manifest. A
 * preset saved before the field existed has no such key, which reads as none. A cite's
 * `public`, when it gives one, replaces the preset's.
 */
export function asManifest(
  p: SavedPreset, room: string, purpose: string | null | undefined, heartbeatOn?: string | null,
  housekeeping?: HousekeepingInput | null, citedPublic?: boolean | null,
): Record<string, unknown> {
  return {
    room,
    purpose: purpose ?? null,
    // The preset's is the default and a cite's own wins (public rooms spec D1).
    public: citedPublic ?? p.public ?? false,
    mode: p.mode,
    heartbeat_on: heartbeatOn ?? p.heartbeat_on,
    housekeeping: housekeeping ?? p.housekeeping,
    roles: p.roles,
    default_role: p.default_role,
    creator_role: p.creator_role,
    host: p.host ?? null,
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
    public: v.public ?? false,
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
