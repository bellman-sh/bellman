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

/**
 * A stream moved once and then written to by an older Worker, as a rollback does: that code
 * reads the deleted `seq` counter as 0 and writes `a:000000000001` again, beside rows already
 * in the table. The next deploy must still wake, with those rows appended after the ones it
 * has, not keyed over them.
 */
it("appends the KV rows an older Worker wrote after the move, rather than colliding on their seq", async () => {
  const before = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  await before.append(entry("member_left"));
  await before.append(entry("invite_issued"));
  await runInDurableObject(before, async (_i: AuditDO, ctx) => {
    await ctx.storage.put<unknown>({
      "a:000000000001": entry("rollback_1"), "a:000000000002": entry("rollback_2"),
      seq: 2, "d:intent-r": 2,
    });
  });
  await abortAllDurableObjects();

  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  expect((await stub.recent(10)).map((e) => e.action))
    .toEqual(["member_left", "invite_issued", "rollback_1", "rollback_2"]);
  expect(await seqs(stub)).toEqual([1, 2, 3, 4]);
  expect(await runInDurableObject(stub, (_i: AuditDO, ctx) => [...ctx.storage.kv.list()].map(([key]) => key))).toEqual([]);

  // The older Worker's delivery mark came across too: its intent, redelivered, appends nothing.
  await stub.append(entry("rollback_2"), "intent-r");
  expect(await seqs(stub)).toEqual([1, 2, 3, 4]);
});

/**
 * Into an empty table a row keeps the seq its key carries: a cursor already handed out names
 * that seq, and counting the rows over from 1 would move it onto another row. A gap in the
 * keys is what tells keeping them from counting over.
 */
it("keeps the seq each key carries when the move is into an empty table, gaps included", async () => {
  const before = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  await runInDurableObject(before, async (_i: AuditDO, ctx) => {
    ctx.storage.sql.exec("DROP TABLE entries");
    ctx.storage.sql.exec("DROP TABLE delivered");
    await ctx.storage.put<unknown>({
      "a:000000000002": entry("member_left"), "a:000000000005": entry("invite_issued"), seq: 5,
    });
  });
  await abortAllDurableObjects();

  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  expect(await seqs(stub)).toEqual([2, 5]);
  await stub.append(entry("sent_message"));
  expect(await seqs(stub)).toEqual([2, 5, 6]);
});

/**
 * The move lands whole or not at all, however many batches it reads. One of its INSERTs fails
 * in the second batch, after the first batch's rows went in and their keys were deleted: that
 * wake fails, and the next moves every row once, each with the seq its key carried, and every
 * mark. The keys are even so a move that half landed would show: the rows it kept would leave
 * the table non-empty, and the rest would take fresh seqs instead of their keys'.
 */
it("moves the whole stream or none of it when an insert fails past its first batch", async () => {
  const rows = 1_100; // three batches of rows and three of marks
  const failAt = 700;
  let inserts = 0;
  let unpatch = () => {};
  await runInDurableObject(env.AUDIT.get(env.AUDIT.idFromName("org_old")), (_i: AuditDO, ctx) => {
    ctx.storage.sql.exec("DROP TABLE entries");
    ctx.storage.sql.exec("DROP TABLE delivered");
    for (let n = 1; n <= rows; n++) {
      ctx.storage.kv.put(`a:${String(2 * n).padStart(12, "0")}`, entry(`row_${n}`));
      ctx.storage.kv.put(`d:intent-${n}`, 2 * n);
    }
    ctx.storage.kv.put("seq", 2 * rows);
    // The prototype, since the move runs in the constructor of an object not built yet.
    const proto = Object.getPrototypeOf(ctx.storage.sql) as SqlStorage;
    const exec = proto.exec;
    Object.defineProperty(proto, "exec", {
      configurable: true,
      writable: true,
      value(this: SqlStorage, query: string, ...bindings: SqlStorageValue[]) {
        if (/^\s*INSERT/i.test(query) && ++inserts === failAt) throw new Error("interrupted");
        return exec.call(this, query, ...bindings);
      },
    });
    unpatch = () => Object.defineProperty(proto, "exec", { configurable: true, writable: true, value: exec });
  });
  await abortAllDurableObjects();

  try {
    // Wrapped because an RPC promise is callable, and `.rejects` would call it.
    await expect(Promise.resolve(env.AUDIT.get(env.AUDIT.idFromName("org_old")).recent(1))).rejects.toThrow(/interrupted/);
  } finally {
    unpatch();
  }
  // The hook sat in front of the move's writes. Without this the case proves nothing.
  expect(inserts).toBe(failAt);

  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  expect(await seqs(stub)).toEqual(Array.from({ length: rows }, (_, i) => 2 * (i + 1)));
  expect(await runInDurableObject(stub, (_i: AuditDO, ctx) => ({
    marks: ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM delivered").one().n,
    kv: [...ctx.storage.kv.list()].map(([key]) => key),
  }))).toEqual({ marks: rows, kv: [] });
});

/**
 * A table from before the chain (ADR 0033) has no prev_hash or hash column. The next wake
 * adds them: the rows it held read back unhashed, and the first row appended after them
 * starts the chain from an empty prev_hash.
 */
it("adds the chain columns to a table from before them, leaving its rows unhashed and chaining from the next append", async () => {
  await runInDurableObject(env.AUDIT.get(env.AUDIT.idFromName("org_old")), (_i: AuditDO, ctx) => {
    ctx.storage.sql.exec("DROP TABLE entries");
    ctx.storage.sql.exec(`CREATE TABLE entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, org_id TEXT, session_id TEXT NOT NULL, action TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_label TEXT, actor_org TEXT, room_name TEXT, parties TEXT, crossing TEXT, direction TEXT, detail TEXT NOT NULL)`);
    ctx.storage.sql.exec(
      "INSERT INTO entries (at, org_id, session_id, action, actor_id, detail) VALUES (1000, 'org_old', 'qs_old', 'member_left', 'u_old', '{}')",
    );
  });
  await abortAllDurableObjects();

  const stub = env.AUDIT.get(env.AUDIT.idFromName("org_old"));
  await stub.append(entry("sent_message"));
  const [old, fresh] = (await stub.query({ limit: 10 })).entries.slice().reverse();
  expect([old.action, old.hash, old.prevHash]).toEqual(["member_left", null, null]);
  expect([fresh.action, fresh.prevHash]).toEqual(["sent_message", ""]);
  expect(fresh.hash).toMatch(/^[0-9a-f]{64}$/);
});
