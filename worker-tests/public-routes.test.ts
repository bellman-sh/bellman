/**
 * The Worker serves the public reads and the unpublish (public rooms spec D2, D3) over
 * the real SessionDO: a request with no credential reads a public room, the creator's
 * bearer makes it private through the room routes, and the read is then the 404 a
 * private room gets. Reached as room-routes.test.ts reaches the Worker, with the key
 * vitest.config.ts binds (`qk_ws_test`, u_jesse, the fixture room's creator).
 *
 * The byline and the handle page (bylines spec D4, D5) are read the same way, and over the
 * real RegistryDO too: a signed room is on its handle's page, and leaves it with its publicity.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import worker from "../src/worker.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ROOM = "qs_worker_public";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("public rooms through the Worker", () => {
  it("reads a public room with no credential, and once its creator makes it private, answers the 404 a private room gets", async () => {
    await new DurableObjectStore(env as never).createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member()] }));
    const open = await call(`/public/rooms/${ROOM}`);
    expect(open.status, await open.clone().text()).toBe(200);
    expect(open.headers.get("access-control-allow-origin")).toBe("*");

    const made = await call(`/rooms/${ROOM}/unpublish`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
    expect(made.status, await made.clone().text()).toBe(204);

    expect((await call(`/public/rooms/${ROOM}`)).status).toBe(404);
  });

  it("reads a public room by its name through the registry's index", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member()], publicName: "worker-room" }));
    expect(await store.claimPublicName("worker-room", { id: ROOM, at: Date.now() }, null)).toBe(true);
    const byName = await call("/public/rooms/worker-room");
    expect(byName.status, await byName.clone().text()).toBe(200);
    expect((await call("/public/rooms/no-such-name")).status).toBe(404);
  });
});

describe("a handle's page through the Worker (bylines spec D4, D5)", () => {
  const auth = { authorization: `Bearer ${KEY}` };

  it("lists a signed public room from the real registry and session objects, names its creator on the room's own read, and drops it once it is private", async () => {
    await new DurableObjectStore(env as never).createSession(session({
      id: ROOM, manifest: roomManifest({ public: true, room: "Open review", purpose: "Read along" }), members: [member()],
    }));
    const claimed = await call("/account/handle", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ handle: "ws-jesse" }),
    });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const signed = await call(`/rooms/${ROOM}/byline`, { method: "PUT", headers: auth });
    expect(signed.status, await signed.clone().text()).toBe(200);

    // No credential, and the handle in another case.
    const page = await call("/public/handles/WS-Jesse");
    expect(page.status, await page.clone().text()).toBe(200);
    expect(await page.json()).toMatchObject({
      handle: "ws-jesse",
      rooms: [{
        id: ROOM,
        public_url: `https://dash.bellman.sh/r/${ROOM}`,
        text: { trust: "untrusted", origin: { label: "@ws-jesse" }, data: { room: "Open review", purpose: "Read along" } },
      }],
    });
    expect(await (await call(`/public/rooms/${ROOM}`)).json()).toMatchObject({ by: { handle: "ws-jesse", as: "member 1" } });

    const made = await call(`/rooms/${ROOM}/unpublish`, { method: "POST", headers: auth });
    expect(made.status, await made.clone().text()).toBe(204);
    expect(await (await call("/public/handles/ws-jesse")).json()).toEqual({ handle: "ws-jesse", rooms: [] });
  });

  it("answers a handle that cannot exist with the handle 404, a 3,000-character segment included", async () => {
    // Without the grammar check this is a 404 too: this workerd's registry takes a key of any length and finds nothing.
    // So this pins the answer over the real registry (never a 500); the check itself, which keeps these segments from
    // reaching the registry at all, is pinned against a spy in tests/http-bylines.test.ts.
    for (const segment of ["a".repeat(3_000), "jesse-", "9lives"]) {
      const res = await call(`/public/handles/${segment}`);
      expect([res.status, await res.json()], segment.slice(0, 12)).toEqual([404, { error: "not_found", error_description: "no such handle" }]);
    }
  });
});
