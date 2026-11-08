import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";

/**
 * One `/mcp` request, either protocol era, answered by a server built for this caller alone (#571).
 *
 * A 2026-07-28 request names its version and client in its own `_meta`; it goes to the SDK's `createMcpHandler`,
 * strict to that era, answering JSON. Anything else is a 2025-era request and gets exactly what it got before the
 * upgrade: a stateless streamable HTTP transport with `enableJsonResponse`, so a plain JSON body rather than the
 * SSE stream `createMcpHandler`'s own legacy path would send. `isLegacyRequest` reads a clone, so the request's
 * body is still there for whichever path answers it.
 *
 * Both entries call this: the Worker with its `Request`, the Node server through `toNodeHandler`.
 */
export async function serveMcp(request: Request, factory: () => McpServer): Promise<Response> {
  // The cast is for the Worker program, whose Request type carries Cloudflare's `cf` generics; the object is the same.
  if (await isLegacyRequest(request.clone() as Parameters<typeof isLegacyRequest>[0])) {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
  const modern = createMcpHandler(factory, {
    legacy: "reject",
    responseMode: "json",
    onerror: (err) => console.error("MCP request failed:", err),
  });
  return modern.fetch(request);
}
