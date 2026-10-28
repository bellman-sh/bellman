#!/usr/bin/env node
/**
 * Bellman status hook (#432): sets every seat this session's bridge holds to what Claude Code is doing.
 *
 * UserPromptSubmit sets it `working`. A Notification sets it `needs_you`: Claude Code is asking the person something,
 * a permission most often. The one Notification it skips is `idle_prompt`, "waiting for your input", which comes after
 * a turn has ended and the Stop hook has set the seat idle already. The Stop hook sets `idle` itself (src/stop-hook.ts).
 *
 * It reaches the bridge through the door (`postSeatStatus` in src/door.ts), and the bridge sends only what changes. It
 * prints nothing, since what a UserPromptSubmit hook prints joins the prompt, and it always exits 0: a status is a
 * courtesy to the room, and a broken one must never hold up the person's prompt.
 */
import type { DoorSeatStatus } from "./door-protocol.js";
import { postSeatStatus } from "./door.js";

/** Claude Code writes the hook input to stdin. Read whole, at most a second. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
    setTimeout(() => resolve(text), 1000).unref();
  });
}

/** The status a hook event sets, or undefined for one that sets none. */
export function statusFor(input: unknown): DoorSeatStatus | undefined {
  const { hook_event_name: event, notification_type: kind } = (input ?? {}) as Record<string, unknown>;
  if (event === "UserPromptSubmit") return "working";
  if (event === "Notification" && kind !== "idle_prompt") return "needs_you";
  return undefined;
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const status = statusFor(input);
  if (status !== undefined) await postSeatStatus(status);
}

main().finally(() => process.exit(0));
