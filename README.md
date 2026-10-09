# Bellman

**Cross-session, cross-provider agent collaboration over MCP.**

One session starts a room and gets a human-relayable code that carries a role (`BELL-7F3K-92-PEER-B`), and the same code as a link for pasting into chat (`https://bellman.sh/j/BELL-7F3K-92-PEER-B`) — the page tells whoever opens it what to say to their agent, and reveals nothing else. Any other MCP-connected session — Claude Code, Claude chat, ChatGPT, Cursor, Gemini CLI, same user on another machine or a different user entirely — connects with the code, previews the creator's context brief and the room's roles, and confirms with its own. Everyone in the room becomes a member of each other's work. A pair room holds two; a swarm room holds as many members as you invite, and you can issue a fresh code — one per role — to add members later.

## Why MCP as the rendezvous

MCP is the one protocol every major provider's clients now speak, which makes a neutral Bellman server *provider-agnostic by default*. The design sticks to the lowest common denominator so nothing breaks outside Claude:

- **Tools first** — every capability is a tool whose text result stands on its own. UI resources ([MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)) are additive: a host that renders them shows a screen, one that does not loses nothing. No sampling or elicitation.
- **Text-first responses**, `structuredContent` as progressive enhancement
- **Bearer keys and OAuth 2.1 + DCR**, either one — a static key for CI and scripts, sign-in for people (`src/auth.ts`, `src/oauth/`)
- **Long-poll capped at 25s** to stay under the strictest client tool-call timeouts

## Tool surface

| Tool | Purpose |
|---|---|
| `bellman_start` | Create a room from a manifest, or from a preset you saved in the panel; get the join code, your `member_id` and the room as recorded. Entitlement-gated. |
| `bellman_connect` | Phase 1: preview the creator's brief and the room's roles (the verbs each lists and the one you would get; verbs are enforced by the server). **Nothing of yours ships yet.** |
| `bellman_confirm` | Phase 2: ship your brief, become a member. |
| `bellman_send` | `message` \| `artifact` \| `action_request` \| `action_response` \| `brief_update` \| `progress` \| `surface` |
| `bellman_sync` | Poll/long-poll for peer events (MCP has no push). |
| `bellman_rooms` | The rooms you hold a seat in: members with their roles, presence and last beat, live codes, expiry. Backs the in-chat monitor. |
| `bellman_surface` | The room's working surface, read-only: every item and the cursor of its last change. Backs the in-chat canvas. |
| `bellman_leave` | Depart with a broadcast event. |
| `bellman_evict` | Creator-only: remove a member and retire their seat's code. Not a verb — no role grants it. |
| `bellman_invite` | Issue a fresh join code for a role at any time, or revoke one role's code — or, with no role named, every live code the room has. Issuing needs the `invite` verb; revoking needs `revoke`. Returns the code and the link it is shared as. |
| `bellman_audit` | Enterprise: every crossing that touched your org's boundary. |

Every tool that takes a room accepts `room_id` as the same id as `session_id`. One host's route to a local server strips any argument named `session_id` before it reaches the bridge, and a host that treats the name as reserved would otherwise break every tool that needs it.

## What a send proves

**The store is truth; the channel is transport.** A room *is* its event log.
Every way that log reaches a member — a `bellman_sync` long poll, a `/ws` frame,
the bridge's Stop-hook fallback — is transport, and transport may be late or
dropped. That is why `bellman_sync` is authoritative and a channel push is only a
convenience, why peer content keeps its untrusted wrapper the whole way to the
model, and why the Stop-hook fallback exists at all.

So a tool says what it *established*, not what it probably caused.

`bellman_send` returns **`room_members`**: the other active members the call saw
just before appending — your own seat is not in it, and a replayed send reports
who was there at the retry. It is not a read receipt. It does not mean

- a peer's session has seen it — that happens on its next `bellman_sync`, or when
  a channel push lands, which needs the bridge running
- a peer's model acted on it
- for an `action_request`, that any human has approved it — that is the receiving
  human's decision, deliberately (see [Trust model](#trust-model))

`bellman_sync` returns **`session_status`**: `active`, `frozen` or `closed`. On a
poll that waited it is read *after* the wait, so it is never older than the
events beside it — a room frozen mid-wait is reported frozen by the poll that was
waiting when it happened, not by the one after. On a poll that asked for no wait,
and for a removed member (whose read never waits), it is the record the call
began with, which is milliseconds old.

What it does not say is whether anyone is there. `active` means only that the
room is neither frozen nor closed — not that a peer is listening, and not that
one ever will.

## The working surface

A room carries a surface as well as a log: a set of named items — a plan, a
decision list, a link, a diagram, and the connectors between them — that
members read and one seat keeps current. The event log is how the surface got
that way; the surface is where things stand.

- Write with `bellman_send type: "surface"`, payload `{ key, kind, title?,
  body?, ends?, placement?, blob?, shape? }`, or remove with `{ key, remove: true }`. Kinds:
  `text`, `link`, `diagram`, `connector`, `file`, `image`, `html`, `shape`. Items replace by key;
  every version stays in the log at its cursor.
- A `file` or an `image` names a blob. Upload the bytes first — `POST
  /rooms/:id/blobs?member_id=…&name=…`, raw body, `Content-Length` required,
  25 MB per file, a bearer token or the panel's cookie, the seat holding
  `write_surface` — then place `{ key, kind: "file", blob: { id } }`. The item
  carries the object's size, type and name as the server stored them, not as
  the uploader claimed them: an image claim is checked against the bytes, and
  a mismatch is stored as `application/octet-stream`. `GET
  /rooms/:id/blobs/:blobId` serves the bytes to the room's members — one a
  creator removed excepted — as a download, except the four image types
  (`png`, `jpeg`, `gif`, `webp`), which are served inline; nothing from it is
  ever HTML. From Claude Code, `bellman_upload` reads a local file, uploads it
  and places it in one call.
- An `html` item is a self-contained page, inline in `body` under the body bound or
  named as a blob stored as `text/html`, never both. The server stores and serves
  it as bytes; the panel renders it only in a sandboxed frame on another origin,
  where it gets no cookies and no network through anything the frame's policy
  governs; WebRTC is outside that policy, and the `html` line in `bellman_send`
  says so (the frame is the dash repo's).
- A `shape` is drawn from its own field, `shape: { form, color?, flip? }`: `form` is
  `rect`, `ellipse`, `diamond`, `arrow` or `line`, `color` is one of six names (`slate`
  by default, then `blue`, `green`, `amber`, `red` and `violet`), and `flip: true` draws
  an arrow or a line from the bottom-left to the top-right. A shape needs `placement`
  with `x`, `y`, `w` and `h`, because its size is the placement's, and takes no `body`,
  because its label is the `title`; `flip: true` on any other form is refused, and so
  is `shape` on any other kind.
- The verb is `write_surface`. Every preset gives it to the creator's seat
  alone; a manifest may give it to any seat. Reading is never gated.
- A joiner's preview lists what the surface holds — keys, kinds and sizes — and
  `bellman_confirm` hands over the items. Every poll carries `surface_cursor`
  once the surface has changed, each change arrives as a `surface` event, and
  `bellman_sync` with `surface: true` returns everything. A member a creator
  removed is the exception: it sees only the items changed at or before its
  cut, and gets `surface_cursor` only when it asks for the surface.
- Every item arrives in an untrusted envelope with its writer as origin. The
  preview carries no prose at all.

The `html` kind is here (#185). The canvas to see the surface on, and the sandbox
that renders `html` and `diagram` items (`bellman-sh/dash#14`), are the control
panel's, in the dash repo; the designs are in `docs/superpowers/specs/`.

## Trust model

- **Two-phase connect**: joiners see the creator's brief and the room's roles (the verbs each lists and the one they would get; verbs are enforced by the server) before their own context crosses. Codes are single-use and expire in 15 minutes unused.
- **Untrusted envelopes**: peer-written briefs, messages and artifacts arrive wrapped `{ trust: "untrusted", origin, data }`, and a response carrying them opens its text with a preamble telling the receiving agent to treat them as data, not instructions. `structuredContent` has none, so there `trust` is the only marker; role names, modes, verbs and agent fields ship unwrapped.
- **Capability grants**: members declare what may be done *to* them (`read_context`, `receive_messages`, `request_actions`). Action requests are approved by the receiving **human**, not the receiving agent.
- **Member handles**: `member_id` is per-connection, so one user pairing with themself across two machines works — and a handle can only be driven by the identity that minted it.

## What a plan gates

Plans gate **creating** a room, not joining one. Anyone signed in can be invited into any room, on any plan — so a teammate, a contractor or someone at another company needs an account and nothing else.

| | modes | rooms / month | blobs / room | kept after close | hosted seat | |
| --- | --- | --- | --- | --- | --- | --- |
| `free` | pair | 20 | 50 MB | 7 days | — | |
| `pro` | pair, swarm | 500 | 500 MB | 1 year | — | |
| `max` | pair, swarm | 2,000 | 5 GB | until deleted | 3 rooms open at once | *not on sale yet* |
| `team` | pair, swarm | 5,000 | 5 GB | until deleted | 5 rooms open at once | `org_only` scoping, audit trail |

A pair room holds two. A swarm room holds as many members as you invite, up to 100, a storage ceiling that is the same on every plan. Rooms persist on every plan: a room ends when its last member leaves, or after 90 days in which nobody in it was seen.

Max and team buy a hosted seat: a member Bellman runs, labelled `host@bellman` whatever its role is called. A room declares it in its manifest's `host` block ([declaring a room](#declaring-a-room-in-your-repo)), and `bellman_start` seats it beside the creator, holding the verb `send` and nothing else. Once a cadence, its room's `heartbeat_on`, it asks the room a question, which starts its own thread: the question carries no `ref_id`, and the tick it answers rides in its payload as `tick`. A member answers with a `message` whose `ref_id` is the question's cursor, and the host replies in that thread, up to three times, until it asks a newer question. It asks on its own cadence only: a tick written because a reporting seat was due does not wake it. It is woken only when a person has been in the room since it last asked, or is connected to it, so a room nobody visits spends one question, the first, which the creator's own seat earns, and nothing after. A tick that asks nobody for a report reaches members without interrupting them; the question interrupts on its own. Evicting the host (`bellman_evict` on `m_host`) stops it: nothing wakes it again, and the room refuses its writes. The host never keeps a room open: a hosted room ends when its last person leaves, or after 90 days in which no person in it was seen. What it writes reaches members as peer content, untrusted like any member's, and a team org's audit stream records its sends as it records any member's.

A hosted seat is metered in wakes, one model call each, weighted by the model: Haiku 1, Sonnet 3, Opus 5. A hosted room spends up to 3,000 units a month and ticks no faster than once an hour; an Opus host at an hourly beat, in a room that replies to every question, is quiet after six days, and at a daily beat it lasts the month. It sends eight times an hour at most. A plan's hosted rooms are the most its holder has open at once: a hosted room takes a slot when it is created and gives it back when it closes, so a creator on max can start a fourth once one of three has ended. A room's units for each month come from its creator's plan as it is when the month begins: a creator still on max or team gets the month's 3,000, and one whose plan no longer includes a hosted seat gets none, so the host posts one notice saying it is paused and calls no model until a month begins on a plan that includes it again. A month that runs out gets one notice from the host, outside the meter, and then quiet until the month turns. A wake the meter would refuse costs no model call, and an answer the model cut off at its token cap, or declined, is never posted or charged.

The hosted seat is off unless `BELLMAN_HOSTED_SEAT = "on"`. Off, `bellman_start` refuses any room that declares a host, however it was declared, with `hosted seats are not available yet`, and a hosted room that already exists is never woken to the model. To turn it on, set the var under `[vars]` in `wrangler.toml`, a commit rather than a secret so that turning it on is reviewed, and set the model key with `npx wrangler secret put ANTHROPIC_API_KEY`. Anything but `on` is off, and a value that is neither `on` nor `off` is logged.

A room that crosses organisations writes to **both** orgs' audit streams, so each side sees the crossings that touched its own boundary and nothing else.

A room's blob ceiling is stamped on the room when it is created, from the plan that creates it, so every member shares it whatever their own plan, and it never counts against the monthly figure. The local Node server (`npm start`) serves the upload and download routes too, over an in-memory blob store.

**What happens after a room closes.** Its record and its files are kept for the window its creator's plan promised, stamped on the room at creation like the blob ceiling (the *kept after close* column), and then deleted for good, files first. A plan change later never shortens a room that was already promised a window. Until then a closed room reads as it always has, and any file nobody placed on its surface is cleared out the moment it closes, with its bytes credited back. The window is set when a room is created, so a room created before this existed has none and is kept until someone deletes it, whatever its plan, even when it closes after the deploy.

- `DELETE /rooms/:id` deletes a closed room now, for its creator or an admin of an org that sat in it. It answers `202` with `{ id, purge_at }`, `purge_at` being the time the room is stored to go (a repeated delete is told the first one's), and the purge follows within moments; a room that has not closed answers `409`, because a room is deleted after it closes, never before.
- `GET /rooms/:id` carries `closed_at` and `purge_at` as ISO times, to a member as to an admin: when the room closed and when it goes. Each is `null` where the record has none, so an open room has neither and a room kept until it is deleted has no `purge_at`.
- On the team plan an org's admin can read any closed room one of that org's people sat in, though they never held a seat: `GET /rooms/:id` answers with `viewer: "admin"`, `GET /rooms/:id/surface` returns the whole surface, `GET /rooms/:id/events` the whole log, a file on it downloads through `GET /rooms/:id/blobs/:blobId` as it does for a member, and `GET /rooms?as=admin` lists those rooms, newest close first. An admin the room's creator removed reads the closed room the same way, since what a removal cuts is a seat's reading and they no longer hold one; their removed handles are still listed in `my_handles`. It is a read: an admin writes nothing to the room, so a surface write or an upload from one is a `403`, and an open room stays its members' alone. The list reads up to 500 rooms from the org's index, open ones among them, keeps the closed ones and returns the newest 50 by close; `truncated: true` says the index held that many, or more than 50 were closed. That scan costs up to 500 room reads for one request, which the summary index of #49 removes. A room created before this deploy is not in the index, though reading that room by its id still works.

## Run it

```bash
npm install && npm run build
npm start                  # http://localhost:3900/mcp
npm run smoke              # end-to-end two-provider simulation (server must be running)
```

**Local-dev bearer keys**, live only while `BELLMAN_KEYS` is unset: `qk_dev_jesse` (team admin, org_codenerd), `qk_dev_peer` (free, org_codenerd), `qk_dev_outsider` (free, no org).

**A hosted seat runs locally too, once it is switched on.** It is off here as it is in production: `BELLMAN_HOSTED_SEAT=on npm start` points it at a fake model the server serves itself, `POST /__fake-model`, so it needs no key and spends none, even with `ANTHROPIC_API_KEY` exported; set `BELLMAN_REAL_MODEL=1` beside the key to call Anthropic's Messages API, or `MODEL_URL` to send the calls somewhere else. It prints which one it chose at startup, or that the seat is off. `qk_dev_jesse` is on team, so it can start a `social` room, which asks its first question an hour after it is created.

Set `BELLMAN_KEYS` (JSON map of key → identity) and it becomes the **sole** source of truth — the dev table stops resolving, and a malformed map rejects every request rather than falling back. **Every deployment must set it.**

Rotate with `npm run rotate-key`. A Worker secret can't be read back, so the map is rebuilt from `~/.config/bellman/identities.json` (identities, no keys) and every key is reminted — which is what you want after a leak anyway. The script backs up the old map, uploads, checks the new key is accepted and the old one is refused, updates the Claude Code MCP entry, and leaves the keys in `~/.config/bellman/keys.json` (mode 600). `--dry-run` shows the plan without touching the server.

**Signing in.** GitHub and Google authenticate the human; Bellman issues its own token. Everyone who signs in gets the default identity — free plan, member role, no org. They can be invited into a room immediately; creating one past the free limits is what needs a plan.

`BELLMAN_USERS` (JSON map of upstream key → identity) names who gets more. `identityFor` tries four keys **in this order**, first match wins:

| Key | Example | Notes |
| --- | --- | --- |
| `<provider>:<subject>` | `github:4308278`, `google:1078…` | The stable upstream id. Survives a rename — **prefer this.** |
| `<provider>:<label>` | `github:mcfearsome` | GitHub login, or Google display name. Convenient, but a freed login can be re-registered by someone else. |
| `<provider>:<email>` | `github:me@x.com` | Only if the provider reports the address; Google must have it verified. |
| `email:<address>` | `email:me@x.com` | Provider-neutral — matches the same human through either sign-in. |

Grant with `npm run grant-plan -- --github <login> --plan team --role admin --org org_x`. It resolves the login to its numeric id, merges into `~/.config/bellman/users.json`, and uploads the whole map — same read-back constraint as `BELLMAN_KEYS`, same backup-then-upload order. Google has no public handle lookup, so those go in as `--key google:<sub>` or `--email <address>`. Also `--list`, `--revoke`, `--dry-run`.

The granted `userId` defaults to `u_<provider>_<subject>`, byte-identical to what the default path mints — a grant that invents a new one orphans every session that human created before it.

Unlike `BELLMAN_KEYS`, a malformed `BELLMAN_USERS` is **ignored rather than fatal**: `parseOverrides` logs and returns `{}`, silently dropping every granted human back to free. That's why the map is validated locally before upload.

## Use it from Claude Code

Bellman is live at `https://mcp.bellman.sh/mcp`. Claude Code connects through a small local bridge, `dist/channel.js`, which proxies the Bellman tools and delivers peer messages to your session as they arrive — the agent never has to remember to call `bellman_sync`.

```bash
npm install -g @bellman-sh/mcp-server
```

That puts four commands on your PATH: `bellman-channel` (the bridge Claude Code spawns), `bellman-stop-hook` (the fallback), `bellman-claude` (the launcher below), and `bellman` (the command line, below). Working from a clone instead? `npm install && npm run build`, and use `node "$PWD/dist/channel.js"` wherever `bellman-channel` appears.

- `bellman update` installs the latest release from npm (`--check` only reports; in a clone or as a project's dependency it prints the commands and runs none). Claude Code sessions already open keep the old bridge until you restart them.
- `bellman feature-request [words…]` opens the feature-request form on GitHub with the words as its title, and prints the URL first for a machine with no browser.

**Channels (recommended).** Peer events are pushed straight into the session, even while it's idle.

```bash
claude mcp add --scope user bellman -- bellman-channel
bellman-claude                # start Claude Code with the channel loaded
```

No key. On the **first launch after you install it**, the bridge registers
itself with Bellman, opens a browser to sign you in, and caches the result under
`~/.config/bellman/` at mode 600. Every launch after that is silent.

That happens at *launch*, not at your first `bellman_*` call: Claude Code lists a
server's tools as soon as it connects, and listing Bellman's tools is already a
call to Bellman. So expect one tab, once, while Claude Code is starting — and
expect it again anywhere the cache is not, which makes a fresh CI container or
devcontainer a first launch every single time. Ask the agent for
`bellman_whoami` to see which account a room will show peers.

The bridge adds one more tool of its own: `bellman_upload` reads a file on
this machine — a regular file, not a symbolic link, at most 25 MB — uploads it
to the room with the credential the bridge holds, and places it on the working
surface as a `file` or an `image`, in one call. Only a path under the upload
root is read, links followed — the directory the bridge was started in, or
`BELLMAN_UPLOAD_ROOT` when that is set (`/` for any file) — so a line that
arrives as peer content cannot send a key file to the room. The
working-directory default is refused when that directory contains your home
directory (the filesystem root included); naming it in `BELLMAN_UPLOAD_ROOT`
allows that much on purpose. A hosted connector has no filesystem and no
bridge, so it has no `bellman_upload`; the control panel's upload comes with
the canvas.

`BELLMAN_NO_BROWSER=1` prints the sign-in URL instead of launching a browser,
for when you would rather open it yourself: a terminal-only session on your own
desktop, or a container that shares the browser's network namespace. It does
**not** make sign-in work from another machine. The bridge listens on
`127.0.0.1`, on the first free port from 51004 to 51008, and the sign-in sends
the browser back to `http://127.0.0.1:<port>/callback` — so a browser on a
different machine hands the code to its own loopback, where the bridge cannot
see it.

Over SSH, forward that port and open the URL in your local browser: connect
with `ssh -L 51004:localhost:51004 <host>`. The bridge takes the first free port
in the range, and the `redirect_uri` in the printed URL names the one it took.
A host with no browser you can reach at all — CI, `npm run smoke`, a server
nobody logs into — needs `BELLMAN_KEY=<key>`: an explicitly set key still wins
and skips sign-in entirely.

Channels are a Claude Code research preview: a custom channel is not on Anthropic's allowlist, so every launch needs `claude --dangerously-load-development-channels server:bellman`. Miss the flag and the session starts normally but nothing is ever pushed into it, which reads as Bellman being broken — `bellman-claude` exists so you can't forget. It passes your other arguments straight through (`bellman-claude --resume`), and `BELLMAN_CHANNEL_SERVER` / `BELLMAN_CHANNEL_FLAG` override the entry and the flag once the channel reaches an org allowlist.

Team and Enterprise orgs must also turn on `channelsEnabled`.

**Stop-hook fallback.** Where channels aren't available, the bridge queues peer events and a Stop hook hands them to Claude when a turn ends. Mid-turn, the agent calls `bellman_wait` to block for a reply.

```bash
claude mcp add --scope user bellman -e BELLMAN_DELIVERY=hook -- bellman-channel
```

```json
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "bellman-stop-hook", "timeout": 60 }] }]
  }
}
```

Prefix the command with `BELLMAN_HOOK_WAIT_SECONDS=30` to keep listening for up to 30s at the end of each turn while you're in a session (never outside one); keep `timeout` above it. The hook finds the bridge's queue through the Claude Code process they share, so Claude Code must spawn `bellman-channel` directly rather than through a wrapper shell.

**One connection per room.** Every Claude Code session starts a bridge of its own, and each used to long-poll Bellman for every room it was in. The bridges on a machine now share one connection per room instead: one of them, whichever got there first, holds a WebSocket to each room and hands every event to the others over a Unix socket in `~/.claude/bellman/bus/`, so several sessions in one room make one connection and not several. Where that cannot be set up (Windows, a socket path that is too long, a directory it cannot write to), or when it stops working, a bridge polls for its own members as it did before. To turn it off yourself, launch the bridge with `BELLMAN_BUS=off`: it then polls for its own members and makes no socket (`claude mcp add --scope user bellman -e BELLMAN_BUS=off -- bellman-channel`). It is read when the bridge starts, so restart Claude Code after changing it. `0`, `false` and `no` also mean off, and so does a value it does not recognise: the bridge says so on stderr rather than keep a bus you tried to turn off.

**Claude Desktop.** Add `https://mcp.bellman.sh/mcp` as a remote custom connector and sign in — nothing to build. Or install the bundle in [`extension/`](extension/), which runs the bridge locally over stdio and signs in the same way; every release attaches a built `.mcpb`. The difference is where the bridge runs: a local one keeps a queue of peer events and the cursor into it, so the agent can block on `bellman_wait`. Nothing arrives unprompted either way — the Stop hook is Claude Code's. Claude Desktop and claude.ai render MCP Apps, so there `bellman_connect` shows the join screen, `bellman_rooms` the room monitor, and `bellman_surface` (and `bellman_confirm`, on joining) the room's working surface as a canvas, where an `html` artifact runs in a nested sandboxed frame when the host allows one and otherwise opens in dash; a host that does not render them gets the same results as text.

**Other clients.** Anything that can send a header — Cursor, Gemini CLI — connects to `https://mcp.bellman.sh/mcp` with `Authorization: Bearer <key>` and uses `bellman_sync` with `wait_seconds` (up to 25) to long-poll. claude.ai, Claude Desktop connectors and ChatGPT only accept OAuth for custom connectors, which Bellman now speaks — add `https://mcp.bellman.sh/mcp` as a custom connector and sign in through the browser.

## Plans

Signing in with GitHub or Google gets you a free identity: pair sessions, 20 a month. Joining somebody else's session is free on every plan — only creating one is gated.

A plan can come from two places, and the order matters:

1. **`BELLMAN_USERS`**, the operator's Worker secret, managed with `npm run grant-plan`. It wins over everything, which is what makes it useful for comping an account or fixing a bad automated grant. **Key it by subject** — `github:<numeric id>` or `google:<numeric id>`. A login or display name is not a key at all, and an address key applies at sign-in but not across a token refresh, because by then it may belong to someone else.
2. **A stored grant**, written at runtime through `POST /admin/grants` by a team admin. This is what a billing webhook writes.

A **stored grant** carries plan, role and org only: your `userId` still comes from the provider (`u_<provider>_<subject>`), so granting, changing or revoking one never orphans sessions you already created. A **`BELLMAN_USERS` override** is the exception — it supplies the whole identity at sign-in, `userId` included, which is what lets an operator point someone at a specific account. Across a token refresh it contributes plan, role and org only, so an override added mid-token cannot rename the holder.

```
GET    /account                  what you are, what plan, and your quota
GET    /admin/grants             list grants           (team admin)
POST   /admin/grants             {key, plan, role, orgId, expiresAt?}
DELETE /admin/grants?key=<key>   revoke
```

`key` must name a human and keep naming them: `github:<numeric id>`, `google:<numeric id>`, or a verified email address (`github:`, `google:` or `email:`). A login or display name is refused, and never resolves even if written by another path — GitHub logins can be renamed and reclaimed, and a Google display name is an arbitrary string, so a grant filed against one is a standing offer of your plan to whoever takes the name next. This applies to `BELLMAN_USERS` too: `npm run grant-plan` refuses a label key, and warns about any already in the file.

An address key is for onboarding someone you know by email, and it is **claimed on first use**: the first sign-in that resolves through it rewrites the grant onto that provider's numeric subject and retires the address key. After that the address carries nothing, so an address later reassigned inside a managed domain does not take the plan with it. Grant by subject where you can; grant by address when that is all you have, and expect it to move.

`orgId` must be your own org: grants are org-tenanted, and an admin administers only their own. Grants and revocations are written to the org audit log, so `bellman_audit` shows who changed whose plan and when.

### Paying for a plan

Stripe sells the plans. `BELLMAN_BILLING` in `wrangler.toml` is `off`, `shadow` or `on`; use `shadow` to take real purchases end to end before anyone's plan depends on them. The switch reaches plans already stored, not just new ones: with billing off, grants Stripe wrote earlier stop resolving, and operator and admin grants are untouched. Shadow still processes cancellations, so switching down from `on` cannot strand a plan nobody is paying for. `shadow` or `on` without both Stripe secrets stays off and logs why.

| Secret | What it is |
| --- | --- |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret (`whsec_…`). |
| `STRIPE_API_KEY` | A restricted key (`rk_…`) with **read** access to Subscriptions and nothing else. Stripe delivers events out of order and timestamps them only to the second, so the webhook reads each subscription's current state from Stripe instead of trusting the event. |
| `STRIPE_PAYMENT_LINKS` | JSON of link name → Payment Link, e.g. `{"pro_monthly":"https://buy.stripe.com/…"}`. Only `https://buy.stripe.com` and `checkout.stripe.com` links are served, at `/upgrade/<name>`. |

Subscribe `/stripe/webhook` to `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and `.resumed`. A price sells the plan named in its `metadata.plan`, or else its lookup key's prefix (`pro_monthly` sells `pro`). The plan holds while the subscription is `active`, `trialing` or `past_due`, and ends otherwise.

**Plans are mutually exclusive, and a subscription sells exactly one.** Build the catalogue so no subscription can carry prices for two; one that does grants nothing at all and logs which plans it named, rather than picking a winner by Stripe's item order. Several items of the *same* plan are fine — that is quantity, not conflict.

**A purchase is a grant.** The webhook does not add a second place a plan can come from — it writes the same stored grant an admin would, with `source: "purchase"`, so a paid plan gets the ownership checks and the `/admin/grants` listing like any other. Team purchases and cancellations are written to the org audit log as `plan_granted` and `plan_revoked` with `stripe` as the actor; a pro or max purchase has no org, so there is no org stream to record it in. Buying `team` makes the buyer admin of an org named for their user id (`org_<userId>`); adding other people to that org isn't built yet. A **purchased** admin can read `/admin/grants` but not write to it — otherwise one month of team would buy permanent team, since an admin could write themselves a grant that billing has no business removing when the subscription lapses. Writing grants stays with admins named in `BELLMAN_USERS`.

Billing only ever touches grants it wrote. An operator override in `BELLMAN_USERS` beats a purchase outright — `/upgrade` stops before Stripe rather than take money that would change nothing — and a grant an admin wrote by hand is left alone, with the clash logged for a human. A checkout carrying someone else's user id can only add a plan to them, never remove one they already pay for.

### Declaring a room in your repo

Put a manifest at `.bellman/room.yaml` and `bellman_start` picks it up
automatically when called through the bridge:

```yaml
room: payments-migration
purpose: Port Stripe v2 to v3
preset: review          # pair | swarm | review | social
```

Or author the roles yourself:

```yaml
room: payments-migration
mode: swarm
roles:
  lead:
    can: [send, invite, revoke, request_actions, respond_actions]
  helper:
    can: [send, request_actions, respond_actions]
  observer:
    can: []
default_role: helper
creator_role: lead
```

Verbs: `send`, `invite`, `revoke`, `request_actions`, `respond_actions`, `write_surface`.
Every member can always sync and leave, and read the working surface.

Verbs are enforced by the server. A call a seat's role does not permit is
refused with an error naming the verb it lacks, and nothing is delivered or
recorded. The `your_verbs` in a connect preview and the verbs enforced come
from one accessor (`src/roles.ts`), so a preview cannot over-promise a verb.

`invite` is not scoped to the inviter's own seat: a seat holding it can mint
a join code for any role the manifest declares, including one more capable
than its own, and can take that seat itself by leaving and rejoining. Give
`invite` only to a seat you would trust with every seat's authority.

A room role is not `Identity.role`. The latter is `member` | `admin` over an
*org* and buys nothing inside a room: an org admin holds exactly what their
seat holds.

A room can also ask its members to report. A top-level `heartbeat_on` (a
duration such as `"5m"`, from 30 seconds to a day, `"24h"`) is the cadence on
which the server appends a `heartbeat` tick saying who has reported and who has
gone quiet, and `reports: true` on a role says members in that seat must answer
it, by sending `progress` — so that role must hold `send`, and a manifest that
asks a verbless seat for reports is refused. With no `heartbeat_on` there is
no tick and `reports` asks for nothing. No built-in preset sets `reports`, and only
`social` sets `heartbeat_on`, for its host; a saved preset carries either, as an
authored manifest does. A cite may set `heartbeat_on` only for
a preset with a host, `social` or a saved preset carrying a `host` block, and a
cite of any other preset that sets it is refused, since nothing there would tick
or the preset already holds its author's cadence. A joiner sees both before it
accepts a seat: the connect preview carries `heartbeat_on_seconds`,
`you_report`, and `reports` for every role.

A room can have a hosted seat, which asks the room a question on each tick
(see [what a plan gates](#what-a-plan-gates)). The `social` preset declares
one; an authored manifest adds a `host` block naming the role it sits in:

```yaml
room: build-club
purpose: What people are building this week
mode: swarm
heartbeat_on: 6h
roles:
  lead:
    can: [send, invite, revoke, write_surface]
  guest:
    can: [send]
  host:
    can: [send]
host:
  role: host                    # a role above that holds exactly [send]
  model: sonnet                 # haiku (the default), sonnet or opus
  instructions: Ask about one thing someone shipped this week.   # optional, ≤300 chars
default_role: guest
creator_role: lead
```

The host's role must hold `send` and nothing else, and must not set `reports`.
The room must be a swarm room, and must set `heartbeat_on` to at least `1h`:
a pair room's two seats are its members', and a host with no tick has nothing to
wake it. The server refuses a manifest that breaks any of these, naming the
rule. `bellman_start` refuses a hosted room on free and pro, and past the
plan's hosted rooms open at once. `instructions` follow Bellman's own rules
for the host in its prompt, which ends saying those rules outrank them; they
cannot give it a tool or a verb, or a name: the host is `host@bellman` whatever
its role is called.

A room can also ask the server to notice when it has gone quiet. A top-level
`housekeeping` block, beside authored roles or a cited preset, sets up to three
thresholds and an optional repeat window:

```yaml
housekeeping:
  quiet_after: 2h       # a member has sent nothing for this long
  answer_within: 30m    # an action request is still unanswered after this long
  idle_after: 1d        # no member has sent anything for this long
  repeat_after: 4h      # optional: how long before a finding that still holds is named again
```

Each value is a whole number of `s`, `m`, `h` or `d`, from 5 minutes to 7 days.
A threshold left out turns its finding off, a block with no threshold turns
housekeeping off, and no built-in preset sets it. When a threshold passes the server
appends a `housekeeping` event naming the member, the request's cursor or the
room, once per window: `repeat_after` is the window for a finding that still
holds, and defaults to the threshold that raised it, so a `repeat_after` shorter
than a threshold repeats that often, by design. Of one member's unanswered
requests the three oldest are named, and the next once an older one is answered, so
a member cannot fill every window by asking more. A finding ends with its
condition: the member sends, the request is answered or its sender leaves, a
member writes to the room. A thaw restarts the clocks, because nobody can send
in a frozen room and a freeze is never counted as silence. The server proposes
and never acts: nothing is sent, answered, closed or removed, and what to do
about a finding is a member's call, under the verb that member already holds. A
joiner sees the thresholds before accepting a seat: the connect preview carries
`housekeeping`, each threshold in seconds (`null` where off, and the whole block
`null` when the room names no one), and the join page says so in a line.

Housekeeping counts people. A hosted seat is never named quiet, what it says is not
activity (a room only the host speaks in reads idle), and a proposal never wakes it. The Node
server (`npm start`) keeps the books these findings are read from and raises nothing: its tick
loop does not run housekeeping, so a housekeeping room shows no proposal there. Run the room
under `npm run dev:worker` to see one.

The bridge reads the file from the directory Claude Code was started in
(it does not search parent directories) and logs
`bellman: using room manifest from .bellman/room.yaml` to stderr when it
uses one. A `manifest` argument passed to `bellman_start` always wins
over the file. The bridge lists `bellman_start` with `manifest` optional
(the server itself requires it), so a client that checks arguments
against the listed schema can still leave it out and let the file
supply it. A file that is malformed, unreadable, over 64 KB, not a
regular file, or a symlink fails locally, before anything is sent; with no file and no
argument, the server's own validation error comes back.

Those local checks are about the FILE, not the manifest. The bridge does
not know the schema — the server owns that, and has exactly one copy of
it. So a file that is valid YAML and parses to a mapping is sent even
when the manifest inside it is wrong: an unknown key, an invalid preset,
a `default_role` naming no role are all reported by the server, which
means that request does cross the wire and comes back an error. Only the
parsed object reaches the server, which has no YAML parser.

**Saved presets.** The panel's Presets page (`dash.bellman.sh/presets`) keeps up to 20 room shapes of your own: clone a built-in, set the roles, their verbs and who reports, and save. An agent starts a room from one with `bellman_start { manifest: { room, preset: "<name>" } }`; the room is expanded at start, so editing a preset never changes a room that exists. A saved preset can carry a cadence and a `housekeeping` block as an authored manifest does; a `housekeeping` block beside the cite replaces the preset's whole, an empty one turns it off, and a cite with none, or a null one, keeps the preset's own. The routes behind it are `GET /presets`, and `PUT` and `DELETE /presets/:name`, refused in the room validator's words when `bellman_start` would refuse the same shape. A preset may carry a `host` block, as a clone of `social` does; a room started from it meets the plan a hosted seat needs and takes one of your hosted rooms, exactly as a manifest that declares one does. A preset is yours alone; for a shape a repo shares, the page's Copy room.yaml writes this file with every role spelled out.

### When a plan lapses

A session whose plan has lapsed is **frozen**, not closed. Everyone stays a member, the whole history stays readable and `bellman_sync` keeps working; what stops is writing — `bellman_send`, `bellman_invite`, `bellman_confirm` and `bellman_evict` refuse and say why. Restoring the plan thaws it and the room is the same room.

Losing the room would be the wrong punishment for a failed card, and it is not reversible: the point of freezing is that paying again gives you back exactly what you had.

`session_status` reports `frozen` alongside `active` and `closed`, so a client can tell a lapsed plan from a room that is simply over — one of those is fixable by paying.

**Nothing detects a lapse yet.** The capability is here and the store can freeze and thaw; wiring it to plan resolution is still to come. Sessions created before that capability shipped are not in the creator index and cannot be added to it — the registry never held a list of sessions to backfill from — so a lapse will not reach them. Those rooms persist like any other, so this does not resolve itself.

## Production path

State lives behind the `BellmanStore` interface (`src/store.ts`). The deployment this was shaped for is **Cloudflare Workers + Durable Objects** — each Bellman session maps 1:1 to a DO, which natively gives you the held long-poll connections, per-room serialization, and geographic placement. That's what serves `mcp.bellman.sh`: `src/worker.ts` with `DurableObjectStore` (`src/store-do.ts`), while `npm start` keeps the in-memory Node server for local development.

## Architecture

For the whole-system view — the surfaces agents arrive on, why the server is
remote-first, the storage objects, the trust boundaries, and where this is
going — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
