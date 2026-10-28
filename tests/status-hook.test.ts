import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statusDoor } from "./helpers/status-door.js";

/**
 * The status hook (#432), run the way Claude Code runs one: through a shell, as a descendant of the process the bridge
 * links its door for. UserPromptSubmit sets every seat working, a Notification that asks the person something sets it
 * needs_you. It prints nothing, since what UserPromptSubmit prints joins the prompt, and it never blocks.
 */

const SOURCE = `"${process.execPath}" --import tsx src/status-hook.ts`;

function runHook(doorRoot: string, input: Record<string, unknown>, command = SOURCE, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env: { ...process.env, BELLMAN_DOOR_ROOT: doorRoot, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

let door: Awaited<ReturnType<typeof statusDoor>>;
beforeEach(async () => { door = await statusDoor(); });
afterEach(async () => { await door.close(); });

describe("Bellman status hook", () => {
  it.each([
    ["a prompt submitted", { hook_event_name: "UserPromptSubmit", prompt: "go" }, "working"],
    ["a permission prompt", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow?" }, "needs_you"],
    ["a notification with no type", { hook_event_name: "Notification", message: "Claude needs your permission" }, "needs_you"],
  ])("sets every seat's status on %s, and prints nothing", async (_what, input, status) => {
    const run = await runHook(door.root, input);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(door.setStatus).toHaveBeenCalledExactlyOnceWith(status);
  });

  // "Waiting for your input" comes after a turn has ended, which the Stop hook already set idle.
  it("leaves the status alone on an idle prompt, and on an event it does not know", async () => {
    await runHook(door.root, { hook_event_name: "Notification", notification_type: "idle_prompt" });
    await runHook(door.root, { hook_event_name: "PreToolUse" });
    expect(door.setStatus).not.toHaveBeenCalled();
  });

  // The committed bundle, by the command plugin/hooks/hooks.json declares for both events.
  it("runs from the plugin's bundle, as hooks.json declares it, and sets the status", async () => {
    const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
    const { hooks } = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
    const declared: string = hooks.UserPromptSubmit[0].hooks[0].command;
    expect(hooks.Notification[0].hooks[0].command).toBe(declared);
    const run = await runHook(door.root, { hook_event_name: "UserPromptSubmit" }, declared, { CLAUDE_PLUGIN_ROOT: plugin });
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(door.setStatus).toHaveBeenCalledExactlyOnceWith("working");
  });

  it("exits 0 in silence with no door to find, or input it cannot read", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sd-"));
    try {
      expect(await runHook(empty, { hook_event_name: "UserPromptSubmit" })).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const garbled = await new Promise<number | null>((resolve) => {
      const child = spawn("sh", ["-c", SOURCE], { env: { ...process.env, BELLMAN_DOOR_ROOT: door.root } });
      child.on("close", resolve);
      child.stdin.end("not json");
    });
    expect(garbled).toBe(0);
    expect(door.setStatus).not.toHaveBeenCalled();
  });
});
