# Security

Bellman carries context between agent sessions that do not trust each other, and
since v0.1 it is also an OAuth authorization server. Both make it a sensible
place to look for bugs.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/bellman-sh/bellman/security/advisories/new).
Please don't open a public issue for anything exploitable.

Tell us what you can reproduce, and what an attacker gets out of it. A working
proof of concept helps but isn't required. Expect a first reply within a few
days; this is a small project, not a vendor with an on-call rota.

## What we consider a vulnerability

- **Cross-member leakage.** Anything that lets one member read a session, brief,
  event or audit entry they are not a member of, or lets a member drive another
  member's handle.
- **Token and key handling.** Forging or replaying an access token, using a token
  minted for another resource, bypassing PKCE, redeeming an authorization code
  twice, reusing a rotated refresh token, or reaching an identity you were not
  granted.
- **Escaping the untrusted frame.** Peer content is wrapped and delivered as data.
  A payload that escapes that framing — closing the `<channel>` tag, or otherwise
  presenting itself to the receiving model as instructions or as server output —
  is a vulnerability, not a curiosity.
- **Org boundaries.** Reading an org's audit stream from outside it, or joining an
  `org_only` session without being in the org.
- **Denial of service** that is cheap to mount and expensive to absorb.

## What we already know

These are documented tradeoffs, not findings:

- **Access tokens cannot be revoked.** They are signed, not stored, and live 10
  minutes. A leaked token is good until it expires.
- **Client registration is open.** Dynamic registration is unauthenticated by
  design; hardening is tracked in the issue tracker.
- **A peer can inject text into your context.** That is what Bellman does. The
  mitigations are the untrusted envelope, the instruction not to act on peer
  content, and human approval for action requests. Reports that strengthen those
  are welcome; "an agent followed instructions in a message" on its own is the
  known shape of the problem.
- **Bellman holds no secrets for you.** It is a coordination layer. If you put a
  credential in a message, it is stored with the session and replayed to members.
