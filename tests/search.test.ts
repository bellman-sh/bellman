import { describe, expect, it } from "vitest";
import { MAX_RESULTS, checkQuery, cutAtWord, queryWords, searchCards, searchMessages } from "../src/search.js";
import type { SessionEvent, SurfaceRow } from "../src/types.js";

const row = (key: string, over: Partial<SurfaceRow> = {}): SurfaceRow => ({
  key, kind: "text", title: null, body: null, ends: null, placement: null, blob: null, shape: null,
  cursor: 1, at: 1_000, createdAt: 1_000, byMemberId: "m_a", byLabel: "a@x", ...over,
});
const msg = (cursor: number, payload: unknown, over: Partial<SessionEvent> = {}): SessionEvent => ({
  cursor, type: "message", fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a@x", payload, refId: null, at: cursor * 1_000, ...over,
});
const cards = (rows: SurfaceRow[], q: string) => searchCards(rows, queryWords(q));
const keys = (out: { results: { row: SurfaceRow }[] }) => out.results.map((h) => h.row.key);

describe("a query (room search spec, section 2, D5)", () => {
  it("lower-cases, splits on whitespace, and drops punctuation at a word's edges but not inside it", () => {
    expect(queryWords("  Retry, POLICY!  node.js (v2) a.b* ")).toEqual(["retry", "policy", "node.js", "v2", "a.b"]);
    expect(queryWords("-- ... --")).toEqual([]);
  });

  it("is 3 to 200 characters once trimmed, and must hold a word", () => {
    for (const q of ["ab", "  ab  ", "a".repeat(201)]) expect(checkQuery(q)).toEqual({ ok: false, reason: "query must be 3 to 200 characters" });
    expect(checkQuery("abc")).toEqual({ ok: true, words: ["abc"] });
    expect(checkQuery("a".repeat(200))).toEqual({ ok: true, words: ["a".repeat(200)] });
    expect(checkQuery("?!.,")).toEqual({ ok: false, reason: "query must hold a word of letters or digits" });
  });
});

describe("matching cards", () => {
  it("needs every word, in any field, in any case, inside a longer word, with a metacharacter read as itself", () => {
    expect(keys(cards([row("a", { title: "Retry", body: "the SEND path" }), row("b", { body: "retry only" })], "retry send"))).toEqual(["a"]);
    expect(keys(cards([row("a", { body: "keeps retrying" })], "retry"))).toEqual(["a"]);
    expect(keys(cards([row("a", { body: "use a.b* here" }), row("b", { body: "aXbbb" })], "a.b*"))).toEqual(["a"]);
  });

  it("matches a word in the key alone at rank 2, snippeting the title, else the body's first line, else nothing", () => {
    const out = cards([
      row("retry-plan", { title: "Plan", body: "line one\nline two", createdAt: 3_000 }),
      row("retry-notes", { body: "\n  first words  \nmore", createdAt: 2_000 }),
      row("retry-box", { kind: "shape", createdAt: 1_000 }),
    ], "retry");
    expect(out.results.map((h) => [h.row.key, h.snippet])).toEqual([["retry-plan", "Plan"], ["retry-notes", "first words"], ["retry-box", null]]);
  });

  it("reads a connector by its title alone, and a file or an image by its title and name, never its key", () => {
    const blob = (name: string) => ({ id: "0".repeat(32), bytes: 1, type: "application/pdf", name });
    const rows = [
      row("c1", { kind: "connector", title: "Retry path", body: "x", ends: { from: "a", to: "b" } }),
      row("c2", { kind: "connector", title: "Path", body: "retry label", ends: { from: "a", to: "b" } }),
      row("f1", { kind: "file", blob: blob("retry-notes.pdf") }),
      row("retry-f2", { kind: "file", blob: blob("a.pdf") }),
    ];
    expect(keys(cards(rows, "retry")).sort()).toEqual(["c1", "f1"]);
    expect(cards(rows, "retry").results.find((h) => h.row.key === "f1")!.snippet).toBe("retry-notes.pdf");
  });

  it("puts a title match first, then newest, then key, and reads a row with no createdAt by its at", () => {
    const rows = [
      row("t-old", { title: "Retry policy", createdAt: 1_000 }),
      row("t-new", { title: "Retry policy", createdAt: 2_000 }),
      row("y", { body: "retry policy", createdAt: 3_000 }),
      row("x", { body: "retry policy", createdAt: 3_000 }),
      row("split", { title: "Retry", body: "policy", createdAt: 9_000 }),
      row("legacy", { body: "retry policy", createdAt: undefined, at: 4_000 }),
    ];
    expect(keys(cards(rows, "retry policy"))).toEqual(["t-new", "t-old", "split", "legacy", "x", "y"]);
  });

  it("answers at most ten, the best ten, with the count of all that matched", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`k${String(i).padStart(2, "0")}`, { body: "retry", createdAt: i }));
    const out = cards(rows, "retry");
    expect([out.total, out.results.length]).toEqual([14, MAX_RESULTS]);
    expect(keys(out)[0]).toBe("k13");
  });
});

describe("snippets (section 2, R7)", () => {
  it("is the first line of the body that holds the first word, trimmed; the whole body when it has no newline", () => {
    expect(cards([row("a", { body: "intro\n  the retry rule  \nretry again" })], "retry").results[0].snippet).toBe("the retry rule");
    expect(cards([row("a", { body: "one line with retry" })], "retry").results[0].snippet).toBe("one line with retry");
  });

  it("is the title when the body does not hold the first word", () => {
    expect(cards([row("a", { title: "Retry", body: "nothing here" })], "retry").results[0].snippet).toBe("Retry");
  });

  it("cuts past 200 characters at the last space, or at 200, with an ellipsis", () => {
    expect(cutAtWord("short")).toBe("short");
    expect(cutAtWord("w".repeat(200))).toBe("w".repeat(200));
    expect(cutAtWord(`${"x".repeat(150)} ${"y".repeat(100)}`)).toBe(`${"x".repeat(150)}\u{2026}`);
    expect(cutAtWord("z".repeat(250))).toBe(`${"z".repeat(200)}\u{2026}`);
  });
});

describe("matching messages (section 2, R8)", () => {
  it("reads only a member's or the hosted seat's message, and only its text", () => {
    const events = [
      msg(1, { text: "retry from a member" }),
      msg(2, { kind: "answer", text: "retry from the host" }, { fromMemberId: "m_host", fromLabel: "host@bellman" }),
      msg(3, { text: "retry" }, { fromMemberId: "system" }),
      msg(4, { key: "retry", kind: "text", body: "retry" }, { type: "surface" }),
      msg(5, { text: "retry" }, { type: "action_request" }),
      msg(6, { note: "retry" }),
      msg(7, { text: 5 }),
    ];
    expect(searchMessages(events, ["retry"]).results.map((h) => h.event.cursor)).toEqual([2, 1]);
  });

  it("answers the newest ten by cursor with the count, each with its line", () => {
    const events = Array.from({ length: 12 }, (_, i) => msg(i + 1, { text: `hello\nretry ${i + 1}` }));
    const out = searchMessages(events, ["retry"]);
    expect([out.total, out.results.length, out.results[0].event.cursor, out.results[0].snippet]).toEqual([12, 10, 12, "retry 12"]);
  });
});
