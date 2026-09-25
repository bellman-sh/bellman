import {
  chmodSync, closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync,
  writeFileSync, writeSync,
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
/**
 * Create the credential directory, and leave it at 0700 whether or not this call
 * was the one that created it.
 *
 * Both steps, always: mkdirSync's `mode` applies only to a directory it actually
 * creates, so a ~/.config/bellman that already exists at 0755 keeps 0755 and the
 * option quietly does nothing.
 *
 * One function rather than the rule written twice, because writing it twice is
 * not a hypothetical here — it already went wrong. The mode-is-ignored trap was
 * found and fixed in writeServer, and then the pre-fix version was written again
 * in acquireLock: two implementations of one rule in one repo, one of them known
 * to be wrong before the other was typed. Every creator of this directory goes
 * through here.
 */
function ensureCredentialsDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writeServer(dir: string, serverUrl: string, cred: ServerCredential): void {
  // Modes are set twice on purpose: the `mode` option covers creation (a fresh
  // file is never on disk at the default mode), the chmod covers a directory or
  // file that already existed, where the option is ignored. Directory first, so
  // an old loose file is already out of reach by the time it is rewritten; the
  // file before it is read or written, so one left at 0400 or 0000 can still be
  // opened. The chmod after the write covers a umask that stripped bits.
  ensureCredentialsDir(dir);
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

/**
 * Can this credential be used right now, without refreshing?
 *
 * The canonical 60-second skew rule, and **currently called by no production
 * code** — do not take that as a reason to delete it. It is the one written
 * statement of when a token is too close to expiry to spend, and the reason
 * nothing calls it is that no caller has yet needed that question:
 *
 *   - connectSignedIn asks a broader one, "is there any token worth trying",
 *     because with the provider in play the SDK refreshes a stale one itself.
 *   - signedInAs asks a different one, "whose account is this", and must NOT
 *     apply the skew rule: a token ten minutes old that the SDK will refresh
 *     without anyone noticing still names the right person, and reporting
 *     "unknown" for it would be a false answer in the common case.
 *
 * A caller that needs "spendable right now" belongs here rather than deriving
 * it again, which is the drift this exists to prevent.
 */
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

export interface LockHandle {
  /** Idempotent. Removes the lock file only if it is still the one this handle created. */
  release(): void;
}

export interface LockOptions {
  waitMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  pidAlive?: (pid: number) => boolean;
  /**
   * Gives up waiting early. waitMs is six minutes, and a bridge shutting down
   * while another holds the lock would otherwise sit here long past the point
   * Claude Code stops waiting and force-terminates it — which is precisely how
   * a lock gets leaked, the failure the exit handler below exists to prevent.
   *
   * Aborting is a way of giving up, so it resolves undefined like every other
   * give-up rather than throwing: the caller already has to handle "no lock",
   * and only the caller knows whether being cancelled is an error.
   */
  signal?: AbortSignal;
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
 *
 * The lock is released when the process exits, so quitting mid-sign-in leaves
 * nothing behind. A SIGKILL, a crash or a power cut still does, and staleness
 * reclaims that.
 */
export async function acquireLock(dir: string, opts: LockOptions = {}): Promise<LockHandle | undefined> {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const pidAlive = opts.pidAlive ?? livePid;

  ensureCredentialsDir(dir);
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;

  for (;;) {
    // Checked every pass, not only beside the deadline: a reclaim `continue`s
    // without ever reaching that branch, so a shutdown could otherwise keep
    // going round while stale locks kept appearing.
    if (opts.signal?.aborted) return undefined;
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
    const release = (): void => {
      if (released) return;
      released = true;
      process.off("exit", onExit);
      clearInterval(timer);
      // Ask before closing, not after: fstat on a closed descriptor is EBADF, and
      // while ours is open nothing else can be handed the inode number it names.
      const ours = stillOurs(handle, path);
      try { closeSync(handle); } catch { /* already closed */ }
      /**
       * `force` suppresses ENOENT and nothing else, so a directory that refuses
       * the unlink throws EPERM out of release() — and release() is called from
       * two `finally` blocks that are not wrapped: writeMerged's, on a live tool
       * call, and connectSignedIn's, holding a sign-in that has just succeeded.
       * Either one would discard a working result over a lock file that could
       * not be tidied up, and the SDK would then relabel it Unauthorized. A
       * stale lock is reclaimed by the next holder after staleMs; a thrown
       * release is not recoverable by anyone.
       */
      if (ours) {
        try { rmSync(path, { force: true }); } catch { /* the next holder reclaims it as stale */ }
      }
    };
    // Quitting Claude Code mid-sign-in must not leave a stale lock. The bridge quits
    // through process.exit (its SIGTERM, SIGINT and stdin-close handlers in
    // src/channel.ts all end there), and Node runs 'exit' listeners on the way out.
    // 'exit' only, and deliberately no SIGINT or SIGTERM listener of our own:
    // registering one replaces Node's default of terminating, so Ctrl-C would stop
    // killing the process unless every handler re-raised. Taken off again by
    // release(), so concurrent locks cannot trip MaxListenersExceededWarning.
    // A declaration, not a `const`: release() above closes over this name, and
    // with a const the two are one reorder away from a ReferenceError thrown out
    // of release() — at process exit, where it has nowhere to be reported.
    //
    // No try/catch of its own. release() is total, and there is a test on
    // release() itself saying so; wrapping it here as well would be a guard no
    // test can fail, and it is what let the old test's name ("keeps an exit that
    // cannot remove the file quiet") read as a promise about release when it
    // only ever exercised this wrapper.
    function onExit(): void {
      release();
    }
    process.on("exit", onExit);
    return { release };
  }
}

/**
 * Is the file at `path` still the one `handle` created? A holder whose lock was
 * reclaimed (a laptop that slept past staleMs, a pid check that said gone) has had
 * its file unlinked and replaced by the next holder's. Removing "the lock" then
 * would delete theirs, and a third bridge could walk in beside a live holder.
 *
 * Same device and inode number, read as bigints so a 64-bit id (NFS, NTFS) is exact.
 * Inode reuse cannot fool this: while our descriptor is open the filesystem cannot
 * hand the number of an unlinked inode to a new file, so equality means the very
 * same file. That is why release() must ask BEFORE it closes the descriptor.
 *
 * Any error means we cannot tell, and the file is left. ENOENT is nothing to
 * remove; for the rest, a leftover of our own goes stale in staleMs and is
 * reclaimed, where a live holder's lock deleted does not come back.
 */
function stillOurs(handle: number, path: string): boolean {
  try {
    const mine = fstatSync(handle, { bigint: true });
    const there = statSync(path, { bigint: true });
    return there.dev === mine.dev && there.ino === mine.ino;
  } catch {
    return false;
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
    //
    // The window is symmetric. An empty file has no pid to fall back on, so a mtime
    // in the future (NFS skew, a backward clock step) that was never called stale
    // would hold the lock until the wall clock caught up, with the user told that
    // another sign-in has it. Beyond staleMs a future mtime means a clock is wrong,
    // and bounded eviction beats unbounded deadlock. Within staleMs it may be clock
    // granularity alone, and it stays a holder.
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      return age > staleMs || age < -staleMs;
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
