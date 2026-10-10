# ADR 0013 — Bellman runs its own authorization server

**Date:** 2026-09-23 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #7

## Context

Bellman began with static bearer keys: the operator's `BELLMAN_KEYS` map, read by
`resolveIdentity` in `src/auth.ts`. #7 named OAuth 2.1 with dynamic client
registration as the swap-in for static keys, and PR #21 built it for the clients
nobody can hand a key to: the Claude Desktop connector, claude.ai and ChatGPT
find the authorization server from the resource, register themselves and run the
flow. Bellman did not want to be an identity provider as well
(`src/oauth/providers.ts`).

## Decision

1. **Bellman is the authorization server and the resource server, in one
   Worker.** `handleOAuth` (`src/oauth/routes.ts`) serves both metadata
   documents, `/register`, `/authorize` and `/token`, and a 401 from `/mcp` names
   the resource metadata in `WWW-Authenticate` (RFC 9728). A token is minted for
   one resource, `<origin>/mcp` on the hostname the request used (`oauthConfig`),
   and `verifyJwt` refuses any other audience, so a token minted for another MCP
   server, or for another hostname, is refused here.
2. **GitHub and Google authenticate the human; the tokens are Bellman's.** The
   upstream token reads one profile in the provider's `exchange` and is neither
   stored nor forwarded. `defaultIdentity` derives `userId` from the provider
   subject alone, `u_<provider>_<subject>`, so a plan granted or revoked later
   orphans no room. A Google address counts only when verified, and a label is
   never an identity key (`identityKeys`).
3. **Clients are public: PKCE with S256 only, and registration needs no
   credential.** `/authorize` refuses any other challenge method, and
   `verifyPkce` checks the verifier at `/token`. `/register` takes redirect URIs
   that are https, or http on loopback (`usableRedirect`). It is the one
   unauthenticated write, so `admitRegistration` bounds it in one `AuthDO`
   transaction: 20 an hour per address, 10,000 clients, and a client lapses
   after a day unless a token is issued for it (PR #51).
4. **Access tokens are signed and short; codes and refresh tokens are stored and
   single-use.** An access token is an HS256 JWT carrying the caller's
   `Identity`, checked with no storage read, never revoked, valid 10 minutes.
   A code (60 seconds) and a refresh token (30 days) are opaque rows in `AuthDO`,
   retired when taken; every refresh issues a new refresh token and re-resolves
   the plan from the subject captured at sign-in (`replanOnRefresh`).
5. **Nothing redirects until the client and its redirect URI are known.** Until
   then an error is a page. A signed 10-minute state carries the request through
   the provider and back, so a forged callback mints no code.
6. **The key paths stay beside it.** `resolveCaller` (`src/worker.ts`) tries an
   access token, then the key map through `resolveIdentity`, the seam #7 named.
   `BELLMAN_KEY` serves CI, `npm run smoke` and machines with no browser. The
   bridge signs itself in here on loopback ports 51004 to 51008 (PR #76). The
   control panel holds an opaque `AuthDO` session behind a `__Host-` cookie, so
   that sign-out can end it: seven days at most, one day idle (PR #166).

## Consequences

- A plan change reaches a client at its next refresh, within the 10 minutes of
  one access token. ADR 0014 records how a plan resolves.
- OAuth is Workers-only (ADR 0003). Without `BELLMAN_TOKEN_SECRET` or the `AUTH`
  binding it is off, and the Node server authenticates by key table alone. A
  deploy with neither OAuth nor a key map answers 503 (`unconfigured`).
- `AuthDO` is a singleton holding clients, codes, refresh tokens, panel sessions
  and the billing ledger, so every sign-in, refresh and registration crosses it.
