import { randomBytes, randomUUID } from "node:crypto";
import { MAX_ROLE_KEY_LENGTH } from "./manifest.js";

// No 0/O, 1/I/L — codes get relayed over voice and chat.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * The longest string renderJoinCode can produce: the fixed "BELL-XXXX-XX-"
 * prefix plus the longest legal role name (the `_` -> `-` swap is 1-for-1, so
 * it does not change length). Anything that accepts a join code as input —
 * bellman_connect's `join_code` argument — must be bounded at least this high,
 * or a role name long enough to reach MAX_ROLE_KEY_LENGTH mints a code the
 * server then refuses. tests/codes.test.ts pins the inequality directly.
 */
export const MAX_JOIN_CODE_LENGTH = "BELL-XXXX-XX-".length + MAX_ROLE_KEY_LENGTH;

function chunk(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Human-relayable join code carrying its role, e.g. BELL-7F3K-92-REVIEWER.
 *
 * The role group is a word, so the restricted alphabet above does not apply to
 * it: that alphabet exists because the random groups have no word context to
 * disambiguate O from 0. `_` renders as `-` because RoleKeyShape
 * (`[a-z][a-z0-9_]{0,30}`) forbids `-` inside a role name, which makes the
 * mapping a bijection. Nothing ever parses this back — see the store.
 */
export function renderJoinCode(role: string): string {
  return `BELL-${chunk(4)}-${chunk(2)}-${role.toUpperCase().replaceAll("_", "-")}`;
}

export function generateSessionId(): string {
  return `qs_${randomUUID()}`;
}

export function generateConnectToken(): string {
  return `qct_${randomUUID()}`;
}

export function normalizeJoinCode(raw: string): string {
  // `_` -> `-` so a code retyped from memory with the wrong separator resolves.
  return raw.trim().toUpperCase().replace(/\s+/g, "").replaceAll("_", "-");
}

/**
 * The page a join code is shared as. bellman.sh renders it from the code
 * alone — it never calls back here — so a self-hosted server's codes get the
 * same page. One constant, not configuration: an operator who wants their own
 * page changes this line. Spec: docs/superpowers/specs/2026-10-06-join-links-design.md, D9.
 */
export const JOIN_URL_BASE = "https://bellman.sh/j/";

export function joinUrl(code: string): string {
  return `${JOIN_URL_BASE}${code}`;
}

/**
 * The page a public room is read at (public rooms spec D6): dash, outside sign-in, by the room's id.
 * A page to read and not a door: it seats nobody, where a join URL hands a seat to whoever redeems it until it expires.
 */
export const PUBLIC_ROOM_URL_BASE = "https://dash.bellman.sh/r/";

export function publicRoomUrl(sessionId: string): string {
  return `${PUBLIC_ROOM_URL_BASE}${sessionId}`;
}
