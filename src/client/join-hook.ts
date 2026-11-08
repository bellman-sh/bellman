#!/usr/bin/env node
/**
 * Bellman join hook (#435): says, at SessionStart, what came of the join a desktop app asked for with
 * `BELLMAN_JOIN_CODE`. The bridge does the joining (`join` in src/client/bridge.ts), since it holds the sign-in and the hook
 * holds nothing; this reads where that stands through the bridge's door and prints one line, which Claude Code adds to
 * the session's context and shows the person.
 *
 * With no code in its environment it prints nothing. With a code and no door to ask within `DOOR_WAIT_MS`, it says
 * how to set a bridge up, since nothing joined. It waits up to `WAIT_MS` for a join still in progress, which covers a
 * sign-in the bridge is waiting on only if the person finishes it quickly; past that it says the join is still going.
 * It never prints the code, and always exits 0: a broken hook must not hold up the session.
 */
import { joinLine, type DoorJoin } from "./door-protocol.js";
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

export { joinLine };

async function main(): Promise<void> {
  // With no code the bridge may still join from the repo's default room; the hook asks and says nothing when it did not.
  const code = Boolean(process.env.BELLMAN_JOIN_CODE?.trim());
  // Without a code, a door not there now is no bridge to wait for: SessionStart is not held up looking for one.
  if (!code && findDoor() === undefined) return;
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
  // Without a code there is nothing to say unless the bridge joined, or tried to join, the repo's default room.
  if (!code) {
    if (join?.from === "repo") process.stdout.write(`${joinLine(join)}\n`);
    return;
  }
  process.stdout.write(`${answered ? joinLine(join) : SETUP}\n`);
}

main().catch(() => undefined).finally(() => process.exit(0));
