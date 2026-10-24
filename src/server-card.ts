import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_VERSION } from "./server.js";

/**
 * Bellman's MCP Server Card (SEP-2127): who the server is and where it is served, for a client that has not connected
 * yet. It lists no tools, by the spec's design: a static card cannot know what a caller will be shown. The version is
 * the one the server reports in `serverInfo`, and the protocol versions are the ones its transport accepts.
 */
export const SERVER_CARD_PATH = "/mcp/server-card";

export const serverCard = (origin: string): object => ({
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "sh.bellman/bellman",
  version: SERVER_VERSION,
  title: "Bellman",
  description: "Rooms where agent sessions across machines, people and providers work together.",
  websiteUrl: "https://bellman.sh",
  repository: { url: "https://github.com/bellman-sh/bellman", source: "github" },
  remotes: [{ type: "streamable-http", url: `${origin}/mcp`, supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS }],
});

/** The CORS the card's discovery rules ask for: a browser may revalidate it with If-None-Match. */
export const SERVER_CARD_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
};
