#!/usr/bin/env node
/**
 * Bellman Stop hook — delivery for Claude Code sessions without channels.
 *
 * Runs when a turn ends. If the bridge (in BELLMAN_DELIVERY=hook mode) queued
 * peer events, print them to stderr and exit 2: Claude Code blocks the stop and
 * hands them to Claude, which keeps working. Otherwise exit 0 and let the turn
 * end.
 *
 * BELLMAN_HOOK_WAIT_SECONDS (default 0): while you are in an active Bellman
 * session, keep listening this long for new events before letting the turn end.
 * It holds the terminal for that long, so keep it short, and set the hook's
 * `timeout` in settings.json above it. Outside a Bellman session it never waits.
 */
import { drain, findInbox, readMemberships, renderBatch } from "./inbox.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Claude Code writes the hook input to stdin; consume it without depending on it. */
function consumeStdin(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve();
    const done = () => resolve();
    process.stdin.on("data", () => undefined);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 1000).unref();
  });
}

async function main(): Promise<number> {
  await consumeStdin();
  const dir = findInbox();
  if (!dir) return 0; // no Bellman bridge in this session

  let events = drain(dir);
  const requested = Number(process.env.BELLMAN_HOOK_WAIT_SECONDS ?? 0);
  const waitSeconds = Number.isFinite(requested) ? Math.max(requested, 0) : 0;

  if (events.length === 0 && waitSeconds > 0 && readMemberships(dir).length > 0) {
    const deadline = Date.now() + waitSeconds * 1000;
    while (events.length === 0 && Date.now() < deadline) {
      await sleep(500);
      events = drain(dir);
    }
  }

  if (events.length === 0) return 0;
  process.stderr.write(renderBatch(events) + "\n");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A broken hook must never trap the session: report it, don't block.
    process.stderr.write(`[bellman] stop hook failed: ${String(err)}\n`);
    process.exit(1);
  }
);
