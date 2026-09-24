import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
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
