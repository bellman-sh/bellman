/**
 * The Worker mounts the preset routes over the real registry (designer spec D5).
 * The routes' rules are pinned in tests/http-presets.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the preset routes through the Worker", () => {
  it("list the built-ins, save a preset into the registry, and list it back", async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    const list = await call("/presets", { headers: auth });
    expect(list.status, await list.clone().text()).toBe(200);
    expect(((await list.json()) as { builtin: unknown[] }).builtin).toHaveLength(4);
    const body = { mode: "pair", roles: { lead: { can: ["send"] } }, default_role: "lead", creator_role: "lead" };
    const saved = await call("/presets/solo_lead", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const mine = ((await (await call("/presets", { headers: auth })).json()) as { mine: { name: string }[] }).mine;
    expect(mine.map((p) => p.name)).toEqual(["solo_lead"]);
  });
});
