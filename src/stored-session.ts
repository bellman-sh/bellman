import type { RoomManifest, Session } from "./types.js";
import { ENTITLEMENTS } from "./auth.js";

// Deliberately not in store-do.ts. That module imports `cloudflare:workers`, which
// exists only inside workerd, so a test can load it only by stubbing that module, and
// then has to stay out of the Node typecheck (see tests/store-do-wiring.test.ts). What
// a plain test has to reach lives here, with no Cloudflare imports.

/** The session record as stored — events live under their own keys. */
export interface StoredSession extends Omit<Session, "events"> {
  /**
   * When the heartbeat alarm last fired for this room (#111).
   *
   * **A floor under the tick's due time, not the clock it runs on.** A tick does
   * not move any member's `lastReportAt`, so a due time computed from member
   * reports alone stays in the past for a member that never answers, and
   * `reArm()` would point the alarm back at it indefinitely — the hazard
   * `alarm()`'s comment records for `due:outbox`. This strictly advances on every
   * firing, written or not, so a due time resting on it does too.
   *
   * It is a floor and not the clock because a clock loses the other half: every
   * member anchored on one firing means a member that reported just after a tick
   * waits nearly two cadences to be asked. `nextTickAt` therefore gives each
   * member its own deadline and applies this only to the members that firing
   * actually asked — the ones already due at it. `askAt` in heartbeat.ts carries
   * the argument and the two properties it has to keep.
   *
   * Absent until the first firing, and `nextTickAt` needs no floor until then:
   * nothing has been asked yet, so every member simply owes its own deadline,
   * which `lastReport` dates from `joinedAt` for one that has never answered.
   */
  lastTickAt?: number;
  /**
   * When the most recent `action_request` was appended (#81).
   *
   * Bookkeeping for one question `bellman_sync` has to answer on every poll:
   * are there outstanding action requests? The answer is DERIVED from the event
   * log and stays derived — this never says what any request's state is. It
   * says whether the log is worth reading at all.
   *
   * Two things fall out of it, and the second is why it is a timestamp rather
   * than a cursor. Absent means no `action_request` has ever been appended
   * here, so nothing can be outstanding. Present but older than
   * ACTION_REQUEST_TTL_MS means the NEWEST request has expired, so every
   * request has, and nothing can be outstanding then either. Only a room with a
   * request inside the window pays for the read.
   *
   * Absent on records written before this landed, which reads as "no requests"
   * — wrong for a room that had one in the last half hour at the moment of
   * deploy, and self-correcting on its next `action_request`. A listing that is
   * briefly short beats a migration over rooms that expire anyway.
   */
  lastActionRequestAt?: number;
  /**
   * The cursor of the last `surface` event that changed a row (#129): a write
   * that replaced or added one, or a removal that deleted one. A removal of a
   * key that held nothing does not move it. Moves in the same put as the row,
   * monotonically, so a poll can report "the surface moved" off the record it
   * already read, with no row read. Absent on rows written before this landed;
   * `hydrateStoredSession` lifts it to 0 and `surfaceCursor` in surface.ts
   * reads it through `?? 0` for the in-memory store, which does not hydrate.
   */
  surfaceCursor?: number;
  /**
   * The bytes charged to this room's blob store so far (#183): the sum every
   * successful `chargeBlobBytes` added, and nothing credits it — a deletion is a
   * retention decision (#65) and lands with its own credit. Absent on rows
   * written before this landed; `hydrateStoredSession` lifts it to 0 and
   * `blobBytesUsed` in blobs.ts reads it through `?? 0` for the in-memory
   * store, which does not hydrate.
   */
  blobBytes?: number;
}

/**
 * Gate every session read out of Durable Object storage.
 *
 * Eight changes to the stored shape landed after the sessions now in production
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
 * - **surfaceCursor** (#129) defaults to `0`: a room written before the surface
 *   existed has never had a row change, which is what 0 says.
 * - **expiresAt and maxMembers** (#18) are stripped. Rooms persist, so a missing
 *   clock is the state every row is in now, and capacity is `capacityOf(manifest)`,
 *   so a stored cap would be the stale mirror the Session type forbids. A swarm
 *   room created under an 8- or 25-member cap holds the ceiling from its next read.
 * - **blobBytes** (#183) defaults to `0`: a room written before blobs existed
 *   has been charged nothing, which is what 0 says.
 * - **blobBytesCeiling** (#183) defaults to the free plan's ceiling. A room
 *   written before the field was stamped from no plan, so the conservative
 *   number is the honest one, and it ends with the room rather than being
 *   migrated.
 *
 * All eight live here, in one gate, rather than in separate functions that could drift.
 */
export function hydrateStoredSession(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = (raw as { manifest?: unknown }).manifest;
  if (!m || typeof m !== "object") return undefined;
  const roles = (m as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;

  const {
    joinCode, joinCodeExpiresAt, expiresAt: _clock, maxMembers: _cap, ...row
  } = raw as StoredSession & {
    joinCode?: string | null; joinCodeExpiresAt?: number; expiresAt?: number; maxMembers?: number;
  };

  return {
    ...row,
    manifest: withHeartbeatDefaults(row.manifest),
    frozenAt: row.frozenAt ?? null,
    surfaceCursor: row.surfaceCursor ?? 0,
    blobBytes: row.blobBytes ?? 0,
    // Required on the type, absent on a row written before #183: the cast says
    // so where `??` alone would read as redundant.
    blobBytesCeiling: (row as { blobBytesCeiling?: number }).blobBytesCeiling ?? ENTITLEMENTS.free.blobBytesPerRoom,
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
