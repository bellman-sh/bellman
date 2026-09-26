import { z } from "zod";
import type { PresetName, RoleDef, RoomManifest, Verb } from "./types.js";

/**
 * The verbs a room role can be declared to hold. The set is closed so that every verb a joiner's human
 * is shown maps to a guard that can exist; an open set would let a manifest advertise authority that
 * enforces nothing. Each of these is an operation a room member invokes on that room.
 *
 * `audit` and `close_room` are absent on purpose, because neither names such an operation. bellman_audit
 * takes no session, so it is org-wide and no room role can gate it. No tool closes a room on a member's
 * say-so: a room ends when its last member leaves. Each verb returns in the PR that adds its operation.
 * Adding one sooner lets a role's `can` promise something no code can keep.
 */
export const VERBS = [
  "send", "invite", "revoke", "request_actions", "respond_actions",
] as const satisfies readonly Verb[];

export const PRESET_NAMES = ["pair", "swarm", "review"] as const satisfies readonly PresetName[];

const MAX_ROLES = 16;
const MAX_ROLE_NAME = 31; // a leading letter plus RoleKeyShape's {0,30}: its longest string

/** A manifest that could not be resolved. The server turns this into a tool error. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

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
 * The one definition of a legal role key. Validate every externally supplied
 * role name with it before using the name as a lookup key: banning a name from
 * `roles` does not make a lookup by that name safe — `roles["constructor"]` on a
 * plain object is the inherited Object function even when no such role exists.
 *
 * The ban is checked first on purpose. `__proto__` also fails the regex, but
 * "reserved" is the more useful thing to tell the author.
 */
export const RoleKeyShape = z.string()
  .refine(
    (key) => !RESERVED_ROLE_KEYS.has(key),
    `role keys must not be one of: ${[...RESERVED_ROLE_KEYS].join(", ")}`,
  )
  .regex(
    /^[a-z][a-z0-9_]{0,30}$/,
    "role keys must match [a-z][a-z0-9_]{0,30}",
  );

const RoleDefShape = z.strictObject({
  can: z.array(z.enum(VERBS)).max(VERBS.length),
  description: z.string().max(300).nullish(),
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

const CiteShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  preset: z.enum(PRESET_NAMES),
});

const AuthorShape = z.strictObject({
  room: z.string().min(1).max(80),
  purpose: z.string().max(300).nullish(),
  mode: z.enum(["pair", "swarm"]),
  roles: RolesShape,
  // Both are echoed verbatim by the cross-field errors, which reach tool errors and
  // the audit log, so they are bounded like every other string in the shape.
  default_role: z.string().max(MAX_ROLE_NAME),
  creator_role: z.string().max(MAX_ROLE_NAME),
});

/** One issue as "path: message". Symbol-safe: a symbol key can reach a path. */
function describeIssue(i: { path: PropertyKey[]; message: string }): string {
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

// ---------------------------------------------------------------------------
// Preset catalog
// ---------------------------------------------------------------------------

type PresetBody = Omit<RoomManifest, "room" | "purpose" | "preset">;

function role(can: Verb[], description: string): RoleDef {
  return { can, description };
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
        ["send", "request_actions", "respond_actions", "invite", "revoke"],
        "Creator. Equal in conversation, holds room control.",
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
        ["send", "invite", "revoke", "request_actions", "respond_actions"],
        "Runs the room: controls who can join.",
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
        ["send", "invite", "revoke", "request_actions", "respond_actions"],
        "Brought the work. Can ask the reviewer to do things.",
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
    const body = PRESETS[v.preset];
    return {
      room: v.room,
      purpose: v.purpose ?? null,
      preset: v.preset,
      mode: body.mode,
      roles: structuredClone(body.roles),
      defaultRole: body.defaultRole,
      creatorRole: body.creatorRole,
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
    roles[key] = { can: [...def.can], description: def.description ?? null };
  }

  return {
    room: v.room,
    purpose: v.purpose ?? null,
    preset: null,
    mode: v.mode,
    roles,
    defaultRole: v.default_role,
    creatorRole: v.creator_role,
  };
}
