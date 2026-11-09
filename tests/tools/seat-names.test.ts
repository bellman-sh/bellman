/**
 * Seat names (seat names spec): every seat is `<role>-<seq>`, returned beside its member id and on every member a tool
 * lists, so an agent can name a seat and tell an account's seats apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinWith, startRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

const SWARM = {
  room: "swarm", mode: "swarm",
  roles: { lead: { can: ["send", "invite"] }, coder: { can: ["send"] } },
  default_role: "coder", creator_role: "lead",
};

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

/** The name the store's own row gives a seat: what every tool must agree with. */
const nameOf = async (sessionId: string, memberId: string) => {
  const m = (await h.store.getSession(sessionId))!.members.find((x) => x.memberId === memberId)!;
  return `${m.roomRole}-${m.seq}`;
};

describe("seat names", () => {
  it("bellman_start returns the creator's name beside its member_id", async () => {
    const { sessionId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    expect(started.data.name).toBe(await nameOf(sessionId, String(started.data.member_id)));
    expect(started.data.name).toMatch(/^lead-\d+$/);
  });

  it("bellman_confirm returns the joiner's name, a name on every member, and the name in member_joined", async () => {
    const { sessionId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const joined = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    expect(joined.isError, joined.text).toBe(false);
    const me = String(joined.data.member_id);
    expect(joined.data.name).toBe(await nameOf(sessionId, me));
    const members = joined.data.members as { member_id: string; name: string }[];
    for (const m of members) expect(m.name).toBe(await nameOf(sessionId, m.member_id));
    const event = (await h.store.eventsAfter(sessionId, 0)).find((e) => e.type === "member_joined" && e.fromMemberId === me)!;
    expect((event.payload as { member: { name: string } }).member.name).toBe(joined.data.name);
  });

  it("gives two seats of one account different names", async () => {
    const { sessionId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const a = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    const b = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    expect(a.data.name).not.toBe(b.data.name);
    expect([a.data.name, b.data.name]).toEqual([
      await nameOf(sessionId, String(a.data.member_id)), await nameOf(sessionId, String(b.data.member_id)),
    ]);
  });

  it("bellman_rooms names each member", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, started } = await startRoom(creator, SWARM);
    await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    const rooms = (await creator.call("bellman_rooms")).data.rooms as { members: { member_id: string; name: string }[] }[];
    const members = rooms[0]!.members;
    expect(members.length).toBe(2);
    for (const m of members) expect(m.name).toBe(await nameOf(sessionId, m.member_id));
  });
});
