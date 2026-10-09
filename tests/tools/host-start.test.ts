/**
 * bellman_start and the hosted seat (#188, #189): a `host` block is refused on a
 * plan with no hosted seat, and past the plan's hosted rooms for the month;
 * otherwise the room is created with the host seated beside its creator and the
 * plan's units stamped on the room.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import { HOST_MEMBER_ID } from "../../src/host.js";
import type { Identity } from "../../src/types.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const max: Identity = { userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" };
const pro: Identity = { userId: "u_pro", orgId: null, plan: "pro", role: "member", label: "pro" };
const social = { room: "the square", purpose: "what people build", preset: "social" };

// The host answers only a reply whose ref_id is its question's cursor (I1), so the tool says so where agents read it.
it("bellman_send tells an agent what ref_id is for, and that the host answers only replies carrying its question's cursor", async () => {
  const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
  const send = tools.find((t) => t.name === "bellman_send")!;
  expect(send.description).toContain(
    "ref_id: the cursor of the event you are answering; a room's host answers only replies that carry its question's cursor",
  );
});

describe("bellman_start with a host", () => {
  it("refuses a hosted room on a plan with no hosted seat, naming the plan", async () => {
    // Free cannot make a swarm room either; the hosted seat's refusal is the one it
    // sees, because upgrading to pro, which the swarm refusal offers, buys no seat.
    const free = await h.connect(DEV_KEY.outsider);
    const r = await free.call("bellman_start", { manifest: social, brief: brief() });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/a hosted seat requires the max or team plan \(you are on "free"\)/);

    const onPro = await (await h.connectAs(pro)).call("bellman_start", { manifest: social, brief: brief() });
    expect(onPro.isError).toBe(true);
    expect(onPro.text).toMatch(/a hosted seat requires the max or team plan \(you are on "pro"\)/);
  });

  it("seats the host beside the creator and stamps the room's units from the plan", async () => {
    const creator = await h.connectAs(max);
    const r = await creator.call("bellman_start", { manifest: social, brief: brief() });
    expect(r.isError, r.text).toBe(false);
    const s = (await h.store.getSession(String(r.data.session_id)))!;
    expect(s.members.map((m) => m.memberId)).toContain(HOST_MEMBER_ID);
    expect(s.members.find((m) => m.memberId === HOST_MEMBER_ID)!.roomRole).toBe("host");
    expect(s.hostUnitsPerMonth).toBe(3000);
    expect((r.data.room as Record<string, unknown>).host).toEqual({ role: "host", model: "haiku" });
    // The room holds one of the creator's hosted slots.
    expect(await h.store.reserveHostedRoom(max.userId, "qs_probe", 1)).toEqual({ ok: false, open: 1 });
  });

  /**
   * A plan's hosted rooms are the most open at once (I7): a fourth is refused on max,
   * naming the count open and the plan, and a hosted room that closes gives its slot back.
   */
  it("refuses a fourth hosted room open at once on max, admits one once a room closes, and still allows a room without a host", async () => {
    const creator = await h.connectAs(max);
    const opened: { session_id: string; member_id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await creator.call("bellman_start", { manifest: social, brief: brief() });
      expect(r.isError, r.text).toBe(false);
      opened.push({ session_id: String(r.data.session_id), member_id: String(r.data.member_id) });
    }
    const fourth = await creator.call("bellman_start", { manifest: social, brief: brief() });
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toMatch(/hosted room limit reached: 3 hosted rooms open, the most the "max" plan allows/);
    const plain = await creator.call("bellman_start", { manifest: { room: "r", preset: "swarm" }, brief: brief() });
    expect(plain.isError, plain.text).toBe(false);
    expect((plain.data.room as Record<string, unknown>).host).toBeNull();

    // The creator leaves one: its last person gone, the room closes and its slot is free.
    expect((await creator.call("bellman_leave", opened[0])).isError).toBe(false);
    const again = await creator.call("bellman_start", { manifest: social, brief: brief() });
    expect(again.isError, again.text).toBe(false);
  });

  it("gives the slot back when the room cannot be created, so a failed start costs none", async () => {
    const creator = await h.connectAs(max);
    const create = h.store.createSession.bind(h.store);
    h.store.createSession = async () => { throw new Error("storage refused the room"); };
    const failed = await creator.call("bellman_start", { manifest: social, brief: brief() });
    expect(failed.isError).toBe(true);
    h.store.createSession = create;
    expect(await h.store.reserveHostedRoom(max.userId, "qs_probe", 1)).toEqual({ ok: true });
  });

  it("records in the audit log whether a room was created with a host", async () => {
    const admin = await h.connectAs({ userId: "u_acme", orgId: "org_acme", plan: "team", role: "admin", label: "acme" });
    const hosted = await admin.call("bellman_start", { manifest: social, brief: brief() });
    const plain = await admin.call("bellman_start", { manifest: { room: "r", preset: "swarm" }, brief: brief() });
    expect(hosted.isError, hosted.text).toBe(false);

    const log = ((await admin.call("bellman_audit", { limit: 100 })).data.entries ?? []) as
      { action: string; session_id: string; detail: Record<string, unknown> }[];
    const created = (r: { data: Record<string, unknown> }) =>
      log.find((e) => e.action === "session_created" && e.session_id === String(r.data.session_id))?.detail;
    expect(created(hosted)).toMatchObject({ hosted: true });
    expect(created(plain)).toMatchObject({ hosted: false });
  });
});
