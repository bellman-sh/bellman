/**
 * The registry's `report_purge` handler (R15), seen from storage. The contract suite (store-contract.test.ts)
 * reads what the store answers: a report is gone 180 days after it is resolved. It cannot see what that answer
 * hides, and these are the parts that go wrong without any answer changing:
 *
 * - The alarm. `resolveReport` points it at the date, or the report waits for an alarm nothing armed. The suite
 *   runs the alarm by hand, so it would pass without one.
 * - The due row. `report_purge` stays due until the handler moves it to the next date or deletes it, and a name
 *   left due past `now` makes the alarm fire back to back for good.
 * - The rows. A purge that leaves a report's creator row or its dated row behind leaks one of each, and
 *   `roomReports` skips a row whose report is gone, so no answer shows it.
 * - The size of a firing. A storage call reads and deletes at most 128 keys, and a purge of 43 reports at once
 *   is more than that.
 *
 * Reports are resolved at the real time, so a date 180 days ahead is one the pool never fires by itself, and the
 * clock is then moved to the date and the alarm run by hand, as the contract suite does.
 */
import { afterEach, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type RegistryDO } from "../src/store-do.js";
import { dueKey } from "../src/outbox.js";
import { REPORT_PURGE_HANDLER, REPORT_RETENTION_MS, type NewReport } from "../src/reports.js";

// The clock is real again before the Durable Objects are reset: those are real RPCs and would not settle under a fake one.
afterEach(async () => {
  vi.useRealTimers();
  await reset();
  await abortAllDurableObjects();
});

const DAY = 24 * 60 * 60 * 1000;
const DUE = dueKey(REPORT_PURGE_HANDLER);
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

/** A new report of a member by `u_reader`: the contract suite's, so the two files file the same thing. */
const filed = (over: Partial<NewReport> = {}): NewReport => ({
  sessionId: "qs_test", creatorId: "u_jesse",
  target: { kind: "member", memberId: "m_peer" },
  subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
  reason: "harassment", note: "called names", reporterUserId: "u_reader", reporterLabel: "reader@x", ...over,
});

async function file(store: DurableObjectStore, over: Partial<NewReport> = {}) {
  const answer = await store.fileReport(filed(over), Date.now());
  if (answer.outcome !== "filed") throw new Error(`expected a new report, got ${answer.outcome}`);
  return answer.report;
}

const note = { note: "warned", by: "u_operator" };

/** The clock at `at`, and the registry's alarm run by hand: what the runtime does when the date comes. */
async function alarmAt(at: number): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  await runInDurableObject(registry(), (instance: RegistryDO) => instance.alarm());
}

it("arms the registry's alarm for the day a resolved report goes, and a later resolution leaves it there", async () => {
  const store = new DurableObjectStore(env as never);
  const first = await file(store);
  const second = await file(store, { target: { kind: "message", cursor: 2 } });
  const at = Date.now();
  await store.resolveReport(first.id, note, at);
  expect(await runInDurableObject(registry(), (_i: RegistryDO, ctx) => ctx.storage.getAlarm())).toBe(at + REPORT_RETENTION_MS);
  await store.resolveReport(second.id, note, at + 10 * DAY);
  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    expect(await ctx.storage.getAlarm(), "a later report leaves the alarm at the earlier date").toBe(at + REPORT_RETENTION_MS);
    expect(await ctx.storage.get(DUE), "and the due row").toBe(at + REPORT_RETENTION_MS);
  });
});

it("leaves nothing of a purged report behind, and moves the due row to the report that is left", async () => {
  const store = new DurableObjectStore(env as never);
  const gone = await file(store);
  const kept = await file(store, { target: { kind: "message", cursor: 2 } });
  const at = Date.now();
  await store.resolveReport(gone.id, note, at);
  await store.resolveReport(kept.id, note, at + DAY);

  await alarmAt(at + REPORT_RETENTION_MS);

  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    const keys = [...(await ctx.storage.list()).keys()];
    expect(keys.filter((k) => k.includes(gone.id)), "no row of the purged report").toEqual([]);
    expect(keys.filter((k) => k.includes(kept.id)).length, "the other report's rows: its report, creator and dated rows").toBe(3);
    expect(await ctx.storage.get(DUE), "the due row names the report that is left").toBe(at + DAY + REPORT_RETENTION_MS);
  });
  expect((await store.listReports(10)).map((r) => r.id)).toEqual([kept.id]);
});

it("deletes the due row once no resolved report is left, so nothing is due for the alarm to fire at", async () => {
  const store = new DurableObjectStore(env as never);
  const gone = await file(store, { target: { kind: "room" }, subject: null });
  const at = Date.now();
  await store.resolveReport(gone.id, note, at);

  await alarmAt(at + REPORT_RETENTION_MS);

  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    expect(await ctx.storage.get(DUE)).toBeUndefined();
    expect([...(await ctx.storage.list({ prefix: "rr:" })).keys()]).toEqual([]);
  });
  expect(await store.listReports(10)).toEqual([]);
});

it("logs a report purge that throws, naming the handler, and rethrows it so the runtime retries", async () => {
  // The runtime retries a throwing alarm a few times and then leaves it unarmed, and says nothing of which handler it
  // gave up on, so the log line is the only record. A report row that lost its target makes the purge throw.
  await runInDurableObject(registry(), async (instance: RegistryDO, ctx) => {
    await ctx.storage.put({ [DUE]: 1, "rr:000000000000001:rpt_broken": "rpt_broken", "rp:rpt_broken": { id: "rpt_broken" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(instance.alarm(), "the alarm still fails, for the runtime to retry").rejects.toThrow(TypeError);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('alarm handler "report_purge" failed for the registry'), expect.any(TypeError));
    } finally {
      logged.mockRestore();
    }
    expect(await ctx.storage.get(DUE), "the purge is still owed: the failed transaction left its due row").toBe(1);
  });
});

/**
 * The most keys one `get`, `put` or `delete` takes, on this object's storage or in a transaction it opens, from now on.
 *
 * Production refuses a call over 128 keys (`KEYS_PER_CALL`). The workerd these tests run in does not: a probe put, read
 * and deleted 200 keys in one call each, inside a transaction and outside one. A purge that sent its keys whole would
 * pass here, so what the limit changes is how wide the calls are, and that is what this reads. As in
 * ban-id-guard.test.ts, which counts storage the same way for the same reason.
 */
function widestCall(ctx: DurableObjectState): () => number {
  let widest = 0;
  const keysIn = (verb: string, first: unknown): number =>
    Array.isArray(first) ? first.length : verb === "put" && typeof first === "object" && first !== null ? Object.keys(first).length : 1;
  const watch = <T extends object>(to: T): T =>
    new Proxy(to, {
      get(target, prop) {
        const member = Reflect.get(target, prop, target) as unknown;
        if (typeof member !== "function") return member;
        if (prop !== "get" && prop !== "put" && prop !== "delete") return member.bind(target);
        return (first: unknown, ...rest: unknown[]) => {
          widest = Math.max(widest, keysIn(prop, first));
          return member.call(target, first, ...rest);
        };
      },
    });
  const real = ctx.storage.transaction.bind(ctx.storage);
  Object.defineProperty(ctx.storage, "transaction", {
    configurable: true,
    value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) => real((txn) => closure(watch(txn))),
  });
  for (const verb of ["get", "put", "delete"] as const) {
    const bound = (ctx.storage[verb] as (...a: unknown[]) => unknown).bind(ctx.storage);
    Object.defineProperty(ctx.storage, verb, {
      configurable: true,
      value: (first: unknown, ...rest: unknown[]) => {
        widest = Math.max(widest, keysIn(verb, first));
        return bound(first, ...rest);
      },
    });
  }
  return () => widest;
}

it("reads and purges more reports than one storage call takes, in calls of 128 keys at most", async () => {
  const store = new DurableObjectStore(env as never);
  const many = 130; // past 128, and a purge deletes three rows a report: 390 keys
  const ids: string[] = [];
  for (let i = 0; i < many; i++) {
    // Each from its own account, which is how this many reports come to one room: an account files 10 a day.
    ids.push((await file(store, { reporterUserId: `u_reader_${i}`, target: { kind: "member", memberId: `m_${i}` } })).id);
  }
  const at = Date.now();
  for (const id of ids) await store.resolveReport(id, note, at);

  await runInDurableObject(registry(), async (instance: RegistryDO, ctx) => {
    const widest = widestCall(ctx);
    expect(await instance.roomReports("u_jesse", "qs_test"), "every report of the room").toHaveLength(many);
    // Exactly 128: no wider, and wide enough that the wrapper is seeing the reads and not nothing.
    expect(widest(), "the read").toBe(128);
  });

  vi.useFakeTimers();
  vi.setSystemTime(at + REPORT_RETENTION_MS);
  await runInDurableObject(registry(), async (instance: RegistryDO, ctx) => {
    const widest = widestCall(ctx);
    await instance.alarm();
    expect(widest(), "the purge").toBe(128);
    expect([...(await ctx.storage.list()).keys()].filter((k) => ids.some((id) => k.includes(id))), "no row left").toEqual([]);
  });
  expect(await store.listReports(many + 1)).toEqual([]);
});
