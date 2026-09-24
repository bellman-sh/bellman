import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  acquireLock, credentialsDir, decodeIdentity, LOCK_FILE, readServer, tokensUsable, writeServer,
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
function fakeJwt(payload: unknown): string {
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

  it("tightens the mode of a credential file that already exists", () => {
    // mkdirSync and writeFileSync apply `mode` only when they create the path, so
    // a directory and file that were already there (restored from a backup, or
    // synced by a dotfile tool) keep the mode they arrived with unless
    // writeServer enforces it.
    const file = join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ version: 1, servers: {} }));
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    // Guard against a vacuous pass: the loose modes must really be in place.
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    writeServer(dir, PROD, { client: { client_id: "c1" } });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("sets exact modes whatever the umask", () => {
    // A umask that strips the owner's own bits would leave the directory 0500 and
    // the file 0400 if the `mode` options were all there was.
    const nested = join(dir, "nested");
    const before = process.umask(0o277);
    try {
      writeServer(nested, PROD, { client: { client_id: "c1" } });
    } finally {
      process.umask(before);
    }
    expect(statSync(join(nested, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  // Neither mode can be opened for writing, and 0000 not for reading either, so
  // writeServer has to chmod before it touches the file, not only after. (As root
  // the modes are ignored and this passes without exercising that.)
  it.each<[string, number]>([["0400", 0o400], ["0000", 0o000]])(
    "recovers a credential file left at mode %s and keeps the other server",
    (_label, mode) => {
      const file = join(dir, "credentials.json");
      writeServer(dir, DEV, { client: { client_id: "dev" } });
      chmodSync(file, mode);

      writeServer(dir, PROD, { client: { client_id: "prod" } });

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readServer(dir, PROD).client?.client_id).toBe("prod");
      expect(readServer(dir, DEV).client?.client_id).toBe("dev");
    }
  );

  it("surfaces a chmod failure and writes nothing into a file it could not secure", async () => {
    const file = join(dir, "credentials.json");
    writeServer(dir, DEV, { client: { client_id: "dev" } });
    const before = readFileSync(file, "utf8");

    // Fail the way a file owned by another user does: chmod is not permitted.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        chmodSync: (path: string, mode: number) => {
          if (path.endsWith("credentials.json")) {
            throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
          }
          real.chmodSync(path, mode);
        },
      };
    });
    try {
      const mocked = await import("../src/credentials.js");
      expect(() => mocked.writeServer(dir, PROD, { client: { client_id: "prod" } })).toThrow(/EPERM/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }

    expect(readFileSync(file, "utf8")).toBe(before);
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

  it("reads a wrong-version or malformed file as absent", () => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 2, servers: { [PROD]: { client: { client_id: "x" } } } }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1 }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, servers: "nope" }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, servers: [] }));
    expect(readServer(dir, PROD)).toEqual({});
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, servers: null }));
    expect(readServer(dir, PROD)).toEqual({});
  });

  it.each<[string, unknown]>([
    ["a string", "junk"],
    ["null", null],
    ["a number", 42],
    ["a boolean", true],
    ["an array", []],
  ])("reads %s where a server's credential should be as absent", (_what, entry) => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, servers: { [PROD]: entry } }));
    expect(readServer(dir, PROD)).toEqual({});
  });

  it("does not resolve inherited object keys as servers", () => {
    writeServer(dir, PROD, { client: { client_id: "c1" } }); // a real, parsed file
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const cred = readServer(dir, key);
      expect(cred, key).toEqual({});
      expect(cred, key).not.toBe(Object.prototype);
    }
  });

  // The recovery the fail-open design rests on: a file that reads as absent has
  // to be writable over, and what was written has to survive a re-read.
  it.each<[string, string]>([
    ["corrupt JSON", "{ not json"],
    ["JSON null", "null"],
    ["a wrong version", JSON.stringify({ version: 2, servers: {} })],
    ["servers as an array", JSON.stringify({ version: 1, servers: [] })],
    ["servers as a string", JSON.stringify({ version: 1, servers: "nope" })],
    ["servers as null", JSON.stringify({ version: 1, servers: null })],
  ])("writes over a file with %s and reads the new credential back", (_shape, body) => {
    writeFileSync(join(dir, "credentials.json"), body);
    const cred = { client: { client_id: "c1" }, tokens: { access_token: "a1" } };
    writeServer(dir, PROD, cred);
    expect(readServer(dir, PROD)).toEqual(cred);
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
    expect(decodeIdentity("a.b.c")).toBeUndefined();
    expect(decodeIdentity(fakeJwt(null))).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ sub: "u_jesse" }))).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ bellman: "not an object" }))).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ bellman: null }))).toBeUndefined();
    expect(decodeIdentity(fakeJwt({ bellman: [identity] }))).toBeUndefined();
  });

  it("wants exactly three dot-separated parts", () => {
    const [header, payload] = fakeJwt({ bellman: identity }).split(".");
    expect(decodeIdentity(`${header}.${payload}`)).toBeUndefined();
    expect(decodeIdentity(`${header}.${payload}.signature.extra`)).toBeUndefined();
  });

  it("never throws on a token that is not a string", () => {
    // It was read back from a file a person may have edited by hand.
    for (const token of [123, null, undefined, {}, ["a", "b", "c"]]) {
      expect(decodeIdentity(token as unknown as string), String(token)).toBeUndefined();
    }
  });
});

describe("tokensUsable", () => {
  const now = 1_700_000_000_000;

  it("is false without tokens or an access token", () => {
    expect(tokensUsable(undefined, now)).toBe(false);
    expect(tokensUsable({ access_token: "" }, now)).toBe(false);
  });

  it("treats a credential with no refresh token as usable until it expires", () => {
    expect(tokensUsable({ access_token: "a" }, now)).toBe(true);
    expect(tokensUsable({ access_token: "a", expires_at: now + 600_000 }, now)).toBe(true);
    expect(tokensUsable({ access_token: "a", expires_at: now - 1 }, now)).toBe(false);
  });

  it("treats a token inside the 60s skew as already expired", () => {
    expect(tokensUsable({ access_token: "a", expires_at: now + 30_000 }, now)).toBe(false);
    expect(tokensUsable({ access_token: "a", expires_at: now + 90_000 }, now)).toBe(true);
  });

  it("treats a token at exactly the 60s skew as expired, and one millisecond past it as usable", () => {
    expect(tokensUsable({ access_token: "a", expires_at: now + 60_000 }, now)).toBe(false);
    expect(tokensUsable({ access_token: "a", expires_at: now + 60_001 }, now)).toBe(true);
  });
});

describe("credentialsDir", () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedHome = process.env.HOME;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(() => {
    restore("XDG_CONFIG_HOME", savedXdg);
    restore("HOME", savedHome);
  });

  it("honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(credentialsDir()).toBe(join("/xdg", "bellman"));
  });

  it("ignores an empty or relative XDG_CONFIG_HOME and falls back to the home directory", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(credentialsDir()).toBe(join(homedir(), ".config", "bellman"));
    process.env.XDG_CONFIG_HOME = "relative/path";
    expect(credentialsDir()).toBe(join(homedir(), ".config", "bellman"));
  });

  it("honours an absolute HOME", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/somewhere/else";
    expect(credentialsDir()).toBe(join("/somewhere/else", ".config", "bellman"));
  });

  // os.homedir() returns $HOME as it finds it, so joining onto an empty or
  // relative one would put the credential wherever the bridge was spawned.
  it.each<[string, string]>([["an empty", ""], ["a relative", "relative/home"]])(
    "does not build a path from %s HOME",
    (_kind, home) => {
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = home;
      expect(credentialsDir()).toBe(join(userInfo().homedir, ".config", "bellman"));
    }
  );

  it("refuses to return a relative path when no absolute home directory can be found", async () => {
    delete process.env.XDG_CONFIG_HOME;
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, homedir: () => "", userInfo: () => ({ ...real.userInfo(), homedir: "" }) };
    });
    try {
      const mocked = await import("../src/credentials.js");
      expect(() => mocked.credentialsDir()).toThrow(/home directory/);
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
});

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

  // Everything below pins something the cases above only imply. Each one was
  // found by deleting the line it covers and watching the cases above still pass.

  it("removes the lock file on release", async () => {
    // "released so the next holder gets it" cannot tell this from a waiter that
    // simply outlasts the stale threshold.
    const lock = await acquireLock(dir, fast);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    lock!.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it("closes its descriptor on release", async () => {
    // open() hands out the lowest free descriptor, so one that release() leaked
    // shows up as the next number along.
    const probe = join(dir, "probe");
    const expected = openSync(probe, "w");
    closeSync(expected);
    const lock = await acquireLock(dir, fast);
    lock!.release();
    const next = openSync(probe, "w");
    closeSync(next);
    expect(next).toBe(expected);
  });

  it("does not hold the event loop open", async () => {
    // The heartbeat timer is unref'd so a held lock cannot stop the bridge
    // exiting. An unref'd timer reports hasRef() === false.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const lock = await acquireLock(dir, fast);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const timer = setIntervalSpy.mock.results[0].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      lock!.release();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("leaves no timer running once released", async () => {
    vi.useFakeTimers(); // so the count is exact: the heartbeat, and nothing else
    try {
      const lock = await acquireLock(dir, fast);
      expect(vi.getTimerCount()).toBe(1);
      lock!.release();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a second release once someone else holds the lock", async () => {
    // A stale handle's release() must not close the descriptor number or remove
    // the file that now belong to the next holder.
    const first = await acquireLock(dir, fast);
    first!.release();
    const second = await acquireLock(dir, fast);
    first!.release();
    const third = await acquireLock(dir, { ...fast, waitMs: 150 });
    expect(third).toBeUndefined();
    second!.release();
  });

  it("writes its pid and a heartbeat that keeps advancing, at mode 0600", async () => {
    // This file is the whole protocol between bridges: what one writes is what the
    // next reads to decide whether it may take over.
    const path = join(dir, LOCK_FILE);
    const read = () => JSON.parse(readFileSync(path, "utf8")) as { pid: number; heartbeat_at: number };
    const lock = await acquireLock(dir, fast);
    const first = read();
    expect(first.pid).toBe(process.pid);
    expect(Math.abs(Date.now() - first.heartbeat_at)).toBeLessThan(1_000); // epoch milliseconds
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await new Promise((r) => setTimeout(r, 100)); // five heartbeat periods
    expect(read().heartbeat_at).toBeGreaterThan(first.heartbeat_at);
    lock!.release();
  });

  it("creates the directory it locks, private to the user", async () => {
    // First run: nothing has written a credential yet, so there is no directory.
    const nested = join(dir, "not", "yet");
    const lock = await acquireLock(nested, fast);
    expect(lock).toBeDefined();
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    lock!.release();
  });

  // Both of these need a staleMs far longer than the test, so that reclaiming is
  // down to the pid check alone rather than a holder that merely outlasted it.
  it("reclaims a holder whose process is gone at once", async () => {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 999_999, heartbeat_at: Date.now() }));
    const lock = await acquireLock(dir, { ...fast, waitMs: 0, staleMs: 60_000, pidAlive: () => false });
    expect(lock).toBeDefined();
    lock!.release();
  });

  it("reclaims the lock of a process that really has exited", async () => {
    // No pidAlive stub: the default check, against a pid that was real a moment ago.
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid, heartbeat_at: Date.now() }));
    const lock = await acquireLock(dir, { ...fast, waitMs: 0, staleMs: 60_000 });
    expect(lock).toBeDefined();
    lock!.release();
  });

  // A body that parses but is not a lock body is as much a corpse as one that does
  // not parse. The heartbeats below never go stale and pidAlive says alive, so only
  // the shape of the body can condemn it.
  const forever = Number.MAX_SAFE_INTEGER;
  it.each<[string, string]>([
    ["JSON null", "null"],
    ["a bare number", "42"],
    ["an array", "[]"],
    ["no pid", JSON.stringify({ heartbeat_at: forever })],
    ["no heartbeat", JSON.stringify({ pid: process.pid })],
    ["a pid that is a string", JSON.stringify({ pid: String(process.pid), heartbeat_at: forever })],
  ])("reclaims a lock holding %s", async (_shape, body) => {
    writeFileSync(join(dir, LOCK_FILE), body);
    const lock = await acquireLock(dir, { ...fast, pidAlive: () => true });
    expect(lock).toBeDefined();
    lock!.release();
  });

  // Creating the lock (open, then write) and every heartbeat (truncate, then write)
  // leave a live holder's file empty for a moment. A waiter that reads it then and
  // calls it a corpse evicts the holder: two bridges, two browser tabs. Under real
  // concurrency this happened in about a quarter of rounds when six bridges started
  // together, and up to 2% at 5ms of spread.
  it("does not reclaim an empty lock file that was written to just now", async () => {
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    const contender = await acquireLock(dir, { ...fast, waitMs: 0, staleMs: 60_000 });
    expect(contender).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });

  it("reclaims an empty lock file that nothing has touched for staleMs", async () => {
    // A holder that died between creating the file and writing to it.
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    const longAgo = new Date(Date.now() - 10_000);
    utimesSync(path, longAgo, longAgo);
    const lock = await acquireLock(dir, { ...fast, waitMs: 0, staleMs: 200 });
    expect(lock).toBeDefined();
    lock!.release();
  });

  // The lock on disk is live throughout; only the read is made to fail, the way it
  // would in the gap after a failed open. ENOENT there means the holder released and
  // a third bridge may already have created a new lock in its place, so calling
  // "gone" a corpse and removing it would take that one out: removing anything at
  // all is the bug. Any other failure is a lock nobody can read: a corpse.
  it.each<[string, string, boolean]>([
    ["ENOENT: it vanished, so leave it alone", "ENOENT", false],
    ["EACCES: it cannot be read, so reclaim it", "EACCES", true],
  ])("a failed read of the lock, %s", async (_what, code, reclaimed) => {
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, JSON.stringify({ pid: process.pid, heartbeat_at: forever }));
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
          if (String(args[0]).endsWith(LOCK_FILE)) {
            throw Object.assign(new Error(`${code}: read failed`), { code });
          }
          return real.readFileSync(...args);
        },
      };
    });
    try {
      const mocked = await import("../src/credentials.js");
      const lock = await mocked.acquireLock(dir, { ...fast, waitMs: 0, pidAlive: () => true });
      expect(lock === undefined).toBe(!reclaimed);
      lock?.release();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    if (!reclaimed) expect(existsSync(path)).toBe(true);
  });

  it("surfaces an error that is not contention instead of retrying it forever", async () => {
    // EACCES from open() means the directory cannot be written, not that someone
    // else holds the lock. Read as a corpse it removes nothing, retries at once,
    // and — with no await on that path — never yields to the event loop.
    vi.resetModules();
    let removals = 0;
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        openSync: () => {
          throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
        },
        // The spin's only exit: fail the test rather than hang the worker.
        rmSync: (...args: Parameters<typeof real.rmSync>) => {
          if (++removals > 100) throw new Error("acquireLock is spinning");
          return real.rmSync(...args);
        },
      };
    });
    try {
      const mocked = await import("../src/credentials.js");
      await expect(mocked.acquireLock(dir, fast)).rejects.toThrow(/EACCES/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("heartbeats every 15s, and calls a heartbeat stale only after 60s", async () => {
    vi.useFakeTimers(); // freezes Date.now(), so the boundary below is exact
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const held = await acquireLock(dir);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
      held!.release();

      const beatenAgo = (ms: number) => JSON.stringify({ pid: process.pid, heartbeat_at: Date.now() - ms });
      const probe = () => acquireLock(dir, { waitMs: 0, pidAlive: () => true });
      writeFileSync(join(dir, LOCK_FILE), beatenAgo(60_000));
      expect(await probe()).toBeUndefined();
      writeFileSync(join(dir, LOCK_FILE), beatenAgo(60_001));
      const lock = await probe();
      expect(lock).toBeDefined();
      lock!.release();
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("gives up after 6 minutes, polling a live holder every 100ms", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      // A holder that is alive and, going by its heartbeat, always will be.
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: process.pid, heartbeat_at: Date.now() + 3_600_000 }),
      );
      let outcome: unknown = "waiting";
      void acquireLock(dir, { pidAlive: () => true }).then((lock) => { outcome = lock; });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
      await vi.advanceTimersByTimeAsync(359_900);
      expect(outcome).toBe("waiting");
      await vi.advanceTimersByTimeAsync(100);
      expect(outcome).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
