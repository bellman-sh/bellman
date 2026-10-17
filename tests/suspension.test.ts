import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import { SUSPENDED, SUSPENSION_CACHE_MS, SuspensionCache } from "../src/suspension.js";
import { DEV_KEY } from "./helpers/harness.js";

describe("the suspension cache (spec D4)", () => {
  it("reads an account at most once a minute, and again after", async () => {
    const read = vi.fn(async () => false);
    const cache = new SuspensionCache();
    expect(await cache.check("u_a", read, 0)).toBe(false);
    read.mockResolvedValue(true);
    expect(await cache.check("u_a", read, SUSPENSION_CACHE_MS - 1)).toBe(false);
    expect(await cache.check("u_a", read, SUSPENSION_CACHE_MS)).toBe(true);
    expect(await cache.check("u_b", read, 1)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("forgets everything past its bound rather than growing", async () => {
    const read = vi.fn(async () => false);
    const cache = new SuspensionCache(SUSPENSION_CACHE_MS, 2);
    for (const id of ["u_a", "u_b", "u_c", "u_a"]) await cache.check(id, read, 0);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("a suspended account on the Node server (spec \u{A7}1, R8)", () => {
  it("is refused at /mcp and at the room routes with the one message, and another account is served", async () => {
    const store = new MemoryStore();
    await store.suspend("u_peer", { note: "test", by: "u_operator", at: 0 });
    const app = createApp(store, new MemoryBlobStore(), { hostedSeat: false });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_KEY.peer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(403);
      expect(await mcp.json()).toMatchObject({ error: { message: SUSPENDED } });
      const rooms = await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${DEV_KEY.peer}` } });
      expect([rooms.status, await rooms.json()]).toEqual([403, { error: "suspended", error_description: SUSPENDED }]);
      expect((await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } })).status, "the control").toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // R8's other paths on this server, a case each. /ws is the Worker's alone.
  for (const path of ["/presets", "/account/handle", "/account/bans"]) {
    it(`is refused at ${path} with the one message, and another account is served`, async () => {
      const store = new MemoryStore();
      await store.suspend("u_peer", { note: "test", by: "u_operator", at: 0 });
      await withServer(store, async (base) => {
        const refused = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${DEV_KEY.peer}` } });
        expect([refused.status, await refused.json()]).toEqual([403, { error: "suspended", error_description: SUSPENDED }]);
        expect((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } })).status, "the control").toBe(200);
      });
    });
  }

  // /operator/stats reads the store as its caller, so R8 gates it too. This server lists no operators, so the route
  // refuses every caller itself: the control is that refusal, which a suspended account must not reach.
  it("is refused at /operator/stats with the one message, ahead of the route's own refusal", async () => {
    const store = new MemoryStore();
    await store.suspend("u_peer", { note: "test", by: "u_operator", at: 0 });
    await withServer(store, async (base) => {
      const refused = await fetch(`${base}/operator/stats`, { headers: { authorization: `Bearer ${DEV_KEY.peer}` } });
      expect([refused.status, await refused.json()]).toEqual([403, { error: "suspended", error_description: SUSPENDED }]);
      const control = await fetch(`${base}/operator/stats`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } });
      expect([control.status, ((await control.json()) as { error: string }).error], "the control").toEqual([403, "not_available"]);
    });
  });
});

/** The real app on an ephemeral port, handed to `use` and closed after. */
async function withServer(store: MemoryStore, use: (base: string) => Promise<void>): Promise<void> {
  const app = createApp(store, new MemoryBlobStore(), { hostedSeat: false });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
