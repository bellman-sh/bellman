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
 * So in this pool the only way to tear an instance down with a waiter registered
 * is abort, and the second case uses it. That makes it a weaker pin than "the
 * same teardown" would be: it shows in-memory waiter state does not carry across
 * a teardown, which is what the socket arm exists to cover, and it is mostly a
 * fact about the runtime rather than about SessionDO.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  env, SELF, reset, abortAllDurableObjects, evictAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import { evictMember } from "../src/rooms.js";
import type { Identity, Member, Session } from "../src/types.js";
import { member, session } from "../tests/helpers/fixtures.js";

// See abortAllDurableObjects() in store-contract.test.ts for why both calls.
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** The key vitest.config.ts binds. Its identity is the creator fixtures.ts seats. */
const KEY = "qk_ws_test";

/**
 * A room in the real SessionDO, and a way to append to it as its creator. `over`
 * reshapes the room the way `session()` takes it: the removal cases below need a
 * roster of their own.
 */
async function room(id?: string, over: Partial<Session> = {}) {
  const store = new DurableObjectStore(env as never);
  const s = session({ ...(id ? { id } : {}), ...over });
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

describe("the fan-out is not reachable over RPC", () => {
  it("does not answer over RPC for the method that sends an event to the sockets", async () => {
    /**
     * wake() resolves the waiting polls and sends a frame to every socket in the room,
     * with the event it is handed. It is `#private`: a Durable Object answers RPC for
     * every method on its class and TypeScript's `private` is erased at compile time, so
     * a `private` one would let anything holding the SESSION binding put an event in
     * front of every watching member that was never stored and never will be. Only the
     * Worker holds that binding today, so this is surface and not a hole.
     *
     * The forged event is what a wake that ran would deliver, and its cursor is the
     * room's next one. Delivered, it would also move every socket's cursor to 1, and the
     * real event that follows, which is also cursor 1, would be skipped as already seen.
     * So the assertions are two: the call is refused, and the socket's first and only
     * frame is the real one. The second is the state check behind the first, and it is
     * what fails if the refusal were ever satisfied for the wrong reason.
     *
     * join-code-outbox.test.ts pins the poll arm of the same method. This is the socket arm.
     */
    const { id, append, stub } = await room();
    const frames = collect(await upgrade(id));
    const rpc = stub as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    // A public method answers, so the refusal below is about the method and not the stub.
    expect(await rpc.eventsAfter(0)).toEqual([]);

    const forged = {
      cursor: 1, type: "message", fromMemberId: "m_forged", fromUserId: "u_forged",
      fromLabel: "forged", payload: { text: "forged" }, refId: null, at: 1,
    };
    const outcome = await rpc.wake(forged).then(() => "answered", (err: unknown) => String(err));
    expect(outcome).toMatch(/does not implement/);

    // It did not run. A real append is what the socket receives: its one frame, with the
    // real text, and nothing forged ahead of it.
    await append("real");
    await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 3000 });
    expect(texts(frames)).toEqual(["real"]);
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

/**
 * A creator removes a member, and the socket that member holds goes with it (#113).
 *
 * "Evict" in this block is the room operation, `bellman_evict`: a creator taking a
 * member out of a room. It is not `evictAllDurableObjects()`, the runtime dropping an
 * object from memory, which is what the first block of this file is about. The two
 * never meet here. Nothing below tears the object down, because a case that asks
 * whether a socket is still OPEN would then be answered by the teardown and not by
 * the code under test (see the header, and why abort is not used).
 *
 * Every socket in this block authenticates as the identity KEY resolves to, u_jesse,
 * so the roster is what decides what that identity may watch: `mine()` seats a handle
 * it owns and `boss()` is the creator who does the removing. The removal is appended
 * through the store wrapper, as evictMember does, because only the wrapper takes a
 * session id. `membersOf` and the attachments are read off the object itself.
 */
let removals = 0;

/** The room's creator. Another user than the one KEY resolves to, which is who gets removed. */
const boss = () =>
  member({ memberId: "m_boss", userId: "u_boss", label: "boss@elsewhere", roomRole: "peer_a" });

/** A handle owned by the identity KEY resolves to, so a socket opened here is entitled by it. */
const mine = (memberId: string, over: Partial<Member> = {}) =>
  member({ memberId, userId: "u_jesse", label: "jesse@codenerd", roomRole: "peer_b", ...over });

/**
 * A room in the real SessionDO that `boss()` created, with these seats beside them. No join
 * code: the cases are about sockets, and a live code would add a door-shutting event to every
 * real removal.
 */
const roomOf = (...seats: Member[]) =>
  room(`qs_removal_${++removals}`, {
    createdBy: "u_boss", joinCodes: {}, members: [boss(), ...seats],
  });

/** The creator speaking: what the member removed must stop hearing. */
const say = (store: DurableObjectStore, id: string, text: string) =>
  store.appendEvent(id, {
    type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
    fromLabel: "boss@elsewhere", payload: { text }, refId: null,
  });

/** What evictMember appends (src/rooms.ts), shape for shape. */
const removal = (memberId: string) => ({
  type: "member_evicted" as const,
  fromMemberId: "system", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
  payload: { member_id: memberId, label: "jesse@codenerd", room_role: "peer_b" },
  refId: null,
});

/**
 * The removal as evictMember performs it: the announcement and the cut in one append. Through
 * the store wrapper, because SessionDO.appendEvent takes no session id.
 */
const evictThrough = (store: DurableObjectStore, id: string, memberId: string) =>
  store.appendEvent(id, removal(memberId), { markRemoved: memberId });

/**
 * The client end of a socket, accepted, with what happens to it recorded in order: a frame by
 * its event type (a message by its text, so two can be told apart) and the close by its code.
 * Order is what several cases are about, and "the notice, then the close" is two entries in a
 * row. `end` fills in when the close arrives.
 */
function watch(res: Response) {
  const ws = res.webSocket!;
  const trail: string[] = [];
  const end: { code?: number; reason?: string } = {};
  ws.accept();
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data));
    trail.push(frame.type === "message" ? `message:${frame.payload.text}` : frame.type);
  });
  ws.addEventListener("close", (e) => {
    end.code = e.code;
    end.reason = e.reason;
    trail.push(`closed:${e.code}`);
  });
  return { ws, trail, end };
}

/** The upgrade through the real route, which has to succeed here: it is the arrangement, not what is tested. */
async function open(id: string) {
  const res = await upgrade(id);
  expect(res.status, "arrangement: this identity may watch the room").toBe(101);
  return watch(res);
}

/**
 * A socket opened the way the Worker opens one, straight on the object with the member list
 * in a header, but naming whomever the caller likes. It skips the route's membersOf, so it
 * can name a member the roster does not hold, or one membersOf would no longer return.
 */
async function openNaming(stub: DurableObjectStub, memberIds: string[]) {
  const res = await stub.fetch(new Request("https://session/ws?cursor=0", {
    headers: { upgrade: "websocket", "x-bellman-members": memberIds.join(",") },
  }));
  expect(res.status, "arrangement: the object accepted the socket").toBe(101);
  return watch(res);
}

/** What the object's accepted sockets carry, as the runtime lists them. */
const attachments = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment()));

describe("a creator removes a member who holds a socket", () => {
  it("refuses a /ws upgrade to a member a creator removed", async () => {
    /**
     * membersOf drops a cut member, so the identity owns no member here and the
     * Worker's existing `memberIds.length === 0` arm answers 403. Both ends are
     * asserted: the route is what a client meets and membersOf is where the answer
     * is made. The first line is the arrangement: until the removal, this identity
     * may watch.
     */
    const { id, store, stub } = await roomOf(mine("m_target"));
    expect((await stub.membersOf("u_jesse")).memberIds).toEqual(["m_target"]);

    await evictThrough(store, id, "m_target");

    expect((await upgrade(id)).status).toBe(403);
    expect((await stub.membersOf("u_jesse")).memberIds).toEqual([]);
  });

  it("still lets in a member who left of their own accord", async () => {
    /**
     * R2 on the socket arm. A member who left and one whose seat timed out both have
     * `leftAt` set and both keep the open feed, so membersOf filters on
     * `removedAtCursor` and NOT on isActiveMember. This is the case that stops the fix
     * widening into what R2 rules out. It passes against the code before the fix, by
     * design: it is a control on the filter's predicate, not a test of the filter.
     */
    const { id, store, stub } = await roomOf(mine("m_target"));
    await store.updateMember(id, "m_target", { leftAt: Date.now() });

    expect((await stub.membersOf("u_jesse")).memberIds).toEqual(["m_target"]);
    const res = await upgrade(id);
    expect(res.status, "a member who left keeps the open feed (R2)").toBe(101);
    const watcher = watch(res);

    await say(store, id, "after they left");
    await vi.waitFor(
      () => expect(watcher.trail).toEqual(["message:after they left"]),
      { timeout: 3000 },
    );
  });

  it("closes a socket open at the moment of the removal, after the notice", async () => {
    /**
     * The notice is the last thing the member receives, and the order is the point: the
     * close follows the wake. A socket closed first reads CLOSING when the wake looks at
     * it, is skipped, and goes without the frame that says why. `trail` holds both in
     * order, so a swapped pair shows as a missing first entry.
     *
     * The readyState literals are 2 and 3 and not WebSocket.CLOSING and CLOSED, for the
     * reason store-do.ts gives where it defines WS_CLOSING and WS_CLOSED: the program may
     * have either WebSocket global.
     */
    const { id, store, stub } = await roomOf(mine("m_target"));
    const watcher = await open(id);
    expect(await attachments(stub)).toEqual([expect.objectContaining({ memberIds: ["m_target"] })]);

    await evictThrough(store, id, "m_target");

    await vi.waitFor(() => expect(watcher.end.code).toBeDefined(), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "closed:1008"]);
    // What a developer reads in their client. That it arrives at all is the 123-byte
    // ceiling checked in this runtime: ws.close() throws above it, and the throw leaves
    // the socket open.
    expect(watcher.end.reason).toMatch(/removed from this room/);
    expect([2, 3]).toContain(watcher.ws.readyState); // CLOSING, CLOSED
  });

  it("leaves the socket open when the same identity still holds a live handle", async () => {
    /**
     * Spec D5: the socket is per identity, and one live handle entitles it. That falls
     * out of the filter and the close predicate and needs no rule of its own.
     *
     * "Open" is proved by a later event arriving, not by no close having been seen. A
     * close takes a moment to reach this end, so an absence read straight after the
     * removal proves nothing; a socket the object has closed is skipped by the wake, so
     * a frame that arrives came to a socket that was open when the pass had finished.
     */
    const { id, store, stub } = await roomOf(mine("m_target"), mine("m_second"));
    const watcher = await open(id);
    expect(await attachments(stub)).toEqual([
      expect.objectContaining({ memberIds: ["m_target", "m_second"] }),
    ]);

    await evictThrough(store, id, "m_target");

    expect((await stub.membersOf("u_jesse")).memberIds).toEqual(["m_second"]);
    await say(store, id, "after");
    await vi.waitFor(() => expect(watcher.trail).toContain("message:after"), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "message:after"]);
    expect(watcher.ws.readyState).toBe(1); // OPEN
  });

  it("does not strand other sockets on an attachment it cannot resolve", async () => {
    /**
     * A socket whose attachment names a member the roster does not hold is neither
     * entitled by it nor condemned by it, so it is left alone, and the sockets around it
     * are still looked at. Nothing in a room's life produces one (the roster only grows
     * and an attachment is built from it), so one is opened by hand, on the object, the
     * way the Worker opens a socket but naming a ghost. Beside it, a socket naming the
     * member about to go.
     *
     * "Strand" only means something when the pass reaches the ghost socket BEFORE the
     * one it should close: a pass that gave up at the first attachment it could not read
     * would never get to the second. The runtime lists sockets newest first (measured,
     * workerd 1.20260926.1), but that is not something this repo controls, so the case
     * runs with each socket opened first in turn and then checks that at least one of
     * the two orders listed the ghost ahead. If a runtime ever lists in an order that
     * defeats both, that last assertion is what says so, and the case has stopped
     * proving what it claims.
     */
    let ghostListedFirst = false;
    for (const ghostOpensFirst of [true, false]) {
      const { id, store, stub } = await roomOf(mine("m_target"));
      let ghost: Awaited<ReturnType<typeof openNaming>>;
      let doomed: Awaited<ReturnType<typeof openNaming>>;
      if (ghostOpensFirst) {
        ghost = await openNaming(stub, ["m_ghost"]);
        doomed = await openNaming(stub, ["m_target"]);
      } else {
        doomed = await openNaming(stub, ["m_target"]);
        ghost = await openNaming(stub, ["m_ghost"]);
      }
      const listed = (await attachments(stub)) as { memberIds: string[] }[];
      expect(listed.map((a) => a.memberIds).flat().sort()).toEqual(["m_ghost", "m_target"]);
      if (listed[0].memberIds[0] === "m_ghost") ghostListedFirst = true;

      await evictThrough(store, id, "m_target");

      // The socket the pass should close was closed, whichever it met first.
      await vi.waitFor(() => expect(doomed.end.code).toBeDefined(), { timeout: 3000 });
      // The ghost's was left alone, and is open rather than not closed yet: a frame that
      // arrives later came to a socket the pass had finished with.
      await say(store, id, "after");
      await vi.waitFor(() => expect(ghost.trail).toContain("message:after"), { timeout: 3000 });
      expect(ghost.trail).toEqual(["member_evicted", "message:after"]);
      expect(ghost.ws.readyState).toBe(1); // OPEN
    }
    expect(ghostListedFirst, "one order has to list the ghost ahead, or nothing here can strand").toBe(true);
  });

  it("leaves a leaver's socket open when somebody else is removed", async () => {
    /**
     * The close pass's predicate is "was removed" and not "has left" (R2). A member who
     * left keeps the open feed, so a socket naming only them is entitled by that, and
     * another member's removal must not take it. The member removed here holds no socket:
     * the pass still runs, over every socket in the room, and this is one of them. It
     * passes against the code before the fix, by design, as a control on the predicate.
     */
    const other = member({
      memberId: "m_other", userId: "u_other", label: "other@elsewhere", roomRole: "peer_b",
    });
    const { id, store, stub } = await roomOf(mine("m_left", { leftAt: 12_345 }), other);
    const watcher = await open(id);
    expect(await attachments(stub)).toEqual([expect.objectContaining({ memberIds: ["m_left"] })]);

    await evictThrough(store, id, "m_other");

    await say(store, id, "after");
    await vi.waitFor(() => expect(watcher.trail).toContain("message:after"), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "message:after"]);
    expect(watcher.ws.readyState).toBe(1); // OPEN
  });

  it("closes the socket when the removal arrives as a keyed append", async () => {
    /**
     * appendEventOnce takes the same extras as appendEvent and applies the same cut, so
     * the sockets follow it too. Without this the cut would hold on one path and the
     * socket stay open on the other.
     */
    const { id, store } = await roomOf(mine("m_target"));
    const watcher = await open(id);

    const write = await store.appendEventOnce(id, removal("m_target"), "evict-0001", {
      markRemoved: "m_target",
    });

    expect(write.outcome).toBe("appended");
    await vi.waitFor(() => expect(watcher.end.code).toBeDefined(), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "closed:1008"]);
  });

  it("closes the socket when a replay is the call that writes the cut", async () => {
    /**
     * The store contract lets a retry repair a cut that never landed ("records the member
     * out on a replay"). The first attempt here asks for none, standing in for an attempt
     * interrupted before it or a row from a build without the field. The retry writes the
     * cut, and nothing else will: a socket the cut does not close is the open feed this
     * exists to shut.
     */
    const { id, store } = await roomOf(mine("m_target"));
    const watcher = await open(id);
    const first = await store.appendEventOnce(id, removal("m_target"), "evict-0001");
    expect(first.outcome).toBe("appended");
    await vi.waitFor(() => expect(watcher.trail).toEqual(["member_evicted"]), { timeout: 3000 });
    expect(watcher.end.code, "no cut yet, so no close").toBeUndefined();

    const retry = await store.appendEventOnce(id, removal("m_target"), "evict-0001", {
      markRemoved: "m_target",
    });

    expect(retry.outcome).toBe("replayed");
    await vi.waitFor(() => expect(watcher.end.code).toBeDefined(), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "closed:1008"]);
  });

  it("closes the socket when the real eviction is what removes the member", async () => {
    /**
     * The same outcome, driven by evictMember itself and not by the append it makes. What
     * ties the room operation to the close is one extra on that append, and this is the
     * case that goes red if the operation ever stops passing it.
     */
    const creator: Identity = {
      userId: "u_boss", orgId: "org_codenerd", plan: "team", role: "member", label: "boss@elsewhere",
    };
    const { id, store } = await roomOf(mine("m_target"));
    const watcher = await open(id);

    const result = await evictMember(store, creator, id, "m_target");

    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(watcher.end.code).toBeDefined(), { timeout: 3000 });
    expect(watcher.trail).toEqual(["member_evicted", "closed:1008"]);
  });

  /**
   * Both cases below watch the object's roster reads through `stored`, which is where an
   * append and the close pass each read it. A TypeScript `private`, so it is there to be
   * wrapped from `runInDurableObject`, the way the cases above mark an instance as warm.
   */
  type Spied = { stored: (...args: unknown[]) => Promise<unknown>; reads: number; failed?: boolean };

  it("reads the roster for the close pass only on an append that carried a removal", async () => {
    /**
     * The pass reads the roster, and an ordinary append must not pay for that. Counted as a
     * difference so that it does not pin how many reads an append makes: a message and a
     * removal go through the same object, and the removal makes exactly one more, the pass's
     * own. A pass that ran on every append would make the two equal.
     */
    const { id, store, stub } = await roomOf(mine("m_target"));
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as Spied;
      const real = o.stored.bind(o);
      o.reads = 0;
      o.stored = (...args) => { o.reads++; return real(...args); };
    });
    const takeReads = () => runInDurableObject(stub, (instance) => {
      const o = instance as unknown as Spied;
      const n = o.reads;
      o.reads = 0;
      return n;
    });

    await say(store, id, "an ordinary append");
    const forMessage = await takeReads();
    await evictThrough(store, id, "m_target");
    const forRemoval = await takeReads();

    expect(forMessage).toBeGreaterThan(0); // the spy is on the path, or the difference below is 0 - 0
    expect(forRemoval - forMessage).toBe(1);
  });

  it("does not fail an append that has committed when the pass cannot read the roster", async () => {
    /**
     * The cut and the announcement commit before the pass runs, so a failure in the pass
     * must not become an error for the caller: evictMember would report a removal that failed
     * when it had not, and skip the audit row it writes next. The pass's read is the second
     * the append makes (the first is inside its transaction), so that is the one made to
     * throw. What is left behind is the cost the pass's docblock names, and this case does
     * not assert it: it asserts the append and the cut, which are what the caller is owed.
     */
    const { id, store, stub } = await roomOf(mine("m_target"));
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as Spied;
      const real = o.stored.bind(o);
      let calls = 0;
      o.stored = (...args) => {
        if (++calls === 2) { o.failed = true; throw new Error("storage unavailable"); }
        return real(...args);
      };
    });

    const event = await evictThrough(store, id, "m_target");

    const hit = await runInDurableObject(stub, (instance) => (instance as unknown as Spied).failed);
    expect(hit, "arrangement: the pass's read is the one that threw").toBe(true);
    expect(event).not.toBeNull();
    const cut = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!;
    expect(cut.removedAtCursor).toBe(event!.cursor);
  });
});

describe("an upgrade the Worker authorized just before a removal", () => {
  /**
   * The route asks membersOf who the caller is and then hands the object a request built
   * from the answer. That is two calls, and a removal can commit between them, which leaves
   * the object holding a member list that was true when it was made. Neither of the other
   * two checks can close that: membersOf has already answered, and the close pass ran before
   * this socket existed, so it never sees it. A socket accepted on the stale list would hold
   * the open feed of a member already cut, which is the bug this issue is about.
   *
   * So fetch looks at the roster again, in the invocation that accepts, where nothing yields
   * between the look and the accept. These cases hand the object the stale list directly,
   * which is what the Worker would have handed it, so the race is a fixed order and not a
   * hope.
   */
  const upgradeNaming = (stub: DurableObjectStub, memberIds: string[]) =>
    stub.fetch(new Request("https://session/ws?cursor=0", {
      headers: { upgrade: "websocket", "x-bellman-members": memberIds.join(",") },
    }));

  it("refuses a socket whose members were all removed after the list was made", async () => {
    const { id, store, stub } = await roomOf(mine("m_target"));
    const asked = (await stub.membersOf("u_jesse")).memberIds;
    expect(asked, "arrangement: the Worker's answer, before the removal").toEqual(["m_target"]);

    await evictThrough(store, id, "m_target");
    const res = await upgradeNaming(stub, asked);

    expect(res.status).toBe(403);
    expect(res.webSocket ?? null).toBeNull();
    expect(await attachments(stub)).toEqual([]);
  });

  it("drops only the removed member from the list, and keeps a socket the others entitle", async () => {
    const { id, store, stub } = await roomOf(mine("m_target"), mine("m_second"));
    const asked = (await stub.membersOf("u_jesse")).memberIds;
    expect(asked, "arrangement: the Worker's answer, before the removal").toEqual(["m_target", "m_second"]);

    await evictThrough(store, id, "m_target");
    const res = await upgradeNaming(stub, asked);

    expect(res.status).toBe(101);
    const watcher = watch(res);
    expect(await attachments(stub)).toEqual([expect.objectContaining({ memberIds: ["m_second"] })]);
    // Live, and not just accepted: the pass that ran at the removal did not see this socket,
    // and a later removal must find it entitled by the handle that is still in.
    await say(store, id, "after");
    await vi.waitFor(() => expect(watcher.trail).toContain("message:after"), { timeout: 3000 });
    expect(watcher.ws.readyState).toBe(1); // OPEN
  });
});
