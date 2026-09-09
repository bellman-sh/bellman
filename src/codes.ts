import { randomBytes, randomUUID } from "node:crypto";

// No 0/O, 1/I/L — codes get relayed over voice and chat.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function chunk(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Human-relayable join code, e.g. QRA-7F3K-92 */
export function generateJoinCode(): string {
  return `QRA-${chunk(4)}-${chunk(2)}`;
}

export function generateSessionId(): string {
  return `qs_${randomUUID()}`;
}

export function generateConnectToken(): string {
  return `qct_${randomUUID()}`;
}

export function normalizeJoinCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}
