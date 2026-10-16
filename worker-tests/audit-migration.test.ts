/**
 * AuditDO's move from KV rows to its SQL tables (audit trail spec, D5): a stream written in
 * the KV shape wakes into the table with every row's seq and every delivery mark.
 */
import { afterEach, expect, it } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuditDO } from "../src/store-do.js";
import type { AuditEntry } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const entry = (action: string): AuditEntry => ({
  at: 1_000, orgId: "org_old", sessionId: "qs_old", actorUserId: "u_old", action, detail: { n: 1 },
});

/** A stream in the KV shape, in a fresh object's storage, and the object dropped so the next call builds it anew. */
async function legacyStream() {
  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  await runInDurableObject(stub, async (_i: AuditDO, ctx) => {
    ctx.storage.sql.exec("DROP TABLE entries");
    ctx.storage.sql.exec("DROP TABLE delivered");
    await ctx.storage.put<unknown>({
      "a:000000000001": entry("member_left"), "a:000000000002": entry("invite_issued"),
      seq: 2, "d:intent-2": 2,
    });
  });
  await abortAllDurableObjects();
  return env.AUDIT.get(env.AUDIT.idFromName("org_old"));
}

const seqs = (stub: DurableObjectStub<AuditDO>) =>
  runInDurableObject(stub, (_i: AuditDO, ctx) =>
    ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM entries ORDER BY seq").toArray().map((r) => r.seq));

it("moves every row into the table with the seq its key carried, and leaves no KV row behind", async () => {
  const stub = await legacyStream();
  expect(await stub.recent(10)).toEqual([entry("member_left"), entry("invite_issued")]);
  expect(await seqs(stub)).toEqual([1, 2]);
  expect(await runInDurableObject(stub, (_i: AuditDO, ctx) => [...ctx.storage.kv.list()].map(([key]) => key))).toEqual([]);
});

it("keeps the delivery marks, so a redelivered intent appends nothing, and the next row takes the next seq", async () => {
  const stub = await legacyStream();
  await stub.append(entry("invite_issued"), "intent-2");
  await stub.append(entry("sent_message"), "intent-3");
  expect((await stub.recent(10)).map((e) => e.action)).toEqual(["member_left", "invite_issued", "sent_message"]);
  expect(await seqs(stub)).toEqual([1, 2, 3]);
});
