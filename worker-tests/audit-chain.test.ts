/**
 * The hash chain over an org's stream (ADR 0035), inside a real AuditDO: a row edited or
 * deleted in the table behind the store's back is the break `verifyAudit` reports.
 */
import { afterEach, expect, it } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type AuditDO } from "../src/store-do.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const store = () => new DurableObjectStore(env as never);
const stub = () => env.AUDIT.get(env.AUDIT.idFromName("org_a"));

async function three() {
  const s = store();
  for (const at of [1, 2, 3]) await s.appendAudit({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });
  return s;
}

it("an edited row breaks the chain at its own seq", async () => {
  const s = await three();
  await runInDurableObject(stub(), (_i: AuditDO, ctx) => { ctx.storage.sql.exec("UPDATE entries SET action = 'edited' WHERE seq = 2"); });
  expect(await s.verifyAudit("org_a")).toMatchObject({ ok: false, broken_at: 2, checked: 2 });
});

it("a deleted row breaks the chain at the row after it", async () => {
  const s = await three();
  await runInDurableObject(stub(), (_i: AuditDO, ctx) => { ctx.storage.sql.exec("DELETE FROM entries WHERE seq = 2"); });
  expect(await s.verifyAudit("org_a")).toMatchObject({ ok: false, broken_at: 3 });
});

it("a room name that is not well-formed UTF-16 still verifies: the row is hashed as SQLite stores it", async () => {
  const s = store();
  await s.appendAudit({ at: 1, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", actorLabel: "\ud800x", roomName: "\udc00y", parties: [], crossing: "internal", direction: "outbound", action: "sent_message", detail: {} });
  await s.appendAudit({ at: 2, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: {} });
  expect(await s.verifyAudit("org_a")).toMatchObject({ ok: true, checked: 2 });
});
