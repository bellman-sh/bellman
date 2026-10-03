import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, type Delivery, type Remote } from "../src/bridge.js";
import { drain, fromEnvelope, type WireEnvelope } from "../src/inbox.js";

const envelope = (over: Record<string, unknown> = {}): WireEnvelope => ({
  trust: "untrusted",
  origin: { memberId: "m_a", label: "lead@a" },
  data: {
    cursor: 7,
    type: "progress",
    from: { member_id: "m_a", label: "lead@a" },
    payload: { note: "ran migration 0042" },
    ref_id: null,
    at: "2026-03-15T12:00:00.000Z",
    ambient: true,
    ...over,
  },
} as WireEnvelope);

describe("fromEnvelope", () => {
  it("carries ambient through to the delivered event", () => {
    const e = fromEnvelope({ session_id: "qs_1", member_id: "m_me" }, envelope());
    expect(e.ambient).toBe(true);
  });

  it("leaves it falsy for an event the server did not mark", () => {
    const e = fromEnvelope(
      { session_id: "qs_1", member_id: "m_me" },
      envelope({ type: "message", ambient: undefined }),
    );
    expect(e.ambient).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

/**
 * deliver() is private to createBridge, so these tests reach it the way a peer's event does: through
 * the watcher, off a scripted remote. The remote answers the watcher's first long-poll with the events
 * and parks the second. The watcher awaits every delivery before it polls again, so the second poll
 * arriving is what says this batch is finished, and that is what lets a test assert that something was
 * NOT pushed without waiting out a timeout and hoping.
 */
type Push = { params: { content: string; meta: Record<string, string> } };

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the watcher never finished delivering the batch");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(teardown.splice(0).map((close) => close()));
});

/** A bridge in this delivery mode, once its watcher has delivered `events`: what it pushed, and what it queued. */
async function delivered(delivery: Delivery, events: WireEnvelope[]) {
  const inboxDir = delivery === "hook" ? mkdtempSync(join(tmpdir(), "bellman-delivery-")) : undefined;
  const last = events.at(-1)?.data.cursor ?? 0;
  let polls = 0;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const answer = (batch: WireEnvelope[], cursor: number): CallToolResult => ({
    content: [{ type: "text", text: "synced" }],
    structuredContent: { events: batch, cursor, session_status: "open" },
  });
  const remote: Remote = {
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }) => {
      // The agent's own sync only teaches the bridge the membership, at cursor 0 so that nothing counts as seen.
      if (name !== "bellman_sync" || !(Number(args?.wait_seconds) > 0)) return answer([], 0);
      polls += 1;
      if (polls === 1) return answer(events, last);
      await parked;
      return answer([], last);
    },
    close: async () => release(),
  };

  const bridge = createBridge({ delivery, inboxDir, remote: async () => remote, pollWaitSeconds: 1 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  const pushes: Push[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push(n as unknown as Push);
  };
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  teardown.push(async () => {
    await bridge.close();
    await client.close();
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  });

  // Any call that names a membership arms its watcher.
  await client.callTool({
    name: "bellman_sync",
    arguments: { session_id: "qs_1", member_id: "m_me", since_cursor: 0, wait_seconds: 0 },
  });
  await until(() => polls >= 2);
  await new Promise((r) => setTimeout(r, 0)); // a notification reaches the client a tick after it is sent

  return { pushes, queued: inboxDir ? drain(inboxDir) : [] };
}

describe("deliver", () => {
  const tick = envelope({ type: "heartbeat", cursor: 1, ambient: undefined });
  const reply = envelope({ type: "progress", cursor: 2 });

  it("pushes a tick and withholds a reply, in channel mode", async () => {
    const { pushes } = await delivered("channel", [tick, reply]);
    expect(pushes.map((p) => p.params.meta.type)).toEqual(["heartbeat"]);
  });

  // Review Focus 4 — the early return must not skip the queue.
  it("queues both in hook mode, because end of turn is not an interruption", async () => {
    const { queued } = await delivered("hook", [tick, reply]);
    expect(queued.map((e) => e.type)).toEqual(["heartbeat", "progress"]);
  });

  // Neither case above can tell reading the flag from naming `progress`: here the type and the flag
  // disagree, and the flag decides.
  it("goes by the server's flag and not by the type", async () => {
    const { pushes } = await delivered("channel", [
      envelope({ type: "message", cursor: 1 }), // an interrupting type the server marked ambient
      envelope({ type: "progress", cursor: 2, ambient: undefined }), // an ambient type it did not
    ]);
    expect(pushes.map((p) => p.params.meta.type)).toEqual(["progress"]);
  });
});
