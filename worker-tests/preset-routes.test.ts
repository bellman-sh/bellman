/**
 * The Worker mounts the preset routes over the real registry (designer spec D5).
 * The routes' rules are pinned in tests/http-presets.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import type { SavedPreset } from "../src/types.js";

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
    expect(((await list.json()) as { builtin: unknown[] }).builtin).toHaveLength(3);
    const body = { mode: "pair", roles: { lead: { can: ["send"] } }, default_role: "lead", creator_role: "lead" };
    const saved = await call("/presets/solo_lead", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const mine = ((await (await call("/presets", { headers: auth })).json()) as { mine: { name: string }[] }).mine;
    expect(mine.map((p) => p.name)).toEqual(["solo_lead"]);
  });
});

// Housekeeping (#66), integration ruling M1. The registry keeps a row for as long as its owner
// does, so a preset saved before the field existed has no such key. Both reads give it the
// saved-preset form the type promises, which is what the routes serve and bellman_start cites.
describe("a preset saved before housekeeping existed", () => {
  const legacy = (): Partial<SavedPreset> => ({
    name: "old_review",
    description: null,
    mode: "pair",
    heartbeat_on: "5m",
    roles: { lead: { can: ["send"], description: null, reports: false } },
    default_role: "lead",
    creator_role: "lead",
    updated_at: "2026-10-09T12:00:00.000Z",
  });

  it("reads as one that sets none, by get and by list, and keeps what else it holds", async () => {
    const store = new DurableObjectStore(env as never);
    await store.putPreset("u_old", legacy() as SavedPreset, 20);
    expect(await store.getPreset("u_old", "old_review")).toEqual({ ...legacy(), housekeeping: null });
    expect(await store.listPresets("u_old")).toEqual([{ ...legacy(), housekeeping: null }]);
  });

  it("keeps a block a row does hold", async () => {
    const store = new DurableObjectStore(env as never);
    await store.putPreset("u_new", { ...legacy(), housekeeping: { quiet_after: "2h" } } as SavedPreset, 20);
    expect((await store.getPreset("u_new", "old_review"))!.housekeeping).toEqual({ quiet_after: "2h" });
    expect((await store.listPresets("u_new")).map((p) => p.housekeeping)).toEqual([{ quiet_after: "2h" }]);
  });
});
