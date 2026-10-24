# ADR 0037 — Agent registration: auth.md's service_auth claim on the authorization server

**Date:** 2026-10-23 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-23-auth-md-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-auth-md.md`

## Context

isitagentready.com reported that `bellman.sh/auth.md` exists but the authorization-server metadata
carries no `agent_auth` block. WorkOS's auth.md profile (v0.6.0) defines that block and a flow
behind it: an agent that knows only its user's email registers, hands the user a link and a code,
and polls until the user approves. Bellman's only way in for an agent was an MCP client running
the authorization-code flow with a browser and a redirect URI.

## Decision

The spec's D1-D11, one line each:

1. **`service_auth` only.** Anonymous and ID-JAG registration are refused: Bellman has one scope
   and verifies no third party's JWT.
2. **Bellman sends no email.** The agent hands over the link and code, so an unauthenticated
   endpoint is not a mail relay.
3. **The claim binds to a verified address.** Approval needs `email:<login_hint>` in the signed-in
   session's `identity_keys`.
4. **The identity assertion is a stored, signed grant.** An HS256 JWT (`bellman:agent-assertion`,
   `jti` = registration id, 30 days) backed by an `AuthDO` record; no record, no exchange.
5. **The exchange is RFC 7523 jwt-bearer on `POST /token`.** An access token with no refresh token,
   re-planned each time; a `SignInRefused` deletes the record.
6. **Polling is the claim grant on `POST /token`.** `authorization_pending`, `slow_down`,
   `expired_token`, then success exactly once; error bodies also carry auth.md's `status`.
7. **Two windows.** The registration lives 24 hours, a code 10 minutes;
   `/agent/identity/claim` mints a fresh one and only the newest works.
8. **The claim page lives on the issuer.** `/agent/claim?claim_attempt_token=…`, behind the panel
   sign-in; the URL never carries the claim token or the code.
9. **The approval POST follows the invites page.** A single-use `held` JWT bound to the attempt and
   the session's hash; five wrong codes kill the attempt; a wrong account is refused unnamed.
10. **Limits reuse the DCR pattern.** 20 registrations per IP an hour, 10,000 unclaimed at once,
    and the `AuthDO` alarm sweeps what expired.
11. **Metadata.** `agent_auth` (with the pre-v0.2 `register_uri` and `claim_uri`) and the two new
    grant types in `grant_types_supported`.

## Consequences

- There is a second path that mints an identity's tokens, beside the authorization-code flow. It
  ends at the same panel sign-in and the same plan resolution, so it grants nothing a sign-in
  would not.
- An attacker's agent can register with a victim's address and talk the victim into approving its
  code. This is RFC 8628's device-flow exposure; the claim page's copy, which says who is signed
  in and what approving grants, is the mitigation. SECURITY.md lists it.
- An assertion is revoked only by deleting its record, which today is an operator's job. There is
  no revocation endpoint and no `events_endpoint`.
- No user-facing page lists a person's approved agents or removes one; that is a dash issue.
