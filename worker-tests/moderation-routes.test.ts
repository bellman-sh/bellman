/**
 * The Worker mounts the moderation routes over the real objects (abuse protections spec, section 4). Their rules are
 * pinned in tests/http-moderation.test.ts and tests/http-admin.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test"; // u_jesse, in vitest.config.ts
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}, on = workerEnv) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
}), on, ctx);
const store = () => new DurableObjectStore(env as never);
const seed = () => store().createSession(session({
  id: "qs_wire_mod", manifest: roomManifest({ public: true }),
  members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
}));

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the moderation routes through the Worker", () => {
  it("bans at /rooms/:id/bans, lists the ban, and lifts it at /rooms/:id/bans/:banId, over the real room", async () => {
    await seed();
    const banned = await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    expect(banned.status, await banned.clone().text()).toBe(200);
    const listed = (await (await call("/rooms/qs_wire_mod/bans")).json()) as { bans: { ban_id: string; label: string }[] };
    expect(listed.bans.map((b) => b.label)).toEqual(["peer@codenerd"]);
    expect((await call(`/rooms/qs_wire_mod/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().roomBans("qs_wire_mod")).toEqual([]);
  });

  it("lists a creator's bans at /account/bans from the real registry, and lifts one at /account/bans/:banId", async () => {
    await seed();
    await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    const listed = (await (await call("/account/bans")).json()) as { bans: { ban_id: string; session_id: string }[] };
    expect(listed.bans.map((b) => b.session_id)).toEqual(["qs_wire_mod"]);
    expect((await call(`/account/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().isBannedByCreator("u_jesse", "u_peer")).toBe(false);
  });

  // `/account/bans` has its own copy of the fail-closed call, as `/rooms/` does (worker-tests/blobs-route.test.ts).
  // Without it a deploy with neither a key map nor OAuth answers the route's 401, which reads as a bad key on a
  // deploy that has none.
  it("answers 503 at /account/bans with neither a key map nor OAuth, and the route's own answer once a key map is bound", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bare = { ...env, BELLMAN_KEYS: undefined } as unknown as Parameters<typeof worker.fetch>[1];
      expect((await call("/account/bans", {}, bare)).status).toBe(503);
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining("BELLMAN_KEYS is unset"));
      // The control: the same request with the key map bound reaches the route.
      expect((await call("/account/bans")).status).toBe(200);
    } finally {
      quiet.mockRestore();
    }
  });
});
