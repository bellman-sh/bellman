import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServer, writeServer } from "../src/credentials.js";

/**
 * writeServer replaces credentials.json rather than truncating it, and the only
 * way to prove that is to fail a write halfway and look at what survived.
 *
 * A real ENOSPC cannot be arranged in a test, and the failure that matters is
 * not "the write threw" — the old code threw too. It is WHEN it threw: opening
 * a file for writing truncates it, so by the time the write fails the old
 * contents are already gone. A mock that merely throws would pass against the
 * very implementation this is here to rule out.
 *
 * So the mock does what the kernel does, in order: truncate the thing being
 * written to, then fail. Pointed at credentials.json — which is what the old
 * code opened — it destroys the credential. Pointed at a temp file, it destroys
 * the temp file and the credential is untouched. Same mock, and only the
 * implementation decides which file is in the line of fire. It is the real
 * node:fs until a test asks for the failure.
 *
 * Run against the truncating write, the first three fail the way the defect
 * actually shows up — `expected {} to deeply equal { …access_token: 'first' }`,
 * the same for a server the call never touched, and `expected '' not to be ''`
 * for a credentials.json of zero bytes. Those three carry the claim. The last
 * two below pass against it as well and are not evidence for this fix: there is
 * no temp file to leave behind when nothing writes one, and the old code
 * chmodded 0600 too. They guard the replacement's own properties, not the
 * property this suite exists for.
 */
const disk = vi.hoisted(() => ({ failAfterTruncating: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: ((target: string, body: string, opts?: unknown) => {
      if (!disk.failAfterTruncating) return real.writeFileSync(target, body, opts as never);
      real.writeFileSync(target, "", opts as never); // the open's O_TRUNC, which already happened
      const err = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }) as typeof real.writeFileSync,
  };
});

const PROD = "https://mcp.bellman.sh/mcp";
const DEV = "http://127.0.0.1:8787/mcp";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bellman-cred-write-"));
  disk.failAfterTruncating = false;
});
afterEach(() => {
  disk.failAfterTruncating = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("a credential write that fails partway", () => {
  it("leaves the previous credential intact and readable", () => {
    writeServer(dir, PROD, { client: { client_id: "c1" }, tokens: { access_token: "first" } });

    disk.failAfterTruncating = true;
    expect(() => writeServer(dir, PROD, { tokens: { access_token: "second" } })).toThrow(/ENOSPC/);
    disk.failAfterTruncating = false;

    // The point of the whole change: the caller catches that throw and promises the
    // person their current credential still works. This is that promise being true.
    expect(readServer(dir, PROD)).toEqual({ client: { client_id: "c1" }, tokens: { access_token: "first" } });
  });

  it("does not take the other servers down with it", () => {
    // The failing write touches one server's entry and rewrites the whole file to do it,
    // so a truncation loses credentials for servers the call was never about.
    writeServer(dir, PROD, { tokens: { access_token: "prod" } });
    writeServer(dir, DEV, { tokens: { access_token: "dev" } });

    disk.failAfterTruncating = true;
    expect(() => writeServer(dir, PROD, { tokens: { access_token: "next" } })).toThrow(/ENOSPC/);
    disk.failAfterTruncating = false;

    expect(readServer(dir, DEV)).toEqual({ tokens: { access_token: "dev" } });
    expect(readServer(dir, PROD)).toEqual({ tokens: { access_token: "prod" } });
  });

  it("leaves the file parseable, not empty", () => {
    // readServer answers {} for a file it cannot parse as well as for one that is gone,
    // so the assertions above would also pass on a wrecked file. This reads the bytes.
    writeServer(dir, PROD, { tokens: { access_token: "first" } });

    disk.failAfterTruncating = true;
    expect(() => writeServer(dir, PROD, { tokens: { access_token: "second" } })).toThrow(/ENOSPC/);
    disk.failAfterTruncating = false;

    const raw = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(raw).not.toBe("");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      servers: { [PROD]: { tokens: { access_token: "first" } } },
    });
  });

  it("cleans up its temp file, so a failed save leaves nothing behind", () => {
    writeServer(dir, PROD, { tokens: { access_token: "first" } });

    disk.failAfterTruncating = true;
    expect(() => writeServer(dir, PROD, { tokens: { access_token: "second" } })).toThrow(/ENOSPC/);
    disk.failAfterTruncating = false;

    // A temp file left at 0600 holding a half-written token is a smaller problem than
    // losing the credential, but it is still a token on disk nobody will ever clean up.
    expect(readdirSync(dir)).toEqual(["credentials.json"]);
  });
});

describe("the replacement it writes when nothing fails", () => {
  it("is 0600, like the file it replaces", () => {
    // The temp file carries the token for the moment before the rename, so it has to be
    // born 0600 — a rename does not change the mode, it moves it.
    writeServer(dir, PROD, { tokens: { access_token: "a1" } });
    writeServer(dir, PROD, { tokens: { access_token: "a2" } });

    const path = join(dir, "credentials.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readServer(dir, PROD)).toEqual({ tokens: { access_token: "a2" } });
    expect(existsSync(join(dir, `.credentials.json.${process.pid}.tmp`))).toBe(false);
  });
});
