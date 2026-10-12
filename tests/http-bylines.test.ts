/**
 * Bylines (bylines spec): the handle routes, the room's sign and unsign, and the public reads that
 * show them. A Request in, a Response out, over one MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MAX_HANDLE_BYTES, handleRoutes } from "../src/http/handles.js";
import { publicRoutes } from "../src/http/public.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PUB = "qs_signed";

let store: MemoryStore;
let deps: RoomRouteDeps;

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
  return identity ? { identity, via: "bearer" } : null;
};
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

beforeEach(async () => {
  store = new MemoryStore();
  deps = { store, blobs: new MemoryBlobStore(), caller, panelOrigins: [] };
  await store.createSession(session({
    id: PUB, manifest: roomManifest({ public: true, room: "Open review", purpose: "Read along" }), members: [member(), peer()],
  }));
});

const req = (key: string | null, method: string, path: string, body?: unknown) => new Request(`${ISSUER}${path}`, {
  method,
  headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const handleCall = (key: string | null, method: string, body?: unknown) => handleRoutes(req(key, method, "/account/handle", body), deps);
const roomCall = (key: string | null, method: string, path: string) => roomRoutes(req(key, method, path), deps);
const pub = (path: string) => publicRoutes(req(null, "GET", path), deps);
const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;
/** A PUT whose body is not JSON, with the Content-Length it declares: the bound is read off the header, before the body. */
const putWithLength = (length: string) => handleRoutes(new Request(`${ISSUER}/account/handle`, {
  method: "PUT",
  headers: { authorization: `Bearer ${DEV_KEY.jesse}`, "content-type": "application/json", "content-length": length },
  body: "not json",
}), deps);

describe("the handle routes", () => {
  it("leave any other path to the next module", async () => {
    expect(await handleRoutes(req(DEV_KEY.jesse, "GET", "/account"), deps)).toBeUndefined();
  });

  it("refuse without a credential", async () => {
    expect((await handleCall(null, "GET"))!.status).toBe(401);
  });

  it("answer null before a handle is claimed, then the claimed one, trimmed and lowercased", async () => {
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "GET"))).toEqual({ handle: null });
    const put = (await handleCall(DEV_KEY.jesse, "PUT", { handle: "  Jesse-Dev " }))!;
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ handle: "jesse-dev" });
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "GET"))).toEqual({ handle: "jesse-dev" });
  });

  it("refuse a handle outside the grammar, a reserved one, and one another person holds", async () => {
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "PUT", { handle: "x-" }))).toMatchObject({ error: "handle_invalid" });
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "PUT", { handle: "Admin" }))).toMatchObject({ error: "handle_reserved" });
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "PUT", {}))).toMatchObject({ error: "handle_invalid" });
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "shared" });
    const taken = (await handleCall(DEV_KEY.peer, "PUT", { handle: "shared" }))!;
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "handle_taken" });
  });

  it("free the old handle on a change, and release it on DELETE", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "first" });
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "second" });
    expect((await handleCall(DEV_KEY.peer, "PUT", { handle: "first" }))!.status).toBe(200);
    expect((await handleCall(DEV_KEY.jesse, "DELETE"))!.status).toBe(204);
    expect(await bodyOf(await handleCall(DEV_KEY.jesse, "GET"))).toEqual({ handle: null });
  });

  it("refuse a body just over a handle's bound before reading it, and read one at the bound", async () => {
    const over = (await putWithLength(String(MAX_HANDLE_BYTES + 1)))!;
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({
      error: "too_large",
      error_description: `a handle request is at most ${MAX_HANDLE_BYTES} bytes of JSON`,
    });
    // At the bound the body is read, and is then refused as a handle: that is how this tells the bound from the body.
    const at = (await putWithLength(String(MAX_HANDLE_BYTES)))!;
    expect(at.status).toBe(400);
    expect(await at.json()).toMatchObject({ error: "handle_invalid" });
  });

  it("refuse a Content-Length that is not a number", async () => {
    const res = (await putWithLength("12abc"))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("signing a room", () => {
  const PRIVATE = "qs_private";
  beforeEach(async () => {
    await store.createSession(session({ id: PRIVATE, manifest: roomManifest({ public: false }), members: [member(), peer()] }));
  });

  it("answers 404 to someone with no seat, and 403 to a member who is not the creator", async () => {
    await handleCall(DEV_KEY.peer, "PUT", { handle: "peer-one" });
    expect((await roomCall(DEV_KEY.outsider, "PUT", `/rooms/${PUB}/byline`))!.status).toBe(404);
    const forbidden = (await roomCall(DEV_KEY.peer, "PUT", `/rooms/${PUB}/byline`))!;
    expect(forbidden.status).toBe(403);
    expect(await store.signedRooms("u_peer")).toEqual([]);
  });

  it("refuses the creator with no handle, and a room that is not public", async () => {
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`))).toMatchObject({ error: "no_handle" });
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PRIVATE}/byline`))).toMatchObject({ error: "room_not_public" });
  });

  it("signs and unsigns for the creator, and the room detail says which", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "GET", `/rooms/${PUB}`))).toMatchObject({ signed: false });
    const signed = (await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`))!;
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ handle: "jesse" });
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "GET", `/rooms/${PUB}`))).toMatchObject({ signed: true });
    expect(await bodyOf(await roomCall(DEV_KEY.peer, "GET", `/rooms/${PUB}`))).toMatchObject({ signed: false });
    expect((await roomCall(DEV_KEY.jesse, "DELETE", `/rooms/${PUB}/byline`))!.status).toBe(204);
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "GET", `/rooms/${PUB}`))).toMatchObject({ signed: false });
  });

  it("takes PUT and DELETE alone: a GET answers 405 and signs nothing", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    const res = (await roomCall(DEV_KEY.jesse, "GET", `/rooms/${PUB}/byline`))!;
    expect([res.status, res.headers.get("allow")]).toEqual([405, "PUT, DELETE"]);
    expect(await store.signedRooms("u_jesse")).toEqual([]);
  });

  it("refuses no credential, and a cookie with no panel Origin, and takes the panel's", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    expect((await roomCall(null, "PUT", `/rooms/${PUB}/byline`))!.status).toBe(401);
    const panel = "https://dash.example.test";
    const viaCookie: RoomRouteDeps = {
      ...deps,
      panelOrigins: [panel],
      caller: async (request) => {
        const who = await caller(request);
        return who && { ...who, via: "cookie" };
      },
    };
    const forged = (await roomRoutes(req(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`), viaCookie))!;
    expect(forged.status).toBe(403);
    expect(await store.signedRooms("u_jesse")).toEqual([]);
    const fromPanel = new Request(`${ISSUER}/rooms/${PUB}/byline`, {
      method: "PUT",
      headers: { authorization: `Bearer ${DEV_KEY.jesse}`, origin: panel },
    });
    expect((await roomRoutes(fromPanel, viaCookie))!.status).toBe(200);
  });

  it("carries signed on an org admin's envelope too, false: the admin holds no seat to sign from", async () => {
    await store.createSession(session({ id: "qs_org_closed", createdBy: "u_peer", closed: true, closedAt: 1_700_000_000_000, members: [peer()] }));
    expect(await bodyOf(await roomCall(DEV_KEY.jesse, "GET", "/rooms/qs_org_closed"))).toMatchObject({ viewer: "admin", signed: false });
  });

  it("says signed to the creator alone, whatever signature another person's record holds", async () => {
    await store.claimHandle("u_peer", "peer-one");
    await store.signRoom("u_peer", PUB, 1);
    expect(await bodyOf(await roomCall(DEV_KEY.peer, "GET", `/rooms/${PUB}`))).toMatchObject({ signed: false });
  });
});
