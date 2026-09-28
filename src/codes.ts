import { randomBytes, randomUUID } from "node:crypto";

// No 0/O, 1/I/L — codes get relayed over voice and chat.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

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
