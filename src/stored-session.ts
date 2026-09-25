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
 * Rows written before Session.manifest existed have no manifest, and a read
 * of `session.manifest.mode` on one is a TypeError. They cannot be migrated
 * — a manifest is a declaration, and inventing one would put words in the
 * creator's mouth — so they are treated as gone and age out on their own TTL.
 */
export function hydrateStoredSession(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = (raw as { manifest?: unknown }).manifest;
  if (!m || typeof m !== "object") return undefined;
  const roles = (m as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;
  return raw as StoredSession;
}
