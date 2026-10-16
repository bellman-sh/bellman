/**
 * The Worker mounts the audit routes over the real stores (audit trail spec, D7 and D8). The
 * routes' rules are pinned in tests/http-audit.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test"; // team plan, admin, org_codenerd: worker-tests/vitest.config.ts
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${KEY}` } }), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the audit routes through the Worker", () => {
  it("serve the caller's own org's stream from its AuditDO", async () => {
    await new DurableObjectStore(env as never).appendAudit({
      at: 1_000, orgId: "org_codenerd", sessionId: "qs_1", actorUserId: "u_jesse", action: "session_created", detail: {},
    });
    const res = await call("/audit");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      org_id: "org_codenerd", total: 1, through: 1, entries: [{ seq: 1, action: "session_created" }],
    });
  });
});
