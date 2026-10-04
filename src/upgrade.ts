/**
 * The WebSocket handshake's `Upgrade` header: the one reading of it, and the one 426
 * when it is absent.
 *
 * Its own module for the reason CLAUDE.md gives. Both checks live in Workers-only
 * files — `src/worker.ts`'s `/ws` route and `SessionDO.fetch` in `src/store-do.ts` —
 * which import `cloudflare:workers` and so cannot be imported by a vitest test. The
 * rule goes in a runtime-free module beside them, as `src/public-event.ts` and
 * `src/stored-session.ts` do, and `tests/upgrade.test.ts` tests it directly.
 *
 * Nothing here touches `Request` or `Response`. This module is in the NODE build,
 * whose `lib` is ES2022 with no DOM, so the caller passes the header value in and
 * builds the response from `UPGRADE_REQUIRED`.
 */

/** The protocol token, lowercase: what to compare against and what to advertise. */
export const WEBSOCKET = "websocket";

/**
 * Whether an `Upgrade` field value asks for WebSocket.
 *
 * `headers.get("upgrade") !== "websocket"` is wrong twice over, and both ways refuse
 * a handshake the server does support (#132):
 *
 * - **`Headers` normalises the field NAME, not its value.** RFC 9110 section 7.8
 *   makes the protocol token case-insensitive, and `Upgrade: WebSocket` is what some
 *   stacks send. Every client this repo drives happens to send lowercase — Node's
 *   `WebSocket`, the smoke leg, the workerd pool — which is why it went unnoticed.
 * - **The field is a LIST.** `Upgrade: websocket, h2c` is one legal value naming two
 *   protocols, and equality sees a string that is neither.
 *
 * So the value is split, trimmed and folded before the token is looked for. RFC 6455
 * section 4.1 asks only that the value *include* the keyword, which is what this does.
 * A protocol version after a slash (`websocket/13`) is a different token and is not
 * matched: RFC 6455 names no version there, and accepting a prefix would also accept
 * `websocket-ish`.
 *
 * `toLowerCase()` and not `toLocaleLowerCase()`: the token is ASCII, and a Turkish
 * locale folds `I` to `ı`, which would stop matching.
 */
export function wantsWebSocket(upgrade: string | null | undefined): boolean {
  if (!upgrade) return false;
  return upgrade.split(",").some((token) => token.trim().toLowerCase() === WEBSOCKET);
}

/**
 * The 426, as the data a `Response` is built from.
 *
 * **It names the protocol.** RFC 9110 section 15.5.22 requires a 426 to send an
 * `Upgrade` header saying what the server wants; without it the status says only
 * "not like that" and a client has nothing to discover the alternative from. This
 * answered with the status and a sentence of prose, which a program cannot read.
 *
 * The prose stays, because it is what a developer sees in a terminal, and the header
 * is what a client reads.
 */
export const UPGRADE_REQUIRED = {
  status: 426,
  body: "Expected a WebSocket upgrade",
  headers: { upgrade: WEBSOCKET },
} as const;
