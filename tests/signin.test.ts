import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALLBACK_PORTS, connectSignedIn, listenForCallback, loopbackRedirects, openBrowser, page,
  SignInCancelled, type Listener, type SignInOptions,
} from "../src/signin.js";
import type { Remote } from "../src/bridge.js";
import { acquireLock, readServer, writeServer } from "../src/credentials.js";
import type { Identity } from "../src/types.js";
import { fakeBellman, RESOURCE, type FakeBellman } from "./helpers/fake-bellman.js";

// openBrowser is the one thing here that starts a process. The real spawn stays
// the default, so a test can ask a real launcher to fail; the tests that must
// never open a browser swap in a fake child for a single call.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// The server a listener creates is not exposed, and a real accept error (EMFILE)
// cannot be provoked from a test. createServer stays the real one, but is spied
// on, so a test can get at the server the listener made and emit an error on it.
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

/** Claims `port` on loopback, or rejects if it is taken. The server holds it until released. */
const claim = (port: number) =>
  new Promise<NetServer>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
const release = (server: NetServer) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * Three consecutive loopback ports that are free right now, chosen once when this file
 * loads and fixed for the whole run: the fake registers whatever loopbackRedirects(ports)
 * is given, so they cannot move between tests.
 *
 * They used to be a fixed 53411-53413, which made two runs of the suite on one machine
 * (two worktrees, a reviewer's clone beside the implementer's checkout) fight over them.
 * The loser fails "binds the first free port in ascending order" and its neighbours for
 * no reason, and a void run reads as unrelated failures, which sends the next person
 * hunting a bug that is not there.
 *
 * The base is picked at random, not by asking the OS for a free port: bind(0) hands out
 * ephemeral ports in sequence (measured, on macOS: 56698, 56699, 56700...), so two runs
 * that start together are given neighbouring triples and trip over each other as soon
 * as the probe lets go. 10000-31999 is below every OS's ephemeral range, and clear of
 * the real bridge's, so a developer's live bridge is untouched.
 */
async function freeTriple(): Promise<number[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 10_000 + Math.floor(Math.random() * 22_000);
    const held: NetServer[] = [];
    try {
      for (const port of [base, base + 1, base + 2]) held.push(await claim(port));
      return [base, base + 1, base + 2];
    } catch {
      // One of the three is taken. Pick again.
    } finally {
      await Promise.all(held.map(release));
    }
  }
  throw new Error("no three consecutive free loopback ports after 50 tries");
}

const TEST_PORTS = await freeTriple();

/**
 * An access token the SERVER refuses. Writing expires_at into the past is not
 * enough on its own: that is only our local bookkeeping, and the fake verifies
 * the real JWT, whose own exp is still minutes out — so the request succeeds,
 * no 401 comes back, and the refresh under test never runs. Pairing the two is
 * the honest fixture: our clock says stale AND the far end agrees.
 */
const STALE = "stale.not.a.jwt";

/** What the listeners under test said. A listener that is not in trouble says nothing. */
const diagnostics: string[] = [];
beforeEach(() => { diagnostics.length = 0; });
const listen = () => listenForCallback(TEST_PORTS, (message) => diagnostics.push(message));

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
    const listener = track((await listen())!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[0]}/callback`);
  });

  it("skips a busy port and takes the next", async () => {
    await block(TEST_PORTS[0]);
    const listener = track((await listen())!);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[1]}/callback`);
  });

  it("gives up when every port is busy", async () => {
    for (const port of TEST_PORTS) await block(port);
    expect(await listen()).toBeUndefined();
  });

  it("captures the code from a matching callback", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const res = await get(`${listener.redirectUri}?code=the-code&state=state-abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("close this tab");
    await expect(waiting).resolves.toBe("the-code");
  });

  // Review Focus 1 — the SDK does not check state for us.
  it("rejects a callback whose state does not match", async () => {
    const listener = track((await listen())!);
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
    const listener = track((await listen())!);
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

  // Expecting an empty state is a bug in the caller (the SDK sends no state when
  // state() returns nothing), and it must be loud. Waited on, it fails open:
  // "?code=attacker-code&state=" equals the empty state and the wait resolves.
  it("refuses to wait on an empty state, which nothing could be checked against", async () => {
    const listener = track((await listen())!);
    await expect(listener.waitForCode("", 400)).rejects.toThrow(/non-empty state/);
  });

  // Review Focus 2 — the human clicked Cancel.
  it("fails fast when the callback carries an error instead of a code", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 60_000);
    // Subscribe BEFORE the request. The listener rejects inside the request
    // handler, while fetch() is still resolving; a rejection nobody is handling
    // yet is an unhandled rejection, and vitest fails the whole run on one.
    const refused = expect(waiting).rejects.toThrow(/access_denied/);
    await get(`${listener.redirectUri}?error=access_denied&state=state-abc`);
    await refused;
  });

  // The page is HTML and the error text is the authorization server's, relayed
  // from whatever provider refused. It only gets here past the state check, but it
  // is still someone else's text.
  it("shows the server's error text as text, not as markup", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const payload = '<script>alert("a&b")</script>';
    const refused = expect(waiting).rejects.toThrow(`access_denied: ${payload}`); // subscribe first
    const res = await get(
      `${listener.redirectUri}?error=access_denied&error_description=${encodeURIComponent(payload)}&state=state-abc`,
    );
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&quot;a&amp;b&quot;)&lt;/script&gt;");
    await refused; // the Error keeps the raw text: that goes to a terminal, not a browser
  });

  it("times out rather than waiting forever", async () => {
    const listener = track((await listen())!);
    await expect(listener.waitForCode("state-abc", 200)).rejects.toThrow(/timed out/i);
  });

  it("ignores a request to another path", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 400);
    const timedOut = expect(waiting).rejects.toThrow(/timed out/i); // subscribe first
    const res = await get(`http://127.0.0.1:${TEST_PORTS[0]}/favicon.ico`);
    expect(res.status).toBe(404);
    await timedOut;
  });

  // The state is right but no code came back: the sign-in did not complete, and
  // the wait goes on.
  it("answers a callback with the state but no code with 400, and keeps waiting", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 400);
    const timedOut = expect(waiting).rejects.toThrow(/timed out/i); // subscribe first
    const res = await get(`${listener.redirectUri}?state=state-abc`);
    expect(res.status).toBe(400);
    await timedOut;
  });

  // A listener on every interface would take the callback from the network too.
  it("listens on the loopback interface only", async () => {
    track((await listen())!);
    const server = vi.mocked(createServer).mock.results.at(-1)!.value as Server;
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port: TEST_PORTS[0] });
  });

  // The handler must never throw: an exception out of it is uncaught, and it
  // ends the bridge. A web page can send this request while a sign-in is pending.
  it("answers a request target it cannot parse, and keeps waiting", async () => {
    const listener = track((await listen())!);
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

  // The page a successful sign-in ends on has the authorization code in its own
  // URL, so nothing the listener says should be cached or handed on in a Referer.
  it("marks every response uncacheable and referrer-free", async () => {
    const listener = track((await listen())!);
    const waiting = listener.waitForCode("state-abc", 5_000);
    const landed = expect(waiting).resolves.toBe("the-code"); // subscribe first
    // The request that settles the wait goes last: after it there is no handler.
    const responses = {
      "a page refusing a forged callback": await get(`${listener.redirectUri}?code=forged&state=nope`),
      "a bare 404": await get(`http://127.0.0.1:${TEST_PORTS[0]}/favicon.ico`),
      "a bare 400": await get(`http://127.0.0.1:${TEST_PORTS[0]}//evil.com:99999999/callback`, {
        signal: AbortSignal.timeout(2_000),
      }),
      "the page that carries the code": await get(`${listener.redirectUri}?code=the-code&state=state-abc`),
    };
    for (const [what, res] of Object.entries(responses)) {
      expect(res.headers.get("cache-control"), what).toBe("no-store");
      expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
    }
    await landed;
  });

  // An accept error after a successful bind (EMFILE, say) is an 'error' event on
  // the server, and an 'error' event nobody listens for is an uncaught exception.
  // It is logged rather than swallowed: a listener that has quietly stopped taking
  // connections would otherwise look like a sign-in that never finishes.
  it("logs an error on its server instead of crashing, and keeps listening", async () => {
    const listener = track((await listen())!);
    const server = vi.mocked(createServer).mock.results.at(-1)!.value as Server;
    const accept = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });
    expect(() => server.emit("error", accept)).not.toThrow();
    expect(diagnostics).toEqual([expect.stringContaining("accept EMFILE")]);
    expect(diagnostics[0]).toContain(listener.redirectUri); // which listener, so which port
    // It is still a working listener.
    const waiting = listener.waitForCode("state-abc", 5_000);
    const landed = expect(waiting).resolves.toBe("the-code"); // subscribe first
    await get(`${listener.redirectUri}?code=the-code&state=state-abc`);
    await landed;
  });
});

describe("closing the listener", () => {
  /** Ref'd timers alive right now: what keeps a process from exiting on its own. */
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  /** How a wait ended, without an unhandled rejection in between. */
  const outcomeOf = (waiting: Promise<string>) =>
    waiting.then((code) => `code:${code}`, (error: Error) => `error:${error.message}`);

  // The caller is shutting down. The wait must end now, as something a caller can
  // tell from a failure, and nothing of it may be left to keep the process alive:
  // a pending 300 s timer held the event loop open for five minutes after close().
  it("ends a pending wait with SignInCancelled, and leaves no timer running", async () => {
    const listener = track((await listen())!);
    const before = timers();
    const waiting = listener.waitForCode("state-abc", 300_000);
    const ended = waiting.catch((error: unknown) => error); // subscribe first
    expect(timers()).toBe(before + 1); // the wait's timer is what would pin the process
    listener.close();
    expect(timers()).toBe(before);
    const error = await ended;
    expect(error).toBeInstanceOf(SignInCancelled);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SignInCancelled");
  });

  it("is safe to close twice", async () => {
    const listener = track((await listen())!);
    const ended = listener.waitForCode("state-abc", 300_000).catch((error: unknown) => error);
    expect(() => { listener.close(); listener.close(); }).not.toThrow();
    expect(await ended).toBeInstanceOf(SignInCancelled);
  });

  it("frees its port", async () => {
    const listener = track((await listen())!);
    listener.close();
    // A blocker can only take the port if the listener let go of it.
    await block(TEST_PORTS[0]);
  });

  it("refuses a wait on a closed listener at once, and starts no timer", async () => {
    const listener = track((await listen())!);
    listener.close();
    const before = timers();
    const waiting = listener.waitForCode("state-abc", 300_000);
    const ended = waiting.catch((error: unknown) => error); // subscribe first
    expect(timers()).toBe(before);
    expect(await ended).toBeInstanceOf(SignInCancelled);
  });

  // Task 7 swallows a shutdown cancel and lets a real failure reach the user, so
  // the two must not be the same class.
  it("keeps a timeout and a refusal apart from a cancellation", async () => {
    const listener = track((await listen())!);
    const timedOut = await listener.waitForCode("state-abc", 50).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(Error);
    expect(timedOut).not.toBeInstanceOf(SignInCancelled);

    const refused = listener.waitForCode("state-abc", 5_000).catch((error: unknown) => error); // subscribe first
    await get(`${listener.redirectUri}?error=access_denied&state=state-abc`);
    expect(await refused).toBeInstanceOf(Error);
    expect(await refused).not.toBeInstanceOf(SignInCancelled);
  });

  // Two waits on one listener would each answer the same request, and the second
  // writeHead throws ERR_HTTP_HEADERS_SENT, uncaught. So there is only ever one.
  it("refuses a second wait while one is pending, and the first still completes", async () => {
    const listener = track((await listen())!);
    const first = listener.waitForCode("state-abc", 5_000);
    const landed = expect(first).resolves.toBe("the-code"); // subscribe first
    const second = listener.waitForCode("state-abc", 300);
    const refused = expect(second).rejects.toThrow(/already waiting/);
    const res = await get(`${listener.redirectUri}?code=the-code&state=state-abc`);
    expect(res.status).toBe(200);
    await landed;
    await refused;
  });

  // Whatever ends a wait takes its request handler with it. Left behind, it would
  // answer a late callback with "Signed in" after the bridge has already given up.
  it("does not acknowledge a callback that arrives after the wait has ended", async () => {
    const listener = track((await listen())!);
    await expect(listener.waitForCode("state-abc", 50)).rejects.toThrow(/timed out/);
    const late = await get(`${listener.redirectUri}?code=late&state=state-abc`, {
      signal: AbortSignal.timeout(300),
    }).then((res) => `status:${res.status}`, () => "no answer");
    expect(late).not.toBe("status:200");
  });

  // The one slot has to free up however the last wait ended.
  it("takes a new wait once the last has ended, however it ended", async () => {
    const listener = track((await listen())!);

    const byCode = outcomeOf(listener.waitForCode("state-1", 5_000));
    await get(`${listener.redirectUri}?code=c1&state=state-1`);
    expect(await byCode).toBe("code:c1");

    const byRefusal = outcomeOf(listener.waitForCode("state-2", 5_000));
    await get(`${listener.redirectUri}?error=access_denied&state=state-2`);
    expect(await byRefusal).toBe("error:access_denied");

    expect(await outcomeOf(listener.waitForCode("state-3", 50))).toMatch(/^error:timed out/);

    const last = outcomeOf(listener.waitForCode("state-4", 5_000));
    await get(`${listener.redirectUri}?code=c4&state=state-4`);
    expect(await last).toBe("code:c4");
  });
});

describe("the sign-in page", () => {
  // Every title is a string literal today, so nothing sends a payload through the
  // title. An edit that put the provider's `error` there would be unguarded.
  it("escapes the title and the body alike", () => {
    const hostile = `<img src=x onerror="alert('a&b')">`;
    const escaped = "&lt;img src=x onerror=&quot;alert(&#39;a&amp;b&#39;)&quot;&gt;";
    const html = page(hostile, hostile);
    expect(html).not.toContain("<img");
    expect(html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1]).toBe(escaped); // the title
    expect(html.match(/<p>(.*?)<\/p>/)?.[1]).toBe(escaped); // the body
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

  afterEach(() => { vi.unstubAllEnvs(); });

  // The URL reaches openBrowser from the SDK's redirectToAuthorization, built from
  // authorization_endpoint in the SERVER's own discovery document, so the server
  // picks the scheme. Every launcher runs whatever application is registered for
  // one: a file: URL, a protocol handler. A sign-in URL is always http(s).
  describe("refuses a URL that is not http or https", () => {
    beforeEach(() => {
      // A broken guard must never start a real process on the machine running the tests.
      vi.mocked(spawn).mockImplementation(() => { throw new Error("spawn was called for a non-web URL"); });
    });
    afterEach(async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation(actual.spawn); // back to the real spawn
    });

    it.each([
      "file:///System/Applications/Calculator.app",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "ms-msdt:/id PCWDiagnostic /skip force",
      "smb://attacker.example/share",
      "vscode://vscode.git/clone?url=https://attacker.example/x.git",
      "httpfoo://mcp.bellman.sh/authorize", // starts with "http" and is not http
    ])("%s, on every platform, and spawns nothing", (target) => {
      const refused = new URL(target);
      for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
        const logged: string[] = [];
        openBrowser(refused, (message) => logged.push(message), platform);
        // One line, and it carries the URL, so the user can see what was attempted.
        expect(logged, platform).toEqual([expect.stringContaining(refused.toString())]);
        expect(logged[0], platform).toMatch(/refus/i);
      }
      expect(spawn, "no child process may exist").not.toHaveBeenCalled();
    });
  });

  it("still opens an http URL, for a local development server", () => {
    fakeChild();
    openBrowser(new URL("http://127.0.0.1:3900/authorize"), () => {}, "linux");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
    ["freebsd", "xdg-open"],
  ] as const)("opens the URL on %s with %s", (platform, command) => {
    fakeChild();
    openBrowser(url, () => {}, platform);
    expect(spawn).toHaveBeenCalledWith(command, [url.toString()], { stdio: "ignore", detached: true });
  });

  // UNVERIFIED on Windows: nobody has run this there. What can be held from here
  // is the argv, and the argv is the point: no shell may parse the URL. cmd /c
  // start split an authorization URL at its first "&" and ran the rest.
  describe("on Windows", () => {
    const rundll32 = (root: string) => `${root}\\System32\\rundll32.exe`;

    it("hands the URL to rundll32 as one argument, with no shell to parse it", () => {
      vi.stubEnv("SystemRoot", "C:\\Windows");
      const child = fakeChild();
      const hostile = new URL("https://as.example/authorize?client_id=c&calc.exe&state=s");
      const logged: string[] = [];
      openBrowser(hostile, (message) => logged.push(message), "win32");
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        rundll32("C:\\Windows"),
        ["url.dll,FileProtocolHandler", hostile.toString()],
        { stdio: "ignore", detached: true },
      );
      // rundll32 reports no failure, so the URL is in the line for a browser that never opens.
      child.emit("spawn");
      expect(logged).toEqual([`opened a browser to sign in: ${hostile}`]);
    });

    // A bare name is looked up in the current directory first, so the path is
    // always absolute, from SystemRoot when that is a usable one.
    it.each([
      ["D:\\Windows", "D:\\Windows"], // Windows installed somewhere else
      [undefined, "C:\\Windows"], // not set
      ["", "C:\\Windows"],
      ["Windows", "C:\\Windows"], // relative: would resolve against the current directory
    ])("resolves rundll32 from a SystemRoot of %j to an absolute path", (systemRoot, expected) => {
      vi.stubEnv("SystemRoot", systemRoot);
      fakeChild();
      openBrowser(url, () => {}, "win32");
      expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(rundll32(expected));
    });
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

describe("connectSignedIn", () => {
  let dir: string;
  let logs: string[];
  const fastLock = { waitMs: 5_000, heartbeatMs: 20, staleMs: 1_000 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bellman-signin-"));
    logs = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /**
   * A sign-in against `bellman`, recording every URL the browser was asked to
   * open. `extra` is whatever the test varies — usually fetchImpl, to stand a
   * second bridge or a hostile server in the way.
   */
  function connect(bellman: FakeBellman, browserCalls: URL[], extra: Partial<SignInOptions> = {}) {
    return connectSignedIn({
      serverUrl: RESOURCE,
      configDir: dir,
      fetchImpl: bellman.fetch,
      ports: TEST_PORTS,
      lock: fastLock,
      callbackTimeoutMs: 5_000,
      log: (message) => logs.push(message),
      browser: async (url) => { browserCalls.push(url); await bellman.browser(url); },
      ...extra,
    });
  }

  /** Stands a second bridge that writes `tokens` the moment our refresh goes out. */
  function racingBridge(bellman: FakeBellman, cred: ReturnType<typeof readServer>, tokens: NonNullable<ReturnType<typeof readServer>["tokens"]>): typeof fetch {
    let landed = false;
    return async (input, init) => {
      if (!landed && String(init?.body ?? "").includes("grant_type=refresh_token")) {
        landed = true; // only the first attempt races; the adopted one must go through
        writeServer(dir, RESOURCE, { ...cred, tokens });
      }
      return bellman.fetch(input, init);
    };
  }

  it("registers, signs in, and caches tokens and identity", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    const remote = await connect(bellman, calls);

    expect(calls).toHaveLength(1);
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();

    const cred = readServer(dir, RESOURCE);
    expect(cred.client?.client_id).toBeTruthy();
    expect(cred.tokens?.access_token).toBeTruthy();
    expect(cred.tokens?.refresh_token).toBeTruthy();
    expect(cred.tokens?.expires_at).toBeGreaterThan(Date.now());
    expect(cred.identity?.label).toBe("jesse@example.dev");
  });

  it("registers exactly one client and reuses it on the next run", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(bellman.registrations).toHaveLength(1);

    // Drop only the tokens; the client_id must survive and be reused.
    const cred = readServer(dir, RESOURCE);
    writeServer(dir, RESOURCE, { client: cred.client });
    await (await connect(bellman, calls)).close();
    expect(bellman.registrations).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("registers the whole loopback range so any port can be used later", async () => {
    const bellman = fakeBellman();
    await (await connect(bellman, [])).close();
    const body = bellman.registrations[0] as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual(TEST_PORTS.map((p) => `http://127.0.0.1:${p}/callback`));
  });

  it("reuses a cached token without opening a browser", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1);
    const first = readServer(dir, RESOURCE);

    const remote = await connect(bellman, calls);
    expect(calls).toHaveLength(1); // still one
    // The absence above needs a positive beside it, or it is satisfied by a
    // connect that did nothing: the reused credential has to actually work.
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();
    // And the file is still the credential it reused, not a rewritten husk.
    const second = readServer(dir, RESOURCE);
    expect(second.client?.client_id).toBe(first.client?.client_id);
    expect(second.tokens?.access_token).toBe(first.tokens?.access_token);
  });

  it("refreshes an expired access token without opening a browser", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    const before = cred.tokens!.access_token;
    writeServer(dir, RESOURCE, {
      ...cred,
      tokens: { ...cred.tokens!, access_token: STALE, expires_at: Date.now() - 1 },
    });

    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1); // no second browser
    expect(readServer(dir, RESOURCE).tokens?.access_token).not.toBe(before);
  });

  /**
   * NOTE: this passes by a path the plan describes wrongly. The plan has the SDK
   * re-throwing invalid_grant to us; in SDK 1.30 `auth()` catches it itself,
   * calls invalidateCredentials("tokens"), and retries — which reaches us as an
   * ordinary UnauthorizedError with an authorization URL to open. The outer
   * invalid_grant branch is the backstop for the SECOND one, tested below.
   */
  it("re-runs the browser flow when the refresh token is rejected", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    // A refresh token rotated away by another process, or revoked.
    writeServer(dir, RESOURCE, {
      ...cred,
      tokens: { access_token: STALE, refresh_token: "dead", expires_at: Date.now() - 1 },
    });

    const remote = await connect(bellman, calls);
    expect(calls).toHaveLength(2); // invalid_grant became a browser tab, not an error
    await remote.close();
    expect(readServer(dir, RESOURCE).tokens?.refresh_token).not.toBe("dead");
    // Escalating from the cached path to the browser must carry the client_id
    // it already had, or every rejected refresh registers a second client.
    expect(bellman.registrations).toHaveLength(1);
  });

  /**
   * Two tool calls can find the access token expired at the same moment. Their
   * persists must not interleave their read-modify-write: refresh tokens are
   * single use, so one of the two refreshes loses by design, and what matters
   * is that the file ends up holding the winner rather than a mixture.
   */
  it("serializes two refreshes that land at the same moment", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();

    const { fetchImpl, expireOnce } = aging(bellman);
    const remote = await connect(bellman, calls, { fetchImpl });
    expireOnce();
    const results = await Promise.allSettled([remote.listTools(), remote.listTools()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await remote.close();

    // Whatever happened, the file holds one coherent credential — and it works.
    const after = readServer(dir, RESOURCE);
    expect(after.tokens?.access_token).toBeTruthy();
    expect(after.tokens?.refresh_token).toBeTruthy();
    const again = await connect(bellman, calls);
    expect((await again.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await again.close();
    expect(calls).toHaveLength(1); // no browser anywhere in that
  });

  /**
   * "another Bellman sign-in is holding the lock, delete the file if nothing
   * is" was true in every word and wrong in its conclusion: the lock is held
   * legitimately, by a bridge mid-sign-in, and someone who follows that advice
   * breaks it. The reason we are here is that the saved credential needs a
   * browser, so that has to be the part they read first.
   */
  it("says the sign-in needs a browser when the lock is held, not just that the lock is held", async () => {
    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    try {
      await expect(
        connect(fakeBellman(), [], { lock: { heartbeatMs: 20, waitMs: 100 } })
      ).rejects.toThrow(/needs a browser/i);
    } finally {
      holder.release();
    }
  });

  it("gives up cleanly when every loopback port is busy and there is no token", async () => {
    for (const port of TEST_PORTS) await block(port);
    await expect(connect(fakeBellman(), [])).rejects.toThrow(/loopback port/i);
  });

  it("uses the cached token when every loopback port is busy", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();

    // A busy port must not block someone who already has a working token.
    for (const port of TEST_PORTS) await block(port);
    const remote = await connect(bellman, calls);
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    expect(calls).toHaveLength(1); // no browser, no listener
    await remote.close();
  });

  /**
   * The fast path hands over a token our own clock still likes. If the server
   * refuses it anyway — revoked, or signed with a key since rotated — failing
   * here would strand the user with a file they would have to find and delete.
   */
  it("signs in again when a cached token that has not expired is refused", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    writeServer(dir, RESOURCE, {
      ...cred,
      tokens: { ...cred.tokens!, access_token: STALE, expires_at: Date.now() + 600_000 },
    });

    const remote = await connect(bellman, calls);
    expect(calls).toHaveLength(1); // the refresh token was still good: no tab
    await remote.close();
    expect(readServer(dir, RESOURCE).tokens?.access_token).not.toBe(STALE);
  });

  it("surfaces an unreachable server rather than hanging", async () => {
    const dead: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(
      connect(fakeBellman(), [], {
        fetchImpl: dead,
        callbackTimeoutMs: 1_000,
        browser: () => { throw new Error("should never reach a browser"); },
      })
      // Named, not a bare rejects.toThrow(): the guard browser above throws too,
      // so an unqualified assertion passes on the wrong error entirely.
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  // ------------------------------------------------------------------ R4
  /**
   * A request arriving when no waitForCode is registered gets no response at
   * all and hangs the connection open, so the listener must go as soon as the
   * wait settles rather than at some later teardown.
   */
  // "the port is free once connectSignedIn returned" used to live here. It could
  // not fail: the closing finally at the end of connectSignedIn satisfies it
  // whether or not the prompt close exists, so it was a green light wired to
  // nothing. The test below watches the port from inside the code exchange,
  // which is the first thing after the wait settles, and fails both ways — if
  // the listener is still bound, and if the exchange never happened at all.

  /**
   * Closing at the END of connectSignedIn is not the same thing: finishAuth and
   * the reconnect sit in between, and the browser sends its favicon request the
   * moment the callback page renders. This widens that window by watching the
   * port from inside the code exchange, which is the first thing after the wait.
   */
  it("stops listening when the wait settles, not when the connect finishes", async () => {
    const bellman = fakeBellman();
    const isFree = (port: number) =>
      new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });

    let freeDuringExchange: boolean | undefined;
    const watched: typeof fetch = async (input, init) => {
      if (freeDuringExchange === undefined && String(init?.body ?? "").includes("grant_type=authorization_code")) {
        freeDuringExchange = await isFree(TEST_PORTS[0]);
      }
      return bellman.fetch(input, init);
    };

    await (await connect(bellman, [], { fetchImpl: watched })).close();
    expect(freeDuringExchange).toBe(true);
  });

  it("stops listening when the sign-in fails", async () => {
    const bellman = fakeBellman();
    await expect(
      connect(bellman, [], { browser: () => { throw new Error("the browser blew up"); } })
    ).rejects.toThrow(/blew up/);
    await expect(block(TEST_PORTS[0])).resolves.toBeUndefined();
  });

  // ------------------------------------------------------------------ R1
  /**
   * channel.ts's shutdown() awaits bridge.close(), which awaits the pending
   * remote. If that remote is blocked on a browser callback for 300s, SIGTERM
   * never reaches process.exit, Claude Code force-terminates, and the credential
   * lock leaks — the very case the lock's exit handler exists to cover.
   */
  it("ends the wait when the sign-in is aborted, instead of holding the bridge open", async () => {
    const controller = new AbortController();
    const pending = connect(fakeBellman(), [], {
      signal: controller.signal,
      // Far past the suite's own timeout: only the abort can end this.
      callbackTimeoutMs: 600_000,
      browser: () => { setTimeout(() => controller.abort(), 10); },
    });
    await expect(pending).rejects.toThrow(SignInCancelled);
  });

  it("releases the credential lock when the sign-in is aborted", async () => {
    const controller = new AbortController();
    const bellman = fakeBellman();
    await expect(
      connect(bellman, [], {
        signal: controller.signal,
        callbackTimeoutMs: 600_000,
        browser: () => { setTimeout(() => controller.abort(), 10); },
      })
    ).rejects.toThrow(SignInCancelled);

    // The next sign-in must not wait on a lock nobody holds.
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(1);
  });

  /**
   * And before reaching the server at all. A later check would also refuse to
   * open a browser, so counting browser calls cannot tell the two apart; the
   * one observable difference is whether a request was ever sent.
   */
  it("never binds a port, reaches the server, or opens a browser when the signal is already aborted", async () => {
    const calls: URL[] = [];
    const bellman = fakeBellman();
    let requests = 0;
    const counted: typeof fetch = (input, init) => { requests += 1; return bellman.fetch(input, init); };

    await expect(
      connect(bellman, calls, { signal: AbortSignal.abort(), fetchImpl: counted })
    ).rejects.toThrow(SignInCancelled);
    expect(requests).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(block(TEST_PORTS[0])).resolves.toBeUndefined();
  });

  /**
   * R1 one layer down. The default lock wait is six minutes, so a shutdown that
   * arrives while another bridge holds the lock would sit here long past the
   * point Claude Code force-terminates us — which leaks the very lock the exit
   * handler exists to clean up.
   */
  it("gives up waiting for the credential lock when the sign-in is aborted", async () => {
    const holder = await acquireLock(dir, { heartbeatMs: 20 });
    expect(holder).toBeDefined();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      await expect(
        connect(fakeBellman(), [], {
          signal: controller.signal,
          lock: { heartbeatMs: 20 }, // the real six-minute wait
        })
      ).rejects.toThrow(SignInCancelled);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      holder!.release();
    }
  });

  /**
   * And the fast path, which has no listener to close. The SDK overwrites
   * requestInit.signal with its own controller's on every send, so the abort has
   * to reach the transport instead.
   */
  it("ends the cached-token connect when the sign-in is aborted", async () => {
    const bellman = fakeBellman();
    await (await connect(bellman, [])).close();

    const controller = new AbortController();
    // A server that never answers: only the abort can end this.
    const stalled: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (String(input).includes("/.well-known/")) resolve(bellman.fetch(input, init));
      });

    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(
      connect(bellman, [], { signal: controller.signal, fetchImpl: stalled })
    ).rejects.toThrow(SignInCancelled);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  /**
   * The seam between two fixes that are each correct on their own. Persist is
   * deliberately signal-less, so a shutdown cannot cost a refresh its rotation.
   * Arming it up front in the !lock branch was also right — there is no lock of
   * our own to deadlock against. Together they put a signal-less wait INSIDE
   * connectSignedIn, in the one branch that exists because another bridge is
   * holding the lock, most likely for a browser flow a human has not finished.
   */
  it("gives up the write, not the process, when a shutdown lands in the no-lock branch", async () => {
    const bellman = fakeBellman();
    await (await connect(bellman, [])).close();
    const stored = readServer(dir, RESOURCE);
    // Stale, so the cached connect must refresh and therefore must write.
    writeServer(dir, RESOURCE, {
      ...stored,
      tokens: { ...stored.tokens!, access_token: STALE, expires_at: Date.now() - 1 },
    });

    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    try {
      const controller = new AbortController();
      const waitMs = 1_500;
      // After the main acquire has given up, so we reach the !lock branch, and
      // while the write that follows it is still contending for the lock.
      setTimeout(() => controller.abort(), waitMs + 150);
      const started = Date.now();
      await expect(
        connect(bellman, [], { signal: controller.signal, lock: { heartbeatMs: 20, waitMs } })
      ).rejects.toThrow(SignInCancelled);
      const elapsed = Date.now() - started;

      // Settled promptly after the abort. A signal-less wait here would have
      // run the full waitMs past it, on top of the wait already survived.
      expect(elapsed).toBeLessThan(waitMs + 1_000);
    } finally {
      holder.release();
    }
  });

  /**
   * The no-lock branch exists to say "someone else is busy, do not make this
   * user wait". Writing unconditionally after the connect put the wait back: a
   * live cached token changes nothing, so the second lock wait was spent
   * rewriting bytes that were already on disk — and it is spent in the one
   * branch where the lock is known to be held.
   */
  it("does not wait for the lock again to rewrite a credential nothing changed", async () => {
    const bellman = fakeBellman();
    await (await connect(bellman, [])).close(); // a live token, nothing to refresh

    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    try {
      const waitMs = 2_000;
      const started = Date.now();
      const remote = await connect(bellman, [], { lock: { heartbeatMs: 20, waitMs } });
      const elapsed = Date.now() - started;

      expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
      await remote.close();
      // One failed lock wait is the price of this branch. A second is not.
      expect(elapsed).toBeLessThan(waitMs + 1_000);
    } finally {
      holder.release();
    }
  });

  /**
   * And the write a live session's refresh makes is awaited by the tool call
   * that triggered it — saveTokens -> set -> persist -> auth() -> transport ->
   * callTool. Signal-less is right, because a shutdown must not cost the
   * rotation; signal-less AND unbounded is an un-abortable stall of up to
   * WAIT_MS on the call path.
   */
  it("does not stall a tool call waiting for the credential lock", async () => {
    const bellman = fakeBellman();
    const { fetchImpl, expireOnce } = aging(bellman);
    await (await connect(bellman, [])).close();
    const remote = await connect(bellman, [], { fetchImpl, lock: { heartbeatMs: 20, waitMs: 10_000 } });

    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    try {
      expireOnce();
      const started = Date.now();
      expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
      // Bounded by the write's own budget, not by the sign-in's lock wait.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logs.join("\n")).toContain("stays in memory for this session");
    } finally {
      holder.release();
      await remote.close();
    }
  });

  // ------------------------------------------------------------------ R2
  /**
   * Access tokens live 10 minutes and every bridge shares one credential file,
   * so N windows contend the refresh every ~10 minutes, not just at startup. A
   * bridge that lost the race must pick up what the winner wrote, not open a tab.
   */
  it("adopts a refresh token another bridge wrote, rather than opening a browser", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);

    // A second bridge refreshes first. That SPENDS our stored token — they
    // rotate on use — and `fresh` is what it would write to the shared file.
    const fresh = await bellman.refresh(cred.tokens!.refresh_token!, cred.client!.client_id);
    writeServer(dir, RESOURCE, {
      ...cred,
      tokens: { ...cred.tokens!, access_token: STALE, expires_at: Date.now() - 1 },
    });

    const remote = await connect(bellman, calls, {
      fetchImpl: racingBridge(bellman, cred, {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expires_at: Date.now() + fresh.expires_in * 1000,
      }),
    });

    expect(calls).toHaveLength(1); // no spare tab, ten minutes after the first
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();
  });

  /** The backstop: what the other bridge wrote was dead too, so a tab after all. */
  it("falls back to the browser when the token another bridge wrote is also rejected", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    const cred = readServer(dir, RESOURCE);
    const dead = { access_token: STALE, expires_at: Date.now() - 1 };
    writeServer(dir, RESOURCE, { ...cred, tokens: { ...dead, refresh_token: "dead" } });

    const remote = await connect(bellman, calls, {
      fetchImpl: racingBridge(bellman, cred, { ...dead, refresh_token: "also-dead" }),
    });

    expect(calls).toHaveLength(2);
    await remote.close();
    const after = readServer(dir, RESOURCE).tokens?.refresh_token;
    expect(after).not.toBe("dead");
    expect(after).not.toBe("also-dead");
  });

  // ---------------------------------------------- refreshes after the connect
  /**
   * The provider outlives connectSignedIn — the Remote holds the transport,
   * which holds the provider — and access tokens live ten minutes, so any
   * session longer than that refreshes. Every refresh rotates the refresh token
   * server-side, so a rotation that is not written leaves the file holding a
   * token the server has already deleted, and the NEXT start opens a browser.
   */
  function aging(bellman: FakeBellman) {
    let armed = false;
    // The 401 a ten-minute-old access token gets, from the real server rather
    // than faked, by dropping the header it would have rejected anyway.
    const fetchImpl = (async (input, init) => {
      const isRpc = String(input).endsWith("/mcp") && init?.method === "POST";
      if (!isRpc || !armed) return bellman.fetch(input, init);
      // Exactly one request, then disarm. The SDK retries the same message
      // after refreshing, and a second 401 on that retry trips its
      // _hasCompletedAuthFlow guard — "401 after successful authentication" —
      // which is a real protection, not something to route around.
      armed = false;
      const headers = new Headers(init?.headers as HeadersInit);
      headers.delete("authorization");
      return bellman.fetch(input, { ...init, headers });
    }) as typeof fetch;
    return { fetchImpl, expireOnce: () => { armed = true; } };
  }

  /**
   * On the CACHED path specifically — the one every window takes, and the one
   * that reached this test suite only through signIn before. Without an auth
   * provider the transport's 401 handler is skipped entirely (it is guarded on
   * this._authProvider), so a token expiring ten minutes in was a bare
   * StreamableHTTPError and the session was over. That capped almost every
   * session at one access-token lifetime.
   */
  it("refreshes mid-session on the cached-token path, and persists it", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close(); // sign in once, to fill the file
    expect(calls).toHaveLength(1);

    const { fetchImpl, expireOnce } = aging(bellman);
    const remote = await connect(bellman, calls, { fetchImpl }); // cached: no listener, no browser
    expect(calls).toHaveLength(1);
    const before = readServer(dir, RESOURCE).tokens!;

    expireOnce();
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();

    const after = readServer(dir, RESOURCE).tokens!;
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(after.access_token).not.toBe(before.access_token);
    expect(calls).toHaveLength(1); // it refreshed; it did not reach for a human
  });

  /**
   * A refresh can land while the bridge is shutting down, and the write must
   * still happen: losing it is the original bug, just in a narrower window —
   * and narrow is how that one hid. So persist takes no signal, unlike every
   * other wait in the module.
   */
  it("still writes a refresh that lands while the sign-in is shutting down", async () => {
    const bellman = fakeBellman();
    const controller = new AbortController();
    const { fetchImpl, expireOnce } = aging(bellman);
    await (await connect(bellman, [])).close();
    const remote = await connect(bellman, [], { fetchImpl, signal: controller.signal });
    const before = readServer(dir, RESOURCE).tokens!;

    // Hold the lock so the persist has to wait, then shut down while it waits.
    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    expireOnce();
    const call = remote.listTools().catch(() => undefined); // the retry may be cancelled; the write must not be
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    holder.release();
    await call;

    expect(readServer(dir, RESOURCE).tokens?.refresh_token).not.toBe(before.refresh_token);
  });

  /**
   * And when the lock genuinely cannot be had, persist degrades rather than
   * throws. This runs inside a live session's tool call, so throwing would end
   * the session over a write that costs one browser tab at the next start.
   */
  it("keeps the session alive when a refresh cannot reach the credential lock", async () => {
    const bellman = fakeBellman();
    const { fetchImpl, expireOnce } = aging(bellman);
    await (await connect(bellman, [])).close();
    const remote = await connect(bellman, [], { fetchImpl, lock: { ...fastLock, waitMs: 150 } });

    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    try {
      expireOnce();
      // The tool call still succeeds; only the write is given up on.
      expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
      expect(logs.join("\n")).toContain("stays in memory for this session");
    } finally {
      holder.release();
      await remote.close();
    }
  });

  /**
   * A credential file holding tokens but no client is reachable by hand-editing,
   * and the cached attempt then registers one before discovering the tokens are
   * dead. Escalating has to carry that registration forward.
   */
  it("does not register a second client when the cached attempt escalates", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(bellman.registrations).toHaveLength(1);

    // Tokens that cannot work, and no client at all.
    writeServer(dir, RESOURCE, {
      tokens: { access_token: STALE, refresh_token: "dead", expires_at: Date.now() - 1 },
    });
    await (await connect(bellman, calls)).close();

    expect(calls).toHaveLength(2); // it needed a human
    expect(bellman.registrations).toHaveLength(2); // one more, not two more
  });

  it("writes a refresh that happens after the connect to disk", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    const { fetchImpl, expireOnce } = aging(bellman);
    const remote = await connect(bellman, calls, { fetchImpl });

    const before = readServer(dir, RESOURCE).tokens!;
    expireOnce();
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("bellman_start");
    await remote.close();

    const after = readServer(dir, RESOURCE).tokens!;
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(after.access_token).not.toBe(before.access_token);
    expect(calls).toHaveLength(1); // no browser: it only refreshed
  });

  it("leaves the file holding the latest token after two rotations in one session", async () => {
    const bellman = fakeBellman();
    const { fetchImpl, expireOnce } = aging(bellman);
    const remote = await connect(bellman, [], { fetchImpl });
    const seen: string[] = [readServer(dir, RESOURCE).tokens!.refresh_token!];

    for (let i = 0; i < 2; i++) {
      expireOnce();
      await remote.listTools();
      seen.push(readServer(dir, RESOURCE).tokens!.refresh_token!);
    }
    await remote.close();

    expect(new Set(seen).size).toBe(3); // three distinct tokens, in order
    // And the last one still works: a fresh connect reuses it with no browser.
    const calls: URL[] = [];
    await (await connect(bellman, calls)).close();
    expect(calls).toHaveLength(0);
  });

  /**
   * The credential lock is not reentrant, so a persist that re-takes it while
   * connectSignedIn still holds it would stall for the whole waitMs and write
   * nothing. Arming only after release() is what prevents that; this fails with
   * a timeout rather than an assertion if it is ever armed too early.
   */
  it("does not deadlock on its own lock when the first connect refreshes", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    // A first connect whose token is stale: it refreshes DURING the connect,
    // with the lock held, and must not try to take it again.
    await (await connect(bellman, calls)).close();
    const stored = readServer(dir, RESOURCE);
    writeServer(dir, RESOURCE, {
      ...stored,
      tokens: { ...stored.tokens!, access_token: STALE, expires_at: Date.now() - 1 },
    });

    const remote = await connect(bellman, calls, { lock: { ...fastLock, waitMs: 2_000 } });
    expect(calls).toHaveLength(1);
    await remote.close();
    expect(readServer(dir, RESOURCE).tokens?.access_token).not.toBe(STALE);
  });

  /**
   * The backstop must not re-run the browser flow once the listener has been
   * waited on: it is closed by then, so a second pass cannot receive a callback
   * and the user would see "the sign-in listener is closed" in place of the
   * real failure. Task 3's closed-listener guard keeps it from hanging, which
   * is why this is defence in depth — but the message the user gets is the
   * difference between a diagnosis and a puzzle.
   */
  it("reports the real failure when the code exchange is rejected, not a closed listener", async () => {
    const bellman = fakeBellman();
    const refusing: typeof fetch = async (input, init) => {
      if (String(init?.body ?? "").includes("grant_type=authorization_code")) {
        return Response.json(
          { error: "invalid_grant", error_description: "authorization code is invalid, used, or expired" },
          { status: 400 }
        );
      }
      return bellman.fetch(input, init);
    };

    const failure = connect(bellman, [], { fetchImpl: refusing });
    await expect(failure).rejects.toThrow(/invalid_grant|code is invalid/i);
    await expect(failure).rejects.not.toThrow(/listener is closed/i);
  });

  /**
   * The last uninterruptible wait in the system, measured rather than reasoned
   * about. makePersist stays signal-less on purpose, so a refresh firing as the
   * bridge shuts down starts a lock wait nothing can cancel — and if another
   * bridge holds that lock for a browser flow, it is WAIT_MS behind a human.
   * The claim that it cannot delay the exit is the claim being checked here:
   * channel.ts ends at process.exit(), which does not wait for pending
   * promises, so the write is abandoned rather than the process detained.
   */
  it("a lock wait still pending does not hold up process.exit", async () => {
    const holder = (await acquireLock(dir, { heartbeatMs: 20 }))!;
    const script = join(dir, "exiter.mjs");
    writeFileSync(script, [
      `import { acquireLock } from ${JSON.stringify(new URL("../src/credentials.ts", import.meta.url).href)};`,
      // Never awaited, exactly as a persist in flight at shutdown is not.
      `void acquireLock(${JSON.stringify(dir)}, { waitMs: 30_000, heartbeatMs: 20 });`,
      `setTimeout(() => process.exit(0), 100);`,
    ].join("\n"));

    try {
      const started = Date.now();
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      const elapsed = Date.now() - started;
      expect(code).toBe(0);
      // Not the 30s the lock wait would have taken if it detained the process.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      holder.release();
    }
  });

  // ------------------------------------------------------------------ R5
  it("names who signed in", async () => {
    await (await connect(fakeBellman(), [])).close();
    expect(logs).toContain("signed in as jesse@example.dev (free plan)");
  });

  /**
   * decodeIdentity returns the token's `bellman` claim verbatim with no field
   * checks, so a malformed claim reaches the log exactly as minted. Branching on
   * the identity merely existing prints "signed in as undefined".
   */
  it("does not say 'signed in as undefined' when the claim carries no label", async () => {
    const bellman = fakeBellman({
      overrides: {
        "github:4242": { userId: "u_x", orgId: null, plan: "free", role: "member" } as unknown as Identity,
      },
    });
    await (await connect(bellman, [])).close();
    expect(logs.join("\n")).not.toContain("undefined");
    expect(logs).toContain("signed in");
  });

  // ------------------------------------------------------------------ R6
  /**
   * openBrowser refuses a non-http(s) URL but only logs, so without a check here
   * a hostile authorization_endpoint burns the whole callback timeout. The
   * timeout below is far past the suite's: a regression hangs rather than passes.
   */
  it("refuses an authorization URL that is not http or https, without waiting for it", async () => {
    const bellman = fakeBellman();
    const calls: URL[] = [];
    const hostile: typeof fetch = async (input, init) => {
      const response = await bellman.fetch(input, init);
      if (!String(input).includes("/.well-known/oauth-authorization-server")) return response;
      const doc = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...doc, authorization_endpoint: "file:///etc/passwd" });
    };

    await expect(
      connect(bellman, calls, { fetchImpl: hostile, callbackTimeoutMs: 600_000 })
    ).rejects.toThrow(/only http and https/i);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The claim the credential lock exists to serve: bridges that start together open
 * ONE browser and do ONE refresh.
 *
 * Each test balances a ledger of what a server was actually asked. A ledger holds
 * counts that must be present as well as counts that must not multiply, because
 * "no second browser" is satisfied for free by a bridge that never ran, and by a
 * fixture in which the thing being raced never happens.
 *
 * Every sign-in is slowed to the pace of what it really waits on: the browser to a
 * person's, the refresh to a network's. The lock's whole job is to span that wait,
 * and a lock that lapsed early is only caught by a rival that arrives inside it.
 * Rivals poll for the lock every 100ms and an unslowed sign-in here takes about as
 * long, so a lock released after its first read passed every test in this describe,
 * five runs in five, with the slowdown taken out.
 */
describe("concurrent bridges", () => {
  let dir: string;
  /**
   * A live holder beats every 20ms and holds the lock for well under a second; a rival
   * reclaims it only after staleMs without a beat. It is long so that a stalled machine
   * cannot make a correct bridge look dead and open a second browser, and since nothing
   * here waits on a lock that is actually dead, the length costs nothing.
   */
  const fastLock = { waitMs: 8_000, heartbeatMs: 20, staleMs: 5_000 };
  /** How long a person takes over the sign-in page, and a token endpoint over a refresh. */
  const SLOW_MS = 300;
  const DEV_URL = "https://dev.example.test/mcp";
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bellman-concurrent-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** One server, watched from the client's side of the wire. */
  interface Site {
    name: string;
    url: string;
    bellman: FakeBellman;
    fetchImpl: typeof fetch;
    /** Every URL a browser was asked to open for this server. */
    browsers: URL[];
    /** `grant:status` for each request to /token, in the order it arrived. */
    grants: string[];
    /** Requests to /mcp that carried a token the server turned away. */
    refused: number;
    /** Registrations that predate this watch, so a second phase counts only its own. */
    registeredBefore: number;
  }

  function watch(
    name: string,
    bellman: FakeBellman,
    { url = RESOURCE, tokenMs = 0 }: { url?: string; tokenMs?: number } = {},
  ): Site {
    const site: Site = {
      name, url, bellman, browsers: [], grants: [], refused: 0,
      registeredBefore: bellman.registrations.length,
      fetchImpl: async (input, init) => {
        const { pathname } = new URL(String(input));
        const token = pathname === "/token" && init?.method === "POST";
        if (token && tokenMs) await pause(tokenMs); // a refresh takes a network's time
        const response = await bellman.fetch(input, init);
        if (token) {
          site.grants.push(`${new URLSearchParams(String(init?.body)).get("grant_type")}:${response.status}`);
        }
        if (pathname === "/mcp" && response.status === 401 && new Headers(init?.headers).has("authorization")) {
          site.refused += 1;
        }
        return response;
      },
    };
    return site;
  }

  /** A bridge signing in to `site`, with a person at the browser. */
  function connect(site: Site, extra: Partial<SignInOptions> = {}): Promise<Remote> {
    return connectSignedIn({
      serverUrl: site.url,
      configDir: dir,
      fetchImpl: site.fetchImpl,
      ports: TEST_PORTS,
      lock: fastLock,
      callbackTimeoutMs: 8_000,
      browser: async (url) => {
        site.browsers.push(url);
        await pause(SLOW_MS);
        await site.bellman.browser(url);
      },
      ...extra,
    });
  }

  /**
   * Every connect runs to its end, pass or fail. A Promise.all that rejected on the
   * first failure would leave the others running into the next test, holding its
   * ports, and a failure would then read as a run of unrelated ones.
   */
  async function all(connects: Promise<Remote>[]): Promise<Remote[]> {
    const settled = await Promise.allSettled(connects);
    const remotes = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    if (failures.length > 0) await Promise.all(remotes.map((remote) => remote.close()));
    expect(failures).toEqual([]);
    return remotes;
  }

  /** What a server was asked. Each count is of something that must not multiply when bridges race. */
  const ledger = (site: Site) => ({
    browsers: site.browsers.length,
    registrations: site.bellman.registrations.length - site.registeredBefore,
    grants: site.grants,
    refused: site.refused,
  });

  /** A remote that is really connected and authorized, not merely one that came back. */
  const toolsOf = async (remote: Remote) => (await remote.listTools()).tools.map((t) => t.name);

  it("opens ONE browser for three simultaneous first runs", async () => {
    const site = watch("bellman", fakeBellman());
    const remotes = await all([connect(site), connect(site), connect(site)]);
    try {
      // One sign-in, in full — a browser, a registration, a code exchange — and
      // nothing after it: the two rivals came in on the winner's token, so nobody
      // refreshed, and the server turned no token away.
      expect(ledger(site)).toEqual({
        browsers: 1,
        registrations: 1,
        grants: ["authorization_code:200"],
        refused: 0,
      });
      // And all three ended up with a bridge that works.
      for (const remote of remotes) expect(await toolsOf(remote)).toContain("bellman_start");
    } finally {
      for (const remote of remotes) await remote.close();
    }
  });

  it("refreshes once when three bridges wake to an expired token", async () => {
    const bellman = fakeBellman();
    await (await connect(watch("first", bellman))).close(); // sign in once, to have a credential to age
    const seeded = readServer(dir, RESOURCE);
    // Expired from both ends of the wire: our clock says so, and the server no
    // longer accepts the access token (see STALE). The refresh token is still good.
    writeServer(dir, RESOURCE, {
      ...seeded,
      tokens: { ...seeded.tokens!, access_token: STALE, expires_at: Date.now() - 1 },
    });

    const site = watch("bellman", bellman, { tokenMs: SLOW_MS });
    const remotes = await all([connect(site), connect(site), connect(site)]);
    try {
      // One refresh, and it worked. The only token the server ever turned away is
      // the stale one, once: the two rivals neither spent the refresh token the
      // winner had already rotated nor showed the dead access token again, because
      // they came in on the winner's. No browser and no registration either.
      expect(ledger(site)).toEqual({
        browsers: 0,
        registrations: 0,
        grants: ["refresh_token:200"],
        refused: 1,
      });
      for (const remote of remotes) expect(await toolsOf(remote)).toContain("bellman_start");
    } finally {
      for (const remote of remotes) await remote.close();
    }
  });

  // Review Focus 5 — one lock, two server keys.
  it("a second server URL waits for the lock, then signs in on its own key", async () => {
    const prod = watch("prod", fakeBellman());
    // A genuinely separate origin, not a URL rewrite: the access token carries a
    // resource indicator derived from the server URL, and /authorize refuses any
    // resource that is not its own.
    const dev = watch("dev", fakeBellman({ origin: "https://dev.example.test" }), { url: DEV_URL });

    // How many of the two were on the wire at once, from a bridge's first request
    // until its connect returned. A bridge waiting for the lock sends nothing.
    const live = new Set<string>();
    let peak = 0;
    for (const site of [prod, dev]) {
      const inner = site.fetchImpl;
      site.fetchImpl = (input, init) => {
        live.add(site.name);
        peak = Math.max(peak, live.size);
        return inner(input, init);
      };
    }
    const remotes = await all([prod, dev].map(async (site) => {
      const remote = await connect(site);
      live.delete(site.name);
      return remote;
    }));
    try {
      // They took turns: at most one on the wire at a time, and one was. This is
      // read first, before the checks below put both back on the wire.
      expect(peak).toBe(1);
      // Two servers means two full sign-ins, each on its own server. The lock
      // serializes them; it does not let the second mistake the first's tokens for
      // its own, which the server would show as a token it turned away.
      const signedInOnce = { browsers: 1, registrations: 1, grants: ["authorization_code:200"], refused: 0 };
      expect({ prod: ledger(prod), dev: ledger(dev) }).toEqual({ prod: signedInOnce, dev: signedInOnce });
      // One file, two credentials, neither written over the other.
      const prodToken = readServer(dir, RESOURCE).tokens?.access_token;
      const devToken = readServer(dir, DEV_URL).tokens?.access_token;
      expect(prodToken).toBeTruthy();
      expect(devToken).toBeTruthy();
      expect(devToken).not.toBe(prodToken);
      for (const remote of remotes) expect(await toolsOf(remote)).toContain("bellman_start");
    } finally {
      for (const remote of remotes) await remote.close();
    }
  });

  // The branch the tests above never reach: the cached attempt finds the refresh token
  // dead and has to hand the sign-in to a browser. Under concurrency that has to happen
  // once, and it has to keep the client the credential already holds.
  it("opens ONE browser, and registers nothing new, when three bridges wake to a dead refresh token", async () => {
    const bellman = fakeBellman();
    await (await connect(watch("first", bellman))).close(); // sign in once, to have a client and a credential
    const seeded = readServer(dir, RESOURCE);
    // A refresh token the server no longer knows: rotated away by another window, or
    // revoked. The access token is refused too (see STALE), so the cached attempt has to
    // spend the refresh token, be told no, and escalate.
    writeServer(dir, RESOURCE, {
      ...seeded,
      tokens: { access_token: STALE, refresh_token: "dead", expires_at: Date.now() - 1 },
    });

    const site = watch("bellman", bellman);
    const remotes = await all([connect(site), connect(site), connect(site)]);
    try {
      // The winner spends the dead token once, is refused, and signs in properly on the
      // client it already had, so nothing new is registered. The two rivals came in on
      // the winner's tokens: neither spent the dead one again nor opened a browser.
      expect(ledger(site)).toEqual({
        browsers: 1,
        registrations: 0,
        grants: ["refresh_token:400", "authorization_code:200"],
        refused: 1,
      });
      for (const remote of remotes) expect(await toolsOf(remote)).toContain("bellman_start");
    } finally {
      for (const remote of remotes) await remote.close();
    }
  });
});
