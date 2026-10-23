import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  chainHash, chainWalk, sweepPlan, nextSinkState, sinkStatus, newSink, batchBody, signBatch,
  retentionDaysOf, sinkUrlOf, deliverBatch, NO_ANCHOR, SINK_DEAD_AFTER_MS, type ChainRow, type AuditSink,
} from "../src/audit-sink.js";
import { recordOf } from "../src/audit.js";
import { backoffMs } from "../src/outbox.js";
import type { AuditEntry } from "../src/types.js";

const entry = (n: number): AuditEntry => ({ at: n, orgId: "org_a", sessionId: "qs_1", actorUserId: "u", action: "x", detail: { n } });
/** A chained stream of `n` rows after `anchor`, optionally with an unhashed prefix. */
const chain = (n: number, { unhashed = 0, anchor = NO_ANCHOR } = {}): ChainRow[] => {
  const rows: ChainRow[] = [];
  let prev = anchor.hash;
  for (let seq = anchor.seq + 1; seq <= anchor.seq + n; seq++) {
    const e = entry(seq);
    if (rows.length < unhashed) { rows.push({ seq, prevHash: null, hash: null, entry: e }); continue; }
    const hash = chainHash(seq, prev, e);
    rows.push({ seq, prevHash: prev, hash, entry: e });
    prev = hash;
  }
  return rows;
};
const walk = (rows: ChainRow[], anchor = NO_ANCHOR, from?: number) => { const w = chainWalk(anchor, from); const more = w.feed(rows); return { more, ...w.result() }; };

describe("chainHash", () => {
  it("is sha256 hex over seq, prev_hash and the record", () => {
    const e = entry(1);
    const expected = createHash("sha256").update(`7\nabc\n${JSON.stringify(recordOf(e))}`).digest("hex");
    expect(chainHash(7, "abc", e)).toBe(expected);
  });
});

describe("chainWalk", () => {
  it("an intact chain is ok, counting unhashed rows before the first hashed one", () => {
    expect(walk(chain(3, { unhashed: 1 }))).toEqual({ more: true, ok: true, from_seq: 1, through_seq: 3, checked: 2, unhashed: 1, anchor: NO_ANCHOR });
  });
  it("reports the first row whose stored hash is wrong, and feed says stop", () => {
    const rows = chain(3); rows[2] = { ...rows[2], hash: "0".repeat(64) };
    expect(walk(rows)).toMatchObject({ more: false, ok: false, broken_at: 3, checked: 3 });
  });
  it("reports a row whose prev_hash is not the previous row's hash", () => {
    const rows = chain(3); rows[2] = { ...rows[2], prevHash: "nope" };
    expect(walk(rows)).toMatchObject({ ok: false, broken_at: 3 });
  });
  it("reports an unhashed row after a hashed one", () => {
    const rows = chain(3); rows[1] = { ...rows[1], prevHash: null, hash: null };
    expect(walk(rows)).toMatchObject({ ok: false, broken_at: 2 });
  });
  it("checks the first hashed row against the anchor", () => {
    const anchor = { seq: 2, hash: "h2" };
    expect(walk(chain(2, { anchor }), anchor)).toMatchObject({ ok: true, from_seq: 3, through_seq: 4, checked: 2, anchor });
    expect(walk(chain(2, { anchor }), { seq: 2, hash: "other" })).toMatchObject({ ok: false, broken_at: 3 });
  });
  it("resumes from a seq, taking that row's stored prev_hash on trust", () => {
    expect(walk(chain(4).slice(2), NO_ANCHOR, 3)).toMatchObject({ ok: true, from_seq: 3, through_seq: 4, checked: 2 });
  });
  it("over no rows is ok with zero counts", () => {
    expect(walk([])).toEqual({ more: true, ok: true, from_seq: 0, through_seq: 0, checked: 0, unhashed: 0, anchor: NO_ANCHOR });
  });
});

describe("sweepPlan", () => {
  const rows = [{ seq: 1, at: 1, hash: "h1" }, { seq: 2, at: 2, hash: "h2" }, { seq: 3, at: 10, hash: "h3" }, { seq: 4, at: 3, hash: "h4" }];
  it("stops at the first young row in seq order, even when an older row follows it", () => {
    expect(sweepPlan(rows, 5)).toEqual({ through: 2, count: 2, anchor: { seq: 2, hash: "h2" } });
  });
  it("is null when nothing is old", () => {
    expect(sweepPlan(rows, 1)).toBeNull();
    expect(sweepPlan([], 5)).toBeNull();
  });
  it("anchors an unhashed row as an empty hash", () => {
    expect(sweepPlan([{ seq: 1, at: 1, hash: null }], 5)).toEqual({ through: 1, count: 1, anchor: { seq: 1, hash: "" } });
  });
});

describe("nextSinkState", () => {
  const failing: AuditSink = { ...newSink("https://c.example/in", 0, "s"), attempts: 2, failingSince: 1_000, lastError: "503" };
  it("success resets the failure fields and arms now only when more remain", () => {
    expect(nextSinkState(failing, { ok: true, through: 7 }, 5_000, true)).toEqual({ sink: { ...failing, deliveredThrough: 7, attempts: 0, failingSince: null, lastError: null }, armAt: 5_000, died: false });
    expect(nextSinkState(failing, { ok: true, through: 7 }, 5_000, false).armAt).toBeNull();
  });
  it("a failure counts, keeps the first failingSince and arms by backoffMs", () => {
    const fresh = newSink("https://c.example/in", 0, "s");
    expect(nextSinkState(fresh, { ok: false, error: "500" }, 5_000, false)).toEqual({ sink: { ...fresh, attempts: 1, failingSince: 5_000, lastError: "500" }, armAt: 5_000 + backoffMs(1), died: false });
    expect(nextSinkState(failing, { ok: false, error: "boom" }, 5_000, true)).toEqual({ sink: { ...failing, attempts: 3, lastError: "boom" }, armAt: 5_000 + backoffMs(3), died: false });
  });
  it("a failure a day after the first marks the sink dead and arms nothing", () => {
    const now = failing.failingSince! + SINK_DEAD_AFTER_MS;
    expect(nextSinkState(failing, { ok: false, error: "503" }, now, false)).toEqual({ sink: { ...failing, attempts: 3, dead: true }, armAt: null, died: true });
    expect(nextSinkState(failing, { ok: false, error: "503" }, now - 1, false).died).toBe(false);
  });
});

describe("sinkStatus", () => {
  const sink = newSink("https://c.example/in", 1_700_000_000_000, "s", 3);
  it("counts pending from the cursor and names the status", () => {
    expect(sinkStatus(sink, 10)).toEqual({ url: "https://c.example/in", created_at: "2023-11-14T22:13:20.000Z", delivered_through: 3, pending: 7, status: "ok", failing_since: null, last_error: null, attempts: 0 });
    expect(sinkStatus(sink, 2).pending).toBe(0);
    expect(sinkStatus({ ...sink, failingSince: 1_700_000_000_000, lastError: "500", attempts: 2 }, 3)).toMatchObject({ status: "failing", failing_since: "2023-11-14T22:13:20.000Z", last_error: "500", attempts: 2 });
    expect(sinkStatus({ ...sink, failingSince: 1, dead: true }, 3).status).toBe("dead");
  });
});

describe("batchBody and signBatch", () => {
  it("names the delivery and carries the entries", () => {
    const { delivery, body } = batchBody("org_a", [{ seq: 4 }, { seq: 5 }], 4, 5);
    expect(delivery).toBe("org_a:4-5");
    expect(JSON.parse(body)).toEqual({ org_id: "org_a", delivery: "org_a:4-5", entries: [{ seq: 4 }, { seq: 5 }] });
  });
  it("signs t.body with HMAC-SHA256 of the secret", async () => {
    const header = await signBatch("secret", 1_700_000_000_000, '{"a":1}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode('1700000000000.{"a":1}'))).toString("hex");
    expect(header).toBe(`t=1700000000000,v1=${mac}`);
  });
});

describe("retentionDaysOf", () => {
  it("accepts null and integers at or above the floor", () => {
    expect([null, 30, 365].map(retentionDaysOf)).toEqual([null, 30, 365]);
    expect([29, 30.5, "90", undefined, true].map(retentionDaysOf)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
  });
});

describe("deliverBatch", () => {
  it("never follows a redirect: a 3xx is a refusal with its status", async () => {
    let init: RequestInit | undefined;
    const post = (async (_u: string, i: RequestInit) => { init = i; return new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/" } }); }) as unknown as typeof fetch;
    const sink = newSink("https://c.example/in", 0, "s");
    expect(await deliverBatch(post, sink, "org_a", [{ seq: 1, ...entry(1) } as never], 0)).toEqual({ ok: false, error: "302" });
    expect(init?.redirect).toBe("manual");
  });
});

describe("sinkUrlOf", () => {
  it("passes an https url verbatim and refuses the rest", () => {
    expect(sinkUrlOf("https://u:p@collector.example/in#frag")).toBe("https://u:p@collector.example/in#frag");
    expect(["http://c.example", "ftp://c.example", "collector", 7, undefined].map(sinkUrlOf)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
  });
});
