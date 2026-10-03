import { it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type AuditDO, type RegistryDO } from "../src/store-do.js";
import { OUTBOX_HANDLER, OUTBOX_PREFIX, dueKey, outboxKey, type OutboxRow } from "../src/outbox.js";
import type { AuditEntry, PlanGrant } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242", plan: "team", role: "admin", orgId: "org_mine",
  source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null, ...over,
});

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const auditStream = (orgId: string) => env.AUDIT.get(env.AUDIT.idFromName(orgId));

/** The rows still waiting to be delivered, in queue order. */
const queuedRows = () =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => [
    ...(await ctx.storage.list<OutboxRow>({ prefix: OUTBOX_PREFIX })).values(),
  ]);
const queued = () =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => [
    ...(await ctx.storage.list({ prefix: OUTBOX_PREFIX })).keys(),
  ]);
/** When the registry's one alarm is set for, or null when nothing is scheduled. */
const armedAlarm = () =>
  runInDurableObject(registry(), (_i: RegistryDO, ctx) => ctx.storage.getAlarm());

const actionsFor = async (store: DurableObjectStore, orgId: string) =>
  (await store.auditForOrg(orgId, 10)).map((e) => e.action);

/**
 * Turn the inline delivery off, or back on, on the instance the registry's calls are
 * served by. With it off a guarded write commits and queues its entry and does not try
 * to deliver it, which is what the isolate going away just before that attempt would
 * amount to. TypeScript's `private` is a compile-time check, so the test can reach the
 * field; nothing in the production class exists for the purpose.
 */
type Driver = { deliverNow?: () => Promise<void> };
const deliveryOff = () =>
  runInDurableObject(registry(), (instance: RegistryDO) => {
    (instance as unknown as { driver: Driver }).driver.deliverNow = async () => {};
  });
const deliveryOn = () =>
  runInDurableObject(registry(), (instance: RegistryDO) => {
    delete (instance as unknown as { driver: Driver }).driver.deliverNow;
  });

it("audits a guarded write, and the entry is there before the caller returns", async () => {
  const store = new DurableObjectStore(env as never);

  expect(await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }))
    .toBe("written");

  expect((await store.auditForOrg("org_mine", 10)).map((e) => [e.action, e.actorUserId, e.detail.key]))
    .toEqual([["plan_granted", "u_admin", "github:4242"]]);
});

/**
 * The bug. The grant change commits, the audit write never happens, and there
 * is no record anywhere that it was owed. Turning the inline delivery off for the
 * write and then aborting the object is the closest reachable analogue of the
 * isolate going away between the commit and the delivery.
 */
it("delivers an audit entry whose inline attempt never ran", async () => {
  const store = new DurableObjectStore(env as never);

  await deliveryOff();
  await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" });
  await abortAllDurableObjects();

  // Nothing delivered yet, and the row is still queued.
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  expect(await queued()).toHaveLength(1);

  // The alarm is the backstop, and it clears the queue.
  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect((await store.auditForOrg("org_mine", 10)).map((e) => e.action)).toEqual(["plan_granted"]);
  expect(await queued()).toEqual([]);
});

/**
 * Review Focus 2. A rejected write leaving an audit trace is the bug #44 fixed
 * on the admin path, reintroduced through a different door.
 */
it("queues and records nothing when a guarded write is refused", async () => {
  const store = new DurableObjectStore(env as never);
  await store.putGrant(grant({ orgId: "org_theirs" }));

  expect(await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }))
    .toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_admin" }))
    .toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:nobody", "org_mine", { actorUserId: "u_admin" }))
    .toBe("missing");

  // Both orgs, so a misfiled entry cannot hide in the one we did not check.
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
  expect(await queued()).toEqual([]);
  // And the grant is untouched, so the emptiness above is about the audit
  // rather than about the whole call having done nothing.
  expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
});

/**
 * Review Focus 1. Every pro purchase is org-less, so the audit log has no stream
 * for it. A queued row for one would not stall: a namespace accepts "", null and
 * undefined as names, so it is DELIVERED, into a stream no org reads — and
 * `idFromName(undefined)` names the same object as an org called "undefined",
 * which isOrgId allows.
 *
 * Two guards keep such a row out: `hasOrg` in grantAuditEntries, and `deliver`'s
 * own `!entry.orgId`. So an empty queue after the call cannot tell which one did
 * the work — `deliver` returning normally makes `drain` delete the row either
 * way. Step 6's control 3 removes BOTH, which is the only way to see either fail.
 */
it("queues nothing for an org-less grant", async () => {
  const store = new DurableObjectStore(env as never);

  const written = await store.putGrantIfSource(
    grant({ orgId: null, plan: "pro", role: "member", source: "purchase" }),
    "purchase",
    { actorUserId: "stripe" }
  );
  expect(written.outcome).toBe("written");

  expect(await queued()).toEqual([]);
  expect(await store.getGrant("github:4242")).toMatchObject({ plan: "pro", orgId: null });
  // With both guards gone, the entry is delivered to the stream of an org named for
  // the null, and the queue is empty again by the time the call returns. Only a read
  // of that stream sees it, so the queue check above cannot be the whole test.
  expect(await store.auditForOrg("null", 10)).toEqual([]);
});

/**
 * The same, for an org id a namespace WOULD accept as a name. `putGrant` validates
 * nothing, so a grant like this can reach the store even though the admin route's
 * isOrgId and billing's derived org id both refuse it. If both guards were gone the
 * entry would land in the stream of org "" and in one named "null" — read back here,
 * so the test fails on a misfile rather than only on a queue that is not empty.
 */
it("queues nothing, and misfiles nothing, for an org id that is not a real org", async () => {
  const store = new DurableObjectStore(env as never);

  await store.putGrant(grant({ key: "github:9", orgId: "" as never, plan: "pro", role: "member", source: "purchase" }));
  const written = await store.putGrantIfSource(
    grant({ key: "github:9", orgId: "" as never, plan: "team", role: "admin", source: "purchase" }),
    "purchase",
    { actorUserId: "stripe" }
  );
  expect(written.outcome).toBe("written");

  expect(await queued()).toEqual([]);
  expect(await store.auditForOrg("", 10)).toEqual([]);
  expect(await store.auditForOrg("null", 10)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Everything above is the brief's own. What follows pins what it leaves open:
// each of the four writes, what an entry carries, and the commit being one.
// ---------------------------------------------------------------------------

/**
 * All four writes, not the one the first test happens to call. Each has its own
 * transaction and its own enqueue, so a write that stopped recording would
 * pass every test that only drives another. The deletes matter most: a revoke
 * that is not recorded is the original loss, and the retry cannot recover it.
 */
const FOUR_WRITES = [
  {
    name: "putGrantIfOwned", action: "plan_granted", visible: true,
    run: async (s: DurableObjectStore, i: { actorUserId: string; detail?: Record<string, unknown> }) =>
      s.putGrantIfOwned(grant(), "org_mine", i),
    outcome: "written",
  },
  {
    name: "putGrantIfSource", action: "plan_granted", visible: true,
    run: async (s: DurableObjectStore, i: { actorUserId: string; detail?: Record<string, unknown> }) =>
      (await s.putGrantIfSource(grant({ source: "purchase" }), "purchase", i)).outcome,
    outcome: "written",
  },
  {
    name: "deleteGrantIfOwned", action: "plan_revoked", visible: false,
    run: async (s: DurableObjectStore, i: { actorUserId: string; detail?: Record<string, unknown> }) => {
      await s.putGrant(grant());
      return s.deleteGrantIfOwned("github:4242", "org_mine", i);
    },
    outcome: "deleted",
  },
  {
    name: "deleteGrantIfSource", action: "plan_revoked", visible: false,
    run: async (s: DurableObjectStore, i: { actorUserId: string; detail?: Record<string, unknown> }) => {
      await s.putGrant(grant({ source: "purchase" }));
      return (await s.deleteGrantIfSource("github:4242", "purchase", i)).outcome;
    },
    outcome: "deleted",
  },
];

it.each(FOUR_WRITES)(
  "$name records its change in the affected org, as the caller said, before it returns",
  async ({ run, outcome, action }) => {
    const store = new DurableObjectStore(env as never);

    const before = Date.now();
    expect(await run(store, { actorUserId: "u_admin", detail: { note: "why" } })).toBe(outcome);
    const after = Date.now();

    const entries = await store.auditForOrg("org_mine", 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "u_admin", action,
      detail: { key: "github:4242", note: "why" },
    });
    // Stamped when the write happened, by the object that made it.
    expect(entries[0].at).toBeGreaterThanOrEqual(before);
    expect(entries[0].at).toBeLessThanOrEqual(after);
    expect(await queued()).toEqual([]);
  }
);

/**
 * The recovery test at the top, for each of the four writes. Each has a transaction
 * of its own: one that queued its row and left nothing armed to find it would be
 * recovered by no one, and would pass every test that delivers inline. The inline
 * attempt is switched off for the length of the write; the alarm is then the only
 * thing left to deliver.
 */
it.each(FOUR_WRITES)(
  "$name leaves its entry queued with an alarm armed if delivery never runs, and the alarm delivers it",
  async ({ run, action }) => {
    const store = new DurableObjectStore(env as never);
    await deliveryOff();

    await run(store, { actorUserId: "u_admin" });

    expect(await queued()).toHaveLength(1);
    expect(await armedAlarm()).not.toBeNull();
    expect(await actionsFor(store, "org_mine")).toEqual([]);

    // Delivery works again, and the alarm is the one to use it.
    await deliveryOn();
    expect(await runDurableObjectAlarm(registry())).toBe(true);

    expect(await actionsFor(store, "org_mine")).toEqual([action]);
    expect(await queued()).toEqual([]);
  }
);

/**
 * `previous` is what lets the rule see a move. The grant is re-homed rather than
 * deleted, so the org it left would never hear of it without this: a team
 * subscription ending while a pro one continues does exactly that.
 */
it("tells the org a grant left, and only that org, when billing moves it", async () => {
  const store = new DurableObjectStore(env as never);
  const stripe = { actorUserId: "stripe" };
  const purchase = (over: Partial<PlanGrant>) =>
    grant({ source: "purchase", grantedBy: "stripe", ...over });

  await store.putGrantIfSource(purchase({ orgId: "org_old" }), "purchase", stripe);
  await store.putGrantIfSource(purchase({ orgId: "org_new" }), "purchase", stripe);

  expect(await actionsFor(store, "org_old")).toEqual(["plan_granted", "plan_revoked"]);
  expect(await actionsFor(store, "org_new")).toEqual(["plan_granted"]);
  expect((await store.auditForOrg("org_old", 10))[1].detail)
    .toMatchObject({ reason: "moved to another plan", moved_to: "org_new" });

  // And into no org at all: the pro plan that continues has no stream, so the
  // org it left is the only one with anything to hear.
  await store.putGrantIfSource(
    purchase({ orgId: null, plan: "pro", role: "member" }), "purchase", stripe
  );
  expect(await actionsFor(store, "org_new")).toEqual(["plan_granted", "plan_revoked"]);
  expect(await actionsFor(store, "org_old")).toEqual(["plan_granted", "plan_revoked"]);

  // And back from no org to a team. The pro plan it leaves has no stream to tell, so
  // the only entry is the grant, and nothing is filed under the name the null gets.
  await store.putGrantIfSource(purchase({ orgId: "org_old" }), "purchase", stripe);
  expect(await actionsFor(store, "org_old"))
    .toEqual(["plan_granted", "plan_revoked", "plan_granted"]);
  expect(await store.auditForOrg("null", 10)).toEqual([]);
  expect(await queued()).toEqual([]);
});

/**
 * A redelivered Stripe event rewrites the same grant with a fresh grantedAt, and
 * must not add a line (#68). A real change must add one that says what it replaced,
 * which only holds if the write hands the rule the grant it actually found.
 */
it.each([
  ["putGrantIfOwned", (s: DurableObjectStore, g: PlanGrant) =>
    s.putGrantIfOwned(g, "org_mine", { actorUserId: "u_admin" })],
  ["putGrantIfSource", (s: DurableObjectStore, g: PlanGrant) =>
    s.putGrantIfSource(g, "operator", { actorUserId: "u_admin" })],
] as const)("%s records a repeat once, and a change again", async (_name, put) => {
  const store = new DurableObjectStore(env as never);

  await put(store, grant());
  await put(store, grant({ grantedAt: Date.now() + 5_000 }));
  expect(await actionsFor(store, "org_mine")).toEqual(["plan_granted"]);

  await put(store, grant({ plan: "pro", role: "member" }));
  const entries = await store.auditForOrg("org_mine", 10);
  expect(entries.map((e) => e.action)).toEqual(["plan_granted", "plan_granted"]);
  expect(entries[1].detail).toMatchObject({ plan: "pro", replaced_plan: "team" });
});

/**
 * A lapsed grant is not a grant, for the ownership check and for the record of
 * the change alike. Handing the rule the stored record instead would tell a dead
 * org it lost something it no longer had, and say the new grant replaced a plan
 * that was already gone.
 */
it.each([
  ["putGrantIfOwned", (s: DurableObjectStore, g: PlanGrant) =>
    s.putGrantIfOwned(g, "org_mine", { actorUserId: "u_admin" })],
  ["putGrantIfSource", (s: DurableObjectStore, g: PlanGrant) =>
    s.putGrantIfSource(g, "operator", { actorUserId: "u_admin" })],
] as const)("%s treats a lapsed grant as no previous grant", async (_name, put) => {
  const store = new DurableObjectStore(env as never);
  await store.putGrant(grant({ orgId: "org_theirs", plan: "team", expiresAt: Date.now() - 1 }));

  await put(store, grant({ plan: "pro", role: "member" }));

  const entries = await store.auditForOrg("org_mine", 10);
  expect(entries.map((e) => e.action)).toEqual(["plan_granted"]);
  expect(entries[0].detail).not.toHaveProperty("replaced_plan");
  expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
  // The write took the key, so the empty stream above is the rule's doing and not
  // a write that never happened.
  expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_mine", plan: "pro" });
});

/**
 * Review Focus 2 for all four writes, and for the lapsed branch of each delete.
 * The row a refused write would queue is not the only trace: queuing arms the
 * object's alarm in the same transaction, and a transaction that returns commits
 * that with everything else. So an alarm armed here is a refused write that got as
 * far as queuing, whether or not its row ever reached storage.
 */
it("refuses all four writes without queuing, arming or recording anything", async () => {
  const store = new DurableObjectStore(env as never);
  const asAdmin = { actorUserId: "u_admin" };
  await store.putGrant(grant({ orgId: "org_theirs" }));
  await store.putGrant(grant({ key: "github:old1", orgId: "org_theirs", expiresAt: Date.now() - 1 }));
  await store.putGrant(grant({ key: "github:old2", orgId: "org_theirs", expiresAt: Date.now() - 1 }));

  expect(await store.putGrantIfOwned(grant(), "org_mine", asAdmin)).toBe("conflict");
  expect((await store.putGrantIfSource(grant(), "purchase", asAdmin)).outcome).toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:4242", "org_mine", asAdmin)).toBe("conflict");
  expect((await store.deleteGrantIfSource("github:4242", "purchase", asAdmin)).outcome).toBe("conflict");
  expect(await store.deleteGrantIfOwned("github:nobody", "org_mine", asAdmin)).toBe("missing");
  expect((await store.deleteGrantIfSource("github:nobody", "purchase", asAdmin)).outcome).toBe("missing");
  // Already gone to every reader: tidied away, reported as missing, revoked by nobody.
  expect(await store.deleteGrantIfOwned("github:old1", "org_theirs", asAdmin)).toBe("missing");
  expect((await store.deleteGrantIfSource("github:old2", "operator", asAdmin)).outcome).toBe("missing");

  expect(await queued()).toEqual([]);
  expect(await armedAlarm()).toBeNull();
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
  // The grant that was refused is still there, so none of the above is a store that
  // did nothing at all.
  expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
});

/**
 * Every pro cancellation is this: a delete that has nothing to record. The row
 * list is empty, and the transaction still has to write it. Nothing else in the
 * suite deletes through a guard with no org.
 */
it("deletes an org-less grant through either guard, and records nothing for it", async () => {
  const store = new DurableObjectStore(env as never);
  const stripe = { actorUserId: "stripe" };
  const solo = (key: string) =>
    grant({ key, orgId: null, plan: "pro", role: "member", source: "purchase" });
  await store.putGrant(solo("github:solo1"));
  await store.putGrant(solo("github:solo2"));

  expect((await store.deleteGrantIfSource("github:solo1", "purchase", stripe)).outcome).toBe("deleted");
  expect(await store.deleteGrantIfOwned("github:solo2", null, stripe)).toBe("deleted");

  expect(await store.getGrant("github:solo1")).toBeUndefined();
  expect(await store.getGrant("github:solo2")).toBeUndefined();
  expect(await queued()).toEqual([]);
  expect(await armedAlarm()).toBeNull();
  // Where a revocation filed against no org would land if neither guard held it back.
  expect(await store.auditForOrg("null", 10)).toEqual([]);
});

/**
 * Make one kind of write fail, wherever it is made: through the object's storage or
 * through a transaction opened on it, which is what an edit that moved the queuing
 * out of the transaction would use. They live on that instance, and the abort in
 * afterEach discards them.
 */
const failWritesTo = (prefix: string, onFail: () => void) =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const wrap = (store: DurableObjectStorage | DurableObjectTransaction) => {
      const write = (store as unknown as { put: Call }).put.bind(store);
      Object.defineProperty(store, "put", {
        configurable: true,
        value: (...args: unknown[]) => {
          const entries = args[0];
          if (typeof entries === "object" && entries !== null
            && Object.keys(entries).some((k) => k.startsWith(prefix))) {
            onFail();
            throw new Error("interrupted");
          }
          return write(...args);
        },
      });
    };
    const storage = ctx.storage;
    wrap(storage);
    const open = (storage as unknown as { transaction: Call }).transaction.bind(storage);
    Object.defineProperty(storage, "transaction", {
      configurable: true,
      value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        open((txn: DurableObjectTransaction) => {
          wrap(txn);
          return closure(txn);
        }),
    });
  });

/**
 * The whole point of the module. The grant change and the intent to record it are
 * one commit: if the write that carries one fails, the other must not be left
 * behind, in either direction. A grant with no row is the lost record. A row with
 * no grant is an entry for a change that never happened.
 *
 * Which write fails is chosen by what it carries. Failing the row writes catches a
 * queue filled in a commit of its own after the grant's; failing the grant writes
 * catches one filled before it. Both are one write today, so each fails the same
 * way, and the assertions cover both ends.
 */
it.each([
  {
    name: "a grant write whose rows cannot be written", prefix: OUTBOX_PREFIX,
    seed: false,
    run: (s: DurableObjectStore) => s.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }),
  },
  {
    name: "a grant write that fails ahead of its rows", prefix: "gr:",
    seed: false,
    run: (s: DurableObjectStore) => s.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" }),
  },
  {
    name: "a delete whose rows cannot be written", prefix: OUTBOX_PREFIX,
    seed: true,
    run: (s: DurableObjectStore) => s.deleteGrantIfSource("github:4242", "operator", { actorUserId: "u_admin" }),
  },
])("commits $name together or not at all", async ({ prefix, seed, run }) => {
  const store = new DurableObjectStore(env as never);
  if (seed) await store.putGrant(grant());
  const before = await store.getGrant("github:4242");
  let attempts = 0;
  await failWritesTo(prefix, () => { attempts++; });

  await expect(run(store)).rejects.toThrow(/interrupted/);

  // The write the hook fails was made. Without it the rest proves nothing.
  expect(attempts).toBeGreaterThan(0);
  expect(await store.getGrant("github:4242")).toEqual(before);
  expect(await queued()).toEqual([]);
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
  // The alarm armed for the rows went back with them.
  expect(await armedAlarm()).toBeNull();
});

/**
 * An entry that landed whose acknowledgement was lost leaves its row queued, and
 * the retry delivers it again. The intent id the row carries is what the stream
 * recognises it by, so it has to go with every delivery and be the same one each
 * time.
 */
it("does not append an entry twice when its delivery is repeated", async () => {
  const store = new DurableObjectStore(env as never);
  await deliveryOff();
  await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" });
  await deliveryOn();
  const [row] = await queuedRows();

  await auditStream("org_mine").append(row.payload as AuditEntry, row.id);
  expect(await store.auditForOrg("org_mine", 10)).toHaveLength(1);

  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect(await store.auditForOrg("org_mine", 10)).toHaveLength(1);
  expect(await queued()).toEqual([]);
});

/**
 * One alarm clears everything queued, in the order it was queued, and no two
 * intents share an id: a stream that recognises an id it has seen would otherwise
 * drop the later entry as a repeat of the earlier one.
 */
it("delivers every queued entry, in the order they were queued", async () => {
  const store = new DurableObjectStore(env as never);
  await deliveryOff();
  for (const key of ["github:1", "github:2", "github:3"]) {
    await store.putGrantIfOwned(grant({ key }), "org_mine", { actorUserId: "u_admin" });
  }
  // The second and third write find the first one's marker still due, and the earliest
  // due time wins, so they arm the alarm for now. It would fire on its own and race the
  // explicit run below, which then finds nothing scheduled. Park it far ahead; the test
  // is the one to fire it.
  await runInDurableObject(registry(), (_i: RegistryDO, ctx) =>
    ctx.storage.setAlarm(Date.now() + 60_000));
  expect(await queued()).toHaveLength(3);
  await abortAllDurableObjects();

  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect((await store.auditForOrg("org_mine", 10)).map((e) => e.detail.key))
    .toEqual(["github:1", "github:2", "github:3"]);
  expect(await queued()).toEqual([]);
});

/**
 * Nothing but audit entries is queued today, and a row of any other kind is not
 * something this object knows how to deliver. It has to stay queued: an entry
 * with no org is dropped as undeliverable, and a payload that is not an entry
 * would read as one.
 */
it("keeps a row of a kind it cannot deliver, rather than dropping it", async () => {
  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    await ctx.storage.put<unknown>({
      [outboxKey(0)]: { id: "x", kind: "mystery", payload: {}, attempts: 0 } satisfies OutboxRow,
      [dueKey(OUTBOX_HANDLER)]: Date.now() - 1,
    });
    await ctx.storage.setAlarm(Date.now() + 60_000);
  });

  expect(await runDurableObjectAlarm(registry())).toBe(true);

  // Tried once, and still here.
  expect(await queuedRows()).toMatchObject([{ id: "x", kind: "mystery", attempts: 1 }]);
});

/**
 * `deliver`'s own guard, on its own. grantAuditEntries never builds an entry with no
 * org, so while its guard holds nothing reaches `deliver` to try the second one on,
 * and the tests above cannot tell whether it is there. A row written by other code,
 * or by this code on some other day, is what it exists for. Seeded straight into the
 * queue, each would be filed in a stream named for its missing org: `idFromName` takes
 * null, "" and undefined and gives each a name.
 */
it("drops a queued entry that names no org, instead of filing it under a name", async () => {
  const store = new DurableObjectStore(env as never);
  const entry = (orgId: unknown) => ({
    at: 1, orgId, sessionId: "grant:github:4242", actorUserId: "u_admin",
    action: "plan_granted", detail: { key: "github:4242" },
  });
  await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    await ctx.storage.put<unknown>({
      [outboxKey(0)]: { id: "a", kind: "audit", payload: entry(null), attempts: 0 },
      [outboxKey(1)]: { id: "b", kind: "audit", payload: entry(""), attempts: 0 },
      [outboxKey(2)]: { id: "c", kind: "audit", payload: entry(undefined), attempts: 0 },
      [dueKey(OUTBOX_HANDLER)]: Date.now() - 1,
    });
    await ctx.storage.setAlarm(Date.now() + 60_000);
  });

  expect(await runDurableObjectAlarm(registry())).toBe(true);

  // Taken off the queue, so the alarm did reach them, and filed nowhere.
  expect(await queued()).toEqual([]);
  for (const name of ["null", "", "undefined"]) {
    expect(await store.auditForOrg(name, 10)).toEqual([]);
  }
});

/**
 * Make an org's audit object slow, or unable to take an entry, from the inside: its
 * every append opens a transaction, so that is where it is held up or refused.
 */
const misbehaving = (orgId: string, how: { down: boolean; delayMs: number }) =>
  runInDurableObject(auditStream(orgId), async (_i: AuditDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const open = (ctx.storage as unknown as { transaction: Call }).transaction.bind(ctx.storage);
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: async (...args: unknown[]) => {
        if (how.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, how.delayMs));
        if (how.down) throw new Error("audit object down");
        return open(...args);
      },
    });
  });

/**
 * #59 as it happens. The delete commits, the audit object cannot take the entry,
 * and the caller must still be told the delete happened: its retry would find
 * nothing to delete and answer "missing", and could never record the revocation.
 * The entry stays queued and the alarm brings it later.
 */
it("keeps the entry, and still answers, when the audit object is down", async () => {
  const store = new DurableObjectStore(env as never);
  const audit = { down: true, delayMs: 0 };
  await misbehaving("org_mine", audit);
  await store.putGrant(grant());

  expect(await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_admin" }))
    .toBe("deleted");

  expect(await store.getGrant("github:4242")).toBeUndefined();
  // Tried, and refused: the attempt count is how this knows the hook did the refusing.
  expect(await queuedRows()).toMatchObject([{ kind: "audit", attempts: 1 }]);
  expect(await store.auditForOrg("org_mine", 10)).toEqual([]);

  // The audit object comes back, and the time the retry was set for arrives. The
  // backoff is the driver's; this only lets it elapse.
  audit.down = false;
  await runInDurableObject(registry(), (_i: RegistryDO, ctx) =>
    ctx.storage.put({ [dueKey(OUTBOX_HANDLER)]: Date.now() - 1 }));
  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect(await actionsFor(store, "org_mine")).toEqual(["plan_revoked"]);
  expect(await queued()).toEqual([]);
});

/**
 * The entry is in the stream when the caller hears back, even when the stream takes
 * its time, for each of the four writes. A delivery that was started and not waited
 * for would return while the entry was still on its way, and the read that follows
 * would find nothing. Without the delay that read usually wins the race anyway, which
 * is why the first test above cannot be the one that pins this.
 */
it.each(FOUR_WRITES)(
  "$name answers only after the entry is in the stream, however slow the stream is",
  async ({ run, action }) => {
    const store = new DurableObjectStore(env as never);
    await misbehaving("org_mine", { down: false, delayMs: 150 });

    await run(store, { actorUserId: "u_admin" });

    expect(await actionsFor(store, "org_mine")).toEqual([action]);
  }
);

/**
 * Delivery waits for the audit object, and nothing may hold the registry while it
 * does. Every other call to this object waits for a transaction closure to commit,
 * so a delivery made inside one would hold every plan lookup, which is what each
 * sign-in does, for as long as the audit object takes to answer. By then the write
 * has committed, and a read is served while the entry is still on its way. For each
 * of the four writes, because each has a transaction of its own.
 */
it.each(FOUR_WRITES)(
  "$name serves other calls while it waits for the audit object",
  async ({ run, visible }) => {
    const store = new DurableObjectStore(env as never);
    await misbehaving("org_mine", { down: false, delayMs: 500 });

    const started = Date.now();
    const write = run(store, { actorUserId: "u_admin" });
    // Past the commit, inside the delivery.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const read = await store.getGrant("github:4242");
    const readTook = Date.now() - started;
    await write;
    const writeTook = Date.now() - started;

    // The change is already there, and the entry is not.
    if (visible) expect(read).toMatchObject({ orgId: "org_mine" });
    else expect(read).toBeUndefined();
    expect(readTook).toBeLessThan(350);
    // The delivery did take that long, or being served early says nothing.
    expect(writeTook).toBeGreaterThanOrEqual(450);
  }
);

/**
 * After an inline delivery the backstop is still armed, and when it fires it finds
 * nothing to do. It must not deliver the entry a second time, and it must not leave
 * itself armed: an alarm that re-arms for an empty queue never stops.
 */
it("lets the backstop fire on an empty queue, and arms nothing after it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.putGrantIfOwned(grant(), "org_mine", { actorUserId: "u_admin" });
  // There is a backstop to fire, so the emptiness after it is not "never armed".
  expect(await armedAlarm()).not.toBeNull();

  expect(await runDurableObjectAlarm(registry())).toBe(true);

  expect(await armedAlarm()).toBeNull();
  expect(await actionsFor(store, "org_mine")).toEqual(["plan_granted"]);
  expect(await queued()).toEqual([]);
});

/**
 * The methods that do what no caller should be able to ask for directly are `#private`,
 * not TypeScript-`private`. The latter is erased, and a Durable Object answers RPC for
 * every method on its class: `deliver` would file an entry in any org's stream, and a
 * `*Txn` half would commit a grant change and leave its entry undelivered. A plain stub
 * must not reach them, and must reach a method that is meant to be public.
 */
it("does not answer over RPC for the methods that must stay internal", async () => {
  const stub = registry() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // A public method answers, so a refusal below is about the method and not the stub.
  expect(await stub.getGrant("github:nobody")).toBeUndefined();

  const internal = [
    "deliver", "auditIntents", "putGrantIfOwnedTxn", "deleteGrantIfOwnedTxn",
    "putGrantIfSourceTxn", "deleteGrantIfSourceTxn",
  ];
  for (const name of internal) {
    const outcome = await stub[name]({}).then(() => "answered", (err: unknown) => String(err));
    expect(outcome, name).toMatch(/does not implement/);
  }
  // None of them ran.
  expect(await queued()).toEqual([]);
  expect(await armedAlarm()).toBeNull();
});

/**
 * `dropGrant` deletes both copies of whatever grant it is handed, and it is `#private` for
 * the same reason: a TypeScript `private` one answers RPC, and nothing outside this class
 * calls it, so it has no reason to answer. That is a narrowing, not a defence — `deleteGrant`
 * is public because `BellmanStore` declares it, and over a stub it removes a live grant just
 * as well. Keeping `dropGrant` private does not put a customer's plan out of reach. The grant below is live and
 * org-scoped, and a drop that ran would take it out of the lookup by key and out of its
 * org's listing. It is refused, and the grant is still there under both.
 */
it("does not answer over RPC for the method that deletes a grant", async () => {
  const store = new DurableObjectStore(env as never);
  await store.putGrant(grant());
  const stub = registry() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // A public method answers, so the refusal below is about the method and not the stub.
  expect(await stub.getGrant("github:4242")).toMatchObject({ key: "github:4242" });

  const outcome = await stub.dropGrant(grant()).then(() => "answered", (err: unknown) => String(err));

  expect(outcome).toMatch(/does not implement/);
  // It did not run.
  expect(await store.getGrant("github:4242")).toMatchObject({ plan: "team", orgId: "org_mine" });
  expect(await store.listGrants(10, "org_mine")).toHaveLength(1);
});
