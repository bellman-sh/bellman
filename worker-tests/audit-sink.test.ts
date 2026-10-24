/**
 * The sink inside a real AuditDO (ADR 0035, D3): setting one and appending arms the object's own
 * alarm, the alarm posts one signed batch, and a refusal backs the next attempt off.
 */
import { afterEach, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type AuditDO } from "../src/store-do.js";
import { SINK_DEAD_AFTER_MS, SINK_DELAY_MS } from "../src/audit-sink.js";
import { backoffMs } from "../src/outbox.js";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
  await abortAllDurableObjects();
});

const store = () => new DurableObjectStore(env as never);
const stub = () => env.AUDIT.get(env.AUDIT.idFromName("org_a"));
const by = { actorUserId: "u_admin", actorOrgId: "org_a" };
const url = "https://collector.example/in";
const dueSink = () => runInDurableObject(stub(), (_i: AuditDO, ctx) => ctx.storage.kv.get<number>("due:sink") ?? null);
const alarm = () => runInDurableObject(stub(), (_i: AuditDO, ctx) => ctx.storage.getAlarm());

/** The alarm runs what is due at `Date.now()`, so the clock is stepped to the sink's date before it fires. */
const fire = async () => {
  const due = (await dueSink())!;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(due);
  await runDurableObjectAlarm(stub());
  vi.useRealTimers();
};

/** `fetch`, answering `status` and keeping every request. */
function collector(status: number) {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    posts.push({ url: String(input), headers: init?.headers as Record<string, string>, body: init?.body as string });
    return new Response(null, { status });
  });
  return posts;
}

it("arms the alarm when a row lands, posts one signed batch, and leaves nothing pending", async () => {
  const posts = collector(200);
  const s = store();
  const before = Date.now();
  await s.setAuditSink("org_a", url, by);
  await s.appendAudit({ at: before, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: {} });
  const due = (await dueSink())!;
  expect(due).toBeGreaterThanOrEqual(before + SINK_DELAY_MS);
  expect(await alarm()).toBe(due);
  await fire();
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toBe(url);
  expect(posts[0].headers["Content-Type"]).toBe("application/json");
  expect(posts[0].headers["Bellman-Delivery"]).toBe("org_a:1-2");
  expect(posts[0].headers["Bellman-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  expect(JSON.parse(posts[0].body)).toMatchObject({ org_id: "org_a", delivery: "org_a:1-2" });
  expect((await s.auditSettings("org_a")).sink).toMatchObject({ status: "ok", delivered_through: 2, pending: 0 });
  expect(await dueSink()).toBeNull();
});

it("drops the outcome of a post that finished after the sink was removed", async () => {
  const s = store();
  let during: (() => Promise<unknown>) | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { await during?.(); return new Response(null, { status: 200 }); });
  await s.setAuditSink("org_a", url, by);
  during = () => s.removeAuditSink("org_a", by);
  await fire();
  expect((await s.auditSettings("org_a")).sink).toBeNull();
  expect(await dueSink()).toBeNull();
  expect(await alarm()).toBeNull();
});

it("backs off after a refusal and keeps the cursor", async () => {
  collector(503);
  const s = store();
  await s.setAuditSink("org_a", url, by);
  const before = (await dueSink())!;
  await fire();
  expect((await s.auditSettings("org_a")).sink).toMatchObject({ status: "failing", attempts: 1, delivered_through: 0, pending: 1, last_error: "503" });
  const due = (await dueSink())!;
  expect(due).toBeGreaterThanOrEqual(before + backoffMs(1));
  expect(await alarm()).toBe(due);
  expect(await s.removeAuditSink("org_a", by)).toBe(true);
  expect(await dueSink()).toBeNull();
  expect(await alarm()).toBeNull();
});

it("a dead sink posts nothing when pumped, keeps its status, and arms nothing", async () => {
  const posts = collector(503);
  const s = store();
  await s.setAuditSink("org_a", url, by);
  await s.appendAudit({ at: Date.now(), orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: {} });
  await fire();
  const retry = (await dueSink())!;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(retry + SINK_DEAD_AFTER_MS);
  await runDurableObjectAlarm(stub());
  vi.useRealTimers();
  expect(posts).toHaveLength(2);
  expect((await s.auditSettings("org_a")).sink).toMatchObject({ status: "dead", attempts: 2 });
  expect(await dueSink()).toBeNull();
  await s.appendAudit({ at: Date.now(), orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: {} });
  expect(await dueSink()).toBeNull();
  expect(await s.pumpAuditSink("org_a", Date.now())).toMatchObject({ status: "dead", attempts: 2, last_error: "503", delivered_through: 0, pending: 4 });
  expect(posts).toHaveLength(2);
  expect(await dueSink()).toBeNull();
  expect(await alarm()).toBeNull();
});
