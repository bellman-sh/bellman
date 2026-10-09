/**
 * The Worker serves the public reads and the unpublish (public rooms spec D2, D3) over
 * the real SessionDO: a request with no credential reads a public room, the creator's
 * bearer makes it private through the room routes, and the read is then the 404 a
 * private room gets. Reached as room-routes.test.ts reaches the Worker, with the key
 * vitest.config.ts binds (`qk_ws_test`, u_jesse, the fixture room's creator).
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
});
