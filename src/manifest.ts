import { z } from "zod";
import type { PresetName, RoleDef, RoomManifest, Verb } from "./types.js";

export const VERBS = [
  "send", "invite", "revoke", "request_actions",
  "respond_actions", "audit", "close_room",
] as const satisfies readonly Verb[];

export const PRESET_NAMES = ["pair", "swarm", "review"] as const satisfies readonly PresetName[];

const MAX_ROLES = 16;

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
 * Role keys are validated by regex, not merely by type. The leading [a-z] rules
 * out `__proto__` and every other Object.prototype member except `constructor`,
 * which IS a legal role name (stored as an ordinary own property). Code that
 * looks a role up by an untrusted name must therefore use Object.hasOwn — never
 * `in` or bare indexing, which would find the inherited `constructor` function.
 */
export const RoleKeyShape = z.string().regex(
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
  default_role: z.string(),
  creator_role: z.string(),
});

export const ManifestShape = z.union([CiteShape, AuthorShape]);
export type ManifestInput = z.input<typeof ManifestShape>;

// ---------------------------------------------------------------------------
// Preset catalog
// ---------------------------------------------------------------------------

type PresetBody = Omit<RoomManifest, "room" | "purpose" | "preset">;

function role(can: Verb[], description: string): RoleDef {
  return { can, description };
}

export const PRESETS: Record<PresetName, PresetBody> = {
  pair: {
    mode: "pair",
    roles: {
      peer_a: role(
        ["send", "request_actions", "respond_actions", "invite", "revoke", "close_room"],
        "Creator. Equal in conversation, holds room control.",
      ),
      peer_b: role(
        ["send", "request_actions", "respond_actions"],
        "Equal peer in conversation; cannot invite or close the room.",
      ),
    },
    defaultRole: "peer_b",
    creatorRole: "peer_a",
  },
  swarm: {
    mode: "swarm",
    roles: {
      lead: role(
        ["send", "invite", "revoke", "request_actions", "respond_actions", "audit", "close_room"],
        "Runs the room: invites, audits, closes.",
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
        ["send", "invite", "revoke", "request_actions", "respond_actions", "close_room"],
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
  const i = err.issues[0];
  const path = i.path.join(".");
  return path ? `${path}: ${i.message}` : i.message;
}

/**
 * Turn either input arm into one fully-expanded manifest.
 *
 * Expansion happens HERE and only here: what the store holds is always
 * concrete roles, never a preset reference. #2 and #3 read `roles` and never
 * learn that presets exist.
 */
export function resolveManifest(input: unknown): RoomManifest {
  // Surface a readable preset error before the union collapses into a dump.
  if (
    typeof input === "object" && input !== null &&
    "preset" in input && typeof (input as { preset: unknown }).preset === "string" &&
    !PRESET_NAMES.includes((input as { preset: string }).preset as PresetName)
  ) {
    throw new ManifestError(
      `unknown preset "${(input as { preset: string }).preset}" (valid: ${PRESET_NAMES.join(", ")})`,
    );
  }

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
