/**
 * Room file paths (ADR 0046). Runtime-free. Every path is normalized here before any authorization reads it, so a
 * namespace check never sees a `..`, a doubled slash, or one of two spellings of the same name.
 */

export const MAX_PATH_CHARS = 512;
export const MAX_PATH_SEGMENTS = 32;

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

// C0, DEL and C1 controls, NUL among them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** NFC, slashes collapsed, a trailing slash dropped; refuses `.`/`..` segments, controls, and the bounds. */
export function normalizePath(raw: string): PathResult {
  if (CONTROL.test(raw)) return { ok: false, reason: "a path may not hold control characters" };
  if (!raw.startsWith("/")) return { ok: false, reason: "a path starts with /" };
  const segments = raw.normalize("NFC").split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, reason: "a path may not hold . or .. segments" };
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, reason: `at most ${MAX_PATH_SEGMENTS} segments` };
  const path = "/" + segments.join("/");
  if (path.length > MAX_PATH_CHARS) return { ok: false, reason: `at most ${MAX_PATH_CHARS} characters` };
  return { ok: true, path };
}

/** The alias a seat writes its own account's memory under before it knows the id. */
export const OWN_MEMORY = "me";

export type Namespace =
  | { ns: "memory"; memoryId: string | null }
  | { ns: "bellman" }
  | { ns: "app"; key: string | null }
  | { ns: "room" };

/** Which of the four kinds a normalized path is (ADR 0046, spec §3 "Paths"). */
export function namespaceOf(path: string): Namespace {
  const [top, second] = path.split("/").slice(1);
  if (top === "members") return { ns: "memory", memoryId: second ?? null };
  if (top === ".bellman") return { ns: "bellman" };
  if (top === "apps") return { ns: "app", key: second ?? null };
  return { ns: "room" };
}
