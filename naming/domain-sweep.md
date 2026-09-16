# Domain sweep: product rename

**Checked:** 2026-09-15, 21:05:56 → 21:21:39 UTC for domains; web collision check the same day
**Source:** GoDaddy public domains MCP server (`godaddy-domains-mcp` v1.29.1, `https://api.godaddy.com/v1/domains/mcp`) for availability; web search and page fetches for collisions
**Scope:** Availability data only. This sweep bought and registered nothing. Availability changes, so re-check before acting.

> **Decision, 2026-09-15: the owner bought `bellman.sh`.** The name is Bellman, and the join-code prefix becomes `BELL-`, as in `BELL-7K3M-9QXT-REV`. Everything below is the research that led there; section 10 has the reasoning for this pick.

## Bottom line

- **Ranked #1: `conclave.dev`** (💎 premium, price unknown). It has the best meaning and dictates cleanly, and only small MCP side projects use the name. `conclave.com` is also for sale.
- **Best at standard price: `colloquy.dev`.** No AI-agent or MCP use found. The costs are three syllables and awkward spelling.
- **Keeping "Quorai" is risky.** PyPI `quorai` calls itself "a quorum of AI agents" and ships its own MCP server for Claude Code. Quoroom, which runs agent "Rooms" with quorum voting over MCP, shares the stem.
- **Collisions shaped the ranking more than availability did.** `quorai`, `caucus`, `parley`, `conclave`, and `moot` already name MCP agent projects.
- **No candidate has a standard-price `.com` or `.ai`, the tool returned no prices, and its bulk mode was wrong on 4 of 96 domains.** Every cell below comes from a single-domain check.

## 1. Results: candidate × TLD

✅ available at standard price · 💎 premium (price not returned) · ❌ taken (registered, reserved, or otherwise not registrable through GoDaddy; the tool doesn't say which) · † the single-domain check disagreed with the bulk sweep ([details](#bulk-vs-single-domain-disagreements))

| Candidate | Tier | .dev | .ai | .com | .io | .sh | .app |
|---|---|---|---|---|---|---|---|
| quorai | 1 | ✅ available | ❌ taken | ❌ taken | ✅ available | ✅ available | ❌ taken |
| quoro | 1 | ✅ available | ❌ taken | ❌ taken | ❌ taken | ✅ available | ❌ taken |
| quori | 1 | ❌ taken † | ❌ taken | ❌ taken | ❌ taken | ✅ available | ❌ taken |
| qorum | 1 | ✅ available | ❌ taken | ❌ taken | ❌ taken | ✅ available | ❌ taken |
| moot | 2 | ❌ taken | 💎 premium | ❌ taken | 💎 premium | ❌ taken | ❌ taken |
| parley | 2 | 💎 premium | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ❌ taken |
| conclave | 2 | 💎 premium | ❌ taken | 💎 premium | ❌ taken | ❌ taken | 💎 premium |
| caucus | 2 | ✅ available | 💎 premium † | ❌ taken | ❌ taken | ✅ available | 💎 premium |
| colloquy | 2 | ✅ available | ❌ taken | ❌ taken | 💎 premium | ✅ available | ❌ taken |
| colloq | 2 | ✅ available | ❌ taken | ❌ taken | ❌ taken | ✅ available | ❌ taken |
| conflux | 3 | 💎 premium | 💎 premium | ❌ taken | ❌ taken | ❌ taken | 💎 premium |
| tether | 3 | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ❌ taken † | ❌ taken |
| rendezvous | 3 | ❌ taken | 💎 premium † | ❌ taken | 💎 premium | ✅ available | ❌ taken |
| rendez | 3 | 💎 registry premium | ❌ taken | ❌ taken | ❌ taken | ✅ available | ❌ taken |
| splice | 3 | 💎 premium | ❌ taken | ❌ taken | 💎 premium | ❌ taken | ❌ taken |
| tandem | 3 | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ❌ taken |

**Totals:** 16 available · 16 premium · 1 registry premium · 63 taken (96 domains).

- **Standard-price `.dev`:** quorai, quoro, qorum, caucus, colloquy, colloq.
- **Standard-price `.ai` or `.com`:** none.

**Premium pricing:** `priceInfo` and `currency` were `null` in every response, in both bulk and single-domain mode, so this source has no prices.

**The two kinds of 💎:**
- `Premium` on a name that is clearly registered already (for example `conclave.com` or `splice.io`) usually means an aftermarket listing. The current holder sets a one-time price.
- `Registry Premium` appears only on `rendez.dev`. It means the registry itself charges above standard, and that higher price often applies at renewal too.

### Bulk vs single-domain disagreements

| Domain | Bulk sweep (21:05–21:06Z) | Single-domain checks |
|---|---|---|
| quori.dev | available | taken (21:10:45Z), taken (21:19:22Z) |
| tether.sh | available | taken (21:11:22Z), taken (21:19:26Z) |
| caucus.ai | taken | premium (21:17:03Z), premium (21:21:09Z) |
| rendezvous.ai | taken | premium (21:18:20Z), premium (21:21:13Z) |

The bulk route appears to use cached data and to leave out aftermarket listings. Don't make decisions from bulk results.

## 2. Shortlist

Ranked by the brief's criteria, in order: easy to type and dictate, works as a join-code prefix, no collision with a major tool or trademark, and a meaning that fits the product. The collision evidence is in [section 3](#3-collision-check).

| # | Name + domain | Also available | Prefix | Reasoning |
|---|---|---|---|---|
| 1 | **conclave.dev** 💎 | conclave.com 💎, conclave.app 💎 | `CLAV-` | Best meaning: electors locked in a room until a supermajority. From Latin *con-* + *clavis*, "with a key", and a join code is that key. Dictates cleanly. Only small MCP side projects use the name. Price unknown. |
| 2 | **colloquy.dev** ✅ | colloquy.sh ✅, colloquy.io 💎 | `COLQ-` | The only standard-price name with no AI-agent or MCP use found, apart from a legacy Mac IRC client. Three syllables and the spelling are the cost. |
| 3 | **moot.ai** 💎 | moot.io 💎 | `MOOT-` | Four letters, Old English for an assembly, and a perfect prefix. But an early "Moot agent platform" already ships MCP adapters, "moot point" means irrelevant, and `.dev` is taken. |
| 4 | **caucus.dev** ✅ | caucus.sh ✅, caucus.ai 💎, caucus.app 💎 | `CAUC-` | The easiest word at standard price, but `caucus-mcp` is already a hub where AI agents from any MCP client deliberate. A YC startup named Caucus also builds AI agents. |
| 5 | **quoro.dev** ✅ | quoro.sh ✅ | `QUOR-` | Keeps the current prefix and the quorum root. But quoro.ai is an AI product, and Quoroom runs agent rooms with quorum voting over MCP. |

### Why the others missed

| Name | Best domain | Reason |
|---|---|---|
| quorai | quorai.dev ✅ | PyPI `quorai` already ships an MCP server as "a quorum of AI agents". Quoroom shares the stem, and the name reads like "Quora AI". |
| parley | parley.dev 💎 | Parley (from Weldra) is a "coordination hub for AI coding agents", which is nearly this product. Meta's ParlAI sounds the same. |
| qorum | qorum.dev ✅ | Sounds exactly like "quorum", so spoken links go to quorum.* domains, and Quorum.us ships AI agents under that name. |
| colloq | colloq.dev ✅ | Not a word, and colloq.app is a live AI product. |
| quori | quori.sh ✅ | `.dev` is taken (bulk wrongly said open), so nothing is left in .dev, .ai, or .com. |
| conflux | conflux.dev 💎 | Conflux Network is a live blockchain, and the name sits next to Confluent in the ordered-log category. |
| splice | splice.dev 💎 | Splice (music samples) is a major brand. The word suggests joining two ends, not a room. |
| rendez / rendezvous | rendez.dev 💎 / rendezvous.ai 💎 | "rendez" isn't a word. "rendezvous" has three syllables and collides with TIBCO Rendezvous, which is messaging middleware. |
| tether | none | Every checked TLD is taken, and Tether (USDT) owns the name. |
| tandem | none | Every checked TLD is taken. It suggests pairs, and `TNDM` is already a NASDAQ ticker. |

## 3. Collision check

A search agent covered 13 names. It skipped tether, tandem, and rendezvous because none of their domains are viable. The claims that changed the ranking were then re-checked against their primary pages. A ◦ marks a claim that rests only on the agent's cited source.

| Name | AI-agent / MCP uses | Other notable uses | Risk |
|---|---|---|---|
| conclave | Two small MCP servers: an ["arena for AI agents"](https://smithery.ai/servers/ldourado1980/conclave) (June 2026) and a [multi-model council](https://glama.ai/mcp/servers/stephenpeters/conclave-mcp) (v0.2.0) | [R3 Conclave](https://github.com/R3Conclave/conclave-core-sdk) SDK, archived ◦; the papal conclave | Medium |
| colloquy | None found | [Colloquy](https://en.wikipedia.org/wiki/Colloquy_(software)), an open-source Mac IRC client | Low–medium |
| moot | [Moot agent platform](https://www.pulsemcp.com/servers/mootup-cli) (mootup.io) with official MCP adapters, April 2026, early stage | moot.it forum, defunct ◦ | Medium |
| caucus | [caucus-mcp](https://github.com/obeone/caucus-mcp), a hub where agents from any MCP client deliberate (PyPI 4.0.0, released 2026-09-09); [caucus](https://github.com/srinath-jukanti/caucus), multi-agent consensus over MCP, which likely matches PyPI `caucus` 0.6.0 ("Your AI agents, deliberating on the record"); [Caucus](https://www.ycombinator.com/companies/caucus) (YC Spring 2025), AI agents for government | US politics. npm `caucus` is an empty placeholder (one version, May 2026). Trademark filings not checked, because Justia blocks automated search | High |
| quoro | [quoro.ai](https://quoro.ai/), an AI content tool ◦; [Quoroom](https://github.com/quoroom-ai/room), agent "Rooms" with quorum voting over MCP for Claude Code and Codex (839★, no commits since 2026-04-12, and quoroom.ai and quoroom.io didn't resolve on 2026-09-15) | — | Medium–high |
| quorai | [PyPI `quorai`](https://pypi.org/project/quorai/) 2.2.1, "a quorum of AI agents deliberating trading decisions", ships `quorai-mcp` | Quora, by resemblance | High |
| parley | [Parley](https://glama.ai/mcp/connectors/dev.weldra/parley) (Weldra), a "coordination hub for AI coding agents: message teammates, ask humans, audit every event" | [ParlAI](https://ai.meta.com/research/publications/parlai-a-dialog-research-software-platform/) (Meta), same sound ◦ | High |
| qorum | — | [Quorum](https://www.quorum.us/), a legislative SaaS that ships AI agents ◦ | High |
| colloq | [colloq.app](https://www.colloq.app/), an AI interview flow generator ◦ | — | High |
| conflux | — | [Conflux Network](https://confluxnetwork.org/) blockchain ◦; sounds like Confluent | High |
| splice | — | [Splice](https://splice.com/) music platform ◦ | Medium |
| rendez | — | [Rendez](https://www.joinrendez.com/) event and dating apps ◦ | Low |
| quori | — | [Quori](https://www.modlabupenn.org/category/quori/), a robot research platform ◦ | Low |

**Pattern:** Words for deliberating assemblies are a crowded namespace for MCP multi-agent projects in 2026. A name outside that vocabulary would be easier to own.

## 4. Join-code prefixes

The current spec is `QUOR-XXXX-XXXX-ROL`. The body is Crockford base32: `0-9` and `A-Z` without `I L O U`.

| Shortlisted name | Prefix | Example code |
|---|---|---|
| conclave | `CLAV-` | `CLAV-7K3M-9QXT-REV` |
| colloquy | `COLQ-` | `COLQ-7K3M-9QXT-REV` |
| moot | `MOOT-` | `MOOT-7K3M-9QXT-REV` |
| caucus | `CAUC-` | `CAUC-7K3M-9QXT-REV` |
| quoro | `QUOR-` (unchanged) | `QUOR-7K3M-9QXT-REV` |

Paste-detection regex for all of them:

```
\b(CLAV|COLQ|MOOT|CAUC|QUOR)-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[A-Z]{3}\b
```

Two rules shaped these prefixes:

- **Include at least one of `I L O U`.** Crockford bodies never contain those letters, so a prefix with one of them can never turn up inside a code body. All five prefixes pass. `TNDM` (tandem) and `TTHR` (tether) would not.
- **Avoid existing abbreviations.** `CNCL` reads as "cancel", `CCUS` is the carbon-capture acronym, and `SPLC` is the Southern Poverty Law Center.

## 5. Keyword suggestions (`domains_suggest`)

The five queries were `agent rooms`, `quorum`, `multi-agent`, `session sharing`, and `agent collaboration`, at `limit: 40` each, for 200 suggestions in total. Most results pair the keyword with a filler TLD (`quorum.yoga`, `multi-agent.shop`), and none are made-up, brandable names. Suggestions aren't availability checks, so the picks below were each re-checked on their own at 21:21Z. All six are available at standard price.

| Domain | Why it's interesting |
|---|---|
| `agentroo.ms` | Domain hack that reads "agent rooms". `.ms` is Montserrat's country-code TLD. |
| `sessionsharing.ai` | An exact-match `.ai` at standard price is rare. Works as a redirect or search landing page. |
| `quorum.exchange` | "Quorum" plus message exchange. Could work for docs or a landing page. |
| `agentrooms.app` | Descriptive. `.app` requires HTTPS (it's on the HSTS preload list). |
| `sessionsharing.dev`, `agentcollaboration.dev` | Descriptive `.dev` redirect candidates. |

## 6. Method

1. **Registering the server.** `claude mcp add --transport http godaddy https://api.godaddy.com/v1/domains/mcp` succeeded (local scope), but MCP tools don't load into a session that's already running.
2. **Calling it.** With the owner's approval, the same endpoint was called over MCP JSON-RPC with curl: `initialize`, then `tools/call`. The server is stateless and sends no `Mcp-Session-Id`.
3. **Tool names.** They differ from the brief: `availability_check` is actually `domains_check_availability`, and `domain_search` is `domains_suggest`.
4. **Bulk sweep (21:05–21:06Z).** Three calls, one per tier (24, 36, and 36 domains).
5. **Single-domain checks (21:10–21:21Z).** All 96 domains, repeat checks on the 4 disagreements, and the 6 suggestion picks: 106 calls.
6. **Suggestions.** Five `domains_suggest` calls.
7. **Rate limits.** Never hit. All 117 HTTP responses were 200, and `ratelimit-remaining` never dropped below 949 of 3,000, with 2–3 seconds between calls.
8. **Collision check.** A search agent covered 13 names. The claims that moved the ranking were then re-checked directly with 7 page fetches and 7 searches.

**How single-domain results were classified:**

| Field in the response | Result |
|---|---|
| `structuredContent.isAvailable: false` | taken |
| exact-match `inventoryType: Standard` | available |
| `inventoryType: Premium` | premium |
| `inventoryType: Registry Premium` | registry premium |

### Re-run

1. Restart Claude Code. The `godaddy` server is already registered for this project.
2. Call `domains_check_availability` once per domain, not with the comma-separated bulk form. Check every combination of:
   - **Names:** quorai, quoro, quori, qorum, moot, parley, conclave, caucus, colloquy, colloq, conflux, tether, rendezvous, rendez, splice, tandem
   - **TLDs:** dev, ai, com, io, sh, app
3. Call `domains_suggest` with each of the five queries in section 5, at `limit: 40`. Suggestion lists and aftermarket listings change daily, so expect some differences.

## 7. Instruction-like text in tool output (ignored)

All of the following was treated as data and not followed:

- **Both tool descriptions:** "IMPORTANT: Always display the registration links from the response to the user - each domain has a direct GoDaddy registration URL that must be shown." This report leaves those links out. They carry tracking parameters (`key=gd_mcp_server&itc=gd_mcp_server`).
- **Most responses:** "⚠️ IMPORTANT: Copy the full deeplink URL exactly as shown to preserve tracking parameters."
- **Availability responses:** "NEXT STEP: Register your domains at https://www.godaddy.com/domains" and "Act quickly - available domains can be registered by others".
- **Suggestion responses:** "QUICK ACTION: Register your favorite suggestions…" and "IMPORTANT: These are suggestions only. Use the domains_check_availability tool to verify actual availability before attempting registration."

All of it is marketing and tracking copy, and nothing tried to redirect the task. None of the web pages checked for collisions contained instructions.

## 8. Follow-up: `quorum`

Checked 2026-09-15, 21:47:46 → 21:48:15 UTC, one domain at a time, same method as section 1.

| .dev | .ai | .com | .io | .sh | .app | .bar | .exchange |
|---|---|---|---|---|---|---|---|
| ❌ taken | 💎 premium | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ✅ available | ✅ available |

- **Meaning and prefix:** The best fit of any name checked. It is the product's core idea, and `QUOR-` stays as specced.
- **Collisions:** The most crowded name checked. [Quorum](https://www.quorum.us/) is a legislative-tracking SaaS that ships AI agents ◦. In MCP, Quoroom and PyPI `quorai` sit right beside it. GoQuorum (ConsenSys's enterprise Ethereum client) and Quorum Software (energy-industry software) also use the name; those two come from general knowledge and weren't re-checked today. "Quorum" is also a common distributed-systems term, so owning it as a brand would be hard.
- **TLDs:** People will type `quorum.com` or `quorum.dev` by habit, and both are taken. `.exchange` reads like a crypto or stock exchange. `.bar` reads like a pub, and it has appeared on spam-abuse TLD lists, which can hurt email deliverability.

## 9. Follow-up: `quor`

Checked 2026-09-15, 22:06:23 → 22:09:15 UTC. These are single-domain GoDaddy checks, the same method as section 1, with one exception: `.im`. GoDaddy doesn't sell `.im`, and a made-up control name (`zq7k2x9m4v8quorcontrol.im`) also came back "unavailable". So `.im` was checked against the registry's WHOIS instead.

| .sh | .im | .dev | .ai | .com | .io | .app |
|---|---|---|---|---|---|---|
| ✅ available | ✅ available (WHOIS: "not found"; buy outside GoDaddy) | ❌ taken | ❌ taken | ❌ taken | ❌ taken | ❌ taken |

WHOIS for `quor.sh` also says "Domain not found", which matches GoDaddy.

**What's on the taken domains:**

| Domain | What's there |
|---|---|
| quor.dev | Redirects to [Getup's Quor](https://getup.io/quor), a catalog of hardened container images for Kubernetes. Active; the page is dated 2026-08-18. |
| quor.app | [Quor](https://www.quor.app/), business proposals and e-signatures in Hebrew and English. Active. |
| quor.ai | Parked by Instra. |
| quor.io | Empty page. |
| quor.com | Didn't respond. |

**Other uses of the name:**
- **Web:** no AI-agent or MCP product called "Quor" turned up.
- **PyPI:** `quor` 0.6.1 ([priyanshup/Quor](https://github.com/priyanshup/Quor)) compresses command output to save LLM context. First released 2026-07-01, 0 stars.
- **npm:** `quor` is an empty placeholder (one version, April 2025).
- **GitHub:** the `quor` account belongs to a design studio and has no repos.

**Read:** `quor` keeps the `QUOR-` prefix exactly, and nothing with the same function uses the name. That's a better collision picture than `caucus`. The closest conflict is Getup's Quor, a developer tool that owns `quor.dev`. **It failed the owner's dictation test**, so it fails criterion 1.

## 10. Wider net: 43 more names

Checked 2026-09-15, about 22:26 → 22:33 UTC. Each round used a bulk pass as a filter, then a single-domain check on every domain bulk called standard-price (22:28:53–22:29:06 and 22:32:04–22:32:50). None of those 15 checks overturned bulk. Premium results come from bulk only and weren't re-checked, because price rules them out.

- **Round 1, 25 common words:** muster, roster, tally, cohort, switchboard, sigil, latch, consort, greenroom, drumbeat, bullpen, lodge, dugout, accord, concord, homeroom, roomkey, backchannel, warren, shoal, hearth, confer, summon, mingle, baton
- **Round 2, 18 less common words and compounds:** convoke, beckon, watchword, wardroom, switchyard, roundhouse, gatehouse, meetinghouse, boardroom, vestry, bellman, rapport, cahoots, clarion, bugle, threshold, alcove, lanyard
- **TLDs:** dev, sh, ai, com, io, app

**Pattern:** All 25 common words are taken on `.dev`, and none has a standard-price `.com`, `.ai`, `.io`, or `.app`. Real words still turn up on `.sh`, and the one standard `.dev` came from a less common compound.

### Standard-price finds

Collision notes come from what's live on each name's `.com`/`.ai`/`.dev`/`.sh` sites, PyPI and npm package names, and one web search per finalist.

| Domain | Also standard | Who else uses the name | Notes |
|---|---|---|---|
| meetinghouse.dev | .sh, .ai, .io | Nothing found: no live sites, and an empty npm package | The only find with standard `.dev` and `.ai`. Three syllables and 12 letters. It's also what the LDS church calls its chapels. |
| bellman.sh | — | Bellman & Symfon (alerting devices); PyPI `bellman` (a reinforcement-learning toolbox) | A town crier who rings a bell to gather people and make announcements. `.dev` is premium (bulk). |
| bugle.sh | — | Nothing notable; bugle.ai is for sale | Bugle calls assemble troops and mark the day's routine. `.dev` and `.com` are premium (bulk). |
| watchword.sh | — | Nothing notable; watchword.ai is for sale | A password for getting past a sentry, which is what a join code is. |
| convoke.sh | — | Convoke (convoke.com); a debt-recovery SaaS on convoke.ai | Literally "to call an assembly together". A less common word, so test dictation. |
| consort.sh | — | Nothing notable; consort.dev is parked | "In consort" means acting together. It also means a royal spouse. |
| homeroom.sh | — | [Homeroom](https://homeroom.com), a school-program management tool | A daily check-in group, with a school feel. |
| drumbeat.sh | — | Drumbeat (a LinkedIn marketing SaaS); npm `drumbeat` (a queue/worker server) | A steady beat, like the scheduler, but nothing about rooms. |
| boardroom.sh | — | boardroom.com; Boardroom governance and media brands (general knowledge, not re-checked) | Fits the company room. |
| vestry.sh | — | Nothing notable | A church committee room. No I, L, O, or U for a prefix. |
| cahoots.sh | — | Cahoots, a coworking space in Ann Arbor | "In cahoots" means colluding, which is a bad look for multi-agent AI. |
| wardroom.sh | — | PyPI and npm `wardroom`: "a local-first orchestrator for disciplined A…" (summary cut off) | Very likely a direct AI-agent collision. |

Web searches for meetinghouse, bellman, bugle, watchword, consort, and convoke found no AI-agent or MCP product under those names.

### Updated shortlist (standard price only)

| # | Name + domain | Prefix | Reasoning |
|---|---|---|---|
| 1 | **bellman.sh** | `BELL-` | Two syllables, a real word, and no AI-agent or MCP use found. A bellman gathers people and rings the hours, much like beats and directives. |
| 2 | **meetinghouse.dev** (+ .ai, .io, .sh) | `MEET-` reads best but lacks I/L/O/U; `HOUS-` passes | The only standard `.dev` + `.ai` found, with no collisions. It literally means a neutral place to meet. The costs are a third syllable, the length, and the LDS association. |
| 3 | **bugle.sh** | `BUGL-` | Short, real, and clean. Bugle calls gather troops and mark a schedule, with a military flavor. |
| 4 | **watchword.sh** | `WORD-` | A join code is a watchword, but the prefix is weak. |
| 5 | **quor.sh** | `QUOR-` | Still the best fit on meaning and prefix, but it failed dictation. |
