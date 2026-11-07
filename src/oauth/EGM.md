# oauth

## Overview

Bellman's OAuth 2.1 authorization server. `routes.ts` is one dispatcher, `handleOAuth`, for discovery metadata,
dynamic client registration, PKCE authorize, the GitHub, Google and org-SSO hand-offs, the token endpoint, agent
registration (auth.md), panel cookie sessions, the sign-in invites page, `/account`, and operator and admin
routes; it also resolves a caller's plan at sign-in and on refresh. `storage.ts` is the runtime-free
`AuthStorage` contract with `MemoryAuthStore`; its Durable Object implementation, `AuthDO`, is Workers-only and lives
in [../workerd/EGM.md](../workerd/EGM.md) (`src/workerd/auth-do.ts`). Nothing here imports `cloudflare:workers`. The rest
are primitives: JWTs and PKCE, sealing, cookies, DNS proof, OIDC, providers, browser origin checks, and the
pure agent-claim decisions.

## Interface

Routes and callers:

- `handleOAuth(request, config)`: `Promise<Response | undefined>`, `undefined` when no route matches
  [src/oauth/routes.ts:handleOAuth]
- Paths matched: `GET /.well-known/oauth-protected-resource[/<suffix>]`, `GET /.well-known/oauth-authorization-server*`,
  `POST /register`, `GET /authorize`, `GET /authorize/sso`, `GET /authorize/:provider`,
  `GET /callback/sso/:orgId`, `GET /callback/:provider`, `POST /token`, `POST /agent/identity`,
  `POST /agent/identity/claim`, `GET|POST /agent/claim`, `GET /upgrade/:link`, `GET /auth/signin`,
  `GET /invite/:token`, `GET /auth/session`, `POST /auth/signout`, `POST /auth/invites`, `GET /account`,
  `GET|POST|DELETE /admin/grants`, `GET /admin/accounts`, `GET /admin/handles`, `DELETE /admin/handles/:handle`,
  `POST|DELETE /admin/suspensions/:userId`, `GET /admin/reports`, `POST /admin/reports/:id/resolve`,
  `POST /admin/rooms/backfill`, `POST /admin/orgs`, `PATCH /admin/orgs/:orgId`, and OPTIONS on `/auth/session`, `/auth/signout`, `/account`
  [src/oauth/routes.ts:handleOAuth]
- `POST /token` grants: `authorization_code`, `refresh_token`, `CLAIM_GRANT`, `JWT_BEARER_GRANT`
  [src/oauth/routes.ts:handleOAuth]
- `caller(request, config)` returns `{identity, planSource, planKey?, subjectKey?, via: "bearer" | "cookie"}` or
  null; `identityFromAccessToken`; `unauthorizedHeaders(config, "/mcp" | "/a2a")`; `parseOperators`
  (`BELLMAN_OPERATORS`); `PROTECTED_RESOURCE_PATH` [src/oauth/routes.ts:caller]
- `OAuthConfig` (issuer, resource, secret, `store: AuthStorage`, credentials, overrides, panel and public-page
  origins, payment links, `plans?: PlanStore`, operators, `fetchImpl`) [src/oauth/routes.ts:OAuthConfig]
- `PlanStore`: a `Pick<BellmanStore, ...>` of grant, org, invite, user and report methods, plus
  `backfillRoomIndex` [src/oauth/routes.ts:PlanStore]
- Plan resolution: `resolvePlan`, `replanOnRefresh`, `signedInPlan`, `standingOf`; `PlanSource = "operator" |
  "grant" | "default"` [src/oauth/routes.ts:resolvePlan]
- Errors `SignInRefused`, `SsoRequired`, `AccessRemoved` (both extend `SignInRefused`), `SeatsFull`
  [src/oauth/routes.ts:SignInRefused]
- `MAX_REPORTS_LISTED` 200, `MAX_ACCOUNTS_LISTED` 1000 [src/oauth/routes.ts:MAX_ACCOUNTS_LISTED]
- `POST /admin/rooms/backfill` writes one window of the registry's missing room-index rows: `?limit=` 1 to
  `MAX_BACKFILL_WINDOW` (300, the default), `?after=` the previous call's `next`; answers `{indexed, next}`, rerun
  until `next` is null [src/oauth/routes.ts:MAX_BACKFILL_WINDOW]

Storage:

- `AuthStorage`: client registration, single-use codes, refresh tokens and spent ids, panel sessions, agent
  registrations; `MemoryAuthStore` "for tests and for the Node server" [src/oauth/storage.ts:AuthStorage]
- Predicates `sessionDead`, `touchDue`, `hasLapsed`, `purgeDue`; `sweepPage`; `clientCount`; limits
  `REGISTRATIONS_PER_HOUR` 20, `CLIENT_CAP` 10,000, `SESSION_TTL_MS` 7 d, `SESSION_IDLE_MS` 24 h
  [src/oauth/storage.ts:sessionDead]
- `AuthDO` implements it, in workerd ([../workerd/EGM.md](../workerd/EGM.md)) [src/workerd/auth-do.ts:AuthStore]

Primitives:

- `signJwt` / `verifyJwt`, `verifyPkce`, `canonicalResource`, `sha256Base64url`, `randomId`; TTLs
  `ACCESS_TOKEN_TTL_SECONDS` 600, `REFRESH_TOKEN_TTL_MS` 30 d, `AUTH_CODE_TTL_MS` 5 min, `STATE_TTL_SECONDS` 600
  [src/oauth/tokens.ts:verifyJwt]
- `seal`, `unseal`, `isSealed`, `SealError` [src/oauth/sealed.ts:seal]
- Session and sign-in nonce cookie helpers (`serializeSessionCookie`, `readSessionCookie`,
  `serializeSigninNonce`, ...) [src/oauth/cookies.ts:serializeSessionCookie]
- `domainVerified`, `txtRecords`, `verificationRecord`, `newDomainToken`, `domainOf`; `DNS_JSON`
  [src/oauth/dns.ts:domainVerified]
- `discover`, `oidcAuthorizeUrl`, `oidcExchange`, `nonceFor` [src/oauth/oidc.ts:oidcExchange]
- `Provider`, `PROVIDERS` (`github`, `google`), SSO key helpers, `identityKeys`, `immutableKeys`, `identityFor`,
  `parseOverrides` (`BELLMAN_USERS`) [src/oauth/providers.ts:PROVIDERS]
- `allowedOrigin`, `corsHeaders`, `preflightResponse`, `csrfRefusal`, `parsePanelOrigins`
  (`BELLMAN_PANEL_ORIGINS`) [src/oauth/browser.ts:csrfRefusal]
- Agent records and pure verdicts `decidePoll`, `decideApprove`, `decideReissue`; `CLAIM_GRANT`,
  `JWT_BEARER_GRANT` [src/oauth/agent-auth.ts:decideApprove]

## Invariants

- Access tokens are HS256 JWTs with no revocation list; `verifyJwt` needs a valid signature, a future `exp` and
  exact `iss` and `aud`, and returns null rather than throwing [src/oauth/tokens.ts:verifyJwt]
- PKCE accepts S256 only, verifier 43-128 characters [src/oauth/tokens.ts:verifyPkce]
- `/authorize` shows errors as HTML until `client_id` and an exactly registered `redirect_uri` are known; redirect
  URIs must be https or http on loopback [src/oauth/routes.ts:usableRedirect]
- Codes and refresh tokens are single use (take deletes before the expiry check); refresh tokens rotate, and
  storing one promotes the client out of disposable registration in the same operation
  [src/oauth/storage.ts:AuthStorage] [src/workerd/auth-do.ts:AuthDO.putRefresh]
- Every read-check-write on the store (registration admission, session touch and re-plan, `spendOnce`, every
  agent method) runs as one operation: synchronous in `MemoryAuthStore`, one transaction in `AuthDO`
  [src/workerd/auth-do.ts:AuthDO.admitRegistration]
- A refresh keeps its granted resource and re-resolves the plan from immutable keys only; an override or grant
  then contributes plan, role and org, never `userId` [src/oauth/routes.ts:replanOnRefresh]
- Operator overrides outrank stored grants; an inactive org downgrades its grant's plan to free
  [src/oauth/routes.ts:decidePlan] [src/oauth/routes.ts:standingOf]
- `require_sso` refuses non-SSO sign-ins for the org (owner excepted); a SCIM-deprovisioned SSO key throws
  `AccessRemoved`; the refusal runs before an address grant is moved [src/oauth/routes.ts:ssoRefusal]
- A stored record without `identity_keys` is refused rather than defaulted, which would downgrade a paid plan
  [src/oauth/routes.ts:storedIdentityKeys]
- A panel session is dead past 7 days or 24 h idle, or when a time field is not finite; re-plan cannot recreate
  a signed-out session [src/oauth/storage.ts:sessionDead]
- Cookie authentication is refused when no panel origins are configured; a bearer header is checked first
  [src/oauth/routes.ts:sessionCaller]
- Panel sign-in binds signed state to the browser with a nonce cookie compared in constant time; held answers
  (`/auth/invites`, `/agent/claim`) spend their `jti` once [src/oauth/routes.ts:finishSession]
- `panelDestination` accepts a return URL only on an exact panel or public-page origin match
  [src/oauth/routes.ts:panelDestination]
- Secure cookies are `__Host-` named, HttpOnly, SameSite=Lax, Path=/, Secure, never a Domain; a cookie name seen
  twice reads as absent [src/oauth/cookies.ts:readCookie]
- The one cookie read and never set here is `bm_ref`, bellman.sh's campaign tag on the whole domain: a slug of 1 to 40
  `[a-z0-9-]` or absent, an observation and never a source of authority [src/oauth/cookies.ts:readCampaignRef]
- Sealed values are `v1.<nonce>.<ciphertext>`, AES-256-GCM with an HKDF-SHA256 key; tampering throws
  [src/oauth/sealed.ts:unseal]
- Domain proof needs TXT `_bellman.<domain>` equal to `bellman-verify=<token>`; a resolver failure throws, never
  reads as unverified [src/oauth/dns.ts:txtRecords]
- OIDC issuer and endpoints must be https and the discovery issuer must match exactly; the id_token's `iss`,
  `aud`, `exp`, `nonce` and `sub` are checked but not its signature (a `ponytail:` comment names JWKS as the
  upgrade) [src/oauth/oidc.ts:oidcExchange]
- An unverified Google email is dropped; GitHub uses a fallback email only if primary and verified
  [src/oauth/providers.ts:google]
- `allowedOrigin` is exact-match, refuses `"null"`; `csrfRefusal` exempts bearer callers and GET/HEAD/OPTIONS
  [src/oauth/browser.ts:allowedOrigin]
- Operator routes are bearer only and need the user in `BELLMAN_OPERATORS` [src/oauth/routes.ts:operatorGate]
- Agent approval checks attempt, expiry, claim state and account before the 6-digit code; 5 failures kill the
  attempt [src/oauth/agent-auth.ts:decideApprove]

## Side Effects

- `AuthDO`'s storage, alarm sweep and RPC are in [../workerd/EGM.md](../workerd/EGM.md)
- Network: provider token and user endpoints (`github.com`, `api.github.com`, `oauth2.googleapis.com`,
  `openidconnect.googleapis.com`), OIDC discovery, token and userinfo, `cloudflare-dns.com`
  [src/oauth/providers.ts:github] [src/oauth/oidc.ts:discover] [src/oauth/dns.ts:txtRecords]
- Plan store writes with audit intent: grants, SSO member provisioning, orgs, suspensions, reports, handle
  release; `recordSignIn` on each resolution, with the request's `bm_ref` campaign tag, which only the sign-in that
  creates the record keeps [src/oauth/cookies.ts:readCampaignRef]; `moveGrant` of an address grant; `backfillRoomIndex` on
  `/admin/rooms/backfill` [src/oauth/routes.ts:handleOAuth]
- Cookies: sign-in nonce set on `/auth/signin` and `/invite/:token`, session cookie set on panel sign-in, cleared
  on `/auth/signout` (always 204) [src/oauth/routes.ts:completeSession]
- 302 redirects to provider authorize URLs and to the Stripe Payment Link [src/oauth/routes.ts:finishUpgrade]
- `console.error` on failed token issue, refresh, sign-in, invalid `BELLMAN_USERS`, `BELLMAN_OPERATORS` or panel
  origins [src/oauth/routes.ts:parseOperators]

## Verification

- Run: `npm test -- tests/oauth- tests/oidc.test.ts tests/sealed.test.ts tests/dns.test.ts
  tests/agent-auth.test.ts tests/auth-store.test.ts tests/sso-flow.test.ts tests/panel-session.test.ts
  tests/browser-safety.test.ts`
- Run: `npm run typecheck:worker` (`src/workerd/auth-do.ts`) and `npm run test:worker` (`auth-*`, `agent-auth-race`)
- Full gate: `npm run verify`
