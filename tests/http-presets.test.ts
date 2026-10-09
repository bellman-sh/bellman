/**
 * The saved-preset routes (designer spec D5), driven as both servers drive them:
 * a Request in, a Response out, over a MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MAX_PRESET_BYTES, presetRoutes, type PresetRouteDeps } from "../src/http/presets.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MAX_PRESETS } from "../src/presets.js";
import { MemoryStore } from "../src/store.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

let store: MemoryStore;
let deps: PresetRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value. The room routes' tests use the same. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(() => {
  store = new MemoryStore();
  deps = { store, caller, panelOrigins: [PANEL] };
});

interface CallOptions { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; cookie?: string }

function call(key: string | null, path: string, over: CallOptions = {}) {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  let body: string | undefined;
  if (over.rawBody !== undefined) body = over.rawBody;
  else if (over.body !== undefined) body = JSON.stringify(over.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return presetRoutes(new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers, body }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

const preset = (over: Record<string, unknown> = {}) => ({
  description: "Review where the reviewer may ask too",
  mode: "pair",
  roles: {
    author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work." },
    reviewer: { can: ["send", "request_actions", "respond_actions"] },
  },
  default_role: "reviewer",
  creator_role: "author",
  ...over,
});

const put = (key: string, name: string, body: unknown = preset()) => call(key, `/presets/${name}`, { method: "PUT", body });

describe("the preset routes", () => {
  it("leave a path outside /presets to the next module", async () => {
    expect(await call(DEV_KEY.jesse, "/rooms")).toBeUndefined();
  });

  it("refuse without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/presets", { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("list the four built-ins expanded, and the caller's own presets and nobody else's", async () => {
    let body = await bodyOf(await call(DEV_KEY.jesse, "/presets"));
    expect((body.builtin as { name: string }[]).map((p) => p.name)).toEqual(["pair", "swarm", "review", "social"]);
    expect(body.mine).toEqual([]);
    expect((await put(DEV_KEY.jesse, "my_review"))!.status).toBe(200);
    body = await bodyOf(await call(DEV_KEY.jesse, "/presets"));
    expect((body.mine as { name: string }[]).map((p) => p.name)).toEqual(["my_review"]);
    expect((await bodyOf(await call(DEV_KEY.peer, "/presets"))).mine).toEqual([]);
  });

  it("save a preset and answer with it as stored", async () => {
    const res = (await put(DEV_KEY.jesse, "my_review"))!;
    expect(res.status).toBe(200);
    const saved = await bodyOf(res);
    expect(saved).toMatchObject({ name: "my_review", mode: "pair", heartbeat_on: null, default_role: "reviewer", creator_role: "author" });
    expect(saved.roles).toEqual({
      author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: false, report: null },
      reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false, report: null },
    });
    expect(typeof saved.updated_at).toBe("string");
    expect(await store.getPreset("u_jesse", "my_review")).toEqual(saved);
  });

  it("refuse what the room validator refuses, in its words", async () => {
    const res = (await put(DEV_KEY.jesse, "my_review", preset({ creator_role: "boss" })))!;
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({
      error: "invalid_manifest",
      error_description: 'creator_role "boss" is not defined in roles (defined: author, reviewer)',
    });
  });

  it("refuse a name outside the grammar, a built-in's name, and a body naming another preset", async () => {
    expect((await put(DEV_KEY.jesse, "My-Review"))!.status).toBe(400);
    const builtin = (await put(DEV_KEY.jesse, "review"))!;
    expect(builtin.status).toBe(409);
    expect(await bodyOf(builtin)).toMatchObject({ error: "builtin" });
    expect((await put(DEV_KEY.jesse, "my_review", preset({ name: "other" })))!.status).toBe(400);
  });

  it("refuse a new name past the cap, and still replace one already saved", async () => {
    for (let i = 0; i < MAX_PRESETS; i++) expect((await put(DEV_KEY.jesse, `p${i}`))!.status).toBe(200);
    const full = (await put(DEV_KEY.jesse, "one_more"))!;
    expect(full.status).toBe(409);
    expect(await bodyOf(full)).toMatchObject({ error: "full" });
    expect((await put(DEV_KEY.jesse, "p0", preset({ description: "again" })))!.status).toBe(200);
  });

  it("refuse a cookie write without the panel's Origin, and take one with it", async () => {
    const bare = (await call(null, "/presets/my_review", { method: "PUT", body: preset(), cookie: DEV_KEY.jesse }))!;
    expect(bare.status).toBe(403);
    const fromPanel = (await call(null, "/presets/my_review", { method: "PUT", body: preset(), cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(fromPanel.status).toBe(200);
    expect(fromPanel.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("refuse a body over the bound before reading it, and a body that is not a JSON object", async () => {
    const over = (await call(DEV_KEY.jesse, "/presets/my_review", {
      method: "PUT", rawBody: "not json", headers: { "content-length": String(MAX_PRESET_BYTES + 1) },
    }))!;
    expect(over.status).toBe(413);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "PUT", rawBody: "not json" }))!.status).toBe(400);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "PUT", body: ["a"] }))!.status).toBe(400);
  });

  it("delete the caller's own, and answer 404 for one they do not have, another person's included", async () => {
    await put(DEV_KEY.jesse, "my_review");
    expect((await call(DEV_KEY.peer, "/presets/my_review", { method: "DELETE" }))!.status).toBe(404);
    expect(await store.getPreset("u_jesse", "my_review")).toBeDefined();
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "DELETE" }))!.status).toBe(204);
    expect((await call(DEV_KEY.jesse, "/presets/my_review", { method: "DELETE" }))!.status).toBe(404);
  });

  /**
   * `social` became a built-in after saved presets shipped, so a person may hold a preset
   * saved under it. It is refused as every built-in's name is from now on, still listed
   * among theirs, and still theirs to delete.
   */
  it("refuse social as a built-in's name, and still list and delete one saved under it before", async () => {
    const refused = (await put(DEV_KEY.jesse, "social"))!;
    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toMatchObject({ error: "builtin" });
    // As one saved before this merge was stored: no `host` key.
    await store.putPreset("u_jesse", {
      name: "social", description: null, mode: "pair", heartbeat_on: null,
      roles: { solo: { can: ["send"], description: null, reports: false } },
      default_role: "solo", creator_role: "solo", updated_at: "2026-10-09T12:00:00.000Z",
    }, MAX_PRESETS);
    expect(((await bodyOf(await call(DEV_KEY.jesse, "/presets"))).mine as { name: string }[]).map((p) => p.name)).toEqual(["social"]);
    expect((await call(DEV_KEY.jesse, "/presets/social", { method: "DELETE" }))!.status).toBe(204);
    expect(await store.getPreset("u_jesse", "social")).toBeUndefined();
  });

  it("save a host block and answer with it as stored", async () => {
    const res = (await put(DEV_KEY.jesse, "mornings", preset({
      mode: "swarm",
      heartbeat_on: "1h",
      roles: { lead: { can: ["send", "invite"] }, guest: { can: ["send"] }, host: { can: ["send"] } },
      default_role: "guest",
      creator_role: "lead",
      host: { role: "host", model: "sonnet" },
    })))!;
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await bodyOf(res)).host).toEqual({ role: "host", model: "sonnet", instructions: null });
    expect((await store.getPreset("u_jesse", "mornings"))!.host).toEqual({ role: "host", model: "sonnet", instructions: null });
  });

  it("answer 404 to a delete whose name is outside the grammar, without asking the store", async () => {
    deps = { ...deps, store: Object.assign(Object.create(store), {
      deletePreset: async () => { throw new Error("the store was asked"); },
    }) };
    const res = (await call(DEV_KEY.jesse, "/presets/y%3An", { method: "DELETE" }))!;
    expect(res.status).toBe(404);
  });

  it("answer the panel's preflight, and 405 for a method a path does not take", async () => {
    const pre = (await call(null, "/presets/my_review", { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect((await call(DEV_KEY.jesse, "/presets", { method: "POST", body: {} }))!.status).toBe(405);
    expect((await call(DEV_KEY.jesse, "/presets/my_review"))!.status).toBe(405);
  });
});
