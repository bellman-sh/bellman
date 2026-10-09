/**
 * Where BELLMAN_HOSTED_SEAT reaches the Workers: the entry's `/mcp`, which builds the server
 * `bellman_start` runs in, and `HostDO`, whose driver runs the wakes. `hostedSeatOn` is
 * tested on its own (tests/host.test.ts); what these pin is that each of the two reads the
 * var off its env, so a deploy that leaves it unset ships with the seat off. The var comes
 * from wrangler.toml, whose value is read by `wrangler deploy --dry-run`, not here.
 *
 * EXCLUDED FROM `npm run typecheck`, as tests/worker-ws.test.ts is, and for the same reason:
 * it imports Workers files. Vitest is unaffected; the vi.mock lets it load them.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { brief } from "./helpers/fixtures.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
}));

afterEach(() => vi.restoreAllMocks());

const REFUSAL = "hosted seats are not available yet";

describe("the Worker's /mcp", () => {
  const KEYS = JSON.stringify({ qk_test_max: { userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" } });

  /** `bellman_start` for the social preset, as a max caller, through the entry; the text of the tool's answer. */
  async function startSocial(env: Record<string, unknown>): Promise<string> {
    const worker = (await import("../src/worker.js")).default;
    const bound = {
      BELLMAN_KEYS: KEYS,
      SESSION: { idFromName: (n: string) => n, get: () => ({}) },
      REGISTRY: { idFromName: (n: string) => n, get: () => ({}) },
      ...env,
    } as never;
    const res = await worker.fetch(new Request("https://b/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer qk_test_max" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "bellman_start", arguments: { manifest: { room: "the square", preset: "social" }, brief: brief() } },
      }),
    }), bound);
    return res.text();
  }

  it("refuses a hosted room when the var is not set", async () => {
    expect(await startSocial({})).toContain(REFUSAL);
  });

  // Past the refusal this fake registry fails the call somewhere else, so what the answer
  // lacks is the refusal: the var reached the tool as "on".
  it("does not refuse a hosted room when the var is \"on\"", async () => {
    expect(await startSocial({ BELLMAN_HOSTED_SEAT: "on" })).not.toContain(REFUSAL);
  });

  it("refuses it again for a value that is not \"on\", a typo included", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await startSocial({ BELLMAN_HOSTED_SEAT: "yes" })).toContain(REFUSAL);
  });
});

describe("HostDO", () => {
  /** A HostDO over an in-memory storage and a room whose reads are recorded; `getSession` answers no room. */
  async function seatOver(env: Record<string, unknown>) {
    const { HostDO } = await import("../src/host-do.js");
    const kv = new Map<string, unknown>();
    let alarmAt: number | null = null;
    const reads: string[] = [];
    const ctx = {
      storage: {
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => { kv.set(key, value); },
        getAlarm: async () => alarmAt,
        setAlarm: async (at: number) => { alarmAt = at; },
        deleteAll: async () => { kv.clear(); },
        deleteAlarm: async () => { alarmAt = null; },
      },
    };
    const room = { getSession: async () => { reads.push("getSession"); return undefined; } };
    const bound = { SESSION: { idFromName: (n: string) => n, get: () => room }, ...env };
    return { seat: new HostDO(ctx as never, bound as never), reads };
  }
  const wake = { sessionId: "qs_1", cause: "tick" as const, cursor: 1 };

  it("settles a queued wake without reading the room when the var is not set", async () => {
    const { seat, reads } = await seatOver({});
    await seat.wake(wake, "row_1");
    await seat.alarm();
    expect(reads).toEqual([]);
  });

  // The control: the same wake, the same alarm, with the var on, goes as far as the room.
  it("reads the room for the same wake when the var is \"on\"", async () => {
    const { seat, reads } = await seatOver({ BELLMAN_HOSTED_SEAT: "on" });
    await seat.wake(wake, "row_1");
    await seat.alarm();
    expect(reads).toEqual(["getSession"]);
  });
});
