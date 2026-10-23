import { isOrgId } from "../grant-index.js";
import type { Identity } from "../types.js";
import { base64url, base64urlDecode } from "./tokens.js";

/**
 * Upstream identity providers.
 *
 * Bellman is its own authorization server, but it does not want to be an
 * identity provider: GitHub and Google authenticate the human, and Bellman
 * maps the result onto the Identity the tools already understand.
 *
 * The upstream access token is used once, here, to read a profile, and is
 * never stored or passed on. The token Bellman issues is its own.
 */

export type ProviderName = "github" | "google";

export interface ProviderProfile {
  /** A hand-written provider, or `sso`: an org's own OIDC provider (SSO spec, D9), whose subject is `<orgId>:<sub>`. */
  provider: ProviderName | "sso";
  /** Stable upstream id. Emails change; this does not. */
  subject: string;
  label: string;
  email?: string;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Provider {
  name: ProviderName;
  displayName: string;
  authorizeUrl(creds: ProviderCredentials, redirectUri: string, state: string): string;
  exchange(
    creds: ProviderCredentials,
    code: string,
    redirectUri: string,
    fetchImpl?: typeof fetch
  ): Promise<ProviderProfile>;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const github: Provider = {
  name: "github",
  displayName: "GitHub",
  authorizeUrl(creds, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
  async exchange(creds, code, redirectUri, fetchImpl = fetch) {
    const token = await json<{ access_token?: string; error_description?: string }>(
      await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      }),
      "GitHub token exchange"
    );
    if (!token.access_token) throw new Error(token.error_description ?? "GitHub returned no access token");

    const headers = {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bellman-mcp-server",
    };
    const user = await json<{ id: number; login: string; email: string | null }>(
      await fetchImpl("https://api.github.com/user", { headers }),
      "GitHub profile"
    );

    let email = user.email ?? undefined;
    if (!email) {
      // A private primary email is not on /user; ask the emails endpoint.
      const emails = await json<{ email: string; primary: boolean; verified: boolean }[]>(
        await fetchImpl("https://api.github.com/user/emails", { headers }),
        "GitHub emails"
      ).catch(() => []);
      email = emails.find((e) => e.primary && e.verified)?.email;
    }
    return { provider: "github", subject: String(user.id), label: user.login, email };
  },
};

export const google: Provider = {
  name: "google",
  displayName: "Google",
  authorizeUrl(creds, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },
  async exchange(creds, code, redirectUri, fetchImpl = fetch) {
    const token = await json<{ access_token?: string; error_description?: string }>(
      await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      }),
      "Google token exchange"
    );
    if (!token.access_token) throw new Error(token.error_description ?? "Google returned no access token");

    const user = await json<{ sub: string; email?: string; email_verified?: boolean; name?: string }>(
      await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
      "Google profile"
    );
    // An unverified Google email must not become an identity key: anyone can
    // claim an address they do not control.
    const email = user.email_verified ? user.email : undefined;
    return { provider: "google", subject: user.sub, label: user.name ?? email ?? user.sub, email };
  },
};

export const PROVIDERS: Record<ProviderName, Provider> = { github, google };

export function isProviderName(value: string): value is ProviderName {
  return value === "github" || value === "google";
}

/**
 * An IdP's `sub` as a key may carry (SSO spec, D10): 1 to 128 printable ASCII characters, no
 * space. OIDC puts no grammar on a subject; this is the bound a storage key and a user id accept.
 */
export const SSO_SUB = /^[\x21-\x7e]{1,128}$/;

/** The identity key an org's IdP subject is filed under: readable in a roster, unambiguous because an org id holds no colon. */
export const ssoKey = (orgId: string, sub: string): string => `sso:${orgId}:${sub}`;

/** The org and the subject an `sso:` key names, or null for a key outside the grammar. */
export function parseSsoKey(key: string): { orgId: string; sub: string } | null {
  if (!key.startsWith("sso:")) return null;
  const rest = key.slice("sso:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const orgId = rest.slice(0, colon);
  const sub = rest.slice(colon + 1);
  return isOrgId(orgId) && SSO_SUB.test(sub) ? { orgId, sub } : null;
}

const utf8 = new TextEncoder();

/**
 * The user id an SSO sign-in mints (D10): `u_sso_` and the org and subject encoded whole. The
 * user id grammar is letters, digits, `-` and `_`, and so is an org id's, so no separator could
 * split the two inside an id; base64url fits the grammar and decodes back, which `signedInPlan`
 * needs to read a hosted room creator's plan again.
 */
export const ssoUserId = (orgId: string, sub: string): string => `u_sso_${base64url(utf8.encode(`${orgId}:${sub}`))}`;

/** The `sso:` key a user id encodes, or null for an id no SSO sign-in minted. */
export function ssoKeyForUser(userId: string): string | null {
  const encoded = /^u_sso_([A-Za-z0-9_-]+)$/.exec(userId)?.[1];
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64urlDecode(encoded));
  } catch {
    return null;
  }
  return parseSsoKey(`sso:${decoded}`) === null ? null : `sso:${decoded}`;
}

/**
 * Every key an identity may be filed under, most specific first.
 *
 * No label. A GitHub login is renameable and the vacated one reclaimable; a
 * Google display name is an arbitrary string its owner picks, unique in no
 * sense at all. Keeping labels for operator convenience produced a security
 * bug on the grant path and then a second one on the refresh path, so they are
 * gone from key resolution entirely. Operators key BELLMAN_USERS by subject.
 */
export function identityKeys(profile: ProviderProfile): string[] {
  const keys = [`${profile.provider}:${profile.subject}`];
  // An org's IdP has no address namespace of its own: the subject, and the address when the org
  // verified its domain (SSO spec, D10), which is how an admin's `email:` grant is claimed.
  if (profile.email && profile.provider === "sso") keys.push(`email:${profile.email}`);
  else if (profile.email) keys.push(`${profile.provider}:${profile.email}`, `email:${profile.email}`);
  // And the address lowercased whole when the provider spelt it otherwise: a SCIM push seats the lowercased
  // address (SCIM spec, D2), and a provider that reports capitals must still claim that seat.
  const lower = profile.email?.toLowerCase();
  if (lower && lower !== profile.email) keys.push(`email:${lower}`);
  return keys;
}

/**
 * The keys that cannot have changed hands since they were written down.
 *
 * Only the provider's subject qualifies. A verified address is safe at
 * sign-in, because the provider just confirmed the human holds it — but a
 * stored key list is a snapshot, and by the time a refresh replays it the
 * address may belong to somebody else. Resolving a plan from a stale mutable
 * key is how a token inherits a stranger's plan and org.
 */
export function immutableKeys(keys: string[]): string[] {
  // An IdP's subject is as immutable as a GitHub id: OIDC promises it never reassigned within the issuer.
  return keys.filter((key) => /^(?:github|google):\d+$/.test(key) || parseSsoKey(key) !== null);
}

/**
 * Whether a key names a human and keeps naming them.
 *
 * A label does not. A GitHub login can be renamed and the vacated one claimed
 * by someone else; a Google display name is not an identifier in any sense.
 * Keying a plan to one means whoever holds that label next inherits the plan,
 * the role and the org.
 *
 * That was survivable while BELLMAN_USERS — a Worker secret only the operator
 * can edit — was the only thing that could file a key. /admin/grants puts the
 * same power in the hands of every team admin, so grants are restricted to the
 * provider's stable subject or a verified email address. Overrides still
 * accept a label, because the operator is trusted by definition and it is
 * their own foot.
 */
export function isStableIdentityKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator < 0) return false;
  const provider = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (!value) return false;
  if (provider === "email") return value.includes("@");
  // An org's IdP hands out an opaque subject; the key names the org beside it, and both must parse (SSO spec, D10).
  if (provider === "sso") return parseSsoKey(key) !== null;
  if (!isProviderName(provider)) return false;
  // Both hand-written providers hand out numeric subjects — GitHub a database
  // id, Google a string of digits — and an address only reaches this list after
  // the provider said it was verified.
  return /^\d+$/.test(value) || value.includes("@");
}

/** The subset of a stored key list that a grant may be resolved against. */
export function grantKeys(keys: string[]): string[] {
  return keys.filter(isStableIdentityKey);
}

/**
 * Who this human is before any plan is applied.
 *
 * userId is derived from the provider subject and nothing else. That is what
 * lets a plan be granted, changed or revoked without orphaning the sessions
 * they already created.
 */
export function defaultIdentity(profile: ProviderProfile): Identity {
  const sso = profile.provider === "sso" ? parseSsoKey(`sso:${profile.subject}`) : null;
  return {
    userId: sso ? ssoUserId(sso.orgId, sso.sub) : `u_${profile.provider}_${profile.subject}`,
    orgId: null,
    plan: "free",
    role: "member",
    label: profile.email ?? `${profile.label}@${profile.provider}`,
  };
}

/**
 * Map an authenticated human onto a Bellman identity using the operator's
 * BELLMAN_USERS map alone. Runtime grants are resolved in routes.ts, which has
 * the store; this is the secret-only path and the one the tests pin.
 */
export function identityFor(
  profile: ProviderProfile,
  overrides: Record<string, Identity> = {}
): Identity {
  for (const key of identityKeys(profile)) {
    const match = overrides[key];
    if (match) return match;
  }
  return defaultIdentity(profile);
}

export function parseOverrides(raw: string | undefined): Record<string, Identity> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Identity>;
  } catch {
    // Same rule as BELLMAN_KEYS: a malformed map must not silently promote or
    // demote anyone. Fall back to defaults and say so.
    console.error("BELLMAN_USERS is set but is not valid JSON — ignoring it");
    return {};
  }
}
