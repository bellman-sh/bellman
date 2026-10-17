/**
 * The mod's kit tests, against a fresh build in a temp folder that holds only what the plugin
 * ships and its tests: the manifest, hooks.json, the contract and the tests. Nothing of src/
 * is there, so a test that imports from it fails here, as it would for anyone who installs
 * the mod. The committed bundle is never touched.
 *
 * Needs the Claude Code CLI (`claude plugin validate` and `claude plugin test`). publish.yml runs
 * `npm run verify` on a runner without it, and `npm publish` runs it again through prepublishOnly:
 * where CI is set and the CLI is not on PATH this skips and succeeds. Anywhere else a missing CLI
 * is a failure. ci.yml runs the pieces of verify, not this, and is unaffected.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMod } from "./build-mod.js";

const dir = mkdtempSync(join(tmpdir(), "bellman-mod-"));
try {
  for (const path of [".claude-plugin/plugin.json", "hooks/hooks.json", "types", "tests"]) {
    cpSync(join("mod", path), join(dir, path), { recursive: true });
  }
  await buildMod(join(dir, "hooks", "register.mjs"));
  for (const command of ["validate", "test"]) {
    const run = spawnSync("claude", ["plugin", command, dir], { stdio: "inherit" });
    if (process.env.CI && (run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      console.log("test:mod skipped: no claude CLI on this runner");
      break;
    }
    if (run.error) throw run.error;
    if (run.status !== 0) {
      process.exitCode = run.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
