import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { win32 } from "node:path";

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
  /** Stops listening and ends a pending wait with SignInCancelled. Safe to call twice. */
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
 */
export function openBrowser(
  url: URL,
  log: (message: string) => void,
  platform: NodeJS.Platform = process.platform,
): void {
  const target = url.toString();
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
