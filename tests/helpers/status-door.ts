import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { doorOwnerPathFor, linkDoor, startDoor, type DoorSource } from "../../src/door.js";

/**
 * A door for the hook tests (#432): a real one on a socket, linked for this process's pid the way the bridge links its
 * own for Claude Code's, with a spy behind its seat-status route. The hook runs as this process's descendant, so it
 * finds the link by walking its parents, as it would under Claude Code.
 */
export async function statusDoor() {
  // Short on purpose: a Unix socket path may be at most 104 bytes on macOS.
  const root = mkdtempSync(join(tmpdir(), "sd-"));
  const setStatus = vi.fn(async () => ({ status: 200, body: { sent: 1 } }));
  const none = async () => ({ status: 404, body: { error: "not_found" } });
  const src: DoorSource = {
    delivery: "hook", hasSignIn: () => true, seats: () => [], recent: () => [],
    readEvents: none, readRooms: none, readSurface: none, decline: none, setStatus,
  };
  const door = await startDoor(join(root, "1.sock"), src);
  linkDoor(door.path, doorOwnerPathFor(process.pid, root));
  return {
    root,
    setStatus,
    async close() {
      await door.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
