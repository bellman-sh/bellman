# auth.md agent registration: design
**Date:** 2026-10-23 · **Status:** approved 2026-10-23 (anonymous stays off)

Implements the `service_auth` path of WorkOS's auth.md profile (v0.6.0, https://github.com/workos/auth.md) on Bellman's authorization server. Builds on the panel sign-in (`/auth/signin`, `completeSession`), the invites page's single-use form (ADR 0027) and the token endpoint in `src/oauth/routes.ts`.

## Goal

An agent that has only its user's email can get a Bellman access token by sending the user a link and a six-digit code. The user signs in to Bellman as themselves and types the code. No MCP client, redirect URI or browser on the agent's side is needed.

Success means:

- isitagentready.com's auth.md check passes for bellman.sh: the authorization-server metadata carries an `agent_auth` block.
- An agent following https://bellman.sh/auth.md, with nothing but an email, ends with a token that works on `/mcp` as that user.
- Nobody gets a token for an account they cannot sign in to.

## Decisions

- **D1. `service_auth` only.** `POST /agent/identity` with `type: "anonymous"` answers `anonymous_not_enabled`. `type: "identity_assertion"` answers `issuer_not_enabled`.
  - Anonymous is refused because Bellman has one scope and no reduced token. An anonymous agent would hold a full identity with no human behind it, which the DCR caps exist to prevent.
  - ID-JAG is refused because Bellman verifies no third party's JWT signature today (`oidc.ts:118`), and a provider trust list is its own project.
- **D2. Bellman sends no email.** `login_hint` binds the registration to an address. The agent, not Bellman, hands the link and code to the user. This avoids building an open mail relay on an unauthenticated endpoint.
- **D3. The claim binds to a verified address.** Approval succeeds only when the signed-in session's `identity_keys` contain `email:<login_hint, lowercased>`.
  - Every provider adds an `email:` key only for an address it verified. Google requires `email_verified`. GitHub uses the public profile address, which GitHub only allows for verified addresses, and otherwise the primary verified one (`providers.ts:87-94`). SSO requires that the IdP vouched and that the org verified the domain.
  - A session with no `email:` key can never complete a claim. The page tells the user to sign in with the account whose address the agent named.
- **D4. The identity assertion is a stored, signed grant.** It is an HS256 JWT signed with `BELLMAN_TOKEN_SECRET`.
  - Claims: audience `bellman:agent-assertion`, `iss` = issuer, `sub` = userId, `jti` = registration_id, and `exp` 30 days after the claim, matching `REFRESH_TOKEN_TTL_MS`.
  - It is backed by an `AuthDO` record holding what a session holds: `identity`, `plan_source`, `plan_key`, `identity_keys`. These are copied from the approving session.
  - A valid signature alone is not enough. Exchange requires the record to exist, so deleting the record revokes the assertion.
- **D5. The exchange is the RFC 7523 jwt-bearer grant on the existing `POST /token`.**
  - It returns `access_token`, `token_type`, `expires_in: 600` and `scope: "bellman"`. The token carries the same claims `issueTokens` mints. There is no `refresh_token`; the agent re-exchanges the assertion. `issueTokens` always mints a refresh token (`routes.ts:2237`), so the access-token half is split out for both callers.
  - Each exchange re-resolves the plan the way a refresh does (`replanOnRefresh`). A `SignInRefused` answers `invalid_grant` and deletes the record.
  - A `resource` parameter, if sent, must equal `config.resource`, else `invalid_target`.
- **D6. Polling is the claim grant on `POST /token`.** `grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=…` answers as follows:
  - `authorization_pending` while the user has not approved.
  - `slow_down` when polled sooner than `interval` (5 s) after the last poll.
  - `expired_token` once the code's window or the registration's window has closed.
  - Success exactly once: the token response from D5 plus `identity_assertion` and `assertion_expires`. That poll spends the `claim_token`, and any later poll answers `invalid_grant`.
  - The spec contradicts itself here. Its error table uses these OAuth codes, while one line (AUTH.md:429) says polls return `"status": "pending"` and `"status": "expired"`. Error bodies carry both: `{"error":"authorization_pending","status":"pending",…}` and `{"error":"expired_token","status":"expired",…}`. (My call.)
- **D7. Two windows.** The registration lives 24 h (`claim_token_expires`). A code lives 10 minutes (`expires_in: 600`).
  - `POST /agent/identity/claim {claim_token, email}` mints a fresh code inside the 24 h, if `email` equals the `login_hint`.
  - Its errors:
    - `invalid_claim_token` for an unknown token.
    - `claim_expired` (410) past 24 h.
    - `claimed_or_in_flight` once claimed.
    - `invalid_request` for an email mismatch.
  - A fresh code replaces the old one; only the newest code works.
- **D8. The claim page lives on the issuer.** `verification_uri` is `${issuer}/agent/claim?claim_attempt_token=<random id>`. The URL never carries the `claim_token` or the code.
  - With no session cookie, `GET` redirects to `/auth/signin?return_to=<that URL>`. `panelDestination` gains this one path on the issuer's own origin as an allowed destination, and nothing else.
  - With a session, the page shows who is signed in and what approving grants. It has a code box, an Approve button and a sign-out link.
- **D9. The approval POST follows the invites page.** The form carries a hidden `held` JWT with audience `bellman:claim-state`. It is bound to the attempt token and to a SHA-256 hash of the session id, never the raw id: the JWT sits in the page's HTML, and the session id is the HttpOnly cookie's secret. It is spent once through `spendOnce`.
  - It does not use the `csrfRefusal` Origin check, which only admits panel origins. The `held` token plus the SameSite=Lax cookie carry CSRF here, as on `/auth/invites`.
  - A wrong code counts against the attempt. The fifth wrong code kills the attempt, and the agent must mint a fresh one (D7).
  - A wrong account (D3) is refused without naming the hinted address.
- **D10. Limits reuse the DCR pattern.**
  - `POST /agent/identity` is admitted by a per-IP hourly bucket: 20 per hour, its own key prefix, the same atomic shape as `admitRegistration`.
  - A cap of 10,000 unclaimed registrations applies.
  - Unclaimed records past 24 h are swept by the `AuthDO` alarm. Today that alarm (`store.ts:322`, `purgeStale`) sweeps only `client:` and `reg:` keys, and only the DCR paths arm it (`store.ts:147`, `store.ts:258`). So `purgeStale` gains the `agentreg:`, `agentattempt:` and expired `agentgrant:` prefixes, and `POST /agent/identity` arms the alarm. Without that, the unclaimed-count cap never comes back down.
  - Over a limit answers 429 `rate_limited`.
- **D11. Metadata.** `/.well-known/oauth-authorization-server` gains the following:
  - `grant_types_supported` adds `urn:ietf:params:oauth:grant-type:jwt-bearer` and `urn:workos:agent-auth:grant-type:claim`.
  - The `agent_auth` block:
    ```json
    "agent_auth": {
      "skill": "https://bellman.sh/auth.md",
      "identity_endpoint": "<issuer>/agent/identity",
      "claim_endpoint": "<issuer>/agent/identity/claim",
      "register_uri": "<issuer>/agent/identity",
      "claim_uri": "<issuer>/agent/identity/claim",
      "identity_types_supported": ["service_auth"]
    }
    ```
  - `register_uri` and `claim_uri` are the pre-v0.2 names. Live implementations (agents-txt.com) and possibly the scanner still read them. They cost two lines.
  - The block has no `events_endpoint`, `events_supported` or `identity_assertion`, and the metadata has no `revocation_endpoint` (out of scope).

## 1. Records

All records live in the `AuthDO` singleton, raw-keyed like `refresh:` and `code:`. Expiry is checked on read.

| Key | Holds | Lives |
|---|---|---|
| `agentreg:<claim_token>` | `registration_id`, `login_hint`, `created_at`, `expires_at`, `last_poll_at`, the current attempt `{attempt_token, user_code, expires_at, failures}`, and `claimed` (the session snapshot, once approved) | 24 h, or until the success poll spends it |
| `agentattempt:<attempt_token>` | the `claim_token` it belongs to | the attempt's 10 minutes |
| `agentgrant:<registration_id>` | `identity`, `plan_source`, `plan_key`, `identity_keys`, `expires_at` | 30 days |

- Tokens: `claim_token` is `clm_` plus `randomId()`. `registration_id` is `reg_` plus `randomId(16)`. `attempt_token` is `randomId()`.
- `user_code` is six digits from `crypto.getRandomValues`.
- Approve, poll and re-initiate each read and write one `agentreg:` record in one storage transaction, so an approve and a poll cannot both win.

## 2. Responses

The bodies follow auth.md v0.6.0's `service_auth` response, claim response and error table, with Bellman's values:
- `post_claim_scopes: ["bellman"]`
- `claim_url` is the `claim_endpoint`.

Errors on `/agent/*` are JSON `{error, error_description}`. Errors on `/token` use `oauthError`.

## 3. The claim page

The page uses the existing `html()` wrapper and CSS, like the sign-in chooser. Copy is plain, and the risk is stated before the button:

> **Approve an agent?**
> Signed in as *label*.
> An agent asked to act as you on Bellman. Approving lets it start rooms and read and send in your rooms, for 30 days, until you sign out of it here or an operator removes it. Approve only if you started this from your own agent just now.
> Enter the 6-digit code your agent gave you. [______] [Approve]
> Not you? Sign out.

The success page says the agent can continue. Every failure has its own sentence:
- wrong code, with the tries left;
- wrong account;
- code expired, so ask the agent for a new one;
- registration expired;
- already approved.

"Until you sign out of it here" is not built (see Out of scope). The builder drops that phrase.

## 4. Security, said out loud

- **This is a new way to mint a full Bellman identity.** It is as strong as the sign-in that approves it, plus one human action. It adds no new provider, and it never identifies anyone by an unverified address.
- **Code phishing is the known residual.** An attacker's agent can register with a victim's email and talk the victim into approving. This is the same exposure every RFC 8628 device flow has. The page copy is the mitigation, and SECURITY.md's "What we already know" gains this line.
- **Assertions can be revoked by deleting the record,** but nothing user-facing does that yet. That matches refresh tokens today, which have no per-user index. Operator suspension still cuts `/mcp` within 60 s.
- **Peer content is untouched.** `client_name` does not exist on this path, and the page renders only Bellman's own strings and the session's label (escaped).

## Tests, docs, rollout

- **Tests.** Tests go in `tests/agent-auth.test.ts`, using the `oauth-flow.test.ts` harness: `MemoryAuthStore`, with `handleOAuth` called directly. Pure logic (the records, code checks, windows) goes in a runtime-free module beside the store, per CLAUDE.md. They cover:
  - Metadata carries the block from D11.
  - `anonymous` and `identity_assertion` give their `*_not_enabled` errors. A bad body gives `invalid_request`.
  - The full path: register, poll pending, GET the claim page signed out and see the redirect, approve with the right code, poll and get the success once, then a second poll gets `invalid_grant`.
  - The access token resolves on `identityFromAccessToken`. The jwt-bearer exchange works, and works again.
  - `slow_down`, the code and registration windows, re-initiate, and five wrong codes.
  - The wrong account is refused. A GitHub session with no `email:` key is refused.
  - A replayed `held` is refused.
  - The rate limit and cap give 429.
  - An exchange after the grant record is deleted gives `invalid_grant`. An exchange after `SignInRefused` gives `invalid_grant` and deletes the record.
  - A wrong `resource` gives `invalid_target`.
- **Workerd tests.** One test in `worker-tests/` covers the approve-against-poll race on the real `AuthDO`.
- **Docs.**
  - A new ADR, numbered at merge.
  - The trust-boundaries section of ARCHITECTURE.md gains the claim path.
  - SECURITY.md gains the line from section 4.
  - In the site repo, `public/auth.md` is rewritten around this flow as a separate PR after the server ships.
- **Rollout.**
  1. Merge and deploy bellman.
  2. Confirm with `curl` that the metadata shows the block, on mcp.bellman.sh and through bellman.sh. bellman.sh already passes mcp.bellman.sh's metadata through (site `worker.js:242`, live 200), so no site change is needed for this.
  3. Ship the site's `auth.md`.
  4. Rerun the scanner. Its auth.md check only reads the PRM and the server metadata. It runs no ceremony.
  5. Run one real ceremony by hand against production with a verified-email account: register with `curl`, approve in the browser, poll, then call `/mcp` with the token.

## Out of scope

- `anonymous` registrations and pre-claim scopes.
- ID-JAG, a provider trust list, `events_endpoint` and SET ingestion.
- An RFC 7009 `revocation_endpoint`. Access tokens are stateless and live 10 minutes (SECURITY.md).
- A page where a user lists or removes the agents they approved.
- Bellman sending the code by email.
