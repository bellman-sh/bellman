import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import {
  CALLBACK_PORTS, listenForCallback, loopbackRedirects, openBrowser, type Listener,
} from "../src/signin.js";

// openBrowser is the one thing here that starts a process. The real spawn stays
// the default, so a test can ask a real launcher to fail; the tests that must
// never open a browser swap in a fake child for a single call.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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

  // Review Focus 1, from the attacker's side. The forgery that costs nothing is
  // a callback with no state at all; a wrong state is the one that takes effort.
  it("refuses every way of not knowing the state, and keeps waiting", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 400);
    const timedOut = expect(waiting).rejects.toThrow(/timed out/i); // subscribe first
    for (const [what, query] of [
      ["no state at all", "code=forged"],
      ["an empty state", "code=forged&state="],
      ["the state with more after it", "code=forged&state=state-abc-and-more"],
      ["the state in another case", "code=forged&state=STATE-ABC"],
    ]) {
      const res = await get(`${listener.redirectUri}?${query}`);
      expect(res.status, what).toBe(400);
    }
    await timedOut; // none of them settled the wait
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

  // The handler must never throw: an exception out of it is uncaught, and it
  // ends the bridge. A web page can send this request while a sign-in is pending.
  it("answers a request target it cannot parse, and keeps waiting", async () => {
    const listener = track((await listenForCallback(TEST_PORTS))!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const landed = expect(waiting).resolves.toBe("the-code"); // subscribe first
    // A valid URL to a browser; to `new URL(target, base)` it is a scheme-relative
    // reference with an impossible port.
    const res = await get(`http://127.0.0.1:${TEST_PORTS[0]}//evil.com:99999999/callback`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(res.status).toBe(400);
    // It neither crashed the listener nor cancelled the pending sign-in.
    await get(`${listener.redirectUri}?code=the-code&state=state-abc`);
    await landed;
  });
});

describe("openBrowser", () => {
  const url = new URL("https://bellman.example/authorize?client_id=c&state=s");
  beforeEach(() => { vi.mocked(spawn).mockClear(); });

  /** A stand-in child process, handed out for exactly one spawn call. */
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ChildProcess);
    return child;
  }

  // A launcher that is not installed is not a throw: spawn reports it later, as an
  // 'error' event, and an 'error' event nobody listens for is an uncaught exception
  // that ends the bridge. That is a headless box, a container, an SSH session.
  it("gives the user the URL when there is no launcher, instead of crashing", async () => {
    const logged: string[] = [];
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent-bellman-test-path"; // no open, no xdg-open, no cmd
    try { openBrowser(url, (m) => logged.push(m)); } finally { process.env.PATH = path; }
    await vi.waitFor(
      () => expect(logged.join("\n")).toContain("could not open a browser"),
      { timeout: 1_000 },
    );
    expect(logged.join("\n")).toContain(url.toString());
    expect(logged.join("\n")).not.toContain("opened a browser"); // and it must not claim success
  });

  it("says which URL it opened only once the launcher has started", () => {
    const child = fakeChild();
    const logged: string[] = [];
    openBrowser(url, (m) => logged.push(m));
    expect(logged).toEqual([]);
    child.emit("spawn");
    expect(logged).toEqual([`opened a browser to sign in: ${url}`]);
  });

  it("falls back to the URL when spawn itself throws", () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("EACCES"); });
    const logged: string[] = [];
    openBrowser(url, (m) => logged.push(m));
    expect(logged).toEqual([`could not open a browser. Sign in here: ${url}`]);
  });

  // A child writing to our stdout would corrupt the MCP transport.
  it("spawns the launcher detached, with its output discarded, and lets go of it", () => {
    const child = fakeChild();
    openBrowser(url, () => {});
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([url.toString()]),
      { stdio: "ignore", detached: true },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
