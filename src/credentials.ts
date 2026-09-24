import {
  chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
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

/**
 * `$XDG_CONFIG_HOME/bellman`, or `~/.config/bellman`. Always absolute: it throws
 * rather than return a relative path (see homeDir).
 */
export function credentialsDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  // A relative XDG_CONFIG_HOME would put credentials wherever the bridge
  // happened to be spawned. Fall back rather than honour it.
  if (xdg && isAbsolute(xdg)) return join(xdg, "bellman");
  return join(homeDir(), ".config", "bellman");
}

/**
 * os.homedir() returns $HOME as it finds it, so HOME="" or a relative HOME would
 * put the credential in whatever directory the bridge was spawned from — very
 * possibly a git tree. Same rule as XDG_CONFIG_HOME: do not honour it, ask the
 * password database instead, and refuse to guess if that is no better.
 */
function homeDir(): string {
  const home = homedir();
  if (isAbsolute(home)) return home;
  const fromPasswd = userInfo().homedir;
  if (isAbsolute(fromPasswd)) return fromPasswd;
  throw new Error("no absolute home directory found for the credential file; set XDG_CONFIG_HOME to an absolute path");
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
  const { servers } = readFile(dir);
  // Own keys only: `servers` is parsed JSON, so "constructor" or "__proto__"
  // would otherwise resolve to something inherited.
  if (!Object.hasOwn(servers, serverUrl)) return {};
  // And only an object: a hand-edited entry of any other shape reads as absent,
  // like every other bad file.
  const entry: unknown = servers[serverUrl];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return {};
  return entry as ServerCredential;
}

/**
 * Replace one server's entry, leaving every other server alone — production and
 * a `wrangler dev` server share the file and must never clobber each other.
 *
 * Throws on a filesystem failure — EPERM from the chmods on a path another user
 * owns, EACCES, ENOSPC — and writes nothing if it cannot first secure the
 * directory or an existing file.
 */
export function writeServer(dir: string, serverUrl: string, cred: ServerCredential): void {
  // Modes are set twice on purpose: the `mode` option covers creation (a fresh
  // file is never on disk at the default mode), the chmod covers a directory or
  // file that already existed, where the option is ignored. Directory first, so
  // an old loose file is already out of reach by the time it is rewritten; the
  // file before it is read or written, so one left at 0400 or 0000 can still be
  // opened. The chmod after the write covers a umask that stripped bits.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILE);
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    // No file yet is fine: the mode option below covers creating it.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const file = readFile(dir);
  file.servers[serverUrl] = cred;
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
  // Read back from a file a person may have edited: `string` is a hope, not a fact.
  if (typeof accessToken !== "string") return undefined;
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

export const LOCK_FILE = "credentials.lock";

const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;
const WAIT_MS = 360_000; // the 5 minute browser cap, plus slack
const POLL_MS = 100;

interface LockBody { pid: number; heartbeat_at: number }

export interface LockHandle { release(): void }

export interface LockOptions {
  waitMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  pidAlive?: (pid: number) => boolean;
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without signalling
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One advisory lock over the credential directory, so concurrent bridges open
 * ONE browser tab and do ONE refresh.
 *
 * The holder heartbeats rather than racing a fixed deadline. A plain age
 * threshold cannot work: a human finishing a browser sign-in may hold this for
 * minutes, and any threshold short enough to reclaim a crashed process promptly
 * is short enough to evict a live one mid-sign-in — which produces exactly the
 * second browser tab the lock exists to prevent.
 *
 * Resolves undefined when waitMs elapses. The caller re-reads the credential
 * file at that point: someone else's sign-in may be all it needed.
 *
 * Throws on a filesystem error that is not contention (an unwritable directory,
 * a full disk): there is nothing to wait for, and waiting would only hide it.
 */
export async function acquireLock(dir: string, opts: LockOptions = {}): Promise<LockHandle | undefined> {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const pidAlive = opts.pidAlive ?? livePid;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600); // O_EXCL: fails if it already exists
    } catch (err) {
      // Only "already exists" is contention. Anything else — EACCES on a directory
      // that cannot be written, ENOSPC, EROFS — is not a corpse to reclaim: the
      // loop below would remove nothing, retry at once, and (no await on that
      // path) never yield to the event loop.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (reclaimable(path, staleMs, pidAlive)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(POLL_MS);
      continue;
    }

    const handle = fd;
    const beat = () => {
      try {
        const body: LockBody = { pid: process.pid, heartbeat_at: Date.now() };
        ftruncateSync(handle, 0);
        writeSync(handle, JSON.stringify(body), 0);
      } catch {
        // A vanished lock file is someone else's business; release is still
        // correct and the next acquire sorts it out.
      }
    };
    beat();
    const timer = setInterval(beat, heartbeatMs);
    // Never hold the event loop open for a heartbeat — the bridge must be able
    // to exit while a lock is held.
    timer.unref?.();

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        clearInterval(timer);
        try { closeSync(handle); } catch { /* already closed */ }
        rmSync(path, { force: true });
      },
    };
  }
}

function reclaimable(path: string, staleMs: number, pidAlive: (pid: number) => boolean): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Gone between the failed open and this read: the holder released. There is
    // nothing to reclaim, and removing "it" now could take out the lock a third
    // bridge has just created in its place — a second holder.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // unreadable: a corpse, not a holder
  }
  if (raw === "") {
    // Not a corpse yet. Creating the lock (open, then write) and every heartbeat
    // (truncate, then write) are separate syscalls, so a live holder is empty for
    // a moment, and a waiter that called that a corpse would evict it. Judge it by
    // mtime, which those very writes refresh, like any other heartbeat: only an
    // empty file nothing has touched for staleMs is a holder that died mid-write.
    try {
      return Date.now() - statSync(path).mtimeMs > staleMs;
    } catch {
      return false; // released between the read and the stat: as above, not ours to remove
    }
  }
  let body: LockBody;
  try {
    body = JSON.parse(raw) as LockBody;
  } catch {
    // Garbled or half-written: a corpse, not a holder.
    return true;
  }
  // Valid JSON that is not a lock body is the same corpse. `null` most of all:
  // it parses, and the property reads below would throw on it.
  if (!body || typeof body.pid !== "number" || typeof body.heartbeat_at !== "number") return true;
  if (!pidAlive(body.pid)) return true;
  return Date.now() - body.heartbeat_at > staleMs;
}
