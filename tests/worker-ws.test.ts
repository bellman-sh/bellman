/**
 * The /ws route. Not the socket itself — SessionDO.fetch is tested in
 * tests/store-do-wiring.test.ts. What this pins is the route's contract:
 * who is refused, with what status, and what reaches the object.
 *
 * What reaches the object is recorded, not inferred: every case asserts the
 * exact calls the fake namespace saw. That is what stops a case passing against
 * a route that never ran. Before /ws existed, "answers 404 for an unknown room"
 * was green on the fall-through's own 404.
 *
 * EXCLUDED FROM `npm run typecheck`; see the comment beside the entry in
 * tsconfig.test.json. Vitest is unaffected: it does not typecheck, and the
 * vi.mock below lets it load a module that imports `cloudflare:workers`.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { signJwt } from "../src/oauth/tokens.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
}));

afterEach(() => vi.restoreAllMocks());

const KEYS = JSON.stringify({
  qk_test_jesse: { userId: "u1", orgId: null, plan: "team", role: "admin", label: "jesse" },
  qk_test_peer: { userId: "u2", orgId: null, plan: "free", role: "member", label: "peer" },
});

type Answer = { memberIds: string[]; closed: boolean };

// workerd answers an upgrade with a 101 that carries a `webSocket`. Node's
// Response throws a RangeError for any status outside 200-599, so this builds a
// 200 and makes `status` read 101. That is all it models: the route returns
// whatever the object returns, and what the object returns is pinned in
// tests/store-do-wiring.test.ts.
const upgraded = () => Object.defineProperty(new Response(null), "status", { value: 101 });

/**
 * A Worker over a fake SESSION namespace. `reached` is every call the object
 * saw, in order, as "<method> <room> [<user>]"; `asked` is the requests its
 * fetch was handed. `answer` is what membersOf says, for every caller or per
 * user. `env` overrides what the Worker is configured with.
 */
async function world(answer: Answer | ((userId: string) => Answer), env: Record<string, unknown> = {}) {
  const asked: Request[] = [];
  const reached: string[] = [];
  const worker = (await import("../src/worker.js")).default;
  const bound = {
    BELLMAN_KEYS: KEYS,
    SESSION: {
      idFromName: (n: string) => n,
      get: (room: string) => ({
        membersOf: async (userId: string) => {
          reached.push(`membersOf ${room} ${userId}`);
          return typeof answer === "function" ? answer(userId) : answer;
        },
        fetch: async (r: Request) => {
          reached.push(`fetch ${room}`);
          asked.push(r);
          return upgraded();
        },
      }),
    },
    REGISTRY: { idFromName: (n: string) => n, get: () => ({}) },
    ...env,
  } as never;
  const call = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    worker.fetch(new Request(url, { method, headers: { upgrade: "websocket", ...headers } }), bound);
  const mcp = (headers: Record<string, string> = {}) =>
    worker.fetch(new Request("https://b/mcp", { method: "POST", headers }), bound);
  return { call, mcp, asked, reached };
}

const AUTH = { authorization: "Bearer qk_test_jesse" };
const OK: Answer = { memberIds: ["m1"], closed: false };
const ROOM = "https://b/ws?session=qs_1&cursor=0";

const SECRET = "oauth-secret-oauth-secret-oauth-secret";
const oauth = { BELLMAN_TOKEN_SECRET: SECRET, AUTH: {} };
// Minted the way the token endpoint does, for the origin the request arrives
// on. /ws accepts what /mcp accepts, so the audience is /mcp's.
const accessToken = (userId: string, aud = "https://b/mcp") =>
  signJwt(
    {
      iss: "https://b",
      sub: userId,
      aud,
      bellman: { userId, orgId: null, plan: "free", role: "member", label: userId },
    },
    SECRET,
    600
  );

describe("GET /ws", () => {
  it("upgrades a member of the room", async () => {
    const { call, reached } = await world(OK);
    expect((await call(ROOM, AUTH)).status).toBe(101);
    // Asked about the identity the key resolves to, in the room named in the
    // query, and handed the socket for that same room.
    expect(reached).toEqual(["membersOf qs_1 u1", "fetch qs_1"]);
  });

  it("refuses a caller with no credentials", async () => {
    const { call, reached } = await world(OK);
    expect((await call(ROOM)).status).toBe(401);
    expect((await call(ROOM, { authorization: "Bearer qk_test_nobody" })).status).toBe(401);
    expect(reached, "a caller who is not authenticated must not reach the object").toEqual([]);
  });

  it("refuses a caller who owns no member here", async () => {
    const { call, reached } = await world({ memberIds: [], closed: false });
    expect((await call(ROOM, AUTH)).status).toBe(403);
    expect(reached, "asked who the caller is, never handed a socket").toEqual(["membersOf qs_1 u1"]);
  });

  it("answers 404 for an unknown room", async () => {
    const { call, reached } = await world({ memberIds: [], closed: true });
    expect((await call("https://b/ws?session=qs_nope&cursor=0", AUTH)).status).toBe(404);
    // Without this the case is satisfied by a route that does not exist, which
    // also answers 404.
    expect(reached).toEqual(["membersOf qs_nope u1"]);
  });

  it("answers 409 for a closed room", async () => {
    // Review Focus #2: a poll onto a closed room lasts 25s, a socket forever.
    const { call, reached } = await world({ memberIds: ["m1"], closed: true });
    expect((await call(ROOM, AUTH)).status).toBe(409);
    expect(reached, "a closed room is refused before the socket is handed over").toEqual(["membersOf qs_1 u1"]);
  });

  it("rejects a cursor that is not a non-negative integer", async () => {
    // Review Focus #1. Number() alone takes "", " 1", "+1", "0x10" and "1\n" as
    // numbers; "9007199254740993" is a digit string that rounds to 2^53 on the
    // way in, and "1e99" and "1.5" are numbers that are not cursors.
    const { call, reached } = await world(OK);
    const cursors = ["-1", "abc", "1.5", "1e99", "", "9007199254740993", " 1", "+1", "0x10", "1\n"];
    for (const c of cursors) {
      const res = await call(`https://b/ws?session=qs_1&cursor=${encodeURIComponent(c)}`, AUTH);
      expect(res.status, `cursor ${JSON.stringify(c)} should be refused`).toBe(400);
    }
    // No cursor at all is not a cursor either.
    expect((await call("https://b/ws?session=qs_1", AUTH)).status, "a missing cursor should be refused").toBe(400);
    expect(reached, "no bad cursor should have reached the object").toEqual([]);
  });

  it("rejects a missing session", async () => {
    const { call, reached } = await world(OK);
    expect((await call("https://b/ws?cursor=0", AUTH)).status).toBe(400);
    expect((await call("https://b/ws?session=&cursor=0", AUTH)).status, "an empty session is missing too").toBe(400);
    expect(reached).toEqual([]);
  });

  it("refuses a request that is not an upgrade", async () => {
    const { call, reached } = await world(OK);
    const res = await call(ROOM, { ...AUTH, upgrade: "" });
    expect(res.status).toBe(426);
    expect(reached).toEqual([]);
  });

  it("refuses a method other than GET before the object is reached", async () => {
    // A handshake is a GET. Without this, a POST carrying `Upgrade: websocket`
    // cleared authentication and reached the object, which accepted a socket
    // before workerd answered the client with a 500.
    const { call, reached } = await world(OK);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await call(ROOM, AUTH, method);
      expect(reached, `${method}: the object must not be reached`).toEqual([]);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET");
    }
  });

  it("answers 405 ahead of every other check", async () => {
    // Not an upgrade and not authenticated: 426 and 401 both apply, and neither
    // gets to answer for a method that was never going to be served.
    const { call, reached } = await world(OK);
    const res = await call(ROOM, { upgrade: "" }, "POST");
    expect(res.status).toBe(405);
    expect(reached).toEqual([]);
  });

  // This guards a path that is live. Presence reads the member list on a socket
  // (SocketAttachment.memberIds in store-do.ts), and a list naming a member keeps
  // that member's whole identity out of every seat reclaim for as long as the
  // socket stays open. A forwarded x-bellman-members would be a protection a
  // caller claims for itself, so the Worker must never forward a caller's
  // request. If the field stops being read, this can go with it.
  it("hands the object a request built here, carrying no client header", async () => {
    const { call, asked } = await world({ memberIds: ["m1", "m3"], closed: false });
    await call("https://b/ws?session=qs_1&cursor=7&members=m_someone_else", {
      ...AUTH,
      // A caller trying to claim a membership it was not granted.
      "x-bellman-members": "m_someone_else",
      cookie: "session=secret",
      origin: "https://evil.example",
    });
    expect(asked).toHaveLength(1);
    const sent = asked[0];
    expect(sent.headers.get("x-bellman-members")).toBe("m1,m3");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("cookie")).toBeNull();
    expect(sent.headers.get("upgrade")).toBe("websocket");
    expect(new URL(sent.url).search, "the validated cursor is the only thing in the query").toBe("?cursor=7");
    // The two named above are the ones this case thought of. This is the rest:
    // whatever else the caller sent, the object sees what the Worker decided.
    expect([...sent.headers.keys()].sort()).toEqual(["upgrade", "x-bellman-members"]);
  });

  it("asks about the identity it authenticated, and refuses another on the same room", async () => {
    const { call, reached } = await world((userId) =>
      userId === "u1" ? OK : { memberIds: [], closed: false });
    expect((await call(ROOM, AUTH)).status).toBe(101);
    expect((await call(ROOM, { authorization: "Bearer qk_test_peer" })).status).toBe(403);
    expect(reached).toEqual(["membersOf qs_1 u1", "fetch qs_1", "membersOf qs_1 u2"]);
  });

  it("refuses to serve with neither a key map nor OAuth", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call, reached } = await world(OK, { BELLMAN_KEYS: undefined });
    expect((await call(ROOM, AUTH)).status).toBe(503);
    expect(reached).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("BELLMAN_KEYS is unset"));
  });

  it("refuses /mcp the same way, so the guard is shared and not copied", async () => {
    // Nothing else imports src/worker.ts, so without this the guard could be
    // dropped from /mcp and every other test would stay green.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mcp, reached } = await world(OK, { BELLMAN_KEYS: undefined });
    expect((await mcp(AUTH)).status).toBe(503);
    expect(reached).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("BELLMAN_KEYS is unset"));
  });
});

describe("GET /ws with OAuth on", () => {
  it("admits an access token with no key map configured", async () => {
    const { call, reached } = await world(OK, { ...oauth, BELLMAN_KEYS: undefined });
    const res = await call(ROOM, { authorization: `Bearer ${await accessToken("u9")}` });
    expect(res.status).toBe(101);
    expect(reached).toEqual(["membersOf qs_1 u9", "fetch qs_1"]);
  });

  it("still admits a static key", async () => {
    const { call, reached } = await world(OK, oauth);
    expect((await call(ROOM, AUTH)).status).toBe(101);
    expect(reached).toEqual(["membersOf qs_1 u1", "fetch qs_1"]);
  });

  it("does not fall back to the dev keys when there is no key map", async () => {
    // The fail-closed guard passes here, because OAuth is configured. What is
    // left between qk_dev_jesse (team plan, admin role) and this URL is that
    // resolveCaller never calls resolveIdentity without a map, which is what
    // makes it fall back to the dev table.
    const { call, mcp, reached } = await world(OK, { ...oauth, BELLMAN_KEYS: undefined });
    const dev = { authorization: "Bearer qk_dev_jesse" };
    expect((await call(ROOM, dev)).status, "/ws").toBe(401);
    expect((await mcp(dev)).status, "/mcp").toBe(401);
    expect(reached).toEqual([]);
  });

  it("answers a 401 with the discovery pointer a client starts from", async () => {
    const { call, reached } = await world(OK, oauth);
    const res = await call(ROOM);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://b/.well-known/oauth-protected-resource"'
    );
    expect(reached).toEqual([]);
  });
});

describe("/ws and /mcp resolve the caller the same way", () => {
  // One truth table, asked of both routes. /ws admits a caller when it upgrades.
  // /mcp admits one when it gets past authentication, which for a POST with no
  // body means any status but 401. A copy of the resolution that is weaker, or
  // stricter, on one route than the other fails here whichever route it is on.
  it("admits the same callers on both, in every deployment", async () => {
    const callers: Record<string, Record<string, string>> = {
      "no credentials": {},
      "an unknown key": { authorization: "Bearer qk_test_nobody" },
      "a static key": AUTH,
      "an access token": { authorization: `Bearer ${await accessToken("u9")}` },
      "a token minted for another audience": {
        authorization: `Bearer ${await accessToken("u9", "https://elsewhere.example/mcp")}`,
      },
      "a dev key": { authorization: "Bearer qk_dev_jesse" },
    };
    const deployments = [
      { name: "key map only", env: {}, admitted: ["a static key"] },
      { name: "key map and OAuth", env: oauth, admitted: ["a static key", "an access token"] },
      { name: "OAuth only", env: { ...oauth, BELLMAN_KEYS: undefined }, admitted: ["an access token"] },
    ];
    for (const d of deployments) {
      const { call, mcp } = await world(OK, d.env);
      for (const [who, headers] of Object.entries(callers)) {
        const expected = d.admitted.includes(who);
        expect((await call(ROOM, headers)).status === 101, `${d.name}: /ws, ${who}`).toBe(expected);
        expect((await mcp(headers)).status !== 401, `${d.name}: /mcp, ${who}`).toBe(expected);
      }
    }
  });
});
