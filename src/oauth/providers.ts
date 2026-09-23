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
 * Map an authenticated human onto a Bellman identity.
 *
 * BELLMAN_USERS names the people who get more than the default: a plan, a
 * role, an org. Everyone else signs in and gets a free identity, which is the
 * monetization model working as designed — creating sessions is gated, joining
 * never is, so a new signer-in can be invited into a room immediately.
 */
export function identityFor(
  profile: ProviderProfile,
  overrides: Record<string, Identity> = {}
): Identity {
  const keys = [
    `${profile.provider}:${profile.subject}`,
    `${profile.provider}:${profile.label}`,
    ...(profile.email ? [`${profile.provider}:${profile.email}`, `email:${profile.email}`] : []),
  ];
  for (const key of keys) {
    const match = overrides[key];
    if (match) return match;
  }
  return {
    userId: `u_${profile.provider}_${profile.subject}`,
    orgId: null,
    plan: "free",
    role: "member",
    label: profile.email ?? `${profile.label}@${profile.provider}`,
  };
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
