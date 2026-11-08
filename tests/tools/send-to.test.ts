/**
 * `bellman_send`'s `to` (seat names spec): a message or artifact addressed to named seats, resolved by the server to
 * member ids and stored as `toMemberIds`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinWith, startRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";

const SWARM = {
  room: "swarm", mode: "swarm",
  roles: { lead: { can: ["send", "invite"] }, coder: { can: ["send"] } },
  default_role: "coder", creator_role: "lead",
};

let h: Harness;
let lead: Peer;
let sessionId: string;
let leadId: string;
/** Two coders: `hearing` allows receive_messages, `deaf` does not. */
let hearing: { id: string; name: string };
let deaf: { id: string; name: string };

beforeEach(async () => {
  h = new Harness();
  lead = await h.connect(DEV_KEY.jesse);
  const { sessionId: id, started } = await startRoom(lead, SWARM);
  sessionId = id;
  leadId = String(started.data.member_id);
  const a = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code), ["read_context", "receive_messages"]);
  const b = await joinWith(await h.connect(DEV_KEY.outsider), String(started.data.join_code), ["read_context"]);
  hearing = { id: String(a.data.member_id), name: String(a.data.name) };
  deaf = { id: String(b.data.member_id), name: String(b.data.name) };
});
afterEach(async () => { await h.close(); });

const send = (over: Record<string, unknown>) => lead.call("bellman_send", {
  session_id: sessionId, member_id: leadId, type: "message", payload: { text: "for you" }, ...over,
});
const messages = async () => (await h.store.eventsAfter(sessionId, 0)).filter((e) => e.type === "message");

describe("bellman_send to", () => {
  it("stores the addressees' member ids on the event, even when another member does not allow receive_messages", async () => {
    const out = await send({ to: [hearing.name.toUpperCase()] });
    expect(out.isError, out.text).toBe(false);
    expect((await messages()).map((e) => e.toMemberIds)).toEqual([[hearing.id]]);
  });

  it("leaves an unaddressed message without toMemberIds", async () => {
    expect((await send({})).isError).toBe(false);
    expect((await messages())[0]).not.toHaveProperty("toMemberIds");
  });

  it("refuses to on any type but message and artifact", async () => {
    const out = await lead.call("bellman_send", {
      session_id: sessionId, member_id: leadId, type: "progress", payload: { note: "n" }, to: [hearing.name],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/to is only for message and artifact/);
  });

  it("refuses an unknown name and a seat without receive_messages, naming each, and appends nothing", async () => {
    const unknown = await send({ to: ["coder-99"] });
    expect([unknown.isError, unknown.text]).toEqual([true, expect.stringContaining("coder-99")]);
    const refused = await send({ to: [deaf.name] });
    expect([refused.isError, refused.text]).toEqual([true, expect.stringContaining(`${deaf.name} does not allow receive_messages.`)]);
    expect(await messages()).toEqual([]);
  });

  it("replays a keyed retry with the same to, and refuses the key with another to", async () => {
    expect((await send({ to: [hearing.name], idempotency_key: "addr-0001" })).isError).toBe(false);
    const again = await send({ to: [hearing.name], idempotency_key: "addr-0001" });
    expect(again.data.replayed).toBe(true);
    // The same key and payload with another `to` (here none) is another message.
    const unaddressed = await send({ idempotency_key: "addr-0001" });
    expect(unaddressed.text).toMatch(/already used for a different message/);
    expect(await messages()).toHaveLength(1);
  });
});
