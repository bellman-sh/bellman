import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, win32 } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Remote } from "./bridge.js";
import {
  acquireLock, credentialsDir, decodeIdentity, LOCK_FILE, readServer, writeServer,
  type LockOptions, type ServerCredential,
} from "./credentials.js";

/**
 * The browser half of self-serve credentials: a loopback listener for the
 * authorization callback, and the platform incantation for opening a browser.
 */

/**
 * A FIXED range, not an ephemeral port. Bellman's /authorize requires an exact
 * match against a registered redirect_uri, so a port that changed between runs
 * would break every re-authentication. Five is enough: concurrent bridges
 * serialize on the credential lock, so a busy port means some other
 * application, not another bridge.
 */
export const CALLBACK_PORTS = [51004, 51005, 51006, 51007, 51008];

export function loopbackRedirects(ports: number[] = CALLBACK_PORTS): string[] {
  return ports.map((port) => `http://127.0.0.1:${port}/callback`);
}

/**
 * A wait that ended because the listener was closed, not because the sign-in
 * failed. A caller that is shutting down closes the listener and ignores this; a
 * refusal or a timeout is a plain Error and must still reach the user. A class
 * rather than a message to match: instanceof survives a rewording.
 */
export class SignInCancelled extends Error {
  constructor(message = "the sign-in was cancelled") {
    super(message);
    this.name = "SignInCancelled";
  }
}

export interface Listener {
  redirectUri: string;
  /**
   * One wait at a time. Resolves with the authorization code; rejects with a plain
   * Error on a refusal or a timeout, and with SignInCancelled if the listener is
   * closed first.
   */
  waitForCode(state: string, timeoutMs: number): Promise<string>;
  /**
   * Stops listening and ends a pending wait with SignInCancelled. Safe to call
   * twice. The wait's promise rejects, so whoever holds it must already have a
   * handler on it (an await, a .catch): closing while a wait exists that nobody is
   * handling yet is an unhandled rejection, which ends a Node process by default.
   * Attach the handler first, then close.
   */
  close(): void;
}

function bind(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    const fail = () => { server.removeAllListeners(); server.close(); resolve(undefined); };
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", fail);
      resolve(server);
    });
  });
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ENTITIES[char]!);

/**
 * Both arguments are text: one of them can be the authorization server's error
 * message. Exported so a test can put a payload in the title too, where only
 * string literals go today.
 */
export const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Bellman</title>` +
  `<body style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.25rem">` +
  `<h1 style="font-size:1.35rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;

/**
 * Bind the first free port, ascending. Undefined when every one is taken. `log`
 * is required, not defaulted: it is where a listener in trouble says so.
 */
export async function listenForCallback(
  ports: number[] = CALLBACK_PORTS,
  log: (message: string) => void,
): Promise<Listener | undefined> {
  for (const port of ports) {
    const server = await bind(port);
    if (server) return makeListener(server, `http://127.0.0.1:${port}/callback`, log);
  }
  return undefined;
}

function makeListener(server: Server, redirectUri: string, log: (message: string) => void): Listener {
  const path = new URL(redirectUri).pathname;
  let closed = false;
  /** Ends the wait in progress with SignInCancelled. Set for exactly as long as there is one. */
  let cancelPending: (() => void) | undefined;
  /**
   * An accept error after a successful bind (EMFILE, say) is an 'error' event on
   * the server, and an 'error' event nobody listens for is an uncaught exception
   * that ends the bridge. It is logged, not swallowed: a listener that has quietly
   * stopped taking connections would otherwise look like a sign-in that never
   * finishes.
   */
  server.on("error", (error) => log(`the sign-in listener at ${redirectUri} reported an error: ${error.message}`));
  return {
    redirectUri,
    waitForCode(state, timeoutMs) {
      // Fail closed. An empty state matches "state=", so waiting on one would
      // accept a callback from anyone who sends that; a caller that has no state
      // to check against has a bug, and it should be loud.
      if (!state) {
        return Promise.reject(new Error("waitForCode needs a non-empty state to check the callback against"));
      }
      // Nothing will ever arrive on a closed listener, and a timer started here
      // would hold the event loop open for the whole wait, for nothing.
      if (closed) return Promise.reject(new SignInCancelled("the sign-in listener is closed"));
      // One wait at a time. Two would each answer the same request; the second
      // writeHead throws ERR_HTTP_HEADERS_SENT, uncaught, and it ends the bridge.
      if (cancelPending) return Promise.reject(new Error("waitForCode is already waiting on this listener"));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => settle(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the sign-in to finish`))),
          timeoutMs,
        );

        // However the wait ends, its timer, its request handler and its slot go.
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          server.removeListener("request", onRequest);
          cancelPending = undefined;
          fn();
        };
        cancelPending = () => settle(() => reject(new SignInCancelled("the sign-in listener was closed while waiting")));

        function onRequest(req: IncomingMessage, res: ServerResponse): void {
          /**
           * Every response goes through here. The page a successful sign-in ends on
           * has the authorization code in its own URL, so none of it is cached and
           * none of it is handed on in a Referer.
           */
          const reply = (status: number, markup?: string) =>
            res.writeHead(status, {
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              ...(markup === undefined ? {} : { "content-type": "text/html; charset=utf-8" }),
            }).end(markup);
          const html = (status: number, title: string, body: string) => reply(status, page(title, body));

          /**
           * req.url is whatever a stranger sent. "//host:99999999/x" is a valid
           * request target that URL reads as a scheme-relative reference with an
           * impossible port, and throws; an exception out of this handler is
           * uncaught, and it ends the bridge. Like a mismatched state, it must
           * not settle the wait either.
           */
          let url: URL;
          try {
            url = new URL(req.url ?? "/", redirectUri);
          } catch {
            reply(400);
            return;
          }

          if (url.pathname !== path) {
            reply(404);
            return;
          }

          /**
           * The SDK generates an OAuth state only because we implement state(),
           * and finishAuth() takes only the code — so checking it is OUR job.
           * Without this, any page open in the user's browser could drive a
           * code of its own choosing into this listener.
           */
          if (url.searchParams.get("state") !== state) {
            html(400, "That sign-in did not come from here", "Start it again from your terminal.");
            return; // deliberately does NOT settle the promise
          }

          const error = url.searchParams.get("error");
          if (error) {
            const description = url.searchParams.get("error_description");
            const message = description ? `${error}: ${description}` : error;
            html(400, "Sign-in was refused", message);
            settle(() => reject(new Error(message)));
            return;
          }

          const code = url.searchParams.get("code");
          if (!code) {
            html(400, "Sign-in did not complete", "No authorization code came back. Start it again.");
            return;
          }
          html(200, "Signed in to Bellman", "You can close this tab and go back to your terminal.");
          settle(() => resolve(code));
        }

        server.on("request", onRequest);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      // The timer is what would keep the process alive: server.close() alone
      // leaves a pending wait's timer running until it fires.
      cancelPending?.();
      server.close();
    },
  };
}

/** The command and arguments that open `target` in the platform's browser. */
function launcherFor(platform: NodeJS.Platform, target: string): [string, string[]] {
  if (platform === "darwin") return ["open", [target]];
  if (platform === "win32") {
    /**
     * UNVERIFIED on Windows: nobody has run this there. A test pins the argv; what
     * rundll32 then does with it is not pinned by anything.
     *
     * No shell parses this line, so nothing needs escaping. `cmd /c start "" <url>`
     * did: libuv quotes an argument only for a space, tab or quote, so an
     * authorization URL reached cmd unquoted, cmd split it at the first "&" and ran
     * the rest as a command. client_id comes from dynamic client registration, so a
     * hostile authorization server could return `c&calc.exe`. SystemRoot makes the
     * path absolute, because a bare name is looked up in the current directory
     * first. rundll32 reports no failure, so the URL stays in the log line for a
     * browser that never opened.
     */
    const root = process.env.SystemRoot;
    const base = root && win32.isAbsolute(root) ? root : "C:\\Windows";
    return [win32.join(base, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", target]];
  }
  return ["xdg-open", [target]];
}

/**
 * Open the platform browser, detached, with its output discarded — a child
 * writing to our stdout would corrupt the MCP transport. The platform is a
 * parameter so every platform's argv can be checked from any one of them.
 *
 * Only http and https URLs are opened. The URL comes from the SDK's
 * redirectToAuthorization, built from authorization_endpoint in the server's own
 * discovery document, so the server picks the scheme, and open, xdg-open and
 * rundll32 url.dll,FileProtocolHandler each launch whatever application is
 * registered for one: a file: URL, a protocol handler. An authorization endpoint
 * is always http(s), so anything else is refused before any process exists, and
 * logged so the user can see what was attempted.
 */
export function openBrowser(
  url: URL,
  log: (message: string) => void,
  platform: NodeJS.Platform = process.platform,
): void {
  const target = url.toString();
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    log(`refusing to open ${target}: only http and https URLs are opened in a browser`);
    return;
  }
  const [command, args] = launcherFor(platform, target);
  const fallback = () => log(`could not open a browser. Sign in here: ${target}`);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    /**
     * A launcher that is not installed (xdg-open on a headless box, in a
     * container, over SSH) does not throw: spawn reports it later, as an 'error'
     * event, and an 'error' event nobody listens for is an uncaught exception
     * that ends the bridge. So the log hears how it went from the child, and the
     * user always gets the URL.
     */
    child.on("error", fallback);
    child.once("spawn", () => log(`opened a browser to sign in: ${target}`));
    child.unref();
  } catch {
    fallback();
  }
}

// ---------------------------------------------------------------------------
// Signing in: the OAuth client half, over the credential file.
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";
const CALLBACK_TIMEOUT_MS = 300_000;

/**
 * How long a credential WRITE waits for the lock before giving up.
 *
 * Not the same question as how long a sign-in waits for it. A write sits on a
 * path a user is waiting on — a tool call for a post-connect refresh, the
 * connect itself in the no-lock branch — so this is a latency budget, not a
 * correctness one, and the default six minutes on that path is a hang.
 *
 * Two seconds because of what actually holds the lock. An ordinary contender is
 * another bridge doing its own read-modify-write, which is milliseconds; two
 * seconds covers that many times over, including a cached connect that has to
 * talk to the server first. The other holder is a bridge mid-SIGN-IN, which
 * keeps the lock for as long as a human takes — up to the 300s callback
 * timeout — and no bound short enough to be a latency budget will ever outlast
 * that, so waiting longer buys nothing and costs the user the difference.
 *
 * Giving up is cheap: the persist chain writes again on the next refresh, ten
 * minutes later at worst, and the only cost of never writing is one browser tab
 * at the next start. That is strictly better than a stalled tool call.
 */
const PERSIST_LOCK_WAIT_MS = 2_000;

/** Lock options for a write, capped at the latency budget above. */
function persistLock(opts: SignInOptions, signal?: AbortSignal): LockOptions {
  return {
    ...opts.lock,
    // Capped, not fixed: a test may ask for less, nothing gets more.
    waitMs: Math.min(opts.lock?.waitMs ?? PERSIST_LOCK_WAIT_MS, PERSIST_LOCK_WAIT_MS),
    signal,
  };
}

export interface SignInOptions {
  serverUrl: string;
  configDir?: string;
  fetchImpl?: typeof fetch;
  browser?: (url: URL) => void | Promise<void>;
  log?: (message: string) => void;
  ports?: number[];
  callbackTimeoutMs?: number;
  lock?: LockOptions;
  /**
   * Ends a sign-in that is waiting on the browser. channel.ts's shutdown()
   * awaits bridge.close(), which awaits the pending remote; without this, a
   * SIGTERM arriving while a human has not finished signing in would never
   * reach process.exit, Claude Code would force-terminate, and the credential
   * lock would leak — the very case the lock's exit handler exists to cover.
   */
  signal?: AbortSignal;
}

/**
 * The credential with its identity read off its own tokens, and from nothing else.
 *
 * bellman_whoami tells a person which account their room will show, and it reads
 * this field, so the field has to be true of the tokens beside it. An identity is
 * only ever a fact about the access token it was decoded from. Carried across a
 * change of tokens — a second sign-in as someone else, tokens adopted from another
 * bridge, tokens dropped — it names one account while the file holds another's, or
 * none, and it does so silently. A token that cannot be read therefore has no
 * identity: decodeIdentity returning undefined is its documented contract, and
 * "unknown" is a true answer where the last account's name is not.
 */
function withIdentityFromTokens(cred: ServerCredential): ServerCredential {
  return { ...cred, identity: cred.tokens ? decodeIdentity(cred.tokens.access_token) : undefined };
}

/**
 * The bridge's own credential, held in memory for the life of one connect and
 * written back under the lock. The SDK calls these methods at points we do not
 * choose, which is why the lock wraps the whole connect rather than each write.
 */
class BridgeAuth implements OAuthClientProvider {
  cred: ServerCredential;
  private verifier = "";
  /**
   * Buffer.from around the bytes, not randomBytes(...).toString(): under the
   * Worker program's types node:crypto returns a plain Uint8Array, whose
   * toString takes no encoding, and tsconfig.worker.json compiles all of src.
   * Same idiom decodeIdentity already uses in credentials.ts.
   */
  private readonly stateValue = Buffer.from(randomBytes(32)).toString("base64url");

  constructor(
    cred: ServerCredential,
    readonly redirectUrl: string,
    private readonly redirects: string[],
    private readonly onRedirect: (url: URL) => void,
    /** Re-reads the credential file from disk. See invalidateCredentials. */
    private readonly reread: () => ServerCredential
  ) { this.cred = cred; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bellman bridge for Claude Code",
      redirect_uris: this.redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "bellman",
    };
  }

  /**
   * The SDK only sends an OAuth state because this exists, and finishAuth()
   * takes only the code — the listener compares this value itself.
   */
  state(): string { return this.stateValue; }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.cred.client ? ({ ...this.cred.client } as OAuthClientInformationFull) : undefined;
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.set({ ...this.cred, client: { client_id: info.client_id } });
  }

  tokens(): OAuthTokens | undefined {
    const t = this.cred.tokens;
    return t ? { access_token: t.access_token, refresh_token: t.refresh_token, token_type: "Bearer" } : undefined;
  }
  /**
   * Where a refresh that happens AFTER connectSignedIn returned is written.
   *
   * Undefined for the whole of the initial connect, and that is the point: the
   * credential lock is held across it, this process cannot take the lock twice
   * (O_EXCL against its own file), and a re-take would stall for the full
   * waitMs and then write nothing. The single writeServer at the end of signIn
   * covers everything up to that moment; arming happens once the lock is gone.
   */
  private persist: ((cred: ServerCredential) => Promise<void>) | undefined;
  armPersist(fn: (cred: ServerCredential) => Promise<void>): void { this.persist = fn; }

  /**
   * The ONLY place this.cred is assigned. saveTokens is not the only mutator
   * that can run after the connect returns: auth() answers an InvalidClientError
   * mid-session by calling invalidateCredentials("all") and registering again,
   * which mints a client_id that would otherwise never reach disk and be
   * re-registered on every start. Routing all three through one setter means a
   * later mutator cannot forget to persist, rather than each remembering to.
   *
   * For the same reason it is where the identity is read off the tokens. Tokens
   * change in more places than saveTokens — adopting another bridge's, dropping
   * them — and each would have to remember to bring the identity with it.
   */
  private async set(cred: ServerCredential): Promise<void> {
    this.cred = withIdentityFromTokens(cred);
    await this.persist?.(this.cred);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // No identity here: set() reads it off these tokens, and carries nothing over from the last.
    await this.set({
      ...this.cred,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      },
    });
  }

  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
  redirectToAuthorization(url: URL): void { this.onRedirect(url); }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") { await this.set({}); return; }
    if (scope === "client") { await this.set({ ...this.cred, client: undefined }); return; }
    if (scope !== "tokens") return;
    /**
     * The SDK calls this the moment it has judged the refresh token dead, and
     * BEFORE it falls back to opening a browser — so it is the one place a
     * re-read can still save a tab.
     *
     * Access tokens live ten minutes and every bridge on this machine shares one
     * credential file, so N Claude Code windows contend the refresh every ten
     * minutes, not just at startup. Losing that race is ordinary: the winner has
     * already written a good refresh token where we can see it. Adopt theirs and
     * let auth()'s own retry spend it. Only when the file holds nothing newer
     * than what we just spent is a browser the right answer.
     */
    const spent = this.cred.tokens?.refresh_token;
    const stored = this.reread().tokens;
    /**
     * `!== spent` is deliberately not load-bearing, and a mutation sweep will
     * report removing it as survivable. Adopting the token we just spent costs
     * one more refresh that fails the same way, after which auth() is out of
     * retries and the backstop below opens a browser — the same end state, one
     * wasted round trip later. It stays because "adopt something NEWER" is the
     * rule the code means, and a reader should not have to derive the outcome
     * to see that re-spending a dead token is pointless.
     */
    if (stored?.refresh_token && stored.refresh_token !== spent) {
      await this.set({ ...this.cred, tokens: stored });
      return;
    }
    /**
     * Clearing is in-memory only in practice: the persist callback merges with
     * `??`, so an undefined field keeps what is on disk. That is deliberate. A
     * transient invalidation mid-session would otherwise blank a credential
     * another bridge is still using, and whatever the SDK settles on next —
     * refreshed tokens, a re-registered client — persists the truth over it.
     */
    await this.set({ ...this.cred, tokens: undefined });
  }
}

function remoteFrom(client: Client): Remote {
  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params) as Promise<CallToolResult>,
    close: () => client.close(),
  };
}

interface Attempt {
  /** Set when the connect succeeded. */
  remote?: Remote;
  /** Carries the client_id and any rotation, so escalating does not re-register. */
  provider: BridgeAuth;
}

/**
 * Connect on the credential we already have, with the auth provider but NO
 * listener bound. Undefined `remote` means the SDK asked for a browser and the
 * caller has to escalate to the full sign-in.
 *
 * The provider is the point. An earlier version sent a bare Authorization
 * header and no authProvider at all, which made this path unable to refresh:
 * the transport's 401 handler is guarded on `this._authProvider`, so a 401 ten
 * minutes in became a plain StreamableHTTPError and the session was dead. Since
 * this is the path almost every window takes, that capped almost every session
 * at one access-token lifetime.
 *
 * redirectUrl stays defined even though nothing is listening on it: the SDK
 * reads `!provider.redirectUrl` as "non-interactive flow" and would go fetch a
 * token directly. What it does instead is record that a browser was wanted, so
 * the caller can bind a listener and run the real flow.
 */
async function connectCached(
  opts: SignInOptions,
  dir: string,
  cred: ServerCredential,
  persist?: (cred: ServerCredential) => Promise<void>
): Promise<Attempt> {
  let wantsBrowser = false;
  const provider = new BridgeAuth(
    cred,
    loopbackRedirects(opts.ports)[0]!,
    loopbackRedirects(opts.ports),
    () => { wantsBrowser = true; },
    () => readServer(dir, opts.serverUrl)
  );
  // Armed up front only when the caller holds no lock. Under the lock it stays
  // inert and the caller writes once, because acquireLock is not reentrant.
  if (persist) provider.armPersist(persist);

  const client = new Client({ name: "bellman-bridge", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
    authProvider: provider,
    fetch: opts.fetchImpl,
  });
  try {
    await client.connect(transport);
    return { remote: remoteFrom(client), provider };
  } catch (err) {
    await transport.close().catch(() => undefined);
    if (opts.signal?.aborted) throw new SignInCancelled("the sign-in was cancelled");
    // Either the SDK reached for the browser, or a second invalid_grant escaped
    // auth()'s own retry — meaning the stored token and anything newer on disk
    // are both dead. Both need a human, and neither is this function's to do.
    if (err instanceof InvalidGrantError) return { provider };
    if (err instanceof UnauthorizedError && wantsBrowser) return { provider };
    throw err;
  }
}

/**
 * Writes a credential the provider changed after its connect returned.
 *
 * Deliberately takes NO AbortSignal. This runs during ordinary tool calls, and
 * a shutdown arriving mid-refresh must not make it abandon the lock wait and
 * drop the write — that loses the rotation, which is the whole bug this exists
 * to fix. The lock wait is bounded anyway, and the process cannot exit while a
 * synchronous write is in progress.
 */
function makePersist(
  dir: string,
  serverUrl: string,
  lockOpts: LockOptions,
  log: (message: string) => void
): (cred: ServerCredential) => Promise<void> {
  const writeOnce = (cred: ServerCredential) => writeMerged(dir, serverUrl, cred, lockOpts, log);

  /**
   * One at a time, explicitly. Two rapid refreshes must not interleave their
   * read-modify-write. It happens to hold today without this — set() assigns
   * and enters persist in one synchronous step, and acquireLock reaches
   * openSync with no await ahead of it — but that is an emergent property of
   * two unrelated functions, and a single await added before either would break
   * it silently. The chain makes the ordering something the code states.
   */
  let tail: Promise<void> = Promise.resolve();
  return (cred: ServerCredential): Promise<void> => {
    const mine = tail.then(() => writeOnce(cred), () => writeOnce(cred));
    tail = mine.then(() => undefined, () => undefined);
    return mine;
  };
}

/**
 * Merge a credential into the file, under the lock.
 *
 * The lock options are the caller's, and the difference matters: a post-connect
 * refresh passes no signal, because a shutdown must not cost it the rotation,
 * while a write that happens INSIDE connectSignedIn passes one, because an
 * uninterruptible wait there is a shutdown the process cannot complete.
 */
async function writeMerged(
  dir: string,
  serverUrl: string,
  cred: ServerCredential,
  lockOpts: LockOptions,
  log: (message: string) => void
): Promise<void> {
  {
    const held = await acquireLock(dir, lockOpts);
    if (!held) {
      // Degrade, never throw: this runs inside a live session's tool call, and
      // ending the session is strictly worse than a rotation that did not reach
      // disk. The next start pays one browser tab at worst.
      log("could not take the credential lock to save the refreshed sign-in; it stays in memory for this session");
      return;
    }
    try {
      // Field by field, so a client we did not re-register survives rather than
      // being blanked by an undefined.
      //
      // The tokens and the identity read off them are ONE fact, so they come from
      // the same side: ours when we hold tokens, the file's when we do not. Not
      // `cred.identity ?? onDisk.identity`, which said "an identity we could not
      // decode survives": a token we cannot read then inherited the identity of
      // the tokens it had just replaced, and the file named the wrong account. An
      // invalidation that emptied our tokens in memory still cannot blank the
      // file — it holds none, so it takes the file's whole pair.
      const onDisk = readServer(dir, serverUrl);
      writeServer(dir, serverUrl, {
        client: cred.client ?? onDisk.client,
        tokens: cred.tokens ?? onDisk.tokens,
        identity: cred.tokens ? cred.identity : onDisk.identity,
      });
    } finally {
      held.release();
    }
  }
}

/**
 * A fetch that also gives up when the sign-in is cancelled.
 *
 * Every network wait in this module goes through one of the SDK's transports,
 * and there is no one place to interrupt them: discovery, registration, the
 * token exchange, the refresh and each connect are separate requests, and the
 * transport overwrites requestInit.signal with its own controller's on every
 * send, so a signal handed in there is ignored. Wrapping fetch is the one seam
 * they all share — which makes this the whole class, not the two instances
 * (the lock wait and the cached-token connect) that were found first.
 *
 * AbortSignal.any would do this in a line, but it needs Node 20.3; this keeps
 * the floor where the rest of the bridge has it.
 */
function withAbort(base: typeof fetch | undefined, signal: AbortSignal | undefined): typeof fetch | undefined {
  if (!signal) return base;
  const inner = base ?? fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (signal.aborted) return Promise.reject(new SignInCancelled("the sign-in was cancelled"));
    const ours = new AbortController();
    const theirs = init?.signal ?? undefined;
    const fromUs = () => ours.abort(new SignInCancelled("the sign-in was cancelled"));
    const fromThem = () => ours.abort(theirs?.reason);
    signal.addEventListener("abort", fromUs, { once: true });
    theirs?.addEventListener("abort", fromThem, { once: true });
    if (theirs?.aborted) fromThem();
    return inner(input, { ...init, signal: ours.signal }).finally(() => {
      signal.removeEventListener("abort", fromUs);
      theirs?.removeEventListener("abort", fromThem);
    });
  }) as typeof fetch;
}

/**
 * Connect to Bellman as a signed-in user, running the browser flow if there is
 * no usable credential. Returns the same Remote shape connectRemote does.
 */
export async function connectSignedIn(options: SignInOptions): Promise<Remote> {
  /**
   * Every transport built below gets the cancelling fetch, so there is no path
   * through this function — fast or full — that can wait on the network past a
   * shutdown. Done once, here, rather than at each of the five call sites that
   * would each have to remember.
   */
  const opts: SignInOptions = { ...options, fetchImpl: withAbort(options.fetchImpl, options.signal) };
  const dir = opts.configDir ?? credentialsDir();
  const log = opts.log ?? (() => {});
  const ports = opts.ports ?? CALLBACK_PORTS;
  const timeout = opts.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
  const openIt = opts.browser ?? ((url: URL) => openBrowser(url, log));

  // Told to stop before we began: bind no port and take no lock.
  if (opts.signal?.aborted) throw new SignInCancelled("the sign-in was cancelled before it started");

  /**
   * No signal — a shutdown must not cost a refresh its rotation — but a short
   * wait, because a tool call awaits this: saveTokens -> set -> persist ->
   * auth() -> the transport -> callTool. "Nothing awaits it" was wrong, and
   * measured wrong rather than argued wrong. Signal-less AND unbounded would
   * be an un-abortable stall on the call path of up to WAIT_MS.
   */
  const persist = makePersist(dir, opts.serverUrl, persistLock(opts), log);
  const lock = await acquireLock(dir, { ...opts.lock, signal: opts.signal });
  // No lock means someone else held it for the whole wait. Their sign-in may be
  // all we needed, so re-read before giving up.
  if (!lock) {
    /**
     * Or that we were told to stop while waiting. WAIT_MS is six minutes, so a
     * shutdown arriving while another bridge holds the lock would otherwise sit
     * here long past the point Claude Code force-terminates us — the same
     * failure R1 exists to prevent, one layer further down.
     */
    if (opts.signal?.aborted) {
      throw new SignInCancelled("the sign-in was cancelled while waiting for the credential lock");
    }
    const cached = readServer(dir, opts.serverUrl);
    if (cached.tokens?.access_token) {
      /**
       * Nothing is armed for this connect. Arming persist here used to look
       * right — we hold no lock of our own to deadlock against — but it put a
       * SIGNAL-LESS lock wait inside connectSignedIn, in the one branch that
       * exists because another bridge is holding the lock, very likely for a
       * browser flow a human has not finished. A shutdown then waited out the
       * full WAIT_MS on top of the wait it had already survived.
       *
       * So: connect, then one write with the signal attached. An abort gives up
       * the WRITE, which costs a rotation; the alternative was giving up the
       * process, which costs the lock. Only once that write is done, and a
       * refresh can no longer be in-connect, does persist take over.
       */
      const attempt = await connectCached(opts, dir, cached);
      if (attempt.remote) {
        /**
         * Only when something actually changed. BridgeAuth.cred is reassigned
         * by set() and by nothing else, so identity here means no refresh, no
         * registration, nothing saved — and taking the lock to rewrite a
         * byte-identical credential would put back the very wait this branch
         * exists to avoid, in the one case where the lock is already known to
         * be held. A live cached token is the common path through here.
         */
        if (attempt.provider.cred !== cached) {
          await writeMerged(dir, opts.serverUrl, attempt.provider.cred, persistLock(opts, opts.signal), log);
        }
        if (opts.signal?.aborted) {
          // The write was given up, and the cancelling fetch has already made
          // this connection refuse everything. Handing it back would be handing
          // back a Remote that cannot answer; say what happened instead.
          await attempt.remote.close().catch(() => undefined);
          throw new SignInCancelled("the sign-in was cancelled");
        }
        attempt.provider.armPersist(persist);
        return attempt.remote;
      }
      // It wants a browser, and a browser needs the lock we could not get.
    }
    /**
     * Naming the lock alone was actively misleading: every word of "another
     * sign-in is holding it, delete the file if nothing is" was true, and the
     * conclusion it invites — delete a lock another bridge legitimately holds
     * mid-sign-in — breaks that bridge. The reason we are here is that the
     * saved credential needs a browser, so say that first.
     */
    throw new Error(
      `the saved sign-in needs a browser, and another Bellman sign-in is holding ` +
        `${join(dir, LOCK_FILE)} — most likely finishing one of its own. Try again in a moment. ` +
        `If nothing anywhere is signing in, delete that file.`
    );
  }

  /** The provider to arm for later refreshes, once the lock is released below. */
  let arm: BridgeAuth | undefined;
  // The lock wraps the WHOLE connect, not each write: the SDK calls tokens() and
  // saveTokens() at points we do not choose, so there is no smaller unit that is
  // still atomic against another bridge.
  try {
    let cred = readServer(dir, opts.serverUrl);

    /**
     * Any token at all is worth trying, not only an unexpired one: with the
     * provider in play the SDK refreshes a stale one itself, so this covers the
     * live case AND the ten-minutes-later case with no listener, no loopback
     * port and no browser. Much the commonest path, and the one every window
     * takes on every start.
     */
    if (cred.tokens?.access_token) {
      const attempt = await connectCached(opts, dir, cred);
      if (attempt.remote) {
        // A refresh may have just happened, under the lock we are holding, so
        // the one write belongs here — the same shape signIn uses, and for the
        // same reason: one atomic write while nobody else can be writing.
        writeServer(dir, opts.serverUrl, attempt.provider.cred);
        arm = attempt.provider;
        return attempt.remote;
      }
      // It wants a human. Carry what it learned — the client_id above all, so
      // escalating does not register a second client with the server.
      cred = attempt.provider.cred;
      log("the saved sign-in needs a browser; signing in again");
    }

    const listener = await listenForCallback(ports, log);
    if (!listener) {
      throw new Error(
        `no free loopback port in ${ports[0]}-${ports[ports.length - 1]} to receive the sign-in`
      );
    }

    // An abort has to reach the listener, because that is what the wait is on.
    const onAbort = () => listener.close();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const signedIn = await signIn(opts, dir, cred, listener, openIt, timeout, log);
      arm = signedIn.provider;
      return signedIn.remote;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      listener.close(); // idempotent: covers every path signIn did not close on
    }
  } finally {
    lock.release();
    /**
     * Only now. The provider outlives this call — the Remote holds the
     * transport, which holds the provider — and access tokens live ten minutes,
     * so any session longer than that refreshes, and every refresh ROTATES the
     * refresh token server-side. Without this the file keeps a token the server
     * has already deleted, and the next start opens a browser: the exact
     * opposite of what a cached credential is for.
     *
     * Armed after release() rather than in the constructor because the lock is
     * not reentrant, and a refresh during the initial connect would stall on a
     * lock this very call is holding.
     */
    arm?.armPersist(persist);
  }
}

async function signIn(
  opts: SignInOptions,
  dir: string,
  cred: ServerCredential,
  listener: Listener,
  openIt: (url: URL) => void | Promise<void>,
  timeout: number,
  log: (message: string) => void
): Promise<{ remote: Remote; provider: BridgeAuth }> {
  let retried = false;
  /** Set once the listener has been waited on: it is closed, so it is single use. */
  let listenerSpent = false;
  let current = cred;

  for (;;) {
    let pending: URL | undefined;
    const provider = new BridgeAuth(
      current,
      listener.redirectUri,
      loopbackRedirects(opts.ports),
      (url) => { pending = url; },
      () => readServer(dir, opts.serverUrl)
    );
    const newTransport = () =>
      new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
        authProvider: provider,
        fetch: opts.fetchImpl,
      });
    let client = new Client({ name: "bellman-bridge", version: VERSION });
    let transport = newTransport();

    try {
      try {
        await client.connect(transport);
      } catch (err) {
        if (!(err instanceof UnauthorizedError) || !pending) throw err;
        /**
         * The URL comes from authorization_endpoint in the server's own
         * discovery document, so the SERVER picks the scheme. openBrowser
         * refuses anything but http(s), but refusing only logs — so without this
         * a hostile or misconfigured endpoint would open nothing and then burn
         * the entire callback timeout waiting for a click that cannot happen.
         */
        if (pending.protocol !== "http:" && pending.protocol !== "https:") {
          throw new Error(
            `refusing to sign in at ${pending.toString()}: only http and https authorization URLs are opened`
          );
        }
        if (opts.signal?.aborted) throw new SignInCancelled("the sign-in was cancelled");
        /**
         * Arm the wait BEFORE opening the browser, not after. waitForCode is
         * what installs the listener's request handler, and a callback that
         * arrives before it does gets no response at all and hangs its
         * connection open — so the browser half never finishes, and the openIt()
         * that is driving it never returns. The browser can beat the next
         * statement whenever no human is in the way: a test driving it in
         * process, a password manager completing the form, an authorization
         * server answering an already-approved client straight from cache.
         */
        const waiting = listener.waitForCode(provider.state(), timeout);
        /**
         * And attach a handler in the same turn. openIt() below can throw, and
         * the close() in the finally would then reject this with nobody awaiting
         * it yet — an unhandled rejection, which ends a Node process by default.
         * `await waiting` still sees the rejection; this only marks it handled.
         */
        waiting.catch(() => undefined);
        listenerSpent = true;
        let code: string;
        try {
          await openIt(pending);
          code = await waiting;
        } finally {
          /**
           * Nothing else will ever arrive for this wait, and a request that
           * finds no waitForCode registered gets no response at all and holds
           * its connection open. The browser sends one the moment the callback
           * page renders — a favicon — so this is the common case, not a rare one.
           */
          listener.close();
        }
        await transport.finishAuth(code);
        /**
         * A fresh pair for the connect that follows. client.connect() calls
         * transport.start(), and a transport that has already been started
         * throws rather than restart — and this one was started by the attempt
         * that ended in the 401 above. The authorization lives on the provider,
         * not the transport, so a new pair picks up the tokens finishAuth saved.
         */
        await transport.close().catch(() => undefined);
        client = new Client({ name: "bellman-bridge", version: VERSION });
        transport = newTransport();
        await client.connect(transport);
      }
    } catch (err) {
      await transport.close().catch(() => undefined);
      // A shutdown mid-request: the cancelling fetch rejected it, and the
      // reason matters more than whatever the SDK wrapped it in.
      if (opts.signal?.aborted) throw new SignInCancelled("the sign-in was cancelled");
      /**
       * auth() already handles the FIRST invalid_grant itself: it calls
       * invalidateCredentials("tokens") — where we may adopt a token another
       * bridge wrote — and retries. Only a second one reaches here, meaning what
       * we adopted was dead too. Drop the tokens and start over from the browser.
       *
       * Not after the listener has been waited on: it is closed by then, so a
       * second pass could not receive a callback.
       */
      if (!retried && !listenerSpent && err instanceof InvalidGrantError) {
        retried = true;
        // No tokens, so no identity: the file must not go on naming an account that
        // nothing can sign in as, for however long the browser takes — or for good, if
        // nobody finishes it.
        current = withIdentityFromTokens({ ...current, tokens: undefined });
        writeServer(dir, opts.serverUrl, current);
        log("the saved sign-in was rejected; signing in again");
        continue;
      }
      throw err;
    }

    writeServer(dir, opts.serverUrl, provider.cred);
    /**
     * decodeIdentity returns the token's `bellman` claim verbatim, with no field
     * checks, so a malformed claim can be an object carrying no label at all.
     * Branch on a usable label, not on the identity merely being there, or this
     * line reads "signed in as undefined".
     */
    const identity = provider.cred.identity;
    const label = typeof identity?.label === "string" && identity.label ? identity.label : undefined;
    const plan = typeof identity?.plan === "string" && identity.plan ? identity.plan : undefined;
    log(label ? `signed in as ${label}${plan ? ` (${plan} plan)` : ""}` : "signed in");
    // The provider goes back with the Remote: it outlives this call inside the
    // transport, and connectSignedIn arms its persist once the lock is released.
    return { remote: remoteFrom(client), provider };
  }
}
