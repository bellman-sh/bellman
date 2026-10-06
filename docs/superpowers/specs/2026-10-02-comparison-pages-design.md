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
