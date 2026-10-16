import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief } from "../helpers/fixtures.js";
import { joinWith, pairUp, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

describe("who is a stranger (spec \u{A7}2)", () => {
  it("records a seat taken through the permanent code as a stranger's, and one through a code that expires as not", async () => {
    const room = await publicRoom(h);
    const stranger = await joinWith(await h.connect(DEV_KEY.peer), room.code);
    const observer = await room.creator.call("bellman_invite", { session_id: room.sessionId, member_id: room.memberId, role: "observer" });
    const regular = await joinWith(await h.connect(DEV_KEY.outsider), String(observer.data.join_code));
    expect((await h.store.getMember(room.sessionId, String(stranger.data.member_id)))?.via).toBe("permanent");
    expect((await h.store.getMember(room.sessionId, String(regular.data.member_id)))?.via).toBeUndefined();
    expect((await h.store.getMember(room.sessionId, room.memberId))?.via, "the creator").toBeUndefined();
  });
});
