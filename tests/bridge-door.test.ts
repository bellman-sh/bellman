/**
 * What the bridge reports for its local door (src/door.ts serves it): the seats it watches, the events it lately
 * delivered, and a room's log read with its own credential. Each test runs a bridge over a fake remote whose
 * bellman_start puts it in one room and whose long poll does as the test says, then reads the fact off the bridge
 * as the door will.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, RECENT_LIMIT, type Delivery, type Remote, type UploadOptions } from "../src/bridge.js";
import { fromEnvelope, type WireEnvelope } from "../src/inbox.js";

const S = "qs_door";
const M = "m_door";
const SERVER = "https://bellman.test/mcp";

function envelope(cursor: number, type: string, ambient?: true): WireEnvelope {
  return {
    trust: "untrusted",
    origin: { memberId: "m_peer", label: "peer@a" },
    data: {
      cursor,
      type,
      from: { member_id: "m_peer", label: "peer@a" },
      payload: { text: `event ${cursor}` },
      ref_id: null,
      at: "2026-10-16T12:00:00.000Z",
      ambient,
    },
  };
}
const message = (cursor: number) => envelope(cursor, "message");
/** A canvas edit, which the server marks ambient: channel delivery does not push it. */
const surfaceEdit = (cursor: number) => envelope(cursor, "surface", true);
const ENVELOPE = message(9);

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(teardown.splice(0).map((close) => close()));
});

interface Armed {
  /**
   * What the fake's long poll does. Events: answered to the first poll, and the polls after are parked. "throws":
   * every poll fails. "throws once": the first fails, the second answers nothing at once, the rest are parked.
   * "throws, then errors": the first fails, the second is answered with an error result, the rest are parked.
   * "hangs": every poll is parked, and the connection closing does not wake them.
   */
  sync: WireEnvelope[] | "throws" | "throws once" | "throws, then errors" | "hangs";
  delivery?: Delivery;
  /** The room the fake's bellman_start puts the bridge in. */
  session?: string;
  upload?: UploadOptions;
  /** Called each time the bridge makes a connection to the fake. */
  onConnect?: () => void;
  /** Called each time the bridge lists tools on the connection it holds: from here, that is all a refreshed sign-in looks like. */
  onList?: () => void;
}

/** A bridge that has relayed one bellman_start, which armed a watch on member M in the room; its long poll is the fake's. */
async function armedBridge(opts: Armed) {
  const delivery = opts.delivery ?? "channel";
  const inboxDir = delivery === "hook" ? mkdtempSync(join(tmpdir(), "bellman-door-")) : undefined;
  let syncs = 0;
  let answered = opts.sync === "hangs";
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const poll = (events: WireEnvelope[]): CallToolResult => ({
    content: [{ type: "text", text: "synced" }],
    structuredContent: { events, cursor: events.at(-1)?.data.cursor ?? 0, session_status: "active" },
  });

  const remote: Remote = {
    listTools: async () => (opts.onList?.(), { tools: [] }),
    callTool: async ({ name }) => {
      // A tool call the server refuses, as one does when the sign-in behind the connection has died.
      if (name === "bellman_audit") throw new UnauthorizedError();
      if (name !== "bellman_sync") {
        return { content: [{ type: "text", text: "ok" }], structuredContent: { session_id: opts.session ?? S, member_id: M } };
      }
      syncs += 1;
      const failsFirst = opts.sync === "throws once" || opts.sync === "throws, then errors";
      if (opts.sync === "throws" || (failsFirst && syncs === 1)) throw new Error("socket hang up");
      if (opts.sync === "throws, then errors" && syncs === 2) {
        // The polls after it are parked, so nothing but this error can have ended the failure.
        answered = true;
        return { isError: true, content: [{ type: "text", text: "overloaded" }] };
      }
      if (answered) {
        await parked;
        return poll([]);
      }
      answered = true;
      return poll(Array.isArray(opts.sync) ? opts.sync : []);
    },
    close: async () => {
      if (opts.sync !== "hangs") release();
    },
  };

  const connect = async () => {
    opts.onConnect?.();
    return remote;
  };
  const bridge = createBridge({ delivery, inboxDir, remote: connect, pollWaitSeconds: 1, upload: opts.upload });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  client.fallbackNotificationHandler = async () => {};
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  teardown.push(async () => {
    await bridge.close();
    release();
    await client.close();
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  });

  // A manifest in the call keeps the bridge from reading .bellman/room.yaml from wherever the suite runs.
  await client.callTool({ name: "bellman_start", arguments: { manifest: {} } });
  return {
    bridge,
    client,
    get syncs() {
      return syncs;
    },
  };
}

/** A server's fetch that writes down each request it is asked, and answers it with `answer`. */
function serving(answer: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return answer(request);
  };
  return { seen, fetchImpl };
}
const uploadTo = (fetchImpl: typeof fetch, bearer: UploadOptions["bearer"] = () => "tok"): UploadOptions => ({
  serverUrl: SERVER,
  bearer,
  fetchImpl,
});
const log = () => Response.json({ events: [ENVELOPE], cursor: 9 });

describe("seats", () => {
  it("names each watched member, retrying while its long poll fails", async () => {
    const healthy = await armedBridge({ sync: [] });
    await until(() => healthy.syncs > 0);
    expect(healthy.bridge.seats()).toEqual([{ session_id: S, member_id: M, retrying: false }]);
    const failing = await armedBridge({ sync: "throws" });
    await until(() => failing.bridge.seats()[0]?.retrying === true);
  });

  it("stops saying retrying once its next long poll succeeds", async () => {
    const { bridge } = await armedBridge({ sync: "throws once" });
    await until(() => bridge.seats()[0]?.retrying === true);
    await until(() => bridge.seats()[0]?.retrying === false);
    expect(bridge.seats()).toEqual([{ session_id: S, member_id: M, retrying: false }]);
  });

  // The seat reports the connection. A server that answers, even with an error result, has been reached.
  it("counts a poll the server answers with an error as answered", async () => {
    const armed = await armedBridge({ sync: "throws, then errors" });
    await until(() => armed.bridge.seats()[0]?.retrying === true);
    await until(() => armed.syncs >= 2);
    await until(() => armed.bridge.seats()[0]?.retrying === false);
  });
});

describe("recent", () => {
  it("keeps what deliver saw, newest last, ambient included, in channel delivery too", async () => {
    const { bridge } = await armedBridge({ sync: [message(1), surfaceEdit(2)] });
    await until(() => bridge.recent().length === 2);
    expect(bridge.recent().map((e) => [e.cursor, e.type, e.ambient === true])).toEqual([
      [1, "message", false],
      [2, "surface", true],
    ]);
  });

  it("keeps them in hook delivery, which queues every event", async () => {
    const { bridge } = await armedBridge({ delivery: "hook", sync: [message(1), surfaceEdit(2)] });
    await until(() => bridge.recent().length === 2);
    expect(bridge.recent().map((e) => [e.cursor, e.type, e.ambient === true])).toEqual([
      [1, "message", false],
      [2, "surface", true],
    ]);
  });

  it("holds the newest 50", async () => {
    const { bridge } = await armedBridge({ sync: Array.from({ length: 51 }, (_, i) => message(i + 1)) });
    await until(() => bridge.recent().at(-1)?.cursor === 51);
    expect(RECENT_LIMIT).toBe(50);
    expect(bridge.recent()).toHaveLength(50);
    expect(bridge.recent()[0].cursor).toBe(2);
  });
});

describe("readEvents", () => {
  it("reads the room's log with the bridge's bearer", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S, 5)).toEqual({
      status: 200,
      body: { events: [fromEnvelope({ session_id: S, member_id: M }, ENVELOPE)], cursor: 9 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`https://bellman.test/rooms/${S}/events?after=5`);
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it("asks for the cursor it is given, 0 included, and for the newest when it is given none", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    await bridge.readEvents(S, 0);
    await bridge.readEvents(S);
    expect(seen.map((r) => r.url)).toEqual([
      `https://bellman.test/rooms/${S}/events?after=0`,
      `https://bellman.test/rooms/${S}/events`,
    ]);
  });

  it("names the room as one path segment", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], session: "qs_a/b?c", upload: uploadTo(fetchImpl) });
    await bridge.readEvents("qs_a/b?c");
    expect(seen.map((r) => r.url)).toEqual(["https://bellman.test/rooms/qs_a%2Fb%3Fc/events"]);
  });

  it("refuses a room it does not watch, and asks the server nothing", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents("qs_elsewhere")).toEqual({ status: 404, body: { error: "not_watched" } });
    expect(seen).toEqual([]);
  });

  it("says it has no credential when the bridge was given no upload target", async () => {
    const { bridge } = await armedBridge({ sync: [] });
    expect(await bridge.readEvents(S)).toEqual({ status: 503, body: { error: "no_credential" } });
  });

  it("asks once more after a 401 when the sign-in was refreshed in between", async () => {
    let token = "old";
    let listed = 0;
    const { seen, fetchImpl } = serving((request) =>
      request.headers.get("authorization") === "Bearer new" ? log() : new Response(null, { status: 401 }),
    );
    const { bridge } = await armedBridge({
      sync: [],
      upload: uploadTo(fetchImpl, () => token),
      onList: () => {
        listed++;
        token = "new";
      },
    });
    expect(await bridge.readEvents(S)).toMatchObject({ status: 200 });
    expect({ listed, bearers: seen.map((r) => r.headers.get("authorization")) }).toEqual({
      listed: 1,
      bearers: ["Bearer old", "Bearer new"],
    });
  });

  // Making a connection can open a browser, and this read comes from the door's poll and not from anyone's call, so a
  // 401 is answered only through a connection the bridge holds. Here a tool call's 401 has just retired it while the
  // seat is still listed: its long poll is hung and has not noticed, as a member on the bus, which has none, would not.
  it("makes no connection to refresh a sign-in: with none held, a 401 is reported as it was", async () => {
    let connects = 0;
    const { seen, fetchImpl } = serving(() => new Response(null, { status: 401 }));
    const armed = await armedBridge({ sync: "hangs", upload: uploadTo(fetchImpl), onConnect: () => connects++ });
    await until(() => armed.syncs > 0);
    await armed.client.callTool({ name: "bellman_audit", arguments: {} }).catch(() => undefined);
    expect(await armed.bridge.readEvents(S)).toEqual({ status: 401, body: { error: "upstream" } });
    expect({ connects, requests: seen.length }).toEqual({ connects: 1, requests: 1 });
  });

  it("does not ask again after a 401 when the bearer is the one just refused", async () => {
    const { seen, fetchImpl } = serving(() => new Response(null, { status: 401 }));
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S)).toEqual({ status: 401, body: { error: "upstream" } });
    expect(seen).toHaveLength(1);
  });

  it.each([403, 404, 500])("reports the server's %i as upstream, with its status", async (status) => {
    const { fetchImpl } = serving(() => new Response("no", { status }));
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S)).toEqual({ status, body: { error: "upstream" } });
  });

  it("reports a server it cannot reach as upstream, and does not throw", async () => {
    const { bridge } = await armedBridge({
      sync: [],
      upload: uploadTo(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    });
    expect(await bridge.readEvents(S)).toEqual({ status: 502, body: { error: "upstream" } });
  });

  it("reports an upload target it cannot build a URL from as upstream, and does not throw", async () => {
    const { fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: { ...uploadTo(fetchImpl), serverUrl: "not a url" } });
    expect(await bridge.readEvents(S)).toEqual({ status: 502, body: { error: "upstream" } });
  });
});
