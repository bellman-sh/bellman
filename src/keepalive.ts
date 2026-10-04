/**
 * The keepalive's two texts, in one place (#144).
 *
 * A watching WebSocket stays open because `SessionDO`'s constructor registers
 * `setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))`. The
 * runtime answers a text frame equal to the first string ITSELF: no JavaScript
 * runs and the object is not constructed, which is the saving the hibernating
 * socket exists for. Any other text reaches `webSocketMessage`, which closes
 * the socket 1003 — receive-only is enforced there, not assumed (spec D1).
 *
 * So `PING` is a protocol, not a preference. Three programs have to agree on
 * it: the server registering it (`src/store-do.ts`), the client sending it
 * (`src/room-socket.ts`), and the fake server the end-to-end tests run against
 * (`tests/helpers/fake-bellman.ts`). Before this module each held its own copy
 * — four with store-do-wiring's assertion — tied together only by comments, and
 * nothing compiled or ran any two of them together. The fake would have gone on
 * agreeing with the client while the real server drifted.
 *
 * `PONG` matters less. Any frame at all counts as proof of life to the client's
 * timer, so a mismatch there only puts the reply through `webSocketMessage`
 * instead of the runtime — which closes the socket, so it is not free either.
 *
 * **This module must stay runtime-free**: no `cloudflare:workers`, directly or
 * transitively. It is imported by the Workers program and the Node one, and
 * `src/store-do.ts` is excluded from the Node build precisely so its types do
 * not leak. `src/oauth/storage.ts` and `src/public-event.ts` are the same rule
 * (see CLAUDE.md). Keeping it to two string constants is what makes that easy
 * to hold — resist giving it the cadence or the timeouts, which are the
 * client's policy and belong with the client.
 *
 * Drift is loud rather than silent, which is what bounds the risk here and is
 * why #144 was maintainability and not correctness. Measured against
 * `wrangler dev` (workerd 1.20260915.1): `ping` was answered `pong` with
 * nothing reaching the object across six keepalives at a 30 s cadence, while
 * `ping ` (trailing space), `Ping` and `ping\n` each woke it and were closed
 * 1003, and with the registration removed the first keepalive woke the object
 * and the client reported a drop and reconnected. So a mismatch costs
 * reconnect churn and hibernation, not lost messages.
 */

/** What a client sends to say it is still there. Matched byte-for-byte. */
export const PING = "ping";

/** What the runtime answers it with, without waking the object. */
export const PONG = "pong";
