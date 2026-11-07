import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { DoorJoin } from "../../src/client/door-protocol.js";
import { doorOwnerPathFor, linkDoor, startDoor, type DoorSource } from "../../src/client/door.js";

/**
 * A door for the hook tests (#432): a real one on a socket, linked for this process's pid the way the bridge links its
 * own for Claude Code's, with a spy behind its seat-status route. The hook runs as this process's descendant, so it
 * finds the link by walking its parents, as it would under Claude Code. `joinState` is what its status reports of a join
 * from BELLMAN_JOIN_CODE (#435), read on every request, so a test can move it while the hook polls. `capture` is what
 * its `/memory` answers for the account's memory settings (#530); undefined, and the route answers as a bridge with no
 * credential would, 503.
 */
export async function statusDoor(joinState: () => DoorJoin | undefined = () => undefined, capture?: boolean) {
  // Short on purpose: a Unix socket path may be at most 104 bytes on macOS.
  const root = mkdtempSync(join(tmpdir(), "sd-"));
  const setStatus = vi.fn(async () => ({ status: 200, body: { sent: 1 } }));
  const none = async () => ({ status: 404, body: { error: "not_found" } });
  const readMemory = vi.fn(async () =>
    capture === undefined ? { status: 503, body: { error: "no_credential" } } : { status: 200, body: { capture } });
  const src: DoorSource = {
    delivery: "hook", hasSignIn: () => true, seats: () => [], recent: () => [],
    readEvents: none, readRooms: none, readSurface: none, readMemory, decline: none, setStatus, writeSurface: none, join: joinState,
  };
  const door = await startDoor(join(root, "1.sock"), src);
  linkDoor(door.path, doorOwnerPathFor(process.pid, root));
  return {
    root,
    setStatus,
    readMemory,
    async close() {
      await door.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
