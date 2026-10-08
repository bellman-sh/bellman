# Room Routes for the Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five HTTP routes beside the blob routes, so a browser can list a person's rooms, read one as their seat sees it, read its working surface cheaply on a poll, and write or remove an item through the same operation the tools use.

**Architecture:** Everything lands in the runtime-free `src/http/rooms.ts` (#183's module), driven by the root test program over `MemoryStore` and dispatched by the Worker and the Node server as the blob routes already are. Reads project through `src/projections.ts`, so the panel and the MCP tools shape a room identically, envelopes included. Writes call `writeSurface` in `src/rooms.ts`, the operation `bellman_send type: "surface"` calls: one write path, two transports, and a route that only maps a `RoomResult` to a status.

**Tech Stack:** TypeScript, web `Request`/`Response`, zod (already in `writeSurface`), vitest in two programs (root over Node, `worker-tests/` in workerd).

**Spec:** `docs/superpowers/specs/2026-10-06-surface-canvas-ui-design.md` (D1, D2, D6 and the Testing section are this plan's half; D3–D5 and D7 are the dash plan's). Issue: bellman-sh/bellman#184.

## Global Constraints

- `src/http/rooms.ts` and everything it imports stay runtime-free: no `@modelcontextprotocol/sdk`, no `cloudflare:workers`. `tests/projections.test.ts` walks the graph and fails otherwise.
- Every route authenticates through `deps.caller` (bearer or cookie, composed by the Worker; the static key map on the Node server) and answers 401 `{ error: "unauthorized" }` without one.
- Every response carries `corsHeaders(origin)`, where `origin` is `allowedOrigin(request, deps.panelOrigins)`; a cookie-authenticated write passes `csrfRefusal(request, who.via, origin)` before anything that writes, `lastSeenAt` included.
- Membership is the tenant boundary: a room the caller holds no handle in and a room that does not exist are one 404 `{ error: "not_found", error_description: "no such room, or no member of yours in it" }`, the blob routes' wording.
- The write routes call `writeSurface(store, blobs, identity, sessionId, memberId, payload)` and nothing else writes; a refusal maps through the existing `STATUS` table (`not_found` 404, `closed` 409, `frozen` 409, `forbidden` 403, `conflict` 409, `invalid` 400).
- Errors keep the OAuth routes' shape through the existing `problem()` helper: `{ error, error_description }`, `cache-control: no-store`.
- The list is bounded at 50 rooms: `MAX_ROOMS_LISTED = 50`, a named constant.
- Peer content stays framed: the surface read returns `surfaceItem` envelopes (`{ trust: "untrusted", origin, data }`) exactly as `bellman_sync surface: true` does; a route never unwraps one.
- Writing rule (CLAUDE.md): a room holds many members. No "two sessions", "the other session", "counterpart" or "other side" in any comment, test name, doc line or commit message. Never the phrases "load-bearing" or "worth saying plainly".
- Commits are signed: `git -c commit.gpgsign=true commit -S -m "..."`; never `git commit -a`; never stage `CLAUDE.md`. Sentence-case subjects that say what changed and why.
- Worker tests run with `npm --prefix worker-tests run test -- -t "<name>"`; root tests with `npx vitest run <file>`; `npm run verify` before the last commit.

## Review Focus

1. A `PUT` whose body is not a JSON object (malformed JSON, an array, a string, an empty body) answers 400 with the route's own wording, never a 500 from `request.json()`. Pinned in Task 4.
2. An `If-None-Match` carrying a weak validator (`W/"3"`), a list (`"2", "3"`), or garbage: a list or weak form that names the current cursor answers 304, garbage answers 200 with the body, nothing answers 500. Pinned in Task 3.
3. A path with a key the grammar refuses (`/rooms/qs/surface/A%2FB`, `/rooms/qs/surface/-bad`) answers 400 through `writeSurface`'s `invalid`, and a path with more segments than the routes know answers 404. Pinned in Task 4.
4. A person who holds two handles in one room (joined from two machines) with one of them removed: the surface read is not cut while a handle of theirs is still in the room, and `my_handles` lists both with `removed` on the right one. Pinned in Tasks 2 and 3.
5. A `PUT` body over 64 KB is refused 413 from its `Content-Length` before it is parsed; an item's fields are bounded at 8,000 characters, and a megabyte of JSON is not an item. Pinned in Task 4.

---

### Task 1: `GET /rooms` — the list, and the dispatch that reaches it

**Files:**
- Modify: `src/http/rooms.ts` (the prefix test, a `LIST` pattern, `listRooms`, `MAX_ROOMS_LISTED`)
- Modify: `src/projections.ts` (`roomSummary`)
- Modify: `src/worker.ts` (the `/rooms/` dispatch also admits `/rooms`)
- Test: `tests/http-rooms.test.ts` (new), `tests/http.test.ts`, `worker-tests/room-routes.test.ts` (new)

**Interfaces:**
- Consumes: `BellmanStore.sessionsCreatedBy(userId, limit)`, `sessionsJoinedBy(userId, limit)`, `getSession(id)`; `sessionStatus(session)` from `src/rooms.ts`; `allowedOrigin`, `corsHeaders`, `preflightResponse` from `src/oauth/browser.ts`; the existing `json`, `problem`, `methodNotAllowed` helpers in `src/http/rooms.ts`.
- Produces: `roomSummary(session: StoredSession, viewerUserId: string, status: string)` in `src/projections.ts` returning `{ id, room, mode, status, members, mine, expires_at }`; `GET /rooms` → 200 `{ rooms: RoomSummary[] }`; `export const MAX_ROOMS_LISTED = 50`.

- [ ] **Step 1: Write the failing tests**

Create `tests/http-rooms.test.ts`. The harness is the blob route test's, so the caller stub and the room fixtures read the same way there.

```ts
/**
 * The room routes the panel calls (#184) over MemoryStore and MemoryBlobStore:
 * the list, the detail, the surface read with its ETag, and the surface writes
 * through the operation the tools call. Driven directly — a web Request in, a
 * Response out — with no listener. Who is calling is a stub over the dev keys,
 * as in tests/http-blobs.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MAX_ROOMS_LISTED, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_routes";

let store: MemoryStore;
let blobs: MemoryBlobStore;
let deps: RoomRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value, read straight off it. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

/** The peer member of the fixture room: a second person, with the seat that cannot write. */
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  deps = { store, blobs, caller, panelOrigins: [PANEL] };
  // jesse (peer_a, the creator) holds write_surface; peer (peer_b) does not;
  // outsider holds no handle at all.
  await store.createSession(session({ id: ROOM, members: [member(), peer()] }));
});

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  cookie?: string;
}

/** One request to the routes. `key` null sends no credential at all. */
function call(key: string | null, path: string, over: CallOptions = {}) {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  let body: string | undefined;
  if (over.rawBody !== undefined) body = over.rawBody;
  else if (over.body !== undefined) body = JSON.stringify(over.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return roomRoutes(new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers, body }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

describe("GET /rooms", () => {
  it("refuses without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/rooms", { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await bodyOf(res)).toMatchObject({ error: "unauthorized" });
  });

  it("lists the rooms I created and the rooms I joined, marks mine, and omits a room I hold no handle in", async () => {
    // Created by jesse: the fixture room. Joined by jesse, created by peer: a second.
    await store.createSession(session({
      id: "qs_joined", createdBy: "u_peer",
      members: [peer(), member({ memberId: "m_jesse2", roomRole: "peer_b" })],
    }));
    // Created by jesse on the record, but jesse holds no handle: not listed, whatever the index says.
    await store.createSession(session({ id: "qs_stranger", members: [peer()] }));
    const res = (await call(DEV_KEY.jesse, "/rooms"))!;
    expect(res.status).toBe(200);
    const { rooms } = (await res.json()) as { rooms: { id: string; mine: boolean; members: number; status: string; mode: string; expires_at: string }[] };
    const ids = rooms.map((r) => r.id).sort();
    expect(ids).toEqual(["qs_joined", ROOM]);
    expect(rooms.find((r) => r.id === ROOM)).toMatchObject({ mine: true, members: 2, status: "active", mode: "pair" });
    expect(rooms.find((r) => r.id === "qs_joined")).toMatchObject({ mine: false });
    expect(Date.parse(rooms[0].expires_at)).toBeGreaterThan(Date.now());
    expect(Object.keys(rooms[0]).sort()).toEqual(["expires_at", "id", "members", "mine", "mode", "room", "status"]);
  });

  it("lists a closed room with its status, and counts only the members still in", async () => {
    const departed = member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b", leftAt: Date.now() });
    await store.createSession(session({ id: "qs_closed", closed: true, members: [member(), departed] }));
    const res = (await call(DEV_KEY.jesse, "/rooms"))!;
    const { rooms } = (await res.json()) as { rooms: { id: string; status: string; members: number }[] };
    expect(rooms.find((r) => r.id === "qs_closed")).toMatchObject({ status: "closed", members: 1 });
  });

  it("is bounded at MAX_ROOMS_LISTED", async () => {
    for (let i = 0; i < MAX_ROOMS_LISTED + 5; i++) {
      await store.createSession(session({ id: `qs_many_${i}`, members: [member()] }));
    }
    const { rooms } = (await bodyOf(await call(DEV_KEY.jesse, "/rooms"))) as { rooms: unknown[] };
    expect(rooms.length).toBe(MAX_ROOMS_LISTED);
  });

  it("answers the list for a cookie caller and a preflight for the panel", async () => {
    const res = (await call(null, "/rooms", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(res.status).toBe(200);
    const pre = (await call(null, "/rooms", { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("answers 405 to a method the list does not take", async () => {
    const res = (await call(DEV_KEY.jesse, "/rooms", { method: "POST", body: {} }))!;
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
```

Add to `tests/http.test.ts` (the Node app), beside its existing `/rooms` bodiless test, one case that the list path reaches the module:

```ts
  it("serves GET /rooms, with no trailing slash, from the room routes module", async () => {
    const res = await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ rooms: [] });
  });
```

(Read the file first for the names it uses for the base URL and the key; `base` and `DEV_KEY` are what its other tests use, or the nearest equivalents.)

Create `worker-tests/room-routes.test.ts`, in the style of `worker-tests/blobs-route.test.ts` (copy its imports, its `SELF`/`env` setup and its bearer):

```ts
/**
 * The Worker's dispatch for the room routes (#184): `/rooms` with no trailing
 * slash must reach src/http/rooms.ts, which the blob routes' prefix test did
 * not admit. One request through the real fetch handler proves the condition.
 */
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("GET /rooms through the Worker", () => {
  it("reaches the room routes module with no trailing slash", async () => {
    const res = await SELF.fetch("https://mcp.example.test/rooms", {
      headers: { authorization: "Bearer qk_dev_jesse" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [] });
  });
});
```

Read `worker-tests/blobs-route.test.ts` for how it reaches the Worker (the host it uses, how the dev key is configured in `worker-tests/wrangler.toml`), and match it exactly; the shape above is the assertion, not the plumbing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/http-rooms.test.ts tests/http.test.ts`
Expected: FAIL — `MAX_ROOMS_LISTED` is not exported; `GET /rooms` answers 404 "Not found" on the Node app.

Run: `npm --prefix worker-tests run test -- -t "no trailing slash"`
Expected: FAIL — the Worker falls through to the OAuth routes and answers 404.

- [ ] **Step 3: Add `roomSummary` to the projections**

In `src/projections.ts`, after `roomPreview`:

```ts
/**
 * A room on a person's list (#184, D1): identifiers, the server's numbers,
 * and the room's name. `room` is creator prose; the panel renders it as text
 * and never as markup, which is what makes it safe to carry unwrapped here
 * where `roomPreview` wraps it for a joiner's MODEL. `status` is handed in
 * because `sessionStatus` lives in rooms.ts, which imports this module.
 */
export function roomSummary(s: StoredSession, viewerUserId: string, status: string) {
  return {
    id: s.id,
    room: s.manifest.room,
    mode: s.manifest.mode,
    status,
    members: s.members.filter((m) => m.leftAt === null).length,
    mine: s.createdBy === viewerUserId,
    expires_at: new Date(s.expiresAt).toISOString(),
  };
}
```

- [ ] **Step 4: Add the list route and widen the prefix test**

In `src/http/rooms.ts`:

```ts
import { findMember, gateSeat, sessionStatus, type RoomFailure } from "../rooms.js";
import { roomSummary } from "../projections.js";
import type { StoredSession } from "../stored-session.js";
```

```ts
// ponytail: fifty rooms, not paged. The first account past it wants #49's
// summary index, not a bigger number.
export const MAX_ROOMS_LISTED = 50;

const LIST = /^\/rooms$/;
```

Change the prefix test at the top of `roomRoutes`:

```ts
  if (path !== "/rooms" && !path.startsWith("/rooms/")) return undefined;
```

And inside the `try`, before the `UPLOAD` match:

```ts
    if (LIST.test(path)) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await listRooms(request, origin, deps);
    }
```

Then the handler:

```ts
/**
 * The list (D1): every room this person created or holds a handle in, from the
 * two registry listings, each resolved with one `getSession`. Membership is
 * checked on the record, not trusted from the index: a listing row names a room,
 * and only the roster says whether this person is in it. Newest first, by the
 * creator's seat, since a room has no creation stamp of its own.
 */
async function listRooms(request: Request, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const userId = who.identity.userId;
  const [created, joined] = await Promise.all([
    deps.store.sessionsCreatedBy(userId, MAX_ROOMS_LISTED),
    deps.store.sessionsJoinedBy(userId, MAX_ROOMS_LISTED),
  ]);
  const ids = [...new Set([...created, ...joined])];
  const found = await Promise.all(ids.map((id) => deps.store.getSession(id)));
  const rooms = found
    .filter((s): s is StoredSession => s !== undefined && s.members.some((m) => m.userId === userId))
    .sort((a, b) => b.members[0].joinedAt - a.members[0].joinedAt)
    .slice(0, MAX_ROOMS_LISTED)
    .map((s) => roomSummary(s, userId, sessionStatus(s)));
  return json(200, { rooms }, origin);
}
```

In `src/worker.ts`, the dispatch condition:

```ts
    if (url.pathname === "/rooms" || url.pathname.startsWith("/rooms/")) {
```

Update the comment above it so it names the list. `src/app.ts` needs nothing: `app.use("/rooms", ...)` already matches the bare path, and the module now answers it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/http-rooms.test.ts tests/http.test.ts tests/projections.test.ts`
Expected: PASS.

Run: `npm --prefix worker-tests run test -- -t "no trailing slash"`
Expected: PASS.

Control, then restore: change the Worker's condition back to `startsWith("/rooms/")` alone and rerun the worker test — it must go red (404). Change the module's prefix test back and rerun the Node test — red. Quote both reds in the report.

- [ ] **Step 6: Commit**

```bash
git add src/http/rooms.ts src/projections.ts src/worker.ts tests/http-rooms.test.ts tests/http.test.ts worker-tests/room-routes.test.ts
git -c commit.gpgsign=true commit -S -m "List a person's rooms over HTTP, from the two registry listings and the roster's say-so"
```

---

### Task 2: `GET /rooms/:id` — the room as my seat sees it

**Files:**
- Modify: `src/http/rooms.ts` (`DETAIL` pattern, `handlesOf`, `roomDetail`)
- Test: `tests/http-rooms.test.ts`

**Interfaces:**
- Consumes: `roomPreview(session, viewerRole)`, `publicMember(member, connected)` from `src/projections.ts`; `verbsOfRole(manifest, role)` from `src/roles.ts`; `isRemovedMember` from `src/store.ts`; `BellmanStore.connectedMembers(sessionId)`.
- Produces: `GET /rooms/:id` → 200 `{ id, session_status, expires_at, preview, members, my_handles }` where `my_handles` is `[{ member_id, room_role, verbs, active, removed }]`; the helper `handlesOf(session, identity): Member[]` reused by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/http-rooms.test.ts`:

```ts
describe("GET /rooms/:id", () => {
  it("answers one 404 for a stranger and for an unknown room", async () => {
    const stranger = (await call(DEV_KEY.outsider, `/rooms/${ROOM}`))!;
    const unknown = (await call(DEV_KEY.jesse, "/rooms/qs_nope"))!;
    expect([stranger.status, unknown.status]).toEqual([404, 404]);
    expect(await bodyOf(stranger)).toEqual(await bodyOf(unknown));
  });

  it("returns the preview for my seat, the roster, the status, and my handles with their verbs", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}`))!;
    expect(res.status).toBe(200);
    const body = await bodyOf(res) as {
      id: string; session_status: string; expires_at: string;
      preview: { your_role: string; your_verbs: string[]; text: { trust: string } };
      members: { member_id: string; presence: string; active: boolean }[];
      my_handles: { member_id: string; room_role: string; verbs: string[]; active: boolean; removed: boolean }[];
    };
    expect(body.id).toBe(ROOM);
    expect(body.session_status).toBe("active");
    expect(body.preview.your_role).toBe("peer_a");
    expect(body.preview.your_verbs).toContain("write_surface");
    expect(body.preview.text.trust).toBe("untrusted");
    expect(body.members.map((m) => m.member_id).sort()).toEqual(["m_creator", "m_peer"]);
    expect(body.members[0]).toHaveProperty("presence");
    expect(body.my_handles).toEqual([
      { member_id: "m_creator", room_role: "peer_a", verbs: expect.arrayContaining(["write_surface"]), active: true, removed: false },
    ]);
  });

  it("gives a seat without the verb a preview that says so", async () => {
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}`)) as { my_handles: { verbs: string[] }[] };
    expect(body.my_handles[0].verbs).not.toContain("write_surface");
  });

  it("lists every handle I hold, and names the removed one", async () => {
    // Joined twice: one handle removed by the creator, one still in.
    await store.createSession(session({
      id: "qs_two", createdBy: "u_peer",
      members: [
        peer(),
        member({ memberId: "m_old", roomRole: "peer_b", leftAt: Date.now(), removedAtCursor: 3 }),
        member({ memberId: "m_new", roomRole: "peer_b" }),
      ],
    }));
    const body = await bodyOf(await call(DEV_KEY.jesse, "/rooms/qs_two")) as {
      preview: { your_role: string }; my_handles: { member_id: string; active: boolean; removed: boolean }[];
    };
    expect(body.my_handles).toEqual([
      { member_id: "m_old", room_role: "peer_b", verbs: expect.any(Array), active: false, removed: true },
      { member_id: "m_new", room_role: "peer_b", verbs: expect.any(Array), active: true, removed: false },
    ]);
    expect(body.preview.your_role).toBe("peer_b");
  });

  it("still answers a member who left, and a closed room", async () => {
    await store.createSession(session({ id: "qs_gone", closed: true, members: [member({ leftAt: Date.now() })] }));
    const res = (await call(DEV_KEY.jesse, "/rooms/qs_gone"))!;
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ session_status: "closed", my_handles: [{ active: false, removed: false }] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/http-rooms.test.ts -t "GET /rooms/:id"`
Expected: FAIL — every detail request answers 404 "no such route".

- [ ] **Step 3: Add the detail route**

In `src/http/rooms.ts`:

```ts
import { publicMember, roomPreview, roomSummary } from "../projections.js";
import { verbsOfRole } from "../roles.js";
import type { Identity, Member } from "../types.js";
```

```ts
const DETAIL = /^\/rooms\/([^/]+)$/;
```

In the `try`, after the `LIST` branch:

```ts
    const detail = DETAIL.exec(path);
    if (detail) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await roomDetail(request, detail[1], origin, deps);
    }
```

The helper and the handler:

```ts
/** Every handle this person holds in the room, in roster order. Empty means a stranger. */
const handlesOf = (session: StoredSession, identity: Identity): Member[] =>
  session.members.filter((m) => m.userId === identity.userId);

/**
 * The room as my seat sees it (D1). The preview is `roomPreview` for the role
 * of the handle still in the room — or, when none is, the first one held — so
 * what the page shows is what a joiner was shown. `my_handles` is what the
 * page needs to pick a seat for a write: the server refuses either way (D6).
 * A member who left, a removed member and a closed room are all served: reads
 * stay open, and what a removed member may READ is bounded at the surface
 * route, where the cut applies.
 */
async function roomDetail(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  if (!session || mine.length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const connected = await deps.store.connectedMembers(sessionId);
  const viewer = mine.find((m) => m.leftAt === null) ?? mine[0];
  return json(200, {
    id: session.id,
    session_status: sessionStatus(session),
    expires_at: new Date(session.expiresAt).toISOString(),
    preview: roomPreview(session, viewer.roomRole),
    members: session.members.map((m) => publicMember(m, connected)),
    my_handles: mine.map((m) => ({
      member_id: m.memberId,
      room_role: m.roomRole,
      verbs: verbsOfRole(session.manifest, m.roomRole),
      active: m.leftAt === null,
      removed: isRemovedMember(m),
    })),
  }, origin);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/http-rooms.test.ts tests/projections.test.ts`
Expected: PASS.

Control, then restore: in a scratch run give the two-handle fixture's `m_old` the role `peer_a`, make `viewer` always `mine[0]`, and confirm `your_role` reads `peer_a` (red) where the `find` reads `peer_b`; restore both. Quote the red.

- [ ] **Step 5: Commit**

```bash
git add src/http/rooms.ts tests/http-rooms.test.ts
git -c commit.gpgsign=true commit -S -m "Read a room over HTTP as the caller's seat sees it, with the handles they hold and the verbs each one carries"
```

---

### Task 3: `GET /rooms/:id/surface` — the read, its ETag, and the cut

**Files:**
- Modify: `src/http/rooms.ts` (`SURFACE` pattern, `etagMatches`, `cutFor`, `readSurfaceRoute`)
- Modify: `docs/superpowers/specs/2026-10-06-surface-canvas-ui-design.md` (D2: the response shape)
- Test: `tests/http-rooms.test.ts`

**Interfaces:**
- Consumes: `readSurface(store, session, cut?)` from `src/rooms.ts` → `{ cursor, items }`; `surfaceCursor(session)` from `src/surface.ts`; `handlesOf` from Task 2.
- Produces: `GET /rooms/:id/surface` → 200 `{ surface_cursor, items }` with `ETag: "<surface_cursor>"`, or 304 with the same `ETag` when `If-None-Match` names it; `cutFor(handles): number | undefined`.

**Ruling recorded here (spec D2 amended in Step 5):** the response is `{ surface_cursor, items }`, not `{ cursor, surface_cursor, items }`. The session record carries the surface cursor and not the log's head, so `cursor` would cost the log read the ETag exists to avoid, and the page has no use for it until the timeline (#49).

- [ ] **Step 1: Write the failing tests**

Append to `tests/http-rooms.test.ts` (add `Harness` to the import from `./helpers/harness.js`):

```ts
/** Write one item through the tool, so the route's read has something to show. */
async function placeThroughTool(key: string, payload: Record<string, unknown>) {
  const h = new Harness(store, blobs);
  const jesse = await h.connect(DEV_KEY.jesse);
  const out = await jesse.call("bellman_send", { session_id: ROOM, member_id: "m_creator", type: "surface", payload: { key, ...payload } });
  await h.close();
  expect(out.isError, out.text).toBe(false);
  return out.data as { cursor: number };
}

/** Record a removal on one handle: `leftAt` and the cut, as `markRemoved` writes them. */
async function removeHandle(memberId: string, cut: number) {
  const s = (await store.getSession(ROOM))!;
  const m = s.members.find((mm) => mm.memberId === memberId)!;
  m.leftAt = Date.now();
  m.removedAtCursor = cut;
}

describe("GET /rooms/:id/surface", () => {
  it("returns every item in an untrusted envelope, with the surface cursor as the ETag", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "# Plan\nship it" });
    const res = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`, { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${cursor}"`);
    // Exposed by name, or a cross-origin fetch in the panel cannot read it.
    expect(res.headers.get("access-control-expose-headers")).toBe("etag");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res) as { surface_cursor: number; items: { trust: string; origin: { memberId: string }; data: { key: string; body: string } }[] };
    expect(body.surface_cursor).toBe(cursor);
    expect(body.items).toEqual([
      { trust: "untrusted", origin: { memberId: "m_creator", label: "jesse@codenerd" }, data: expect.objectContaining({ key: "plan", kind: "text", body: "# Plan\nship it", cursor }) },
    ]);
    expect(Object.keys(body).sort()).toEqual(["items", "surface_cursor"]);
  });

  it("answers 304 from the record alone when If-None-Match names the cursor, and 200 once a write moves it", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    const reads = { n: 0 };
    const original = store.surfaceOf.bind(store);
    store.surfaceOf = async (id: string) => { reads.n++; return original(id); };
    const same = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${cursor}"` } }))!;
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(`"${cursor}"`);
    expect(await same.text()).toBe("");
    expect(reads.n).toBe(0);
    const next = await placeThroughTool("plan", { kind: "text", body: "v2" });
    const moved = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${cursor}"` } }))!;
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).toBe(`"${next.cursor}"`);
  });

  it("matches a weak validator and a list, and treats garbage as a miss, never a throw", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    for (const header of [`W/"${cursor}"`, `"1", "${cursor}"`, "*"]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": header } }))!;
      expect(res.status, header).toBe(304);
    }
    for (const header of ["garbage", `"${cursor + 1}"`, ""]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": header } }))!;
      expect(res.status, header).toBe(200);
    }
  });

  it("answers an empty surface with cursor 0 and an ETag of \"0\"", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"0"');
    expect(await bodyOf(res)).toEqual({ surface_cursor: 0, items: [] });
  });

  it("stops a removed member at its cut, and derives the cursor from what it is shown", async () => {
    const first = await placeThroughTool("a", { kind: "text", body: "before" });
    await placeThroughTool("b", { kind: "text", body: "after" });
    await removeHandle("m_peer", first.cursor);
    const res = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`))!;
    const body = await bodyOf(res) as { surface_cursor: number; items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a"]);
    expect(body.surface_cursor).toBe(first.cursor);
    expect(res.headers.get("etag")).toBe(`"${first.cursor}"`);
  });

  it("does not cut a person while one of their handles is still in the room", async () => {
    const first = await placeThroughTool("a", { kind: "text", body: "before" });
    await placeThroughTool("b", { kind: "text", body: "after" });
    await removeHandle("m_peer", first.cursor);
    await store.addMember(ROOM, member({ memberId: "m_peer2", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }));
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a", "b"]);
  });

  it("answers one 404 for a stranger and an unknown room", async () => {
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/surface`))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, "/rooms/qs_nope/surface"))!.status).toBe(404);
  });
});
```

Two notes for the implementer. `removeHandle` mutates the record `MemoryStore.getSession` returns; read `src/store.ts` for whether that store hands out the live object or a copy — if a copy, write the two fields through `store.updateMember(ROOM, memberId, patch)` instead (read `MemberPatch` for the fields it accepts; if `removedAtCursor` is not among them, use `store.removeMember` with a request whose `cut` is set, the way an eviction does). The fixture must end with `removedAtCursor` set on `m_peer` and nothing else changed. And the `surfaceOf` spy counts reads for the 304 case; nothing needs restoring, since `beforeEach` builds a fresh store.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/http-rooms.test.ts -t "surface"`
Expected: FAIL — 404 "no such route" on every read.

- [ ] **Step 3: Add the surface read**

In `src/http/rooms.ts`:

```ts
import { findMember, gateSeat, readSurface, sessionStatus, type RoomFailure } from "../rooms.js";
import { surfaceCursor } from "../surface.js";
```

```ts
const SURFACE = /^\/rooms\/([^/]+)\/surface$/;

/** The validator for a surface cursor: the number, quoted, as RFC 9110 wants a strong ETag. */
const surfaceTag = (cursor: number): string => `"${cursor}"`;

/**
 * Whether an If-None-Match header names `tag`. A list, a weak validator and `*`
 * all count; anything else is a miss, so a garbled header costs a body and
 * never a 500.
 */
const etagMatches = (header: string | null, tag: string): boolean =>
  header !== null && header.split(",").some((v) => {
    const t = v.trim().replace(/^W\//, "");
    return t === "*" || t === tag;
  });

/**
 * Where a person's reading stops (#113), if anywhere. Only when every handle
 * they hold was removed: a handle still in the room, or one that left of its
 * own accord, keeps the open feed, as it does on `bellman_sync`. With several
 * removed handles, the latest cut: the most this person was ever shown.
 */
const cutFor = (handles: readonly Member[]): number | undefined =>
  handles.every(isRemovedMember)
    ? Math.max(...handles.map((m) => m.removedAtCursor ?? 0))
    : undefined;
```

In the `try`, after the `DETAIL` branch:

```ts
    const surface = SURFACE.exec(path);
    if (surface) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await readSurfaceRoute(request, surface[1], origin, deps);
    }
```

The handler:

```ts
/**
 * The surface read (D2): the same envelopes `bellman_sync surface: true`
 * returns, with the surface cursor as the ETag. A member still in the room is
 * answered from the record alone on a match — no row read, which is what makes
 * a four-second poll cheap. A removed member reads to its cut, and its cursor
 * is derived from the rows it is shown, as the tool derives it: the record's
 * number would claim a change the member never saw.
 */
async function readSurfaceRoute(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  if (!session || mine.length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  // The page reads the ETag off a cross-origin response, which CORS hides
  // unless the header is exposed by name; on the 304 as on the 200.
  const exposed = { ...corsHeaders(origin), "access-control-expose-headers": "etag" };
  const notModified = (cursor: number) =>
    new Response(null, { status: 304, headers: { ...exposed, "cache-control": "no-store", etag: surfaceTag(cursor) } });

  const cut = cutFor(mine);
  if (cut === undefined && etagMatches(ifNoneMatch, surfaceTag(surfaceCursor(session)))) {
    return notModified(surfaceCursor(session));
  }
  const block = await readSurface(deps.store, session, cut);
  if (cut !== undefined && etagMatches(ifNoneMatch, surfaceTag(block.cursor))) return notModified(block.cursor);
  const res = json(200, { surface_cursor: block.cursor, items: block.items }, origin);
  res.headers.set("etag", surfaceTag(block.cursor));
  res.headers.set("access-control-expose-headers", "etag");
  return res;
}
```

`json()` builds a `Response` whose headers are mutable; if they are not in this runtime, build the `Response` inline with the same headers plus `etag`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/http-rooms.test.ts tests/projections.test.ts`
Expected: PASS.

Controls, then restore, quoting each red: (a) drop the `.replace(/^W\//, "")` — the weak-validator case goes red; (b) make `cutFor` return the cut when `some` handle is removed rather than `every` — the two-handle case goes red; (c) read the rows before the 304 decision for a member in the room — the `reads.n` assertion goes red.

- [ ] **Step 5: Amend the spec's D2 and commit**

In `docs/superpowers/specs/2026-10-06-surface-canvas-ui-design.md`, D2's first sentence becomes:

> `GET /rooms/:id/surface` answers `{ surface_cursor, items }` with the same projection `bellman_sync surface: true` returns — envelopes intact, the #49 rule that peer content stays framed. The log's own `cursor` is not in it: the record carries the surface cursor and not the log's head, so it would cost the row read the ETag exists to avoid, and the page has no use for it until the timeline (#49).

Keep the rest of D2 as it is.

```bash
git add src/http/rooms.ts tests/http-rooms.test.ts docs/superpowers/specs/2026-10-06-surface-canvas-ui-design.md
git -c commit.gpgsign=true commit -S -m "Read a room's surface over HTTP with the surface cursor as its ETag, so a poll that finds nothing new reads no rows"
```

---

### Task 4: `PUT` and `DELETE /rooms/:id/surface/:key` — the writes, through the operation the tools call

**Files:**
- Modify: `src/http/rooms.ts` (`SURFACE_ITEM` pattern, `MAX_SURFACE_WRITE_BYTES`, `writeSurfaceRoute`)
- Modify: `src/oauth/browser.ts` (`ALLOWED_METHODS` gains `PUT`)
- Test: `tests/http-rooms.test.ts`, `tests/browser-safety.test.ts`

**Interfaces:**
- Consumes: `writeSurface(store, blobs, identity, sessionId, memberId, payload)` from `src/rooms.ts` → `RoomResult<{ cursor, replayed, roomMembers }>`; `findMember`, `STATUS`, `csrfRefusal`.
- Produces: `PUT /rooms/:id/surface/:key?member_id=` with a JSON body that is the item without its key (`{ kind, title?, body?, ends?, placement?, blob? }`; a `key` in the body must equal the path's) → 200 `{ cursor, room_members }`; `DELETE /rooms/:id/surface/:key?member_id=` → 200 `{ cursor, room_members }`; `export const MAX_SURFACE_WRITE_BYTES = 64 * 1024`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/http-rooms.test.ts`:

```ts
const put = (key: string | null, itemKey: string, body: unknown, over: CallOptions & { member?: string | null; room?: string } = {}) => {
  const q = over.member === null ? "" : `?member_id=${over.member ?? "m_creator"}`;
  return call(key, `/rooms/${over.room ?? ROOM}/surface/${itemKey}${q}`, { method: "PUT", body, ...over });
};
const del = (key: string | null, itemKey: string, over: CallOptions & { member?: string | null } = {}) => {
  const q = over.member === null ? "" : `?member_id=${over.member ?? "m_creator"}`;
  return call(key, `/rooms/${ROOM}/surface/${itemKey}${q}`, { method: "DELETE", ...over });
};

/** The surface as the tool reads it, for the agreement tests. */
async function surfaceThroughTool(key: string, memberId: string) {
  const h = new Harness(store, blobs);
  const p = await h.connect(key);
  const out = await p.call("bellman_sync", { session_id: ROOM, member_id: memberId, since_cursor: 0, wait_seconds: 0, surface: true });
  await h.close();
  return out.data as { surface?: { cursor: number; items: unknown[] }; surface_cursor?: number };
}

describe("PUT and DELETE /rooms/:id/surface/:key", () => {
  it("writes an item through the route, and the tool reads back exactly what the route reads", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", title: "Plan", body: "ship it", placement: { x: 10, y: 20 } }))!;
    expect(res.status, await res.clone().text()).toBe(200);
    const out = await bodyOf(res) as { cursor: number; room_members: string[] };
    expect(out.room_members).toEqual(["peer@codenerd"]);
    const viaRoute = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { surface_cursor: number; items: unknown[] };
    const viaTool = await surfaceThroughTool(DEV_KEY.peer, "m_peer");
    expect(viaRoute.items).toEqual(viaTool.surface!.items);
    expect(viaRoute.surface_cursor).toBe(viaTool.surface_cursor);
    expect(viaRoute.surface_cursor).toBe(out.cursor);
  });

  it("reads back through the route what the tool wrote, and replaces by key", async () => {
    await placeThroughTool("plan", { kind: "text", body: "v1" });
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "v2" }))!;
    expect(res.status).toBe(200);
    const body = await bodyOf(await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string; body: string } }[] };
    expect(body.items.map((i) => [i.data.key, i.data.body])).toEqual([["plan", "v2"]]);
  });

  it("removes an item, and the tool no longer sees it", async () => {
    await placeThroughTool("plan", { kind: "text", body: "v1" });
    const res = (await del(DEV_KEY.jesse, "plan"))!;
    expect(res.status).toBe(200);
    expect((await surfaceThroughTool(DEV_KEY.jesse, "m_creator")).surface!.items).toEqual([]);
  });

  it("refuses a seat without the verb, and the log is unchanged", async () => {
    const before = (await store.eventsAfter(ROOM, 0)).length;
    const res = (await put(DEV_KEY.peer, "plan", { kind: "text", body: "mine" }, { member: "m_peer" }))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "forbidden" });
    expect((await store.eventsAfter(ROOM, 0)).length).toBe(before);
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  it("answers 404 for a handle that is not the caller's, before any gate", async () => {
    const res = (await put(DEV_KEY.peer, "plan", { kind: "text", body: "x" }, { member: "m_creator" }))!;
    expect(res.status).toBe(404);
  });

  it("requires member_id", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { member: null }))!;
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({ error_description: expect.stringContaining("member_id") });
  });

  it("maps the operation's refusals to statuses: invalid is 400, a frozen room is 409", async () => {
    const invalid = (await put(DEV_KEY.jesse, "plan", { kind: "link", body: "not a url" }))!;
    expect(invalid.status).toBe(400);
    expect(await bodyOf(invalid)).toMatchObject({ error: "invalid", error_description: expect.stringContaining("http") });
    await store.freezeSession(ROOM, Date.now());
    const frozen = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }))!;
    expect(frozen.status).toBe(409);
    expect(await bodyOf(frozen)).toMatchObject({ error: "frozen" });
  });

  it("refuses a body that is not a JSON object with the route's own 400", async () => {
    for (const rawBody of ["not json", "[1,2]", '"text"', ""]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan?member_id=m_creator`, { method: "PUT", rawBody }))!;
      expect(res.status, JSON.stringify(rawBody)).toBe(400);
      expect(await bodyOf(res)).toMatchObject({ error: "invalid_request" });
    }
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  it("refuses a body whose key disagrees with the path, and accepts one that agrees", async () => {
    const clash = (await put(DEV_KEY.jesse, "plan", { key: "other", kind: "text", body: "x" }))!;
    expect(clash.status).toBe(400);
    const same = (await put(DEV_KEY.jesse, "plan", { key: "plan", kind: "text", body: "x" }))!;
    expect(same.status).toBe(200);
  });

  it("refuses a key the grammar refuses with the operation's 400, a malformed escape with 400, and an unknown deeper path with 404", async () => {
    const bad = (await put(DEV_KEY.jesse, "-bad", { kind: "text", body: "x" }))!;
    expect(bad.status).toBe(400);
    const slash = (await put(DEV_KEY.jesse, "a%2Fb", { kind: "text", body: "x" }))!;
    expect(slash.status).toBe(400);
    const escape = (await put(DEV_KEY.jesse, "%E0%A4%A", { kind: "text", body: "x" }))!;
    expect(escape.status).toBe(400);
    const deeper = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan/more?member_id=m_creator`, { method: "PUT", body: {} }))!;
    expect(deeper.status).toBe(404);
  });

  it("refuses a body over MAX_SURFACE_WRITE_BYTES from its Content-Length, unparsed", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { headers: { "content-length": String(64 * 1024 + 1) } }))!;
    expect(res.status).toBe(413);
  });

  it("refuses a cookie write without the panel's Origin before touching the seat, and takes one with it", async () => {
    const seenBefore = (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_creator")!.lastSeenAt;
    const forged = (await put(null, "plan", { kind: "text", body: "x" }, { cookie: DEV_KEY.jesse }))!;
    expect(forged.status).toBe(403);
    expect((await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_creator")!.lastSeenAt).toBe(seenBefore);
    const real = (await put(null, "plan", { kind: "text", body: "x" }, { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(real.status).toBe(200);
    const gone = (await del(null, "plan", { cookie: DEV_KEY.jesse }))!;
    expect(gone.status).toBe(403);
  });

  it("answers the preflight for a PUT", async () => {
    const pre = (await call(null, `/rooms/${ROOM}/surface/plan`, { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(pre.headers.get("access-control-allow-headers")).toContain("if-none-match");
  });
});
```

Note on the forged-cookie case: the fixture sets `lastSeenAt` to `Date.now()` at creation, so the equality holds unless the test sleeps; if it proves flaky, pin the fixture's `lastSeenAt` to a constant.

In `tests/browser-safety.test.ts`, beside the assertion that the preflight allows `DELETE`, add:

```ts
    expect(preflightResponse(PANEL).headers.get("access-control-allow-methods")).toContain("PUT");
    expect(preflightResponse(PANEL).headers.get("access-control-allow-headers")).toContain("if-none-match");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/http-rooms.test.ts tests/browser-safety.test.ts -t "PUT"`
Expected: FAIL — 404 "no such route" on the writes; the preflight lacks `PUT`.

- [ ] **Step 3: Add the writes**

In `src/oauth/browser.ts`:

```ts
/** The methods the panel uses. Explicit rather than echoing the request. */
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
```

and in `preflightResponse`, the allowed request headers become `"content-type, if-none-match"`, with a comment: the page sends `If-None-Match` on its surface poll, which is not a CORS-safelisted request header, so the browser asks first and must be told yes.

In `src/http/rooms.ts`:

```ts
import { findMember, gateSeat, readSurface, sessionStatus, writeSurface, type RoomFailure } from "../rooms.js";
```

```ts
const SURFACE_ITEM = /^\/rooms\/([^/]+)\/surface\/([^/]+)$/;

// ponytail: 64 KB, not tuned. An item's largest field is 8,000 characters;
// this is the bound on the JSON around it, read off the header before parsing.
export const MAX_SURFACE_WRITE_BYTES = 64 * 1024;
```

In the `try`, after the `SURFACE` branch:

```ts
    const item = SURFACE_ITEM.exec(path);
    if (item) {
      if (request.method !== "PUT" && request.method !== "DELETE") return methodNotAllowed("PUT, DELETE", origin);
      let key: string;
      try {
        key = decodeURIComponent(item[2]);
      } catch {
        return problem(400, "invalid_request", "the key is not valid percent-encoding", origin);
      }
      return await writeSurfaceRoute(request, url, item[1], key, origin, deps);
    }
```

The handler:

```ts
/**
 * The writes (D1, D6): a PUT whose body is the item, a DELETE that removes the
 * key. Both call `writeSurface`, the operation `bellman_send type: "surface"`
 * calls, so the verb guard, the blob head, the connector check, the audit row
 * and the event are one sequence for both transports; this maps the result to
 * a status and nothing else. The key is the path's; a body that names another
 * is refused rather than silently rekeyed.
 */
async function writeSurfaceRoute(
  request: Request,
  url: URL,
  sessionId: string,
  key: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);

  let payload: unknown;
  if (request.method === "DELETE") {
    payload = { key, remove: true };
  } else {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_SURFACE_WRITE_BYTES) {
      return problem(413, "too_large", `a surface write is at most ${MAX_SURFACE_WRITE_BYTES} bytes of JSON`, origin);
    }
    const notObject = () => problem(400, "invalid_request", "the body must be a JSON object: the item, without its key or with the path's", origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return notObject();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return notObject();
    const given = (body as { key?: unknown }).key;
    if (given !== undefined && given !== key) {
      return problem(400, "invalid_request", `the body names key ${JSON.stringify(given)} but the path names "${key}"`, origin);
    }
    payload = { ...(body as Record<string, unknown>), key };
  }

  // A stranger's answer is the unknown room's answer, before the gate, as on
  // an upload: a handle that is not the caller's is 404, and the gate's
  // `forbidden` then means the seat itself.
  const found = await deps.store.getSession(sessionId);
  if (!found || !findMember(found, memberId, who.identity)) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const out = await writeSurface(deps.store, deps.blobs, who.identity, sessionId, memberId, payload);
  if (!out.ok) return problem(STATUS[out.code], out.code, out.reason, origin);
  return json(200, { cursor: out.value.cursor, room_members: out.value.roomMembers }, origin);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/http-rooms.test.ts tests/browser-safety.test.ts tests/http-blobs.test.ts tests/projections.test.ts`
Expected: PASS.

Controls, then restore, quoting each red: (a) move the `csrfRefusal` call below the `writeSurface` call — the forged-cookie `lastSeenAt` assertion goes red, because `gateSeat` inside `writeSurface` touches the seat; (b) drop the `Array.isArray` test — the `[1,2]` case goes red; (c) drop the key-disagreement check — the clash case goes red; (d) drop the 413 — its case goes red.

- [ ] **Step 5: Commit**

```bash
git add src/http/rooms.ts src/oauth/browser.ts tests/http-rooms.test.ts tests/browser-safety.test.ts
git -c commit.gpgsign=true commit -S -m "Write and remove surface items over HTTP through the operation the tools call, so the verb guard and the audit row cannot differ by transport"
```

---

### Task 5: Documents and the whole-tree check

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§4, §8, the frontmatter's `last-verified-against-source` and `last-updated`)
- Modify: `src/http/rooms.ts` (the module's header comment)
- Modify: `README.md` (the control panel paragraph, if one names what the panel can reach)
- Test: `npm run verify`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new; the tree the dash plan builds against.

- [ ] **Step 1: The module header**

Replace the first paragraph of the docblock at the top of `src/http/rooms.ts` with:

```ts
/**
 * The HTTP room routes (#183, #184; #49 is where the rest go): the list, the
 * detail, the surface read and its writes, and the two doors a room's bytes
 * pass through. What the control panel calls, and what any bearer caller may.
```

Keep the rest of the docblock.

- [ ] **Step 2: ARCHITECTURE §4 and §8**

In `docs/ARCHITECTURE.md` §4 "Surfaces and delivery", where the surfaces agents arrive on are listed, add the panel as a surface, one paragraph, after the existing surfaces and before "Two delivery paths":

> **The control panel** (`dash.bellman.sh`, #49) reaches a room over HTTP rather than MCP: `GET /rooms` for the rooms a person created or holds a handle in, `GET /rooms/:id` for a room as their seat sees it, `GET /rooms/:id/surface` for the working surface with the surface cursor as its `ETag`, and `PUT`/`DELETE /rooms/:id/surface/:key` to write or remove an item (#184), beside the blob routes (#183). The routes authenticate through the same composed caller the blob routes use (a bearer, or the panel's cookie behind the CSRF `Origin` check), project through `src/projections.ts` so the panel and the tools shape a room identically, and write through `writeSurface`, the operation `bellman_send type: "surface"` calls. Membership is the tenant boundary: a stranger and an unknown room are one 404. A poll that finds nothing new costs one record read, because the ETag is the record's surface cursor. The `/ws` socket does not admit the panel yet; polling with an ETag came first.

In §8 "Where this is going", find the line about the working surface or the panel and append:

> Piece 3 of the working surface (#129) is split: the room routes are here (#184); the canvas page is in `bellman-sh/dash` (#13), the first screen that renders peer content and the one that brings the panel its content security policy.

Set the frontmatter's `last-verified-against-source` to the short SHA of HEAD before this commit and `last-updated` to today's date.

Check `README.md` for a paragraph about the control panel or `dash`; if one lists what the panel can do, add one sentence naming the room routes. If none exists, change nothing there.

- [ ] **Step 3: The writing sweep**

Over every file this plan touched:

```bash
git diff --name-only "$(git merge-base origin/main HEAD)" HEAD | xargs grep -n -i 'two sessions\|other session\|counterpart\|other side\|load-bearing\|worth saying plainly'; echo "exit=$? (1 means clean)"
```

Expected: no matches.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: exit 0; quote the summary lines (both programs' file and test counts) in the report.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md src/http/rooms.ts README.md
git -c commit.gpgsign=true commit -S -m "Name the control panel as a surface the room routes serve"
```

Do not push and do not open a PR; both are the controller's.
