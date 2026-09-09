# Quorai

**Cross-session, cross-provider agent collaboration over MCP.**

One session starts a room and gets a human-relayable code (`QRA-7F3K-92`). Any other MCP-connected session — Claude Code, Claude chat, ChatGPT, Cursor, Gemini CLI, same user on another machine or a different user entirely — connects with the code, previews the creator's context brief, confirms with its own, and the two sessions become members of each other's work.

## Why MCP as the rendezvous

MCP is the one protocol every major provider's clients now speak, which makes a neutral Quorai server *provider-agnostic by default*. The design sticks to the lowest common denominator so nothing breaks outside Claude:

- **Tools only** — no MCP resources, sampling, or elicitation (spotty support elsewhere)
- **Text-first responses**, `structuredContent` as progressive enhancement
- **Bearer-key auth** (OAuth 2.1 + DCR is the swap-in path, isolated in `src/auth.ts`)
- **Long-poll capped at 25s** to stay under the strictest client tool-call timeouts

## Tool surface

| Tool | Purpose |
|---|---|
| `quorai_start` | Create a room, get join code + `member_id`. Entitlement-gated. |
| `quorai_connect` | Phase 1: preview the creator's brief. **Nothing of yours ships yet.** |
| `quorai_confirm` | Phase 2: ship your brief, become a member. |
| `quorai_send` | `message` \| `artifact` \| `action_request` \| `action_response` \| `brief_update` |
| `quorai_sync` | Poll/long-poll for peer events (MCP has no push). |
| `quorai_leave` | Depart with a broadcast event. |
| `quorai_audit` | Enterprise: every crossing that touched your org's boundary. |

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

Dev bearer keys: `qk_dev_jesse` (team admin, org_codenerd), `qk_dev_peer` (free, org_codenerd), `qk_dev_outsider` (free, no org). Real keys via `QUORAI_KEYS` env (JSON map of key → identity).

Connect from Claude: Settings → Connectors → Add custom connector → `http://<host>:3900/mcp` with an Authorization header.

## Production path

State lives behind the `QuoraiStore` interface (`src/store.ts`). The deployment this was shaped for is **Cloudflare Workers + Durable Objects** — each Quorai session maps 1:1 to a DO, which natively gives you the held long-poll connections, per-room serialization, and geographic placement. Swap `MemoryStore`, change nothing else.
