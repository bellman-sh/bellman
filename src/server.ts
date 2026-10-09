import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Identity } from "./types.js";
import type { BellmanStore } from "./store.js";
import type { BlobStore } from "./blobs.js";
import { registerStart } from "./tools/start.js";
import { registerConnect } from "./tools/connect.js";
import { registerConfirm } from "./tools/confirm.js";
import { registerInvite } from "./tools/invite.js";
import { registerSend } from "./tools/send.js";
import { registerSync } from "./tools/sync.js";
import { registerRooms } from "./tools/rooms.js";
import { registerSurface } from "./tools/surface.js";
import { registerLeave } from "./tools/leave.js";
import { registerEvict } from "./tools/evict.js";
import { registerAudit } from "./tools/audit.js";
import { registerAppResource } from "./ui/resource.js";

const SERVER_NAME = "bellman-mcp-server";
const SERVER_VERSION = "0.1.0";

/**
 * One `McpServer` per request, bound to a caller identity.
 *
 * This file used to hold all nine tools, their descriptions and the shared
 * helpers, and had passed 1,100 lines — every new tool made the one file every
 * tool lives in worse (#92). Now a tool is a file, and adding one costs this
 * file a single line. What the tools share went two ways, and the split is not
 * cosmetic: `projections.ts` is runtime-free so the control panel's read routes
 * can import the wire shaping without dragging in the MCP SDK (#114), while
 * `tools/kit.ts` is the MCP-coupled part and stays on this side of that line.
 *
 * The call order below is the order the tools are registered in, and it is the
 * order they were registered in before the split. `extension/manifest.json`
 * declares the same list by hand for the Claude Desktop bundle, and
 * `tests/extension.test.ts` asserts the two against each other. The resource is
 * registered last; it is not a tool, and the manifest does not list it.
 *
 * `blobs` is the blob seam (#183), handed only to `bellman_send`, whose `file`,
 * `image` and blob-backed `html` items read it; it has no default, so a deploy
 * that forgets the binding does not compile rather than serving a store that
 * forgets.
 *
 * `features.hostedSeat` is BELLMAN_HOSTED_SEAT (`hostedSeatOn`), handed only to
 * `bellman_start`, which refuses a room that declares a host while it is false.
 * It has no default for the same reason `blobs` has none: a caller that forgets
 * it does not compile, and so no server is built that decides the seat's switch
 * by accident.
 */
export function buildServer(identity: Identity, s: BellmanStore, blobs: BlobStore, features: { hostedSeat: boolean }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerStart(server, identity, s, features);
  registerConnect(server, identity, s);
  registerConfirm(server, identity, s);
  registerInvite(server, identity, s);
  registerSend(server, identity, s, blobs);
  registerSync(server, identity, s);
  registerRooms(server, identity, s);
  registerSurface(server, identity, s);
  registerLeave(server, identity, s);
  registerEvict(server, identity, s);
  registerAudit(server, identity, s);

  // The one UI resource (#28). Hosts that render MCP Apps show bellman_connect
  // and bellman_rooms through it; every other host ignores it (D10).
  registerAppResource(server);

  return server;
}
