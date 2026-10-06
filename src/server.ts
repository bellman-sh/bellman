import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Identity } from "./types.js";
import type { BellmanStore } from "./store.js";
import { registerStart } from "./tools/start.js";
import { registerConnect } from "./tools/connect.js";
import { registerConfirm } from "./tools/confirm.js";
import { registerInvite } from "./tools/invite.js";
import { registerSend } from "./tools/send.js";
import { registerSync } from "./tools/sync.js";
import { registerLeave } from "./tools/leave.js";
import { registerEvict } from "./tools/evict.js";
import { registerAudit } from "./tools/audit.js";

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
 * `tests/extension.test.ts` asserts the two against each other.
 */
export function buildServer(identity: Identity, s: BellmanStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerStart(server, identity, s);
  registerConnect(server, identity, s);
  registerConfirm(server, identity, s);
  registerInvite(server, identity, s);
  registerSend(server, identity, s);
  registerSync(server, identity, s);
  registerLeave(server, identity, s);
  registerEvict(server, identity, s);
  registerAudit(server, identity, s);

  return server;
}
