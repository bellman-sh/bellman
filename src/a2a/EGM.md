# a2a

## Overview

The A2A (Agent2Agent) surface: an outside agent that holds no seat asks a public, open room a question over
JSON-RPC and reads back its own tasks. `/a2a` speaks A2A v1.0 and names the room by `tenant`; `/a2a/<tenant>`
speaks v0.3, taking the room from the path, and is translated to and from the v1.0 handlers rather than run as
a second copy. The directory also builds the AgentCards a room publishes (v1.0 and v0.3 shapes, plus Bellman's
own card); `src/http/public.ts` serves them. `src/app.ts` and `src/workerd/worker.ts` mount `a2aRoutes`.

## Interface

- `a2aRoutes(request, deps)` returns `null` for any path other than `/a2a` or `/a2a/<seg>`, else the JSON-RPC
  `Response` [src/a2a/routes.ts:a2aRoutes]
- `A2aDeps`: `store`, caller `Identity`, `suspended()`, `origin`, optional `blockCapMs` and `waitRoundMs`
  [src/a2a/routes.ts:A2aDeps]
- `BLOCK_CAP_MS = 395_000`: the longest a blocking `SendMessage` or a stream waits (Cloudflare's 400 s idle
  limit minus 5 s) [src/a2a/routes.ts:BLOCK_CAP_MS]
- v1.0 methods: `SendMessage`, `SendStreamingMessage`, `SubscribeToTask`, `GetTask`, `ListTasks`, `CancelTask`
  [src/a2a/routes.ts:HANDLERS]
- Push-config methods (`Create/Get/List/DeleteTaskPushNotificationConfig`) answer -32003; `GetExtendedAgentCard`
  answers -32007 [src/a2a/routes.ts:PUSH_METHODS]
- v0.3 method map: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`,
  `tasks/pushNotificationConfig/{set,get,list,delete}`, `agent/getAuthenticatedExtendedCard`
  [src/a2a/routes.ts:V03_METHODS]
- `isA2aPath(path)`: true for `/a2a` or `/a2a/<one segment>`, the one OAuth resource [src/a2a/routes.ts:isA2aPath]
- `v03CardTenant(path)`: the decoded tenant for `/a2a/<seg>/.well-known/agent-card.json`, else `undefined`
  [src/a2a/routes.ts:v03CardTenant]
- `toA2aTask(task, asked, historyLength?)`: an `OutsideTask` as a v1.0 `Task` with history and status message
  [src/a2a/routes.ts:toA2aTask]
- `roomCard(room, origin, how = {oauth: true})`: a room's v1.0 AgentCard with two interfaces (1.0 with tenant,
  and the 0.3 URL) [src/a2a/cards.ts:roomCard]
- `roomCard03(room, origin, how)`: the same card in v0.3 shape, `protocolVersion "0.3.0"`
  [src/a2a/cards.ts:roomCard03]
- `bellmanCard(origin)`: Bellman's own card, no tenant; its skill tells callers to name a public room
  [src/a2a/cards.ts:bellmanCard]
- `cardResponse(card, ifNoneMatch, extra)`: JSON with a SHA-256 strong ETag, `cache-control: public,
  max-age=300`, 304 on a match [src/a2a/cards.ts:cardResponse]
- Types `PublicRoomView {tenant, name, purpose}`, `CardOptions {oauth}` [src/a2a/cards.ts:PublicRoomView]
- `A2A_ERRORS`: JSON-RPC and A2A codes -32700, -32600, -32601, -32602, -32603, -32001..-32005, -32007, -32009,
  plus refused -32000 [src/a2a/jsonrpc.ts:A2A_ERRORS]
- `parseRpc(body)`, `rpcResult`, `rpcError`, `errorInfo(reason, metadata)` (a `google.rpc.ErrorInfo`, domain
  `bellman.sh`); types `RpcId`, `RpcRequest`, `RpcError` [src/a2a/jsonrpc.ts:parseRpc]

## Invariants

- Only a public, open room answers. A private, closed, missing, malformed or over-200-character tenant gets the
  same `NO_ROOM` error; a closed or private room stays readable to a caller who has tasks in it
  [src/a2a/routes.ts:readableRoom]
- A public-name tenant must equal `room.publicName`, so a name another room has since claimed does not resolve to
  the old room [src/a2a/routes.ts:readableRoom]
- POST only; anything else is 405 with `allow: POST` [src/a2a/routes.ts:a2aRoutes]
- Version gate: `/a2a` requires `A2A-Version` 1.0; `/a2a/<tenant>` accepts absent, empty or 0.3; anything else
  is -32009 [src/a2a/routes.ts:a2aRoutes]
- Suspension is checked after method and params validation and before any handler runs (-32000 `SUSPENDED`)
  [src/a2a/routes.ts:a2aRoutes]
- Text parts are the question; other parts are dropped. No text is refused -32005 and nothing is stored; a
  question whose JSON exceeds `MAX_PAYLOAD_CHARS` is refused -32602 [src/a2a/routes.ts:ask]
- Ask refusals: banned, suspended, rate_limited (`retry_after` defaults to 60), too_many_open
  (`MAX_OPEN_OUTSIDE_TASKS`), not_input_required, bad_context [src/a2a/routes.ts:askRefused]
- Tasks are scoped to the caller's `userId`: `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask` read only
  the caller's own [src/a2a/routes.ts:getTask]
- History holds only the caller's questions and the room's answers, ordered by cursor; `historyLength` 0 omits it
  [src/a2a/routes.ts:toA2aTask]
- `SubscribeToTask` on an ended task answers -32004 [src/a2a/routes.ts:subscribeToTask]
- A wait round never outlasts the remaining cap; following stops when the task settles, the cap passes, or the
  client aborts [src/a2a/routes.ts:follow]
- `ListTasks` page size is clamped to 1..100 (default 50), newest `updatedAt` first, `pageToken` a numeric offset
  [src/a2a/routes.ts:listTasks]
- A card advertises OAuth only when `oauth` is true (the Node server has bearer keys only)
  [src/a2a/cards.ts:security]

## Side Effects

- `askRoom` writes an outside question to the room's store, creating or continuing a task [src/a2a/routes.ts:ask]
- `cancelOutsideTask` changes a task's state [src/a2a/routes.ts:cancelTask]
- Long-polls the room through `store.waitForEvents`, re-reading the task row each round [src/a2a/routes.ts:follow]
- SSE stream (`text/event-stream`, `cache-control: no-store`): the task, then status updates, with a
  `: waiting` comment on idle rounds [src/a2a/routes.ts:stream]
- Re-encodes v1.0 answers and stream events into v0.3 shapes [src/a2a/routes.ts:toV03]
- `retry-after` header on rate-limited refusals [src/a2a/routes.ts:askRefused]
- `console.error` on a handler or stream failure [src/a2a/routes.ts:a2aRoutes]
- `crypto.subtle` SHA-256 of the card body for the ETag [src/a2a/cards.ts:cardResponse]

## Verification

- Run: `npm run test:worker` (`worker-tests/a2a.test.ts`, `a2a-cards.test.ts`, `a2a-v03.test.ts`)
- Run: `npm test -- tests/delivery-paths.test.ts`
- Full gate: `npm run verify`
