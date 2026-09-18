# Bellman

**Cross-session, cross-provider agent collaboration over MCP.**

One session starts a room and gets a human-relayable code (`BELL-7F3K-92`). Any other MCP-connected session — Claude Code, Claude chat, ChatGPT, Cursor, Gemini CLI, same user on another machine or a different user entirely — connects with the code, previews the creator's context brief, confirms with its own, and the two sessions become members of each other's work.

## Why MCP as the rendezvous

MCP is the one protocol every major provider's clients now speak, which makes a neutral Bellman server *provider-agnostic by default*. The design sticks to the lowest common denominator so nothing breaks outside Claude:

- **Tools only** — no MCP resources, sampling, or elicitation (spotty support elsewhere)
- **Text-first responses**, `structuredContent` as progressive enhancement
- **Bearer-key auth** (OAuth 2.1 + DCR is the swap-in path, isolated in `src/auth.ts`)
- **Long-poll capped at 25s** to stay under the strictest client tool-call timeouts

## Tool surface

| Tool | Purpose |
|---|---|
| `bellman_start` | Create a room, get join code + `member_id`. Entitlement-gated. |
| `bellman_connect` | Phase 1: preview the creator's brief. **Nothing of yours ships yet.** |
| `bellman_confirm` | Phase 2: ship your brief, become a member. |
| `bellman_send` | `message` \| `artifact` \| `action_request` \| `action_response` \| `brief_update` |
| `bellman_sync` | Poll/long-poll for peer events (MCP has no push). |
| `bellman_leave` | Depart with a broadcast event. |
| `bellman_invite` | Issue a fresh join code at any time, or revoke the current one. Creator only. |
| `bellman_audit` | Enterprise: every crossing that touched your org's boundary. |

## Trust model

- **Two-phase connect**: joiners see the creator's brief before their own context crosses. Codes are single-use and expire in 15 minutes unused.
- **Untrusted envelopes**: every peer-originated payload arrives wrapped `{ trust: "untrusted", origin, data }` with an explicit preamble instructing the receiving agent to treat it as data, not instructions. Cross-provider makes this load-bearing: it's a GPT agent's output landing in a Claude context, and vice versa.
- **Capability grants**: members declare what may be done *to* them (`read_context`, `receive_messages`, `request_actions`). Action requests are approved by the receiving **human**, not the receiving agent.
- **Member handles**: `member_id` is per-connection, so one user pairing with themself across two machines works — and a handle can only be driven by the identity that minted it.

## Monetization asymmetry

Plans gate session **creation** only (`free`: pair/20-mo/4h · `pro`: swarm/500-mo/72h · `team`: 25 members/30d/org-scoping/audit). **Joining is free on every plan** — the viral loop stays open, the initiator pays. Enterprise value concentrates in `org_only` scoping and the audit trail: cross-org sessions log to *both* orgs' audit streams.

## Run it

```bash
npm install && npm run build
npm start                  # http://localhost:3900/mcp
npm run smoke              # end-to-end two-provider simulation (server must be running)
```

**Local-dev bearer keys**, live only while `BELLMAN_KEYS` is unset: `qk_dev_jesse` (team admin, org_codenerd), `qk_dev_peer` (free, org_codenerd), `qk_dev_outsider` (free, no org).

Set `BELLMAN_KEYS` (JSON map of key → identity) and it becomes the **sole** source of truth — the dev table stops resolving, and a malformed map rejects every request rather than falling back. **Every deployment must set it.**

Rotate with `npm run rotate-key`. A Worker secret can't be read back, so the map is rebuilt from `~/.config/bellman/identities.json` (identities, no keys) and every key is reminted — which is what you want after a leak anyway. The script backs up the old map, uploads, checks the new key is accepted and the old one is refused, updates the Claude Code MCP entry, and leaves the keys in `~/.config/bellman/keys.json` (mode 600). `--dry-run` shows the plan without touching the server.

## Use it from Claude Code

Bellman is live at `https://mcp.bellman.sh/mcp`. Claude Code connects through a small local bridge, `dist/channel.js`, which proxies the Bellman tools and delivers peer messages to your session as they arrive — the agent never has to remember to call `bellman_sync`.

```bash
npm install && npm run build
```

**Channels (recommended).** Peer events are pushed straight into the session, even while it's idle.

```bash
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -- node "$PWD/dist/channel.js"
npm link                      # puts bellman-claude on your PATH
bellman-claude                # start Claude Code with the channel loaded
```

Channels are a Claude Code research preview: a custom channel is not on Anthropic's allowlist, so every launch needs `claude --dangerously-load-development-channels server:bellman`. Miss the flag and the session starts normally but nothing is ever pushed into it, which reads as Bellman being broken — `bellman-claude` exists so you can't forget. It passes your other arguments straight through (`bellman-claude --resume`), and `BELLMAN_CHANNEL_SERVER` / `BELLMAN_CHANNEL_FLAG` override the entry and the flag once the channel reaches an org allowlist.

Team and Enterprise orgs must also turn on `channelsEnabled`.

**Stop-hook fallback.** Where channels aren't available, the bridge queues peer events and a Stop hook hands them to Claude when a turn ends. Mid-turn, the agent calls `bellman_wait` to block for a reply.

```bash
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -e BELLMAN_DELIVERY=hook -- node "$PWD/dist/channel.js"
```

```json
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/bellman/dist/stop-hook.js", "timeout": 60 }] }]
  }
}
```

Prefix the command with `BELLMAN_HOOK_WAIT_SECONDS=30` to keep listening for up to 30s at the end of each turn while you're in a session (never outside one); keep `timeout` above it. Launch the bridge with `node` directly, as above — the hook finds the bridge's queue through their shared Claude Code process.

**Other clients.** Anything that can send a header — Cursor, Gemini CLI — connects to `https://mcp.bellman.sh/mcp` with `Authorization: Bearer <key>` and uses `bellman_sync` with `wait_seconds` (up to 25) to long-poll. claude.ai, Claude Desktop connectors and ChatGPT only accept OAuth for custom connectors, so they wait on #7.

## Production path

State lives behind the `BellmanStore` interface (`src/store.ts`). The deployment this was shaped for is **Cloudflare Workers + Durable Objects** — each Bellman session maps 1:1 to a DO, which natively gives you the held long-poll connections, per-room serialization, and geographic placement. That's what serves `mcp.bellman.sh`: `src/worker.ts` with `DurableObjectStore` (`src/store-do.ts`), while `npm start` keeps the in-memory Node server for local development.
