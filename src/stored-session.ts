import type { Session } from "./types.js";

// Deliberately not in store-do.ts. That module imports `cloudflare:workers`, which
// exists only inside workerd, so a test can load it only by stubbing that module, and
// then has to stay out of the Node typecheck (see tests/store-do-wiring.test.ts). What
// a plain test has to reach lives here, with no Cloudflare imports.

/** The session record as stored — events live under their own keys. */
export type StoredSession = Omit<Session, "events">;

/**
 * Gate every session read out of Durable Object storage.
 *
 * Two fields were added after the sessions now in production were written, and
 * they want opposite treatment:
 *
 * - **manifest** cannot be defaulted. It is a declaration, and inventing one
 *   would put words in the creator's mouth — while a read of
 *   `session.manifest.mode` on a row without one is a TypeError. So such rows
 *   are treated as gone: no read returns them, and nothing rewrites them.
 * - **frozenAt** can, and must. Every guard is written `frozenAt !== null`,
 *   and `undefined !== null`, so a row without it would report frozen and
 *   refuse every write in that room. Null is the honest default: a session
 *   nobody froze is not frozen.
 *
 * Both live here, in one gate, rather than in two functions that could drift.
 */
export function hydrateStoredSession(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = (raw as { manifest?: unknown }).manifest;
  if (!m || typeof m !== "object") return undefined;
  const roles = (m as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;
  const row = raw as StoredSession;
  return { ...row, frozenAt: row.frozenAt ?? null };
}
