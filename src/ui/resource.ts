import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_HTML } from "./assets.js";

/**
 * The one UI resource (#28). Both screens, the join preview and the room
 * monitor, live in this single page, which dispatches on the tool result the
 * host hands it (spec D10). `ui://` is the scheme the MCP Apps extension
 * reserves for resources a host renders rather than reads.
 */
export const APP_RESOURCE_URI = "ui://bellman/app.html";

/**
 * MCP Apps, spec 2026-01-26: the exact mimeType a host renders as an app. Any
 * other value is shown as text or not at all. Written here rather than imported
 * from `@modelcontextprotocol/ext-apps/server`, which expects the v2 SDK this
 * server does not use (D11).
 */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** What a tool puts in its `_meta` to be rendered through the app. */
export const APP_UI_META = { ui: { resourceUri: APP_RESOURCE_URI } } as const;

/**
 * Register the page. Registering any resource switches the server's `resources`
 * capability on; tests/tools/surface.test.ts pins that this is the only one.
 * `prefersBorder` asks the host to frame the app; the spec recommends saying so
 * because hosts' defaults differ. No `csp`: the page loads nothing external and
 * reaches data only through the host's `tools/call` (D1).
 */
export function registerAppResource(server: McpServer): void {
  server.registerResource(
    "Bellman",
    APP_RESOURCE_URI,
    {
      title: "Bellman",
      description: "The join preview and the room monitor, rendered by hosts that support MCP Apps.",
      mimeType: APP_MIME_TYPE,
    },
    async () => ({
      contents: [{
        uri: APP_RESOURCE_URI,
        mimeType: APP_MIME_TYPE,
        text: APP_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );
}
