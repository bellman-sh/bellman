/**
 * A lift answers false for a string that is not a ban id before it reads storage (abuse protections
 * spec, section 1). The id arrives from a creator, and Durable Object storage limits a key to 2 KiB,
 * so a lift that went on to read a longer one could fail where MemoryStore answers false.
 *
 * The contract suite pins the answer in both stores and cannot see this. The workerd these tests run in
 * enforces no key limit: a probe read, wrote, listed and deleted a 100,000 character key without a throw.
 * So a lift with no guard answers false here too, and what the guard changes is whether storage was
 * touched. That is what this counts, as the number of transactions the lift opens.
 *
 * Its control is a well-formed id that no ban holds. That lift must open one transaction, or the
 * wrapper is not seeing the lift and the zero above says nothing.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { RegistryDO, SessionDO } from "../src/store-do.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** Not ban ids: near misses, and two past 2 KiB. */
const NOT_BAN_IDS = ["", "ban_", "ban_0123456789abcde", "ban_0123456789abcdef0", "x".repeat(3_000), `ban_${"0".repeat(3_000)}`];
/** Well formed, and no ban's. */
const NO_SUCH_BAN = "ban_0000000000000000";

/** The transactions `ctx.storage` has opened since this was called. */
function transactionsOpened(ctx: DurableObjectState): () => number {
  let opened = 0;
  const real = ctx.storage.transaction.bind(ctx.storage);
  Object.defineProperty(ctx.storage, "transaction", {
    configurable: true,
    value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) => {
      opened++;
      return real(closure);
    },
  });
  return () => opened;
}

it("SessionDO.liftRoomBan opens no transaction for a string that is not a ban id", async () => {
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_ban_id_guard"));
  await runInDurableObject(stub, async (room: SessionDO, ctx) => {
    const opened = transactionsOpened(ctx);
    for (const id of NOT_BAN_IDS) expect(await room.liftRoomBan(id), id.slice(0, 24)).toBe(false);
    expect(opened(), "no transaction was opened").toBe(0);
    expect(await room.liftRoomBan(NO_SUCH_BAN), "the control: a well-formed id is looked up").toBe(false);
    expect(opened(), "the control: and the wrapper sees the lookup").toBe(1);
  });
});

it("RegistryDO.liftCreatorBan opens no transaction for a string that is not a ban id", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("registry_ban_id_guard"));
  await runInDurableObject(stub, async (registry: RegistryDO, ctx) => {
    const opened = transactionsOpened(ctx);
    for (const id of NOT_BAN_IDS) expect(await registry.liftCreatorBan("u_jesse", id), id.slice(0, 24)).toBe(false);
    expect(opened(), "no transaction was opened").toBe(0);
    expect(await registry.liftCreatorBan("u_jesse", NO_SUCH_BAN), "the control: a well-formed id is looked up").toBe(false);
    expect(opened(), "the control: and the wrapper sees the lookup").toBe(1);
  });
});
