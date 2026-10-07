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
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
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
});
