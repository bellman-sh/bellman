/**
 * A room that closes while the upgrade is in flight does not get a socket (#133).
 *
 * `/ws` is two invocations of one object: `membersOf`, which authorizes the watch,
 * and then `fetch`, which accepts the socket. The input gate makes each atomic and
 * says nothing about the pair, so a close — or the TTL alarm — lands in the gap, and
 * before this fix `fetch` never looked again. The socket was accepted onto a closed
 * room and stayed, because the close that would have ended it had already happened.
 *
 * The refusal that defeats is deliberate and stricter than the poll path's. A
 * `bellman_sync` onto a closed room is served and lasts 25 seconds; `/ws` refuses,
 * because a socket lasts as long as the process does (design D6). So this is not a
 * cosmetic status code — it is the only thing between a closed room and an unbounded
 * delivery channel into it.
 *
 * THE CLOSE LANDS IN THE REAL GAP. The route runs end to end through `SELF.fetch`:
 * real auth, real `membersOf`, the request the Worker itself builds. What the test
 * adds is a hold at the entry to `SessionDO.fetch`, before its first read, which is
 * where the gap is. Held there, the test commits the close through the ordinary
 * store, releases, and reads what the route answered. Neither the request nor the
 * sequence is reconstructed by hand.
 *
 * The hold is a timer await, which is why the close gets in: the input gate holds
 * other calls off only while a storage operation is outstanding (see `stored()` in
 * store-do.ts), and a parked timer is not one. That is the production gap rather
 * than an artefact of the test — the same gap the Worker leaves between its two
 * calls, moved somewhere a test can reach.
 *
 * Reverting the recheck in `SessionDO.fetch` turns both cases red: 101, and a socket
 * accepted onto a closed room.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  env, SELF, reset, abortAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { Session } from "../src/types.js";
import { session } from "../tests/helpers/fixtures.js";

/** The key worker-tests/vitest.config.ts binds. Its identity is the creator fixtures.ts seats. */
const KEY = "qk_ws_test";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, or fail the test instead of hanging it. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(2);
  }
}

interface Hold {
  held: boolean;
  released: boolean;
  release(): void;
}

const holds: Hold[] = [];
const undo: (() => void)[] = [];

/**
 * Hold the upgrade at the entry to `SessionDO.fetch`, before its first read: the gap
 * between the Worker's `membersOf` and the accept.
 *
 * It patches the class's prototype, as session-close-join-race.test.ts does and for
 * the same reason — a Durable Object answers RPC from its prototype, so an override
 * set on the instance is never called. The wait polls a timer, because what it waits
 * for can only be changed by another request.
 */
async function holdTheUpgrade(id: string): Promise<Hold> {
  const hold: Hold = { held: false, released: false, release: () => { hold.released = true; } };
  holds.push(hold);
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  await runInDurableObject<SessionDO, void>(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      fetch: (request: Request) => Promise<Response>;
    };
    const real = proto.fetch;
    proto.fetch = async function (this: SessionDO, request: Request) {
      hold.held = true;
      await until(() => hold.released, "the upgrade to be released", 15_000);
      return real.call(this, request);
    };
    undo.push(() => { proto.fetch = real; });
  });
  return hold;
}

afterEach(async () => {
  // Release before restoring, so a test that failed while holding does not leave the
  // patched fetch waiting on a flag nothing will ever set.
  for (const hold of holds.splice(0)) hold.release();
  await sleep(50);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

let rooms = 0;

/** An open room in the real SessionDO, seating the identity KEY authenticates as. */
async function room(over: Partial<Session> = {}) {
  const store = new DurableObjectStore(env as never);
  const s = session({ id: `qs_close_race_${++rooms}`, ...over });
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

/** The upgrade through the real route: auth, membersOf, then the object. */
const upgrade = (id: string) =>
  SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });

/** How many sockets the object is holding. One is one too many here. */
const socketCount = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_instance, state) => state.getWebSockets().length);

/**
 * Refused, and with nothing accepted. The status alone is not enough: a response
 * carrying a socket the object also kept is the whole defect, 409 or not.
 */
async function expectRefused(res: Response, stub: DurableObjectStub): Promise<void> {
  // The body carries the reason and belongs in the failure message, but a 101
  // handshake response can be neither read nor cloned — and 101 is precisely the
  // failure being reported. So name that instead of trying to read it.
  const reason = res.status === 101 ? "an accepted socket onto a closed room" : await res.text();
  expect(res.status, reason).toBe(409);
  expect(res.webSocket, "a refusal hands back no socket").toBeFalsy();
  expect(await socketCount(stub), "the object accepted nothing").toBe(0);
}

describe("an upgrade overtaken by a close", () => {
  it("is refused when the close commits after membersOf said the room was open", async () => {
    const { id, store, stub } = await room();
    const hold = await holdTheUpgrade(id);

    const res = upgrade(id); // auth, membersOf (open), then held at the object
    await until(() => hold.held, "the upgrade to reach the object");

    // The close the Worker's membersOf could not have seen. It commits while the
    // upgrade waits, and it is the close that nothing would be left to repeat.
    await store.closeSession(id);
    expect((await store.getSession(id))!.closed, "the close committed").toBe(true);

    hold.release();
    await expectRefused(await res, stub);
  });

  it("is refused when the room lapses past its TTL while the upgrade waits", async () => {
    // The window the issue calls the likeliest, and no close is called at all: the
    // clock simply crosses expiresAt. membersOf read the room before it, the recheck
    // runs after. Whether the alarm also got in and wrote closed=true is neither
    // asserted nor needed — either way the room reads closed and the refusal is one.
    const expiresAt = Date.now() + 500;
    const { id, stub } = await room({ expiresAt });
    const hold = await holdTheUpgrade(id);

    const res = upgrade(id);
    await until(() => hold.held, "the upgrade to reach the object");
    await until(() => Date.now() > expiresAt, "the room's TTL to pass", 5_000);

    hold.release();
    await expectRefused(await res, stub);
  });
});
