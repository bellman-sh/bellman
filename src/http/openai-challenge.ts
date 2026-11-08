/**
 * OpenAI's plugin portal proves the publisher owns the MCP server's domain by fetching a token it issued from
 * `/.well-known/openai-apps-challenge` on that host: the exact token as plain text, nothing else. The token is
 * public (anyone can fetch it), so it is a `[vars]` entry, `OPENAI_APPS_CHALLENGE`, not a secret. Runtime-free,
 * so the Node test program can hold it.
 */
export const OPENAI_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/** The response for a GET of the challenge path: the trimmed token as text/plain, or null when none is set. */
export function openaiChallengeResponse(token: string | undefined): Response | null {
  const value = token?.trim();
  if (!value) return null;
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
