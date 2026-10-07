/**
 * The room blob routes (#183) over MemoryStore and MemoryBlobStore: the upload
 * door and its order of refusals, the put-then-charge, and the download under
 * membership with the headers spec D4 names. Driven directly — a web Request
 * in, a Response out — with no listener, which is why the module is
 * runtime-free. Who is calling is a stub over the dev keys: the seam under
 * test is the route, and the cookie session store has tests/panel-session.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import {
  MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, MemoryBlobStore, blobBytesUsed, blobKey, newBlobId, type BlobPut, type BlobRead,
} from "../src/blobs.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { STALE_AFTER_MS } from "../src/presence.js";
import { MemoryStore, type BlobCharge } from "../src/store.js";
import { PNG, text } from "./helpers/blob-bytes.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_blobs";

/**
 * A blob store that remembers every put, so a test can show nothing was stored or that a refusal
 * cleaned up, and counts every get, so a test can show a download never asked it.
 */
class RecordingBlobStore extends MemoryBlobStore {
  puts: { sessionId: string; id: string }[] = [];
  gets = 0;
  override async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    this.puts.push({ sessionId, id });
    return super.put(sessionId, id, body, meta);
  }
  override async get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead> {
    this.gets++;
    return super.get(sessionId, id, ifNoneMatch);
  }
}

let store: MemoryStore;
let blobs: RecordingBlobStore;
let deps: RoomRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value, read straight off it. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new RecordingBlobStore();
  deps = { store, blobs, caller, panelOrigins: [PANEL] };
  // jesse (peer_a) holds write_surface; peer (peer_b) does not; outsider holds no
  // handle. The ceiling is the room's, stamped on its record (D3): small, so the
  // quota cases need no large bodies.
  await store.createSession(session({
    id: ROOM,
    blobBytesCeiling: 1024,
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
  }));
});

interface UploadOptions {
  member?: string | null;
  name?: string | null;
  type?: string;
  /** null leaves Content-Length off; undefined sets it from the body. */
  length?: string | null;
  headers?: Record<string, string>;
  room?: string;
  cookie?: string;
  /** Replaces the body: a stream the test can watch, or null for no body at all. */
  body?: ReadableStream<Uint8Array> | null;
}

function uploadRequest(key: string | null, body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}): Request {
  const bytes = typeof body === "string" ? text(body) : body;
  const headers: Record<string, string> = { "content-type": over.type ?? "text/plain", ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  if (over.length !== null) headers["content-length"] = over.length ?? String(bytes.byteLength);
  const url = new URL(`${ISSUER}/rooms/${over.room ?? ROOM}/blobs`);
  if (over.member !== null) url.searchParams.set("member_id", over.member ?? "m_creator");
  if (over.name !== null) url.searchParams.set("name", over.name ?? "notes.txt");
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body: over.body === undefined ? bytes : over.body };
  if (over.body instanceof ReadableStream) init.duplex = "half";
  return new Request(url, init);
}

const upload = (key: string | null, body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}) =>
  roomRoutes(uploadRequest(key, body, over), deps);
const download = (key: string | null, id: string, headers: Record<string, string> = {}, room = ROOM) =>
  roomRoutes(
    new Request(`${ISSUER}/rooms/${room}/blobs/${id}`, {
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    }),
    deps,
  );
const used = async () => blobBytesUsed((await store.getSession(ROOM))!);

/** An upload that must land, answering what it stored. */
async function stored(body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}) {
  const res = (await upload(DEV_KEY.jesse, body, over))!;
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { blob_id: string; bytes: number; type: string; name: string };
}

/** A store whose charge always refuses with `reason`, standing in for a room that changed while the bytes were in flight. */
function refusingStore(reason: "frozen" | "closed" | "over_quota" | "not_found"): MemoryStore {
  return new (class extends MemoryStore {
    override async chargeBlobBytes(): Promise<BlobCharge> {
      return { ok: false, reason, used: 0 };
    }
  })();
}

describe("POST /rooms/:id/blobs", () => {
  it("stores the bytes, answers 201 with the id and what it stored, and charges the room", async () => {
    const out = await stored("hello", { name: "hello.txt", type: "text/plain" });
    expect(out).toEqual({ blob_id: expect.stringMatching(/^[a-f0-9]{32}$/), bytes: 5, type: "text/plain", name: "hello.txt" });
    expect(await blobs.head(ROOM, out.blob_id)).toMatchObject({ bytes: 5, type: "text/plain", name: "hello.txt", by: "m_creator" });
    expect(await used()).toBe(5);
  });

  it("accepts an empty file", async () => {
    const out = await stored("", { name: "empty.txt", length: "0", body: null });
    expect(out.bytes).toBe(0);
    expect(await blobs.head(ROOM, out.blob_id)).toMatchObject({ bytes: 0 });
  });

  it("answers 401 with no credential, and stores nothing", async () => {
    expect((await upload(null, "x"))!.status).toBe(401);
    expect(blobs.puts).toEqual([]);
  });

  it("answers 404 to a stranger, to a handle that is not the caller's, and for an unknown room alike", async () => {
    const stranger = (await upload(DEV_KEY.outsider, "x"))!;
    const notTheirs = (await upload(DEV_KEY.peer, "x", { member: "m_creator" }))!;
    const unknown = (await upload(DEV_KEY.jesse, "x", { room: "qs_nowhere" }))!;
    expect([stranger.status, notTheirs.status, unknown.status]).toEqual([404, 404, 404]);
    expect(await stranger.text()).toBe(await unknown.text());
    expect(blobs.puts).toEqual([]);
  });

  it("answers 403 to a seat without write_surface, naming the verb, and to a seat that has left", async () => {
    const verbless = (await upload(DEV_KEY.peer, "x", { member: "m_peer" }))!;
    expect(verbless.status).toBe(403);
    expect(await verbless.text()).toContain("write_surface");
    await store.updateMember(ROOM, "m_creator", { leftAt: Date.now() });
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(403);
    expect(blobs.puts).toEqual([]);
  });

  it("answers 411 without a length and 413 over the cap or the quota, before a byte is read", async () => {
    let reads = 0;
    // highWaterMark 0: at the default of 1 the stream calls `pull` itself when it is built,
    // so `reads` would count the streams, whatever the route does with the body.
    const untouched = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          reads++;
          throw new Error("the body was read");
        },
      }, { highWaterMark: 0 });
    expect((await upload(DEV_KEY.jesse, "x", { length: null, body: untouched() }))!.status).toBe(411);
    expect((await upload(DEV_KEY.jesse, "x", { length: "abc", body: untouched() }))!.status).toBe(411);
    expect((await upload(DEV_KEY.jesse, "x", { length: "-1", body: untouched() }))!.status).toBe(411);
    const overCap = (await upload(DEV_KEY.jesse, "x", { length: String(MAX_BLOB_BYTES + 1), body: untouched() }))!;
    expect(overCap.status).toBe(413);
    expect(await overCap.json()).toMatchObject({ error: "too_large" });
    // The cap itself passes the header check; the quota's courtesy check then
    // refuses it from the record, still without a byte read.
    const atCap = (await upload(DEV_KEY.jesse, "x", { length: String(MAX_BLOB_BYTES), body: untouched() }))!;
    expect(atCap.status).toBe(413);
    expect(await atCap.json()).toMatchObject({ error: "over_quota" });
    expect(reads, "no byte read before any of these").toBe(0);
    expect(blobs.puts).toEqual([]);
  });

  it("refuses a cookie upload without an allowlisted Origin, and accepts one from the panel with CORS", async () => {
    const forged = (await upload(null, "x", { cookie: DEV_KEY.jesse }))!;
    expect(forged.status).toBe(403);
    expect(await forged.text()).toContain("Origin");
    expect((await upload(null, "x", { cookie: DEV_KEY.jesse, headers: { origin: "https://evil.example" } }))!.status).toBe(403);
    expect(blobs.puts).toEqual([]);
    // The control: the same cookie from the panel lands, and a bearer needs no Origin.
    const fromPanel = (await upload(null, "x", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(fromPanel.status).toBe(201);
    expect(fromPanel.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(fromPanel.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(201);
  });

  // The Origin check runs ahead of the seat gate, and the gate touches the caller's lastSeenAt: a
  // forged request writes nothing at all, not even a liveness stamp.
  it("refuses a forged cookie upload before the seat gate, so the member's lastSeenAt is unchanged", async () => {
    // Stale enough that the gate's touch would write: touchMember skips a seat seen within half the window.
    const stale = Date.now() - 2 * STALE_AFTER_MS;
    await store.updateMember(ROOM, "m_creator", { lastSeenAt: stale });
    const lastSeen = async () =>
      (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_creator")!.lastSeenAt;
    const before = await lastSeen();
    expect(before, "the seat starts stale").toBe(stale);
    const noOrigin = (await upload(null, "x", { cookie: DEV_KEY.jesse }))!;
    expect([noOrigin.status, await lastSeen()], "no Origin: refused, and the seat as it was").toEqual([403, before]);
    const offList = (await upload(null, "x", { cookie: DEV_KEY.jesse, headers: { origin: "https://evil.example" } }))!;
    expect([offList.status, await lastSeen()], "an off-list Origin: refused, and the seat as it was").toEqual([403, before]);
    expect(blobs.puts).toEqual([]);
    // The control: the same stale seat through a bearer is touched, so "unchanged" above means something.
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(201);
    expect(await lastSeen()).toBeGreaterThan(stale);
  });

  it("refuses an over-quota upload before the bytes move, against the room's own ceiling", async () => {
    await store.createSession(session({ id: "qs_small", blobBytesCeiling: 10, members: [member()] }));
    const small = { room: "qs_small" };
    const usedSmall = async () => blobBytesUsed((await store.getSession("qs_small"))!);
    const TEN = "0123456789";
    const ELEVEN = "0123456789a";
    const refused = (await upload(DEV_KEY.jesse, ELEVEN, small))!;
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: "over_quota", used: 0, ceiling: 10 });
    expect(blobs.puts).toEqual([]);
    expect(await usedSmall()).toBe(0);
    // The controls: ten bytes fit exactly, the next byte is refused, and the
    // same eleven bytes land in the room whose record says 1024.
    expect((await upload(DEV_KEY.jesse, TEN, small))!.status).toBe(201);
    expect(await usedSmall()).toBe(10);
    expect((await upload(DEV_KEY.jesse, "x", small))!.status).toBe(413);
    expect((await upload(DEV_KEY.jesse, ELEVEN))!.status).toBe(201);
  });

  it("deletes the object when the charge refuses after the put (D3: put, then charge)", async () => {
    for (const [reason, status] of [["frozen", 409], ["closed", 409], ["over_quota", 413], ["not_found", 404]] as const) {
      const refusing = refusingStore(reason);
      await refusing.createSession(session({ id: ROOM, members: [member()] }));
      const before = blobs.puts.length;
      const res = (await roomRoutes(uploadRequest(DEV_KEY.jesse, "bytes in flight"), { ...deps, store: refusing }))!;
      expect(res.status, reason).toBe(status);
      expect(await res.json(), reason).toMatchObject({ error: reason });
      expect(blobs.puts, "the object was put before the charge decided").toHaveLength(before + 1);
      expect(await blobs.head(ROOM, blobs.puts[before].id), "and deleted when the charge refused").toBeNull();
    }
  });

  // A charge that throws is not a refusal. The room object may have committed it before the call failed, so
  // deleting the object could leave a charge nothing can list; it is kept, and the log names its key for the
  // sweep that will find it (D3, #65). The client gets this route's JSON, not a thrown error.
  it("answers a charge that throws with a JSON 500, keeps the object it put, and logs its key", async () => {
    vi.spyOn(store, "chargeBlobBytes").mockRejectedValueOnce(new Error("the room object is unreachable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = (await upload(DEV_KEY.jesse, "bytes in flight"))!;
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({
        error: "internal",
        error_description: "the request failed on the server; nothing was placed",
      });
      expect(blobs.puts).toHaveLength(1);
      const { id } = blobs.puts[0];
      expect(await blobs.head(ROOM, id), "the object is kept: the charge may have landed").not.toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(blobKey(ROOM, id)), expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });

  // Review Focus 1. The route maps one class, and both stores throw it (Tasks 1 and 5), so this
  // answer is the same over R2.
  it("stores and charges nothing for a body that ends short of its Content-Length", async () => {
    const res = (await upload(DEV_KEY.jesse, "short", { length: "10" }))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "body did not match Content-Length: 10 bytes declared, 5 received",
    });
    expect(blobs.puts).toHaveLength(1);
    expect(await blobs.head(ROOM, blobs.puts[0].id)).toBeNull();
    expect(await used()).toBe(0);
  });

  it("stores a claimed PNG that is not one as an octet-stream, and a real one as image/png (D6)", async () => {
    expect((await stored("<html>not a png</html>", { name: "fake.png", type: "image/png" })).type).toBe("application/octet-stream");
    expect((await stored(PNG, { name: "real.png", type: "image/png" })).type).toBe("image/png");
    expect((await stored("<svg xmlns='http://www.w3.org/2000/svg'/>", { name: "v.svg", type: "image/svg+xml" })).type).toBe("application/octet-stream");
    expect((await stored("# notes", { name: "n.md", type: "text/markdown; charset=utf-8" })).type).toBe("text/markdown");
  });

  // Review Focus 4.
  it("treats the name as a label: stripped of paths and control characters, bounded, required", async () => {
    expect((await stored("x", { name: "../../etc/passwd" })).name).toBe("....etcpasswd");
    expect((await stored("x", { name: " résumé (1).pdf " })).name).toBe("résumé (1).pdf");
    expect((await stored("x", { name: "a\u0000b\nc.txt" })).name).toBe("abc.txt");
    for (const name of [null, "", "///", "n".repeat(MAX_BLOB_NAME_CHARS + 1)]) {
      expect((await upload(DEV_KEY.jesse, "x", { name }))!.status, JSON.stringify(name)).toBe(400);
    }
    expect((await upload(DEV_KEY.jesse, "x", { member: null }))!.status).toBe(400);
  });

  it("refuses an upload into a frozen room and a closed one with 409", async () => {
    await store.freezeSession(ROOM, Date.now());
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(409);
    await store.freezeSession(ROOM, null);
    await store.closeSession(ROOM);
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(409);
    expect(blobs.puts).toEqual([]);
  });

  it("answers a preflight for the panel, 405 for the wrong method, and leaves other paths alone", async () => {
    const pre = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs`, { method: "OPTIONS", headers: { origin: PANEL } }), deps))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    const wrong = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } }), deps))!;
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/nothing`), deps))!.status).toBe(404);
    expect(await roomRoutes(new Request(`${ISSUER}/account`), deps)).toBeUndefined();
  });
});

describe("GET /rooms/:id/blobs/:blobId", () => {
  it("serves an image inline as stored, with nosniff, sandbox, a private cache, an ETag, its length and CORS", async () => {
    const { blob_id } = await stored(PNG, { name: "real.png", type: "image/png" });
    const res = (await download(DEV_KEY.jesse, blob_id, { origin: PANEL }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves everything else as an octet-stream download — the SVG, the false PNG and the HTML included — never as HTML", async () => {
    const cases = [
      await stored("<!doctype html><script>alert(1)</script>", { name: "page.html", type: "text/html" }),
      await stored("<svg xmlns='http://www.w3.org/2000/svg'/>", { name: "v.svg", type: "image/svg+xml" }),
      await stored("<html>not a png</html>", { name: "fake.png", type: "image/png" }),
      await stored("# notes", { name: "résumé (1).md", type: "text/markdown" }),
    ];
    for (const { blob_id, name } of cases) {
      const res = (await download(DEV_KEY.jesse, blob_id))!;
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), name).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), name).toBe("sandbox");
    }
    const md = cases[3];
    expect((await download(DEV_KEY.jesse, md.blob_id))!.headers.get("content-disposition"))
      .toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.md");
  });

  it("answers 304 to a matching If-None-Match, with the ETag, the download headers, CORS and no body", async () => {
    const { blob_id } = await stored("cached", { name: "c.txt" });
    const etag = (await download(DEV_KEY.jesse, blob_id))!.headers.get("etag")!;
    const again = (await download(DEV_KEY.jesse, blob_id, { "if-none-match": etag, origin: PANEL }))!;
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("private, max-age=300");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("content-security-policy")).toBe("sandbox");
    expect(again.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await again.text()).toBe("");
    expect((await download(DEV_KEY.jesse, blob_id, { "if-none-match": '"something-else"' }))!.status).toBe(200);
  });

  it("answers 401 with no credential, and 404 to a stranger, for an unknown room, an unknown id and a malformed one alike", async () => {
    const { blob_id } = await stored("x");
    expect((await download(null, blob_id))!.status).toBe(401);
    const stranger = (await download(DEV_KEY.outsider, blob_id))!;
    const unknownRoom = (await download(DEV_KEY.jesse, blob_id, {}, "qs_nowhere"))!;
    const unknownId = (await download(DEV_KEY.jesse, newBlobId()))!;
    const malformed = (await download(DEV_KEY.jesse, "zz".repeat(16)))!;
    for (const res of [stranger, unknownRoom, unknownId, malformed]) expect(res.status).toBe(404);
    expect(await stranger.text()).toBe(await unknownRoom.text());
    const posted = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs/${blob_id}`, { method: "POST", headers: { authorization: `Bearer ${DEV_KEY.jesse}` } }), deps))!;
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });

  // The id check is the route's own rule. Over MemoryBlobStore an unknown id answers null, so a
  // status alone cannot tell the guard from the store: count the questions the store was asked.
  it("answers 404 to a malformed id without asking the blob store", async () => {
    await stored("x");
    const malformed = [
      // `../x` as a client has to send it: a literal `../x` is resolved away by the URL parser and
      // never reaches a route.
      "..%2Fx",
      "ABCDEF01".repeat(4), // 32 characters, but uppercase hex
      "a".repeat(31), // one character short
    ];
    const statuses: number[] = [];
    const asked: number[] = [];
    for (const id of malformed) {
      statuses.push((await download(DEV_KEY.jesse, id))!.status);
      asked.push(blobs.gets);
    }
    expect([statuses, asked]).toEqual([[404, 404, 404], [0, 0, 0]]);
    // The control: a well-formed id nobody stored is asked of the store, and is a 404 too.
    expect([(await download(DEV_KEY.jesse, newBlobId()))!.status, blobs.gets]).toEqual([404, 1]);
  });

  it("serves a member whatever its verbs, one who left or timed out, a closed room and a frozen one", async () => {
    const { blob_id } = await stored("x");
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    // A departure and a timed-out seat are one record: leftAt set, no cut.
    await store.updateMember(ROOM, "m_peer", { leftAt: Date.now() });
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    await store.freezeSession(ROOM, Date.now());
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    await store.freezeSession(ROOM, null);
    await store.closeSession(ROOM);
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    expect((await download(DEV_KEY.jesse, blob_id))!.status).toBe(200);
  });

  // The same outer catch, from the read side: a store that rejects answers JSON, and what it threw stays in the log.
  it("answers a download whose store throws with a JSON 500 that does not repeat what was thrown", async () => {
    const { blob_id } = await stored("x");
    vi.spyOn(store, "getSession").mockRejectedValueOnce(new Error("the room object is unreachable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = (await download(DEV_KEY.jesse, blob_id))!;
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json");
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ error: "internal" });
      expect(body).not.toContain("unreachable");
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`GET /rooms/${ROOM}/blobs/${blob_id}`), expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a member a creator removed, as /ws does", async () => {
    const { blob_id } = await stored("x");
    const evicted = await store.appendEvent(ROOM, {
      type: "member_evicted", fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
      payload: { member_id: "m_peer" }, refId: null,
    }, { markRemoved: "m_peer" });
    expect(evicted).not.toBeNull();
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(403);
    // The control: the creator still reads it.
    expect((await download(DEV_KEY.jesse, blob_id))!.status).toBe(200);
  });
});
