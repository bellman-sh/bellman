/**
 * A hosted room's instructions in the room block of every tool that returns one. They are what the room's creator
 * wrote, so the creator's account reads them back in `text.data.host_instructions`, inside the untrusted envelope,
 * and no other account does, through whichever door the block comes: `bellman_start`, `bellman_connect`,
 * `bellman_confirm`, `bellman_surface` or `bellman_rooms`. The HTTP read is in tests/http-rooms.test.ts, the pure
 * rule in tests/projections.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Outcome } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import { SOCIAL_HOST_INSTRUCTIONS } from "../../src/manifest.js";

const TEXT = "Ask about the week.";

const hosted = {
  room: "build-club", purpose: "What people are building this week", mode: "swarm", heartbeat: "1h",
  roles: { lead: { can: ["send", "invite", "revoke"] }, guest: { can: ["send"] }, host: { can: ["send"] } },
  default_role: "guest", creator_role: "lead",
  host: { role: "host", model: "haiku", instructions: TEXT },
};

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

/** The untrusted text of a tool's room block. */
const textOf = (room: unknown) => (room as { text: { trust: string; data: Record<string, unknown> } }).text;
/** The room block of `bellman_rooms`' only room. */
const roomsBlock = (out: Outcome) => (out.data.rooms as { room: unknown }[])[0].room;

async function startHosted(manifest: Record<string, unknown> = hosted) {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", { manifest, brief: brief() });
  expect(started.isError, started.text).toBe(false);
  return {
    creator, started,
    sessionId: String(started.data.session_id), memberId: String(started.data.member_id), code: String(started.data.join_code),
  };
}

const confirm = (preview: Outcome) => ({
  connect_token: String(preview.data.connect_token), brief: brief(), capabilities: ["read_context", "receive_messages"],
});

describe("a hosted room's instructions through the tools", () => {
  it("gives the creator the text in the room block of bellman_start, bellman_surface and bellman_rooms", async () => {
    const { creator, started, sessionId } = await startHosted();
    const surface = await creator.call("bellman_surface", { session_id: sessionId });
    const rooms = await creator.call("bellman_rooms");
    expect([surface.isError, rooms.isError]).toEqual([false, false]);
    const blocks = { bellman_start: started.data.room, bellman_surface: surface.data.room, bellman_rooms: roomsBlock(rooms) };
    for (const [tool, room] of Object.entries(blocks)) {
      expect(textOf(room).trust, tool).toBe("untrusted");
      expect(textOf(room).data.host_instructions, tool).toBe(TEXT);
    }
  });

  it("gives a member who is not the creator nothing, through bellman_connect, bellman_confirm, bellman_surface, bellman_rooms or bellman_sync", async () => {
    const { creator, sessionId, code } = await startHosted();
    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: code });
    expect(preview.isError, preview.text).toBe(false);
    const confirmed = await joiner.call("bellman_confirm", confirm(preview));
    expect(confirmed.isError, confirmed.text).toBe(false);
    const surface = await joiner.call("bellman_surface", { session_id: sessionId });
    const rooms = await joiner.call("bellman_rooms");
    const sync = await joiner.call("bellman_sync", { session_id: sessionId, member_id: String(confirmed.data.member_id), since_cursor: 0 });

    const doors: Record<string, Outcome> = { bellman_connect: preview, bellman_confirm: confirmed, bellman_surface: surface, bellman_rooms: rooms, bellman_sync: sync };
    for (const [tool, out] of Object.entries(doors)) {
      expect(out.isError, `${tool}: ${out.text}`).toBe(false);
      expect(out.text, tool).not.toContain(TEXT);
    }
    for (const room of [preview.data.room, confirmed.data.room, surface.data.room, roomsBlock(rooms)]) {
      expect(textOf(room).data).not.toHaveProperty("host_instructions");
    }
    // Control: the creator reads the same room's text through the same door, so the lines above can fail.
    expect((await creator.call("bellman_surface", { session_id: sessionId })).text).toContain(TEXT);
  });

  it("gives the creator's own account the text when it previews and confirms a seat in its room: the viewer is the account, not the seat", async () => {
    const { creator, code } = await startHosted();
    const preview = await creator.call("bellman_connect", { join_code: code });
    expect(preview.isError, preview.text).toBe(false);
    expect(textOf(preview.data.room).data.host_instructions).toBe(TEXT);
    const confirmed = await creator.call("bellman_confirm", confirm(preview));
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(textOf(confirmed.data.room).data.host_instructions).toBe(TEXT);
  });

  it("leaves the key out of a room with no host, for its creator", async () => {
    const { creator, started, sessionId } = await startHosted({ room: "plain", preset: "swarm" });
    const surface = await creator.call("bellman_surface", { session_id: sessionId });
    const rooms = await creator.call("bellman_rooms");
    for (const room of [started.data.room, surface.data.room, roomsBlock(rooms)]) {
      expect(textOf(room).data).not.toHaveProperty("host_instructions");
    }
  });

  it("reads back a preset's own instructions to the creator who never wrote them, in the same envelope", async () => {
    const { started } = await startHosted({ room: "the square", purpose: "what people build", preset: "social" });
    expect(textOf(started.data.room).data.host_instructions).toBe(SOCIAL_HOST_INSTRUCTIONS);
  });
});
