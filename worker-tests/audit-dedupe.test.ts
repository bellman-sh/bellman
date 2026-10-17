import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuditDO } from "../src/store-do.js";
import type { AuditEntry } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const entry = (action: string): AuditEntry => ({
  at: 1_000, orgId: "org_mine", sessionId: "grant:github:4242",
  actorUserId: "stripe", action, detail: { key: "github:4242" },
});

it("applies an entry once however many times it is delivered", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");

  // Exact match, not a count: a length check alone would also pass against an
  // append that silently wrote nothing at all.
  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

it("keeps entries that carry different intent ids", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");

  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});

it("still appends when no intent id is given", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"));
  await audit.append(entry("plan_granted"));

  expect(await audit.recent(10)).toEqual([entry("plan_granted"), entry("plan_granted")]);
});

/**
 * An inline drain racing an alarm hands the same row over twice at once. The look at the
 * marker and the writes are one synchronous transaction, so no second delivery can come
 * between them: eight arriving together land once.
 */
it("applies an entry once when the same delivery arrives eight times at once", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));
  await Promise.all(Array.from({ length: 8 }, () => audit.append(entry("plan_granted"), "intent-1")));
  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

/**
 * A delivery that stops part-way must leave nothing a redelivery mishandles. Fail the Nth
 * INSERT one delivery makes (1 is the row, 2 its marker): the transaction rolls both back,
 * so the redelivery appends the row once, and a later entry lands after it.
 */
it.each([1, 2])("holds each entry once when insert %i of a delivery is interrupted", async (failAt) => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));
  let inserts = 0;
  let failOn = failAt;
  await runInDurableObject(audit, (_i: AuditDO, ctx) => {
    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      configurable: true,
      value: (query: string, ...bindings: SqlStorageValue[]) => {
        if (/^\s*INSERT/i.test(query) && ++inserts === failOn) throw new Error("interrupted");
        return exec(query, ...bindings);
      },
    });
  });

  // Wrapped because an RPC promise is callable, and `.rejects` would call it.
  await expect(Promise.resolve(audit.append(entry("plan_revoked"), "intent-1"))).rejects.toThrow(/interrupted/);
  failOn = 0;
  // The hook sat in front of the delivery's writes. Without this the case proves nothing.
  expect(inserts).toBe(failAt);

  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");
  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});
