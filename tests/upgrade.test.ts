/**
 * The `Upgrade` header's grammar, where `src/worker.ts` and `src/store-do.ts` cannot
 * be tested from: both import `cloudflare:workers`. `src/upgrade.ts` holds the rule
 * for that reason, and this is where it is pinned.
 *
 * `tests/worker-ws.test.ts` drives the route and `tests/store-do-wiring.test.ts` the
 * object; each asserts that a real `Upgrade: WebSocket` is served and that the 426
 * names a protocol. What they cannot cheaply do is the table below — every form of
 * the field worth refusing or accepting, which is the part #132 got wrong.
 */
import { describe, it, expect } from "vitest";
import { UPGRADE_REQUIRED, WEBSOCKET, wantsWebSocket } from "../src/upgrade.js";

describe("wantsWebSocket", () => {
  /**
   * The token is case-insensitive (RFC 9110 section 7.8) and the field is a list, so
   * both axes have accepted and refused rows. A table rather than one case per `it`:
   * the interesting thing is the BOUNDARY, and a boundary is only visible with what
   * sits either side of it in view.
   */
  const CASES: [string | null | undefined, boolean, string][] = [
    ["websocket", true, "the canonical form"],
    // #132 itself: valid, sent by real stacks, and refused before the fix.
    ["WebSocket", true, "the casing RFC 6455's own prose uses"],
    ["WEBSOCKET", true, "shouted"],
    ["wEbSoCkEt", true, "no casing is privileged"],
    ["  websocket  ", true, "surrounded by the whitespace a list tolerates"],
    ["websocket, h2c", true, "first in a list"],
    ["h2c, WebSocket", true, "second in a list, and cased"],
    ["h2c,websocket", true, "a list with no space after the comma"],

    [null, false, "absent"],
    [undefined, false, "absent, as a missing property rather than a null"],
    ["", false, "present and empty"],
    ["   ", false, "whitespace only"],
    [",", false, "a list of nothing"],
    ["h2c", false, "a protocol that is not this one"],
    // A prefix match would take these, and they are not the token.
    ["websockets", false, "the plural is a different protocol"],
    ["websocket-ish", false, "a longer token that merely starts the same"],
    ["notwebsocket", false, "a longer token that merely ends the same"],
    // RFC 6455 names no version after a slash, so this is not the token either.
    ["websocket/13", false, "a versioned token RFC 6455 does not define"],
  ];

  it.each(CASES)("%j is %s — %s", (value, expected) => {
    expect(wantsWebSocket(value)).toBe(expected);
  });

  it("matches the token it advertises", () => {
    // The two halves of #132 are one fact: the server refuses what it does not want
    // and names what it does. If the 426's header and the predicate ever disagreed,
    // the server would be telling clients to send something it then refuses.
    expect(wantsWebSocket(UPGRADE_REQUIRED.headers.upgrade)).toBe(true);
    expect(UPGRADE_REQUIRED.headers.upgrade).toBe(WEBSOCKET);
  });
});

describe("UPGRADE_REQUIRED", () => {
  it("is a 426 that names the protocol it wants", () => {
    // RFC 9110 section 15.5.22. Without the header the status says only "not like
    // that", and a client has nothing to discover the alternative from — which is
    // what this answered with before #132.
    expect(UPGRADE_REQUIRED.status).toBe(426);
    expect(UPGRADE_REQUIRED.headers.upgrade).toBe("websocket");
    expect(UPGRADE_REQUIRED.body, "the prose a developer reads stays").toContain("WebSocket");
  });
});
