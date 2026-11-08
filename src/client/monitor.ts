#!/usr/bin/env node
/**
 * Bellman's plugin Monitor: puts a peer event in front of Claude the moment it arrives, while the session works or idles.
 *
 * Claude Code runs it in the background for the whole session, from the plugin's `experimental.monitors`, and "what it
 * prints reaches Claude as notifications". It replaces channel delivery, which MCP 2026-07-28 cannot carry: a server on
 * that revision may send no notification the client did not ask for, and Claude Code does not register such a server
 * as a channel.
 *
 * It finds its session's bridge the way the Stop hook does, by walking up its own process ancestry to the Claude Code
 * process whose inbox exists (`findInbox`), and waits for one until the bridge has made it. Each second it takes the
 * interrupting events from that inbox (`drainInterrupting`), once and atomically, so the Stop hook and bellman_wait
 * never hand the same event over again, and prints each as one line. Ambient events stay queued for the end of the
 * turn.
 *
 * What it prints is peer content: `renderLine` says so first and escapes every `<` in it, as the Stop hook's text does.
 * An action request carries the instruction to show it to the human and act only on their approval. It never exits on
 * its own; Claude Code stops it when the session ends.
 */
import { pathToFileURL } from "node:url";
import { drainInterrupting, findInbox, renderLine, type PeerEvent } from "./inbox.js";

export const MONITOR_POLL_MS = 1_000;

export interface MonitorOptions {
  /** The inbox this session's bridge writes, or undefined until it has made one. */
  find: () => string | undefined;
  drain: (dir: string) => PeerEvent[];
  write: (line: string) => void;
  pollMs?: number;
}

/** One pass: find the inbox if not yet found, and print what has arrived. Returns the inbox, found or not. */
export function monitorOnce(dir: string | undefined, opts: Omit<MonitorOptions, "pollMs">): string | undefined {
  const found = dir ?? opts.find();
  if (!found) return undefined;
  for (const event of opts.drain(found)) opts.write(`Bellman: ${renderLine(event)}\n`);
  return found;
}

/** Run until stopped: a pass at once, then one every `pollMs`. */
export function runMonitor(opts: MonitorOptions): { stop(): void } {
  let dir: string | undefined;
  const pass = () => {
    try {
      dir = monitorOnce(dir, opts);
    } catch {
      // A pass that fails (the inbox swept away with a dead bridge, say) is tried again next time, from the top.
      dir = undefined;
    }
  };
  pass();
  const timer = setInterval(pass, opts.pollMs ?? MONITOR_POLL_MS);
  return { stop: () => clearInterval(timer) };
}

// Run as a program (the plugin's monitor command, or its bundle), not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMonitor({ find: () => findInbox(), drain: drainInterrupting, write: (line) => process.stdout.write(line) });
}
