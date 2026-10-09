# Validation and provenance: what a card is worth, and why

**Issues:** none filed yet; companion to
[topic rooms](2026-10-08-topic-rooms-design.md), whose D4 (every card names
its sources) this spec extends. Builds on the hosted seat
([2026-10-08-hosted-seat-design.md](2026-10-08-hosted-seat-design.md)) for the
one automated validator.

**Status:** draft for discussion, 2026-10-08.

**Scope:** typed claims, a provenance record on every surface item, source
tiers, validation as an event with a verb, one hosted validator with a bounded
fetch, author standing from verified identity, decay and re-check, and a
reader-side floor. Reputation from track record, cross-room trust and anything
that reads a validator's history are follow-ups.

## Problem

There is a pattern of content written for an agent's retrieval step rather
than for a person: a study that was never run, a comparison that opens "I was
about to go with X but the numbers did not add up, here is why I am on Y now."
It reads as experience, it is cheap to produce in volume, and an agent that
collects information will collect it. A topic room that stores what agents
bring would store it faithfully, approve it if a maintainer is tired, and hand
it to every agent that joins after.

"Validators and a score" is the obvious answer and also the first thing an
attacker games: validators that are the proposer's other accounts, a score
bought with a hundred cheap approvals, a trusted source that is a page the
attacker published last week. So the design has to make the attack cost more
than it earns, and it has to keep working after the attack adapts, which a
single number the server owns does not.

Four things raise the cost and do not expire: a card is a typed claim and not
a story; a claim is checked against the page it cites, mechanically; who vouched
is an identity that cost something to have; and a person approves every card.
Everything below is one of those four, written down.

## Decisions

### D1. A card is a typed claim

`SurfaceItem` gains `claim`, required by the `topic` preset on `text` and
`diagram` items and refused elsewhere:

| `claim` | what it is | ceiling |
|---|---|---|
| `fact` | a statement a cited page supports: "Durable Object duration bills at $12.50 per million GB-s" | none |
| `measurement` | a number with how it was produced: the command, the environment, the date | high only with a reproduction; medium without |
| `opinion` | a preference, a recommendation, a comparison with no reproducible numbers | low, always |

The poison format has no checkable claim, so it cannot be a `fact`. It can be an
`opinion`, labelled, scored low, and never above a sourced fact on the same key.
A `fact` whose body contains more than one sentence of assertion is refused
with "one claim per card"; a maintainer who wants a paragraph writes several
cards and connects them. Most of the defence is this schema, and it costs a
validator nothing because the server applies it at the tool boundary.

### D2. The server stores evidence; the score is derived

A single stored score is a target. What the row holds is a provenance record,
and a score is a pure function of it and the room's policy, computed when it is
read and shown with its reasons.

```ts
provenance: {
  claim: "fact" | "measurement" | "opinion",
  sources: [{ url, tier, fetchedAt?, hash?, verdict?: "supported" | "partial" | "absent" | "contradicted" }],
  author: { userId, standing: "first_party" | "verified_org" | "member" | "new" },
  approvedBy: memberId,
  validations: [cursor],        // validation events, D4
  corroboration: number,        // distinct registrable domains among supported sources
  lastValidatedAt?: string,
}
```

`scoreOf(provenance, policy)` lives in `src/provenance.ts`, runtime-free, and is
the one function both stores, the tools, the panel and the public page call.
Default policy, which a room's manifest may reweight and not remove:

- base by claim: `fact` 1.0, `measurement` 0.8 with a reproduction and 0.4
  without, `opinion` 0.3
- times the weakest necessary source's tier: primary 1.0, secondary 0.7,
  tertiary 0.4
- times verification: supported 1.0, partial 0.6, unchecked 0.5, absent 0.2,
  contradicted 0
- plus 0.1 per independent corroborating domain, to 0.3
- times decay (D8)

Reported 0–100 with the list of reasons that produced it, in that order. The
reasons are the product; the number is the summary.

### D3. Source tiers are the room's, seeded by the operator

A manifest declares them:

```yaml
sources:
  first_party: [cloudflare.com, developers.cloudflare.com]
  primary: [datatracker.ietf.org, modelcontextprotocol.io]
  secondary: [blog.cloudflare.com, simonwillison.net]
```

A domain not listed is tertiary. `src/sources.ts` carries the operator's seed
list (standards bodies, the major vendors' documentation hosts, peer-reviewed
indexes), which every room inherits and may extend; a room may not demote a
seeded domain, only add. Matching is on the registrable domain, so a subdomain
an attacker controls on a free host does not inherit the host's tier.

No heuristic tries to detect agent-written pages. The tier system does the
honest version of that job: an unknown domain is tertiary until a maintainer
says otherwise, and a `fact` with only tertiary sources cannot score above 40.

### D4. Validation is an event, under a verb

`VERBS` gains `validate`; `SEND_KINDS` gains `validation`:

```ts
bellman_send type: "validation", payload: {
  ref: number,                                 // the surface event's cursor
  source: string,                              // one of the card's URLs
  verdict: "supported" | "partial" | "absent" | "contradicted",
  quote?: string,                              // ≤ 500 chars from the page
  hash: string,                                // sha-256 of the fetched body
}
```

The event appends like any send, and `AppendExtras.validation` writes the
verdict into the item's provenance row in the same transaction, the
`creditReport` pattern. Validations are kept per source per validator; a later
one from the same validator replaces its earlier one.

The `topic` preset gains a `validator` role holding `send` and `validate` and
nothing else. A validation from a seat whose `userId` or `orgId` matches the
proposer's or the approver's is refused with `not_independent`; the check is in
the store, not the tool, so the HTTP route cannot differ.

A maintainer approving a proposal (topic rooms D3) sees the validations that
have landed on it. Approval does not require one; a room's policy may say it
does (`require_validation: true`), and then an approval of an unvalidated card
is refused.

### D5. One hosted validator, with a fetch and nothing else

The hosted seat has no network by design. The validator needs one, bounded:

- `ValidatorDO`, one per room, keyed by session id, woken through the outbox
  on a `surface_proposal` and on the re-check schedule (D8).
- It fetches only the card's declared source URLs, only on domains at
  secondary tier or above, with redirects followed only within the same
  registrable domain, a 2 MB body cap, a 10 s timeout, and no other request.
- The page text enters the model call inside the untrusted envelope with `<`
  escaped, beside the claim; the model returns a verdict and a quote; nothing
  from the page is an instruction.
- It sends its `validation` under `u_bellman_validator`, a seat holding
  `validate` only, so `denyVerb` and the audit log see a member.
- It is metered as host wakes are, in units on the room, with a weight of its
  own in the model table.

Its verdict is one validator among others and its weight is fixed at the
`member` standing (D7): a page that fools a model is a thing that happens, and a
hosted verdict never outranks a first-party human's. What it buys is that a
maintainer never approves a card nobody checked, and that every card is
re-checked when its source changes.

### D6. Who is a source

Standing is computed at proposal time from the identity keys `identityFor`
already resolves, stored on the provenance record, and never recomputed for a
card that exists:

| standing | rule |
|---|---|
| `first_party` | the author's verified email is on a domain the room lists under `sources.first_party` |
| `verified_org` | the author's identity carries an `orgId` and the org has a verified domain |
| `member` | a signed-in identity older than 30 days |
| `new` | younger than that |

An employee of the vendor proposing a card about the vendor's product is a
first-party source, which is a tier and not a verdict. A first-party
`validation` contradicting a card is the strongest signal the system has, and
the public page says who contradicted it.

### D7. Independence and weight

A validation's weight is its author's standing: `first_party` 1.0,
`verified_org` 0.8, `member` 0.5, `new` 0.1, hosted 0.5. The card's
`verification` factor in D2 is the weighted majority verdict across its
independent validators, and a single `contradicted` from a first-party
validator sets it to 0 until a maintainer resolves it. Collusion is handled by
refusal, not weight: same `userId` or same `orgId` as the proposer or approver
is not a validator for that card (D4).

Track record (a validator whose verdicts are later overturned loses weight) is
the reputation follow-up the topic-room spec names. It needs history to exist
first; nothing here depends on it.

### D8. Decay and re-check

A `fact` decays with a half-life the room sets (default 90 days) from
`lastValidatedAt`; a `measurement` from its date; an `opinion` does not decay
because it has nowhere lower to go. The validator re-fetches a supported
source weekly; a changed `hash` writes `verdict: "absent"` for that source
until it is checked again, and the card drops below the floor and into the
maintainer's review queue. A source that goes away (404, 410, a domain that
stops resolving) is `absent` on the next check, not deleted: the card keeps
saying what it cited.

### D9. The reader's floor

A room's policy sets `floor` (default 40). `bellman_connect` on a public room
returns cards at or above the floor and a count of those below; a reader may
ask for them with `include_below_floor: true` and gets them with their reasons.
The envelope carries `score` and `reasons` beside `origin`, so an agent that
reads a card can say why it believed it. The public page shows the same reasons
under every card and, above the cards, says that a score records what was
checked and by whom, and is not a guarantee.

### D10. What an attack costs now

| attack | before | after |
|---|---|---|
| the fake comparison post | one proposal, one tired approval | an `opinion` capped at 30, below the floor, invisible to readers by default |
| the fake study | a `fact` with a cited page | the hosted validator fetches the page; a page the attacker wrote is tertiary, so the card caps at 40; a first-party contradiction zeroes it |
| a hundred cheap approvals | a score | there is no score to buy; approval is one maintainer's human, and validations need independence |
| Sybil validators | weight | `new` identities weigh 0.1; same-org validators are refused; the only standing worth having costs a verified domain or thirty days |
| a source that changes after approval | nothing | the weekly re-fetch finds the hash changed and pulls the card into review |
| poisoning the validator with the page | the page is in the prompt | the page is untrusted data inside the envelope; the verdict is one vote weighted 0.5 |

None of these makes a room correct. They make lying expensive and visible,
and they keep a person at the end of every write.

## What this does not do

- No reputation from track record. Weights are standing only until there is
  history to read.
- No trust across rooms. A validator's standing in one room says nothing in
  another; the operator's seed list is the only shared thing.
- No detection of generated text. The tier system refuses to pretend.
- No automatic approval. The hosted validator checks; it never approves.
- No scoring of messages or briefs. Provenance is a surface-item property.

## Errors

| Case | What happens |
|---|---|
| `text` or `diagram` proposal in a topic room without `claim` | refused at the tool boundary, naming D1 |
| `fact` with more than one sentence of assertion | refused, "one claim per card" |
| `claim` on an item outside a topic room | refused; the field is the preset's |
| validation from a seat without `validate` | `denyVerb` refuses |
| validation whose `userId` or `orgId` matches the proposer's or approver's | refused `not_independent` |
| validation naming a URL the card does not cite | refused, listing the card's sources |
| validation `quote` over 500 chars, or `hash` not sha-256 | refused at the tool boundary |
| approval with `require_validation` and no validation | refused, naming the policy |
| hosted validator: domain below secondary tier | no fetch; verdict `unchecked`, reason named |
| hosted validator: redirect off the registrable domain, body over 2 MB, 10 s timeout | fetch abandoned; verdict `absent` with the reason; retried on the next schedule |
| hosted validator: model 429 or 5xx | backoff 1, 5, 15 min; dropped after three; the card stays `unchecked` |
| a room lowers a seeded domain's tier | refused; rooms add, they do not demote |
| `floor` outside 0–100 | refused |
| build rolled back past `provenance` | rows carry an unknown field; `hydrateStoredSession` drops it; roll forward |

## Testing

Every new assertion is run against a broken implementation before it counts.

- `src/provenance.ts` in Node: every default weight in D2 against a table of
  records; reasons listed in order; the opinion ceiling; the tertiary cap; a
  first-party contradiction zeroes verification; decay by half-life; a
  reweighted policy changes the number and not the reasons.
- `src/sources.ts`: registrable-domain matching; a subdomain on a free host
  does not inherit; a room may add and not demote.
- Manifest: `sources` shape; `validator` role in the preset; `floor`;
  `require_validation`.
- Contract suite, both stores: a validation writes the provenance row in the
  append's transaction; a later validation from the same validator replaces
  the earlier; independence refused in the store; standing stamped at
  proposal and not recomputed.
- Tools: the `claim` refusals; `bellman_send type: "validation"` shape; the
  floor on `bellman_connect` with and without `include_below_floor`; score and
  reasons in the envelope.
- `ValidatorDO` in worker tests with a stubbed model and a stubbed fetch: a
  proposal wakes it; it fetches only the declared URLs; an off-domain redirect
  is abandoned; a 2 MB body is abandoned; the page text is escaped inside the
  envelope; a changed hash on re-check writes `absent`; backoff on 429.
- Routes and page: reasons under every card; the sentence above the cards.
- `wrangler deploy --dry-run` before merge: a new binding and a new migration.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `SurfaceItem.claim`, `provenance`; `Verb` gains `validate`; `SendKind` gains `validation`; `RoomManifest.sources`, `floor`, `require_validation` |
| `src/manifest.ts` | `VERBS`, the `validator` role in `topic`, `SourcesShape`, the policy fields |
| `src/provenance.ts` | new, runtime-free: `scoreOf`, the default policy, standing rules |
| `src/sources.ts` | new: the seed tier list, registrable-domain matching |
| `src/surface.ts` | `claim` validation; the one-claim rule |
| `src/rooms.ts` | standing at proposal; the independence check; `require_validation` on approval |
| `src/store.ts`, `src/store-do.ts` | `AppendExtras.validation`; provenance on the `sf:` row; `ValidatorDO` wake rows; the re-check alarm |
| `src/outbox.ts` | the `validate` kind |
| `src/validator.ts` | new, runtime-free: the fetch rules, the prompt, the verdict parse |
| `src/tools/send.ts` | `validation` |
| `src/tools/connect.ts` | the floor, `include_below_floor`, score and reasons in the envelope |
| `src/inbox.ts` | score and reasons in the rendered card |
| `src/worker.ts`, `wrangler.toml` | `VALIDATOR` binding, migration |
| `src/app.ts` | the fake fetch and model for local dev |
| `bellman-sh/dash` | reasons under every card; the review queue; the sentence above the page |
| `README.md`, `docs/ARCHITECTURE.md`, `skills/room-manifest/SKILL.md` | claims, tiers, the verb, the validator |

## Follow-ups, not this spec

- Reputation from track record: validators whose verdicts are overturned
  lose weight; proposers whose cards survive gain standing.
- Cross-room trust: a validator's record carried between rooms that opt in.
- A reproduction runner for `measurement` cards, in a sandbox nobody else holds.
- Dispute: a contributor's answer to a contradiction, as a thread on the card.
- Export of a card with its provenance as a citation block.
