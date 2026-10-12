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
 *                     browser, for one you would rather open yourself on THIS
 *                     machine. It does not make sign-in work from another
 *                     machine: the listener binds 127.0.0.1 here, on the first
 *                     free port in 51004-51008, so a browser elsewhere posts
 *                     the code to its own loopback. Over SSH, forward that
 *                     port. With no browser anywhere, set BELLMAN_KEY.
 *   XDG_CONFIG_HOME   optional. Where the credential is cached.
 *   BELLMAN_DELIVERY  "channel" (default): push peer events into the session.
 *                     Launch with --dangerously-load-development-channels server:<name>.
 *                     "hook": queue them for the Bellman Stop hook and bellman_wait.
 *   BELLMAN_BUS       "on" (default) or "off". On, the bridges on a machine share one
 *                     connection per room, over a Unix socket under ~/.claude/bellman/bus,
 *                     where each used to long-poll for every member it watches. "off" is
 *                     the way back to that: this bridge polls for its own members and
 *                     makes no socket. 0, false and no also mean off, and so does any
 *                     value this does not recognise, which is logged: a switch for
 *                     turning something off should not leave it on over a spelling.
 *                     Read at launch, and per bridge: one with it off does not stop the
 *                     others sharing a bus among themselves.
 *   BELLMAN_UPLOAD_ROOT  optional. Where bellman_upload may read from: a path outside this
 *                     directory, links followed, is refused. Unset or empty, it is the
 *                     directory the bridge was started in, unless that directory contains
 *                     your home directory (the filesystem root included), which is
 *                     refused: name it here to allow that much. "/" is any file. Read on
 *                     each upload.
 *
 * The sign-in is NOT lazy. Claude Code
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
import { busCredentials } from "./credentials.js";
import { inboxDirFor, sweepStaleInboxes } from "./inbox.js";
import { connectSignedIn, signedInAs, SignInCancelled } from "./signin.js";

const key = process.env.BELLMAN_KEY;
const url = process.env.BELLMAN_URL ?? "https://mcp.bellman.sh/mcp";
const delivery: Delivery = process.env.BELLMAN_DELIVERY === "hook" ? "hook" : "channel";
const log = (message: string) => console.error(`[bellman] ${message}`);

/**
 * The kill switch for the local bus (see BELLMAN_BUS above). A value that is neither on nor off is read as off and said
 * so, not read as on: the switch exists to be turned off, so a spelling it does not know ("disabled") must not leave
 * the bus running in front of a person who has just tried to stop it, and off costs only what the bus saves.
 */
const BUS_ON = ["", "on", "1", "true", "yes"];
const BUS_OFF = ["off", "0", "false", "no"];
const busValue = (process.env.BELLMAN_BUS ?? "").trim().toLowerCase();
const busOn = BUS_ON.includes(busValue);
if (!busOn && !BUS_OFF.includes(busValue)) {
  log(`BELLMAN_BUS=${JSON.stringify(process.env.BELLMAN_BUS)} is not on or off, so it is read as off`);
}

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
  /**
   * Where bellman_upload posts (#183): the blob routes on this server's origin,
   * as whoever the bridge is — the BELLMAN_KEY, or the cached sign-in's access
   * token, read on every upload because it rotates every ten minutes.
   */
  upload: { serverUrl: url, bearer: busCredentials(url, key).bearer },
  /**
   * One upstream connection per room, shared by every bridge on this machine (#43, #99). It is asked for when the
   * first membership is armed and not before, so nothing is read and no socket made at launch: a signed-in bridge
   * has no identity to name a bus after until it has signed in. A BELLMAN_KEY names the bus and signs a room's
   * upgrade; signed in, the person (not the token, which changes every ten minutes) names it and whatever token
   * the credential file holds signs it. Where the bus cannot be had the bridge polls as it always did, and with
   * BELLMAN_BUS off it is never asked for: no option at all is what a bridge had before the bus.
   */
  ...(busOn ? { bus: { url, ...busCredentials(url, key) } } : {}),
  log,
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Before close(), not after. close() awaits the connect in flight, and a
  // sign-in is the one that can hold for as long as a human takes.
  signingIn.abort();
  // close() also closes the local bus, and that is what removes this bridge's socket file if it was the
  // coordinator. The bridges that were its subscribers race again and one takes over, each from its own cursor.
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
/**
 * Which of the three states this start is in, because the browser is about to
 * be the surprising part. A cached credential is reused in silence and a fresh
 * machine is not, and the difference is invisible from the outside — so a user
 * asking "why did a tab just open" has the answer in the line above it. Safe to
 * call: signedInAs catches its own credentialsDir(), and a key never reads at all.
 */
const state = whoami().source;
log(
  `ready: ${delivery} delivery via ${url} ` +
    (state === "env" ? "(BELLMAN_KEY)" : state === "oauth" ? "(signed in)" : "(not signed in yet)") +
    // Said when it is off and not when it is on, which is what every bridge did before there was a switch to say.
    (busOn ? "" : `; local bus off (BELLMAN_BUS=${process.env.BELLMAN_BUS})`)
);
