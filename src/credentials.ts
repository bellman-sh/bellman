import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Identity } from "./types.js";

/**
 * Where the bridge keeps the credential it signed in with.
 *
 * This module is the storage boundary and nothing else: no network, no OAuth,
 * no MCP. It is the half of self-serve credentials that can be tested against a
 * temp directory with no server in sight.
 */

const FILE = "credentials.json";
/** Treat a token inside this window as already expired, so a call never races it. */
const EXPIRY_SKEW_MS = 60_000;

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Absolute epoch milliseconds, computed on save from the SDK's expires_in. */
  expires_at?: number;
}

export interface ServerCredential {
  client?: { client_id: string };
  tokens?: StoredTokens;
  /**
   * The access token's `bellman` claim, stored verbatim so there is no second
   * shape to keep in step. UNVERIFIED — see decodeIdentity.
   */
  identity?: Identity;
}

export interface CredentialFile {
  version: 1;
  servers: Record<string, ServerCredential>;
}

/** `$XDG_CONFIG_HOME/bellman`, or `~/.config/bellman`. */
export function credentialsDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  // A relative XDG_CONFIG_HOME would put credentials wherever the bridge
  // happened to be spawned. Fall back rather than honour it.
  if (xdg && isAbsolute(xdg)) return join(xdg, "bellman");
  return join(homedir(), ".config", "bellman");
}

/**
 * Read the whole file. Anything unreadable, unparseable, or not shaped like a
 * version 1 credential file reads as empty: failing closed would strand the
 * user with no way back but to find and delete a file, and a fresh sign-in
 * costs one browser tab.
 */
function readFile(dir: string): CredentialFile {
  let raw: string;
  try {
    raw = readFileSync(join(dir, FILE), "utf8");
  } catch {
    return { version: 1, servers: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialFile>;
    if (parsed.version !== 1) return { version: 1, servers: {} };
    const servers = parsed.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return { version: 1, servers: {} };
    }
    return { version: 1, servers: servers as Record<string, ServerCredential> };
  } catch {
    return { version: 1, servers: {} };
  }
}

export function readServer(dir: string, serverUrl: string): ServerCredential {
  return readFile(dir).servers[serverUrl] ?? {};
}

/**
 * Replace one server's entry, leaving every other server alone — production and
 * a `wrangler dev` server share the file and must never clobber each other.
 */
export function writeServer(dir: string, serverUrl: string, cred: ServerCredential): void {
  // Modes are set twice on purpose: the `mode` option covers creation (a fresh
  // file is never on disk at the default mode), the chmod covers a directory or
  // file that already existed, where the option is ignored. Directory first, so
  // an old loose file is already out of reach by the time it is rewritten.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = readFile(dir);
  file.servers[serverUrl] = cred;
  const path = join(dir, FILE);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Pull the `bellman` claim out of an access token for display.
 *
 * THIS DOES NOT VERIFY THE SIGNATURE, and must never gate anything. The server
 * verifies its own tokens on every request; this is so `bellman_whoami` and the
 * startup log can name who you are without a round trip. If you find yourself
 * branching on this value for a security decision, you have found a bug.
 */
export function decodeIdentity(accessToken: string): Identity | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const bellman = claims.bellman;
    if (!bellman || typeof bellman !== "object" || Array.isArray(bellman)) return undefined;
    return bellman as Identity;
  } catch {
    return undefined;
  }
}

/** Can this credential be used right now, without refreshing? */
export function tokensUsable(tokens: StoredTokens | undefined, now = Date.now()): boolean {
  if (!tokens?.access_token) return false;
  // No expiry recorded means the server did not say; assume usable and let a
  // 401 correct us. A missing refresh_token is likewise not a problem until the
  // access token expires.
  if (tokens.expires_at === undefined) return true;
  return tokens.expires_at - EXPIRY_SKEW_MS > now;
}
