# Bridge Self-Serve Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude Code bridge signs itself in through Bellman's OAuth server on first use, instead of requiring an operator to mint a key and redeploy the Worker.

**Architecture:** Two new Node-only modules beside `bridge.ts`. `src/credentials.ts` owns the credential file and a heartbeating lock; `src/signin.ts` implements the MCP SDK's `OAuthClientProvider`, binds a loopback listener on a fixed port range, and exposes `connectSignedIn()` returning the same `Remote` shape `connectRemote()` does. `src/bridge.ts` is unchanged except for one new tool; `src/channel.ts` picks which connect function to call. `src/oauth/` — the authorization server — is not touched.

**Tech Stack:** TypeScript (NodeNext, strict), `@modelcontextprotocol/sdk` 1.30.0, vitest 5 (`pool: "forks"`), Node 22+, `node:http` / `node:fs` / `node:child_process`.

**Spec:** [`docs/superpowers/specs/2026-09-23-bridge-self-serve-credentials-design.md`](../specs/2026-09-23-bridge-self-serve-credentials-design.md)

## Global Constraints

- **Every `BellmanStore` method is async.** Not touched by this plan, but do not
  add a synchronous storage call anywhere.
- **`src/oauth/` is the authorization *server*.** No client code goes there. The
  client half lives beside `bridge.ts` / `inbox.ts` / `channel.ts`.
- **Workers-only files stay excluded from the Node build:** `src/worker.ts`,
  `src/store-do.ts`, `src/oauth/store.ts`. Nothing added here may be imported by
  them, and nothing added here may import `cloudflare:workers`.
- **stdout is the MCP transport.** Every diagnostic goes to stderr, via the
  injected `log` callback. Never `console.log` in `src/`.
- **`npm run verify` (typecheck + build + test) must pass before every commit.**
- **Credential directory is `0700`, credential file is `0600`.** Exact modes.
- **Loopback port range is exactly `51004`–`51008`**, redirect path `/callback`,
  bound in ascending order.
- **Lock timings:** heartbeat every `15_000`ms, stale after `60_000`ms without a
  heartbeat, waiter polls every `100`ms for up to `360_000`ms.
- **Browser callback cap is `300_000`ms.**
- **The stored `identity` is the access token's `bellman` claim verbatim** — the
  camelCase `Identity` from `src/types.ts`. Snake_case only at the tool
  boundary.
- **Decoded JWT claims are display-only and unverified.** Never branch on them
  for a security decision.

## Review Focus

Input classes the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **A forged callback to the loopback.** The SDK generates an OAuth `state` only if the provider implements `state()`, and `finishAuth(code)` takes just the code — so state validation is *ours*. Without it any page in the user's browser can drive a code into `127.0.0.1:51004`. → Task 3, `rejects a callback whose state does not match`.
2. **The human clicks Cancel at GitHub.** The callback arrives with `error=access_denied` and no `code`. It must fail fast with that message, not hang for the full 5 minutes. → Task 3, `fails fast when the callback carries an error instead of a code`.
3. **A credential file that is valid JSON but the wrong shape** — `version: 2`, or `servers` missing entirely. Must read as absent, not throw and not half-load. → Task 1, `reads a wrong-version or malformed file as absent`.
4. **A token response with no `refresh_token`.** The spec assumes one; a server is free to omit it. `tokensUsable` and the refresh path must handle `undefined` rather than crash on first expiry. → Task 1, `treats a credential with no refresh token as usable until it expires`.
5. **Two different server URLs signing in at once** — production and `wrangler dev`. The lock is one file for the whole config directory but credentials are per-server, so the second must wait, then proceed on its *own* server key rather than seeing the first's tokens and using them. → Task 5, `a second server URL waits for the lock, then signs in on its own key`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/credentials.ts` | **Create.** The credential file and the lock. Read, write at 0600, per-server keying, unverified claim decode, lock acquire/heartbeat/release. No network, no OAuth. |
| `src/signin.ts` | **Create.** `OAuthClientProvider` implementation, loopback listener, browser opener, `connectSignedIn()`. |
| `src/bridge.ts` | **Modify.** Add the `bellman_whoami` tool and a `whoami` option. Nothing else. |
| `src/channel.ts` | **Modify.** Choose `connectRemote` vs `connectSignedIn`; stop exiting when `BELLMAN_KEY` is unset; supply `whoami`. |
| `tests/helpers/fake-bellman.ts` | **Create.** A `fetch` that serves the real `handleOAuth` for OAuth paths and a minimal JSON-RPC `/mcp` for the transport, plus a scripted browser. |
| `tests/credentials.test.ts` | **Create.** Store and lock, no server. |
| `tests/signin.test.ts` | **Create.** Real SDK client against the real `handleOAuth`. |
| `tests/bridge.test.ts` | **Modify.** `bellman_whoami` under both credential sources. |
| `README.md` | **Modify.** Drop `-e BELLMAN_KEY=…` from the install lines. |

---

## Task 1: The credential file

**Files:**
- Create: `src/credentials.ts`
- Create: `tests/credentials.test.ts`

**Interfaces:**
- Consumes: `Identity` from `src/types.ts` (`{ userId, orgId, plan, role, label }`).
- Produces:
  ```ts
  export interface StoredTokens { access_token: string; refresh_token?: string; expires_at?: number }
  export interface ServerCredential { client?: { client_id: string }; tokens?: StoredTokens; identity?: Identity }
  export interface CredentialFile { version: 1; servers: Record<string, ServerCredential> }
  export function credentialsDir(): string
  export function readServer(dir: string, serverUrl: string): ServerCredential
  export function writeServer(dir: string, serverUrl: string, cred: ServerCredential): void
  export function decodeIdentity(accessToken: string): Identity | undefined
  export function tokensUsable(tokens: StoredTokens | undefined, now?: number): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/credentials.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsDir, decodeIdentity, readServer, tokensUsable, writeServer,
} from "../src/credentials.js";
import type { Identity } from "../src/types.js";

const PROD = "https://mcp.bellman.sh/mcp";
const DEV = "http://127.0.0.1:8787/mcp";

const identity: Identity = {
  userId: "u_jesse", orgId: null, plan: "free", role: "member", label: "jesse@github",
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bellman-cred-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A JWT the way src/oauth/tokens.ts writes one: base64url header.payload.sig */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.not-a-real-signature`;
}

describe("the credential file", () => {
  it("round-trips a credential", () => {
    writeServer(dir, PROD, { client: { client_id: "c1" }, tokens: { access_token: "a1" }, identity });
    expect(readServer(dir, PROD)).toEqual({
      client: { client_id: "c1" }, tokens: { access_token: "a1" }, identity,
    });
  });

  it("writes the file 0600 and the directory 0700", () => {
    const nested = join(dir, "nested");
    writeServer(nested, PROD, { client: { client_id: "c1" } });
    expect(statSync(join(nested, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("keeps two server URLs apart", () => {
    writeServer(dir, PROD, { client: { client_id: "prod" } });
    writeServer(dir, DEV, { client: { client_id: "dev" } });
    expect(readServer(dir, PROD).client?.client_id).toBe("prod");
    expect(readServer(dir, DEV).client?.client_id).toBe("dev");
  });

  it("reads an absent file as an empty credential", () => {
    expect(readServer(dir, PROD)).toEqual({});
  });

  it("reads corrupt JSON as absent rather than throwing", () => {
    writeFileSync(join(dir, "credentials.json"), "{ not json");
    expect(readServer(dir, PROD)).toEqual({});
  });

  // Review Focus 3
  it("reads a wrong-version or malformed file as absent", () => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 2, servers: { [PROD]: { client: { client_id: "x" } } } }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1 }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, servers: "nope" }));
    expect(readServer(dir, PROD)).toEqual({});
  });

  it("overwrites one server without disturbing the other", () => {
    writeServer(dir, PROD, { client: { client_id: "prod" } });
    writeServer(dir, DEV, { client: { client_id: "dev" } });
    writeServer(dir, PROD, { client: { client_id: "prod2" } });
    expect(readServer(dir, PROD).client?.client_id).toBe("prod2");
    expect(readServer(dir, DEV).client?.client_id).toBe("dev");
  });
});

describe("decodeIdentity", () => {
  it("pulls the bellman claim out of an access token", () => {
    expect(decodeIdentity(fakeJwt({ sub: "u_jesse", bellman: identity }))).toEqual(identity);
  });

  it("returns undefined for a token that is not a JWT, or carries no claim", () => {
    expect(decodeIdentity("qk_static_key")).toBeUndefined();
    expect(decodeIdentity("a.b")).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ sub: "u_jesse" }))).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ bellman: "not an object" }))).toBeUndefined();
  });
});

describe("tokensUsable", () => {
  const now = 1_700_000_000_000;

  it("is false without tokens or an access token", () => {
    expect(tokensUsable(undefined, now)).toBe(false);
    expect(tokensUsable({ access_token: "" }, now)).toBe(false);
  });

  // Review Focus 4
  it("treats a credential with no refresh token as usable until it expires", () => {
    expect(tokensUsable({ access_token: "a" }, now)).toBe(true);
    expect(tokensUsable({ access_token: "a", expires_at: now + 600_000 }, now)).toBe(true);
    expect(tokensUsable({ access_token: "a", expires_at: now - 1 }, now)).toBe(false);
  });

  it("treats a token inside the 60s skew as already expired", () => {
    expect(tokensUsable({ access_token: "a", expires_at: now + 30_000 }, now)).toBe(false);
    expect(tokensUsable({ access_token: "a", expires_at: now + 90_000 }, now)).toBe(true);
  });
});

describe("credentialsDir", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  it("honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(credentialsDir()).toBe(join("/xdg", "bellman"));
  });

  it("ignores an empty or relative XDG_CONFIG_HOME and falls back to the home directory", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(credentialsDir().endsWith(join(".config", "bellman"))).toBe(true);
    process.env.XDG_CONFIG_HOME = "relative/path";
    expect(credentialsDir().endsWith(join(".config", "bellman"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/credentials.test.ts`
Expected: FAIL — `Failed to resolve import "../src/credentials.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/credentials.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = readFile(dir);
  file.servers[serverUrl] = cred;
  writeFileSync(join(dir, FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/credentials.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/credentials.ts tests/credentials.test.ts
git commit -m "feat(bridge): the credential file, keyed by server URL

Read, write at 0600, and an unverified display-only decode of the access
token's bellman claim. Anything unreadable or wrongly shaped reads as
absent: failing closed would strand a user behind a file they would have
to find and delete, and a fresh sign-in costs one browser tab."
```

---

## Task 2: The heartbeating lock

**Files:**
- Modify: `src/credentials.ts` (append; do not restructure Task 1's exports)
- Modify: `tests/credentials.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `credentialsDir` from Task 1.
- Produces:
  ```ts
  export interface LockHandle { release(): void }
  export interface LockOptions {
    waitMs?: number; heartbeatMs?: number; staleMs?: number;
    pidAlive?: (pid: number) => boolean;
  }
  export function acquireLock(dir: string, opts?: LockOptions): Promise<LockHandle | undefined>
  export const LOCK_FILE: string   // "credentials.lock"
  ```
  `acquireLock` resolves `undefined` when `waitMs` elapses without the lock.

- [ ] **Step 1: Write the failing tests**

Append to `tests/credentials.test.ts`. Add `acquireLock, LOCK_FILE` to the existing import from `../src/credentials.js`, then:

```ts
describe("the lock", () => {
  const fast = { waitMs: 2_000, heartbeatMs: 20, staleMs: 200 };

  it("is exclusive, and released so the next holder gets it", async () => {
    const first = await acquireLock(dir, fast);
    expect(first).toBeDefined();
    const contended = await acquireLock(dir, { ...fast, waitMs: 150 });
    expect(contended).toBeUndefined();
    first!.release();
    const second = await acquireLock(dir, fast);
    expect(second).toBeDefined();
    second!.release();
  });

  it("hands the lock to a waiter as soon as the holder releases", async () => {
    const first = await acquireLock(dir, fast);
    const waiter = acquireLock(dir, fast);
    setTimeout(() => first!.release(), 100);
    const second = await waiter;
    expect(second).toBeDefined();
    second!.release();
  });

  it("reclaims a lock whose process is gone", async () => {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 999_999, heartbeat_at: Date.now() }));
    const lock = await acquireLock(dir, { ...fast, pidAlive: () => false });
    expect(lock).toBeDefined();
    lock!.release();
  });

  it("reclaims a lock whose heartbeat went stale", async () => {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, heartbeat_at: Date.now() - 10_000 }));
    const lock = await acquireLock(dir, { ...fast, staleMs: 200, pidAlive: () => true });
    expect(lock).toBeDefined();
    lock!.release();
  });

  it("reclaims a lock whose contents are unreadable", async () => {
    writeFileSync(join(dir, LOCK_FILE), "{ not json");
    const lock = await acquireLock(dir, fast);
    expect(lock).toBeDefined();
    lock!.release();
  });

  /**
   * The regression test for the bug this design started with: a fixed age
   * threshold evicts a live holder mid-sign-in, which produces exactly the
   * second browser tab the lock exists to prevent.
   */
  it("does not reclaim a live holder, however long it holds", async () => {
    const holder = await acquireLock(dir, { waitMs: 2_000, heartbeatMs: 20, staleMs: 100 });
    expect(holder).toBeDefined();
    await new Promise((r) => setTimeout(r, 400)); // 4x staleMs
    const thief = await acquireLock(dir, { waitMs: 150, heartbeatMs: 20, staleMs: 100 });
    expect(thief).toBeUndefined();
    holder!.release();
  });

  it("stops heartbeating once released, so nothing is left running", async () => {
    const lock = await acquireLock(dir, fast);
    lock!.release();
    lock!.release(); // releasing twice is not an error
    const next = await acquireLock(dir, fast);
    expect(next).toBeDefined();
    next!.release();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/credentials.test.ts -t "the lock"`
Expected: FAIL — `acquireLock` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/credentials.ts`, and extend the `node:fs` import at the top to
`import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";`:

```ts
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
    } catch {
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
  let body: LockBody;
  try {
    body = JSON.parse(readFileSync(path, "utf8")) as LockBody;
  } catch {
    // Unreadable, empty, or half-written: a corpse, not a holder.
    return true;
  }
  if (typeof body.pid !== "number" || typeof body.heartbeat_at !== "number") return true;
  if (!pidAlive(body.pid)) return true;
  return Date.now() - body.heartbeat_at > staleMs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/credentials.test.ts`
Expected: PASS, every `describe` in the file.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/credentials.ts tests/credentials.test.ts
git commit -m "feat(bridge): a heartbeating lock over the credential directory

The holder rewrites heartbeat_at every 15s, including while it waits on a
human, and the lock is stale only after 60s without one. A fixed age
threshold cannot work here: short enough to reclaim a crashed process is
short enough to evict a live one mid-sign-in, which produces exactly the
second browser tab the lock exists to prevent. There is a test."
```

---

## Task 3: The loopback listener and the browser

**Files:**
- Create: `src/signin.ts`
- Create: `tests/signin.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 yet.
- Produces:
  ```ts
  export const CALLBACK_PORTS: number[]          // [51004, 51005, 51006, 51007, 51008]
  export function loopbackRedirects(ports?: number[]): string[]
  export interface Listener {
    redirectUri: string;
    waitForCode(state: string, timeoutMs: number): Promise<string>;
    close(): void;
  }
  export function listenForCallback(ports?: number[]): Promise<Listener | undefined>
  export function openBrowser(url: URL, log: (m: string) => void): void
  ```
  `listenForCallback` resolves `undefined` when every port is busy.

- [ ] **Step 1: Write the failing tests**

Create `tests/signin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  CALLBACK_PORTS, listenForCallback, loopbackRedirects, type Listener,
} from "../src/signin.js";

/** Ports well away from the real range, so a developer's live bridge is untouched. */
const TEST_PORTS = [53411, 53412, 53413];

const open: { close(): void }[] = [];
afterEach(() => { for (const item of open.splice(0)) item.close(); });
function track<T extends { close(): void }>(x: T): T { open.push(x); return x; }

async function block(port: number): Promise<void> {
  const blocker = track(createServer());
  await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
}

describe("loopbackRedirects", () => {
  it("is the fixed range the client registers, in ascending order", () => {
    expect(CALLBACK_PORTS).toEqual([51004, 51005, 51006, 51007, 51008]);
    expect(loopbackRedirects()).toEqual([
      "http://127.0.0.1:51004/callback",
      "http://127.0.0.1:51005/callback",
      "http://127.0.0.1:51006/callback",
      "http://127.0.0.1:51007/callback",
      "http://127.0.0.1:51008/callback",
    ]);
  });
});

describe("the loopback listener", () => {
  it("binds the first free port in ascending order", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[0]}/callback`);
  });

  it("skips a busy port and takes the next", async () => {
    await block(TEST_PORTS[0]);
    const listener = track((await listenForCallback(TEST_PORTS))!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[1]}/callback`);
  });

  it("gives up when every port is busy", async () => {
    for (const port of TEST_PORTS) await block(port);
    expect(await listenForCallback(TEST_PORTS)).toBeUndefined();
  });

  it("captures the code from a matching callback", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const res = await fetch(`${listener.redirectUri}?code=the-code&state=state-abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("close this tab");
    await expect(waiting).resolves.toBe("the-code");
  });

  // Review Focus 1 — the SDK does not check state for us.
  it("rejects a callback whose state does not match", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 400);
    const res = await fetch(`${listener.redirectUri}?code=forged&state=state-xyz`);
    expect(res.status).toBe(400);
    // The forged call must NOT complete the wait — it times out instead.
    await expect(waiting).rejects.toThrow(/timed out/i);
  });

  // Review Focus 2 — the human clicked Cancel.
  it("fails fast when the callback carries an error instead of a code", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 60_000);
    await fetch(`${listener.redirectUri}?error=access_denied&state=state-abc`);
    await expect(waiting).rejects.toThrow(/access_denied/);
  });

  it("times out rather than waiting forever", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    await expect(listener.waitForCode("state-abc", 200)).rejects.toThrow(/timed out/i);
  });

  it("ignores a request to another path", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 400);
    const res = await fetch(`http://127.0.0.1:${TEST_PORTS[0]}/favicon.ico`);
    expect(res.status).toBe(404);
    await expect(waiting).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/signin.test.ts`
Expected: FAIL — `Failed to resolve import "../src/signin.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/signin.ts`:

```ts
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The browser half of self-serve credentials: a loopback listener for the
 * authorization callback, and the platform incantation for opening a browser.
 */

/**
 * A FIXED range, not an ephemeral port. Bellman's /authorize requires an exact
 * match against a registered redirect_uri, so a port that changed between runs
 * would break every re-authentication. Five is enough: concurrent bridges
 * serialize on the credential lock, so a busy port means some other
 * application, not another bridge.
 */
export const CALLBACK_PORTS = [51004, 51005, 51006, 51007, 51008];

export function loopbackRedirects(ports: number[] = CALLBACK_PORTS): string[] {
  return ports.map((port) => `http://127.0.0.1:${port}/callback`);
}

export interface Listener {
  redirectUri: string;
  waitForCode(state: string, timeoutMs: number): Promise<string>;
  close(): void;
}

function bind(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    const fail = () => { server.removeAllListeners(); server.close(); resolve(undefined); };
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", fail);
      resolve(server);
    });
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Bellman</title>` +
  `<body style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.25rem">` +
  `<h1 style="font-size:1.35rem">${title}</h1><p>${body}</p>`;

/** Bind the first free port, ascending. Undefined when every one is taken. */
export async function listenForCallback(ports: number[] = CALLBACK_PORTS): Promise<Listener | undefined> {
  for (const port of ports) {
    const server = await bind(port);
    if (server) return makeListener(server, `http://127.0.0.1:${port}/callback`);
  }
  return undefined;
}

function makeListener(server: Server, redirectUri: string): Listener {
  const path = new URL(redirectUri).pathname;
  return {
    redirectUri,
    waitForCode(state, timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.removeListener("request", onRequest);
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the sign-in to finish`));
        }, timeoutMs);

        const settle = (fn: () => void) => {
          clearTimeout(timer);
          server.removeListener("request", onRequest);
          fn();
        };

        function onRequest(req: IncomingMessage, res: ServerResponse): void {
          const url = new URL(req.url ?? "/", redirectUri);
          const html = (status: number, title: string, body: string) =>
            res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, body));

          if (url.pathname !== path) {
            res.writeHead(404).end();
            return;
          }

          /**
           * The SDK generates an OAuth state only because we implement state(),
           * and finishAuth() takes only the code — so checking it is OUR job.
           * Without this, any page open in the user's browser could drive a
           * code of its own choosing into this listener.
           */
          if (url.searchParams.get("state") !== state) {
            html(400, "That sign-in did not come from here", "Start it again from your terminal.");
            return; // deliberately does NOT settle the promise
          }

          const error = url.searchParams.get("error");
          if (error) {
            const description = url.searchParams.get("error_description");
            const message = description ? `${error}: ${description}` : error;
            html(400, "Sign-in was refused", message);
            settle(() => reject(new Error(message)));
            return;
          }

          const code = url.searchParams.get("code");
          if (!code) {
            html(400, "Sign-in did not complete", "No authorization code came back. Start it again.");
            return;
          }
          html(200, "Signed in to Bellman", "You can close this tab and go back to your terminal.");
          settle(() => resolve(code));
        }

        server.on("request", onRequest);
      });
    },
    close() { server.close(); },
  };
}

/**
 * Open the platform browser, detached, with its output discarded — a child
 * writing to our stdout would corrupt the MCP transport.
 */
export function openBrowser(url: URL, log: (message: string) => void): void {
  const target = url.toString();
  const [command, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [target]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
    log(`opened a browser to sign in: ${target}`);
  } catch {
    log(`could not open a browser. Sign in here: ${target}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/signin.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/signin.ts tests/signin.test.ts
git commit -m "feat(bridge): loopback callback listener on a fixed port range

/authorize matches redirect_uris exactly, so an ephemeral port would
break re-authentication; the client registers 51004-51008 once and binds
the first free one.

The listener checks the OAuth state itself. The SDK generates one only
because we implement state(), and finishAuth() takes only the code, so
without this check any page in the user's browser could drive a code of
its choosing into the listener."
```

---

## Task 4: Signing in

**Files:**
- Create: `tests/helpers/fake-bellman.ts`
- Modify: `src/signin.ts` (append)
- Modify: `tests/signin.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `readServer`, `writeServer`, `decodeIdentity`, `tokensUsable`, `acquireLock`, `credentialsDir`, `LockOptions`, `ServerCredential` (Tasks 1–2); `listenForCallback`, `loopbackRedirects`, `openBrowser`, `Listener`, `CALLBACK_PORTS` (Task 3); `Remote` from `src/bridge.ts`.
- Produces:
  ```ts
  export interface SignInOptions {
    serverUrl: string;
    configDir?: string;
    fetchImpl?: typeof fetch;
    browser?: (url: URL) => void | Promise<void>;
    log?: (message: string) => void;
    ports?: number[];
    callbackTimeoutMs?: number;
    lock?: LockOptions;
  }
  export function connectSignedIn(opts: SignInOptions): Promise<Remote>
  ```

- [ ] **Step 1: Write the test helper**

Create `tests/helpers/fake-bellman.ts`:

```ts
import {
  handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig,
} from "../../src/oauth/routes.js";
import { MemoryAuthStore } from "../../src/oauth/storage.js";
import type { Identity } from "../../src/types.js";

/**
 * A `fetch` that is the real Bellman: the real handleOAuth for every OAuth
 * path, and a minimal JSON-RPC /mcp that demands a token minted for itself.
 * Nothing about the protocol is mocked — only the upstream identity provider
 * and the network are.
 */

export const ISSUER = "https://mcp.example.test";
export const RESOURCE = "https://mcp.example.test/mcp";

const upstream = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: null });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

export interface FakeBellman {
  fetch: typeof fetch;
  config: OAuthConfig;
  /** Every /register body the client sent — length is the registration count. */
  registrations: unknown[];
  /** Drives the browser half: authorize page -> provider -> loopback. */
  browser(authorizeUrl: URL): Promise<void>;
}

export interface FakeBellmanOptions {
  overrides?: Record<string, Identity>;
  /**
   * The server's own origin. A second fake needs a DIFFERENT one rather than a
   * URL rewrite: tokens carry an RFC 8707 resource indicator derived from the
   * server URL, and /authorize refuses any resource that is not its own
   * (`invalid_target`). Two servers means two origins, all the way down.
   */
  origin?: string;
}

export function fakeBellman({ overrides = {}, origin = ISSUER }: FakeBellmanOptions = {}): FakeBellman {
  const config: OAuthConfig = {
    issuer: origin,
    resource: `${origin}/mcp`,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides,
    fetchImpl: upstream,
  };
  const registrations: unknown[] = [];

  const serve: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      registrations.push(await request.clone().json());
    }

    if (url.pathname !== "/mcp") {
      const handled = await handleOAuth(request, config);
      return handled ?? new Response("not found", { status: 404 });
    }

    // ------------------------------------------------------------- /mcp
    if (request.method === "GET") return new Response("no sse", { status: 405 });

    const header = request.headers.get("authorization") ?? "";
    const identity = header.toLowerCase().startsWith("bearer ")
      ? await identityFromAccessToken(header.slice(7).trim(), config)
      : null;
    if (!identity) {
      return new Response("unauthorized", { status: 401, headers: unauthorizedHeaders(config) });
    }

    const body = (await request.json()) as { method?: string; id?: unknown };
    if (body.id === undefined) return new Response(null, { status: 202 }); // a notification

    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "bellman", version: "0.1.0" },
          }
        : body.method === "tools/list"
          ? { tools: [{ name: "bellman_start", description: "start", inputSchema: { type: "object" } }] }
          : {};

    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "content-type": "application/json" } }
    );
  };

  return {
    fetch: serve,
    config,
    registrations,
    /**
     * What a human's browser does: load /authorize, pick GitHub, let the
     * provider come back, and follow the final redirect to the loopback — that
     * last hop with the REAL fetch, because the listener is a real server.
     */
    async browser(authorizeUrl: URL): Promise<void> {
      const page = await (await serve(authorizeUrl)).text();
      const req = /\/authorize\/github\?req=([^"]+)/.exec(page)?.[1];
      if (!req) throw new Error(`no provider link on the authorize page: ${page.slice(0, 200)}`);
      const back = await serve(`${origin}/callback/github?code=gh_code&state=${req}`, { redirect: "manual" });
      const location = back.headers.get("location");
      if (!location) throw new Error(`callback did not redirect: ${back.status}`);
      await fetch(location); // the loopback listener is a real local server
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/signin.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSignedIn } from "../src/signin.js";
import { readServer, writeServer } from "../src/credentials.js";
import { fakeBellman, RESOURCE, type FakeBellman } from "./helpers/fake-bellman.js";

describe("connectSignedIn", () => {
  let dir: string;
  const fastLock = { waitMs: 5_000, heartbeatMs: 20, staleMs: 1_000 };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bellman-signin-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function connect(bellman: FakeBellman, browserCalls: URL[]) {
    return connectSignedIn({
      serverUrl: RESOURCE,
      configDir: dir,
      fetchImpl: bellman.fetch,
      ports: TEST_PORTS,
      lock: fastLock,
      callbackTimeoutMs: 5_000,
      browser: async (url) => { browserCalls.push(url); await bellman.browser(url); },
    });
  }

  it("registers, signs in, and caches tokens and identity", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    const remote = await connect(bellman, calls);

    expect(calls).toHaveLength(1);
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();

    const cred = readServer(dir, RESOURCE);
    expect(cred.client?.client_id).toBeTruthy();
    expect(cred.tokens?.access_token).toBeTruthy();
    expect(cred.tokens?.refresh_token).toBeTruthy();
    expect(cred.tokens?.expires_at).toBeGreaterThan(Date.now());
    expect(cred.identity?.label).toBe("jesse@example.dev");
  });

  it("registers exactly one client and reuses it on the next run", async () => {
    const bellman = fakeBellman();
    // Drops only the tokens below; the client_id must survive and be reused.
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(bellman.registrations).toHaveLength(1);

    // Drop only the tokens; the client_id must survive and be reused.
    const cred = readServer(dir, RESOURCE);
    writeServer(dir, RESOURCE, { client: cred.client });
    await (await connect(bellman, calls)).close();
    expect(bellman.registrations).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("registers the whole loopback range so any port can be used later", async () => {
    const bellman = fakeBellman();
    await (await connect(bellman, [])).close();
    const body = bellman.registrations[0] as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual(TEST_PORTS.map((p) => `http://127.0.0.1:${p}/callback`));
  });

  it("reuses a cached token without opening a browser", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1);
    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1); // still one
  });

  it("refreshes an expired access token without opening a browser", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    const before = cred.tokens!.access_token;
    writeServer(dir, RESOURCE, { ...cred, tokens: { ...cred.tokens!, expires_at: Date.now() - 1 } });

    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1); // no second browser
    expect(readServer(dir, RESOURCE).tokens?.access_token).not.toBe(before);
  });

  it("re-runs the browser flow when the refresh token is rejected", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    // A refresh token rotated away by another process, or revoked.
    writeServer(dir, RESOURCE, {
      ...cred,
      tokens: { access_token: cred.tokens!.access_token, refresh_token: "dead", expires_at: Date.now() - 1 },
    });

    const remote = await connect(bellman, calls);
    expect(calls).toHaveLength(2); // invalid_grant became a browser tab, not an error
    await remote.close();
    expect(readServer(dir, RESOURCE).tokens?.refresh_token).not.toBe("dead");
  });

  it("gives up cleanly when every loopback port is busy and there is no token", async () => {
    for (const port of TEST_PORTS) await block(port);
    await expect(connect(fakeBellman(), [])).rejects.toThrow(/loopback port/i);
  });

  it("uses the cached token when every loopback port is busy", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();

    // A busy port must not block someone who already has a working token.
    for (const port of TEST_PORTS) await block(port);
    const remote = await connect(bellman, calls);
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    expect(calls).toHaveLength(1); // no browser, no listener
    await remote.close();
  });

  it("surfaces an unreachable server rather than hanging", async () => {
    const dead: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(
      connectSignedIn({
        serverUrl: RESOURCE,
        configDir: dir,
        fetchImpl: dead,
        ports: TEST_PORTS,
        lock: fastLock,
        callbackTimeoutMs: 1_000,
        browser: () => { throw new Error("should never reach a browser"); },
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/signin.test.ts -t "connectSignedIn"`
Expected: FAIL — `connectSignedIn` is not exported from `../src/signin.js`.

- [ ] **Step 4: Write the implementation**

Append to `src/signin.ts`:

```ts
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Remote } from "./bridge.js";
import {
  acquireLock, credentialsDir, decodeIdentity, readServer, tokensUsable, writeServer,
  type LockOptions, type ServerCredential,
} from "./credentials.js";

const VERSION = "0.1.0";
const CALLBACK_TIMEOUT_MS = 300_000;

export interface SignInOptions {
  serverUrl: string;
  configDir?: string;
  fetchImpl?: typeof fetch;
  browser?: (url: URL) => void | Promise<void>;
  log?: (message: string) => void;
  ports?: number[];
  callbackTimeoutMs?: number;
  lock?: LockOptions;
}

/**
 * The bridge's own credential, held in memory for the life of one connect and
 * written back under the lock. The SDK calls these methods at points we do not
 * choose, which is why the lock wraps the whole connect rather than each write.
 */
class BridgeAuth implements OAuthClientProvider {
  cred: ServerCredential;
  private verifier = "";
  private readonly stateValue = randomBytes(32).toString("base64url");

  constructor(
    cred: ServerCredential,
    readonly redirectUrl: string,
    private readonly redirects: string[],
    private readonly onRedirect: (url: URL) => void
  ) { this.cred = cred; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bellman bridge for Claude Code",
      redirect_uris: this.redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "bellman",
    };
  }

  /**
   * The SDK only sends an OAuth state because this exists, and finishAuth()
   * takes only the code — the listener compares this value itself.
   */
  state(): string { return this.stateValue; }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.cred.client ? ({ ...this.cred.client } as OAuthClientInformationFull) : undefined;
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.cred = { ...this.cred, client: { client_id: info.client_id } };
  }

  tokens(): OAuthTokens | undefined {
    const t = this.cred.tokens;
    return t ? { access_token: t.access_token, refresh_token: t.refresh_token, token_type: "Bearer" } : undefined;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.cred = {
      ...this.cred,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      },
      identity: decodeIdentity(tokens.access_token) ?? this.cred.identity,
    };
  }

  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
  redirectToAuthorization(url: URL): void { this.onRedirect(url); }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") { this.cred = {}; return; }
    if (scope === "tokens") this.cred = { ...this.cred, tokens: undefined };
    if (scope === "client") this.cred = { ...this.cred, client: undefined };
  }
}

/** True for the one OAuth error the SDK re-throws instead of recovering from. */
function isInvalidGrant(err: unknown): boolean {
  return /invalid_grant/i.test(err instanceof Error ? err.message : String(err));
}

function remoteFrom(client: Client): Remote {
  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params) as Promise<CallToolResult>,
    close: () => client.close(),
  };
}

/** The degraded path: a cached token, no listener, no auth provider. */
async function connectWithHeader(url: string, token: string, fetchImpl?: typeof fetch): Promise<Remote> {
  const client = new Client({ name: "bellman-bridge", version: VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: fetchImpl,
    })
  );
  return remoteFrom(client);
}

/**
 * Connect to Bellman as a signed-in user, running the browser flow if there is
 * no usable credential. Returns the same Remote shape connectRemote does.
 */
export async function connectSignedIn(opts: SignInOptions): Promise<Remote> {
  const dir = opts.configDir ?? credentialsDir();
  const log = opts.log ?? (() => {});
  const ports = opts.ports ?? CALLBACK_PORTS;
  const timeout = opts.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
  const openIt = opts.browser ?? ((url: URL) => openBrowser(url, log));

  const lock = await acquireLock(dir, opts.lock ?? {});
  // No lock means someone else held it for the whole wait. Their sign-in may be
  // all we needed, so re-read before giving up.
  if (!lock) {
    const cached = readServer(dir, opts.serverUrl);
    if (tokensUsable(cached.tokens)) {
      return await connectWithHeader(opts.serverUrl, cached.tokens!.access_token, opts.fetchImpl);
    }
    throw new Error(
      `another Bellman sign-in is holding ${dir}/credentials.lock. If nothing is signing in, delete that file.`
    );
  }

  try {
    const cred = readServer(dir, opts.serverUrl);
    const listener = await listenForCallback(ports);

    // Every port busy is survivable if the cached token still works.
    if (!listener) {
      if (!tokensUsable(cred.tokens)) {
        throw new Error(
          `no free loopback port in ${ports[0]}-${ports[ports.length - 1]} to receive the sign-in`
        );
      }
      log("every loopback port is busy; using the cached token without signing in");
      return await connectWithHeader(opts.serverUrl, cred.tokens!.access_token, opts.fetchImpl);
    }

    try {
      return await signIn(opts, dir, cred, listener, openIt, timeout, log);
    } finally {
      listener.close();
    }
  } finally {
    lock.release();
  }
}

async function signIn(
  opts: SignInOptions,
  dir: string,
  cred: ServerCredential,
  listener: Listener,
  openIt: (url: URL) => void | Promise<void>,
  timeout: number,
  log: (message: string) => void
): Promise<Remote> {
  let retried = false;
  let current = cred;

  for (;;) {
    let pending: URL | undefined;
    const provider = new BridgeAuth(
      current,
      listener.redirectUri,
      loopbackRedirects(opts.ports),
      (url) => { pending = url; }
    );
    const client = new Client({ name: "bellman-bridge", version: VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
      authProvider: provider,
      fetch: opts.fetchImpl,
    });

    try {
      try {
        await client.connect(transport);
      } catch (err) {
        if (!(err instanceof UnauthorizedError) || !pending) throw err;
        await openIt(pending);
        const code = await listener.waitForCode(provider.state(), timeout);
        await transport.finishAuth(code);
        await client.connect(transport);
      }
    } catch (err) {
      await transport.close().catch(() => undefined);
      /**
       * The SDK swallows network and server errors on refresh and falls through
       * to a browser flow, but re-throws invalid_grant. A refresh token rotated
       * away by a racing process, revoked, or expired lands here — and the user
       * should see a browser tab, not a hard error.
       */
      if (!retried && isInvalidGrant(err)) {
        retried = true;
        current = { ...current, tokens: undefined };
        writeServer(dir, opts.serverUrl, current);
        log("the saved sign-in was rejected; signing in again");
        continue;
      }
      throw err;
    }

    writeServer(dir, opts.serverUrl, provider.cred);
    const identity = provider.cred.identity;
    log(identity ? `signed in as ${identity.label} (${identity.plan} plan)` : "signed in");
    return remoteFrom(client);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/signin.test.ts`
Expected: PASS, every `describe` in the file.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/signin.ts tests/signin.test.ts tests/helpers/fake-bellman.ts
git commit -m "feat(bridge): connectSignedIn, the OAuth client half

An OAuthClientProvider over the credential file, driven by the MCP SDK,
tested by routing the real SDK client's fetch into the real handleOAuth —
the real client against the real authorization server, in process.

invalid_grant is handled explicitly. The SDK swallows network and server
errors on refresh and falls through to a browser flow, but re-throws
invalid_grant, so a refresh token rotated away by a racing bridge would
otherwise be a hard error where the user should see a browser tab."
```

---

## Task 5: Concurrent bridges open one browser

**Files:**
- Modify: `tests/signin.test.ts` (append a `describe`)

No production code. Tasks 2 and 4 must already satisfy this; the task exists because "one browser tab" is the headline claim of the design and deserves its own gate.

**Interfaces:**
- Consumes: `connectSignedIn` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Append to `tests/signin.test.ts`:

```ts
describe("concurrent bridges", () => {
  let dir: string;
  const fastLock = { waitMs: 8_000, heartbeatMs: 20, staleMs: 2_000 };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bellman-concurrent-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function connect(bellman: FakeBellman, calls: URL[]) {
    return connectSignedIn({
      serverUrl: RESOURCE,
      configDir: dir,
      fetchImpl: bellman.fetch,
      ports: TEST_PORTS,
      lock: fastLock,
      callbackTimeoutMs: 8_000,
      browser: async (url) => { calls.push(url); await bellman.browser(url); },
    });
  }

  it("opens ONE browser for three simultaneous first runs", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    const remotes = await Promise.all([
      connect(bellman, calls), connect(bellman, calls), connect(bellman, calls),
    ]);

    expect(calls).toHaveLength(1);
    expect(bellman.registrations).toHaveLength(1);
    for (const remote of remotes) {
      expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
      await remote.close();
    }
  });

  it("refreshes once when three bridges wake to an expired token", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    writeServer(dir, RESOURCE, { ...cred, tokens: { ...cred.tokens!, expires_at: Date.now() - 1 } });

    const remotes = await Promise.all([
      connect(bellman, calls), connect(bellman, calls), connect(bellman, calls),
    ]);
    // No second browser, and the losers used the winner's token rather than
    // spending the rotated refresh token a second time.
    expect(calls).toHaveLength(1);
    for (const remote of remotes) await remote.close();
  });

  // Review Focus 5 — one lock, two server keys.
  it("a second server URL waits for the lock, then signs in on its own key", async () => {
    const prod = fakeBellman();
    // A genuinely separate origin, not a URL rewrite: the access token carries
    // a resource indicator derived from the server URL, and /authorize refuses
    // any resource that is not its own.
    const dev = fakeBellman({ origin: "https://dev.example.test" });
    const DEV_URL = "https://dev.example.test/mcp";
    const calls: URL[] = [];

    const [a, b] = await Promise.all([
      connect(prod, calls),
      connectSignedIn({
        serverUrl: DEV_URL,
        configDir: dir,
        fetchImpl: dev.fetch,
        ports: TEST_PORTS,
        lock: fastLock,
        callbackTimeoutMs: 8_000,
        browser: async (url) => { calls.push(url); await dev.browser(url); },
      }),
    ]);

    // Two servers means two sign-ins — the lock serializes them, it does not
    // let the second mistake the first's tokens for its own.
    expect(calls).toHaveLength(2);
    const prodToken = readServer(dir, RESOURCE).tokens?.access_token;
    const devToken = readServer(dir, DEV_URL).tokens?.access_token;
    expect(prodToken).toBeTruthy();
    expect(devToken).toBeTruthy();
    expect(devToken).not.toBe(prodToken);
    await a.close();
    await b.close();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/signin.test.ts -t "concurrent bridges"`
Expected: PASS if Tasks 2 and 4 are correct. If the first test reports 2 or 3 browser calls, the lock is not wrapping the whole connect — fix `connectSignedIn`, not the test.

- [ ] **Step 3: Verify and commit**

```bash
npm run verify
git add tests/signin.test.ts
git commit -m "test(bridge): three simultaneous bridges open one browser

The headline claim of the design, pinned: one tab, one registration, one
refresh, and a second server URL that waits for the lock and then signs
in on its own key rather than adopting the first's tokens."
```

---

## Task 6: `bellman_whoami`

**Files:**
- Modify: `src/bridge.ts`
- Modify: `tests/bridge.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // src/bridge.ts
  export type WhoAmI =
    | { source: "oauth"; label: string; plan: string; role: string; org_id: string | null }
    | { source: "env"; label: null };
  // BridgeOptions gains:  whoami?: () => WhoAmI
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/bridge.test.ts`, at the end of the file:

```ts
describe("bellman_whoami", () => {
  async function bridgeWith(whoami?: () => WhoAmI) {
    const bridge = createBridge({
      delivery: "channel",
      remote: () => remoteFor(store, DEV_KEY.jesse),
      whoami,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "0.0.1" });
    await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
    return { bridge, client };
  }

  it("reports the signed-in identity", async () => {
    const { bridge, client } = await bridgeWith(() => ({
      source: "oauth", label: "jesse@github", plan: "free", role: "member", org_id: null,
    }));

    expect((await client.listTools()).tools.map((t) => t.name)).toContain("bellman_whoami");
    const result = (await client.callTool({ name: "bellman_whoami" })) as CallToolResult;
    expect(result.structuredContent).toEqual({
      source: "oauth", label: "jesse@github", plan: "free", role: "member", org_id: null,
    });
    await client.close();
    await bridge.close();
  });

  it("says so honestly when a static key is in play", async () => {
    const { bridge, client } = await bridgeWith();
    const result = (await client.callTool({ name: "bellman_whoami" })) as CallToolResult;
    expect(result.structuredContent).toEqual({ source: "env", label: null });
    expect(result.content?.[0]).toMatchObject({ type: "text" });
    await client.close();
    await bridge.close();
  });

  it("is offered under hook delivery too, alongside bellman_wait", async () => {
    const session = await open(DEV_KEY.jesse, "hook");
    const tools = (await session.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("bellman_whoami");
    expect(tools).toContain("bellman_wait");
  });
});
```

Add `type WhoAmI` to the existing `createBridge` import from `../src/bridge.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts -t "bellman_whoami"`
Expected: FAIL — `WhoAmI` is not exported and `whoami` is not a known `BridgeOptions` property.

- [ ] **Step 3: Write the implementation**

In `src/bridge.ts`, add after the existing `WAIT_TOOL` declaration:

```ts
export type WhoAmI =
  | { source: "oauth"; label: string; plan: string; role: string; org_id: string | null }
  | { source: "env"; label: null };

const WHOAMI_TOOL: Tool = {
  name: "bellman_whoami",
  title: "Who this bridge is signed in as",
  description: `The identity peers see when you join a Bellman room. Answered locally from the cached sign-in, with no round trip.

Returns: { source, label, plan, role, org_id }. source is "oauth" when this bridge signed in, or "env" when it was handed a BELLMAN_KEY — in which case the bridge cannot know the identity behind the key and label is null.`,
  inputSchema: { type: "object", properties: {} },
  annotations: {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  },
};
```

In `BridgeOptions`, add:

```ts
  /** Who this bridge signed in as. Absent means a static BELLMAN_KEY. */
  whoami?: () => WhoAmI;
```

In `createBridge`, after `const pollWait = opts.pollWaitSeconds ?? MAX_WAIT_SECONDS;`:

```ts
  const whoami = opts.whoami ?? ((): WhoAmI => ({ source: "env", label: null }));
```

Replace the `ListToolsRequestSchema` handler body with:

```ts
    const { tools } = await (await remote()).listTools();
    const local = delivery === "hook" ? [WAIT_TOOL, WHOAMI_TOOL] : [WHOAMI_TOOL];
    return { tools: [...tools, ...local] };
```

In the `CallToolRequestSchema` handler, add immediately before the `WAIT_TOOL` line:

```ts
    if (name === WHOAMI_TOOL.name) return describeSelf();
```

And add this function beside `waitForQueued`:

```ts
  /**
   * Answered from the cached sign-in, not the server: a room shows your label
   * to peers, and "which account am I in this room as" should be answerable
   * before the first call — which is exactly when a wrong-account sign-in bites.
   */
  function describeSelf(): CallToolResult {
    const who = whoami();
    const text =
      who.source === "oauth"
        ? `Signed in as ${who.label} — ${who.plan} plan, role ${who.role}, org ${who.org_id ?? "none"}.`
        : "Using a BELLMAN_KEY from the environment. This bridge cannot tell whose key it is; the server resolves it on every call.";
    return { content: [{ type: "text", text }], structuredContent: { ...who } };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS — the new block and every pre-existing bridge test.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/bridge.ts tests/bridge.test.ts
git commit -m "feat(bridge): bellman_whoami

A room shows your label to peers, so which account you signed in as is
load-bearing and should be answerable before the first call. Answered
from the cached claim with no round trip. Under BELLMAN_KEY it returns
source env and a null label, because the bridge genuinely cannot know
whose key it holds and saying so beats guessing."
```

---

## Task 7: Wire it up, and the docs

**Files:**
- Modify: `src/channel.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `connectSignedIn` (Task 4); `credentialsDir`, `readServer` (Task 1); `WhoAmI` (Task 6); `connectRemote`, `createBridge` (existing).
- Produces: nothing; this is the entry point.

- [ ] **Step 1: Update the header comment in `src/channel.ts`**

Replace the `Environment:` block with:

```
 * Environment:
 *   BELLMAN_KEY       optional. A static bearer key. Set it and the bridge uses
 *                     it unchanged — CI, the smoke script, a headless box.
 *                     Leave it unset and the bridge signs you in on first use,
 *                     caching the result under ~/.config/bellman/.
 *   BELLMAN_URL       optional. Defaults to https://mcp.bellman.sh/mcp
 *   BELLMAN_NO_BROWSER  optional. Print the sign-in URL instead of opening a
 *                     browser. For SSH and headless machines.
 *   XDG_CONFIG_HOME   optional. Where the credential is cached.
 *   BELLMAN_DELIVERY  "channel" (default): push peer events into the session.
 *                     Launch with --dangerously-load-development-channels server:<name>.
 *                     "hook": queue them for the Bellman Stop hook and bellman_wait.
```

- [ ] **Step 2: Update the imports**

```ts
import { connectRemote, createBridge, type Delivery, type WhoAmI } from "./bridge.js";
import { credentialsDir, readServer } from "./credentials.js";
import { connectSignedIn } from "./signin.js";
```

- [ ] **Step 3: Replace the key guard**

Replace:

```ts
const key = process.env.BELLMAN_KEY;
if (!key) {
  console.error("[bellman] BELLMAN_KEY is not set; refusing to start.");
  process.exit(1);
}
const url = process.env.BELLMAN_URL ?? "https://mcp.bellman.sh/mcp";
```

with:

```ts
const key = process.env.BELLMAN_KEY;
const url = process.env.BELLMAN_URL ?? "https://mcp.bellman.sh/mcp";
const log = (message: string) => console.error(`[bellman] ${message}`);

/**
 * An explicitly set BELLMAN_KEY is a deliberate act and wins over a cached
 * sign-in. Unset, the bridge signs in on the first tool call: it has no TTY and
 * stdout is the MCP transport, so there is nowhere to prompt and nothing to run
 * first.
 */
const connect = key
  ? () => connectRemote(url, key)
  : () =>
      connectSignedIn({
        serverUrl: url,
        log,
        browser: process.env.BELLMAN_NO_BROWSER
          ? (target: URL) => log(`sign in here: ${target.toString()}`)
          : undefined,
      });

function whoami(): WhoAmI {
  if (key) return { source: "env", label: null };
  const identity = readServer(credentialsDir(), url).identity;
  if (!identity) return { source: "env", label: null };
  return {
    source: "oauth",
    label: identity.label,
    plan: identity.plan,
    role: identity.role,
    org_id: identity.orgId,
  };
}
```

- [ ] **Step 4: Update the `createBridge` call and the ready line**

```ts
const bridge = createBridge({
  delivery,
  inboxDir,
  remote: connect,
  whoami,
  log,
});
```

and:

```ts
await bridge.server.connect(new StdioServerTransport());
console.error(
  `[bellman] ready: ${delivery} delivery via ${url}` +
    (key ? " (BELLMAN_KEY)" : " (sign-in on first use)")
);
```

- [ ] **Step 5: Verify the build and the whole suite**

Run: `npm run verify`
Expected: PASS. If `tsc` says `WhoAmI` is not exported from `./bridge.js`, Task 6 Step 3 was not applied.

- [ ] **Step 6: Check the bridge starts with no key at all**

Run:

```bash
node -e '
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.BELLMAN_KEY;
  const p = spawn("node", ["dist/channel.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  setTimeout(() => {
    p.kill();
    console.log(err.trim());
    process.exit(err.includes("sign-in on first use") ? 0 : 1);
  }, 1500);
'
```

Expected: prints `[bellman] ready: channel delivery via https://mcp.bellman.sh/mcp (sign-in on first use)` and exits 0. Before this change it exited 1 with "BELLMAN_KEY is not set; refusing to start." No browser opens — sign-in is lazy and no tool was called.

- [ ] **Step 7: Update the README**

Replace the two `claude mcp add` lines:

```
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -- bellman-channel
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -e BELLMAN_DELIVERY=hook -- bellman-channel
```

with:

```
claude mcp add --scope user bellman -- bellman-channel
claude mcp add --scope user bellman -e BELLMAN_DELIVERY=hook -- bellman-channel
```

and add this immediately after the first one:

```markdown
No key. The first time your agent calls a `bellman_*` tool, the bridge registers
itself, opens a browser to sign in, and caches the result under
`~/.config/bellman/` at mode 600. Every run after that is silent. Ask the agent
for `bellman_whoami` to see which account a room will show peers.

On a headless machine, set `BELLMAN_NO_BROWSER=1` and the bridge prints the
sign-in URL instead of opening anything. For CI and `npm run smoke`, set
`BELLMAN_KEY=<key>` — an explicitly set key still wins and skips sign-in
entirely.
```

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/channel.ts README.md
git commit -m "feat(bridge): sign in when BELLMAN_KEY is unset

The bridge no longer refuses to start without a key. Unset, it signs in
on the first tool call and caches under ~/.config/bellman/; set, nothing
changes, which keeps CI, the smoke script and headless boxes on the
documented non-interactive path.

Closes #36."
```

---

## Manual verification against the real server

Not a task — do this once after Task 7, before opening the PR.

1. `npm run build`
2. Back up and remove any existing credential: `mv ~/.config/bellman ~/.config/bellman.bak 2>/dev/null || true`
3. `claude mcp remove bellman 2>/dev/null; claude mcp add --scope user bellman -- node "$PWD/dist/channel.js"`
4. `bellman-claude`, then ask the agent to call `bellman_whoami`.
5. Expect: a browser opens once, you pick a provider, the tab says you can close it, and the agent reports your label and plan.
6. Launch `bellman-claude` again in a second terminal *while the first is still open*: no second browser, and `bellman_whoami` agrees in both.
7. `ls -l ~/.config/bellman/` — `credentials.json` is `-rw-------`.
8. Restore your backup if you made one.
