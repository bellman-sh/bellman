import type { Identity } from "../types.js";

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
  provider: ProviderName;
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
  if (profile.email) keys.push(`${profile.provider}:${profile.email}`, `email:${profile.email}`);
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
  return keys.filter((key) => /^(?:github|google):\d+$/.test(key));
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
  if (!isProviderName(provider)) return false;
  // Both providers hand out numeric subjects — GitHub a database id, Google a
  // string of digits — and an address only reaches this list after the
  // provider said it was verified. A third provider with opaque subjects would
  // need this rule widened, and grants would silently stop resolving until it
  // was, so: assumption stated out loud.
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
  return {
    userId: `u_${profile.provider}_${profile.subject}`,
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
