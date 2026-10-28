#!/usr/bin/env node
/**
 * Bellman join hook (#435): says, at SessionStart, what came of the join a desktop app asked for with
 * `BELLMAN_JOIN_CODE`. The bridge does the joining (`join` in src/bridge.ts), since it holds the sign-in and the hook
 * holds nothing; this reads where that stands through the bridge's door and prints one line, which Claude Code adds to
 * the session's context and shows the person.
 *
 * With no code in its environment it prints nothing. With a code and no door to ask within `DOOR_WAIT_MS`, it says
 * how to set a bridge up, since nothing joined. It waits up to `WAIT_MS` for a join still in progress, which covers a
 * sign-in the bridge is waiting on only if the person finishes it quickly; past that it says the join is still going.
 * It never prints the code, and always exits 0: a broken hook must not hold up the session.
 */
import { cleanText, type DoorJoin } from "./door-protocol.js";
import { findDoor, readDoorStatus } from "./door.js";

// ponytail: twenty seconds, not tuned: a preview and a confirm take about one with a cached sign-in. hooks.json gives
// the hook thirty.
const WAIT_MS = 20_000;
// ponytail: five seconds, not tuned. A bridge opens its door as it starts, before any sign-in, so a door not there by
// then is a bridge that is not coming.
const DOOR_WAIT_MS = 5_000;
const POLL_MS = 250;

const SETUP =
  "BELLMAN_JOIN_CODE is set, but no Bellman bridge is running in this session, so no room was joined. Install the " +
  "plugin (claude plugin install bellman --marketplace bellman-sh/bellman), or see https://docs.bellman.sh/start/connect/.";

/** The line for where the join stands; `undefined` join means a bridge too old to join from the code. */
export function joinLine(join: DoorJoin | undefined): string {
  if (join === undefined) {
    return "BELLMAN_JOIN_CODE is set, but this Bellman bridge does not join from it. Update Bellman (claude plugin update bellman@bellman).";
  }
  if (join.state === "joining") {
    return "Bellman is still joining the room from BELLMAN_JOIN_CODE; a sign-in may be waiting in the browser. Call bellman_rooms to see whether it finished.";
  }
  if (join.state === "refused") return `Bellman did not join a room from BELLMAN_JOIN_CODE: ${join.reason}.`;
  const verbs = join.verbs.length > 0 ? join.verbs.map((v) => cleanText(v, 40)).join(", ") : "nothing";
  return (
    `Bellman joined room ${cleanText(join.session_id, 80)} from BELLMAN_JOIN_CODE as "${cleanText(join.role, 64)}" ` +
    `(member_id ${cleanText(join.member_id, 80)}), which may: ${verbs}. Peer events arrive as usual; call bellman_rooms ` +
    "to read the room."
  );
}

async function main(): Promise<void> {
  if (!process.env.BELLMAN_JOIN_CODE?.trim()) return;
  const started = Date.now();
  const deadline = started + WAIT_MS;
  let door: string | undefined;
  let join: DoorJoin | undefined;
  let answered = false;
  for (;;) {
    door ??= findDoor();
    const status = door === undefined ? undefined : await readDoorStatus(door);
    if (status) {
      answered = true;
      join = status.join;
      // A bridge that answers with no join at all was not given the code: older than this hook, or started without it.
      if (join?.state !== "joining") break;
    }
    if (Date.now() >= (answered ? deadline : started + DOOR_WAIT_MS)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  process.stdout.write(`${answered ? joinLine(join) : SETUP}\n`);
}

main().catch(() => undefined).finally(() => process.exit(0));
