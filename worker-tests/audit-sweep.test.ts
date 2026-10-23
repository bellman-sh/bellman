/**
 * Retention inside a real AuditDO (ADR 0033, D2): setting a window arms the object's own alarm,
 * the alarm runs the sweep and re-dates itself a day ahead, and clearing the window disarms it.
 */
import { afterEach, expect, it } from "vitest";
import { env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type AuditDO } from "../src/store-do.js";
import { SWEEP_EVERY_MS } from "../src/audit-sink.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const store = () => new DurableObjectStore(env as never);
const stub = () => env.AUDIT.get(env.AUDIT.idFromName("org_a"));
const by = { actorUserId: "u_admin", actorOrgId: "org_a" };
const alarm = () => runInDurableObject(stub(), (_i: AuditDO, ctx) => ctx.storage.getAlarm());
const dueSweep = () => runInDurableObject(stub(), (_i: AuditDO, ctx) => ctx.storage.kv.get<number>("due:sweep") ?? null);

/**
 * The harness fires a due alarm on its own, so the sweep armed for "now" may have run before the
 * test looks: `runDurableObjectAlarm` fires it if it has not, and the assertions are on what the
 * sweep leaves, whichever of the two ran it.
 */
it("sweeps when the window is set, re-dates the sweep a day ahead, and disarms when the window is cleared", async () => {
  const s = store();
  const old = Date.now() - 40 * 86_400_000;
  for (const at of [old, old + 1, Date.now()]) await s.appendAudit({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });
  const setAt = Date.now();
  await s.setAuditRetention("org_a", 30, by);
  await runDurableObjectAlarm(stub());
  const due = (await dueSweep())!;
  expect(due).toBeGreaterThanOrEqual(setAt + SWEEP_EVERY_MS);
  expect(await alarm()).toBe(due);
  const rows = await s.auditForOrg("org_a", 10);
  expect(rows.map((r) => r.action)).toEqual(["sent_message", "audit_retention_set", "audit_swept"]);
  expect(rows[2]).toMatchObject({ orgId: "org_a", actorUserId: "system", detail: { through_seq: 2, count: 2 } });
  expect(await s.verifyAudit("org_a")).toMatchObject({ ok: true, from_seq: 3, through_seq: 5, anchor: { seq: 2 } });
  await s.setAuditRetention("org_a", null, by);
  expect(await alarm()).toBeNull();
  expect(await dueSweep()).toBeNull();
});
