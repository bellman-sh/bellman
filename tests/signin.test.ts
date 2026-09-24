import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  CALLBACK_PORTS, listenForCallback, loopbackRedirects, type Listener,
} from "../src/signin.js";

/** Ports well away from the real range, so a developer's live bridge is untouched. */
const TEST_PORTS = [53411, 53412, 53413];

const open: { close(): void }[] = [];
afterEach(() => { for (const item of open.splice(0)) item.close(); });
function track<T extends { close(): void }>(x: T): T { open.push(x); return x; }

/**
 * fetch(), one connection per request. fetch pools keep-alive connections by
 * origin, and every test here rebinds the same ports, so a pooled connection to
 * the server the last test closed can be handed to this test's request, and it
 * fails with ECONNRESET. Which pair of tests trips it depends on event-loop
 * timing, so no delay cures it; not pooling does.
 */
const get = (url: string, init: { signal?: AbortSignal } = {}) =>
  fetch(url, { ...init, headers: { connection: "close" } });

async function block(port: number): Promise<void> {
  const blocker = track(createServer());
  await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
}

describe("loopbackRedirects", () => {
  it("is the fixed range the client registers, in ascending order", () => {
    expect(CALLBACK_PORTS).toEqual([51004, 51005, 51006, 51007, 51008]);
    expect(loopbackRedirects()).toEqual([
      "http://127.0.0.1:51004/callback",
      "http://127.0.0.1:51005/callback",
      "http://127.0.0.1:51006/callback",
      "http://127.0.0.1:51007/callback",
      "http://127.0.0.1:51008/callback",
    ]);
  });
});

describe("the loopback listener", () => {
  it("binds the first free port in ascending order", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[0]}/callback`);
  });

  it("skips a busy port and takes the next", async () => {
    await block(TEST_PORTS[0]);
    const listener = track((await listenForCallback(TEST_PORTS))!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[1]}/callback`);
  });

  it("gives up when every port is busy", async () => {
    for (const port of TEST_PORTS) await block(port);
    expect(await listenForCallback(TEST_PORTS)).toBeUndefined();
  });

  it("captures the code from a matching callback", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const res = await get(`${listener.redirectUri}?code=the-code&state=state-abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("close this tab");
    await expect(waiting).resolves.toBe("the-code");
  });

  // Review Focus 1 — the SDK does not check state for us.
  it("rejects a callback whose state does not match", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 400);
    const timedOut = expect(waiting).rejects.toThrow(/timed out/i); // subscribe first
    const res = await get(`${listener.redirectUri}?code=forged&state=state-xyz`);
    expect(res.status).toBe(400);
    // The forged call must NOT complete the wait — it times out instead.
    await timedOut;
  });

  // Review Focus 2 — the human clicked Cancel.
  it("fails fast when the callback carries an error instead of a code", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 60_000);
    // Subscribe BEFORE the request. The listener rejects inside the request
    // handler, while fetch() is still resolving; a rejection nobody is handling
    // yet is an unhandled rejection, and vitest fails the whole run on one.
    const refused = expect(waiting).rejects.toThrow(/access_denied/);
    await get(`${listener.redirectUri}?error=access_denied&state=state-abc`);
    await refused;
  });

  it("times out rather than waiting forever", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    await expect(listener.waitForCode("state-abc", 200)).rejects.toThrow(/timed out/i);
  });

  it("ignores a request to another path", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 400);
    const timedOut = expect(waiting).rejects.toThrow(/timed out/i); // subscribe first
    const res = await get(`http://127.0.0.1:${TEST_PORTS[0]}/favicon.ico`);
    expect(res.status).toBe(404);
    await timedOut;
  });
});
