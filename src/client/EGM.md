# client

## Overview

What a Claude Code session runs on the user's machine: the stdio bridge (`bridge.ts`, started by `channel.ts`), the
local bus that lets every bridge on a machine share one upstream connection per room (`bus.ts`, `bus-link.ts`,
`room-socket.ts`), the door socket the mod reads (`door.ts`, with its runtime-free protocol in `door-protocol.ts`),
the on-disk inbox, the Stop, status and join hooks, browser sign-in, the credential file, and the `bellman` CLI.
Nothing in `src/workerd/`, `src/index.ts` or `src/app.ts` imports a file here; a file here may import the
runtime-free modules of `src/` (`types.ts`, `keepalive.ts`, `auth.ts`, ...). `npm run build:plugin` bundles the
four entries (`channel.ts`, `stop-hook.ts`, `status-hook.ts`, `join-hook.ts`) into `plugin/bridge/*.mjs`; the npm
package runs them from `dist/client/`, and `npm run build:mod` bundles `door-protocol.ts` and `inbox.ts`
into the mod.

## Interface

- `[src/client/channel.ts]` the stdio MCP entry Claude Code spawns: reads the environment, builds the bridge, opens the door,
  starts an optional join, and shuts down on SIGTERM, SIGINT or stdin close.
- `[src/client/bridge.ts:createBridge]` the local MCP server: relays the remote tools and resources, adds `bellman_whoami`,
  `bellman_upload` and, outside channel delivery, `bellman_wait`; learns memberships from tool results
  (`observe`) and delivers peer events by `Delivery` = `channel | hook | queue`. Exposes the door's reads and
  writes (`readEvents`, `readRooms`, `readSurface`, `decline`, `writeSurface`, `setStatus`, `join`).
- `[src/client/inbox.ts]` the on-disk event queue per Claude Code pid (`enqueue`, `drain`, `discardThrough`), membership
  files, and `renderEvent`/`renderBatch`, which frame peer content as untrusted.
- `[src/client/bus.ts:openBus]` one coordinator per machine and identity serving the other bridges over a Unix socket
  (NDJSON); `[src/client/bus.ts:RoomWindow]` the coordinator's contiguous window of recent events.
- `[src/client/bus-link.ts:createBusLink]` links a bridge's watches to the bus and room sockets and hands a member back to
  polling through `onFallback`. `[src/client/room-socket.ts:openRoomSocket]` one upstream WebSocket to `/ws` per room,
  degrading to an injected `poll`.
- `[src/client/door.ts:startDoor]` an HTTP server on a Unix socket per bridge: `GET /status`, `GET /rooms`,
  `GET /rooms/<id>/events`, `GET /rooms/<id>/surface`, and the writes `POST /rooms/<id>/decline`,
  `POST /seats/status`, `PUT`/`DELETE /rooms/<id>/surface/<key>`. `[src/client/door-protocol.ts]` the runtime-free shapes
  shared with the mod (`DOOR_VERSION = 1`, `cleanText`, `cleanBlock`, `eventLine`, `herdrTerminalOf`, `joinLine`). `GET /status`
  names the Herdr terminal the bridge runs in as `herdr_terminal`, from a well-formed `HC_TERMINAL_ID`, and omits it
  otherwise `[src/client/door.ts:statusOf]`.
- Hooks: `[src/client/stop-hook.ts]` (drains the inbox, exits 2 to keep the turn going), `[src/client/status-hook.ts:statusFor]`
  (`working` / `needs_you`), `[src/client/join-hook.ts]` (prints `[src/client/door-protocol.ts:joinLine]`; without
  `BELLMAN_JOIN_CODE`, only for a join `from: "repo"`).
- The join at launch, `[src/client/repo-remote.ts:launchJoin]`: `BELLMAN_JOIN_CODE` wins (`[src/client/bridge.ts:join]`);
  else the cwd's `origin` (`[src/client/repo-remote.ts:remoteOf]`, git then `jj --ignore-working-copy git remote list`, normalized by
  `[src/room/remote.ts:normalizeRemote]`), when `GET /me/repo-rooms` lists it (so an unbound remote never leaves the
  machine), goes to `POST /me/repo-rooms/connect` and the token to `bellman_confirm`
  (`[src/client/bridge.ts:joinBound]`), only after the first tools/list, so the handshake stays local. No binding, no
  credential or a server without the route says nothing; any other outcome is `joined` with `from: "repo"`, and in
  channel delivery the bridge pushes `joinLine` once the client has initialized. Seats taken this way are kept in
  `boundSeats`, and `close()` leaves them (`bellman_leave` through the held connection, at most `leaveTimeoutMs`, 3 s,
  in all) before anything else shuts; a seat joined by hand or from a code stays.
- `[src/client/signin.ts:connectSignedIn]` browser OAuth with PKCE on a loopback callback (`CALLBACK_PORTS` 51004-51008);
  `[src/client/signin.ts:signedInAs]`. `[src/client/credentials.ts]` the credential file (`readServer`, `writeServer`,
  `acquireLock`, `busCredentials`).
- `[src/client/cli.ts:run]` the `bellman` command: `help`, `version`, `feature-request`, `update [--check]`, `doctor`.
  `[src/client/doctor.ts:diagnose]` read-only checks with a fix command for each finding.

## Invariants

- Push is never a dependency. `[src/client/bridge.ts:viaBus]` hands a member back to the long-poll `watch` from the shared
  cursor on bus failure; `[src/client/bus.ts:openBus]` turns every setup failure into `BusUnavailableError`;
  `[src/client/room-socket.ts:drive]` degrades to polling after 3 failures or a refused credential. Delivery is deduplicated
  by cursor (`[src/client/bridge.ts:watch]`, `[src/client/bus.ts:Sub.sentThrough]`, `[src/client/room-socket.ts:accept]`).
- `[src/client/bridge.ts:watch]` never creates a connection; a watcher whose connection is gone disarms instead.
  `[src/client/bridge.ts:showsEvictionOf]` trusts only `member_evicted` and `member_timed_out` event types, so a peer payload
  cannot forge an eviction.
- Sockets are created 0600 by narrowing the umask around `listen` (`[src/client/bus.ts:listen]`, `[src/client/door.ts:startDoor]`) in
  directories created 0700; those permissions are the door's only access check.
- `[src/client/bridge.ts:readLocalFile]` refuses symlinks, paths outside the upload root, non-regular files and files over
  `MAX_BLOB_BYTES`; `[src/client/bridge.ts:uploadRoot]` refuses an implicit root that is `/`, the home directory or one of
  its ancestors.
- `[src/client/credentials.ts:replaceFile]` writes through a 0600 temp file and an atomic rename; `[src/client/credentials.ts:writeServer]`
  refuses to write when the directory or file cannot be secured. `[src/client/signin.ts:BridgeAuth.saveCodeVerifier]` keeps
  the PKCE verifier in memory only, and the loopback listener compares `state` itself
  (`[src/client/signin.ts:makeListener.onRequest]`).
- `[src/client/bridge.ts:createBridge]` never declares the `claude/channel/permission` capability, so a peer cannot approve
  tool use in a session; `[src/client/bridge.ts:CHANNEL_INSTRUCTIONS]`, `HOOK_INSTRUCTIONS` and `QUEUE_INSTRUCTIONS` each
  tell the agent an `action_request` needs its human's approval.
- `[src/client/door-protocol.ts:cleanText]` strips escape sequences, controls and bidi characters before the mod draws a
  peer string; `[src/client/door-protocol.ts:lineOf]` reads an `action_response` from `approved` alone.

## Side Effects

- Client filesystem: credentials under `$XDG_CONFIG_HOME/bellman` or `~/.config/bellman` (`credentials.json`,
  `credentials.lock`) `[src/client/credentials.ts:credentialsDir]`; inboxes under `~/.claude/bellman/inbox/<pid>/`
  `[src/client/inbox.ts:inboxRoot]`; bus sockets under `~/.claude/bellman/bus/` `[src/client/bus.ts:busRoot]`; door sockets under
  `~/.claude/bellman/door/` `[src/client/door.ts:doorRoot]`; reads `.bellman/room.yaml` from the working directory
  `[src/client/bridge.ts:loadRoomManifest]`.
- Client processes and network: a loopback HTTP listener on 127.0.0.1:51004-51008 and a detached browser launcher
  `[src/client/signin.ts:openBrowser]`; MCP over Streamable HTTP to `BELLMAN_URL` (default `https://mcp.bellman.sh/mcp`)
  `[src/client/channel.ts]`; WebSockets to `/ws` `[src/client/room-socket.ts:attempt]`; `ps` for parent pids `[src/client/inbox.ts:parentPid]`;
  `npm` and `claude --version` from the CLI `[src/client/cli.ts:update]`, `[src/client/doctor.ts:diagnose]`.

## Verification

- Run: `npm test` (the bridge, bus, door, inbox, hook, sign-in, credentials and CLI tests under `tests/`).
- Run: `npm run build:plugin` after changing an entry or anything it imports; the committed bundles are rebuilt by
  every release PR (`tests/plugin.test.ts`).
- Run: `npm run verify` before every commit; it includes `test:mod`, which runs the mod's kit tests against the
  bundled door protocol.
