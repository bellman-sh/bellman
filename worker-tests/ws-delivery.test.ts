/**
 * Delivery survives the object being evicted and revived — in real workerd,
 * against the real /ws route (worker-tests/wrangler.toml sets
 * main = "../src/worker.ts").
 *
 * THE TEARDOWN IS evictAllDurableObjects(), NOT abortAllDurableObjects(), which
 * is what store-contract.test.ts uses and what this file was first written
 * around. Measured in this pool (0.22.0, workerd 1.20260926.1): abort is a
 * crash, not hibernation. It closes every accepted socket (the client sees
 * close 1006, "WebSocket disconnected without sending Close frame", unclean) and
 * nothing appended afterwards can reach it. Evict is the graceful teardown, and
 * with its default `webSockets: "hibernate"` the socket stays open while the
 * instance is torn down, which is what idle eviction does to a real object.
 *
 * What that leaves for a long-poll waiter: eviction waits for in-flight
 * requests to drain, and a waiter IS an in-flight request. Measured: a 4 s poll
 * held evictAllDurableObjects() for 3.7 s and resolved empty at its own timeout.
 * So production does not evict an object with a poll in flight, and the only way
 * to tear an instance down with a waiter registered is abort. The second case
 * therefore uses abort, and pins the other half: in-memory waiter state does not
 * carry across a teardown, which is what the socket arm exists to cover.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  env, SELF, reset, abortAllDurableObjects, evictAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import { session } from "../tests/helpers/fixtures.js";

// See abortAllDurableObjects() in store-contract.test.ts for why both calls.
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** The key vitest.config.ts binds. Its identity is the creator fixtures.ts seats. */
const KEY = "qk_ws_test";

/** A room in the real SessionDO, and a way to append to it as its creator. */
async function room(id?: string) {
  const store = new DurableObjectStore(env as never);
  const s = session(id ? { id } : {});
  await store.createSession(s);
  const append = (text: string) =>
    store.appendEvent(s.id, {
      type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
      fromLabel: "jesse@codenerd", payload: { text }, refId: null,
    });
  const stub = env.SESSION.get(env.SESSION.idFromName(s.id));
  return { id: s.id, store, append, stub };
}

/** The upgrade, through the real route: auth, membersOf, then the object. */
const upgrade = (id: string, cursor = 0) =>
  SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=${cursor}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });

/** Accept the client end and collect what arrives. */
function collect(res: Response): string[] {
  const frames: string[] = [];
  const ws = res.webSocket!;
  ws.accept();
  ws.addEventListener("message", (e) => frames.push(String(e.data)));
  return frames;
}

const texts = (frames: string[]) => frames.map((f) => JSON.parse(f).payload.text);

describe("delivery across eviction", () => {
  it("a socket still receives after the object is evicted and revived", async () => {
    const { id, append, stub } = await room();
    const res = await upgrade(id);
    expect(res.status).toBe(101);
    const frames = collect(res);

    // Mark the instance that accepted the socket. Evict skips an object that is
    // not running, so without this a no-op eviction would pass the case below.
    await runInDurableObject(stub, (instance) => { (instance as unknown as { warm: boolean }).warm = true; });

    // THE TEARDOWN. The instance goes; the socket, held by the runtime, stays.
    await evictAllDurableObjects();

    // Appending revives the object. wake() has to find the socket on the
    // rebuilt instance through ctx.getWebSockets(), not through instance state.
    await append("after eviction");

    await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 3000 });
    expect(JSON.parse(frames[0]).payload).toEqual({ text: "after eviction" });

    // The instance that delivered it is not the one that was marked.
    const stillWarm = await runInDurableObject(stub, (instance) => (instance as unknown as { warm?: boolean }).warm);
    expect(stillWarm).toBeUndefined();
  });

  it("a long-poll waiter does NOT survive a teardown", async () => {
    // The other half. If a waiter also survived, the case above would show
    // nothing about hibernation: both arms would just be durable.
    const { id, store, append } = await room();
    const polling = store.waitForEvents(id, 0, 20_000).then(
      (events) => ({ events }),
      (error: unknown) => ({ error: String(error) }),
    );
    // Let the poll reach the object and register before it is torn down.
    await new Promise((r) => setTimeout(r, 200));

    await abortAllDurableObjects();
    await append("after teardown");

    // The poll died with its instance. It was not woken by the append: it
    // rejected at the teardown, before the append existed, and was not left to
    // resolve empty at its own timeout.
    const outcome = await polling;
    expect(outcome).toEqual({ error: expect.stringContaining("abortAllDurableObjects") });
    // And the append did happen, so "not woken" is not "nothing was appended".
    expect(await store.eventsAfter(id, 0)).toHaveLength(1);
  });
});

describe("delivery racing an upgrade", () => {
  it("an event appended while a socket is connecting is delivered exactly once", async () => {
    /**
     * D5's premise, and the only place it can be checked. fetch reads the
     * missed events, attaches and accepts inside ONE invocation, and the input
     * gate holds every other request to the object for that duration. So an
     * append racing the upgrade either lands before the read, and is replayed,
     * or after the registration, and is sent as a frame. What it cannot do is
     * fall between them, which would drop it silently.
     *
     * This is the socket form of CLAUDE.md's read-and-register rule. The long
     * poll has a test for the same property; this is that test for sockets.
     */
    /**
     * Swept, not repeated. The append goes out `lag` ms after the upgrade
     * starts, for each lag from 0 up. At 0 it beats the object's read and is
     * replayed (checked: with wake()'s socket loop disabled, the racing frame
     * still arrives at 0), so twenty runs at one lag would be twenty runs of
     * one ordering. The lags walk the append across the upgrade's duration
     * instead, so it lands before the read, around it, and after the
     * registration.
     */
    const lags = Array.from({ length: 21 }, (_, i) => i);
    const wrong: string[] = [];
    for (const lag of lags) {
      const { id, append } = await room(`qs_race_${lag}`);
      const racing = () => append("racing the upgrade");
      const [res] = await Promise.all([
        upgrade(id),
        lag === 0 ? racing() : new Promise((r) => setTimeout(r, lag)).then(racing),
      ]);
      const frames = collect(res);

      // Whether it was replayed or pushed, it must arrive, and once. Both
      // appends have returned, so a second copy of the first would already be
      // on the socket, ahead of the sentinel. The sentinel is what makes
      // "once" checkable: the list is complete when it shows up.
      await append("sentinel");
      await vi.waitFor(() => expect(texts(frames)).toContain("sentinel"), { timeout: 3000 }).catch(() => {});
      if (JSON.stringify(texts(frames)) !== JSON.stringify(["racing the upgrade", "sentinel"])) {
        wrong.push(`lag ${lag}ms received ${JSON.stringify(texts(frames))}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
