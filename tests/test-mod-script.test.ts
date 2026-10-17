/**
 * `npm run test:mod` runs the mod's kit tests through the Claude Code CLI. publish.yml runs `npm run verify` on a
 * runner that has no such CLI, and `npm publish` runs it again through prepublishOnly: there the script skips and
 * succeeds. Anywhere else a missing CLI is a failure, or a machine without it would call the mod tested.
 *
 * These run the real script with a PATH that holds node and npx and no `claude`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let bin: string;

beforeAll(() => {
  // A folder of links to what `npx tsx` needs and nothing more (npx runs its command through sh): `claude` may sit
  // beside node on this machine, where `npm i -g` puts it.
  bin = mkdtempSync(join(tmpdir(), "bellman-no-claude-"));
  const links = { node: process.execPath, npx: join(dirname(process.execPath), "npx"), sh: "/bin/sh" };
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(bin, name));
});

afterAll(() => rmSync(bin, { recursive: true, force: true }));

/** `npx tsx scripts/test-mod.ts` with no `claude` on PATH; `CI` is set only when `ci` says so, whatever this run has. */
function testMod(ci: boolean) {
  const { CI: _ci, ...env } = process.env;
  return spawnSync("npx", ["tsx", "scripts/test-mod.ts"], {
    cwd: ROOT,
    env: { ...env, PATH: bin, ...(ci ? { CI: "1" } : {}) },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("npm run test:mod with no Claude Code CLI on PATH", () => {
  it("skips, and succeeds, on a CI runner", () => {
    const run = testMod(true);

    expect(run.stdout.trim()).toBe("test:mod skipped: no claude CLI on this runner");
    expect(run.status).toBe(0);
  });

  it("fails anywhere else, for the missing CLI", () => {
    const run = testMod(false);

    expect(run.stdout).not.toContain("skipped");
    expect(run.stderr).toContain("spawnSync claude ENOENT");
    expect(run.status).not.toBe(0);
  });

  // The skip is for an absent CLI alone: a runner that has one gets the kit tests, and a failing run fails.
  it("runs a CLI that is there, on a CI runner too", () => {
    const stub = join(bin, "claude");
    writeFileSync(stub, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    try {
      const run = testMod(true);

      expect(run.stdout).not.toContain("skipped");
      expect(run.status).toBe(7);
    } finally {
      rmSync(stub);
    }
  });
});
