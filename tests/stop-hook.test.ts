import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enqueue, inboxDirFor, pendingCount, writeMemberships, type PeerEvent } from "../src/inbox.js";
import { statusDoor } from "./helpers/status-door.js";

/**
 * The real hook, run the way Claude Code runs one: through a shell, as a
 * descendant of the process that owns the inbox. Here the test process plays
 * Claude Code, so the inbox is keyed by this process's pid.
 */

/** What Claude Code writes to the hook's stdin; `session_id` is the only field the hook reads. */
const hookInput = (sessionId = "sess-1") =>
  JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, session_id: sessionId });

const SOURCE = `"${process.execPath}" --import tsx src/stop-hook.ts`;

function runHook(root: string, env: Record<string, string> = {}, command = SOURCE, input = hookInput()) {
  return new Promise<{ code: number | null; stderr: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn("sh", ["-c", command], {
      // A scratch door root too, so that no run finds the door of a real bridge among its parents (#432).
      env: { ...process.env, BELLMAN_INBOX_ROOT: root, BELLMAN_DOOR_ROOT: root, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
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

// #432: a turn that ends sets every seat idle through the bridge's door. One the hook blocks, to hand Claude what is
// queued, does not end: Claude goes on working.
describe("the Stop hook and the seat status", () => {
  it("sets every seat idle when it lets the turn end", async () => {
    const door = await statusDoor();
    try {
      const run = await runHook(root, { BELLMAN_DOOR_ROOT: door.root });
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
      expect(door.setStatus).toHaveBeenCalledExactlyOnceWith("idle");
    } finally {
      await door.close();
    }
  });

  it("sets every seat idle in hook delivery too, from an inbox that holds nothing", async () => {
    const door = await statusDoor();
    try {
      mkdirSync(inbox, { recursive: true });
      const run = await runHook(root, { BELLMAN_DOOR_ROOT: door.root });
      expect(run.code).toBe(0);
      expect(door.setStatus).toHaveBeenCalledExactlyOnceWith("idle");
    } finally {
      await door.close();
    }
  });

  it("sets no status when it blocks the stop to hand over queued events", async () => {
    const door = await statusDoor();
    try {
      enqueue(inbox, event());
      const run = await runHook(root, { BELLMAN_DOOR_ROOT: door.root });
      expect(run.code).toBe(2);
      expect(door.setStatus).not.toHaveBeenCalled();
    } finally {
      await door.close();
    }
  });
});

// #530: the third stop of a session with nothing queued asks the bridge's door whether the account has memory capture
// on, and with it on asks the agent, once, whether anything durable came up to remember in home memory. The switch is
// the account's (PUT /me/memory from the dash); no environment turns it on, and the hook reads only the session id.
describe("the Stop hook's memory check", () => {
  type Door = Awaited<ReturnType<typeof statusDoor>>;
  const stops = async (n: number, door?: Door, input?: string) => {
    const runs = [];
    const env: Record<string, string> = door ? { BELLMAN_DOOR_ROOT: door.root } : {};
    for (let i = 0; i < n; i++) runs.push(await runHook(root, env, SOURCE, input));
    return runs;
  };
  /** Runs `n` stops against a door whose account has capture `on`, then closes it. */
  const withDoor = async <T,>(on: boolean | undefined, body: (door: Door) => Promise<T>): Promise<T> => {
    const door = await statusDoor(() => undefined, on);
    try {
      return await body(door);
    } finally {
      await door.close();
    }
  };

  it("asks nothing with no bridge to ask, and counts no turn against the account", async () => {
    const runs = await stops(4);
    expect(runs.map((r) => [r.code, r.stderr])).toEqual([[0, ""], [0, ""], [0, ""], [0, ""]]);
  });

  it("asks nothing while the account has capture off, and reads the account once, at the third stop", () =>
    withDoor(false, async (door) => {
      const runs = await stops(4, door);
      expect(runs.map((r) => [r.code, r.stderr])).toEqual([[0, ""], [0, ""], [0, ""], [0, ""]]);
      expect(door.readMemory).toHaveBeenCalledTimes(1);
      expect(door.setStatus).toHaveBeenCalledTimes(4);
    }));

  it("asks nothing when the bridge cannot read the account", () =>
    withDoor(undefined, async (door) => {
      const runs = await stops(3, door);
      expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
      expect(door.readMemory).toHaveBeenCalledTimes(1);
    }));

  it("asks at the third stop of a session, once, with capture on and nothing queued, and sets no seat idle then", () =>
    withDoor(true, async (door) => {
      const runs = await stops(4, door);
      expect(runs.map((r) => r.code)).toEqual([0, 0, 2, 0]);
      expect(runs[2].stderr).toContain("bellman_memory");
      expect(runs[2].stderr).toContain('"remember"');
      expect(runs[2].stderr).toContain("Memory check");
      expect(runs[3].stderr).toBe("");
      expect(door.readMemory).toHaveBeenCalledTimes(1);
      expect(door.setStatus).toHaveBeenCalledTimes(3);
    }));

  it("counts each session on its own", () =>
    withDoor(true, async (door) => {
      await stops(3, door, hookInput("sess-1"));
      const other = await runHook(root, { BELLMAN_DOOR_ROOT: door.root }, SOURCE, hookInput("sess-2"));
      expect(other.code).toBe(0);
    }));

  it("asks in hook delivery too, from an inbox that holds nothing", () =>
    withDoor(true, async (door) => {
      mkdirSync(inbox, { recursive: true });
      const runs = await stops(3, door);
      expect(runs.map((r) => r.code)).toEqual([0, 0, 2]);
      expect(runs[2].stderr).toContain("Memory check");
    }));

  it("hands queued events over first, and asks at the next stop that has none", () =>
    withDoor(true, async (door) => {
      await stops(2, door);
      enqueue(inbox, event({ payload: { text: "queued ahead of the memory check" } }));

      const [withEvents] = await stops(1, door);
      expect(withEvents.code).toBe(2);
      expect(withEvents.stderr).toContain("queued ahead of the memory check");
      expect(withEvents.stderr).not.toContain("Memory check");
      expect(door.readMemory).not.toHaveBeenCalled();

      const [next] = await stops(1, door);
      expect(next.code).toBe(2);
      expect(next.stderr).toContain("Memory check");
    }));

  it("never asks without a session id to count by", () =>
    withDoor(true, async (door) => {
      const runs = await stops(4, door, JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
      expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
      expect(door.readMemory).not.toHaveBeenCalled();
    }));

  it("refuses a session id that is not a plain name", () =>
    withDoor(true, async (door) => {
      const runs = await stops(3, door, hookInput("../escape"));
      expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
      expect(existsSync(join(root, "escape"))).toBe(false);
    }));
});

/**
 * The committed bundle, run by the command plugin/hooks/hooks.json declares. Claude Code
 * substitutes ${CLAUDE_PLUGIN_ROOT} and also exports it to the hook, so the shell here
 * expands it from the environment to the same path.
 */
describe("the plugin's Stop hook, plugin/bridge/stop-hook.mjs", () => {
  const PLUGIN = fileURLToPath(new URL("../plugin", import.meta.url));
  const declared = (): string => {
    const { hooks } = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
    return hooks.Stop[0].hooks[0].command;
  };

  it("lets the turn end when this session has no Bellman bridge", async () => {
    const run = await runHook(root, { CLAUDE_PLUGIN_ROOT: PLUGIN }, declared());

    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
  });

  it("blocks the stop and hands a queued peer event to Claude", async () => {
    enqueue(inbox, event({ payload: { text: "queued for the bundled hook" } }));

    const run = await runHook(root, { CLAUDE_PLUGIN_ROOT: PLUGIN }, declared());

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("UNTRUSTED PEER CONTENT");
    expect(run.stderr).toContain("queued for the bundled hook");
    expect(pendingCount(inbox)).toBe(0);
  });
});
