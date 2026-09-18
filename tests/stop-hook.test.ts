import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, inboxDirFor, pendingCount, writeMemberships, type PeerEvent } from "../src/inbox.js";

/**
 * The real hook, run the way Claude Code runs one: through a shell, as a
 * descendant of the process that owns the inbox. Here the test process plays
 * Claude Code, so the inbox is keyed by this process's pid.
 */

const hookInput = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });

function runHook(root: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stderr: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const command = `"${process.execPath}" --import tsx src/stop-hook.ts`;
    const child = spawn("sh", ["-c", command], {
      env: { ...process.env, BELLMAN_INBOX_ROOT: root, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
    child.stdin.end(hookInput);
  });
}

function event(over: Partial<PeerEvent> = {}): PeerEvent {
  return {
    session_id: "bs_test",
    member_id: "m_mine",
    cursor: 5,
    type: "message",
    from_member_id: "m_peer",
    from_label: "peer@codenerd",
    ref_id: null,
    at: new Date().toISOString(),
    payload: { text: "ping from the other session" },
    ...over,
  };
}

let root: string;
let inbox: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bellman-hook-"));
  inbox = inboxDirFor(process.pid, root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Bellman Stop hook", () => {
  it("lets the turn end when this session has no Bellman bridge", async () => {
    const run = await runHook(root);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("blocks the stop and hands queued peer events to Claude", async () => {
    enqueue(inbox, event());

    const run = await runHook(root);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("UNTRUSTED PEER CONTENT");
    expect(run.stderr).toContain("ping from the other session");
    expect(pendingCount(inbox)).toBe(0);
  });

  it("listens for new events while you're in an active session", async () => {
    writeMemberships(inbox, [{ session_id: "bs_test", member_id: "m_mine" }]);
    setTimeout(() => enqueue(inbox, event({ payload: { text: "arrived while listening" } })), 700);

    const run = await runHook(root, { BELLMAN_HOOK_WAIT_SECONDS: "8" });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("arrived while listening");
    expect(run.ms).toBeLessThan(6000);
  });

  it("never listens outside an active session, even with a wait configured", async () => {
    writeMemberships(inbox, []);

    const run = await runHook(root, { BELLMAN_HOOK_WAIT_SECONDS: "8" });

    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(4000);
  });
});
