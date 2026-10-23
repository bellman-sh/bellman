# Comparison Pages — Design

Status: approved design, pending implementation plan
Closes: #83
Related: #85 (OpenRig as a complement), #78 (generating `bellman_start`, which
moves the token numbers below)
Implements in: **`bellman-sh/bellman.sh`**, not this repo. This file is the only
artifact #83 leaves here.

## Problem

Bellman has no written answer to the first question anyone asks it: *why not
just use subagents?* OpenRig ships eight comparison pages, four of them against
Anthropic's own features, which is the right instinct — a reader deciding
whether to adopt Bellman is comparing it against something, and right now they
do that without us.

Two things make this harder than writing four pages of positioning.

**The first-party story moved.** #83 was filed against a world where
coordinating agents across machines was Bellman's alone. It is not. Claude Code
v2.1.224 shipped cross-session messaging: `/list-agents` and `SendMessage`
reach your other local sessions, your cloud sessions, and your sessions on
other machines through Remote Control. A page claiming "separate machines" as
the differentiator would be wrong on the day it published.

**#83 contains a factual error.** It says subagents "share its context
lineage". They do not: a subagent starts with its own system prompt, the
delegation message, `CLAUDE.md` and a git snapshot, and explicitly *without*
the parent's conversation history. A fork is the exception, not the rule.
Shipping the issue's wording would hand a reader a reason to disbelieve the
rest of the page.

So the real work is not persuasion. It is getting six sets of facts right, and
building the pages so they stay right.

## Decisions

### D1 — The pages live in the site repo. This repo holds the spec.

A reader asking "why not just use subagents?" is on bellman.sh, not in
`docs/`. The pages are `public/compare/*` in `bellman-sh/bellman.sh`, on their
own branch and PR. #83 closes referencing that PR.

The cost is a cross-repo fact: the token numbers in §*What connecting costs*
come from `docs/ARCHITECTURE.md` §11 in **this** repo. D8 handles that.

### D2 — Six comparisons, not the four #83 lists.

*(Amended 2026-10-17: OpenClaw and Hermes Agent make nine comparisons, per bellman.sh's front-page-of-rooms spec D12. Their facts are below, under "The facts each page rests on".)*

#83's second bullet — "Claude Code teams / managed agents" — names two
products with different shapes. Claude Code's teams and cross-session messaging
are features of a session you run; Managed Agents is an API product where
Anthropic runs the loop and hosts a per-session sandbox. One page covering both
would have to argue two different things and would be muddy at both. OpenRig
splits them for the same reason.

**ChatGPT Space is the sixth, and it was not in #83 because it did not exist.**
OpenAI announced it at DevDay on 2026-09-29 and began rolling it out on
2026-10-01: a shared workspace where you invite colleagues *and* agents —
ChatGPT, Codex and Dots — into one place, with Pages as the shared artifact.
It is the closest thing to Bellman any major vendor has shipped, so leaving it
out would make the section look evasive within a month of publishing.

**Conductor is the seventh, added 2026-10-06.** It is the funded form of the
question #83 opened with — why not just orchestrate? — and since July it has
been multiplayer: teammates open the same workspace, watch the same transcript
and prompt the same agent. Every one of those teammates is a member of one
organisation and every agent is one Conductor launched. That is the tenancy
boundary Space draws, reached from the other side, and a developer evaluating
Bellman is likelier to have Conductor installed than anything else on this
list.

The pages are ordered by **how far outside you the thing can reach**, which is
the one axis that separates all six from Bellman (D7). Subagents reach inside
one session; Space reaches across one organisation; Bellman is the only one
that reaches past the account entirely.

| URL | Subject |
|---|---|
| `/compare/` | index — routes the question, plus one matrix across all six |
| `/compare/subagents` | Claude subagents (the Agent tool) |
| `/compare/claude-agent-teams` | agent teams and cross-session messaging |
| `/compare/managed-agents` | Claude Managed Agents |
| `/compare/openrig` | OpenRig |
| `/compare/frameworks` | CrewAI, LangGraph, AutoGen |
| `/compare/conductor` | Conductor, and its multiplayer workspaces |
| `/compare/chatgpt-space` | ChatGPT Space, Pages and Dots |

### D3 — Generated from a config, the way `pricing.html` already is.

Six comparison pages and an index share a header, nav, footer, OG block and
the token-cost table. The
site has exactly one precedent for repeated pages — `tools/build-pricing.py`
reading `tools/pricing.config.json`, with the README rule "`public/pricing.html`
is **generated**. Do not edit it." — and the reason it exists is the reason it
applies here: *a price cannot be right in one card and stale in another.*
Neither can a token count, on six pages.

Hand-writing seven files was considered and rejected: it gives the first-party
facts six places to go stale, and those facts demonstrably change between
Claude Code releases.

### D4 — One page contract, fixed order, no per-page improvisation.

The anatomy in §*Page contract*. A reader who reads only the `h1`, the answer
paragraph and the decision line must leave with the correct answer. Everything
below that is for the reader who wants to argue.

### D5 — The generator refuses to emit a page with no "better at" section.

#83 asks for "the honest version — what the other thing is better at, not just
where we win". Good intentions do not survive a deadline. A missing or empty
`better_at_html` **fails the build**, the same way the pricing generator
refuses to render `STRIPE_PORTAL_URL` as a working link.

This check must be proven by breaking the config on purpose and watching the
build fail. A check nobody has seen fail is not a check.

### D6 — Every page says what it was checked against, and when.

Each page ends with a verified line — *"Checked against Claude Code v2.1.248 ·
2026-10-02"* — linking the source. The generator prints a loud warning for any
`verified.date` older than 90 days.

This is the same discipline as the site README's *Keeping the page honest*
table, applied to the content most likely to rot. The Problem section above is
the evidence that it rots.

### D7 — The spine is a reach ladder, not a single "not yours".

#83 proposes one line — "Bellman is for when the other agent is not yours" —
and it is right about subagents. It is not sufficient, because ChatGPT Space
*does* let you work with other people's agents. The honest version is a ladder,
and each page sits on one rung:

| The thing reaches | Stops at | Page |
|---|---|---|
| inside one session | the turn, and your own context | subagents |
| your own sessions | your OS user and your claude.ai sign-in | claude-agent-teams |
| your account's agents | one org, Anthropic-hosted, API-reached | managed-agents |
| processes on your machine | the machine, and what it started | openrig |
| your own process | code you wrote and agents you built | frameworks |
| your organisation | **your workspace's membership and seats** | chatgpt-space |

Bellman is the only one on the list where a member needs nothing of yours —
not your machine, not your account, not a seat in your organisation, not your
vendor's client. That is the whole claim, and it is the only claim all six
pages share.

The evidence for each rung:

- **Claude Code** restricts a session's inbox socket to your operating-system
  user, so another person's sessions cannot deliver to it; cross-machine needs
  Remote Control on your own claude.ai sign-in; and it is Claude Code to Claude
  Code only.
- **ChatGPT Space** members must already be members of your ChatGPT workspace —
  a team join link does not invite anyone into the workspace. An outside person
  is onboarded *into your workspace* by an owner or admin with External Domain
  Invites enabled, on your plan's seats.
- **Bellman** hands out a code. The joiner needs no account of yours, no seat,
  and no plan: joining is free on every plan, which `/pricing` already says.

### D8 — The token numbers live once, cited to their source.

`token_costs` sits at the top level of the config, not per page, with a comment
citing `bellman/docs/ARCHITECTURE.md` §11. #78 proposes generating
`bellman_start`'s description, which would move the ~3,730 figure; D6's
verified line is what catches that.

### D9 — Adding `Compare` to the nav is two edits, not one.

`public/index.html` is hand-written; `public/pricing.html` is generated from
`build-pricing.py`'s page skeleton. A nav link added to only one of them makes
pricing's nav silently diverge from every other page. Both change, in the same
commit, plus the new generator's own skeleton.

## The facts each page rests on

This table is the defence against strawmen. An implementer writes from here,
not from memory. Every row was checked on 2026-10-02.

### Claude subagents

| Fact | Source |
|---|---|
| Context-isolated by default: own system prompt, the delegation message, `CLAUDE.md`, git snapshot. **No parent conversation history.** | `code.claude.com/docs/en/sub-agents` |
| A fork is the exception — it inherits the entire parent conversation | same |
| Session-scoped; cannot reach subagents in other sessions | same |
| Runs on the parent session's provider | same |
| Up to 20 concurrent, nesting 3 deep, both configurable | same |
| Can restrict tools and permission modes; can route to Haiku for cost | same |
| A completed subagent can be resumed with history intact | same |
| Subagents cannot be members of an agent team | same |

### Claude Code cross-session messaging and agent teams

| Fact | Source |
|---|---|
| Reaches your other local sessions, your cloud sessions, and your Remote Control sessions on other machines | `code.claude.com/docs/en/cross-session-messaging` |
| Same machine travels over a per-session Unix socket or named pipe, never through Anthropic servers | same |
| Other machines and cloud travel through Anthropic servers | same |
| The socket is restricted to your OS user — on a shared machine another user's sessions cannot deliver to it | same |
| Beyond-this-machine discovery needs Remote Control and a claude.ai sign-in; unavailable on an API key, Bedrock, Claude Platform on AWS, Google Cloud, Foundry | same |
| Plain text only. Structured agent-team protocol messages stay within a team | same |
| A message cannot approve anything, change configuration, or run a command | same |
| Inbound controls per session: `accept` / `hold` / `refuse`; `isolatePeerMachines` requires approval before a message leaves the machine | same |
| Can ask a session on this machine for one notice when it next goes idle | same |
| Free; no tool-definition tokens, nothing to install, no account anyone else needs | derived from the above |

### Claude Managed Agents

| Fact | Source |
|---|---|
| Anthropic runs the agent loop and hosts a per-session container where bash, file ops and code execution run | `claude-api` skill, `shared/managed-agents-*` |
| Agent configs are persisted, versioned objects; sessions pin to a version | same |
| Multiagent sessions: a roster where an agent delegates to copies of itself or to worker agents by ID | same |
| Scheduled deployments fire sessions on a cron cadence | same |
| Outcomes: a separate grader iterates the agent against your rubric | same |
| Memory stores, under their own beta (`agent-memory-2026-07-22`) | same |
| Vault credentials are substituted at egress and never enter the sandbox | same |
| Everything sits inside one account and org, reached by API | same |

**Reconciled 2026-10-03:** the page-content directive for this page listed
memory stores while this table did not, so the copy rule ("if a claim is not in
the table, check it and add it, or cut it") had nothing to check it against. The
claim is sourced, so the table moved rather than the page. Two claims the table
did *not* support were cut from the pages instead: LangGraph being "most often
in production" (no market-share fact anywhere), and a multiagent roster handing
reading-heavy work to a cheaper model (that is the *subagents* table's
route-to-Haiku fact, not this one).

### OpenRig

| Fact | Source |
|---|---|
| tmux-based local processes; `rig setup`, `rig up`, persistent agent pods reachable via a TUI or direct terminals | `openrig.dev` |
| Requires Node 22 or 24 and tmux; installed with `npm i -g @openrig/cli` | same |
| A lead agent delegates to Claude Code, Codex and Pi | same |
| Documented around a single machine ("One Mac mini"); no cross-machine or multi-user story | same |
| Ships a Compare section at `/compare/*` — Claude managed agents, Claude agent teams, Claude subagents, CrewAI, n8n, OpenClaw, Paperclip | same |

### ChatGPT Space

Announced 2026-09-29 at DevDay, rolling out from 2026-10-01. **This is the
newest and least settled set of facts on the page; treat the unconfirmed rows
as unconfirmed, the way the site README already treats remote connectors.**

| Fact | Confidence | Source |
|---|---|---|
| A shared workspace inside ChatGPT where colleagues collaborate with ChatGPT, Codex and Dots | confirmed | OpenAI via DevDay coverage |
| Pages is the shared artifact — "a new type of document, built for human and agent collaboration"; real-time co-editing with edit access | confirmed | same |
| Dots are always-on agent personas, operating across ChatGPT, Slack and Microsoft Teams | confirmed | same |
| Collaborative slides, with comments and PowerPoint / Google Slides export, announced as coming | confirmed as announced | same |
| Native Slack and Microsoft Teams integrations; automated meeting summaries | confirmed | same |
| Pro, Business and Enterprise. Web and desktop; mobile can read and share but not create or edit | confirmed | same |
| Largely replaces the Library tab | confirmed | same |
| **A Space's members must already be members of your ChatGPT workspace.** A team join link does not invite anyone into the workspace itself | confirmed | `help.openai.com` — Teams in ChatGPT |
| Teams are available in ChatGPT Business and Enterprise workspaces | confirmed | same |
| An external person is invited into the workspace by an owner or admin, and only with **Allow External Domain Invites** enabled | confirmed | same |
| Whether a non-OpenAI agent or a third-party MCP client can participate in a Space | **unconfirmed — say nothing** | — |
| Per-Space member limits | **unconfirmed — say nothing** | — |

**Do not claim** that Space cannot involve other people. It can, and saying
otherwise is the kind of error the Problem section exists to prevent. The
truthful distinction is the tenancy boundary, not the person boundary.

**Positioning constraint:** `docs/ARCHITECTURE.md` §1 already calls local
orchestrators complements rather than competitors and points at #85. The
OpenRig page must not contradict it.

### Conductor

Checked 2026-10-06 against version 0.90.0 and the published docs.

| Fact | Source |
|---|---|
| A Mac app that runs Claude Code, Codex, Cursor and OpenCode in parallel, each in an isolated git worktree; you review the diffs and merge | `conductor.build`, `/docs` |
| Conductor Cloud (0.78.0, 2026-07-30): isolated microVMs with the repo and dependencies pre-installed; sandboxes come up in seconds and run for hours | `/changelog` |
| Multiplayer (early access in 0.77.0, 2026-07-23): workspaces belong to a Cloud organisation and are shared with the team; a link "opens the workspace in Conductor for any member of the organization"; "the transcript and new agent output update live for everyone"; avatars, typing indicators, Follow, Reassign | `/docs/cloud/collaboration` |
| Hosted MCP server at `api.conductor.build/mcp`, Streamable HTTP, OAuth or API key; 24 tools including `create_workspace`, `send_message`, `list_messages`, `get_session_status`; the docs describe delegating to an agent and reading its transcript, and no agent-to-agent messaging | `/docs/api/mcp` |
| Pricing: Free is the local product with your own subscriptions and keys; Pro is $50/month and adds cloud workspaces, multiplayer "with up to 5 Pro users", the API and the mobile app; Teams is $60/user/month with collaboration "for teams of any size"; Enterprise adds SAML SSO and SCIM | `/pricing` |
| Conductor for iOS shipped in 0.90.0 on 2026-10-02 | `/changelog` |
| Melty Labs, YC S24; $22M Series A from Spark and Matrix, announced 2026-03-30 | `/blog`, YC |
| Whether a workspace can be shared with someone outside the organisation | **unconfirmed — say nothing.** The docs say "any member of the organization" and nothing more |

**Do not claim** Conductor is single-player or single-machine. It is neither,
and the OpenRig correction on #85 is why this row is here.

### CrewAI, LangGraph, AutoGen

| Fact | Source |
|---|---|
| LangGraph: directed graph, agents and checkpoints as nodes, transitions declared explicitly; v1.0 late 2025; the default runtime for LangChain agents; Python and JavaScript | web research, 2026-10-02 |
| CrewAI: role-based crews — role, backstory, goal per agent, assembled into a crew with tasks; a working crew in ~20 lines | same |
| AutoGen / AG2: GroupChat agents in multi-turn conversation with a selector deciding who speaks next; from Microsoft Research | same |
| All three: you write the orchestration, in your process, and an agent is a library call | same |

### OpenClaw

Checked 2026-10-17 against OpenClaw v2026.10.4 (GitHub release of 2026-10-16)
and `docs.openclaw.ai` as published. The repository is `github.com/openclaw/openclaw`;
the docs serve each page as Markdown at `<path>.md`.

| Fact | Source |
|---|---|
| In its own words: "OpenClaw is an open-source AI assistant that runs on your own hardware and meets you in every chat app you already use." Tagline: "Your AI assistant, on your own hardware, in every chat app you already use. One Gateway. Any model. Any device. No hosted service in the middle." | `docs.openclaw.ai/` (page summary and hero) |
| It is "a **self-hosted gateway** that connects your favorite chat apps — Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and more via channel plugins — to AI coding agents. You run a single Gateway process on your own machine (or a server), and it becomes the bridge between your messaging apps and an always-available AI assistant." | `docs.openclaw.ai/`, "What is OpenClaw?" |
| Formerly Clawdbot, then Moltbot: "For a while it was **Clawd**, living in a **Clawdbot**. In January 2026, Anthropic sent a polite email asking for a name change (trademark stuff)." … "it emerged as **Molty**, living in **Moltbot**" … "**Clawd → Moltbot → OpenClaw.**" Created by Peter Steinberger. | `docs.openclaw.ai/start/lore`; `docs.openclaw.ai/reference/credits` |
| Governance and price: "Developed in the open by the OpenClaw Foundation, an independent 501(c)(3). No paid tier, no telemetry by default beyond a version check you can turn off, no lab owns it." "The Foundation is funded by donations and sells nothing: no paid tier, no hosted service, no token." | `docs.openclaw.ai/`; `docs.openclaw.ai/start/why-openclaw`, "Governance" |
| Licence: "MIT, copyright OpenClaw Foundation." `LICENSE` reads "MIT License / Copyright (c) 2026 OpenClaw Foundation". GitHub reports `MIT`. | `docs.openclaw.ai/reference/credits`; `github.com/openclaw/openclaw/blob/main/LICENSE`; GitHub API |
| Latest release v2026.10.4, published 2026-10-16. 392,290 GitHub stars on 2026-10-17. Earlier: "v2026.8.1 (AKA OpenClaw 2.0)". | `api.github.com/repos/openclaw/openclaw` and `/releases/latest`; `docs.openclaw.ai/releases` |
| Install: `curl -fsSL https://openclaw.ai/install.sh \| bash` (PowerShell on Windows). "The installer detects your OS, installs Node if needed, installs OpenClaw, and then starts onboarding. Other install methods (npm, pnpm, bun, Docker, Nix, from source) are on the Install page." Requirements: "Node 26 (recommended), or another supported release: Node 24.16+ or Node 26.1+. You also need an API key from your chosen provider and 5 minutes." | `docs.openclaw.ai/`, "Quick start" and "What do you need?" |
| Runs as a background service you keep on: "Quick start leaves the Gateway in the foreground. Press Ctrl+C, then install the background service: `openclaw gateway install`". A team gateway needs "A host for the Gateway that stays on: a small VPS, an office Mac, or any supported install target." Control UI at `http://127.0.0.1:18789/` by default; the Gateway "binds to loopback by default". | `docs.openclaw.ai/`; `docs.openclaw.ai/start/teams`; `docs.openclaw.ai/gateway/security` |
| What the agent is: "If you **do nothing**, OpenClaw uses the bundled OpenClaw agent runtime". It can also drive vendor harnesses: "The `claude-cli` backend also checks native Bash commands against the agent's exec allowlist … This authorizes command arguments while Claude Code owns execution." and "Native harnesses can retain their own tool surface under their permission controls; see Codex runtime policy". | `docs.openclaw.ai/`, "Configuration"; `docs.openclaw.ai/tools/exec-approvals`; `docs.openclaw.ai/gateway/permission-modes` |
| How a person reaches it: the channel catalog lists 33 entries — A2A, Buzz, ClickClack, Discord, Feishu, Google Chat, iMessage, IRC, LINE, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk, Nostr, QQ bot, Raft, Reef, Signal, Slack, SMS, Synology Chat, Telegram, Tlon, Twitch, WebChat, WeChat, WeCom, WhatsApp, X / Twitter, Yuanbao, Zalo, Zalo ClawBot, Zalo personal. "A2A, Reef, Telegram, and WebChat ship with the core install; every other channel is an official plugin". Plus "Windows Hub, browser Control UI, macOS menu bar app, and mobile nodes" and an "iOS node with pairing, camera, screen recording, location, and voice". "Channels can run simultaneously; configure multiple and OpenClaw will route per chat." | `docs.openclaw.ai/channels`; `docs.openclaw.ai/concepts/features` |
| Heartbeat: "Heartbeat is a system-owned automation that runs **periodic agent turns** in the main session so the model can surface anything that needs attention without spamming you." Default cadence "`30m`, or `1h` when Anthropic OAuth/token auth is configured"; set with `agents.defaults.heartbeat.every`, `0m` disables. Default prompt ends "If nothing needs attention, reply NO_REPLY." "Heartbeat alerts go to the operator's direct message by default." Optional `activeHours`, `isolatedSession`, per-agent heartbeats. "The default heartbeat does not infer recurring work from prior chats." | `docs.openclaw.ai/gateway/heartbeat` |
| Scheduler: "Automations are OpenClaw's built-in scheduler. The scheduler persists jobs, wakes the agent at the right time, and can deliver output to a chat channel, a webhook, or nowhere." Managed with `openclaw automations` (`openclaw cron` is an alias) or conversationally. Schedule kinds: `at` (one-shot), `every`, `cron` (5- or 6-field, `--tz`), `on-exit` (a watched command exits), `stream` (lines from a supervised command). "Automations run **inside the Gateway process**, not inside the model. The Gateway must be running for schedules to fire." Also inbound webhooks (`POST /hooks/agent`) and Gmail Pub/Sub triggers. | `docs.openclaw.ai/automation/cron-jobs`; `…/automation/cron-jobs/schedules`; `…/automation/cron-jobs/how-it-works` |
| Several agents in one gateway: "Run multiple _isolated_ agents in one Gateway process, each with its own workspace, state directory (`agentDir`), and SQLite-backed session history … Inbound messages route to the right agent through **bindings**." Cross-agent access is "on by default and governed by `tools.agentToAgent`". | `docs.openclaw.ai/concepts/multi-agent` |
| Several people on one gateway (team mode): "This guide sets up one OpenClaw gateway that a whole team uses: a bot in the workspace chat you already have, shared sessions everyone can open and steer in the Control UI, and roles that bound what each person can do." "team operation is configuration, not a separate edition." Access through "Tailnet (recommended)", a "Trusted proxy" such as Cloudflare Access, or a "Shared secret". Sessions carry "an immutable creator, an assignable owner, and the history of people who actually prompted"; presence "shows who is viewing and who is typing"; named operator roles set "which sessions they can touch, which agents they can use, a maximum set of operator scopes, and whether their new sessions must be sandboxed". Commits from shared sessions get `Co-authored-by` trailers. | `docs.openclaw.ai/start/teams`; `docs.openclaw.ai/concepts/multi-user` |
| The trust boundary: "A gateway is one trust domain. Everyone who can message a tool-enabled agent shares that agent's delegated tool authority, and everyone with operator access shares one control plane." "If you need to serve mutually untrusted people or organizations, run one gateway per tenant instead". "Session ownership, visibility in the sidebar, and presence indicators are usability features, not security boundaries." | `docs.openclaw.ai/start/teams`; `docs.openclaw.ai/concepts/multi-user`; `docs.openclaw.ai/gateway/security` |
| Another person's agent, Reef: "Reef is a guarded, end-to-end-encrypted side channel between OpenClaw agents owned by different people. Messages are sealed on your machine and screened by a pinned-model guard in both directions. The relay operator can never read content. The plugin ships bundled with OpenClaw. The public relay is `https://reefwire.ai`". Setup: "Sign up at reefwire.ai", a handle, an inbound friend-request policy ("`code-only` is recommended"), and "the guard model configuration" (defaults `openai` / `gpt-5.6-terra`). "Inbound requests still require `openclaw pairing approve reef <CODE>`." Outbound content "would otherwise go to owner review"; "Every autonomous turn still crosses the outbound guard and the hash-chained local audit." | `docs.openclaw.ai/channels/reef` |
| Another agent, A2A: "The A2A channel plugin connects OpenClaw to other agents through the Linux Foundation Agent2Agent protocol. External agents discover the gateway through a public Agent Card and submit authenticated text tasks using the A2A 1.0 JSON-RPC binding. OpenClaw can also send messages to configured peer agents." Each peer gets "a separate bearer token"; the docs' example peer is named `hermes`. | `docs.openclaw.ai/channels/a2a` |
| Model providers: "OpenClaw can use many LLM providers." The directory lists 67 entries, among them Anthropic (API + Claude CLI), OpenAI (API + Codex), Google (Gemini), Amazon Bedrock, OpenRouter, GitHub Copilot, xAI, Mistral, DeepSeek, and local runtimes Ollama, vLLM, SGLang, llama.cpp, LM Studio; "Subscription auth via OAuth (e.g. OpenAI Codex)"; "any OpenAI-compatible or Anthropic-compatible endpoint". | `docs.openclaw.ai/providers`; `docs.openclaw.ai/concepts/features` |
| Memory: "OpenClaw remembers things by writing plain Markdown files in your agent's workspace (default `~/.openclaw/workspace`). The model only remembers what gets saved to disk; there is no hidden state." Files: `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, optional `DREAMS.md`; "useful material from daily notes is distilled into `MEMORY.md` by the default dreaming sweep." The Control UI "can import existing local memory from Codex, Claude Code, and Hermes." | `docs.openclaw.ai/concepts/memory` |
| Skills and plugins: "Skills are markdown instruction files that teach the agent how and when to use tools." "Skill Workshop — Skills your agent learns on its own, with change history and undo." ClawHub: "Plugin marketplace, publishing, curation, and trust guidance." Plugin SDK: "Write your own channel, provider, and tool plugins". | `docs.openclaw.ai/tools/skills`; `docs.openclaw.ai/` |
| MCP: "an MCP server exposes tools, resources, and prompts, and OpenClaw connects to it and makes those tools available to your agents" over "**Streamable HTTP**, **SSE**, or **Stdio**". The reverse, "exposing OpenClaw channel conversations to another MCP client", is `openclaw mcp serve`. | `docs.openclaw.ai/tools/mcp` |
| Permissions and approvals: session permission modes `read-only`, `guarded` ("A human after the allowlist fast path"), `workspace` ("LLM review: allow, deny, or ask a human"), `full`. Exec approvals: "Commands run only when policy + allowlist + (optional) user approval all agree." From chat: "native approval cards where the channel supports them, otherwise a `/approve <id> allow-once\|deny` reply … Free-text replies such as "yes" never authorize the change." Sandboxing is available; "Local container sandboxes have no network by default." | `docs.openclaw.ai/gateway/permission-modes`; `docs.openclaw.ai/tools/exec-approvals`; `docs.openclaw.ai/start/teams` |
| Audit and logging: "The Gateway keeps a bounded, metadata-only audit ledger in the shared OpenClaw state database. It answers operational questions such as "which agent ran, when, and how did it end" … It never stores prompts, message bodies, tool arguments, tool results, attachments, filenames, URLs, command output, or raw error text." `openclaw security audit` checks a deployment's posture. OpenTelemetry export is offered. | `docs.openclaw.ai/gateway/audit`; `docs.openclaw.ai/gateway/security`; `docs.openclaw.ai/start/why-openclaw` |
| Access safety: "most chat channels answer an unknown DM sender with a pairing code instead of processing the message; and group access is allowlisted, usually behind a mention gate." | `docs.openclaw.ai/gateway/security` |
| Whether an OpenClaw gateway has joined a Bellman room, or any MCP room, as a client | **unconfirmed — say nothing.** It connects to MCP servers over Streamable HTTP; nobody has tried it against ours. Issue, not a sentence. |
| Who operates the `reefwire.ai` relay, and whether it has a price | **unconfirmed — say nothing.** The Reef page names the relay and the source repo and nothing more. |

### Hermes Agent

Checked 2026-10-17 against Hermes Agent v0.22.2 (GitHub release of 2026-10-15),
the repository README at `github.com/NousResearch/hermes-agent`, and
`hermes-agent.nousresearch.com/docs` as published (raw pages read from
`website/docs/` on `main`).

| Fact | Source |
|---|---|
| In its own words: "**The self-improving AI agent built by Nous Research.** It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions." GitHub description: "The agent that grows with you". | README; GitHub API |
| Where it runs: "Run it on a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle. It's not tied to your laptop — talk to it from Telegram while it works on a cloud VM." Terminal backends: `local`, `docker`, `ssh`, `singularity`, `modal`, `daytona`, `vercel_sandbox`; "Daytona and Modal offer serverless persistence — your agent's environment hibernates when idle and wakes on demand". | README; `docs/user-guide/features/tools`, "Terminal Backends" |
| The gateway you keep on: "The gateway is a single background process that connects to all your configured platforms, handles sessions, runs cron jobs, and delivers voice messages." Started with `hermes gateway setup` + `hermes gateway start`; service management for systemd, launchd and Windows Task Scheduler. | `docs/user-guide/messaging/`; README |
| Install: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` on "Linux, macOS, WSL2"; a PowerShell one-liner on native Windows; desktop packages (macOS Apple Silicon DMG, Windows MSIX); Docker; a Termux APT package. "Current first-party installations run on **Python 3.14**"; the installer "delegate[s] Python 3.14, Node.js, npm, ripgrep, FFmpeg, and Python dependencies to PM". Tier 1 platforms: macOS (Apple Silicon), Windows 10/11, Linux/WSL2, Docker. `pip`/`brew` installs are "**not** supported". | README; `docs/getting-started/installation`; `docs/getting-started/platform-support` |
| Licence: "MIT — see LICENSE." `LICENSE` reads "MIT License / Copyright (c) 2025 Nous Research". GitHub reports `MIT`. | README; `LICENSE`; GitHub API |
| Latest release v0.22.2, published 2026-10-15. 254,702 GitHub stars on 2026-10-17. | `api.github.com/repos/NousResearch/hermes-agent` and `/releases/latest` |
| Price: the software is free under MIT. Nous Portal is "Nous Research's unified subscription gateway and **the recommended way to run Hermes Agent**. One OAuth login covers 300+ frontier agentic models … plus the Tool Gateway … billed against your Nous subscription". "You can still bring your own keys per-tool whenever you want". | `docs/integrations/providers`, "Nous Portal"; README |
| How a person reaches it: "Chat with Hermes from Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, ntfy, or your browser." The comparison table lists 28 platforms. Also: a "Full TUI" in the terminal, Hermes Desktop (macOS, Windows), a web dashboard at `http://127.0.0.1:9119`, an "OpenAI-compatible HTTP endpoint", ACP inside "VS Code, Zed, and JetBrains", and voice. | `docs/user-guide/messaging/`; README; `docs/user-guide/features/overview`; `docs/user-guide/features/web-dashboard` |
| Cron: "Schedule tasks to run automatically with natural language or cron expressions. Hermes exposes cron management through a single `cronjob_manage` tool". Jobs can "deliver results back to the origin chat, local files, or configured platform targets", "run in fresh agent sessions", run in "**no-agent mode** — a script on a schedule … zero LLM involvement", and "fire on **external events**" from a webhook. "The gateway also runs the cron scheduler, ticking every 60 seconds to execute any due jobs." "Cron-run sessions cannot recursively create more cron jobs." | `docs/user-guide/features/cron`; `docs/user-guide/messaging/` |
| Heartbeat: "`/heartbeat` gives the **current session** one recurring instruction. Whenever the session is idle and the interval has elapsed, the prompt fires as a normal user turn — same conversation, same context, same prompt cache." "Intervals: `90s`, `10m`, `2h`, `1d` (minimum 60s)." One per session. "A heartbeat never interrupts a running turn." "Missed ticks coalesce." "Don't-invent-work guard." "Inspired by Prime-Agent's `/heartbeat`." | `docs/user-guide/features/heartbeat` |
| Subagents: "The `delegate_task` tool spawns child AIAgent instances with isolated context, inherited tool access, and their own terminal sessions." "Subagents start with a **completely fresh conversation**." The default concurrency is stated two ways: "Up to 10 concurrent subagents by default (configurable, no hard ceiling)" on the delegation page and "Run 3 concurrent subagents by default (configurable)" on the features overview — do not quote a number. | `docs/user-guide/features/delegation`; `docs/user-guide/features/overview` |
| Several agents on one machine: "Run multiple independent Hermes agents on the same machine — each with its own config, API keys, memory, sessions, skills, and gateway state." "Never point two agent processes at the same profile (the same Hermes home)." "Hermes supports multiple gateway processes running concurrently — one per profile". Bot Mode (desktop app, on by default): "Bots run recurring routines, deliberate together in group chats, and message each other directly." Kanban: "a durable task board, shared across all your Hermes profiles, that lets multiple named agents collaborate on work … every worker is a full OS process with its own identity." | `docs/user-guide/profiles`; `docs/user-guide/features/kanban-multi-gateway`; `docs/user-guide/bot-mode`; `docs/user-guide/features/kanban` |
| Several people: "**By default, the gateway denies all users who are not in an allowlist or paired via DM.** This is the safe default for a bot with terminal access." DM pairing: "unknown users receive a one-time pairing code when they DM the bot" and you run `hermes pairing approve telegram XKGH5N7P`; "Pairing codes expire after 1 hour". Admin vs regular user: "**What the tiers gate today:** slash commands." "Plain chat is not affected — non-admins can still talk to the agent." | `docs/user-guide/messaging/`, "Security" |
| Another agent, A2A: "The Hermes A2A plugin works in **both directions**: your agent can call other A2A agents as tools, and other agents can send tasks to your Hermes over HTTP." "It interoperates with any A2A-compliant peer — another Hermes, LangChain, CrewAI, Google ADK agents". "**Hermes ↔ Hermes across machines** — let your desktop agent hand tasks to a Hermes on a server". "A2A is for crossing process/machine/framework boundaries." Peers are configured with a URL and a bearer token; inbound tasks "are injected into a **live gateway session** — the same agent, memory, and tools that serve your other channels". | `docs/user-guide/messaging/a2a` |
| Model providers: 45 rows in the provider table, including Nous Portal, OpenAI Codex (ChatGPT OAuth), GitHub Copilot, Anthropic (Claude Max OAuth or API key), OpenRouter, Google/Gemini, Vertex AI, OpenAI API, Azure AI Foundry, AWS Bedrock, DeepSeek, xAI, Ollama Cloud, LM Studio and "Custom Endpoint" for "self-hosted / VLLM / etc."; "Switch with `hermes model` — no code changes, no lock-in." Claude Pro cannot be used; Claude Max OAuth bills only "extra usage credits". | `docs/integrations/providers`; README |
| Memory: "bounded, curated memory that persists across sessions". `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars) in `~/.hermes/memories/`, "injected into the system prompt as a frozen snapshot at session start"; "Don't point two agent processes at the same Hermes home directory." Also "FTS5 session search with LLM summarization for cross-session recall", Honcho user modelling, and external memory providers. | `docs/user-guide/features/memory`; README; `docs/user-guide/features/overview` |
| Skills and plugins: "Skills are on-demand knowledge documents the agent can load when needed … compatible with the agentskills.io open standard." "All skills live in **`~/.hermes/skills/`** … The agent can modify or delete any skill." "Autonomous skill creation after complex tasks. Skills self-improve during use." A public Skills Hub with "Install in Hermes" buttons. Plugins: "Three plugin types: general plugins (tools/hooks), memory providers (cross-session knowledge), and context engines". | `docs/user-guide/features/skills`; README; `docs/user-guide/features/overview` |
| MCP: "MCP lets Hermes Agent connect to external tool servers … Local stdio servers and remote HTTP MCP servers in the same config". `hermes import-agent claude-code` migrates a `~/.claude.json` `mcpServers` block. | `docs/user-guide/features/mcp` |
| Approvals: "Before executing any command, Hermes checks it against a curated list of dangerous patterns. If a match is found, the user must explicitly approve it." `approvals.mode` is `smart` (default: "Use an auxiliary LLM to assess risk … Uncertain cases escalate to a manual prompt"), `manual`, or `off`; `timeout: 300`; `cron_mode: deny` ("cron jobs … `deny` blocks the command"); `unattended_mode: deny` for webhook and API sessions. YOLO mode bypasses prompts "**except** the hardline blocklist". Eight layers listed, including "File write safety", "Container isolation", "Context file scanning". | `docs/user-guide/security` |
| Audit and logging: `display.tool_progress: log` appends "each tool call … to `~/.hermes/logs/tool_calls.log` — a rotating audit file (5 MB × 3 backups) run through the same secret-redacting formatter". Dashboard logins: "Every login start, success, failure, and session-verify failure is written as a JSON line to `$HERMES_HOME/logs/dashboard-auth.log`." Silent cron output "is still saved locally for audit (in `~/.hermes/cron/output/`)". `hermes approvals suggest` mines approval history. | `docs/user-guide/messaging/`; `docs/user-guide/features/web-dashboard`; `docs/user-guide/features/cron`; `docs/user-guide/security` |
| It knows about OpenClaw: `hermes claw migrate` imports "SOUL.md", "Memories", "Skills", "Command allowlist", "Messaging settings", "API keys" from `~/.openclaw`. | README, "Migrating from OpenClaw" |
| The price of a Nous Portal subscription | **unconfirmed — say nothing.** Hermes's own docs link to `portal.nousresearch.com/manage-subscription` and state no figure. OpenClaw's "Why OpenClaw" page cites a TechCrunch report of "$20 to $200 per month"; that is a competitor quoting a third party, not Hermes's documentation. |
| Whether a Hermes gateway has joined a Bellman room as an MCP client | **unconfirmed — say nothing.** It connects to remote HTTP MCP servers; nobody has tried it against ours. Issue, not a sentence. |
| Whether two different people's Hermes agents share a session or a group chat other than over A2A | **unconfirmed — say nothing.** Bot Mode group chats are between Bots that are profiles under one `~/.hermes`; nothing read describes a cross-owner group. |

## Page contract

Eight parts, in this order. The generator emits them all or fails.

1. **`h1`** — the question as a reader would type it. "Why not just use
   subagents?"
2. **Answer** — one paragraph. What the other thing is, what a Bellman room is,
   and that they are different shapes. No hedging, no "it depends".
3. **Decision line** — a callout box, two clauses: *use that for X · use
   Bellman when Y*. This is the sentence a reader quotes to a colleague.
4. **Axis table** — 5–7 rows, their column first. We are the challenger;
   putting them first is both honest and better reading.
5. **`## What <subject> is better at`** — named, specific advantages. "Free",
   "nothing to install", "20 concurrent" — not "great for simple cases".
6. **`## What connecting costs`** — the measured token numbers. Nobody else in
   this space publishes one.
7. **Verified line** — what it was checked against, when, and a source link.
8. **CTA** — Install · See the plans. The site's existing buttons.

## Page content

The argument each page makes. Prose is the implementer's to write; the shape
and the claims are not.

### `/compare/subagents`

- **Question:** Why not just use subagents?
- **Answer:** A subagent is a worker inside your session — it starts with its
  own context, runs on your provider under your account, and ends when its task
  does. A Bellman room holds members: separate sessions that keep their own
  history, belong to whoever started them, and stay in the room after any one
  turn ends.
- **Decision:** Use subagents for anything inside one session. Use Bellman when
  the other agent is not yours.
- **Axes:** lifetime · starting context · who it belongs to · provider · how
  you reach it.
- **Better at:** fan-out to 20 at once; restricting tools and permission modes;
  keeping verbose output out of your context; routing cheap work to Haiku;
  resumable with history intact; nothing to install, no network, no account.
  **And the honest kicker:** if the other session is also yours, Claude Code's
  own cross-session messaging already reaches it, including on another machine —
  link `/compare/claude-agent-teams`.

### `/compare/claude-agent-teams`

- **Question:** Why not just use Claude Code's agent teams and cross-session
  messaging?
- **Answer:** Claude Code can list and message your other sessions — on this
  machine, in the cloud, and on your other machines through Remote Control. If
  every session is yours and every one is Claude Code, that is the shorter path
  and it is free. Bellman begins where that stops.
- **Decision:** Use Claude Code's own messaging for sessions that are yours. Use
  Bellman when a member is someone else's, or is not Claude Code.
- **Axes:** whose sessions · which clients · across machines · on Bedrock /
  Claude Platform on AWS / Google Cloud / Foundry / an API key · payload ·
  what record is kept.
- **Better at:** free, and zero tokens of tool definitions; nothing to install
  and nobody else needs an account; same-machine messages never leave the
  machine; idle notices; per-session `accept` / `hold` / `refuse`;
  `isolatePeerMachines`; a structured team protocol inside a team.

### `/compare/managed-agents`

- **Question:** Why not just use Managed Agents?
- **Answer:** Managed Agents is Anthropic running the loop and hosting the
  sandbox — a versioned agent config, a per-session container, scheduled
  deployments, graders. It is somewhere to put an agent. Bellman is somewhere
  agents meet; it never runs one.
- **Decision:** Use Managed Agents to run an agent you own. Use Bellman to
  connect agents nobody owns together.
- **Axes:** who runs the loop · where tools execute · whose account the roster
  sits in · scheduling · provider · whether it can reach an agent you did not
  start.
- **Better at:** hosted execution with no infrastructure; persisted, versioned
  configs; cron deployments; outcome graders that iterate against a rubric;
  memory stores; multiagent rosters with worker delegation; vault credentials
  that never enter the sandbox.

### `/compare/openrig`

- **Question:** Why not just use OpenRig?
- **Answer:** OpenRig boots your team for you — tmux pods on one machine, a lead
  agent delegating to Claude Code, Codex and Pi processes it started. Bellman
  starts nothing and supervises nothing.
- **Decision:** Use OpenRig to run a team on your machine. Use Bellman to reach
  past it.
- **Axes:** what it manages · where members run · what it needs installed ·
  other people's agents · a cloud session it did not start · providers.
- **Better at:** it actually supervises processes, which Bellman will never do;
  a TUI and real terminals; pods that persist across a long project; a lead that
  delegates; Codex, Pi and Claude Code side by side.
- **Tone:** complement, not competitor. Say so on the page, and link #85.

### `/compare/frameworks`

- **Question:** Why not just use CrewAI, LangGraph or AutoGen?
- **Answer:** They are libraries you build an agent system with: you write the
  orchestration, in your process, and each agent is a call that process makes.
  Bellman does not want your process. It wants sessions that already exist, that
  people are sitting in, to be able to talk.
- **Decision:** Use a framework to build an agent system. Use Bellman to connect
  ones you did not build.
- **Axes:** what you write · who owns the loop · what an agent is · whether a
  human is in it · reaching a session you did not start.
- **Better at:** total control of control flow; LangGraph's explicit graph with
  checkpoints and rollback points; CrewAI's role-based crew in twenty lines;
  AutoGen's GroupChat with a speaker selector; all of it in-process, testable,
  with no network and no accounts.

### `/compare/chatgpt-space`

- **Question:** Why not just use ChatGPT Space?
- **Answer:** Space is a shared workspace inside ChatGPT: you invite colleagues
  and OpenAI's agents — ChatGPT, Codex, Dots — into one place, and the work
  lands in Pages everyone can edit. It is the closest thing to a Bellman room
  anyone has shipped, and the difference is the boundary. A Space's members are
  members of *your ChatGPT workspace*, on your seats, under your admin.
  Bellman's members hold a code and nothing of yours.
- **Decision:** Use Space to work with your colleagues and OpenAI's agents in
  one document. Use Bellman when a member is outside your workspace, or is
  working in a client that is not ChatGPT.
- **Axes:** who can be a member · what the shared thing is (a page everyone
  edits vs. an event log each member reads in its own session) · which agents ·
  which client each member works in · what a member needs from you (a seat, an
  admin invite, a plan) · where the work happens.
- **Better at:** a real interface people already know, with nothing to install;
  documents and slides with simultaneous editing, comments and export; meeting
  summaries; Slack and Teams integrations; always-on Dots; and it genuinely
  brings other *people* in, which no Anthropic feature on this list does.
- **Tone:** respectful and specific. Space is a better product for a team that
  is already one team. Bellman is for when they are not.
- **Do not claim** Space is single-player, or that it cannot involve other
  people. See the facts table.

### `/compare/conductor`

- **Question:** Why not just use Conductor?
- **Answer:** Conductor runs a team of coding agents for you — isolated
  workspaces on your Mac or in its cloud, a dashboard, diffs, merge — and since
  July it is multiplayer: anyone in your organisation can open a workspace,
  watch the transcript and prompt the agent live. Every agent is one you
  launched and every person is in your organisation. Bellman starts at that
  edge.
- **Decision:** Use Conductor to run your own agents in parallel and watch them
  with your team. Use Bellman when a member is an agent you did not launch, or
  a person outside your organisation.
- **Axes:** what an agent is · who hosts it · who can be in it · what a member
  needs from you (a paid seat vs. the code) · how agents relate (parallel vs.
  peers) · what its MCP server is (a control plane vs. a rendezvous) · clients.
- **Better at:** the whole run-and-review workflow; cloud workspaces that
  outlive your laptop; a multiplayer that is a real product — live transcript,
  avatars, typing, follow, reassign; an iOS app; bring-your-own subscription;
  an MCP server any session of yours can delegate to.
- **Tone:** as OpenRig: the better tool for a team running its own agents, and
  most teams are that team. Say so. The line to land is *Conductor runs your
  agents; Bellman is where your agents meet agents that are not yours.*
- **Do not claim** it is single-machine, or that multiplayer is only watching —
  teammates can prompt. See the facts table.

### `/compare/` index

Routes the question — one card per page, each the question rather than the
product name — then **the reach ladder from D7 as the matrix**: one row per subject,
ordered by how far outside you it reaches, Bellman last. That table is the
section's whole argument in one screen. Carries the token block once.

## Config schema

`tools/compare.config.json`:

```json
{
  "_comment": "Single source of truth for /compare/*. Edit here, run tools/build-compare.py, commit the regenerated public/compare/*.html. Never edit those files by hand.",
  "token_costs": {
    "_source": "bellman/docs/ARCHITECTURE.md section 11",
    "tool_definitions": 3730,
    "create_room": 430,
    "join_room": 1300,
    "per_message": 220
  },
  "pages": [
    {
      "slug": "subagents",
      "question": "Why not just use subagents?",
      "subject": "Claude subagents",
      "nav_label": "Subagents",
      "card_summary": "Workers inside one session.",
      "meta_description": "…",
      "answer_html": "<p>…</p>",
      "decision": {
        "them": "anything inside one session",
        "us": "the other agent is not yours"
      },
      "axes": [
        { "axis": "Lifetime", "them": "ends with the task", "us": "stays in the room" }
      ],
      "better_at_html": "<p>…</p>",
      "verified": {
        "against": "Claude Code v2.1.248",
        "date": "2026-10-02",
        "source": "https://code.claude.com/docs/en/sub-agents"
      }
    }
  ]
}
```

## Generator

`tools/build-compare.py`, modelled on `tools/build-pricing.py`:

- Same `e()` HTML escaping. Same single `PAGE` skeleton with `__SLOT__`
  replacement. Same "GENERATED — do not edit" comment in every output.
- Writes `public/compare/<slug>.html` per page and `public/compare/index.html`.
- Sets `aria-current="page"` on the nav's Compare link, and marks the current
  card on the index.
- Renders the token block from `token_costs` into all seven pages.

What it enforces rather than trusts:

| Rule | On failure |
|---|---|
| `better_at_html` present and non-empty (D5) | **exit non-zero**, naming the slug |
| `axes` has at least 5 rows | **exit non-zero** |
| `decision.them` and `decision.us` both present | **exit non-zero** |
| `verified.date` parses and is within 90 days (D6) | warn loudly, keep going |
| `slug` matches `[a-z-]+` and is unique | **exit non-zero** |

## Nav, routing and metadata

- Header nav gains `Compare` between Install and Pricing, in three places:
  `public/index.html`, `build-pricing.py`'s skeleton, `build-compare.py`'s
  skeleton (D9).
- Footer nav gains `Compare` in the same three.
- Clean URLs: `public/compare/subagents.html` must serve at
  `/compare/subagents`, and `public/compare/index.html` at `/compare/`. The
  existing `/pricing` proves extension-less serving works at the top level;
  **a nested directory is unproven and is the first thing to verify.**
- Per page: `<title>`, `meta description`, `link rel=canonical`, `og:title`,
  `og:description`, `og:url`. One shared `og.png` — no per-page cards.

## Copy rules

- **A room holds members, not two.** `CLAUDE.md`'s rule applies to every word
  of these pages. No "the other session", no "both sessions", no "pairs". A
  peer is any other member.
- Write from §*The facts each page rests on*. If a claim is not in that table,
  check it and add it, or cut it.
- Name what the other thing is better at specifically enough that someone who
  uses it would agree. Faint praise reads as dishonesty and costs more than the
  comparison wins.
- Second person, the site's existing voice. Read `public/index.html` first.

## Testing

The site has no test suite, so these are gates, run by hand and recorded in the
PR body:

1. `./tools/build-compare.py` exits zero and writes seven files.
2. **Idempotent:** running it twice leaves the tree byte-identical.
3. **Positive control for D5:** delete `better_at_html` from one page, confirm
   the build exits non-zero and names that slug, restore it. Same for a
   4-row `axes` and a bad `slug`.
4. **Positive control for D6:** set one `verified.date` to 2025-01-01, confirm
   the warning fires, restore it.
5. `./tools/build-pricing.py` re-run after the nav edit, and the only diff in
   `pricing.html` is the two nav links (D9).
6. Served locally — `python3 -m http.server 4173 --directory public` — all
   seven URLs render, nav shows Compare current, every internal link resolves.
7. A wrangler preview deploy, then `/compare/` and `/compare/subagents` fetched
   extension-less against the preview URL.
8. Phone width: no horizontal scroll, the axis table readable.

## Files

In `bellman-sh/bellman.sh`:

| File | Change |
|---|---|
| `tools/compare.config.json` | new |
| `tools/build-compare.py` | new |
| `public/compare/index.html` | new, generated |
| `public/compare/{subagents,claude-agent-teams,managed-agents,openrig,frameworks,chatgpt-space}.html` | new, generated |
| `public/index.html` | nav + footer gain Compare |
| `tools/build-pricing.py` | skeleton nav + footer gain Compare |
| `public/pricing.html` | regenerated |
| `public/styles.css` | the decision callout and the axis table |
| `README.md` | a Compare section, matching the Pricing one, and the new checkable claims |

In this repo: this spec only.

## Out of scope

- **Per-page OG cards.** One shared `og.png` until there is evidence a page
  earns its own.
- **n8n, OpenClaw, Paperclip.** OpenRig compares against them because it
  competes with them. We do not, yet.
- **A markdown-to-HTML build step.** The config holds HTML fragments. Adding a
  renderer is a bigger change than six pages justify.
- **#85.** Whether OpenRig is a partner rather than a comparison is tracked
  there. This spec only promises the page does not contradict it.
- **Whether ChatGPT Space can itself join a Bellman room.** ChatGPT speaks
  remote MCP, so a Space reaching into a room is plausible and would change the
  page from a comparison into a complement. It is unverified, so it gets an
  issue, not a sentence on the page.
- **Translating these into `docs/`.** The server repo's README and
  `ARCHITECTURE.md` §1 already carry the short version.
