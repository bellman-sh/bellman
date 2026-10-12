// src/handles.ts
/**
 * A public handle (bylines spec D1): the name a room's creator signs a public room with, in place
 * of their sign-in label, which is an email address for most (ADR 0011). Runtime-free, so the
 * routes and the tests share one rule.
 */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "bellman", "admin", "administrator", "support", "help", "root", "system", "staff", "team", "host",
  "api", "mcp", "dash", "www", "about", "settings", "null", "undefined", "anthropic", "claude",
]);

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; error: "handle_invalid" | "handle_reserved"; description: string };

export function checkHandle(raw: unknown): HandleCheck {
  if (typeof raw !== "string") return { ok: false, error: "handle_invalid", description: "handle must be a string" };
  const handle = raw.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    return {
      ok: false,
      error: "handle_invalid",
      description: "a handle is 3 to 30 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen",
    };
  }
  if (RESERVED_HANDLES.has(handle)) return { ok: false, error: "handle_reserved", description: `${handle} is reserved` };
  return { ok: true, handle };
}
