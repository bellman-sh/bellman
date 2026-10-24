import { drawnOrgName } from "./orgs.js";
import { signJwt, verifyJwt } from "./oauth/tokens.js";
import { whyNotSent, type MailBinding } from "./reports.js";
import type { Org, OrgInvite } from "./types.js";

/** Where an invitation comes from (ADR 0036, D1). */
export const INVITE_FROM = "invites@bellman.sh";
/** The audience an invite link's token carries, so no other token this server signs opens the page (D2). */
export const INVITE_AUDIENCE = "bellman:invite";

type InviteClaim = { orgId: string; key: string };

/**
 * The link an invitation carries (D2): `<issuer>/invite/<token>`, the token naming the org and the invite's key and
 * expiring with the invite. It grants nothing by itself: the page it opens starts a sign-in, and the invite is read
 * again, live, when the person answers.
 */
export async function inviteLink(issuer: string, secret: string, invite: OrgInvite): Promise<string> {
  const exp = Math.floor(invite.expiresAt / 1000);
  const claim: InviteClaim = { orgId: invite.orgId, key: invite.key };
  const token = await signJwt(
    { iss: issuer, sub: "invite", aud: INVITE_AUDIENCE, bellman: claim as never, exp },
    secret,
    Math.max(1, exp - Math.floor(Date.now() / 1000)),
  );
  return `${issuer}/invite/${token}`;
}

/** The org and key a link names, or null for a bad signature, another audience, an expired link or a malformed claim. */
export async function verifyInviteLink(token: string, issuer: string, secret: string): Promise<InviteClaim | null> {
  const claims = await verifyJwt(token, secret, { issuer, audience: INVITE_AUDIENCE });
  const { orgId, key } = (claims?.bellman ?? {}) as Partial<Record<keyof InviteClaim, unknown>>;
  return typeof orgId === "string" && orgId !== "" && typeof key === "string" && key !== "" ? { orgId, key } : null;
}

/**
 * The invitation (D1). Fixed text, the org's drawn name (no control character, so no CR/LF reaches the subject) and the
 * link on its own line. The inviter is not named: a label is untrusted text, and the org is what the person is joining.
 */
export function inviteMail(org: Org, invite: OrgInvite, link: string): { subject: string; text: string } {
  const name = drawnOrgName(org);
  return {
    subject: `Join ${name} on Bellman`,
    text: [
      `${name} invited you to join it on Bellman as ${invite.role === "admin" ? "an admin" : "a member"}.`,
      "",
      "Open this link and sign in to accept:",
      "",
      link,
      "",
      `The invitation expires on ${new Date(invite.expiresAt).toUTCString()}. If you were not expecting it, ignore this message.`,
    ].join("\n"),
  };
}

// No space, control character, list separator, quote, bracket or second `@`: what is left cannot name two mailboxes.
const ATOM = "[^\\s\\x00-\\x1f\\x7f@,;:<>()\\[\\]\\\\\"]+";
const ADDRESS = new RegExp(`^${ATOM}@${ATOM}\\.${ATOM}$`);

/**
 * Whether an address is one plain mailbox the invite may be mailed to (D1). An `email:` key needs only an `@` to be a
 * key, so a list, a display name or a header line would otherwise reach the binding; 254 is the longest a path can be.
 */
export function isMailableAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}

/** Mails one invitation and answers whether the binding took it; never rejects. */
export type InviteMailer = (to: string, org: Org, invite: OrgInvite, link: string) => Promise<boolean>;

/**
 * Sends through the `send_email` binding. A missing binding or a failed send is logged once and answers false: the invite
 * is stored before this runs, and the admin holds the link to pass on by hand. The log names the org and when the invite was sent, never the address.
 */
export function inviteMailer(binding: MailBinding | undefined): InviteMailer {
  return async (to, org, invite, link) => {
    if (!isMailableAddress(to)) {
      console.error(`invite ${org.orgId} at ${invite.invitedAt}: the key is not one plain address, so no email went; the admin has the link`);
      return false;
    }
    if (!binding) {
      console.error(`invite ${org.orgId} at ${invite.invitedAt}: no send_email binding, so no email went; the admin has the link`);
      return false;
    }
    try {
      await binding.send({ from: INVITE_FROM, to, ...inviteMail(org, invite, link) });
      return true;
    } catch (err) {
      console.error(`invite ${org.orgId} at ${invite.invitedAt}: the email was not sent (${whyNotSent(err)}); the admin has the link`);
      return false;
    }
  };
}
