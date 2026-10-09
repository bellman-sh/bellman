# Paid rooms: a creator sells a subscription to a room's surface

**Issues:** none filed yet; third in the set with
[topic rooms](2026-10-08-topic-rooms-design.md) and
[validation and provenance](2026-10-08-validation-and-provenance-design.md).
Builds on the billing path that exists (`src/billing/`: the Stripe webhook,
`BillingLedger`, "a purchase is a grant") and on the public read in topic
rooms D2.

**Status:** draft for discussion, 2026-10-08. Nothing here is built before a
free topic room has strangers proposing to it (topic rooms D9).

**Scope:** a price on a public topic room, Stripe Connect for the creator, a
room-scoped membership grant written by the webhook, the public/members split
on cards, refunds and cancellation, what may be sold, the fee. A creator
dashboard beyond the minimum, tipping, one-off purchases and team seats for a
buyer's org are follow-ups.

## Problem

Give people a way to earn and they will build. Reddit never let a moderator
earn from a subreddit; Substack, Patreon and Discord did, and those have
people working full-time inside them. A topic room is a page a specialist
keeps current for agents to read, which is a thing nobody sells yet: Substack
sells prose to people; this sells context to agents, bought by the person who
runs one.

The mechanism is almost already here. Today Stripe's webhook writes a plan
grant and a purchase resolves like any other plan. A paid room is the same
webhook writing a membership grant for one room. The work is everything around
that line: who gets paid, what is shown for free, what happens when the money
stops, and what may not be sold at all.

## Decisions

### D1. A paid room is a public topic room with a price

The `public` block gains `price`:

```yaml
preset: topic
public:
  slug: rust-async
  price:
    monthly: 900          # cents, USD; 300 ≤ monthly ≤ 20000
    annual: 9000          # optional; ≤ 12 × monthly
purpose: What is known about async Rust in production, with sources.
```

A price may be set on a room only when the room has at least ten approved
cards with `visibility: public` (D4) and each has a source at secondary tier or
above; `bellman_start` and the manifest update route refuse otherwise, naming
the count. A room cannot charge for an empty page, and a buyer always sees what
they are buying.

Only `topic` rooms carry a price. The lobby and the build room are free by
construction, and a `pair` or `swarm` room has nothing a stranger reads.

### D2. The creator is a connected account

A creator onboards once, from the panel: `POST /account/connect` creates a
Stripe Connect Express account for the signed-in identity, stores its id on
the `CustomerRecord` in `AuthDO` beside the customer id a plan purchase stores,
and sends the person to Stripe's hosted onboarding. Express means Stripe does
identity verification, payouts, 1099-K and the tax interview; Bellman holds
none of it. A room's `price` is refused until `account.updated` reports
`charges_enabled` and `payouts_enabled` for the maintainer's account.

Charges are made on the platform account with `transfer_data.destination` set
to the creator's account and `application_fee_percent` the fee (D8). The buyer
sees Bellman on the statement; the creator sees a transfer. Direct charges on
the connected account were considered and rejected: refunds, disputes and the
customer record would then live on an account Bellman does not operate, and the
ledger's one-read-path rule would break.

### D3. The purchase is a grant, scoped to a room

`POST /rooms/:id/subscribe` creates a Checkout Session in `subscription` mode
with the room's price, `client_reference_id` the buyer's user id (the rule
`isLinkableUserId` already enforces), and `metadata.room` the session id. This
is the first Stripe write the Worker makes; `STRIPE_API_KEY` gains Checkout
and Subscriptions write, and nothing else.

The webhook handles the events it already handles. `checkout.session.completed`
with `metadata.room` links the customer as a plan checkout does, and the
subscription events write a **membership grant**:

```ts
{ kind: "membership", room: sessionId, source: "purchase", expiresAt, subscriptionId }
```

filed under the buyer's identity key (`github:4242`), the key `grantKeyForUser`
derives, beside the plan grant and under the same `serializeUser` lock. One
read path: a membership resolves through the grant store with the same
ownership checks, expiry and audit trail a plan has, and nothing in billing
knows what a room is.

`canPurchaseAs` applies: an identity with no recoverable key cannot buy, and
the button is not shown to it.

### D4. What the grant opens

Every surface item in a paid room carries `visibility: "public" | "members"`,
set by the maintainer at approval and changeable with a surface write. The
public page and `bellman_connect` return public cards to anyone and a count
of members-only cards; a reader whose identity holds a live membership grant
for the room gets everything. `bellman_confirm` into a paid room's contributor
seat requires the grant too, so contributors are subscribers; the maintainer's
seats and any seat the maintainer issues a code for are exempt, which is how a
creator brings in a co-maintainer or a validator without charging them.

The grant is read at `bellman_connect`, at `bellman_confirm` and on the public
page; it is not stamped on the seat. A subscription that lapses closes the read
on the next call and the seat on the next `bellman_sync`, which reports
`session_status: "unsubscribed"` with the room's subscribe link, and the member
is marked departed by the same path a leave takes. Nothing they wrote is
removed; a card keeps its author.

The public/members split is the product. Substack's free paragraphs are why
people subscribe; a paid room with no public cards is refused (D1), and a room
whose public cards go stale will be seen to go stale, because the page shows
when the surface last changed.

### D5. The money stops in three ways

| event | grant | seat |
|---|---|---|
| the buyer cancels | expires at period end | kept until then, departed after |
| payment fails, Stripe retries, subscription `past_due` then `canceled` | kept through the retry window, expired on `canceled` | kept, then departed |
| the buyer disputes | expired at once on `charge.dispute.created`; the fee and the transfer are reversed by Stripe | departed at once |
| the creator closes the room, or Bellman removes it (D7) | every subscription on the room is cancelled with proration; grants expire | the room closes |

Refunds are the policy, written once at `bellman.sh/terms`: a full refund on
request inside seven days of the first charge, pro-rated after that for the
current period, no questions asked. The refund is issued on the platform
account and reverses the transfer; Stripe does the arithmetic. A creator who
objects to a refund is told the policy was on the page they priced their room
under. Disputes on a Connect platform count against the platform, which is why
the refund is generous: a refund costs the creator's share; a dispute costs
Bellman's standing with Stripe.

### D6. Nothing is sold until it is read

Before a room may carry a price, and again on every manifest change that
touches `price` or `sources`, the hosted validator (validation spec D5) has
checked every public card and the room's score floor is at or above 40. This
is not a quality judgement; it is the minimum that keeps a buyer from paying
for a page the system itself scores as unchecked.

### D7. What may be sold, and who takes it down

The creator terms at `bellman.sh/creator-terms` say what a paid room may not
contain, and the server enforces the parts it can:

- Nothing the creator does not have the right to sell: another author's
  documentation, a course, a book, a dataset under a licence that forbids it.
  A DMCA notice to `abuse@bellman.sh` closes the room's price within one
  business day (not the room) pending the creator's response; a counter-notice
  reopens it; a second notice on the same room removes the price for good.
- No medical, legal or financial advice sold as fact. A room whose
  `purpose` or cards are classified into those subjects by the hosted
  validator is `opinion`-only at the schema and may not carry a price. This
  is a blunt rule, chosen over a judgement Bellman is not staffed to make.
- No personal data about identifiable people. Same mechanism as the
  public-room guardrails: a report, a review queue, a price removed first and
  a room closed second.
- No room may sell what its own public cards contradict.

Removing a price refunds the current period for every subscriber. The creator
is told why, with the report's cursor, and may appeal to `abuse@`.

Payouts to a creator's account hold for seven days after the first charge on a
new room and after any report that is upheld, so a room that is a fraud is
refunded from money that has not left.

### D8. The fee

A flat 15% of each charge as `application_fee_percent`, published on the
creator terms, with Stripe's own processing fee inside Bellman's share and not
the creator's. The creator sees the number once, at the moment they set a
price, as "you receive $7.65 of $9.00 a month per subscriber", and the panel
shows the same arithmetic beside every room.

The operator's own rooms (topic rooms D9) are free and stay free; they are the
public cards of the whole catalogue.

Plans do not gate selling: a free-plan creator may price a room, because the
fee is the plan. What plans gate is unchanged (creating rooms, swarm mode,
audit, org scoping).

### D9. Taxes and the paperwork

Stripe Tax is enabled on the platform account and computes sales tax and VAT
on each Checkout Session by the buyer's location; the amount is on top of the
room's price and is not in the fee base. Connect Express files 1099-K for US
creators who cross the threshold and collects W-8/W-9 at onboarding; Bellman
stores nothing of it. The creator terms say so in one paragraph.

### D10. The least creator dashboard

`dash.bellman.sh/rooms/:id/subscribers` for a maintainer: subscriber count,
monthly recurring revenue, the next payout date and amount as Stripe reports
them, each subscription's status, and a link to the Express dashboard for
everything else. Nothing that duplicates Stripe.

## What this does not do

- No one-off purchases, no tipping, no "buy a card".
- No team seats: a membership is one identity. An org that wants ten readers
  buys ten, until a follow-up adds org memberships.
- No revenue share with contributors or validators. The creator is the
  maintainer; how they pay their contributors is theirs.
- No promotion of paid rooms by Bellman beyond the `/r/` index, which lists
  free and paid rooms alike with the price shown.
- No currency but USD in the first version.

## Errors

| Case | What happens |
|---|---|
| `price` on a room that is not a public `topic` room | refused, naming the preset |
| `price` with fewer than ten public approved cards at secondary tier or above | refused, naming the count |
| `price` before Connect reports `charges_enabled` and `payouts_enabled` | refused, linking onboarding |
| `price` while the room's score floor is under 40 | refused, naming the floor |
| `monthly` outside 300–20000 cents, or `annual` over 12 × monthly | refused at the manifest boundary |
| subscribe by an identity `canPurchaseAs` refuses | the button is absent; the route answers 409 with the reason the plan path uses |
| subscribe to a room the buyer maintains | refused; maintainers do not pay themselves |
| webhook subscription event with `metadata.room` naming a closed room | the subscription is cancelled with proration; the grant is not written |
| `bellman_confirm` into a paid room with no grant | refused with the room's subscribe link; nothing of the joiner's crosses |
| `bellman_sync` on a seat whose grant expired | `session_status: "unsubscribed"` once, then the seat is departed |
| dispute created | grant expired, seat departed, fee and transfer reversed by Stripe; the creator is told |
| DMCA notice received | the price is removed within one business day; subscribers refunded for the period; the creator is told |
| price removed by report while subscriptions are live | each subscription cancelled with proration; grants expire; the room stays |
| `STRIPE_API_KEY` lacks Checkout write | `POST /rooms/:id/subscribe` answers 503 naming the scope; nothing else is affected |
| build rolled back past membership grants | the grant store refuses an unknown `kind`; roll forward |

## Testing

Every new assertion is run against a broken implementation before it counts.

- Manifest: the `price` shape and bounds; the ten-card rule; refusals for
  non-topic and non-public rooms.
- Grants (`tests/billing-grants.test.ts` and the contract suite): a
  membership grant is filed under the derived key beside a plan grant;
  `usableGrant` resolves it with expiry; `serializeUser` covers both; a
  closed room's event writes nothing.
- Webhook: `checkout.session.completed` with `metadata.room` links and
  writes; the five subscription events move the grant through D5's table;
  `charge.dispute.created` expires it; out-of-order delivery as the plan path
  already tests.
- Tools: `bellman_connect` returns public cards and the members-only count
  without a grant, everything with one; `bellman_confirm` refuses without a
  grant and exempts maintainer-issued seats; `bellman_sync` reports
  `unsubscribed` once and departs the seat.
- Routes: `/account/connect` stores the account id; `/rooms/:id/subscribe`
  builds a session with the right `client_reference_id`, metadata,
  `transfer_data` and fee; refuses a maintainer; refuses when the key lacks
  the scope.
- Panel: the subscribers page renders Stripe's numbers and nothing computed
  twice.
- Stripe test mode end to end in `npm run smoke`: onboard a test creator,
  price a room, subscribe a test buyer, read members-only cards, cancel, read
  public cards only.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `public.price`; `SurfaceItem.visibility`; `MembershipGrant`; `CustomerRecord.connectAccountId` |
| `src/manifest.ts` | `PriceShape`, the ten-card rule's hook |
| `src/billing/grants.ts` | `membershipGrantFor`; the room-scoped write and expiry |
| `src/billing/stripe.ts` | `metadata.room` on checkout; `charge.dispute.created`; `account.updated` |
| `src/billing/ledger.ts` | the connected account on the customer record |
| `src/billing/checkout.ts` | new: the Checkout Session body, fee and destination |
| `src/grant-index.ts`, `src/store-do.ts` | the `membership` grant kind in `RegistryDO` |
| `src/rooms.ts` | the grant read at connect and confirm; `visibility` on approval; the price refusals |
| `src/tools/connect.ts`, `src/tools/confirm.ts`, `src/tools/sync.ts` | the split, the refusal, `unsubscribed` |
| `src/http/rooms.ts` | `/rooms/:id/subscribe`; `visibility` on the public page |
| `src/oauth/routes.ts` | `/account/connect` |
| `src/worker.ts`, `wrangler.toml` | the key scope note; Stripe Tax flag |
| `bellman-sh/dash` | onboarding button; the subscribers page; the price form with the arithmetic |
| `bellman-sh/bellman.sh` | `/creator-terms`; the refund policy on `/terms`; prices on `/r/` |
| `README.md`, `docs/ARCHITECTURE.md` | the membership grant beside the plan grant; the fee |

## Follow-ups, not this spec

- Org memberships: one purchase, N readers in a buyer's org.
- One-off purchases and tips.
- A revenue split to contributors, declared in the manifest.
- Discovery: a featured page, categories, and search across paid rooms.
- Currencies beyond USD.
- A creator's payout and dispute history in the panel, once Stripe's
  dashboard is not enough.
