import { z } from "zod";
import type { HostConfig, HostModelName, PresetName, RoleDef, RoomManifest, SavedPreset, Verb } from "./types.js";

/**
 * The verbs a room role can be declared to hold. The set is closed so that every verb a joiner's human
 * is shown maps to a guard that can exist; an open set would let a manifest advertise authority that
 * enforces nothing. Each of these is an operation a room member invokes on that room.
 *
 * `audit` and `close_room` are absent on purpose, because neither names such an operation. bellman_audit
 * takes no session, so it is org-wide and no room role can gate it. No tool closes a room on a member's
 * say-so: a room ends when its last member leaves. Each verb returns in the PR that adds its operation.
 * Adding one sooner lets a role's `can` promise something no code can keep.
 *
 * `write_surface` (#129) gates `bellman_send type: "surface"`, the one write to
 * the room's working surface. Reading it is never gated, as reading never is.
 */
export const VERBS = [
  "send", "invite", "revoke", "request_actions", "respond_actions", "write_surface",
] as const satisfies readonly Verb[];

export const PRESET_NAMES = ["pair", "swarm", "review", "social"] as const satisfies readonly PresetName[];
export const HOST_MODEL_NAMES = ["haiku", "sonnet", "opus"] as const satisfies readonly HostModelName[];

const MAX_ROLES = 16;

/**
 * The longest legal role key: a leading letter plus up to 30 more characters
 * (RoleKeyShape's regex, built from this below). Exported so codes.ts can size
 * the join code that has to carry a role name whole, and so server.ts can bound
 * `role` arguments against the same number it validates `join_code` against —
 * one constant rather than two literals that can drift apart.
 */
export const MAX_ROLE_KEY_LENGTH = 31;

/** A manifest that could not be resolved. The server turns this into a tool error. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * The cadence bounds. Below the floor it is a liveness timer, which is #103's
 * job and what #111 explicitly is not. The ceiling is a day: a hosted seat
 * (spec D3) is slowed, not stopped, by a heavy model, and a daily question is
 * the slow end of that. Above a day the cadence says nothing a peer could act on.
 */
export const MIN_HEARTBEAT_MS = 30_000;
export const MAX_HEARTBEAT_MS = 86_400_000;
/** A room with a host ticks no faster than this: 744 wakes a month at most from ticks alone. */
export const MIN_HOST_HEARTBEAT_MS = 3_600_000;

/**
 * The bounds on every housekeeping key (#66, D5): one pair for all four. The floor
 * keeps a manifest from making a room raise a finding every few seconds; the
 * ceiling is a week.
 */
export const MIN_HOUSEKEEPING_MS = 5 * 60_000;
export const MAX_HOUSEKEEPING_MS = 7 * 24 * 3_600_000;

const DURATION = /^(\d{1,4})(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/**
 * The units a field is written in, largest first. They belong to the field and not to the
 * parser, so what a field reads and what it prints cannot disagree. heartbeat_on has never
 * been written in days: its ceiling is a day (the hosted seat's daily beat) and a day is "24h",
 * so "1d" is a shape error there and its bound prints as 24h. A housekeeping threshold's
 * ceiling is a week, so it also takes days and prints that bound as 7d.
 */
const BEAT_UNITS: readonly Unit[] = ["h", "m", "s"];
const THRESHOLD_UNITS: readonly Unit[] = ["d", "h", "m", "s"];

/**
 * Milliseconds back to the shortest duration that denotes them — the inverse of
 * what parseDuration reads, so an error can name a bound in the same notation
 * the caller wrote. The largest of the field's units that divides exactly, so
 * 3_600_000 is "1h" rather than "60m", and a week is "7d" rather than "168h" where
 * days are written, but a day is "24h" where they are not.
 */
const duration = (ms: number, units: readonly Unit[]): string => {
  const unit = units.find((u) => ms % UNIT_MS[u] === 0) ?? "s";
  return `${ms / UNIT_MS[unit]}${unit}`;
};

/**
 * `"30s"`, `"5m"`, `"1h"`, and `"2d"` where `units` has days, to milliseconds, refused
 * outside `[min, max]`. `field` is the manifest key, and both errors name it first.
 *
 * The raw value is echoed by both errors, and those reach tool errors and the
 * audit log, so DurationShape bounds it to 8 characters before it can get
 * here. The regex caps the digits too, so neither message can be grown by its
 * input.
 */
function parseDuration(field: string, raw: string, min: number, max: number, units: readonly Unit[]): number {
  const m = DURATION.exec(raw);
  if (!m || !units.includes(m[2] as Unit)) {
    const examples = units.includes("d") ? '"30s", "5m", "1h" or "2d"' : '"30s", "5m" or "1h"';
    throw new ManifestError(`${field} must be a duration like ${examples} (got "${raw}")`);
  }
  const ms = Number(m[1]) * UNIT_MS[m[2] as Unit];
  if (ms < min || ms > max) {
    // Rendered from the bounds, not restated. A bound change would otherwise
    // leave this message wrong while the test pinning its literal text passed.
    throw new ManifestError(
      `${field} must be between ${duration(min, units)} and ${duration(max, units)} (got "${raw}")`,
    );
  }
  return ms;
}

const parseHeartbeatOn = (raw: string, field: "heartbeat" | "heartbeat_on" = "heartbeat_on"): number =>
  parseDuration(field, raw, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS, BEAT_UNITS);

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

/** Bounded before interpolation. See parseDuration. */
const DurationShape = z.string().max(8);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Names that must never be role keys. The regex alone cannot enforce this:
 * `constructor` and `prototype` match it, and `__proto__` never reaches it (see
 * RolesShape). Stored in `roles`, any of them would collide with what a bare
 * `roles[name]` lookup finds on a plain object, so #2 and #3 could mistake an
 * inherited property for a defined role.
 */
const RESERVED_ROLE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * One slug grammar for every externally supplied key that becomes a lookup key:
 * role keys here, surface keys in surface.ts. `noun` is only the wording of the
 * two messages, so a surface key is refused as a surface key.
 */
export function slugShape(noun: string) {
  return z.string()
    .refine(
      (key) => !RESERVED_ROLE_KEYS.has(key),
      `${noun} must not be one of: ${[...RESERVED_ROLE_KEYS].join(", ")}`,
    )
    .regex(
      new RegExp(`^[a-z][a-z0-9_]{0,${MAX_ROLE_KEY_LENGTH - 1}}$`),
      `${noun} must match [a-z][a-z0-9_]{0,${MAX_ROLE_KEY_LENGTH - 1}}`,
    );
}

/**
 * The one definition of a legal role key. Validate every externally supplied
 * role name with it before using the name as a lookup key: banning a name from
 * `roles` does not make a lookup by that name safe — `roles["constructor"]` on a
 * plain object is the inherited Object function even when no such role exists.
 *
 * The ban is checked first on purpose. `__proto__` also fails the regex, but
 * "reserved" is the more useful thing to tell the author.
 */
export const RoleKeyShape = slugShape("role keys");

/** A saved preset's name (designer spec D2): the role-key grammar, refused with its own noun. */
export const PresetNameShape = slugShape("preset names");

const RoleDefShape = z.strictObject({
  can: z.array(z.enum(VERBS)).max(VERBS.length),
  description: z.string().max(300).nullish(),
  // Whether this seat is on the heartbeat, and what it reports (vocabulary spec D1): true,
  // false, or the instruction. `reports` and `report` below are the old words (D3).
  heartbeat_on: z.union([z.boolean(), z.string().max(300)]).nullish(),
  // Absent means not asked. A role has to opt in to being expected to report,
  // for the same reason no preset does (D3): a tick that names members silent
  // who were never asked for anything is how the signal gets ignored.
  reports: z.boolean().nullish(),
  // What the seat reports on a tick, in the creator's words (heartbeat instructions
  // spec D1). Bounded like a description; refused below on a seat that does not report.
  report: z.string().max(300).nullish(),
});

/**
 * z.record never shows an own `__proto__` key to its key schema — it skips the
 * key outright (zod 4.5, core/schemas.js) — so RoleKeyShape alone would let a
 * hostile roles map resolve as if that role had never been declared. Check the
 * raw own keys against RoleKeyShape first and fail closed. This lives in the
 * shape, not in resolveManifest, so a tool inputSchema built on ManifestShape
 * is protected too: the MCP SDK parses arguments before any handler runs.
 */
const RolesShape = z.preprocess(
  (raw, ctx) => {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const key of Object.getOwnPropertyNames(raw)) {
        const verdict = RoleKeyShape.safeParse(key);
        if (!verdict.success) {
          // One bad key is enough to reject, and keeps the error bounded.
          ctx.addIssue({
            code: "custom",
            message: verdict.error.issues[0].message,
            path: [key],
            input: key,
          });
          break;
        }
      }
    }
    return raw;
  },
  z.record(RoleKeyShape, RoleDefShape)
    .refine((r) => Object.keys(r).length > 0, "roles must define at least one role")
    .refine((r) => Object.keys(r).length <= MAX_ROLES, `at most ${MAX_ROLES} roles`),
);

/**
 * The thresholds past which the server proposes a housekeeping finding (#66). Each
 * key is nullish for the reason `heartbeat_on` is: a valueless `idle_after:` in
 * YAML is null, and means that finding is off. An authored "" is still refused,
 * by resolveHousekeeping.
 */
const HousekeepingShape = z.strictObject({
  quiet_after: DurationShape.nullish(),
  answer_within: DurationShape.nullish(),
  idle_after: DurationShape.nullish(),
  repeat_after: DurationShape.nullish(),
});
export type HousekeepingInput = z.input<typeof HousekeepingShape>;

const HostShape = z.strictObject({
  // Echoed verbatim by the cross-field errors, as default_role is, so it is bounded the same way.
  role: z.string().max(MAX_ROLE_KEY_LENGTH),
  model: z.enum(HOST_MODEL_NAMES).default("haiku"),
  instructions: z.string().max(300).nullish(),
});

const CiteShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  preset: PresetNameShape,
  // A cite may set the beat of a preset with a host, built-in or saved (checkCiteCadence); for
  // `social` that is how a room has its host ask less often than hourly. `heartbeat` is its name
  // (vocabulary spec D1), and the `heartbeat_on` below the old one (D3).
  heartbeat: DurationShape.nullish(),
  heartbeat_on: DurationShape.nullish(),
  // Housekeeping is not part of what a preset is (D5), so a citation may add it.
  housekeeping: HousekeepingShape.nullish(),
});

const AuthorShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  mode: z.enum(["pair", "swarm"]),
  // The room's frequency (vocabulary spec D1); the `heartbeat_on` below is its old name (D3).
  heartbeat: DurationShape.nullish(),
  heartbeat_on: DurationShape.nullish(),
  housekeeping: HousekeepingShape.nullish(),
  roles: RolesShape,
  // Both are echoed verbatim by the cross-field errors, which reach tool errors and
  // the audit log, so they are bounded like every other string in the shape.
  default_role: z.string().max(MAX_ROLE_KEY_LENGTH),
  creator_role: z.string().max(MAX_ROLE_KEY_LENGTH),
  host: HostShape.nullish(),
});

/** One issue as "path: message". Symbol-safe: a symbol key can reach a path. */
export function describeIssue(i: { path: PropertyKey[]; message: string }): string {
  const path = i.path.map(String).join(".");
  return path ? `${path}: ${i.message}` : i.message;
}

/** The arm the caller was aiming at: a `preset` key means "cite", anything else "author". */
function aimedArm(input: unknown): typeof CiteShape | typeof AuthorShape {
  return typeof input === "object" && input !== null && "preset" in input ? CiteShape : AuthorShape;
}

export const ManifestShape = z.union([CiteShape, AuthorShape], {
  // A failed union reports one opaque "Invalid input". Say which field is wrong,
  // using the arm the caller was aiming at. This is the message a tool caller sees
  // when a tool's inputSchema is ManifestShape: the MCP SDK validates with it
  // before any handler runs, and shows only each issue's message and path.
  error: (iss) => {
    if (iss.code !== "invalid_union") return undefined;
    const first = iss.errors[aimedArm(iss.input) === CiteShape ? 0 : 1]?.[0];
    return first ? describeIssue(first) : undefined;
  },
});
export type ManifestInput = z.input<typeof ManifestShape>;

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

// ---------------------------------------------------------------------------
// Preset catalog
// ---------------------------------------------------------------------------

// A preset carries no cadence (D3) and no housekeeping thresholds (#66, D5), so
// the catalog's shape leaves both out and resolveManifest supplies null. Making
// them unrepresentable here is stronger than a catalog entry that happens to say
// null. The exception is a preset with a host, which must tick to be asked its
// question (hosted seat spec, D1): `heartbeatOnMs` is optional so that entry can
// set it, and `social` is the only one that does. `housekeeping` has no exception:
// `social` carries none either.
type PresetBody =
  Omit<RoomManifest, "room" | "purpose" | "preset" | "heartbeatOnMs" | "housekeeping"> & { heartbeatOnMs?: number };

function role(can: Verb[], description: string): RoleDef {
  // No preset expects a report (D3). Turning this on for shipped presets would
  // tick every room anyone already runs and name members silent who were never
  // asked for anything.
  return { can, description, reports: false, report: null };
}

/**
 * Not exported, on purpose. The `can` arrays are mutable, so an importer that could reach this would
 * change every later resolution by editing one. What leaves the module is a structuredClone of it.
 */
const PRESETS: Record<PresetName, PresetBody> = {
  pair: {
    mode: "pair",
    roles: {
      peer_a: role(
        ["send", "request_actions", "respond_actions", "invite", "revoke", "write_surface"],
        "Creator. Equal in conversation, holds room control and writes the surface.",
      ),
      peer_b: role(
        ["send", "request_actions", "respond_actions"],
        "Equal peer in conversation; cannot change who can join.",
      ),
    },
    defaultRole: "peer_b",
    creatorRole: "peer_a",
    host: null,
  },
  swarm: {
    mode: "swarm",
    roles: {
      lead: role(
        ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
        "Runs the room: controls who can join, and writes the surface.",
      ),
      helper: role(
        ["send", "request_actions", "respond_actions"],
        "Works the problem. Cannot change who is in the room.",
      ),
      observer: role([], "Reads the room. Sends nothing."),
    },
    defaultRole: "helper",
    creatorRole: "lead",
    host: null,
  },
  review: {
    mode: "pair",
    roles: {
      author: role(
        ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
        "Brought the work. Can ask the reviewer to do things, when the reviewer allows it. Writes the surface.",
      ),
      reviewer: role(
        ["send", "respond_actions"],
        "Reviews the work. Answers action requests but does not initiate them.",
      ),
    },
    defaultRole: "reviewer",
    creatorRole: "author",
    host: null,
  },
  social: {
    mode: "swarm",
    roles: {
      lead: role(
        ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
        "Opened the room: controls who can join, and writes the surface.",
      ),
      guest: role(["send"], "Answers the host's questions and talks with the room."),
      host: role(["send"], "Asks the room a question each tick and answers in the thread. Bellman runs it."),
    },
    defaultRole: "guest",
    creatorRole: "lead",
    host: { role: "host", model: "haiku", instructions: null },
    heartbeatOnMs: MIN_HOST_HEARTBEAT_MS,
  },
};

/** What each built-in is for, in a line, for the panel's list (designer spec D5, plan ruling R3). */
const BUILTIN_DESCRIPTIONS: Record<PresetName, string> = {
  pair: "Two peers. The creator controls who joins and writes the surface.",
  swarm: "A lead who runs the room, helpers who work it, and observers who read it.",
  review: "An author who brought the work, and a reviewer who answers but does not ask.",
  social: "A lead who opened the room, guests who talk in it, and a host Bellman runs that asks them a question each hour.",
};

/**
 * The built-ins in a saved preset's form, fresh copies on every call, for the
 * panel to show and clone (designer spec D5). PRESETS itself stays unexported:
 * its `can` arrays are mutable. `social` comes with its host and its hour, so a
 * clone of it saves a hosted preset rather than a room whose `host` role nobody runs.
 */
export function builtinPresets(): SavedPreset[] {
  return PRESET_NAMES.map((name) => {
    const body = PRESETS[name];
    return {
      name,
      description: BUILTIN_DESCRIPTIONS[name],
      mode: body.mode,
      heartbeat_on: body.heartbeatOnMs === undefined ? null : duration(body.heartbeatOnMs, BEAT_UNITS),
      // No built-in sets housekeeping, `social` included (D5), and PresetBody cannot say it does.
      housekeeping: null,
      roles: structuredClone(body.roles),
      default_role: body.defaultRole,
      creator_role: body.creatorRole,
      host: structuredClone(body.host),
      updated_at: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function firstIssue(err: z.ZodError): string {
  return describeIssue(err.issues[0]);
}

/**
 * Turn either input arm into one fully-expanded manifest.
 *
 * Expansion happens HERE and only here: what the store holds is always
 * concrete roles, never a preset reference. #2 and #3 read `roles` and never
 * learn that presets exist.
 */
export function resolveManifest(input: unknown): RoomManifest {
  // Name the valid presets when given an unknown one.
  if (
    typeof input === "object" && input !== null &&
    "preset" in input && typeof (input as { preset: unknown }).preset === "string" &&
    !PRESET_NAMES.includes((input as { preset: string }).preset as PresetName)
  ) {
    throw new ManifestError(
      `unknown preset "${(input as { preset: string }).preset}" (valid: ${PRESET_NAMES.join(", ")})`,
    );
  }

  // Parse with the union itself, not a hand-picked arm. Zod already hoists the best
  // arm's issues (roles plus a null preset says `Unrecognized key: "preset"`, the
  // right advice), and ManifestShape's error hook names the field for the rest.
  // Picking an arm here once said "preset: Invalid option" to someone who had
  // authored roles.
  const parsed = ManifestShape.safeParse(input);
  if (!parsed.success) throw new ManifestError(firstIssue(parsed.error));
  const v = parsed.data;

  if ("preset" in v) {
    const body = PRESETS[v.preset as PresetName];
    const beat = roomBeat(v);
    checkCiteCadence(v.preset, body.host !== null, beat.raw, beat.word ?? "heartbeat_on");
    const manifest: RoomManifest = {
      room: v.room,
      purpose: v.purpose ?? null,
      preset: v.preset as PresetName,
      mode: body.mode,
      roles: structuredClone(body.roles),
      defaultRole: body.defaultRole,
      creatorRole: body.creatorRole,
      // Cloned like `roles`: the catalog is private so that one room's edit cannot reach the next.
      host: structuredClone(body.host),
      // A cite may set the beat. Absent, it takes the preset's own, which is null for
      // every preset but one with a host (see PresetBody).
      heartbeatOnMs: beat.raw != null ? parseHeartbeatOn(beat.raw, beat.word ?? "heartbeat_on") : (body.heartbeatOnMs ?? null),
      // A cite may add housekeeping to any preset, the host's included (#66, D5).
      housekeeping: resolveHousekeeping(v.housekeeping),
    };
    checkHost(manifest, { cadence: beat.word ?? "heartbeat_on", hostRole: "reports" });
    return manifest;
  }

  const defined = Object.keys(v.roles);
  if (!defined.includes(v.default_role)) {
    throw new ManifestError(
      `default_role "${v.default_role}" is not defined in roles (defined: ${defined.join(", ")})`,
    );
  }
  if (!defined.includes(v.creator_role)) {
    throw new ManifestError(
      `creator_role "${v.creator_role}" is not defined in roles (defined: ${defined.join(", ")})`,
    );
  }

  const beat = roomBeat(v);
  // The words a refusal about the frequency speaks when the author wrote neither (plan ruling R2).
  const spelledNew = beat.word === "heartbeat" || Object.values(v.roles).some((d) => d.heartbeat_on !== undefined);
  const roleWords: Record<string, "heartbeat_on" | "reports"> = {};
  const roles: Record<string, RoleDef> = {};
  for (const [key, def] of Object.entries(v.roles)) {
    const seen = new Set<Verb>();
    for (const verb of def.can) {
      if (seen.has(verb)) {
        throw new ManifestError(`role "${key}" lists duplicate verb "${verb}"`);
      }
      seen.add(verb);
    }
    // A seat that may not speak may not report either: `SEND_VERB.progress` is
    // `send`, so a `reports: true` role without it is shown an obligation, named
    // in every heartbeat snapshot, and then refused the one reply that answers
    // it. Refused here beside the other cross-field checks, because no runtime
    // state makes it work.
    //
    // Refused whether or not the room declares a cadence, because the seat is
    // what cannot answer. A room with no `heartbeat_on` never ticks, so such a
    // manifest asks nothing of anybody today — but it is still unanswerable the
    // day a cadence is added, and the author is here now. `you_report` in the
    // connect preview is the other half of that split: it reads the cadence AND
    // the seat, so a room that never ticks promises nothing.
    const onBeat = roleBeat(key, def);
    roleWords[key] = onBeat.word;
    if (onBeat.reports && !def.can.includes("send")) {
      const holds = def.can.length > 0 ? def.can.join(", ") : "none";
      throw new ManifestError(onBeat.word === "heartbeat_on"
        ? `role "${key}" sets heartbeat_on but does not hold the verb "send" (it holds: ${holds})`
        : `role "${key}" sets reports: true but does not hold the verb "send" (it holds: ${holds})`);
    }
    roles[key] = { can: [...def.can], description: def.description ?? null, reports: onBeat.reports, report: onBeat.report };
  }

  const host: HostConfig | null = v.host == null ? null : {
    role: v.host.role, model: v.host.model, instructions: v.host.instructions ?? null,
  };

  const manifest: RoomManifest = {
    room: v.room,
    purpose: v.purpose ?? null,
    preset: null,
    mode: v.mode,
    roles,
    defaultRole: v.default_role,
    creatorRole: v.creator_role,
    // `!= null`, not truthiness: an authored "" is a mistake to refuse, not an
    // absent key. A valueless `heartbeat_on:` in YAML is null and means no cadence.
    heartbeatOnMs: beat.raw != null ? parseHeartbeatOn(beat.raw, beat.word ?? "heartbeat_on") : null,
    housekeeping: resolveHousekeeping(v.housekeeping),
    host,
  };
  checkHost(manifest, {
    cadence: beat.word ?? (spelledNew ? "heartbeat" : "heartbeat_on"),
    hostRole: (v.host && roleWords[v.host.role]) ?? "reports",
  });
  return manifest;
}

/**
 * A cite may set the beat only of a preset with a host, built-in or saved, as main's
 * strict cite refused the key for every preset (M8). With no host a cite has nothing to
 * slow: a built-in has no reporting role, so nothing would ever tick, and a saved preset
 * already carries the cadence its author chose. bellman_start meets it for a saved
 * preset, which resolveManifest never sees cited.
 */
export function checkCiteCadence(
  preset: string, hasHost: boolean, heartbeatOn: unknown, word: "heartbeat" | "heartbeat_on" = "heartbeat_on",
): void {
  if (heartbeatOn !== undefined && !hasHost) {
    throw new ManifestError(
      `${word}: the "${preset}" preset has no host, so a cite of it cannot set a cadence; author the roles to set one`,
    );
  }
}

/**
 * The cross-field rules a hosted seat adds (hosted seat spec, D1). One function for
 * both arms, so a preset and an authored manifest cannot be refused differently.
 */
function checkHost(
  m: RoomManifest,
  // The words its two messages name, today's unless the author wrote the new ones (vocabulary spec D5).
  words: { cadence: "heartbeat" | "heartbeat_on"; hostRole: "heartbeat_on" | "reports" } = { cadence: "heartbeat_on", hostRole: "reports" },
): void {
  if (m.host === null) return;
  const defined = Object.keys(m.roles);
  if (!defined.includes(m.host.role)) {
    throw new ManifestError(`host.role "${m.host.role}" is not defined in roles (defined: ${defined.join(", ")})`);
  }
  if (m.mode === "pair") {
    throw new ManifestError("a pair room cannot have a host: its two seats are its members'");
  }
  const def = m.roles[m.host.role];
  if (def.can.length !== 1 || def.can[0] !== "send") {
    const holds = def.can.length > 0 ? def.can.join(", ") : "none";
    throw new ManifestError(`host role "${m.host.role}" must hold exactly the verb "send" (it holds: ${holds})`);
  }
  if (def.reports) {
    throw new ManifestError(words.hostRole === "heartbeat_on"
      ? `host role "${m.host.role}" must not be on the heartbeat`
      : `host role "${m.host.role}" must not report`);
  }
  // Rendered from the constant, as parseHeartbeatOn renders its bounds: a floor change
  // would otherwise leave these messages naming a floor that no longer exists.
  const floor = duration(MIN_HOST_HEARTBEAT_MS, BEAT_UNITS);
  if (m.heartbeatOnMs === null) {
    throw new ManifestError(`a room with a host must set ${words.cadence} (at least ${floor})`);
  }
  if (m.heartbeatOnMs < MIN_HOST_HEARTBEAT_MS) {
    throw new ManifestError(`a room with a host must tick no faster than ${floor} (got "${duration(m.heartbeatOnMs, BEAT_UNITS)}")`);
  }
}

/**
 * The housekeeping block as milliseconds, or null when it asks for no finding.
 *
 * Null, not an object of nulls, for an empty block and for one holding only
 * `repeat_after`: a repeat window with nothing to repeat is the same room as one
 * with no block, and one representation of "off" is one fewer thing for the rules
 * and the stored row to check. Every key is parsed before that is decided, so a
 * bad `repeat_after` is refused even when it stands alone.
 *
 * `!= null` for the reason `heartbeat_on` uses it: an authored "" is a mistake to
 * refuse, and a valueless key is off.
 */
function resolveHousekeeping(
  h: z.infer<typeof HousekeepingShape> | null | undefined,
): RoomManifest["housekeeping"] {
  if (!h) return null;
  const ms = (key: keyof typeof h): number | null => {
    const raw = h[key];
    return raw != null
      ? parseDuration(`housekeeping.${key}`, raw, MIN_HOUSEKEEPING_MS, MAX_HOUSEKEEPING_MS, THRESHOLD_UNITS)
      : null;
  };
  const out = {
    quietAfterMs: ms("quiet_after"),
    answerWithinMs: ms("answer_within"),
    idleAfterMs: ms("idle_after"),
    repeatAfterMs: ms("repeat_after"),
  };
  return out.quietAfterMs === null && out.answerWithinMs === null && out.idleAfterMs === null ? null : out;
}
