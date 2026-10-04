/**
 * The real runtime holds the keepalive registration, and it is the shared pair
 * (#144).
 *
 * tests/store-do-wiring.test.ts pins the CALL: it builds a real SessionDO over a
 * fake ctx and reads back what `setWebSocketAutoResponse` was handed. What it
 * cannot say is that workerd accepted it, because its ctx is a stub that keeps
 * whatever it is given. This reads the pair back out of a real
 * `DurableObjectState` with `getWebSocketAutoResponse()`, so the assertion is
 * about the runtime's own state rather than about our argument.
 *
 * That distinction is the one the registration's comment says matters: without
 * it a client keepalive reaches the object, and a ping to an evicted one revives
 * it (measured), which undoes the saving the hibernating socket exists for.
 * Delivery still works, so nothing on the delivery path would show it — the
 * cost is hibernation and an unmeasured billing risk, which is exactly the kind
 * of defect only a direct assertion catches.
 *
 * No session is created. The registration happens in the constructor, before
 * any storage read, so a bare object already has it — which is also the claim
 * about WHERE it is registered (see SessionDO's constructor).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  env, reset, abortAllDurableObjects, evictAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import type { SessionDO } from "../src/store-do.js";
import { PING, PONG } from "../src/keepalive.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const sessionStub = (name: string) => env.SESSION.get(env.SESSION.idFromName(name));

describe("the keepalive auto-response, in real workerd", () => {
  it("is registered on a freshly built object, before any socket exists", async () => {
    const pair = await runInDurableObject(
      sessionStub("qs_keepalive"),
      (_i: SessionDO, ctx) => ctx.getWebSocketAutoResponse(),
    );

    expect(pair).not.toBeNull();
    // The same two constants src/room-socket.ts sends and the fake answers, so
    // the client cannot be closed 1003 at its first keepalive by a drift.
    expect(pair!.request).toBe(PING);
    expect(pair!.response).toBe(PONG);
  });

  it("survives the object being evicted and revived", async () => {
    // The pair belongs to the object in the runtime, not to this instance, and
    // SessionDO's constructor records that a revived object whose constructor
    // had not set it still had it. A socket outlives the instance that accepted
    // it, so the keepalive answering it has to outlive that instance too.
    //
    // evictAllDurableObjects(), not abortAllDurableObjects(): abort is a crash,
    // and it leaves the stub throwing "Application called
    // abortAllDurableObjects()" for every later call, so the read below could
    // not happen (measured here). Evict is the graceful teardown — the same
    // choice, for a related reason, as ws-delivery.test.ts. Evict also skips an
    // object that is not running, which is what the marker is for: without it a
    // no-op eviction would pass this case.
    const stub = sessionStub("qs_keepalive_revived");
    await runInDurableObject(stub, (i: SessionDO) => {
      (i as unknown as { warm: boolean }).warm = true;
    });
    await evictAllDurableObjects();

    const after = await runInDurableObject(
      stub, (_i: SessionDO, ctx) => ctx.getWebSocketAutoResponse());
    const stillWarm = await runInDurableObject(
      stub, (i: SessionDO) => (i as unknown as { warm?: boolean }).warm);

    expect(stillWarm).toBeUndefined();
    expect(after?.request).toBe(PING);
    expect(after?.response).toBe(PONG);
  });
});
