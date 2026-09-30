import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  DUE_PREFIX, MAX_DRAIN_PASSES, OUTBOX_GRACE_MS, OUTBOX_PREFIX, OUTBOX_SEQ, OutboxDriver,
  backoffMs, drain, dueKey, dueNames, earliestDue, enqueueRows, mergeDue, outboxKey,
  type OutboxRow, type OutboxStorage,
} from "../src/outbox.js";

describe("named alarms", () => {
  /**
   * Storage keys outlive a deploy, so a changed prefix orphans every stored
   * `due:` row. The first expectation is built from DUE_PREFIX and cannot
   * notice a change; the literal can.
   */
  it("names a due row under its own prefix", () => {
    expect(dueKey("outbox")).toBe(`${DUE_PREFIX}outbox`);
    expect(dueKey("outbox")).toBe("due:outbox");
  });

  it("picks the earliest due time, and null when nothing is scheduled", () => {
    expect(earliestDue([500, 100, 900])).toBe(100);
    // The minimum first. A loop that starts one element in passes every other
    // case here, because none of them has the minimum in first position.
    expect(earliestDue([1, 5, 9])).toBe(1);
    // A fake clock starts at 0. That is a due time, not "nothing scheduled".
    expect(earliestDue([5, 0, 9])).toBe(0);
    // Any iterable works, including `Map.values()`, which can only be read once.
    // This is also the only case with the minimum in LAST position: a loop that
    // drops the final element passes every other case here and fails this one.
    expect(earliestDue(new Map([["a", 500], ["b", 100]]).values())).toBe(100);
    expect(earliestDue([])).toBeNull();
  });

  /**
   * The boundary is the case that bites: an alarm fires AT its due time, not
   * after it. `<` here would skip the handler at that instant and re-arm the
   * alarm to the same instant, so it spins until the clock moves on.
   */
  it("treats a handler due exactly now as due", () => {
    const due = new Map([["ttl", 1_000], ["outbox", 1_001]]);
    expect(dueNames(due, 1_000)).toEqual(["ttl"]);
    expect(dueNames(due, 1_001)).toEqual(["outbox", "ttl"]);
    expect(dueNames(due, 999)).toEqual([]);
    // Name order, whatever order the map was built in. These are also the only
    // due times of 0 in this test: a guard such as `if (!at)` that drops a
    // handler due at the epoch passes every other case here and fails this one.
    expect(dueNames(new Map([["b", 0], ["c", 0], ["a", 0]]), 0)).toEqual(["a", "b", "c"]);
  });

  /**
   * Derived entries are ones an object computes rather than stores — SessionDO's
   * TTL comes from the session record. A stored row of the same name wins,
   * earlier or later than the derived time, so a handler can reschedule itself
   * past its default. A derived entry with no stored row (`gc`) survives: a
   * session written before named alarms has a derived `ttl` and nothing stored
   * to shadow it. Neither input is changed.
   */
  it("merges stored rows over derived ones, stripping the prefix", () => {
    const rows = new Map([
      [`${DUE_PREFIX}outbox`, 700],
      [`${DUE_PREFIX}ttl`, 50],
      [`${DUE_PREFIX}retry`, 900],
    ]);
    const derived = new Map([["ttl", 999], ["retry", 100], ["gc", 5]]);
    const rowsBefore = [...rows];
    const derivedBefore = [...derived];

    expect(mergeDue(rows, derived)).toEqual(
      new Map([["outbox", 700], ["ttl", 50], ["retry", 900], ["gc", 5]])
    );
    expect([...rows]).toEqual(rowsBefore);
    expect([...derived]).toEqual(derivedBefore);

    // A stored due time of 0 is a due time, not an absent one, so it still
    // shadows the derived 999. `||` where `??` is meant lets the derived time win.
    expect(
      mergeDue(new Map([[`${DUE_PREFIX}ttl`, 0]]), new Map([["ttl", 999]]))
    ).toEqual(new Map([["ttl", 0]]));
  });
});

/** The storage a Durable Object would supply, as a plain Map. */
function fakeStorage(): OutboxStorage & {
  map: Map<string, unknown>;
  alarm: number | null;
  alarms: number[];
} {
  const map = new Map<string, unknown>();
  const self = {
    map,
    alarm: null as number | null,
    // Every setAlarm call, oldest first. `alarm` alone cannot tell "never set"
    // from "set to nothing".
    alarms: [] as number[],
    async get<T>(key: string) { return map.get(key) as T | undefined; },
    async put<T>(entries: Record<string, T>) {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    async delete(key: string) { return map.delete(key); },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map(
        [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
      ) as Map<string, T>;
    },
    async setAlarm(at: number) { self.alarm = at; self.alarms.push(at); },
  };
  return self;
}

describe("outbox", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("numbers rows from the counter and parks the counter outside the prefix", () => {
    const rows = enqueueRows(0, [
      { id: "i1", kind: "audit", payload: { a: 1 } },
      { id: "i2", kind: "audit", payload: { a: 2 } },
    ]);
    expect(Object.keys(rows).sort()).toEqual([OUTBOX_SEQ, outboxKey(0), outboxKey(1)].sort());
    expect(rows[OUTBOX_SEQ]).toBe(1);
    expect(rows[outboxKey(0)]).toEqual({ id: "i1", kind: "audit", payload: { a: 1 }, attempts: 0 });
    // The counter must not be listed by the drain that reads `ob:`, or the
    // drain hands a bare number to deliver() as though it were a row.
    expect(OUTBOX_SEQ.startsWith(OUTBOX_PREFIX)).toBe(false);
  });

  it("enqueues nothing for an empty intent list", () => {
    expect(enqueueRows(7, [])).toEqual({});
  });

  it("delivers in key order and deletes each row once it lands", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "i1", kind: "audit", payload: 1 },
      { id: "i2", kind: "audit", payload: 2 },
    ]));

    const seen: unknown[] = [];
    const next = await drain(storage, async (row) => { seen.push(row.payload); }, 1_000);

    expect(seen).toEqual([1, 2]);
    expect(next).toBeNull();
    expect([...storage.map.keys()]).toEqual([OUTBOX_SEQ]);
  });

  /**
   * Review Focus 3. An org move emits two rows. If the head fails, the one
   * behind it must still be there AND must not have been delivered ahead of it.
   * An audit stream that reorders around a stuck entry is worse than one that
   * stalls, so a failing head blocks everything behind it.
   */
  it("stops at a failing row, keeps it, and leaves the ones behind it untouched", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "revoked", kind: "audit", payload: "old-org" },
      { id: "granted", kind: "audit", payload: "new-org" },
    ]));

    const seen: unknown[] = [];
    const next = await drain(storage, async (row) => {
      if (row.id === "revoked") throw new Error("AuditDO is down");
      seen.push(row.payload);
    }, 1_000);

    // Nothing delivered, because the head never landed.
    expect(seen).toEqual([]);
    // Both rows still queued, in order, with the head's attempt counted.
    expect(await storage.get<OutboxRow>(outboxKey(0)))
      .toEqual({ id: "revoked", kind: "audit", payload: "old-org", attempts: 1 });
    expect(await storage.get<OutboxRow>(outboxKey(1)))
      .toEqual({ id: "granted", kind: "audit", payload: "new-org", attempts: 0 });
    // And it asked to be woken again.
    expect(next).toBe(1_000 + backoffMs(1));
  });

  it("backs off by doubling to a five-minute cap", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(99)).toBe(300_000);
  });

  /**
   * Storage keys outlive a deploy, so each is pinned by its literal as well as by
   * the constant. A narrower pad sorts `ob:10` before `ob:9`, which breaks FIFO
   * past nine rows. A wider one mixes widths with rows already stored, which
   * reorders the queue across the deploy. A renamed counter is not found, so
   * numbering starts again at 0 over rows that are still waiting.
   */
  it("keeps its storage keys byte for byte", () => {
    expect(OUTBOX_PREFIX).toBe("ob:");
    expect(OUTBOX_SEQ).toBe("ob_seq");
    expect(outboxKey(0)).toBe("ob:000000000000");
    expect(outboxKey(42)).toBe("ob:000000000042");
  });

  it("leaves the intents it is given alone", () => {
    const intents = [{ id: "i1", kind: "audit", payload: { a: 1 } }];
    const before = structuredClone(intents);

    enqueueRows(0, intents);

    // The stored row gets its own attempts count. The caller's intent does not.
    expect(intents).toEqual(before);
  });

  it("never waits less than the first delay, even for a count of zero", () => {
    expect(backoffMs(0)).toBe(1_000);
  });

  /**
   * A crash between delivering a row and deleting it has to find the row still
   * queued, so it is delivered again rather than lost. Deleting first would turn
   * at-least-once into at-most-once, and a dropped audit entry cannot be
   * recovered.
   */
  it("keeps a row in storage until its delivery has landed", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "i1", kind: "audit", payload: 1 }]));

    let whileDelivering: unknown = "deliver never ran";
    await drain(storage, async () => {
      whileDelivering = await storage.get(outboxKey(0));
    }, 1_000);

    expect(whileDelivering)
      .toEqual({ id: "i1", kind: "audit", payload: 1, attempts: 0 });
  });

  /**
   * The first failure cannot tell the two counts apart, because a count of 0
   * and a count of 1 both wait one second. It takes a second failure to see
   * whether the wait follows the attempts including this one.
   */
  it("counts each failure, doubles the wait, and lands the row once the downstream recovers", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "i1", kind: "audit", payload: 1 }]));
    let down = true;
    const attemptsSeen: number[] = [];
    const landed: unknown[] = [];
    const deliver = async (row: OutboxRow) => {
      attemptsSeen.push(row.attempts);
      if (down) throw new Error("AuditDO is down");
      landed.push(row.payload);
    };

    // The wake time is counted from the time drain was given.
    expect(await drain(storage, deliver, 10_000)).toBe(11_000);
    expect(await drain(storage, deliver, 20_000)).toBe(22_000);
    expect(await drain(storage, deliver, 30_000)).toBe(34_000);

    down = false;
    expect(await drain(storage, deliver, 40_000)).toBeNull();

    // deliver() sees how often the row has already failed, and it lands once.
    expect(attemptsSeen).toEqual([0, 1, 2, 3]);
    expect(landed).toEqual([1]);
    expect([...storage.map.keys()]).toEqual([OUTBOX_SEQ]);
  });

  /**
   * A row that fails behind a delivered one must not drag the delivered one back
   * into the queue. Deleting only after a clean pass would deliver it again on
   * the next drain.
   */
  it("does not deliver a row again because one behind it failed", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "a", kind: "audit", payload: "a" },
      { id: "b", kind: "audit", payload: "b" },
    ]));
    let bDown = true;
    const landed: unknown[] = [];
    const deliver = async (row: OutboxRow) => {
      if (row.id === "b" && bDown) throw new Error("AuditDO is down");
      landed.push(row.payload);
    };

    await drain(storage, deliver, 0);
    bDown = false;
    await drain(storage, deliver, 0);

    expect(landed).toEqual(["a", "b"]);
  });

  /**
   * A stuck queue has to become loud, but not from the first blip: a downstream
   * object that is down for a moment should not read as an outage. From the
   * fifth failure on, every failure is logged with the row and the error.
   */
  it("logs a failing row from its fifth failure on, and not before", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    await storage.put({ [outboxKey(0)]: { id: "i1", kind: "audit", payload: 1, attempts: 3 } });
    const boom = new Error("AuditDO is down");
    const deliver = async () => { throw boom; };

    await drain(storage, deliver, 0); // the fourth failure
    expect(errors).not.toHaveBeenCalled();

    await drain(storage, deliver, 0); // the fifth
    expect(errors).toHaveBeenCalledTimes(1);
    const [message, err] = errors.mock.calls[0];
    expect(message).toContain("audit");
    expect(message).toContain("i1");
    expect(message).toContain("5");
    expect(err).toBe(boom);

    await drain(storage, deliver, 0); // and the sixth
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

/** A caller's transaction, reduced to the one read the driver makes from it. */
function fakeTxn(values: Record<string, unknown> = {}) {
  const asked: string[] = [];
  return {
    asked,
    async get<T>(key: string) {
      asked.push(key);
      return values[key] as T | undefined;
    },
  };
}

describe("OutboxDriver", () => {
  const NOW = 1_800_000_000_000;
  const intent = { id: "i1", kind: "audit", payload: { a: 1 } };

  // The driver stamps rows and arms the alarm from Date.now(). Frozen, the marker
  // and the alarm are exact values rather than "some time around now".
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("enqueue returns the rows and a due marker, numbered from the transaction's counter", async () => {
    const driver = new OutboxDriver(fakeStorage(), async () => {});
    const txn = fakeTxn({ [OUTBOX_SEQ]: 4 });

    const rows = await driver.enqueue(txn, [intent]);

    expect(Object.keys(rows).sort())
      .toEqual([outboxKey(5), OUTBOX_SEQ, dueKey("outbox")].sort());
    expect(rows[OUTBOX_SEQ]).toBe(5);
    expect(rows[dueKey("outbox")]).toBe(NOW);
    // The counter is read from the caller's transaction, and from no other key.
    expect(txn.asked).toEqual([OUTBOX_SEQ]);
  });

  it("enqueue returns {} for no intents, without reading the transaction", async () => {
    const txn = fakeTxn({ [OUTBOX_SEQ]: 4 });
    const driver = new OutboxDriver(fakeStorage(), async () => {});

    expect(await driver.enqueue(txn, [])).toEqual({});
    // The positive fact behind the empty object: it stopped before reading.
    expect(txn.asked).toEqual([]);
  });

  it("deliverNow clears the due marker when the queue empties", async () => {
    const storage = fakeStorage();
    const seen: unknown[] = [];
    const driver = new OutboxDriver(storage, async (row) => { seen.push(row.payload); });
    await storage.put({
      ...enqueueRows(0, [
        { id: "i1", kind: "audit", payload: 1 },
        { id: "i2", kind: "audit", payload: 2 },
      ]),
      [dueKey("outbox")]: NOW,
    });
    // The marker has to exist before it can be seen to go.
    expect(storage.map.has(dueKey("outbox"))).toBe(true);

    await driver.deliverNow();

    expect(seen).toEqual([1, 2]);
    // Only the counter is left. A marker nobody clears re-fires the alarm forever
    // against an empty queue.
    expect([...storage.map.keys()]).toEqual([OUTBOX_SEQ]);
  });

  it("deliverNow keeps the due marker and arms the alarm when a row fails", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async (row) => {
      if (row.id === "revoked") throw new Error("AuditDO is down");
    });
    await storage.put({
      ...enqueueRows(0, [
        { id: "revoked", kind: "audit", payload: "old-org" },
        { id: "granted", kind: "audit", payload: "new-org" },
      ]),
      [dueKey("outbox")]: NOW,
    });

    await driver.deliverNow();

    // One failure is a one-second wait, so the marker moves into the future...
    expect(storage.map.get(dueKey("outbox"))).toBe(NOW + 1_000);
    // ...and the alarm follows it, or nothing would come back for the rows.
    expect(storage.alarm).toBe(NOW + 1_000);
  });

  it("allDue merges derived under stored, and dueNow returns only what is due", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(
      storage, async () => {}, async () => new Map([["ttl", 50]])
    );
    await storage.put({ [dueKey("outbox")]: 700 });

    expect(await driver.allDue()).toEqual(new Map([["outbox", 700], ["ttl", 50]]));
    expect(await driver.dueNow(100)).toEqual(["ttl"]);
    expect(await driver.dueNow(700)).toEqual(["outbox", "ttl"]);
  });

  it("reArm points the alarm at the earliest of stored and derived", async () => {
    const storedFirst = fakeStorage();
    await storedFirst.put({ [dueKey("outbox")]: 200 });
    await new OutboxDriver(
      storedFirst, async () => {}, async () => new Map([["ttl", 900]])
    ).reArm();
    expect(storedFirst.alarm).toBe(200);

    // And with the derived time the earlier one. Ignoring either side passes
    // exactly one of the two cases.
    const derivedFirst = fakeStorage();
    await derivedFirst.put({ [dueKey("outbox")]: 800 });
    await new OutboxDriver(
      derivedFirst, async () => {}, async () => new Map([["ttl", 100]])
    ).reArm();
    expect(derivedFirst.alarm).toBe(100);
  });

  /**
   * A row that commits with nothing scheduled to read it is the window this module
   * exists to close, and RegistryDO has no other alarm to come back for it, so
   * enqueue arms one itself, a grace period behind the inline delivery. Both facts
   * are asserted, so the test fails if either the arm or the marker goes missing.
   */
  it("enqueue arms the alarm, alongside the marker it returns", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});

    const rows = await driver.enqueue(fakeTxn(), [intent]);

    expect(rows[dueKey("outbox")]).toBe(NOW);
    expect(storage.alarm).toBe(NOW + OUTBOX_GRACE_MS);
  });

  /**
   * Arming for the queue must not push back a due time that was already closer.
   * SessionDO's session expiry is one: a queue that moved the alarm later would
   * stop rooms expiring.
   */
  it("enqueue leaves an earlier derived due time in place", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(
      storage, async () => {}, async () => new Map([["ttl", 1]])
    );

    await driver.enqueue(fakeTxn(), [intent]);

    expect(storage.alarm).toBe(1);
  });

  /**
   * The alarm is a backstop, so it waits behind the inline delivery instead of
   * racing it. Armed for `now`, it fired 1-3 ms after the commit and ran a second
   * drain against the first. The marker stays at `now`, so the handler is due the
   * moment the alarm does fire, whatever fired it.
   */
  it("enqueue arms the alarm a grace period behind the marker, and a nearer due time still wins", async () => {
    const storage = fakeStorage();
    const rows = await new OutboxDriver(storage, async () => {}).enqueue(fakeTxn(), [intent]);
    const marker = rows[dueKey("outbox")] as number;

    expect(storage.alarm).toBeGreaterThanOrEqual(marker + OUTBOX_GRACE_MS);
    // A grace too short to matter would put the race back.
    expect(OUTBOX_GRACE_MS).toBeGreaterThanOrEqual(1_000);

    // A due time nearer than the grace still wins, so a session cannot expire late
    // because a row was queued.
    const nearer = fakeStorage();
    await new OutboxDriver(
      nearer, async () => {}, async () => new Map([["ttl", NOW + 1_000]])
    ).enqueue(fakeTxn(), [intent]);
    expect(nearer.alarm).toBe(NOW + 1_000);
  });

  it("enqueue leaves an earlier stored due time in place, even one at the epoch", async () => {
    // A fake clock starts at 0. A handler due then is due, and is not "nothing
    // scheduled", so it must not lose the alarm to a row queued later.
    for (const earlier of [NOW - 5, 0]) {
      const storage = fakeStorage();
      await storage.put({ [dueKey("retry")]: earlier });
      const driver = new OutboxDriver(storage, async () => {});

      await driver.enqueue(fakeTxn(), [intent]);

      expect(storage.alarm).toBe(earlier);
    }
  });

  /**
   * The counter holds the last number used, so a counter of 0 means row 0
   * exists. Read as unset, it would hand out 0 again and overwrite a row that
   * has not been delivered.
   */
  it("enqueue numbers rows consecutively, from 0 on a fresh queue, never reusing one", async () => {
    const driver = new OutboxDriver(fakeStorage(), async () => {});

    const fresh = await driver.enqueue(fakeTxn(), [intent, { ...intent, id: "i2" }]);
    expect(Object.keys(fresh).sort())
      .toEqual([outboxKey(0), outboxKey(1), OUTBOX_SEQ, dueKey("outbox")].sort());
    expect(fresh[OUTBOX_SEQ]).toBe(1);

    const after = await driver.enqueue(fakeTxn({ [OUTBOX_SEQ]: 0 }), [intent]);
    expect(Object.keys(after).sort())
      .toEqual([outboxKey(1), OUTBOX_SEQ, dueKey("outbox")].sort());
    expect(after[OUTBOX_SEQ]).toBe(1);
  });

  it("enqueue writes no rows of its own", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});

    await driver.enqueue(fakeTxn(), [intent]);

    // The rows are the caller's to commit with its mutation. The alarm is the
    // one thing enqueue writes itself.
    expect([...storage.map.keys()]).toEqual([]);
  });

  it("enqueue arms nothing when it has nothing to queue", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});

    await driver.enqueue(fakeTxn(), []);

    // A refused mutation queues nothing, so there is nothing to wake for.
    expect(storage.alarms).toEqual([]);
  });

  /**
   * The arm only commits with the caller's transaction if it finishes inside the
   * closure, so enqueue must not resolve before the alarm write has. The write is
   * held open here, and enqueue has to still be waiting on it.
   */
  it("enqueue does not resolve until the alarm write has", async () => {
    const storage = fakeStorage();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    storage.setAlarm = async (at) => { started.push(at); await held; };
    const driver = new OutboxDriver(storage, async () => {});

    let resolved = false;
    const pending = driver.enqueue(fakeTxn(), [intent]).then(() => { resolved = true; });
    // A macrotask turn runs every ready promise first, so by now enqueue has
    // reached the alarm write and has nothing left to do but wait on it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([NOW + OUTBOX_GRACE_MS]);
    expect(resolved).toBe(false);

    release();
    await pending;
    expect(resolved).toBe(true);
  });

  it("deliverNow leaves a nearer derived due time in place when a row fails", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(
      storage,
      async () => { throw new Error("AuditDO is down"); },
      async () => new Map([["ttl", NOW + 500]])
    );
    await storage.put({ ...enqueueRows(0, [intent]), [dueKey("outbox")]: NOW });

    await driver.deliverNow();

    // The retry is a second away and a session expires in half of that.
    expect(storage.map.get(dueKey("outbox"))).toBe(NOW + 1_000);
    expect(storage.alarm).toBe(NOW + 500);
  });

  it("dueNow defaults to the current time", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});
    await storage.put({ [dueKey("outbox")]: NOW, [dueKey("retry")]: NOW + 1 });

    expect(await driver.dueNow()).toEqual(["outbox"]);
  });

  it("reArm sets no alarm when nothing is scheduled", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});

    await driver.reArm();

    expect(storage.alarms).toEqual([]);
  });

  it("reArm arms a due time of 0, which is a due time and not nothing scheduled", async () => {
    const storage = fakeStorage();
    const driver = new OutboxDriver(storage, async () => {});
    await storage.put({ [dueKey("outbox")]: 0 });

    await driver.reArm();

    expect(storage.alarms).toEqual([0]);
  });
});

describe("OutboxDriver, overlapping deliverNow calls", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  /** A deliver() whose every call the test settles by hand, in the order it chooses. */
  function manualDeliver() {
    const calls: Array<{ id: string; def: ReturnType<typeof deferred> }> = [];
    const landed: string[] = [];
    const deliver = (row: OutboxRow) => {
      const def = deferred();
      calls.push({ id: row.id, def });
      return def.promise.then(() => { landed.push(row.id); });
    };
    return { calls, landed, deliver };
  }
  const queuedIds = (storage: ReturnType<typeof fakeStorage>) =>
    [...storage.map].filter(([k]) => k.startsWith(OUTBOX_PREFIX)).map(([, v]) => (v as OutboxRow).id);

  it("delivers a row once when the alarm arrives during the inline delivery", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "r0", kind: "audit", payload: 0 }]));
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const inline = driver.deliverNow();
    await tick();
    const alarm = driver.deliverNow();
    await tick();
    expect(m.calls.map((c) => c.id)).toEqual(["r0"]);

    m.calls[0].def.resolve();
    await Promise.all([inline, alarm]);
    expect(queuedIds(storage)).toEqual([]);
  });

  it("never puts back a row that another drain has already delivered and deleted", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [
      { id: "r0", kind: "put", payload: 0 }, { id: "r1", kind: "drop", payload: 1 },
    ]));
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const inline = driver.deliverNow();
    await tick();
    const alarm = driver.deliverNow();
    await tick();
    // The order that hurts: the first call lands, so does everything after it,
    // and then whichever call is still open fails.
    m.calls[0].def.resolve();
    await tick();
    for (const c of m.calls.slice(1)) c.def.resolve();
    await tick();
    for (const c of m.calls) c.def.reject(new Error("late failure"));
    await Promise.all([inline, alarm]);

    for (const id of queuedIds(storage)) expect(m.landed).not.toContain(id);
  });

  it("never leaves rows queued with no due marker", async () => {
    const storage = fakeStorage();
    await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const first = driver.deliverNow(); // lists [r0]; its ack is slow
    await tick();
    // A second write commits while that delivery is in flight, and asks to be drained.
    const seq = (await storage.get<number>(OUTBOX_SEQ))!;
    await storage.put({
      ...enqueueRows(seq + 1, [{ id: "r1", kind: "put", payload: 1 }]),
      [dueKey("outbox")]: 2,
    });
    const second = driver.deliverNow();
    await tick();
    for (const c of m.calls.slice(1)) c.def.reject(new Error("sink error"));
    await tick();
    m.calls[0].def.resolve(); // the slow one lands last
    await tick();
    for (const c of m.calls.slice(1)) c.def.reject(new Error("sink error"));
    await tick();
    await Promise.allSettled([first, second]);

    expect(queuedIds(storage).length).toBeGreaterThan(0);      // r1 cannot have landed
    expect(storage.map.has(dueKey("outbox"))).toBe(true);      // so something must still come back for it
  });

  /**
   * A caller that joins a drain is told the queue has been tried, so it has to wait
   * for the drain it joined. Handing someone a join code right after creating the
   * room only works if the caller that made the room waits for the delivery that
   * makes the code resolve, even when another caller started that delivery.
   */
  it("resolves a caller that joined a drain only once that drain has finished", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]));
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const inline = driver.deliverNow();
    await tick();
    let joinerDone = false;
    const joiner = driver.deliverNow().then(() => { joinerDone = true; });
    await tick();
    expect(joinerDone).toBe(false);

    m.calls[0].def.resolve();
    await Promise.all([inline, joiner]);
    expect(joinerDone).toBe(true);
    expect(queuedIds(storage)).toEqual([]);
  });

  /**
   * After a failure the head is still failing, and the backoff owns the retry. A
   * caller that arrived mid-drain must not turn that into an immediate second
   * attempt, or every write to a downed downstream retries the head at once and
   * the attempt count climbs faster than the backoff allows.
   */
  it("does not retry a failing head for a caller that arrived mid-drain", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]));
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const first = driver.deliverNow();
    await tick();
    const second = driver.deliverNow();
    await tick();
    m.calls[0].def.reject(new Error("AuditDO is down"));
    await tick();

    expect(m.calls.length).toBe(1);
    await Promise.all([first, second]);
    expect(queuedIds(storage)).toEqual(["r0"]);
  });

  /** A drain that has finished must not leave the driver believing one is still running. */
  it("starts a fresh drain for a call made after the previous one finished", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]));
    const landed: string[] = [];
    const driver = new OutboxDriver(storage, async (row) => { landed.push(row.id); });

    await driver.deliverNow();
    await storage.put(enqueueRows(1, [{ id: "r1", kind: "put", payload: 1 }]));
    await driver.deliverNow();

    expect(landed).toEqual(["r0", "r1"]);
  });

  /**
   * A drain that throws, because the storage under it failed, must not wedge the
   * driver: the next call drains, instead of joining a drain that is over.
   */
  it("drains again after a drain that threw", async () => {
    const storage = fakeStorage();
    await storage.put(enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]));
    const landed: string[] = [];
    const driver = new OutboxDriver(storage, async (row) => { landed.push(row.id); });
    const list = storage.list.bind(storage);
    let failNext = true;
    storage.list = async <T>(options: { prefix: string }) => {
      if (failNext) {
        failNext = false;
        throw new Error("storage is down");
      }
      return list<T>(options);
    };

    await expect(driver.deliverNow()).rejects.toThrow("storage is down");
    await driver.deliverNow();

    expect(landed).toEqual(["r0"]);
  });

  /**
   * A row committed while a drain is in flight sets the marker, and the drain's own
   * delete then takes it. If the committer never reaches deliverNow(), because its
   * isolate died in that gap or because it queues without delivering, nothing wakes
   * for the row: alarm() dispatches on the marker. So a drain that finds a row after
   * clearing the marker puts the marker back and takes another pass, and the marker
   * is there while that pass is still in flight.
   */
  it("puts the marker back and takes another pass for a row committed while it was in flight", async () => {
    const storage = fakeStorage();
    await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
    const m = manualDeliver();
    const driver = new OutboxDriver(storage, m.deliver);

    const first = driver.deliverNow();
    await tick();
    // A second write commits: its row, and the marker enqueue returns. Its caller
    // never gets as far as deliverNow().
    const seq = (await storage.get<number>(OUTBOX_SEQ))!;
    await storage.put({
      ...enqueueRows(seq + 1, [{ id: "r1", kind: "put", payload: 1 }]),
      [dueKey("outbox")]: 2,
    });

    m.calls[0].def.resolve(); // r0 lands, so that pass's listing is empty
    await tick();

    // The drain looked again, found r1 and started another pass. That pass is still
    // waiting on r1, and the marker is back for the alarm to find.
    expect(m.calls.map((c) => c.id)).toEqual(["r0", "r1"]);
    expect(await driver.dueNow(Number.MAX_SAFE_INTEGER)).toEqual(["outbox"]);
    expect(storage.map.get(dueKey("outbox"))).toBeLessThanOrEqual(Date.now());

    m.calls[1].def.resolve();
    await first;
    expect(queuedIds(storage)).toEqual([]);
    expect(storage.map.has(dueKey("outbox"))).toBe(false);
  });

  /**
   * The look has to come after the delete. Looking first and deleting second leaves
   * a gap between them, and a row committed in that gap loses its marker to the
   * delete without the look ever seeing it.
   */
  it("looks at the queue after it clears the marker, not before", async () => {
    const storage = fakeStorage();
    await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
    const landed: string[] = [];
    const driver = new OutboxDriver(storage, async (row) => { landed.push(row.id); });

    // A second write commits at the moment the marker is deleted: its row and its
    // marker land first, then the delete takes the marker.
    const remove = storage.delete.bind(storage);
    let committed = false;
    storage.delete = async (key: string) => {
      if (key === dueKey("outbox") && !committed) {
        committed = true;
        const seq = (await storage.get<number>(OUTBOX_SEQ))!;
        await storage.put({
          ...enqueueRows(seq + 1, [{ id: "r1", kind: "put", payload: 1 }]),
          [dueKey("outbox")]: 2,
        });
      }
      return remove(key);
    };

    await driver.deliverNow();

    expect(landed).toEqual(["r0", "r1"]);
  });

  /**
   * The look at the end of a drain cannot see a row committed after it. That row's
   * committer calls deliverNow() and, with the drain still running, joins it. The
   * join has to ask for another pass, or the drain ends without ever trying the row
   * and the committer's own delivery is silently skipped: a join code handed out
   * right after its room was created would not resolve until the alarm.
   */
  it("gives a caller that joins after the drain's last look another pass", async () => {
    const storage = fakeStorage();
    await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
    const landed: string[] = [];
    const driver = new OutboxDriver(storage, async (row) => { landed.push(row.id); });

    // The look is the drain's second listing of the queue, after its own. A second
    // write commits just after the look has read, and its caller joins the drain.
    const readQueue = storage.list.bind(storage);
    let listings = 0;
    let joiner: Promise<void> | undefined;
    storage.list = async <T>(options: { prefix: string }) => {
      const seen = await readQueue<T>(options);
      if (options.prefix === OUTBOX_PREFIX && ++listings === 2) {
        const seq = (await storage.get<number>(OUTBOX_SEQ))!;
        await storage.put({
          ...enqueueRows(seq + 1, [{ id: "r1", kind: "put", payload: 1 }]),
          [dueKey("outbox")]: 2,
        });
        joiner = driver.deliverNow();
      }
      return seen;
    };

    await driver.deliverNow();
    await joiner;

    expect(landed).toEqual(["r0", "r1"]);
  });

  describe("the pass cap", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    /**
     * A deliver() that queues another row each time, up to `chain` deliveries, so no
     * pass leaves the queue empty until then. Past the cap it throws instead: a driver
     * with no working cap then fails these tests, where it would otherwise spin.
     */
    function refilling(storage: ReturnType<typeof fakeStorage>, chain: number) {
      const state = { delivered: 0 };
      const deliver = async () => {
        state.delivered++;
        if (state.delivered > MAX_DRAIN_PASSES + 50) throw new Error("the drain ran past its cap");
        if (state.delivered < chain) {
          const seq = (await storage.get<number>(OUTBOX_SEQ))!;
          await storage.put(enqueueRows(seq + 1, [
            { id: `r${state.delivered}`, kind: "put", payload: state.delivered },
          ]));
        }
      };
      return { state, deliver };
    }

    /**
     * Without a bound, a deliver() that keeps the queue from emptying spins the drain
     * forever, and nothing can interrupt a loop that never yields to the event loop.
     * So the drain stops at the cap, says so, and leaves the rows queued with the
     * marker set: the alarm comes back for them, so stopping early delays work and
     * never drops it. This is the one test in the file that has to complete rather
     * than hang.
     */
    it("stops at the pass cap when the queue never empties, and leaves the rows queued with the marker set", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const storage = fakeStorage();
      await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
      const { state, deliver } = refilling(storage, Number.POSITIVE_INFINITY);
      const driver = new OutboxDriver(storage, deliver);

      await driver.deliverNow();

      // Each pass delivers one row, so this counts the passes.
      expect(state.delivered).toBe(MAX_DRAIN_PASSES);
      expect(errors).toHaveBeenCalledTimes(1);
      const [message] = errors.mock.calls[0];
      expect(message).toContain(String(MAX_DRAIN_PASSES));
      expect(message).toContain("queue depth 1");
      // The row the last pass queued is still there, and the marker is set.
      expect(queuedIds(storage)).toEqual([`r${MAX_DRAIN_PASSES}`]);
      expect(await driver.dueNow(Number.MAX_SAFE_INTEGER)).toEqual(["outbox"]);
    });

    /**
     * The cap has to sit above what a busy queue needs, or it stops legitimate work: a
     * queue that keeps refilling for twenty passes is busy, not broken. And a queue that
     * is empty after the last pass the cap allows ended normally, so reporting it as a
     * runaway would raise an alarm for nothing.
     */
    it("does not stop a queue that refills for a while, or one that empties on the last pass the cap allows", async () => {
      for (const chain of [20, MAX_DRAIN_PASSES]) {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const storage = fakeStorage();
        await storage.put({ ...enqueueRows(0, [{ id: "r0", kind: "put", payload: 0 }]), [dueKey("outbox")]: 1 });
        const { state, deliver } = refilling(storage, chain);
        const driver = new OutboxDriver(storage, deliver);

        await driver.deliverNow();

        expect(state.delivered).toBe(chain);
        expect(errors).not.toHaveBeenCalled();
        expect(queuedIds(storage)).toEqual([]);
        expect(storage.map.has(dueKey("outbox"))).toBe(false);
        errors.mockRestore();
      }
    });

    // The cap is a safety net measured in seconds of work, so a change to it should be
    // deliberate.
    it("caps a drain at a hundred passes", () => {
      expect(MAX_DRAIN_PASSES).toBe(100);
    });
  });
});
