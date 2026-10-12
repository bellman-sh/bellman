/**
 * Bylines (bylines spec): the handle routes, the room's sign and unsign, and the public reads that
 * show them. A Request in, a Response out, over one MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MAX_HANDLE_BYTES, handleRoutes } from "../src/http/handles.js";
import { publicRoutes } from "../src/http/public.js";
import { MAX_ROOMS_LISTED, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { HOST_USER_ID, MemoryStore } from "../src/store.js";
import { member, roomManifest, session, type SessionSeed } from "./helpers/fixtures.js";
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

describe("the byline on the public reads", () => {
  const sign = async (handle: string) => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
  };

  it("is null until the creator signs, then names the handle and the creator's public number", async () => {
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: null });
    await sign("jesse");
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: { handle: "jesse", as: "member 1" } });
  });

  it("names the creator in the log by the same number the byline gives", async () => {
    await sign("jesse");
    const creator = member();
    await store.appendEvent(PUB, { type: "message", fromMemberId: creator.memberId, fromUserId: creator.userId, fromLabel: creator.label, payload: { text: "hi" }, refId: null });
    const { by } = (await bodyOf(await pub(`/public/rooms/${PUB}`))) as { by: { as: string } };
    const { events } = (await bodyOf(await pub(`/public/rooms/${PUB}/events`))) as { events: { origin: { label: string } }[] };
    expect(events.at(-1)!.origin.label).toBe(by.as);
  });

  it("follows a changed handle, and goes when the handle is released", async () => {
    await sign("jesse");
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse-two" });
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: { handle: "jesse-two" } });
    await handleCall(DEV_KEY.jesse, "DELETE");
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: null });
  });

  it("carries the handle and the number and nothing more", async () => {
    await sign("jesse");
    expect((await bodyOf(await pub(`/public/rooms/${PUB}`))).by).toEqual({ handle: "jesse", as: "member 1" });
  });

  it("reads the creator's signature alone: another member's, written straight to the registry, shows no byline", async () => {
    await store.claimHandle("u_peer", "peer-one");
    await store.signRoom("u_peer", PUB, 1);
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: null });
    await sign("jesse");
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({ by: { handle: "jesse" } });
  });

  it("is null when the creator's seat has no public number for the page to swap, signed or not", async () => {
    // publicNames never numbers the hosted seat, so a room whose first seat is the host has no `as` to give.
    await store.createSession(session({
      id: "qs_host_first",
      manifest: roomManifest({ public: true }),
      members: [member({ memberId: "m_host", userId: HOST_USER_ID, label: "host" }), peer()],
    }));
    await store.claimHandle("u_jesse", "jesse");
    await store.signRoom("u_jesse", "qs_host_first", 1);
    expect(await bodyOf(await pub("/public/rooms/qs_host_first"))).toMatchObject({ by: null });
  });

  // The creator's seat stays on the room's record when it leaves (ADR 0019), so the byline names it by the number it
  // was given at seating, and not whichever member now sits first.
  it("names the creator's seat after the creator has left the room", async () => {
    await sign("jesse");
    await store.updateMember(PUB, "m_creator", { leftAt: Date.now() });
    expect(await bodyOf(await pub(`/public/rooms/${PUB}`))).toMatchObject({
      text: { origin: { memberId: "m_creator", label: "member 1" } },
      by: { handle: "jesse", as: "member 1" },
    });
  });

  // A public room is read by its name as by its id (public names spec, D6). The byline is looked up for the room the
  // name resolves to, never for the name itself.
  it("names the creator on a read by the room's public name, as on a read by its id", async () => {
    await sign("jesse");
    await store.claimPublicName("open-review", { id: PUB, at: Date.now() }, null);
    await store.setPublicName(PUB, "open-review");
    const byName = await bodyOf(await pub("/public/rooms/open-review"));
    expect(byName).toMatchObject({ id: PUB, by: { handle: "jesse", as: "member 1" } });
    expect(byName).toEqual(await bodyOf(await pub(`/public/rooms/${PUB}`)));
  });
});

describe("GET /public/handles/:handle", () => {
  it("lists the handle's signed public rooms, wrapped as the creator's words, in any case of the handle", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
    const res = (await pub("/public/handles/JESSE"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { handle: string; rooms: Record<string, unknown>[] };
    expect(body.handle).toBe("jesse");
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject({
      id: PUB,
      public_url: `https://dash.bellman.sh/r/${PUB}`,
      text: { trust: "untrusted", origin: { label: "@jesse" }, data: { room: "Open review", purpose: "Read along" } },
    });
    expect(typeof body.rooms[0].signed_at).toBe("string");
    expect(JSON.stringify(body)).not.toContain("jesse@codenerd");
  });

  it("is 404 for a handle nobody holds", async () => {
    expect((await pub("/public/handles/nobody"))!.status).toBe(404);
  });

  it("lists none of an old owner's rooms under a freed handle someone else claimed", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse-two" });
    await handleCall(DEV_KEY.peer, "PUT", { handle: "jesse" });
    expect(await bodyOf(await pub("/public/handles/jesse"))).toEqual({ handle: "jesse", rooms: [] });
  });

  it("drops a room once it is unpublished", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
    await store.unpublishSession(PUB, Date.now());
    expect(await bodyOf(await pub("/public/handles/jesse"))).toEqual({ handle: "jesse", rooms: [] });
  });

  // As the byline does: the creator's seat, which stays on the record when it leaves (ADR 0019), and not whichever
  // member now sits first.
  it("lists a signed room under its creator's seat after the creator has left it", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
    await store.updateMember(PUB, "m_creator", { leftAt: Date.now() });
    const { rooms } = (await bodyOf(await pub("/public/handles/jesse"))) as { rooms: { id: string; text: { origin: { memberId: string } } }[] };
    expect(rooms.map((r) => [r.id, r.text.origin.memberId])).toEqual([[PUB, "m_creator"]]);
  });

  it("answers the handle and its rooms and nothing more", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
    const body = await bodyOf(await pub("/public/handles/jesse"));
    expect(Object.keys(body).sort()).toEqual(["handle", "rooms"]);
    expect(Object.keys((body.rooms as object[])[0]).sort()).toEqual(["id", "public_url", "signed_at", "text"]);
  });

  it("reads the handle as a claim does: percent-decoded, trimmed and lowercased", async () => {
    await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
    expect(await bodyOf(await pub("/public/handles/%20%4AESSE%20"))).toMatchObject({ handle: "jesse" });
  });

  it("answers a malformed percent-escape with the handle 404, not a 500", async () => {
    const res = (await pub("/public/handles/%E0%A4%A"))!;
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found", error_description: "no such handle" }]);
  });

  it("lists the newest signatures first, at most MAX_ROOMS_LISTED of them", async () => {
    await store.claimHandle("u_jesse", "jesse");
    const total = MAX_ROOMS_LISTED + 3;
    for (let i = 0; i < total; i++) {
      await store.createSession(session({ id: `qs_many_${i}`, manifest: roomManifest({ public: true }), members: [member()] }));
      await store.signRoom("u_jesse", `qs_many_${i}`, 1_000 + i);
    }
    const { rooms } = (await bodyOf(await pub("/public/handles/jesse"))) as { rooms: { id: string; signed_at: string }[] };
    expect(rooms.map((r) => r.id)).toEqual(Array.from({ length: MAX_ROOMS_LISTED }, (_, k) => `qs_many_${total - 1 - k}`));
    expect(rooms[0].signed_at).toBe(new Date(1_000 + total - 1).toISOString());
  });

  // One case for each way a signed room leaves the page, beside a control that stays on it. The extra room is signed
  // straight through the store with the newest signature, so whichever condition lets it through puts it first.
  // (The route refuses some of these signatures; the registry is what the page must not trust.)
  describe("keeps off the page a signed room a reader may not see", () => {
    const idsWith = async (over: SessionSeed) => {
      await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
      await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
      await store.createSession(session({ id: "qs_extra", manifest: roomManifest({ public: true }), members: [member(), peer()], ...over }));
      await store.signRoom("u_jesse", "qs_extra", Date.now() + 60_000);
      const { rooms } = (await bodyOf(await pub("/public/handles/jesse"))) as { rooms: { id: string }[] };
      return rooms.map((r) => r.id);
    };

    it("lists a second room that is public, open and the creator's own, newest signature first: the control", async () => {
      expect(await idsWith({})).toEqual(["qs_extra", PUB]);
    });

    it.each<[string, SessionSeed]>([
      ["was never public", { manifest: roomManifest({ public: false }) }],
      ["is closed, which isPublic still passes until the purge", { closed: true, closedAt: 1_700_000_000_000, joinCodes: {} }],
      ["someone else created", { createdBy: "u_peer" }],
    ])("drops a signed room that %s", async (_why, over) => {
      expect(await idsWith(over)).toEqual([PUB]);
    });

    it("drops a signed room once it is purged, and still answers", async () => {
      await handleCall(DEV_KEY.jesse, "PUT", { handle: "jesse" });
      await roomCall(DEV_KEY.jesse, "PUT", `/rooms/${PUB}/byline`);
      await store.createSession(session({
        id: "qs_purged", manifest: roomManifest({ public: true }), members: [member()], closed: true, closedAt: Date.now() - 1_000, joinCodes: {},
      }));
      await store.signRoom("u_jesse", "qs_purged", Date.now() + 60_000);
      await store.schedulePurge("qs_purged", Date.now(), "u_jesse");
      await store.sweep(Date.now());
      expect(await store.getSession("qs_purged")).toBeUndefined();
      const res = (await pub("/public/handles/jesse"))!;
      expect(res.status).toBe(200);
      expect(((await res.json()) as { rooms: { id: string }[] }).rooms.map((r) => r.id)).toEqual([PUB]);
    });
  });
});
