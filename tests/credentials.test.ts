import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
