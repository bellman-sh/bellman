# Room Delivery, Server Half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve room delivery over a hibernating WebSocket at `/ws`, and stop
`getSession` from reading every event, without changing a single line of
client behaviour.

**Architecture:** `SessionDO` keeps its in-memory long-poll waiters and gains a
second delivery arm over `ctx.getWebSockets()`, whose sockets survive object
eviction. A `/ws` route in the Worker authenticates exactly as `/mcp` does,
asks the object which members the caller owns, and hands it a freshly
constructed upgrade request. Separately, `getSession` stops re-inflating an
events array that only one caller ever read.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (Hibernation
API), vitest, wrangler.

**Spec:** [`docs/superpowers/specs/2026-09-29-room-delivery-design.md`](../specs/2026-09-29-room-delivery-design.md)

## Global Constraints

- **Node >= 22.** `package.json` `engines`. No new runtime dependency in this plan.
- **Two TypeScript programs.** `npm run typecheck` (Node) excludes `src/worker.ts`,
  `src/store-do.ts`, `src/oauth/store.ts`; `npm run typecheck:worker` includes them.
  Both must pass. `npm run verify` runs typecheck + typecheck:worker + build + test.
- **Three test programs now, not two.** (1) The root vitest suite: anything importing
  `cloudflare:workers` needs `vi.mock("cloudflare:workers")`; runtime-free shapes go in
  a module beside it — see `src/stored-session.ts`. (2) `worker-tests/`, added by #12
  (PR #102): a SEPARATE npm package with its own `node_modules`, running
  `@cloudflare/vitest-pool-workers` against real workerd. It is not an npm workspace of
  the root; `npm install` there is separate. Its `wrangler.toml` sets
  `main = "../src/worker.ts"`, so the real Worker and real Durable Objects are loaded.
  (3) `npm run smoke`, against a real deployment.
- **`npm run verify` now runs five things**, not four: `typecheck && typecheck:worker &&
  build && test && test:worker`. The last one installs `worker-tests/` with
  `--legacy-peer-deps` first, so it is slower than the plan's earlier tasks assume.
- **The shared contract suite binds both stores now.** `tests/helpers/store-contract.ts`
  runs against `MemoryStore` (root suite) AND `DurableObjectStore` (worker-tests). A case
  added there must pass in real workerd too. `describeStoreContract` takes a third
  argument, a `StoreContractDivergences` map, for documented per-store deviations.
- **A room holds many members, not two.** Never write "two sessions" or "the other
  session" in code comments, commit messages or docs. Say *members*, *the room*, or
  *peers*.
- **Peer content is untrusted, everywhere.** Nothing in this plan renders or unwraps
  peer content; the socket carries raw `SessionEvent`s and the client escapes.
- **Read and register in the same turn.** No `await` between reading events and
  registering a delivery target. This plan extends the rule to sockets (Task 5),
  it does not retire it.
- **Every new assertion must be seen to fail.** Break the implementation by hand,
  watch the test go red, then fix it. A green test nobody has seen fail is not
  evidence. Each task's "verify it fails" step is that, and is not optional.
- **`main` moves only through merges.** Work on the current branch; land by PR.

## Review Focus

Five input classes the spec implies but no task's happy path exercises. Each
line names the input and the behaviour a reasonable person expects; each has a
test added to the task that owns the code.

1. **`?cursor=` that is not a non-negative integer** — `-1`, `abc`, `1e99`, absent.
   Expect 400 and no socket, not an unbounded replay or an `e:0000000000NaN` lookup.
   *(Task 7)*
2. **`?session=` naming a closed or unknown room.** A poll onto a closed room lasts
   25 seconds; a socket would last forever. Expect 404 for unknown and 409 for
   closed. *(Tasks 3 and 7)*
3. **A member whose `leftAt` is set.** `findMember` does not exclude them, so
   `bellman_sync` still serves them. `/ws` must too, or the two delivery paths
   drift — which the spec names as its standing risk. *(Task 3)*
4. **An identity owning several members in one room.** The attachment must carry
   all of them, and one socket serves them all. *(Tasks 3 and 4)*
5. **`ref_id` naming no event, or naming one with leading zeros.** `"007"` did not
   match cursor 7 before and must not start to. Expect the existing
   `no action_request with cursor id …` failure, not a throw. *(Task 2)*

---

### Task 1: `eventAt` on the store seam

A single-key event lookup. `bellman_send` resolves an `action_response`'s
`ref_id` by scanning every event; this is what it will use instead (Task 2).
Landing the seam first means Task 2 has something to switch to.

**Files:**
- Modify: `src/store.ts` (the `BellmanStore` interface, and `MemoryStore`)
- Modify: `src/store-do.ts` (`SessionDO`, and the `DurableObjectStore` facade)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BellmanStore.eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined>`;
  `SessionDO.eventAt(cursor: number): Promise<SessionEvent | undefined>`.

- [ ] **Step 1: Write the failing contract tests**

In `tests/helpers/store-contract.ts`, directly after the
`it("eventsAfter filters strictly by cursor", …)` case:

```ts
    it("eventAt returns exactly the event at that cursor", async () => {
      const s = session();
      await store.createSession(s);
      const first = await store.appendEvent(s.id, draft(s, { payload: { n: 1 } }));
      const second = await store.appendEvent(s.id, draft(s, { payload: { n: 2 } }));

      expect(await store.eventAt(s.id, first!.cursor)).toEqual(first);
      expect(await store.eventAt(s.id, second!.cursor)).toEqual(second);
    });

    it("eventAt returns undefined for a cursor with no event", async () => {
      const s = session();
      await store.createSession(s);
      const only = await store.appendEvent(s.id, draft(s, { payload: { n: 1 } }));

      expect(await store.eventAt(s.id, only!.cursor + 1)).toBeUndefined();
      expect(await store.eventAt(s.id, 0)).toBeUndefined();
      expect(await store.eventAt(s.id, -1)).toBeUndefined();
    });

    it("eventAt returns undefined for an unknown session", async () => {
      expect(await store.eventAt("qs_nope", 1)).toBeUndefined();
    });

    it("eventAt hands back a detached copy", async () => {
      const s = session();
      await store.createSession(s);
      const e = await store.appendEvent(s.id, draft(s, { payload: { n: 1 } }));

      const got = await store.eventAt(s.id, e!.cursor);
      (got!.payload as Record<string, unknown>).n = 99;
      expect((await store.eventAt(s.id, e!.cursor))!.payload).toEqual({ n: 1 });
    });
```

If a local `draft(...)` helper does not already exist in this file, use the
same inline event shape the neighbouring `appendEvent` cases use rather than
introducing one.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run tests/store.test.ts -t "eventAt"`
Expected: FAIL — `store.eventAt is not a function`.

- [ ] **Step 3: Declare it on the interface**

In `src/store.ts`, directly after the `eventsAfter` declaration:

```ts
  /**
   * The event at exactly this cursor, or undefined.
   *
   * One key, not a scan. `bellman_send` resolves an action_response's ref_id
   * this way; reading the whole history to find one event is what #25 was.
   */
  eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined>;
```

- [ ] **Step 4: Implement it on `MemoryStore`**

In `src/store.ts`, directly after `MemoryStore.eventsAfter`:

```ts
  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    const e = this.sessions.get(sessionId)?.events.find((ev) => ev.cursor === cursor);
    return e ? detach(e) : undefined;
  }
```

- [ ] **Step 5: Implement it on `SessionDO` and the facade**

In `src/store-do.ts`, directly after `SessionDO.eventsAfter`:

```ts
  async eventAt(cursor: number): Promise<SessionEvent | undefined> {
    return this.ctx.storage.get<SessionEvent>(eventKey(cursor));
  }
```

and directly after `DurableObjectStore.eventsAfter`:

```ts
  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    return this.session(sessionId).eventAt(cursor);
  }
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run tests/store.test.ts -t "eventAt"`
Expected: PASS, 4 tests.

- [ ] **Step 7: See the detachment test fail on purpose**

Change `MemoryStore.eventAt` to `return e;` (drop the `detach`). Run the suite
again and confirm "eventAt hands back a detached copy" goes RED. Restore the
`detach` and confirm green. Do not skip this: the other three tests pass with
or without it, so this is the only one that proves anything about detachment.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:worker
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git commit -m "feat(store): add eventAt, a single-key event lookup (#25)"
```

---

### Task 2: `getSession` returns `StoredSession`

Stop reading every event on a read that almost nobody wanted events from. The
events-free type already exists.

**Files:**
- Modify: `src/store.ts` (interface, `MemoryStore.getSession`, `getSessionByJoinCode`)
- Modify: `src/store-do.ts` (`SessionDO.getSession`, facade `getSession`/`getSessionByJoinCode`)
- Modify: `src/server.ts:729` (the one caller that read `session.events`)
- Test: `tests/store-do-wiring.test.ts`, `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `BellmanStore.eventAt` (Task 1).
- Produces: `BellmanStore.getSession(id): Promise<StoredSession | undefined>` and
  `getSessionByJoinCode(code): Promise<{ session: StoredSession; role: string } | undefined>`,
  where `StoredSession = Omit<Session, "events">` from `src/stored-session.ts`.

- [ ] **Step 1: Write the failing list-count test**

`tests/store-do-wiring.test.ts` already has `fakeStorage`. Give it a `lists`
counter — add `let lists = 0;` beside `let puts = 0;`, add
`get lists() { return lists; },` beside the `puts` getter, and make the first
line of the `list:` implementation `lists++;`.

Then add this test beside the other `SessionDO` cases:

```ts
  it("getSession does not list events", async () => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const doi = new storeDo.SessionDO({ storage } as never, {} as never);
    await doi.appendEvent({
      type: "message", fromMemberId: "m1", fromUserId: "u1",
      fromLabel: "jesse", payload: { n: 1 }, refId: null,
    });

    const before = storage.lists;
    const got = await doi.getSession();

    expect(got?.id).toBe(LEGACY_ID);
    expect(got).not.toHaveProperty("events");
    // The whole point of #25: a session read is O(1) keys, not O(events).
    expect(storage.lists - before).toBe(0);
  });
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "does not list events"`
Expected: FAIL — the list count is 1, and `events` is present.

- [ ] **Step 3: Change the interface and both implementations**

`src/store.ts` — import the type and change two declarations:

```ts
import type { StoredSession } from "./stored-session.js";
```

```ts
  /**
   * The session record and its members. NOT its events.
   *
   * Returning StoredSession rather than Session is what stops #25 coming
   * back: a handler that reaches for history no longer compiles, so it has
   * to call eventsAfter or eventAt and say which events it wants.
   */
  getSession(id: string): Promise<StoredSession | undefined>;
```

and in the `getSessionByJoinCode` declaration, change the return type to
`Promise<{ session: StoredSession; role: string } | undefined>`.

`MemoryStore.getSession`:

```ts
  async getSession(id: string): Promise<StoredSession | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.expireIfDue(s, Date.now());
    const { events: _events, ...rest } = detach(s);
    return rest;
  }
```

`SessionDO.getSession` — the second `stored()` read becomes the return value:

```ts
  async getSession(): Promise<StoredSession | undefined> {
    const s = await this.stored();
    if (!s) return undefined;
    await this.expireIfDue(s, Date.now());
    // Re-read: expireIfDue may have written closed=true and cleared the codes.
    return this.stored();
  }
```

Change both facade signatures in `src/store-do.ts` to `StoredSession` to match.
`MemoryStore.getSessionByJoinCode` and the facade's need no body change — they
already return whatever `getSession` gave them.

- [ ] **Step 4: Switch the one caller that wanted events**

`src/server.ts`, in the `action_response` branch (currently line 729), replace:

```ts
        const req = session.events.find((e) => String(e.cursor) === ref_id && e.type === "action_request");
        if (!req) return fail(`no action_request with cursor id ${ref_id}.`);
```

with:

```ts
        // One key, not the whole history (#25). String-compared, not numeric:
        // "007" never matched cursor 7 and must not start to.
        const at = Number(ref_id);
        const req = Number.isSafeInteger(at) && at > 0
          ? await s.eventAt(session_id, at)
          : undefined;
        if (!req || String(req.cursor) !== ref_id || req.type !== "action_request") {
          return fail(`no action_request with cursor id ${ref_id}.`);
        }
```

- [ ] **Step 5: Write the Review Focus #5 test**

In `tests/tools/` beside the existing `bellman_send` tests, add:

```ts
  it("rejects an action_response whose ref_id names no action_request", async () => {
    const { send } = await room();
    for (const ref of ["9999", "007", "abc", "-1", "0", "1e3"]) {
      const r = await send({ type: "action_response", ref_id: ref, payload: { ok: true } });
      expect(r.isError, `ref_id ${ref} should be refused`).toBe(true);
      expect(textOf(r)).toContain(`no action_request with cursor id ${ref}`);
    }
  });
```

Match the surrounding file's helpers for `room()`, `send()` and `textOf()`
rather than introducing new ones; the names above are placeholders for
whatever that file already uses to drive a tool through the harness.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. Any failure here is a caller that wanted `session.events` and
now cannot have it — there should be exactly none, but fix by calling
`eventsAfter` or `eventAt`, never by widening the return type back.

- [ ] **Step 7: See the count test fail on purpose**

Restore `return { ...fresh, events: await this.events(0) };` in
`SessionDO.getSession` by hand. Confirm "getSession does not list events" goes
RED. Put it back. This is the only assertion standing between #25 and its
return.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:worker
git add src/store.ts src/store-do.ts src/server.ts tests/
git commit -m "perf(store): getSession stops reading every event (#25)

The events-free type already existed as StoredSession, and exactly one
caller outside the store read session.events: bellman_send resolving an
action_response's ref_id. That becomes a single-key eventAt.

The type does the enforcing. A handler that reaches for history now fails
to compile, so the poll cost stops growing with the age of the room."
```

---

### Task 3: `SessionDO.membersOf`

The upgrade's authorization check, kept cheap: it reads the session row and
never touches an event key.

**Files:**
- Modify: `src/store-do.ts` (`SessionDO`)
- Test: `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: `SessionDO.stored()` (private, existing).
- Produces: `SessionDO.membersOf(userId: string): Promise<{ memberIds: string[]; closed: boolean }>`.

Why a shape and not a bare array: the route must tell "you own nothing here"
(403) from "this room is closed" (409), and a second RPC to ask would be a
second cross-object hop.

- [ ] **Step 1: Write the failing tests**

```ts
  describe("membersOf", () => {
    const withMembers = (...ms: Partial<Member>[]) =>
      currentRow({ members: ms.map((m) => member(m)) });

    it("returns every member that identity owns", async () => {
      const storage = fakeStorage({
        session: withMembers(
          { memberId: "m1", userId: "u1" },
          { memberId: "m2", userId: "u2" },
          { memberId: "m3", userId: "u1" },
        ),
        cursor: 0,
      });
      const doi = new storeDo.SessionDO({ storage } as never, {} as never);
      // Review Focus #4: one identity, several members, one socket for all.
      expect(await doi.membersOf("u1")).toEqual({ memberIds: ["m1", "m3"], closed: false });
    });

    it("returns nothing for an identity that owns no member", async () => {
      const storage = fakeStorage({ session: withMembers({ memberId: "m1", userId: "u1" }), cursor: 0 });
      const doi = new storeDo.SessionDO({ storage } as never, {} as never);
      expect(await doi.membersOf("u9")).toEqual({ memberIds: [], closed: false });
    });

    it("still returns a member who has left", async () => {
      // Review Focus #3. findMember (src/server.ts:108) does not exclude
      // leftAt, so bellman_sync still serves them. The two delivery paths
      // must not drift, so /ws must not exclude them either.
      const storage = fakeStorage({
        session: withMembers({ memberId: "m1", userId: "u1", leftAt: Date.now() }),
        cursor: 0,
      });
      const doi = new storeDo.SessionDO({ storage } as never, {} as never);
      expect((await doi.membersOf("u1")).memberIds).toEqual(["m1"]);
    });

    it("reports a closed room as closed, with the membership intact", async () => {
      // Review Focus #2. A poll onto a closed room lasts 25s; a socket would
      // last forever. The route refuses, but the distinction is made here.
      const storage = fakeStorage({
        session: { ...withMembers({ memberId: "m1", userId: "u1" }), closed: true },
        cursor: 0,
      });
      const doi = new storeDo.SessionDO({ storage } as never, {} as never);
      expect(await doi.membersOf("u1")).toEqual({ memberIds: ["m1"], closed: true });
    });

    it("reports an unknown room as closed with no members", async () => {
      const doi = new storeDo.SessionDO({ storage: fakeStorage() } as never, {} as never);
      expect(await doi.membersOf("u1")).toEqual({ memberIds: [], closed: true });
    });

    it("reads no event keys", async () => {
      const storage = fakeStorage({ session: withMembers({ memberId: "m1", userId: "u1" }), cursor: 0 });
      const doi = new storeDo.SessionDO({ storage } as never, {} as never);
      const before = storage.lists;
      await doi.membersOf("u1");
      expect(storage.lists - before).toBe(0);
    });
  });
```

Import `Member` as a type and `member` from `./helpers/fixtures.js` if the file
does not already.

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "membersOf"`
Expected: FAIL — `doi.membersOf is not a function`.

- [ ] **Step 3: Implement it**

In `src/store-do.ts`, in `SessionDO`, directly after `getSession`:

```ts
  /**
   * Which members this user owns here, and whether the room is closed.
   *
   * The authorization check for a /ws upgrade. Deliberately mirrors
   * findMember (src/server.ts:108), leftAt and all: bellman_sync serves a
   * member who has left, and two delivery paths that disagree about who may
   * watch is exactly the drift the spec names as its standing risk.
   *
   * Reads the session row only. Never an event key — that is the whole
   * reason the route asks here rather than calling getSession.
   */
  async membersOf(userId: string): Promise<{ memberIds: string[]; closed: boolean }> {
    const s = await this.stored();
    if (!s) return { memberIds: [], closed: true };
    return {
      memberIds: s.members.filter((m) => m.userId === userId).map((m) => m.memberId),
      closed: s.closed,
    };
  }
```

- [ ] **Step 4: Run them and verify they pass**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "membersOf"`
Expected: PASS, 6 tests.

- [ ] **Step 5: See the leftAt test fail on purpose**

Add `.filter((m) => m.leftAt === null)` to the members filter. Confirm "still
returns a member who has left" goes RED. Remove it. Without this you have not
shown the test can detect the drift it exists to prevent.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck:worker
git add src/store-do.ts tests/store-do-wiring.test.ts
git commit -m "feat(do): membersOf, the /ws upgrade's authorization read (#99)"
```

---

### Task 4: The fake ctx grows sockets, and `SessionDO.fetch` accepts one

`SessionDO`'s first `fetch` handler. Accept, replay from the cursor, write the
attachment — all in one invocation, so the input gate makes them atomic against
a concurrent append.

**Files:**
- Modify: `tests/store-do-wiring.test.ts` (a `fakeCtx` with a WebSocket surface,
  AND converting every existing bare `{ storage }` construction to use it — ten
  as of Task 3, found by grep, not by line number. See Step 1b, which Task 5
  depends on)
- Modify: `src/store-do.ts` (`SessionDO.fetch`)
- Test: `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: `SessionDO.events(cursor)` (private, existing), `eventKey`.
- Produces: `SessionDO.fetch(request: Request): Promise<Response>`; the
  attachment shape `{ memberIds: string[]; cursor: number }`; the upgrade
  contract — `?cursor=<int>` and an `x-bellman-members` header of
  comma-separated member ids, both set by the Worker (Task 7), never by a caller.

- [ ] **Step 1: Add a socket-capable fake ctx**

In `tests/store-do-wiring.test.ts`, beside `fakeStorage`:

```ts
/**
 * A fake WebSocket pair plus the slice of DurableObjectState the Hibernation
 * API needs. The real runtime persists accepted sockets across eviction and
 * hands them back from getWebSockets(); here a plain array stands in, which is
 * enough for fan-out, replay and attachment logic but NOT for eviction itself.
 * Eviction is verified by npm run smoke against real Durable Objects — see D13.
 */
function fakeSocket() {
  const sent: string[] = [];
  let attachment: unknown = undefined;
  let closed: { code: number; reason: string } | undefined;
  return {
    sent,
    get closed() { return closed; },
    send: (data: string) => { sent.push(data); },
    close: (code: number, reason: string) => { closed = { code, reason }; },
    serializeAttachment: (v: unknown) => { attachment = structuredClone(v); },
    deserializeAttachment: () => structuredClone(attachment),
  };
}

function fakeCtx(storage: ReturnType<typeof fakeStorage>) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const autoResponses: unknown[] = [];
  return {
    storage,
    sockets,
    autoResponses,
    acceptWebSocket: (ws: unknown) => { sockets.push(ws as ReturnType<typeof fakeSocket>); },
    getWebSockets: () => [...sockets],
    setWebSocketAutoResponse: (r: unknown) => { autoResponses.push(r); },
  };
}
```

`SessionDO.fetch` constructs a `WebSocketPair`, which workerd provides and
vitest does not. Stub it once at the top of the file, beside the
`vi.mock("cloudflare:workers")` call:

```ts
// workerd global. The DO returns client and accepts server; a test drives the
// server side, which is the one acceptWebSocket is handed.
vi.stubGlobal("WebSocketPair", class {
  0 = fakeSocket();
  1 = fakeSocket();
});
```

**If that class-field form does not compile**, use a constructor returning a
plain indexed object instead. Vitest does not typecheck and this file is
excluded from `tsc`, so this is a runtime concern only.

- [ ] **Step 1b: Give every `SessionDO` construction a ctx with `getWebSockets`**

THIRTEEN as of Task 3. Find them with a grep that matches the CONSTRUCTOR,
not the argument:

```bash
grep -nE 'new (storeDo\.)?SessionDO\(' tests/store-do-wiring.test.ts   # expect 13
```

An earlier revision of this step grepped for `new storeDo.SessionDO({ storage`
instead. That matches the ARGUMENT, so it misses every multi-line construction
— where `(` ends the line and the ctx sits on the next — and it found 11 of 13.
Both misses are in Task 3's TTL boundary test, and one of them drives
`getSession` -> `expireIfDue` -> `wake()`, so it is exactly a site that breaks.

Two clarifications the wording needs, both raised by Task 3:

- **The target is `SessionDO`, not "bare `{ storage }`".** Task 3 already gave
  its two sites a local `socketlessCtx(storage)` returning
  `{ storage, getWebSockets: () => [] }`. Those are no longer "bare", but they
  still need folding into `fakeCtx` so there is one ctx helper, not two. Fold
  them and delete `socketlessCtx`.
- **`RegistryDO` is out of scope.** There is one bare-ctx `RegistryDO`
  construction in this file. It has no `wake()` and never reaches
  `getWebSockets`, so leave it exactly as it is. "Every ctx" read literally
  would sweep it in for no reason.

```ts
new SessionDO({ storage: legacyStorage } as never, {} as never)
// becomes
new SessionDO(fakeCtx(legacyStorage) as never, {} as never)
```

**This is not tidying, and skipping it breaks Task 5.** Around twenty call
sites in this file reach `wake()` through `appendEvent`, `appendEventOnce` or
`alarm()`. Today `wake()` opens with `if (this.waiters.length === 0) return;`,
so with no waiters registered it returns before touching `this.ctx` — that
early return is the only reason a ctx with no `getWebSockets` works at all.
Task 5 deletes that line, because it would otherwise skip socket delivery
whenever nobody is long-polling, which becomes the common case. The moment it
goes, every one of those paths calls `this.ctx.getWebSockets()` and throws
`TypeError: this.ctx.getWebSockets is not a function`.

Do NOT instead make `wake()` tolerant (`this.ctx.getWebSockets?.() ?? []`).
That weakens production code to accommodate a test fake, and it would hide a
real missing-binding failure in workerd. Fix the fake, not the object.

Note that `worker-tests/` will stay green either way — it runs against real
Durable Objects, where `getWebSockets()` exists. Only the root suite breaks,
which is exactly the kind of split that gets misdiagnosed.

- [ ] **Step 1c: Confirm the conversion changed nothing**

Run: `npm test`
Expected: PASS, same count as before your change. `fakeCtx` passes `storage`
straight through, so no existing assertion should move.

- [ ] **Step 2: Write the failing tests**

```ts
  describe("fetch: websocket upgrade", () => {
    const upgrade = (cursor: number, members = "m1") =>
      new Request("https://do/ws?cursor=" + cursor, {
        headers: { upgrade: "websocket", "x-bellman-members": members },
      });

    const world = async (events = 0) => {
      const storage = fakeStorage({ session: currentRow(), cursor: 0 });
      const ctx = fakeCtx(storage);
      const doi = new storeDo.SessionDO(ctx as never, {} as never);
      for (let n = 1; n <= events; n++) {
        await doi.appendEvent({
          type: "message", fromMemberId: "m9", fromUserId: "u9",
          fromLabel: "peer", payload: { n }, refId: null,
        });
      }
      return { doi, ctx, storage };
    };

    it("answers 101 and accepts the socket", async () => {
      const { doi, ctx } = await world();
      const res = await doi.fetch(upgrade(0));
      expect(res.status).toBe(101);
      expect(ctx.sockets).toHaveLength(1);
    });

    it("replays exactly what was missed, and nothing already seen", async () => {
      const { doi, ctx } = await world(5);
      await doi.fetch(upgrade(3));
      const got = ctx.sockets[0].sent.map((s) => JSON.parse(s).cursor);
      expect(got).toEqual([4, 5]);
    });

    it("replays nothing when the cursor is current", async () => {
      const { doi, ctx } = await world(2);
      await doi.fetch(upgrade(2));
      expect(ctx.sockets[0].sent).toEqual([]);
    });

    it("stores the members and the replayed cursor on the attachment", async () => {
      const { doi, ctx } = await world(3);
      await doi.fetch(upgrade(1, "m1,m3"));
      expect(ctx.sockets[0].deserializeAttachment())
        .toEqual({ memberIds: ["m1", "m3"], cursor: 3 });
    });

    it("keeps the requested cursor on the attachment when nothing was replayed", async () => {
      const { doi, ctx } = await world(2);
      await doi.fetch(upgrade(2));
      expect(ctx.sockets[0].deserializeAttachment())
        .toEqual({ memberIds: ["m1"], cursor: 2 });
    });

    it("refuses a request that is not an upgrade", async () => {
      const { doi, ctx } = await world();
      const res = await doi.fetch(new Request("https://do/ws?cursor=0"));
      expect(res.status).toBe(426);
      expect(ctx.sockets).toHaveLength(0);
    });
  });
```

- [ ] **Step 3: Run them and verify they fail**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "websocket upgrade"`
Expected: FAIL — `doi.fetch is not a function`.

- [ ] **Step 4: Implement `fetch`**

In `src/store-do.ts`, in `SessionDO`, after `membersOf`. Add the attachment
type above the class, beside `type Waiter`:

```ts
/**
 * What a hibernating socket remembers, across eviction.
 *
 * The 16 KB cap is reachable, though only by churn: membersOf deliberately
 * returns members who have left (D6), so this list grows with seatings rather
 * than with the room's active cap. serializeAttachment throws above it, which
 * is why fetch attaches before it accepts.
 */
type SocketAttachment = { memberIds: string[]; cursor: number };
```

```ts
  /**
   * Accept a watching socket. The Worker has already authenticated the caller
   * and asked membersOf who they are; this request is one the Worker BUILT,
   * so nothing on it came from the client (see the /ws route in worker.ts).
   *
   * Accept, replay and attach happen in this one invocation, and the input
   * gate holds every other request to this object for its duration. That is
   * CLAUDE.md's read-and-register rule, not an exemption from it: an event
   * appended between the replay and the accept would otherwise be delivered
   * to nobody and skipped by the cursor.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const cursor = Number(url.searchParams.get("cursor"));
    const memberIds = (request.headers.get("x-bellman-members") ?? "")
      .split(",").filter(Boolean);

    // Read FIRST. Accepting before reading leaves an accepted socket with no
    // attachment if this throws, and wake() has no right answer for a socket
    // whose cursor it does not know — it fails closed, so that socket then
    // receives nothing, silently, for as long as it stays open. A failed read
    // must accept nothing.
    const missed = await this.events(cursor);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Attach BEFORE accept. serializeAttachment throws above the 16 KB cap,
    // and accepting first would strand an accepted socket with no cursor —
    // wake() fails closed on that, so it would receive nothing, silently, for
    // as long as it stayed open. Measured against workerd 1.20260926.1: a
    // pre-accept attachment persists and survives eviction. Both calls are
    // synchronous and adjacent, so nothing interleaves either.
    server.serializeAttachment({
      memberIds,
      cursor: missed.length > 0 ? missed[missed.length - 1].cursor : cursor,
    } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    for (const e of missed) server.send(JSON.stringify(e));

    return new Response(null, { status: 101, webSocket: client });
  }
```

- [ ] **Step 5: Run them and verify they pass**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "websocket upgrade"`
Expected: PASS, 6 tests.

- [ ] **Step 6: See the replay test fail on purpose**

Change `await this.events(cursor)` to `await this.events(0)`. Confirm "replays
exactly what was missed, and nothing already seen" goes RED with `[1,2,3,4,5]`.
Restore it. Re-delivering events a member has already seen is the failure this
test exists to catch, and it is silent in production.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck:worker
git add src/store-do.ts tests/store-do-wiring.test.ts
git commit -m "feat(do): accept a watching WebSocket and replay from its cursor (#99)"
```

---

### Task 5: `wake()` delivers to sockets as well as waiters

The second arm. The first is untouched: the long poll is permanent for clients
that cannot reach a local process.

**Files:**
- Modify: `src/store-do.ts` (`SessionDO.wake`)
- Test: `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: `SocketAttachment` and the fake ctx (Task 4) — including Task 4's
  Step 1b, which converted every bare `{ storage }` ctx in the test file. If
  that did not happen, deleting the early return below makes ~20 existing
  tests throw `this.ctx.getWebSockets is not a function`. Check before you
  start: every site `grep -nE 'new (storeDo\.)?SessionDO\(' tests/store-do-wiring.test.ts`
  finds must be passed a ctx that provides `getWebSockets` — via `fakeCtx`
  after Task 4 folds in Task 3's interim `socketlessCtx`. Do NOT grep for
  `SessionDO({ storage` — that matches the argument, and a multi-line
  construction puts the ctx on the next line and slips straight through.
- Produces: no new signature. `wake()` stays `private wake(event: SessionEvent): void`
  and stays synchronous.

- [ ] **Step 1: Write the failing tests**

```ts
  describe("wake: socket delivery", () => {
    const world = async () => {
      const storage = fakeStorage({ session: currentRow(), cursor: 0 });
      const ctx = fakeCtx(storage);
      const doi = new storeDo.SessionDO(ctx as never, {} as never);
      const post = (n: number) => doi.appendEvent({
        type: "message", fromMemberId: "m9", fromUserId: "u9",
        fromLabel: "peer", payload: { n }, refId: null,
      });
      return { doi, ctx, post };
    };
    const open = (ctx: ReturnType<typeof fakeCtx>, cursor: number, members = "m1") =>
      new Request("https://do/ws?cursor=" + cursor, {
        headers: { upgrade: "websocket", "x-bellman-members": members },
      });

    it("sends an appended event to a watching socket", async () => {
      const { doi, ctx, post } = await world();
      await doi.fetch(open(ctx, 0));
      await post(1);
      expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).payload)).toEqual([{ n: 1 }]);
    });

    it("fans out to every socket", async () => {
      const { doi, ctx, post } = await world();
      await doi.fetch(open(ctx, 0, "m1"));
      await doi.fetch(open(ctx, 0, "m2"));
      await post(1);
      expect(ctx.sockets).toHaveLength(2);
      for (const ws of ctx.sockets) expect(ws.sent).toHaveLength(1);
    });

    it("advances each socket's attachment as it sends", async () => {
      const { doi, ctx, post } = await world();
      await doi.fetch(open(ctx, 0));
      await post(1);
      await post(2);
      expect((ctx.sockets[0].deserializeAttachment() as { cursor: number }).cursor).toBe(2);
    });

    it("skips a socket already past the event", async () => {
      const { doi, ctx, post } = await world();
      await post(1);
      // Connects at cursor 1: it has already seen event 1 and must not get it.
      await doi.fetch(open(ctx, 1));
      const ws = ctx.sockets[0];
      expect(ws.sent).toEqual([]);
      await post(2);
      expect(ws.sent.map((s) => JSON.parse(s).cursor)).toEqual([2]);
    });

    it("sends nothing to a socket that claimed a cursor ahead of the room", async () => {
      // The guard's ONLY real trigger, and the reason the test above cannot
      // prove it. A socket's attachment starts at the cursor the client named
      // and cursors only rise, so in ordinary flow event.cursor is always
      // above att.cursor and the guard never fires — remove it and the test
      // above still passes. It fires when a client names a cursor the room
      // has not reached, and then it must: that client has claimed to have
      // seen through 10, so 1 and 2 are not news to it.
      const { doi, ctx, post } = await world();
      await doi.fetch(open(ctx, 10));
      await post(1);
      await post(2);
      expect(ctx.sockets[0].sent).toEqual([]);

      // ...and it starts receiving once the room passes what it claimed.
      for (let n = 3; n <= 11; n++) await post(n);
      expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).cursor)).toEqual([11]);
    });

    it("still resolves a long-poll waiter", async () => {
      const { doi, ctx, post } = await world();
      await doi.fetch(open(ctx, 0));
      const polling = doi.waitForEvents(0, 5_000);
      await post(1);
      expect((await polling).map((e) => e.cursor)).toEqual([1]);
      // Both arms, one event. The long poll is permanent for remote clients.
      expect(ctx.sockets[0].sent).toHaveLength(1);
    });

    it("delivers session_expired over the socket too", async () => {
      const storage = fakeStorage({
        session: { ...currentRow(), expiresAt: Date.now() - 1 }, cursor: 0,
      });
      const ctx = fakeCtx(storage);
      const doi = new storeDo.SessionDO(ctx as never, {} as never);
      await doi.fetch(open(ctx, 0));
      await doi.alarm();
      expect(ctx.sockets[0].sent.map((s) => JSON.parse(s).type)).toEqual(["session_expired"]);
    });
  });
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "socket delivery"`
Expected: FAIL — every socket's `sent` is empty; the waiter test passes already.

- [ ] **Step 2b: Fix the alarm that never re-arms**

Task 3's implementer found this and it belongs here, because this task owns
the `alarm()` -> `wake()` -> socket path.

`createSession` arms the TTL alarm exactly once (`setAlarm(s.expiresAt)`,
`src/store-do.ts:99`). `alarm()` calls `expireIfDue(s, Date.now())`, whose
guard is `if (s.closed || now <= s.expiresAt) return;`. An alarm that fires at
*exactly* `expiresAt` therefore does nothing — and **nothing re-arms it**, so
the room never expires at all.

It has not bitten yet because `bellman_sync` calls `getSession` every 25
seconds and `getSession` expires lazily. That is an accident, and **this
branch removes it**: once a member watches over a socket instead of polling,
nothing calls `getSession`, and a room whose alarm fired on the boundary lives
forever. In a change whose whole purpose is that a quiet room costs nothing,
a room that never dies is the wrong bug to ship.

Write the failing test first:

```ts
  it("re-arms the TTL alarm when it fires before the room is due", async () => {
    // The boundary: expireIfDue's guard is `now <= expiresAt`, so an alarm
    // landing exactly on expiresAt expires nothing. Without a re-arm the room
    // is then immortal, because after this branch nothing polls it.
    const at = Date.now() + 10_000;
    const storage = fakeStorage({ session: { ...currentRow(), expiresAt: at }, cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);

    vi.setSystemTime(at); // fire exactly on the boundary
    await doi.alarm();

    expect((await storage.get("session")) as { closed: boolean }).toMatchObject({ closed: false });
    expect(storage.alarms.at(-1)).toBeGreaterThan(at);
  });
```

Wrap it in `vi.useFakeTimers()` / `vi.useRealTimers()` if the file does not
already, following whatever the surrounding cases do.

Run it, watch it fail on `storage.alarms.at(-1)` being undefined, then:

```ts
  async alarm(): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    await this.expireIfDue(s, Date.now());
    /**
     * Re-arm if the room is still live.
     *
     * expireIfDue's guard is `now <= expiresAt`, so an alarm firing exactly on
     * the boundary expires nothing, and createSession arms this alarm only
     * once. Without this line such a room never expires — which went unnoticed
     * because bellman_sync's getSession expired it lazily every 25 seconds.
     * A socket-watched room calls getSession never, so that safety net is
     * gone and this one has to be real.
     *
     * Terminates: the re-arm is strictly after expiresAt, so the next firing
     * has now > expiresAt and expireIfDue closes the room.
     */
    const fresh = await this.stored();
    if (fresh && !fresh.closed) await this.ctx.storage.setAlarm(fresh.expiresAt + 1);
  }
```

Confirm green, then delete the re-arm line and confirm the test goes red again.

- [ ] **Step 3: Implement the second arm**

Replace `SessionDO.wake` in `src/store-do.ts`:

```ts
  /**
   * Two arms, one event.
   *
   * Waiters are in-memory long polls and do not survive eviction; sockets are
   * held by the runtime and do. Both are served here so that a room behaves
   * identically however a member is watching it, which is the property the
   * whole two-path design rests on.
   *
   * Synchronous on purpose. getWebSockets, deserializeAttachment, send and
   * serializeAttachment are all sync, so nothing here yields — an await
   * between reading a socket's cursor and sending would reopen the gap that
   * read-and-register exists to close.
   */
  private wake(event: SessionEvent): void {
    const woken = this.waiters.filter((w) => event.cursor > w.after);
    this.waiters = this.waiters.filter((w) => event.cursor <= w.after);
    for (const w of woken) w.resolve([event]);

    const frame = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      // Fail closed on a missing attachment. fetch() attaches before it sends,
      // so every accepted socket has one; a null here means something is
      // wrong, and over-delivering every event to a socket whose cursor we do
      // not know is the worse of the two answers.
      if (!att || event.cursor <= att.cursor) continue;
      ws.send(frame);
      ws.serializeAttachment({ ...att, cursor: event.cursor });
    }
  }
```

Note the early `if (this.waiters.length === 0) return;` guard is gone: it would
now skip socket delivery whenever nobody is long-polling, which is the common
case.

- [ ] **Step 4: Run them and verify they pass**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "socket delivery"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing waiter tests must be untouched and green.

- [ ] **Step 6: See two tests fail on purpose**

First, restore `if (this.waiters.length === 0) return;` at the top of `wake`.
Confirm "sends an appended event to a watching socket" goes RED — this is the
exact mistake the guard invites, and the one most likely to be reintroduced by
someone tidying the method. Remove it again.

Second, drop the `if (att && event.cursor <= att.cursor) continue;` line.
Confirm **"sends nothing to a socket that claimed a cursor ahead of the room"**
goes RED — two frames arrive where none should. Restore it.

Note which test that is. "skips a socket already past the event" passes with
or without the guard: its socket connects at cursor 1 and then receives cursor
2, and `2 > 1` means the guard never fires. Only a socket whose attachment is
AHEAD of the incoming event exercises it. If you run the mutation against the
wrong test you will conclude the guard is dead code and delete it.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck:worker
git add src/store-do.ts tests/store-do-wiring.test.ts
git commit -m "feat(do): wake() delivers to sockets as well as waiters (#99)

Two arms, one event. The waiter arm is untouched: the long poll is
permanent for remote MCP clients, which cannot reach a local process.

The early return on an empty waiter list had to go. It would have skipped
socket delivery whenever nobody was long-polling, which is the common case
once the bridge stops polling at all."
```

---

### Task 6: Receive-only, and the hibernation lifecycle handlers

The socket is a delivery side-channel. Enforce that rather than assume it, and
define the handlers the runtime needs in order to hibernate at all.

**Files:**
- Modify: `src/store-do.ts` (`SessionDO`)
- Test: `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: the fake ctx (Task 4).
- Produces: `webSocketMessage`, `webSocketClose`, `webSocketError` on `SessionDO`.
  Close code `1003` ("unsupported data") for a client frame.

- [ ] **Step 1: Write the failing tests**

```ts
  describe("receive-only", () => {
    const world = async () => {
      const storage = fakeStorage({ session: currentRow(), cursor: 0 });
      const ctx = fakeCtx(storage);
      const doi = new storeDo.SessionDO(ctx as never, {} as never);
      await doi.fetch(new Request("https://do/ws?cursor=0", {
        headers: { upgrade: "websocket", "x-bellman-members": "m1" },
      }));
      return { doi, ctx, ws: ctx.sockets[0] };
    };

    it("closes a socket that sends a frame", async () => {
      const { doi, ws } = await world();
      await doi.webSocketMessage(ws as never, "anything");
      expect(ws.closed?.code).toBe(1003);
    });

    it("appends nothing when a client sends", async () => {
      const { doi, ctx, ws } = await world();
      const before = ctx.storage.writes;
      await doi.webSocketMessage(ws as never, JSON.stringify({ type: "message", payload: {} }));
      expect(ctx.storage.writes - before).toBe(0);
    });

    it("registers a ping auto-response so a keepalive never wakes the object", async () => {
      const { ctx } = await world();
      expect(ctx.autoResponses).toHaveLength(1);
    });

    it("defines close and error handlers without throwing", async () => {
      const { doi, ws } = await world();
      await doi.webSocketClose(ws as never, 1000, "bye", true);
      await doi.webSocketError(ws as never, new Error("boom"));
    });
  });
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "receive-only"`
Expected: FAIL — `doi.webSocketMessage is not a function`.

- [ ] **Step 3: Implement the handlers**

In `src/store-do.ts`, in `SessionDO`, after `fetch`:

```ts
  /**
   * The socket is receive-only, and this is where that is enforced rather
   * than merely intended.
   *
   * A send over the socket would need bellman_send's verb check, frozen
   * guard, idempotency record, payload-depth limit and audit write
   * reimplemented at a second entry point and kept behaviourally identical
   * to the first. Adding that is a deliberate act; it starts with deleting
   * this method.
   */
  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    ws.close(1003, "This socket is receive-only. Send with bellman_send over /mcp.");
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _clean: boolean): Promise<void> {
    // The runtime drops it from getWebSockets(); there is no list of our own
    // to prune. Defined because the Hibernation API requires a handler.
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same. A socket that errors is already gone from getWebSockets().
  }
```

and in `fetch`, immediately before `this.ctx.acceptWebSocket(server)`:

```ts
    // Answered by the runtime without waking this object. Without it a
    // keepalive would revive the DO on every interval, which is the whole
    // saving undone.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
```

Stub that global in the test file beside `WebSocketPair`:

```ts
vi.stubGlobal("WebSocketRequestResponsePair", class {
  constructor(public request: string, public response: string) {}
});
```

- [ ] **Step 4: Run them and verify they pass**

Run: `npx vitest run tests/store-do-wiring.test.ts -t "receive-only"`
Expected: PASS, 4 tests.

- [ ] **Step 5: See the close test fail on purpose**

Change `webSocketMessage` to an empty body. Confirm "closes a socket that sends
a frame" goes RED. Restore it.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck:worker
git add src/store-do.ts tests/store-do-wiring.test.ts
git commit -m "feat(do): enforce a receive-only socket, and hibernate cleanly (#99)"
```

---

### Task 7: The `/ws` route

Authenticate exactly as `/mcp` does, ask the object who the caller is, and hand
it a request the Worker built.

**Files:**
- Modify: `src/worker.ts`
- Test: `tests/worker-ws.test.ts` (create)

**Interfaces:**
- Consumes: `SessionDO.membersOf` (Task 3), `SessionDO.fetch` (Task 4),
  `resolveIdentity`, `identityFromAccessToken`, `unauthorized`.
- Produces: the `GET /ws?session=<id>&cursor=<int>` contract. Status codes:
  101 upgraded, 400 bad cursor or missing session, 401 no identity, 403 owns no
  member here, 404 unknown room, 409 room closed, 426 not an upgrade,
  503 unconfigured.

- [ ] **Step 1: Write the failing tests**

Create `tests/worker-ws.test.ts`. Mirror the mocking `tests/store-do-wiring.test.ts`
uses so `src/worker.ts` is loadable, and drive the exported default `fetch` with
a fake `SESSION` namespace whose `get()` returns an object recording what it was
asked:

```ts
/**
 * The /ws route. Not the socket itself — SessionDO.fetch is tested in
 * tests/store-do-wiring.test.ts. What this pins is the route's contract:
 * who is refused, with what status, and what reaches the object.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
}));

const KEYS = JSON.stringify({ qk_test_jesse: { userId: "u1", orgId: null, plan: "team", role: "admin", label: "jesse" } });

async function world(members: { memberIds: string[]; closed: boolean }) {
  const asked: Request[] = [];
  const worker = (await import("../src/worker.js")).default;
  const env = {
    BELLMAN_KEYS: KEYS,
    SESSION: {
      idFromName: (n: string) => n,
      get: () => ({
        membersOf: async () => members,
        fetch: async (r: Request) => { asked.push(r); return new Response(null, { status: 101 }); },
      }),
    },
    REGISTRY: { idFromName: (n: string) => n, get: () => ({}) },
  } as never;
  const call = (url: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(url, { headers: { upgrade: "websocket", ...headers } }), env);
  return { call, asked };
}

const AUTH = { authorization: "Bearer qk_test_jesse" };
const OK = { memberIds: ["m1"], closed: false };

describe("GET /ws", () => {
  it("upgrades a member of the room", async () => {
    const { call } = await world(OK);
    expect((await call("https://b/ws?session=qs_1&cursor=0", AUTH)).status).toBe(101);
  });

  it("refuses a caller with no credentials", async () => {
    const { call } = await world(OK);
    expect((await call("https://b/ws?session=qs_1&cursor=0")).status).toBe(401);
  });

  it("refuses a caller who owns no member here", async () => {
    const { call } = await world({ memberIds: [], closed: false });
    expect((await call("https://b/ws?session=qs_1&cursor=0", AUTH)).status).toBe(403);
  });

  it("answers 404 for an unknown room", async () => {
    const { call } = await world({ memberIds: [], closed: true });
    expect((await call("https://b/ws?session=qs_nope&cursor=0", AUTH)).status).toBe(404);
  });

  it("answers 409 for a closed room", async () => {
    // Review Focus #2: a poll onto a closed room lasts 25s, a socket forever.
    const { call } = await world({ memberIds: ["m1"], closed: true });
    expect((await call("https://b/ws?session=qs_1&cursor=0", AUTH)).status).toBe(409);
  });

  it("rejects a cursor that is not a non-negative integer", async () => {
    // Review Focus #1.
    const { call, asked } = await world(OK);
    for (const c of ["-1", "abc", "1.5", "1e99", "", "9007199254740993"]) {
      const res = await call(`https://b/ws?session=qs_1&cursor=${c}`, AUTH);
      expect(res.status, `cursor ${JSON.stringify(c)} should be refused`).toBe(400);
    }
    expect(asked, "no bad cursor should have reached the object").toHaveLength(0);
  });

  it("rejects a missing session", async () => {
    const { call } = await world(OK);
    expect((await call("https://b/ws?cursor=0", AUTH)).status).toBe(400);
  });

  it("refuses a request that is not an upgrade", async () => {
    const { call } = await world(OK);
    const res = await call("https://b/ws?session=qs_1&cursor=0", { upgrade: "" });
    expect(res.status).toBe(426);
  });

  it("hands the object a request built here, carrying no client header", async () => {
    const { call, asked } = await world({ memberIds: ["m1", "m3"], closed: false });
    await call("https://b/ws?session=qs_1&cursor=7", {
      ...AUTH,
      // A caller trying to claim a membership it was not granted.
      "x-bellman-members": "m_someone_else",
      cookie: "session=secret",
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].headers.get("x-bellman-members")).toBe("m1,m3");
    expect(asked[0].headers.get("authorization")).toBeNull();
    expect(asked[0].headers.get("cookie")).toBeNull();
    expect(new URL(asked[0].url).searchParams.get("cursor")).toBe("7");
  });

  it("refuses to serve with neither a key map nor OAuth", async () => {
    const worker = (await import("../src/worker.js")).default;
    const env = { SESSION: { idFromName: (n: string) => n, get: () => ({}) } } as never;
    const res = await worker.fetch(
      new Request("https://b/ws?session=qs_1&cursor=0", { headers: { upgrade: "websocket" } }), env);
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx vitest run tests/worker-ws.test.ts`
Expected: FAIL — every case returns 404, because `/ws` falls through to the
`url.pathname !== "/mcp"` guard.

- [ ] **Step 3: Extract the fail-closed guard**

`/ws` needs the same refusal `/mcp` has. Lift it out of the `/mcp` body in
`src/worker.ts` into a helper above `export default`, and call it from both:

```ts
/**
 * Fail closed with neither a key map nor OAuth. resolveIdentity falls back to
 * the dev table when handed nothing, and nodejs_compat means `process` exists
 * here — so without this a deploy that forgot the secret would serve
 * qk_dev_jesse (team plan, admin role) on a public URL.
 */
function unconfigured(env: WorkerEnv, oauth?: OAuthConfig): Response | undefined {
  if (env.BELLMAN_KEYS || oauth) return undefined;
  console.error("BELLMAN_KEYS is unset — refusing to serve. Set it with: wrangler secret put BELLMAN_KEYS");
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32002, message: "Server is not configured with an identity key map" }, id: null },
    { status: 503 }
  );
}
```

Replace the inline guard in the `/mcp` path with
`const blocked = unconfigured(env, oauth); if (blocked) return blocked;`, and
confirm `npm test` is still green before continuing.

- [ ] **Step 4: Add the route**

In `src/worker.ts`, after the `/healthz` block and before
`if (url.pathname !== "/mcp")`:

```ts
    /**
     * The watching path. Delivery only — tool calls stay on /mcp, which is
     * what keeps this a side-channel rather than a second MCP transport.
     *
     * Nothing from the caller's request is forwarded to the object. The
     * Worker reads the query, resolves the identity, asks the object which
     * members that identity owns, and then BUILDS the upgrade request. A
     * client setting x-bellman-members itself therefore achieves nothing,
     * because its request is not the one the object ever sees.
     */
    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;

      const sessionId = url.searchParams.get("session");
      if (!sessionId) return new Response("Missing session", { status: 400 });

      // Number() alone accepts "", "1.5", "1e99" and " 1". A cursor is an
      // index into storage keys; anything else is a bad request, not a
      // silently clamped one.
      const raw = url.searchParams.get("cursor") ?? "";
      const cursor = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor)) {
        return new Response("cursor must be a non-negative integer", { status: 400 });
      }

      const header = request.headers.get("authorization") ?? undefined;
      const bearer = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
      let identity = oauth && bearer ? await identityFromAccessToken(bearer, oauth) : null;
      if (!identity && env.BELLMAN_KEYS) identity = resolveIdentity(header, env.BELLMAN_KEYS);
      if (!identity) return unauthorized(oauth);

      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      const { memberIds, closed } = await stub.membersOf(identity.userId);
      // An unknown room and a closed one are both "closed" to membersOf; the
      // membership is what tells them apart, and a stranger learns neither.
      if (memberIds.length === 0) {
        return new Response(closed ? "Not found" : "Forbidden", { status: closed ? 404 : 403 });
      }
      if (closed) return new Response("This room is closed", { status: 409 });

      return stub.fetch(
        new Request(`https://session/ws?cursor=${cursor}`, {
          headers: { upgrade: "websocket", "x-bellman-members": memberIds.join(",") },
        })
      );
    }
```

- [ ] **Step 5: Run them and verify they pass**

Run: `npx vitest run tests/worker-ws.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: See the forwarding test fail on purpose**

Change the `stub.fetch(...)` call to `stub.fetch(request)`. Confirm "hands the
object a request built here, carrying no client header" goes RED — the
caller's `x-bellman-members: m_someone_else` arrives. Restore it. This is the
one test standing between the route and a membership a caller can claim for
itself.

- [ ] **Step 7: Full verify and commit**

```bash
npm run verify
git add src/worker.ts tests/worker-ws.test.ts
git commit -m "feat(worker): serve room delivery at /ws (#99)

Authenticates exactly as /mcp does, then asks SessionDO which members the
identity owns before upgrading. Nothing from the caller's request reaches
the object: the Worker builds the upgrade request from what it decided, so
a client setting x-bellman-members achieves nothing.

A closed room refuses the upgrade where bellman_sync would serve it. A poll
onto a closed room lasts 25 seconds; a socket would last for as long as the
process does."
```

---

### Task 8: Prove eviction in workerd, then again in smoke

The claim this whole change rests on is that delivery survives the object being
evicted and revived. A fake ctx cannot show it. Two checks now can, and they
prove different things: the workerd test is a per-commit gate on the mechanism,
the smoke run is the only check against a real deployment.

**Files:**
- Create: `worker-tests/ws-delivery.test.ts`
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: the `/ws` route (Task 7), `SessionDO`'s socket arm (Tasks 4-6).
- Produces: nothing other code imports.

**Read first:** `worker-tests/README.md`. It names three things that will bite
you — the `--legacy-peer-deps` install, the deliberate `workerd` override, and
the fact that the pool's config API changed at 0.22.0 (no `defineWorkersConfig`;
`cloudflareTest()` is a plain Vite plugin; `isolatedStorage` is gone, replaced
by `reset()` and `abortAllDurableObjects()` from `cloudflare:test`).

- [ ] **Step 1: Write the failing workerd test**

Create `worker-tests/ws-delivery.test.ts`. Follow the shape of
`worker-tests/store-contract.test.ts` for imports and cleanup.

```ts
/**
 * Delivery survives the object being evicted and revived — in real workerd,
 * against the real /ws route (worker-tests/wrangler.toml sets
 * main = "../src/worker.ts").
 *
 * The mechanism is abortAllDurableObjects(), which store-contract.test.ts
 * already documents while making a different point: it "tears the instances
 * down, and that is what clears SessionDO.waiters — in-memory state no storage
 * rollback would touch." That is exactly the claim under test here. A waiter is
 * in-memory and dies with the instance; a socket is held by the runtime and
 * does not. The second case pins that difference rather than assuming it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, SELF, reset, abortAllDurableObjects } from "cloudflare:test";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("delivery across eviction", () => {
  it("a socket still receives after the object is torn down and revived", async () => {
    // Build a room whose member this identity owns, then upgrade.
    // Use the same fixtures/keys path the /ws route tests use.
    const res = await SELF.fetch("https://bellman.test/ws?session=<id>&cursor=0", {
      headers: { upgrade: "websocket", authorization: "Bearer <key>" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();

    const frames: string[] = [];
    ws.addEventListener("message", (e) => frames.push(String(e.data)));

    // THE TEARDOWN. Every instance goes; only runtime-held state survives.
    await abortAllDurableObjects();

    // Appending revives the object. wake() must find the socket on the
    // rebuilt instance, via ctx.getWebSockets(), not via instance state.
    await appendOneEvent();

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(JSON.parse(frames[0]).payload).toEqual({ text: "after teardown" });
  });

  it("a long-poll waiter does NOT survive the same teardown", async () => {
    // The companion half. If this also survived, the first test would be
    // proving nothing about hibernation — both arms would just be durable.
    const polling = /* start a bellman_sync long poll with a long wait */;
    await abortAllDurableObjects();
    await appendOneEvent();
    // The waiter is gone with its instance, so this poll cannot be woken by
    // the append; it resolves empty at its own timeout instead.
    expect(await polling).toEqual([]);
  });
});
```

Fill in the room setup, the key, and `appendOneEvent()` from whatever
`worker-tests/store-contract.test.ts` and `tests/helpers/fixtures.ts` already
provide — do not invent a new fixture layer. Import `vi` from vitest if you use
`vi.waitFor`.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:worker`
Expected: FAIL. Before Tasks 4-7 exist this cannot pass at all; if you are
running Task 8 after them, break it deliberately instead — see Step 3.

**If `abortAllDurableObjects()` closes the accepted socket** rather than
leaving it hibernating, this test cannot be written this way. That is a real
possible outcome, not a failure on your part. Report it as
DONE_WITH_CONCERNS, say exactly what you observed, delete the file, and do the
smoke steps only. The spec's D13 anticipates this and calls for recording that
the pool cannot express eviction.

- [ ] **Step 3: Make it pass, then see it fail on purpose**

The implementation already exists (Tasks 4-6). Once green, change `wake()`'s
socket loop to iterate an empty array (`for (const ws of [] as WebSocket[])`),
re-run `npm run test:worker`, and confirm the first case goes RED. Restore it.

Then, separately, confirm the second case is not vacuous: make it assert
`toHaveLength(1)` instead of `toEqual([])` and confirm THAT goes red too. A
test that passes whatever the code does is not a test. Restore it.

- [ ] **Step 4: Commit the workerd test**

```bash
git add worker-tests/ws-delivery.test.ts
git commit -m "test(worker): prove delivery survives eviction, in real workerd (#99)

#12 built worker-tests and npm run verify already pays for it, so the
eviction assertion the design rests on becomes a per-commit gate rather
than something only a manual smoke run covers.

Two cases, because one would not be evidence. A socket delivers across
abortAllDurableObjects(); a long-poll waiter registered before the same
teardown does not. That is the difference between the two arms of wake(),
asserted rather than assumed."
```

- [ ] **Step 5: Add the smoke `/ws` leg**

In `scripts/smoke.ts`, after the existing send/sync checks, with the room and
its member handles already in scope:

```ts
  // --------------------------------------------------------------- /ws (#99)
  // Requires real Durable Objects: BELLMAN_URL pointing at wrangler dev or a
  // deployment. Skipped against the Node server, which has no /ws.
  const wsBase = new URL(URL_.toString());
  wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
  wsBase.pathname = "/ws";

  const openSocket = (key: string, session: string, cursor: number): WebSocket =>
    new WebSocket(`${wsBase}?session=${session}&cursor=${cursor}`, {
      headers: { authorization: `Bearer ${key}` },
    } as never);

  const nextFrame = (ws: WebSocket, ms: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no frame within ${ms}ms`)), ms);
      ws.addEventListener("message", (e) => {
        clearTimeout(t);
        resolve(JSON.parse(String((e as MessageEvent).data)));
      }, { once: true });
    });

  // A bad bearer is refused before any socket exists.
  const refused = openSocket("qk_not_a_real_key", sessionId, 0);
  await new Promise<void>((r) => { refused.addEventListener("error", () => r(), { once: true }); });
  console.log("  ok  /ws refuses a bad bearer");

  const ws = openSocket(jesseKey, sessionId, cursorAfterSetup);
  await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
  console.log("  ok  /ws upgrades a member");

  // Past the ~10s idle eviction, so the object that delivers below is a
  // different instance from the one that accepted this socket. The workerd
  // test proves the mechanism; this proves it against a real deployment.
  await new Promise((r) => setTimeout(r, 15_000));

  const arriving = nextFrame(ws, 10_000);
  await call(peer, "bellman_send", {
    session_id: sessionId, member_id: peerMemberId,
    type: "message", payload: { text: "after eviction" },
  });
  const frame = (await arriving) as { type: string; payload: { text: string } };
  if (frame.payload.text !== "after eviction") {
    throw new Error(`/ws delivered the wrong frame after revival: ${JSON.stringify(frame)}`);
  }
  console.log("  ok  /ws delivers after the object was evicted and revived");
  ws.close();
```

Use whatever names the surrounding script already has for the session id, the
member handles, the keys and the `call` helper; the identifiers above are
placeholders for those.

**Note:** `scripts/smoke.ts` IS in the Node tsc program (`tsconfig.test.json`
includes `scripts`). If the global `WebSocket`/`MessageEvent` types or the
non-standard `headers` option do not typecheck, cast at the call site rather
than widening any shared type.

- [ ] **Step 6: Run it against real Durable Objects**

```bash
npx wrangler dev &
BELLMAN_URL=http://localhost:8787/mcp npm run smoke
```

Expected: every existing check passes, then the three new lines. The run is
~15 seconds longer, which is the eviction wait and is the point.

- [ ] **Step 7: Commit the smoke leg**

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): prove /ws delivers after eviction, against a deployment (#99)

The workerd test in worker-tests gates the mechanism on every commit. This
is the other half: the same claim against whatever BELLMAN_URL points at,
which is the only place the real eviction timer and the real network are
involved."
```

---

### Task 9: Document the delivery path

`docs/ARCHITECTURE.md` is the whole-system view CLAUDE.md sends people to
before they change how the pieces fit together. There are now two delivery
paths, and which clients take which is not guessable from the code.

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:** none.

- [ ] **Step 1: Read what is there**

Run: `grep -n '^#\{1,3\} ' docs/ARCHITECTURE.md`

Find the section covering delivery, waiters, or `bellman_sync`. Match its
voice and depth; do not append a new section at the end if delivery is already
discussed somewhere.

- [ ] **Step 2: Write the delivery section**

It must answer, for someone who has never seen this code:

- **Two paths, one behaviour.** A hibernating WebSocket at `/ws` for clients
  that can reach a local process; `bellman_sync` long-polling for remote MCP
  clients (ChatGPT connectors, Claude's web connector) which cannot. Both are
  served by `wake()`, which is why they cannot drift apart accidentally.
- **Why the socket is cheaper.** A long poll is an in-flight request and keeps
  the object resident, billing duration for its full 128 MB. A hibernating
  socket does not, so a quiet room costs nothing. Give the `$0.005625` per
  watched room-hour figure and say the 400,000 GB-s allowance covers about 1.23
  always-watched rooms account-wide.
- **Why it is not an MCP transport change.** MCP 2026-07-28 defines stdio and
  Streamable HTTP; WebSocket is custom only, and SEP-1287 was closed on
  2025-12-03. Tool calls stay on `/mcp`. Both ends of `/ws` are Bellman's code.
- **The socket is receive-only**, and `webSocketMessage` enforces it.
- **The trust boundary at the route.** The Worker never forwards the caller's
  request to the object; it builds one. Say why, so nobody "simplifies" it.
- **Read-and-register still applies.** Say that `SessionDO.fetch` accepts,
  replays and attaches inside one invocation for the same reason
  `waitForEvents` must not await between reading and pushing, and that the
  rule governs both paths.
- **One socket per (machine, room).** A socket binds to one `SessionDO`, so a
  machine watching three rooms holds three. Note that the client half
  (#43, plan 2) is what makes it one per machine per room rather than one per
  member per session.

Link the spec: `docs/superpowers/specs/2026-09-29-room-delivery-design.md`.

- [ ] **Step 3: Check the writing rules**

```bash
grep -ni 'two sessions\|the other session\|both sessions\|load-bearing' docs/ARCHITECTURE.md
```

Expected: no matches. A room holds many members, not two.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: describe the two delivery paths and why both exist (#99)"
```

---

## Done when

- [ ] `npm run verify` is green.
- [ ] `npm run verify` includes `npm run test:worker`, and `worker-tests/ws-delivery.test.ts`
      passes in real workerd — or, if the pool cannot express eviction, that is
      recorded in the spec's D13 and the file is gone.
- [ ] `BELLMAN_URL=http://localhost:8787/mcp npm run smoke` is green against
      `wrangler dev`, including the eviction check.
- [ ] Every "see it fail on purpose" step has actually been run. There are
      nine, in Tasks 1, 2, 3, 4, 5 (two), 6, 7 and 8 (two: the socket loop, and
      the waiter case's own non-vacuity).
- [ ] `git log` shows one commit per task, each signed.
- [ ] No client behaviour has changed: `src/bridge.ts`, `src/channel.ts` and
      `src/stop-hook.ts` are untouched by this plan, and every existing bridge
      test passes unmodified.
- [ ] PR opened against `main`. Body names #99 and #25, says that #43 and the
      rest of #99 land in plan 2, and states plainly that duration billing
      stopping is Cloudflare's documentation rather than something measured here.
