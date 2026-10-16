/**
 * The mod's kit tests, against a fresh build in a temp folder that holds only what the plugin
 * ships and its tests: the manifest, hooks.json, the contract and the tests. Nothing of src/
 * is there, so a test that imports from it fails here, as it would for anyone who installs
 * the mod. The committed bundle is never touched.
 *
 * Needs the Claude Code CLI (`claude plugin validate` and `claude plugin test`), which CI does
 * not have: CI runs none of this.
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
    if (run.error) throw run.error;
    if (run.status !== 0) {
      process.exitCode = run.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
