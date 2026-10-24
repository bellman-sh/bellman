import { createdAtOf } from "./surface.js";
import type { SessionEvent, SurfaceRow } from "./types.js";

// Room search (docs/superpowers/specs/2026-10-23-room-search-design.md,
// section 2). The one place a record is matched, ranked and snippeted: the
// tool, both HTTP reads and the dash's expectations all rest on these rules,
// so a change here is the change. Runtime-free on purpose, like
// projections.ts: it imports a type and one other runtime-free module, so the
// Worker's routes and the MCP server read the same function.

export const QUERY_MIN_CHARS = 3;
export const QUERY_MAX_CHARS = 200;
export const MAX_RESULTS = 10;
// ponytail: a member's message search reads the newest 2,000 events through
// recentEvents and matches them in the Worker, so 2,000 events of up to
// MAX_PAYLOAD_CHARS (20,000) each cross the RPC to get here and can pass its
// message limit. The upgrade is a store method that matches inside the room's
// Durable Object, where an index would live.
export const MAX_MESSAGE_SCAN = 2_000;
export const SNIPPET_CHARS = 200;
export const SEARCH_IN = ["cards", "messages"] as const;
export type SearchIn = (typeof SEARCH_IN)[number];
export const QUERY_LENGTH_REFUSAL = "query must be 3 to 200 characters";
export const QUERY_WORDLESS_REFUSAL = "query must hold a word of letters or digits";

// A letter, a digit, or a combining mark (so a word's last letter keeps its vowel sign or accent).
const EDGE_PUNCTUATION = /^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu;

/** The query's words: lower-cased, split on whitespace, punctuation shed at each word's edges and kept inside it. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCTUATION, ""))
    .filter((w) => w.length > 0);
}

/** Length is the trimmed query's UTF-16 length, as every surface bound counts; a query of no words is refused, since every word of nothing is in every card. */
export function checkQuery(query: string): { ok: true; words: string[] } | { ok: false; reason: string } {
  const length = query.trim().length;
  if (length < QUERY_MIN_CHARS || length > QUERY_MAX_CHARS) return { ok: false, reason: QUERY_LENGTH_REFUSAL };
  const words = queryWords(query);
  if (words.length === 0) return { ok: false, reason: QUERY_WORDLESS_REFUSAL };
  return { ok: true, words };
}

/**
 * A line past SNIPPET_CHARS is cut at the last space at or before that index, or at the index when
 * it has none (whole, so a surrogate pair is never split), and ends in an ellipsis.
 */
export function cutAtWord(line: string): string {
  if (line.length <= SNIPPET_CHARS) return line;
  const space = line.lastIndexOf(" ", SNIPPET_CHARS);
  if (space > 0) return `${line.slice(0, space)}\u{2026}`;
  const last = line.charCodeAt(SNIPPET_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? SNIPPET_CHARS - 1 : SNIPPET_CHARS;
  return `${line.slice(0, end)}\u{2026}`;
}

/** The fields a search reads, by kind: a connector its title; a file or an image its title and name; every other kind its title, body and key. A null field is no text. */
export function cardFields(row: SurfaceRow): string[] {
  const fields =
    row.kind === "connector" ? [row.title]
    : row.kind === "file" || row.kind === "image" ? [row.title, row.blob?.name ?? null]
    : [row.title, row.body, row.key];
  return fields.filter((f): f is string => f !== null);
}

/** A member's or the hosted seat's message; the server's own ("system") events are not anyone's words. */
export const isMessage = (e: SessionEvent): boolean => e.type === "message" && e.fromMemberId !== "system";

/** A message's text is `payload.text` when that is a string, the shape members and the hosted seat send; any other payload has no text. */
export const messageText = (e: SessionEvent): string | null => {
  const p = e.payload;
  if (typeof p !== "object" || p === null) return null;
  const text = (p as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
};

export interface CardHit { row: SurfaceRow; snippet: string | null }
export interface MessageHit { event: SessionEvent; snippet: string }

const holdsEvery = (fields: readonly string[], words: readonly string[]): boolean => {
  const lowered = fields.map((f) => f.toLowerCase());
  return words.every((w) => lowered.some((f) => f.includes(w)));
};

/** The first line of `text` that holds `word`, trimmed; null when none does. */
const lineHolding = (text: string, word: string): string | null => {
  const line = text.split("\n").find((l) => l.toLowerCase().includes(word));
  return line === undefined ? null : line.trim();
};

const firstLine = (text: string): string | null => {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line === undefined ? null : line.trim();
};

/** R7: the body's line that holds the first word; else the title; else a file's or an image's name; else the body's first line; else nothing. */
function cardSnippet(row: SurfaceRow, word: string): string | null {
  const named = row.kind === "file" || row.kind === "image";
  const body = named || row.kind === "connector" ? null : row.body;
  const candidates: (string | null)[] = [
    body === null ? null : lineHolding(body, word),
    row.title?.trim() || null,
    named ? row.blob?.name ?? null : null,
    body === null ? null : firstLine(body),
  ];
  const chosen = candidates.find((c) => c !== null) ?? null;
  return chosen === null ? null : cutAtWord(chosen);
}

/** Every word in some field; a title holding every word ranks first; then newest first, then key, as the surface pages. Snippets are made for the ten kept only. */
export function searchCards(rows: readonly SurfaceRow[], words: readonly string[]): { total: number; results: CardHit[] } {
  const matched = rows
    .filter((row) => holdsEvery(cardFields(row), words))
    .map((row) => ({ row, rank: row.title !== null && holdsEvery([row.title], words) ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || createdAtOf(b.row) - createdAtOf(a.row) || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  return {
    total: matched.length,
    results: matched.slice(0, MAX_RESULTS).map(({ row }) => ({ row, snippet: cardSnippet(row, words[0]) })),
  };
}

/** Every word in the message's text; newest first by cursor. */
export function searchMessages(events: readonly SessionEvent[], words: readonly string[]): { total: number; results: MessageHit[] } {
  const matched = events
    .flatMap((event) => {
      if (!isMessage(event)) return [];
      const text = messageText(event);
      return text !== null && holdsEvery([text], words) ? [{ event, text }] : [];
    })
    .sort((a, b) => b.event.cursor - a.event.cursor);
  return {
    total: matched.length,
    results: matched.slice(0, MAX_RESULTS).map(({ event, text }) => ({ event, snippet: cutAtWord(lineHolding(text, words[0]) ?? text) })),
  };
}
