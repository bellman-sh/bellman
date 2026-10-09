import { z } from "zod";
import type { PresetName, RoleDef, RoomManifest, SavedPreset, Verb } from "./types.js";

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

export const PRESET_NAMES = ["pair", "swarm", "review"] as const satisfies readonly PresetName[];

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
 * job and what #111 explicitly is not. Above the ceiling the cadence says
 * nothing a peer could act on inside a working session.
 */
export const MIN_HEARTBEAT_MS = 30_000;
export const MAX_HEARTBEAT_MS = 3_600_000;

/**
 * The bounds on every housekeeping key (#66, D5): one pair for all four. The floor
 * keeps a manifest from making a room raise a finding every few seconds; the
 * ceiling is a week.
 */
export const MIN_HOUSEKEEPING_MS = 5 * 60_000;
export const MAX_HOUSEKEEPING_MS = 7 * 24 * 3_600_000;

const DURATION = /^(\d{1,4})(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Milliseconds back to the shortest duration that denotes them — the inverse of
 * what parseDuration reads, so an error can name a bound in the same notation
 * the caller wrote. Largest unit that divides exactly, so 3_600_000 is "1h"
 * rather than "60m", and a week is "7d" rather than "168h".
 */
const duration = (ms: number): string => {
  for (const [unit, size] of [["d", UNIT_MS.d], ["h", UNIT_MS.h], ["m", UNIT_MS.m]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms / UNIT_MS.s}s`;
};

/**
 * `"30s"`, `"5m"`, `"1h"`, `"2d"` to milliseconds, refused outside `[min, max]`.
 * `field` is the manifest key, and both errors name it first.
 *
 * The raw value is echoed by both errors, and those reach tool errors and the
 * audit log, so DurationShape bounds it to 8 characters before it can get
 * here. The regex caps the digits too, so neither message can be grown by its
 * input.
 */
function parseDuration(field: string, raw: string, min: number, max: number): number {
  const m = DURATION.exec(raw);
  if (!m) {
    // heartbeat_on tops out at an hour, so a day was never among its examples.
    const examples = field === "heartbeat_on" ? '"30s", "5m" or "1h"' : '"30s", "5m", "1h" or "2d"';
    throw new ManifestError(`${field} must be a duration like ${examples} (got "${raw}")`);
  }
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (ms < min || ms > max) {
    // Rendered from the bounds, not restated. A bound change would otherwise
    // leave this message wrong while the test pinning its literal text passed.
    throw new ManifestError(
      `${field} must be between ${duration(min)} and ${duration(max)} (got "${raw}")`,
    );
  }
  return ms;
}

const parseHeartbeatOn = (raw: string): number =>
  parseDuration("heartbeat_on", raw, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS);

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
  // Absent means not asked. A role has to opt in to being expected to report,
  // for the same reason no preset does (D3): a tick that names members silent
  // who were never asked for anything is how the signal gets ignored.
  reports: z.boolean().nullish(),
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

const CiteShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  preset: PresetNameShape,
  // Housekeeping is not part of what a preset is (D5), so a citation may add it.
  housekeeping: HousekeepingShape.nullish(),
});

const AuthorShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  mode: z.enum(["pair", "swarm"]),
  heartbeat_on: DurationShape.nullish(),
  housekeeping: HousekeepingShape.nullish(),
  roles: RolesShape,
  // Both are echoed verbatim by the cross-field errors, which reach tool errors and
  // the audit log, so they are bounded like every other string in the shape.
  default_role: z.string().max(MAX_ROLE_KEY_LENGTH),
  creator_role: z.string().max(MAX_ROLE_KEY_LENGTH),
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
// the catalog's shape leaves both out and resolveManifest supplies them. Making
// them unrepresentable here is stronger than a catalog entry that happens to say
// null.
type PresetBody = Omit<RoomManifest, "room" | "purpose" | "preset" | "heartbeatOnMs" | "housekeeping">;

function role(can: Verb[], description: string): RoleDef {
  // No preset expects a report (D3). Turning this on for shipped presets would
  // tick every room anyone already runs and name members silent who were never
  // asked for anything.
  return { can, description, reports: false };
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
  },
};

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
    return {
      room: v.room,
      purpose: v.purpose ?? null,
      preset: v.preset as PresetName,
      mode: body.mode,
      roles: structuredClone(body.roles),
      defaultRole: body.defaultRole,
      creatorRole: body.creatorRole,
      heartbeatOnMs: null,
      housekeeping: resolveHousekeeping(v.housekeeping),
    };
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
    if ((def.reports ?? false) && !def.can.includes("send")) {
      const holds = def.can.length > 0 ? def.can.join(", ") : "none";
      throw new ManifestError(
        `role "${key}" sets reports: true but does not hold the verb "send" (it holds: ${holds})`,
      );
    }
    roles[key] = {
      can: [...def.can],
      description: def.description ?? null,
      reports: def.reports ?? false,
    };
  }

  return {
    room: v.room,
    purpose: v.purpose ?? null,
    preset: null,
    mode: v.mode,
    roles,
    defaultRole: v.default_role,
    creatorRole: v.creator_role,
    // `!= null`, not truthiness: an authored "" is a mistake to refuse, not an
    // absent key. A valueless `heartbeat_on:` in YAML is null and means no cadence.
    heartbeatOnMs: v.heartbeat_on != null ? parseHeartbeatOn(v.heartbeat_on) : null,
    housekeeping: resolveHousekeeping(v.housekeeping),
  };
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
      ? parseDuration(`housekeeping.${key}`, raw, MIN_HOUSEKEEPING_MS, MAX_HOUSEKEEPING_MS)
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
