# ADR 0025 — SSO is one OIDC provider per org, routed by a verified domain

**Date:** 2026-10-21 · **Status:** accepted, amended by ADR 0027 · **Closes:** #55 · **Spec:** `docs/superpowers/specs/2026-10-21-orgs-and-sso-design.md` (D9 to D14)

## Context

Sign-in was GitHub and Google, compiled in. Every company that would buy Team authenticates
through Okta, Entra ID, Google Workspace or JumpCloud, and asks for SSO before anything else.
An org is a record now (ADR 0024), so a per-org identity provider has somewhere to live.

## Decision

1. **One generic OIDC provider, configured per org and discovered when saved.** `PUT /org/idp`
   fetches the issuer's discovery document, requires its `issuer` to equal the one given and the
   endpoints to be https, and stores what it found under `oi:<orgId>`, apart from the `Org` record;
   a sign-in fetches no discovery document. OIDC only: it covers the four IdPs named, and SAML is a
   different protocol. `protocol: "oidc"` and the separate row are where SAML would differ.
2. **The IdP subject is the stable key**, `sso:<orgId>:<sub>`, and the user id encodes both,
   `u_sso_<base64url(orgId:sub)>`, because the user id grammar has no separator to spare and
   `signedInPlan` has to decode it. `sub` is 1 to 128 printable ASCII characters.
3. **A domain does nothing until a DNS TXT record proves it.** `_bellman.<domain>` carrying
   `bellman-verify=<token>`, read over Cloudflare's DNS-over-HTTPS; `verifyDomain` writes the one
   index `od:<domain>` in the same transaction, so two orgs cannot both win a domain. Only a verified
   domain routes a sign-in or counts an address.
4. **Sign-in is routed by email domain.** The `/authorize` and `/auth/signin` pages carry a
   work-email form; `/authorize/sso` sends the address's domain to its org's IdP with the same
   signed state the buttons carry and a nonce derived from it, and one redirect URI per org,
   `/callback/sso/<orgId>`, which is what an Okta or Entra admin registers. The id token's `iss`,
   `aud`, `exp`, `nonce` and `sub` are checked; its signature is not, since it arrived in the token
   endpoint's own response over TLS (OIDC Core 3.1.3.7, step 6).
5. **The first sign-in seats the person**: `provisionSsoMember`, one transaction, a `team` member
   grant from `sso` within the org's seats; a full org refuses before anything is minted. An
   admin's `email:` grant for the address is claimed onto the subject first, so the role they
   were given holds and no second seat is taken.
6. **`require_sso` is enforced where plans resolve.** `ssoRefusal` runs at sign-in and at every
   re-check (a refresh, a panel session, a hosted room's month turn): a GitHub or Google sign-in
   that lands in the org by a grant that took effect, never by an invite (ADR 0027), or carries a
   verified address under one of its domains, is refused
   unless the person is the org's owner, whose original provider is the break-glass. An operator
   override and an SSO profile are exempt.
7. **The client secret is sealed** with AES-256-GCM under a key HKDF derives from
   `BELLMAN_SEAL_SECRET`, or from `BELLMAN_TOKEN_SECRET` when that is unset, and no route returns it.

## Consequences

- No SAML, no SCIM (#56), no account linking: a person who had a personal account under an
  address whose org turns `require_sso` on signs in through SSO as a different account, and their
  earlier rooms stay with the old one. The refusal says so; admins should seat existing members
  by their GitHub or Google key before turning the switch on if those accounts should be kept.
- A domain is checked once, when its admin asks; nothing re-checks it on a schedule.
- Rotating the seal secret means every org re-enters its IdP secret, which is why
  `BELLMAN_SEAL_SECRET` can be kept apart from a token secret rotation.
- An IdP that moves an endpoint is re-saved by its admin; the save says what it could not use.
- The panel's SSO pages are dash work; this gives them the JSON and the record to publish.
