#!/usr/bin/env node
/**
 * Bellman for Claude Code — the stdio MCP server Claude Code spawns.
 *
 * Environment:
 *   BELLMAN_KEY       optional. A static bearer key. Set it and the bridge uses
 *                     it unchanged — CI, the smoke script, a headless box.
 *                     Leave it unset and the bridge signs you in, caching the
 *                     result under ~/.config/bellman/.
 *   BELLMAN_URL       optional. Defaults to https://mcp.bellman.sh/mcp
 *   BELLMAN_NO_BROWSER  optional. Print the sign-in URL instead of opening a
 *                     browser. For SSH and headless machines.
 *   XDG_CONFIG_HOME   optional. Where the credential is cached.
 *   BELLMAN_DELIVERY  "channel" (default): push peer events into the session.
 *                     Launch with --dangerously-load-development-channels server:<name>.
 *                     "hook": queue them for the Bellman Stop hook and bellman_wait.
 *
 * The sign-in is NOT lazy, and it is worth being plain about it. Claude Code
 * lists a server's tools as soon as it connects, the bridge proxies tools/list
 * to Bellman, and proxying it means connecting — so on a machine with no cached
 * credential the browser opens at Claude Code LAUNCH, not at the first bellman_*
 * call. Nothing here can defer that without a tool-list cache, which would then
 * have to be invalidated against a server it has not talked to yet.
 *
 * Launch it with `node` directly, not through npx or a shell: hook delivery
 * keys the inbox by this process's parent PID, which must be Claude Code.
 *
 * stdout is the MCP transport. Log to stderr only.
 */
import { rmSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectRemote, createBridge, type Delivery, type Remote, type WhoAmI } from "./bridge.js";
import { inboxDirFor, sweepStaleInboxes } from "./inbox.js";
import { connectSignedIn, signedInAs, SignInCancelled } from "./signin.js";

const key = process.env.BELLMAN_KEY;
const url = process.env.BELLMAN_URL ?? "https://mcp.bellman.sh/mcp";
const delivery: Delivery = process.env.BELLMAN_DELIVERY === "hook" ? "hook" : "channel";
const log = (message: string) => console.error(`[bellman] ${message}`);

/**
 * Ends a sign-in that is waiting on a human. shutdown() below awaits
 * bridge.close(), which awaits whatever connect is in flight, and a browser flow
 * holds for up to 300s — so without this a SIGTERM during one would never reach
 * process.exit(). Claude Code would force-terminate us instead, and the
 * credential lock would leak, which is the one failure its exit handler exists
 * to prevent.
 */
const signingIn = new AbortController();

/**
 * An explicitly set BELLMAN_KEY is a deliberate act and wins over a cached
 * sign-in: that is what keeps CI, `npm run smoke` and headless boxes on the
 * documented non-interactive path. Unset, the bridge signs itself in — it has no
 * TTY and stdout is the MCP transport, so there is nowhere to prompt and nothing
 * for the user to run first.
 */
const connect: () => Promise<Remote> = key
  ? () => connectRemote(url, key)
  : async () => {
      try {
        return await connectSignedIn({
          serverUrl: url,
          log,
          signal: signingIn.signal,
          browser: process.env.BELLMAN_NO_BROWSER
            ? (target: URL) => log(`sign in here: ${target.toString()}`)
            : undefined,
        });
      } catch (error) {
        /**
         * A cancel is this process shutting down: there is nobody left to tell,
         * and saying it anyway turns every quit into a line that reads like a
         * failure. Everything else has to reach the user — the 300s callback
         * timeout above all, which is what a sign-in nobody finished looks like.
         *
         * By instanceof, not by message: a reworded cancel must not silently
         * start being reported, and a reworded timeout must not silently stop.
         */
        if (!(error instanceof SignInCancelled)) {
          log(`sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    };

/** Who peers will see. A key is unattributable here; the server resolves it per call. */
const whoami = (): WhoAmI => (key ? { source: "env", label: null } : signedInAs(url, { log }));

const inboxDir = delivery === "hook" ? inboxDirFor(process.ppid) : undefined;
if (delivery === "hook") sweepStaleInboxes();

const bridge = createBridge({
  delivery,
  inboxDir,
  remote: connect,
  whoami,
  log,
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Before close(), not after. close() awaits the connect in flight, and a
  // sign-in is the one that can hold for as long as a human takes.
  signingIn.abort();
  await bridge.close().catch(() => undefined);
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  /**
   * Still ends here, deliberately. A post-connect credential persist may be in
   * flight; it takes no signal, because a shutdown must not cost it the token
   * rotation, and nothing awaits it. That is only safe because this line is
   * reached: were this ever to become a natural exit, an un-awaited persist
   * would hold the event loop open for its lock wait.
   */
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

await bridge.server.connect(new StdioServerTransport());
log(`ready: ${delivery} delivery via ${url}` + (key ? " (BELLMAN_KEY)" : " (signing in)"));
