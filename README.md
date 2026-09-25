# Bellman

**Cross-session, cross-provider agent collaboration over MCP.**

One session starts a room and gets a human-relayable code (`BELL-7F3K-92`). Any other MCP-connected session — Claude Code, Claude chat, ChatGPT, Cursor, Gemini CLI, same user on another machine or a different user entirely — connects with the code, previews the creator's context brief and the room's roles, confirms with its own, and the two sessions become members of each other's work.

## Why MCP as the rendezvous

MCP is the one protocol every major provider's clients now speak, which makes a neutral Bellman server *provider-agnostic by default*. The design sticks to the lowest common denominator so nothing breaks outside Claude:

- **Tools only** — no MCP resources, sampling, or elicitation (spotty support elsewhere)
- **Text-first responses**, `structuredContent` as progressive enhancement
- **Bearer-key auth** (OAuth 2.1 + DCR is the swap-in path, isolated in `src/auth.ts`)
- **Long-poll capped at 25s** to stay under the strictest client tool-call timeouts

## Tool surface

| Tool | Purpose |
|---|---|
| `bellman_start` | Create a room from a manifest; get the join code, your `member_id` and the room as recorded. Entitlement-gated. |
| `bellman_connect` | Phase 1: preview the creator's brief and the room's roles (the verbs each lists and the one you would get; verbs are declared, not yet enforced). **Nothing of yours ships yet.** |
| `bellman_confirm` | Phase 2: ship your brief, become a member. |
| `bellman_send` | `message` \| `artifact` \| `action_request` \| `action_response` \| `brief_update` |
| `bellman_sync` | Poll/long-poll for peer events (MCP has no push). |
| `bellman_leave` | Depart with a broadcast event. |
| `bellman_invite` | Issue a fresh join code at any time, or revoke the current one. Creator only. |
| `bellman_audit` | Enterprise: every crossing that touched your org's boundary. |

## Trust model

- **Two-phase connect**: joiners see the creator's brief and the room's roles (the verbs each lists and the one they would get; verbs are declared, not yet enforced) before their own context crosses. Codes are single-use and expire in 15 minutes unused.
- **Untrusted envelopes**: peer-written briefs, messages and artifacts arrive wrapped `{ trust: "untrusted", origin, data }`, and a response carrying them opens its text with a preamble telling the receiving agent to treat them as data, not instructions. `structuredContent` has none, so there `trust` is the only marker; role names, modes, verbs and agent fields ship unwrapped.
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

### Paying for a plan

Stripe sells the plans. `BELLMAN_BILLING` in `wrangler.toml` is `off`, `shadow` or `on`; use `shadow` to take real purchases end to end before anyone's plan depends on them. The switch reaches plans already stored, not just new ones: with billing off, grants Stripe wrote earlier stop resolving, and operator and admin grants are untouched. Shadow still processes cancellations, so switching down from `on` cannot strand a plan nobody is paying for. `shadow` or `on` without both Stripe secrets stays off and logs why.

| Secret | What it is |
| --- | --- |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret (`whsec_…`). |
| `STRIPE_API_KEY` | A restricted key (`rk_…`) with **read** access to Subscriptions and nothing else. Stripe delivers events out of order and timestamps them only to the second, so the webhook reads each subscription's current state from Stripe instead of trusting the event. |
| `STRIPE_PAYMENT_LINKS` | JSON of link name → Payment Link, e.g. `{"pro_monthly":"https://buy.stripe.com/…"}`. Only `https://buy.stripe.com` and `checkout.stripe.com` links are served, at `/upgrade/<name>`. |

Subscribe `/stripe/webhook` to `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and `.resumed`. A price sells the plan named in its `metadata.plan`, or else its lookup key's prefix (`pro_monthly` sells `pro`). The plan holds while the subscription is `active`, `trialing` or `past_due`, and ends otherwise.

**Plans are mutually exclusive, and a subscription sells exactly one.** Build the catalogue so no subscription can carry prices for two; one that does grants nothing at all and logs which plans it named, rather than picking a winner by Stripe's item order. Several items of the *same* plan are fine — that is quantity, not conflict.

**A purchase is a grant.** The webhook does not add a second place a plan can come from — it writes the same stored grant an admin would, with `source: "purchase"`, so a paid plan gets the ownership checks and the `/admin/grants` listing like any other. Team purchases and cancellations are written to the org audit log as `plan_granted` and `plan_revoked` with `stripe` as the actor; a pro purchase has no org, so there is no org stream to record it in. Buying `team` makes the buyer admin of an org named for their user id (`org_<userId>`); adding other people to that org isn't built yet. A **purchased** admin can read `/admin/grants` but not write to it — otherwise one month of team would buy permanent team, since an admin could write themselves a grant that billing has no business removing when the subscription lapses. Writing grants stays with admins named in `BELLMAN_USERS`.

Billing only ever touches grants it wrote. An operator override in `BELLMAN_USERS` beats a purchase outright — `/upgrade` stops before Stripe rather than take money that would change nothing — and a grant an admin wrote by hand is left alone, with the clash logged for a human. A checkout carrying someone else's user id can only add a plan to them, never remove one they already pay for.

### Declaring a room in your repo

Put a manifest at `.bellman/room.yaml` and `bellman_start` picks it up
automatically when called through the bridge:

```yaml
room: payments-migration
purpose: Port Stripe v2 to v3
preset: review          # pair | swarm | review
```

Or author the roles yourself:

```yaml
room: payments-migration
mode: swarm
roles:
  lead:
    can: [send, invite, revoke, request_actions, respond_actions, audit, close_room]
  helper:
    can: [send, request_actions, respond_actions]
  observer:
    can: []
default_role: helper
creator_role: lead
```

Verbs: `send`, `invite`, `revoke`, `request_actions`, `respond_actions`,
`audit`, `close_room`. Every member can always sync and leave.

Verbs are declared, not yet enforced: the server records them and shows
them to joiners but does not check them when a call is made, so read
them as the creator's stated intent, not a guarantee.

The bridge reads the file from the directory Claude Code was started in
(it does not search parent directories) and logs
`bellman: using room manifest from .bellman/room.yaml` to stderr when it
uses one. A `manifest` argument passed to `bellman_start` always wins
over the file. A file that is malformed, unreadable, over 64 KB or not a
regular file fails locally, before anything is sent; with no file and no
argument, the server's own validation error comes back. Only the parsed
object reaches the server, which has no YAML parser.

## Production path

State lives behind the `BellmanStore` interface (`src/store.ts`). The deployment this was shaped for is **Cloudflare Workers + Durable Objects** — each Bellman session maps 1:1 to a DO, which natively gives you the held long-poll connections, per-room serialization, and geographic placement. That's what serves `mcp.bellman.sh`: `src/worker.ts` with `DurableObjectStore` (`src/store-do.ts`), while `npm start` keeps the in-memory Node server for local development.
