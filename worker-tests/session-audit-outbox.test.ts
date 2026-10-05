import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { SessionDO, AuditDO } from "../src/store-do.js";
import { outboxKey, OUTBOX_SEQ, dueKey, OUTBOX_HANDLER } from "../src/outbox.js";

// Storage is not isolated between tests in this pool (worker-tests/README.md), and
// the first and third cases both file rows under org_codenerd. Without this the
// redelivery case counts the first case's row and fails with a length of 2.
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/**
 * The rows are planted directly rather than earned by an operation. Nothing
 * queues an audit intent until Task 2, and the branch that delivers one is what
 * this task adds — so the drain is driven from storage the way the alarm would
 * find it.
 */
async function plant(id: DurableObjectId, row: Record<string, unknown>): Promise<void> {
  await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
    await ctx.storage.put<unknown>({
      [outboxKey(0)]: row,
      [OUTBOX_SEQ]: 0,
      [dueKey(OUTBOX_HANDLER)]: Date.now(),
    });
  });
}

const entry = (over: Record<string, unknown> = {}) => ({
  at: 1_700_000_000_000,
  orgId: "org_codenerd",
  sessionId: "qs_test",
  actorUserId: "u_jesse",
  action: "member_left",
  detail: {},
  ...over,
});

describe("SessionDO delivers audit intents", () => {
  it("delivers an audit row to the entry's own org", async () => {
    const id = env.SESSION.idFromName("qs_audit_one");
    await plant(id, { id: "intent-one", kind: "audit", payload: entry(), attempts: 0 });

    await runInDurableObject(env.SESSION.get(id), async (instance: SessionDO) => {
      await instance.alarm();
    });

    const auditId = env.AUDIT.idFromName("org_codenerd");
    await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
      const rows = await audit.recent(10);
      expect(rows.map((r) => r.action)).toEqual(["member_left"]);
    });
  });

  /**
   * Review Focus 4. A namespace accepts null as a name, so a falsy org is
   * DELIVERED — into a stream no org reads, or one called "null". The guard is
   * what keeps a misfiled row from looking like a delivered one.
   */
  it("delivers nothing for an entry with no org, and clears the row", async () => {
    const id = env.SESSION.idFromName("qs_audit_none");
    await plant(id, {
      id: "intent-none", kind: "audit", payload: entry({ orgId: null }), attempts: 0,
    });

    await runInDurableObject(env.SESSION.get(id), async (instance: SessionDO) => {
      await instance.alarm();
    });

    for (const name of ["null", "undefined", ""]) {
      const auditId = env.AUDIT.idFromName(name);
      await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
        expect(await audit.recent(10)).toEqual([]);
      });
    }

    // The row is gone: a delivery that is correctly a no-op still counts as
    // delivered, or the queue stalls behind it for good.
    await runInDurableObject(env.SESSION.get(id), async (_do: SessionDO, ctx) => {
      expect(await ctx.storage.get(outboxKey(0))).toBeUndefined();
    });
  });

  it("does not append the same intent twice when it is redelivered", async () => {
    const id = env.SESSION.idFromName("qs_audit_twice");
    const row = { id: "intent-dupe", kind: "audit", payload: entry(), attempts: 0 };

    await plant(id, row);
    await runInDurableObject(env.SESSION.get(id), async (i: SessionDO) => { await i.alarm(); });
    await plant(id, row);
    await runInDurableObject(env.SESSION.get(id), async (i: SessionDO) => { await i.alarm(); });

    const auditId = env.AUDIT.idFromName("org_codenerd");
    await runInDurableObject(env.AUDIT.get(auditId), async (audit: AuditDO) => {
      expect(await audit.recent(10)).toHaveLength(1);
    });
  });
});
