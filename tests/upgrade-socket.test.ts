/**
 * `ignoreResets`, and the Node behaviour it exists for.
 *
 * The bug it fixes was a CI flake: an uncaught `ECONNRESET` on a socket taken from
 * an `'upgrade'` event, which failed the run with all 1,873 assertions passing. It
 * reproduces on neither macOS nor demand — whether a poll is in flight when
 * `afterEach` kills the bridge is timing, and whether the kernel turns that close
 * into a reset is the platform's. So the thing worth pinning is not the race. It is
 * the one fact the race exploited, which `emit` makes deterministic and
 * cross-platform: **an `'error'` with no listener throws.**
 *
 * That is why `expect(...).toThrow()` is in the first case. Without it the second
 * case passes against an `ignoreResets` whose body was deleted, and the assertion
 * that is supposed to hold the fix in place would be holding nothing.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { ignoreResets } from "./helpers/upgrade-socket.js";

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

describe("ignoreResets", () => {
  it("THE CONTROL: an error on a bare socket throws", () => {
    // Node's own rule, and the whole defect. An EventEmitter with no 'error'
    // listener rethrows synchronously; off a socket's read callback there is no
    // caller to catch it, so it surfaces as an uncaught exception and vitest fails
    // the run. If this case ever goes green, the one below has stopped meaning
    // anything.
    expect(() => new PassThrough().emit("error", reset())).toThrow("ECONNRESET");
  });

  it("swallows a reset, so a killed peer cannot fail the run", () => {
    const socket = new PassThrough();
    ignoreResets(socket);
    expect(() => socket.emit("error", reset())).not.toThrow();
  });

  it("returns the socket it was given, so it can wrap a call", () => {
    // channel-bus.test.ts writes `ignoreResets(socket).end(...)`: the listener goes
    // on before the write, which is the order that matters when the write is what
    // provokes the peer.
    const socket = new PassThrough();
    expect(ignoreResets(socket)).toBe(socket);
  });

  it("leaves every other event alone", () => {
    // Swallowing is scoped to 'error'. A handler that absorbed more would hide a
    // test server failing to close.
    const socket = new PassThrough();
    ignoreResets(socket);
    const seen: string[] = [];
    socket.on("close", () => seen.push("close"));
    socket.emit("close");
    expect(seen).toEqual(["close"]);
  });
});
