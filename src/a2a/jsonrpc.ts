/**
 * JSON-RPC 2.0 for the A2A binding (A2A v1.0, section 9), by hand: a request read, a result, an error. Errors carry the
 * spec's codes (sections 5.4 and 9.5), and their `data`, when there is any, is the spec's array of `@type` objects.
 */

export type RpcId = string | number | null;
export type RpcRequest = { id: RpcId; method: string; params: unknown };
export type RpcError = { error: { id: RpcId; code: number; message: string } };

/** The standard JSON-RPC codes and the A2A ones (spec 5.4), with each one's standard message. */
export const A2A_ERRORS = {
  parseError: { code: -32700, message: "Invalid JSON payload" },
  invalidRequest: { code: -32600, message: "Request payload validation error" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid parameters" },
  internal: { code: -32603, message: "Internal error" },
  taskNotFound: { code: -32001, message: "Task not found" },
  taskNotCancelable: { code: -32002, message: "Task cannot be canceled" },
  pushNotSupported: { code: -32003, message: "Push Notification is not supported" },
  unsupportedOperation: { code: -32004, message: "This operation is not supported" },
  contentTypeNotSupported: { code: -32005, message: "Incompatible content types" },
  extendedCardNotConfigured: { code: -32007, message: "Extended agent card not configured" },
  versionNotSupported: { code: -32009, message: "Version not supported" },
  /** JSON-RPC's own server-error code, outside the A2A range: the room refused this caller (a ban, a suspension, a limit). */
  refused: { code: -32000, message: "Refused" },
} as const;

const isId = (v: unknown): v is RpcId => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** A parsed body as a request, or the error to answer it with. A notification (no `id`) is answered too, with a null id. */
export function parseRpc(body: unknown): RpcRequest | RpcError {
  const b = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
  const id = b && typeof b === "object" && isId(b.id) ? b.id : null;
  if (!b || typeof b !== "object" || Array.isArray(b) || b.jsonrpc !== "2.0" || !isId(b.id) || typeof b.method !== "string") {
    return { error: { id, ...A2A_ERRORS.invalidRequest } };
  }
  return { id: b.id, method: b.method, params: b.params ?? {} };
}

export const rpcResult = (id: RpcId, result: unknown): Response => Response.json({ jsonrpc: "2.0", id, result });

export const rpcError = (id: RpcId, code: number, message: string, data?: unknown[], headers?: HeadersInit): Response =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, { headers });

/** A `google.rpc.ErrorInfo` detail for `data`: why, in a word a program can branch on, and its values as strings. */
export const errorInfo = (reason: string, metadata?: Record<string, string>) =>
  ({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "bellman.sh", ...(metadata ? { metadata } : {}) });
