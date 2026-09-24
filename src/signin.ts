import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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

export interface Listener {
  redirectUri: string;
  waitForCode(state: string, timeoutMs: number): Promise<string>;
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

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Bellman</title>` +
  `<body style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.25rem">` +
  `<h1 style="font-size:1.35rem">${title}</h1><p>${body}</p>`;

/** Bind the first free port, ascending. Undefined when every one is taken. */
export async function listenForCallback(ports: number[] = CALLBACK_PORTS): Promise<Listener | undefined> {
  for (const port of ports) {
    const server = await bind(port);
    if (server) return makeListener(server, `http://127.0.0.1:${port}/callback`);
  }
  return undefined;
}

function makeListener(server: Server, redirectUri: string): Listener {
  const path = new URL(redirectUri).pathname;
  return {
    redirectUri,
    waitForCode(state, timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.removeListener("request", onRequest);
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the sign-in to finish`));
        }, timeoutMs);

        const settle = (fn: () => void) => {
          clearTimeout(timer);
          server.removeListener("request", onRequest);
          fn();
        };

        function onRequest(req: IncomingMessage, res: ServerResponse): void {
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
            res.writeHead(400).end();
            return;
          }
          const html = (status: number, title: string, body: string) =>
            res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, body));

          if (url.pathname !== path) {
            res.writeHead(404).end();
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
    close() { server.close(); },
  };
}

/**
 * Open the platform browser, detached, with its output discarded — a child
 * writing to our stdout would corrupt the MCP transport.
 */
export function openBrowser(url: URL, log: (message: string) => void): void {
  const target = url.toString();
  const [command, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [target]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
    log(`opened a browser to sign in: ${target}`);
  } catch {
    log(`could not open a browser. Sign in here: ${target}`);
  }
}
