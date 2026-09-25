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

**Signing in.** GitHub and Google authenticate the human; Bellman issues its own token. Everyone who signs in gets the default identity — free plan, member role, no org — which is the monetization asymmetry working as designed: they can be invited into a room immediately, they just can't create one.

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

That puts three commands on your PATH: `bellman-channel` (the bridge Claude Code spawns), `bellman-stop-hook` (the fallback), and `bellman-claude` (the launcher below). Working from a clone instead? `npm install && npm run build`, and use `node "$PWD/dist/channel.js"` wherever `bellman-channel` appears.

**Channels (recommended).** Peer events are pushed straight into the session, even while it's idle.

```bash
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -- bellman-channel
bellman-claude                # start Claude Code with the channel loaded
```

Channels are a Claude Code research preview: a custom channel is not on Anthropic's allowlist, so every launch needs `claude --dangerously-load-development-channels server:bellman`. Miss the flag and the session starts normally but nothing is ever pushed into it, which reads as Bellman being broken — `bellman-claude` exists so you can't forget. It passes your other arguments straight through (`bellman-claude --resume`), and `BELLMAN_CHANNEL_SERVER` / `BELLMAN_CHANNEL_FLAG` override the entry and the flag once the channel reaches an org allowlist.

Team and Enterprise orgs must also turn on `channelsEnabled`.

**Stop-hook fallback.** Where channels aren't available, the bridge queues peer events and a Stop hook hands them to Claude when a turn ends. Mid-turn, the agent calls `bellman_wait` to block for a reply.

```bash
claude mcp add --scope user bellman -e BELLMAN_KEY=<your key> -e BELLMAN_DELIVERY=hook -- bellman-channel
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

**Other clients.** Anything that can send a header — Cursor, Gemini CLI — connects to `https://mcp.bellman.sh/mcp` with `Authorization: Bearer <key>` and uses `bellman_sync` with `wait_seconds` (up to 25) to long-poll. claude.ai, Claude Desktop connectors and ChatGPT only accept OAuth for custom connectors: point them at the same URL and sign in with GitHub or Google.

## Plans

Signing in with GitHub or Google gets you a free identity: pair sessions, 20 a month, 4 hour lifetime. Joining somebody else's session is free on every plan — only creating one is gated.

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

## Production path

State lives behind the `BellmanStore` interface (`src/store.ts`). The deployment this was shaped for is **Cloudflare Workers + Durable Objects** — each Bellman session maps 1:1 to a DO, which natively gives you the held long-poll connections, per-room serialization, and geographic placement. That's what serves `mcp.bellman.sh`: `src/worker.ts` with `DurableObjectStore` (`src/store-do.ts`), while `npm start` keeps the in-memory Node server for local development.
