import type { RoomManifest, Session } from "./types.js";

// Deliberately not in store-do.ts. That module imports `cloudflare:workers`, which
// exists only inside workerd, so a test can load it only by stubbing that module, and
// then has to stay out of the Node typecheck (see tests/store-do-wiring.test.ts). What
// a plain test has to reach lives here, with no Cloudflare imports.

/** The session record as stored — events live under their own keys. */
export interface StoredSession extends Omit<Session, "events"> {
  /**
   * When the heartbeat alarm last fired for this room (#111).
   *
   * The tick's clock, and the reason the alarm cannot spin: a tick does not move
   * any member's `lastReportAt`, so a due time computed from member reports
   * alone stays in the past for a member that never answers, and `reArm()` would
   * point the alarm back at it indefinitely — the hazard `alarm()`'s comment
   * records for `due:outbox`. This strictly advances on every firing.
   *
   * Absent until the first firing; `nextTickAt` anchors on the earliest
   * reporting member's `joinedAt` until then.
   */
  lastTickAt?: number;
}

/**
 * Gate every session read out of Durable Object storage.
 *
 * Four changes to the stored shape landed after the sessions now in production
 * were written, and they want different treatment:
 *
 * - **manifest** cannot be defaulted. It is a declaration, and inventing one
 *   would put words in the creator's mouth — while a read of
 *   `session.manifest.mode` on a row without one is a TypeError. So such rows
 *   are treated as gone: no read returns them, and nothing rewrites them.
 * - **frozenAt** can, and must. Every guard is written `frozenAt !== null`,
 *   and `undefined !== null`, so a row without it would report frozen and
 *   refuse every write in that room. Null is the honest default: a session
 *   nobody froze is not frozen.
 * - **joinCode / joinCodeExpiresAt** are lifted into `joinCodes`, keyed by the
 *   manifest's default role, and then stripped. Stripped rather than kept
 *   because a `joinCode` beside `joinCodes` is the stale mirror the Session
 *   type forbids. The legacy string has no role group and needs none: the whole
 *   string is the index key, so it resolves as written and expires naturally.
 *   Read-time rather than a bulk migration because there is no list of sessions
 *   to iterate — the registry indexes by creator and by code, never by "all".
 * - **manifest.heartbeatOnMs / manifest.roles[].reports** (#111) default to
 *   `null` and `false`: the room as it was run until now, with no cadence and no
 *   seat asked to report. That is not the first bullet's mistake, because a
 *   manifest that never mentioned a cadence declares none, so the default
 *   invents nothing. Left alone, both read as `undefined`, which is neither: a
 *   guard written `=== null` misses the cadence and goes on to do arithmetic with
 *   it, and `mustReport` hands out an `undefined` its signature calls a boolean.
 *
 * All four live here, in one gate, rather than in separate functions that could drift.
 */
export function hydrateStoredSession(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = (raw as { manifest?: unknown }).manifest;
  if (!m || typeof m !== "object") return undefined;
  const roles = (m as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;

  const {
    joinCode, joinCodeExpiresAt, ...row
  } = raw as StoredSession & { joinCode?: string | null; joinCodeExpiresAt?: number };

  return {
    ...row,
    manifest: withHeartbeatDefaults(row.manifest),
    frozenAt: row.frozenAt ?? null,
    joinCodes:
      row.joinCodes ??
      (joinCode ? { [row.manifest.defaultRole]: { code: joinCode, expiresAt: joinCodeExpiresAt ?? 0 } } : {}),
  };
}

/**
 * A manifest as every consumer may assume it is: `heartbeatOnMs` a number or
 * null, and `reports` a boolean on every role.
 *
 * The types already say so, because every row written since the heartbeat has
 * both. The `??` is for the rows that predate it. New objects all the way down
 * rather than assignments into the row, so the gate stays a pure function of what
 * it was handed.
 */
function withHeartbeatDefaults(m: RoomManifest): RoomManifest {
  return {
    ...m,
    heartbeatOnMs: m.heartbeatOnMs ?? null,
    roles: Object.fromEntries(
      Object.entries(m.roles).map(([key, def]) => [key, { ...def, reports: def.reports ?? false }]),
    ),
  };
}
