/**
 * #144: the keepalive's two texts are a protocol, and they now have one home.
 *
 * `SessionDO`'s constructor registers them with
 * `setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))`, and
 * the runtime answers a frame that equals the first string EXACTLY — no
 * JavaScript runs and the object is not constructed. Anything else reaches
 * `webSocketMessage`, which closes the socket 1003. So the client in
 * `src/room-socket.ts` has to send that same text, and the fake server in
 * `tests/helpers/fake-bellman.ts` has to answer it, or the end-to-end tests
 * agree with the client while the real server drifts.
 *
 * Before this module the strings were in four places — the server's inline
 * literals, the client's own constants, the fake's own copy, and
 * store-do-wiring's assertion — tied together by comments. Now they agree by
 * construction, which is the whole fix; these tests pin the two things
 * construction cannot.
 */
import { describe, it, expect } from "vitest";
import { PING, PONG } from "../src/keepalive.js";

describe("the keepalive pair", () => {
  /**
   * The ONE place these literals belong.
   *
   * This is a wire value matched byte-for-byte by a runtime this repo does not
   * control, so it is not ours to tidy. Measured against workerd 1.20260915.1:
   * `ping ` (trailing space), `Ping` and `ping\n` each WOKE the object and were
   * closed 1003, where `ping` was answered by the runtime with the object never
   * constructed. Renaming the constant is free; changing its value is a
   * protocol break that costs hibernation and shows up as a client-side
   * reconnect loop that looks like a server-side drop.
   */
  it("is exactly the text the runtime's auto-response matches", () => {
    expect(PING).toBe("ping");
    expect(PONG).toBe("pong");
  });

  it("is two different texts, so a reply cannot be read back as a request", () => {
    expect(PING).not.toBe(PONG);
  });

  it("carries no whitespace or case the runtime would refuse", () => {
    // Each of these is a measured 1003 close rather than a hypothetical.
    for (const s of [PING, PONG]) {
      expect(s).toBe(s.trim());
      expect(s).toBe(s.toLowerCase());
      expect(s).not.toContain("\n");
    }
  });
});
