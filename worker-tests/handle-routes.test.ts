/**
 * The Worker mounts the handle routes over the real registry (bylines spec D6).
 * The routes' rules are pinned in tests/http-bylines.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the handle routes through the Worker", () => {
  it("read, claim, refuse a held one, free the old on a change, release, and refuse the rest", async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    const put = (handle: unknown) =>
      call("/account/handle", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ handle }) });
    const get = async (path = "/account/handle") => {
      const res = await call(path, { headers: auth });
      return { status: res.status, body: await res.json() };
    };
    const registry = new DurableObjectStore(env as never);

    expect(await get()).toEqual({ status: 200, body: { handle: null } });
    const first = await put(" Wire-Do ");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ handle: "wire-do" });
    expect(await get("/account/handle/")).toEqual({ status: 200, body: { handle: "wire-do" } });
    expect(await registry.handleOf("u_jesse")).toBe("wire-do");

    // Another person holds a handle, set straight in the registry: the route refuses it.
    await registry.claimHandle("u_someone_else", "held-by-other");
    const taken = await put("held-by-other");
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "handle_taken" });

    // A change frees the old handle for anyone else.
    expect((await put("wire-do-two")).status).toBe(200);
    expect(await registry.claimHandle("u_someone_else", "wire-do")).toBe("claimed");

    expect((await call("/account/handle", { method: "DELETE", headers: auth })).status).toBe(204);
    expect(await get()).toEqual({ status: 200, body: { handle: null } });
    expect(await registry.userOfHandle("wire-do-two")).toBeUndefined();

    expect((await call("/account/handle")).status).toBe(401);
    expect((await call("/account/handle", { method: "OPTIONS" })).status).toBe(204);
    expect((await call("/account/handle", { method: "POST", headers: auth })).status).toBe(405);
  });
});
