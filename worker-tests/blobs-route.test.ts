/**
 * The Worker actually serves the room routes (#183, Review Focus 2).
 *
 * tests/http-blobs.test.ts proves the module over the memory stores. This
 * proves what only a request through the real `fetch` handler can: that the
 * `BLOBS` binding reaches `R2BlobStore`, that the charge lands in the real
 * SessionDO, that a key-map bearer resolves through `roomCaller`, and that a
 * body of the wrong length is a 400 over the real bucket. panel-wiring.test.ts
 * exists because a line exactly like these was once absent with every test
 * green. What no request here can see is the order of dispatch, `/rooms/` ahead
 * of the OAuth routes: `handleOAuth` answers `undefined` for it either way.
 * Task 7 Step 6 and Task 10 Step 2 check that order by line number instead.
 *
 * The key is the one vitest.config.ts binds (`qk_ws_test`, u_jesse), and the
 * room is created through the real DurableObjectStore with that identity in
 * the creator's seat, which holds write_surface. The bodies are streams, so the
 * explicit Content-Length is the only length a request has, as it is behind the
 * edge, which sets the header from the real body.
 *
 * The second and third describes are the same kind of line, reached the same
 * way: the cookie half of `roomCaller` and the panel's origins handed to the
 * route (every case above carries a key-map bearer, so a Worker that dropped
 * either would pass them), and the fail-closed guard `/rooms/` shares with `/ws`.
 * The cookie is a real session in the real AuthDO, so the Worker reads it the
 * way a browser's would be read.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { AuthStore } from "../src/oauth/store.js";
import { sessionCookieName } from "../src/oauth/cookies.js";
import { SESSION_TTL_MS } from "../src/oauth/storage.js";
import { blobBytesUsed } from "../src/blobs.js";
import { member, session } from "../tests/helpers/fixtures.js";
import { stream, text } from "../tests/helpers/blob-bytes.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ROOM = "qs_blobs_route";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

describe("the Worker serves /rooms/:id/blobs", () => {
  it("uploads through the real binding, charges the real room object, and serves the bytes back", async () => {
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: ROOM, members: [member()] }));

    const body = text("# notes\n");
    const uploaded = await call(`/rooms/${ROOM}/blobs?member_id=m_creator&name=notes.md`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/markdown", "content-length": String(body.byteLength) },
      body: stream(body),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, bytes, type } = (await uploaded.json()) as { blob_id: string; bytes: number; type: string };
    expect(bytes).toBe(body.byteLength);
    expect(type).toBe("text/markdown");

    // The binding, not a memory store: the object is in the bucket under the room's prefix.
    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    const object = await bucket.head(`rooms/${ROOM}/${blob_id}`);
    expect(object?.size).toBe(body.byteLength);
    expect(object?.customMetadata?.name).toBe("notes.md");

    // The charge landed in SessionDO, through the facade's chargeBlobBytes.
    expect(blobBytesUsed((await store.getSession(ROOM))!)).toBe(body.byteLength);

    const served = await call(`/rooms/${ROOM}/blobs/${blob_id}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);
  });

  // From the room routes, not from the Worker's plain-text "Not found" fall-through: the body is
  // the module's own JSON, exactly.
  it("answers no credential 401 and a stranger 404 as the room routes' own JSON", async () => {
    const anonymous = await call(`/rooms/${ROOM}/blobs/0123456789abcdef0123456789abcdef`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized", error_description: "sign in, or send a bearer token" });
    const stranger = await call(`/rooms/qs_nowhere/blobs/0123456789abcdef0123456789abcdef`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(stranger.status).toBe(404);
    expect(stranger.headers.get("content-type")).toBe("application/json");
    expect(await stranger.json()).toEqual({ error: "not_found", error_description: "no such blob" });
  });

  // Review Focus 1, end to end: the route maps `BlobLengthError` to 400, and over the real bucket
  // that class comes from `R2BlobStore` (Task 5), not from the memory store the route tests use.
  it("answers a body shorter than its Content-Length 400 over the real bucket, and charges and stores nothing", async () => {
    const room = "qs_blobs_short";
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: room, members: [member()] }));

    const short = await call(`/rooms/${room}/blobs?member_id=m_creator&name=short.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/plain", "content-length": "10" },
      body: stream(text("short")),
    });
    expect(short.status, await short.clone().text()).toBe(400);
    expect(await short.json()).toEqual({
      error: "invalid_request",
      error_description: "body did not match Content-Length: 10 bytes declared, 5 received",
    });

    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    expect((await bucket.list({ prefix: `rooms/${room}/` })).objects).toEqual([]);
    expect(blobBytesUsed((await store.getSession(room))!)).toBe(0);
  });

  // The whole-branch review's third finding: a non-ASCII name had only ever been sent through MemoryBlobStore.
  // R2 keeps a name in customMetadata, which travels as an HTTP header value, so the store encodes it and the
  // bucket holds ASCII. The raw read below is the check that can go red: with the encoding dropped the metadata
  // is the name itself, and the simulator would happily hand that back, so only this line sees the difference.
  it("keeps a non-ASCII name percent-encoded in the bucket, and serves it back under the same name", async () => {
    const room = "qs_blobs_unicode";
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: room, members: [member()] }));

    const body = text("# notes\n");
    const name = "résumé (1).md";
    const uploaded = await call(`/rooms/${room}/blobs?member_id=m_creator&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/markdown", "content-length": String(body.byteLength) },
      body: stream(body),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, name: answered } = (await uploaded.json()) as { blob_id: string; name: string };
    expect(answered).toBe(name);

    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    const object = await bucket.head(`rooms/${room}/${blob_id}`);
    expect(object?.customMetadata?.name).toBe("r%C3%A9sum%C3%A9%20(1).md");

    const served = await call(`/rooms/${room}/blobs/${blob_id}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.md");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);
  });

  // The route's own comment says a zero-byte file is a file. Over memory it always was; over R2 the body goes
  // through a FixedLengthStream(0), which this is the first request to build.
  it("takes a zero-byte upload over the real bucket: 201, nothing charged, and an empty download", async () => {
    const room = "qs_blobs_empty";
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: room, members: [member()] }));

    const uploaded = await call(`/rooms/${room}/blobs?member_id=m_creator&name=empty.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/plain", "content-length": "0" },
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, bytes } = (await uploaded.json()) as { blob_id: string; bytes: number };
    expect(bytes).toBe(0);
    expect(blobBytesUsed((await store.getSession(room))!)).toBe(0);

    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    expect((await bucket.head(`rooms/${room}/${blob_id}`))?.size).toBe(0);

    const served = await call(`/rooms/${room}/blobs/${blob_id}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-length")).toBe("0");
    expect((await served.arrayBuffer()).byteLength).toBe(0);
  });
});

const PANEL = "https://dash.example.test";
const JESSE = { userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd" };

/**
 * What OAuth, and so the panel's cookie, needs to be configured at all: what panel-wiring.test.ts builds, on top
 * of the key map the test env already binds, so the cookie and the bearer are both live as they are in production.
 */
const panelEnv = () =>
  ({
    ...env,
    BELLMAN_TOKEN_SECRET: "test-signing-secret",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BELLMAN_PANEL_ORIGINS: PANEL,
  }) as unknown as Parameters<typeof worker.fetch>[1];
const panelCall = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), panelEnv(), ctx);

describe("the Worker serves /rooms/:id/blobs to the control panel's cookie", () => {
  // A cookie caller is the one CSRF exists for: a bearer is exempt from it, so a cookie that came out of
  // `roomCaller` marked as one would let any page upload as the signed-in person. The forged and the absent
  // Origin are refused 403 before the body is read, so nothing is stored or charged for them; the allowed
  // origin's upload is the control that shows the 403 is the Origin's and not the cookie's.
  it("reads a blob for a signed-in panel, takes an upload from its origin only, and stores nothing for a forged one", async () => {
    const room = "qs_blobs_cookie";
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: room, members: [member()] }));

    // A blob, put there by the key-map bearer: the other half of the caller.
    const body = text("# notes\n");
    const seeded = await call(`/rooms/${room}/blobs?member_id=m_creator&name=notes.md`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/markdown", "content-length": String(body.byteLength) },
      body: stream(body),
    });
    expect(seeded.status, await seeded.clone().text()).toBe(201);
    const { blob_id } = (await seeded.json()) as { blob_id: string };

    // A panel session in the real AuthDO, as the sign-in would have written it, for the person the key map names.
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    await new AuthStore(env.AUTH as never).putSession(sessionId, {
      identity: JESSE, plan_source: "default", identity_keys: [],
      created_at: now, last_used_at: now, replanned_at: now, expires_at: now + SESSION_TTL_MS,
    });
    const cookie = `${sessionCookieName(true)}=${sessionId}`;

    // The cookie alone reads the blob, with the download's headers, and the panel's origin is granted CORS on it.
    const served = await panelCall(`/rooms/${room}/blobs/${blob_id}`, { headers: { cookie, origin: PANEL } });
    expect(served.status, await served.clone().text()).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("private, max-age=300");
    expect(served.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(served.headers.get("access-control-allow-credentials")).toBe("true");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);

    // A cookie that names no session, and no cookie at all, are no caller.
    const unknown = await panelCall(`/rooms/${room}/blobs/${blob_id}`, {
      headers: { cookie: `${sessionCookieName(true)}=no-such-session`, origin: PANEL },
    });
    expect(unknown.status).toBe(401);
    expect((await panelCall(`/rooms/${room}/blobs/${blob_id}`, { headers: { origin: PANEL } })).status).toBe(401);

    const upload = (headers: Record<string, string>) =>
      panelCall(`/rooms/${room}/blobs?member_id=m_creator&name=panel.txt`, {
        method: "POST",
        headers: { cookie, "content-type": "text/plain", "content-length": "5", ...headers },
        body: stream(text("panel")),
      });
    const allowed = await upload({ origin: PANEL });
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(PANEL);

    for (const headers of [{ origin: "https://evil.example" }, {}]) {
      const forged = await upload(headers);
      expect(forged.status, JSON.stringify(headers)).toBe(403);
      expect(await forged.json()).toEqual({
        error: "invalid_request",
        error_description: "a cookie-authenticated write must carry an Origin header from the control panel",
      });
    }

    // Two objects and 13 bytes: the key-map upload and the panel's own. The refused two left nothing behind.
    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    expect((await bucket.list({ prefix: `rooms/${room}/` })).objects).toHaveLength(2);
    expect(blobBytesUsed((await store.getSession(room))!)).toBe(body.byteLength + 5);
  });
});

describe("the Worker's fail-closed guard covers the room routes", () => {
  // `/ws` and `/mcp` refuse a deploy with neither a key map nor OAuth with a 503 and a log line, rather than 401
  // every caller as though their credentials were wrong. `/rooms/` is dispatched ahead of both, so it has its own
  // copy of that call. Without it the answer is the route's 401, which reads as a bad key on a deploy that has none.
  it("answers 503 with neither a key map nor OAuth, and the route's own answer once a key map is bound", async () => {
    const path = "/rooms/qs_nowhere/blobs/0123456789abcdef0123456789abcdef";
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bare = { ...env, BELLMAN_KEYS: undefined } as unknown as Parameters<typeof worker.fetch>[1];
      const refused = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${KEY}` } }), bare, ctx);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Server is not configured with an identity key map" },
        id: null,
      });
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining("BELLMAN_KEYS is unset"));

      // The control: the same request with the key map bound reaches the route, which answers its own 404.
      const served = await call(path, { headers: { authorization: `Bearer ${KEY}` } });
      expect(served.status).toBe(404);
      expect(await served.json()).toEqual({ error: "not_found", error_description: "no such blob" });
    } finally {
      quiet.mockRestore();
    }
  });
});
