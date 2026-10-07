/**
 * The Worker's dispatch for the room routes (#184): `/rooms` with no trailing
 * slash must reach src/http/rooms.ts, which the blob routes' prefix test did
 * not admit. One request through the real fetch handler proves the condition.
 *
 * Reached the way blobs-route.test.ts reaches the Worker: `worker.fetch` with the
 * pool's `env`, and the key vitest.config.ts binds (`qk_ws_test`, u_jesse). The
 * isolate is fresh, so that identity has made no room and the list is empty.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

describe("GET /rooms through the Worker", () => {
  it("reaches the room routes module with no trailing slash", async () => {
    const res = await call("/rooms", { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ rooms: [] });
  });
});
