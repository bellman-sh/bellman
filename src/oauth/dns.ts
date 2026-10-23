import { base64url } from "./tokens.js";

/**
 * A domain is proven by a TXT record (SSO spec, D11): the org publishes `_bellman.<domain>` with
 * `bellman-verify=<token>`, and the verify route reads it over DNS-over-HTTPS, a fetch and no
 * dependency. Runtime-free, so the tests drive it over a fake resolver.
 */

/** Cloudflare's resolver, JSON API. One resolver, not a race across several: a disagreement would be a wrong answer either way. */
export const DNS_JSON = "https://cloudflare-dns.com/dns-query";

/**
 * A hostname an org may claim: lowercase labels of letters, digits and hyphens, each 1 to 63
 * characters and not starting or ending in a hyphen, at least two of them, the last letters only
 * and at least two of them, the whole at most 253 characters. Lowercase on purpose: the claim and
 * the address are compared as strings, and `domainOf` lowercases.
 */
export function isDomain(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

/** The domain of an address, lowercased, after the last `@`; null unless it is a domain. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return isDomain(domain) ? domain : null;
}

/** The record an org publishes, as the claim route answers it. */
export function verificationRecord(domain: string, token: string): { name: string; type: "TXT"; value: string } {
  return { name: `_bellman.${domain}`, type: "TXT", value: `bellman-verify=${token}` };
}

/** 16 random bytes in base64url: unguessable, and nothing a DNS record cannot carry. */
export const newDomainToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(16)));

const TXT = 16;

/**
 * The TXT records at `name`: each answer's strings unquoted and joined, since a long record arrives
 * as several quoted strings separated by spaces. An empty list for a name that does not exist; a
 * throw for a resolver that could not answer, which the route reports as the resolver's failure
 * and never as "unverified".
 */
export async function txtRecords(name: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = new URL(DNS_JSON);
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const res = await fetchImpl(url.toString(), { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`the resolver answered HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => undefined);
  if (typeof body !== "object" || body === null) throw new Error("the resolver's answer is not JSON");
  const answers = (body as { Answer?: unknown }).Answer;
  if (!Array.isArray(answers)) return [];
  const wanted = name.toLowerCase().replace(/\.$/, "");
  return answers
    .filter((a): a is { name: string; type: number; data: string } =>
      typeof a === "object" && a !== null && (a as { type?: unknown }).type === TXT && typeof (a as { data?: unknown }).data === "string"
      && typeof (a as { name?: unknown }).name === "string" && (a as { name: string }).name.toLowerCase().replace(/\.$/, "") === wanted)
    .map((a) => unquote(a.data));
}

/** `"bellman-" "verify=abc"` is one record in two strings: strip each pair of quotes and join. */
function unquote(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data;
  return parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/** Whether the domain's record carries this token, or what was found there when it does not. */
export async function domainVerified(
  domain: string, token: string, fetchImpl: typeof fetch = fetch,
): Promise<{ verified: true } | { verified: false; found: string[] }> {
  const { name, value } = verificationRecord(domain, token);
  const found = await txtRecords(name, fetchImpl);
  return found.includes(value) ? { verified: true } : { verified: false, found };
}
