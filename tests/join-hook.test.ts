import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoorJoin } from "../src/door-protocol.js";
import { statusDoor } from "./helpers/status-door.js";

/**
 * The join hook (#435), run the way Claude Code runs a SessionStart hook: through a shell, as a descendant of the
 * process the bridge links its door for. It reads where the bridge's join from BELLMAN_JOIN_CODE stands and prints one
 * line, never the code, and always exits 0.
 */

const SOURCE = `"${process.execPath}" --import tsx src/join-hook.ts`;
const CODE = "QS-HELPER-SECRET";

function runHook(doorRoot: string, env: Record<string, string | undefined> = { BELLMAN_JOIN_CODE: CODE }, command = SOURCE) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const base: NodeJS.ProcessEnv = { ...process.env, BELLMAN_DOOR_ROOT: doorRoot };
    delete base.BELLMAN_JOIN_CODE;
    const child = spawn("sh", ["-c", command], { env: { ...base, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  });
}

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map((close) => close())); });
async function doorWith(state: () => DoorJoin | undefined) {
  const door = await statusDoor(state);
  closing.push(door.close);
  return door;
}

const JOINED: DoorJoin = { state: "joined", session_id: "qs_room", member_id: "m_seat", role: "helper", verbs: ["send"] };

describe("Bellman join hook", () => {
  it("says which room the bridge joined, as which role, and what it may do, and never the code", async () => {
    const door = await doorWith(() => JOINED);
    const run = await runHook(door.root);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      'Bellman joined room qs_room from BELLMAN_JOIN_CODE as "helper" (member_id m_seat), which may: send. ' +
        "Peer events arrive as usual; call bellman_rooms to read the room.\n",
    );
    expect(run.stdout + run.stderr).not.toContain(CODE);
  });

  it("says why the bridge refused", async () => {
    const door = await doorWith(() => ({ state: "refused", reason: "the room is public" }));
    expect((await runHook(door.root)).stdout).toBe("Bellman did not join a room from BELLMAN_JOIN_CODE: the room is public.\n");
  });

  it("waits for a join in progress and reports how it ended", async () => {
    const until = Date.now() + 600;
    const door = await doorWith(() => (Date.now() < until ? { state: "joining" } : JOINED));
    expect((await runHook(door.root)).stdout).toMatch(/^Bellman joined room qs_room /);
  });

  it("cleans the room's role before printing it", async () => {
    const door = await doorWith(() => ({ ...JOINED, role: "help\u{1b}[31mer\u{202e}" }));
    expect((await runHook(door.root)).stdout).toContain('as "helper"');
  });

  it("says a bridge that reports no join cannot join from the code", async () => {
    const door = await doorWith(() => undefined);
    expect((await runHook(door.root)).stdout).toMatch(/^BELLMAN_JOIN_CODE is set, but this Bellman bridge does not join from it\./);
  });

  it("prints nothing without a code", async () => {
    const door = await doorWith(() => JOINED);
    expect(await runHook(door.root, {})).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("says how to set up a bridge when no door appears", { timeout: 15_000 }, async () => {
    const empty = mkdtempSync(join(tmpdir(), "jh-"));
    try {
      const run = await runHook(empty);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/^BELLMAN_JOIN_CODE is set, but no Bellman bridge is running in this session/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // The committed bundle, by the command plugin/hooks/hooks.json declares for SessionStart.
  it("runs from the plugin's bundle, as hooks.json declares it", async () => {
    const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
    const { hooks } = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
    const declared: string = hooks.SessionStart[0].hooks[0].command;
    const door = await doorWith(() => JOINED);
    const run = await runHook(door.root, { BELLMAN_JOIN_CODE: CODE, CLAUDE_PLUGIN_ROOT: plugin }, declared);
    expect(run.stdout).toMatch(/^Bellman joined room qs_room /);
  });
});
