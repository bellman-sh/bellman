# ADR 0036 — Invites by email: mailed, linked, expiring, resendable

**Date:** 2026-10-23 · **Status:** accepted · **Amends:** 0027 · **Closes:** #54 · **Spec:** `docs/superpowers/specs/2026-10-23-org-invites-by-email-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-org-invites-by-email.md`

## Context

ADR 0027 made an admin's seat for a person the org does not own by its form an invite: a row apart
from the grants, answered on a page the person's next sign-in stops at. It said nothing to the
person. An invite to `email:ana@example.com` waited for Ana to sign in with a provider that
reported that address, and nobody told Ana. It also never lapsed, and could not be sent again.

## Decision

- **An invite to an address is mailed**, through a `send_email` binding of its own (`INVITE_EMAIL`,
  since the reports' binding is fixed to support@), from `invites@bellman.sh`, as plain text naming the org, the role, a link and the expiry. No other mail
  provider, no new secret. The mailer logs and swallows a failed send, and the API says `mailed: false`.
- **The link is a signed token, not a stored one**: a JWT with audience `bellman:invite` naming the
  org, the key and the invite's `invitedAt`, expiring with the invite. The invite row is the
  single-use part, and a link opens only the row it was signed for: a withdrawal, a resend, a Join,
  or the expiry makes every earlier link dead, and an invite withdrawn and issued again is not the
  old links' to open. `GET /invite/<token>` shows the org and the role and starts a panel sign-in
  whose signed state carries the token's claim, never the token, since that state goes to the
  provider; the callback adds that invite to the sign-in's offers and the Join reads it under the
  invite's key, each checking it is still the invite the link named. The person joins under whatever their
  provider reported, which is how an address a provider does not report still gets its person in.
- **A link attaches nothing on its own.** Opening it starts a sign-in, with the nonce cookie the
  panel sign-in sets, even for a browser already signed in. The invite is attached only after a
  provider has just asserted who this is.
- **Every invite expires**, fourteen days after it was issued or last resent. Expired invites are
  offered to nobody and refused at the Join; the roster lists them as `expired` so an admin can
  resend or withdraw them, and they count toward the pending cap until withdrawn. No sweeper.
- **Resend** is `POST /org/members/<key>/resend`: it moves `invitedAt`, extends the expiry, mails a
  fresh link, and is refused for ten minutes after the last one. Moving `invitedAt` is what makes a
  resend ask again after a decline (ADR 0027).
- **An org mails at most fifty invites a UTC day**, or twice its seats if that is more. Every send
  counts, an invite's and a resend's alike, so withdrawing and inviting again is no way past the
  resend's ten minutes. Past the budget the invite is still made, and answers `mailed: false` with
  its link.
- **A full org refuses to invite** at `POST /org/members`, before any mail goes; an invite still
  takes no seat, and the Join re-checks.
- The 202 of an invite and the 200 of a resend carry `link` and `mailed`, for any key: an admin can
  hand the link on by other means. The roster never carries links.

## Consequences

- ADR 0027's "invites do not expire" no longer holds. Its seats-as-offers (an unowned address seat)
  are grants and still do not expire.
- The binding reaches arbitrary recipients only once the sending domain is onboarded to Cloudflare
  Email Service; until then every invite is created, answered with its link, and `mailed: false`.
- A resend retires the invite's older links: a person who opens an older mail is told the invitation
  expired or was withdrawn, and uses the newest one. A leaked link dies with a resend or a withdrawal.
- A send the binding refuses still spends the budget: the count is taken before the mail goes.
- Bounces are not reported to the Worker: an address that does not exist looks like one that was
  never opened, and the admin sees only an invite that expires.
