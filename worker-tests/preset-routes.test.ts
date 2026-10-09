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

// Housekeeping (#66). The registry keeps a row for as long as its owner does, so a preset saved
// before the field existed has no such key. Both reads hand it back as it was written, as they do a
// row saved before hosted seats reached the presets and has no `host`: the key is optional, and an
// absent one is read as none where it is used (`asManifest`), not invented here.
describe("a preset saved before housekeeping existed", () => {
  // In the words it was saved in, before the heartbeat's vocabulary changed: read in the new ones.
  const legacy = (): SavedPreset => ({
    name: "old_review",
    description: null,
    mode: "pair",
    heartbeat_on: "5m",
    roles: { lead: { can: ["send"], description: null, reports: false } },
    default_role: "lead",
    creator_role: "lead",
    updated_at: "2026-10-09T12:00:00.000Z",
  }) as unknown as SavedPreset;

  it("reads in the heartbeat's new words, by get and by list, with no housekeeping key invented for it", async () => {
    const store = new DurableObjectStore(env as never);
    await store.putPreset("u_old", legacy(), 20);
    const { heartbeat_on: _old, ...rest } = legacy() as unknown as Record<string, unknown>;
    const now = { ...rest, heartbeat: "5m", roles: { lead: { can: ["send"], description: null, heartbeat_on: false } } };
    expect(await store.getPreset("u_old", "old_review")).toEqual(now);
    expect(await store.listPresets("u_old")).toEqual([now]);
  });

  it("keeps a block a row does hold", async () => {
    const store = new DurableObjectStore(env as never);
    await store.putPreset("u_new", { ...legacy(), housekeeping: { quiet_after: "2h" } }, 20);
    expect((await store.getPreset("u_new", "old_review"))!.housekeeping).toEqual({ quiet_after: "2h" });
    expect((await store.listPresets("u_new")).map((p) => p.housekeeping)).toEqual([{ quiet_after: "2h" }]);
  });
});
