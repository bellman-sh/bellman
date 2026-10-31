/**
 * The tool listing's budget (docs/ARCHITECTURE.md §11). Every connected client pays for the server's
 * tools/list on every request, so §11 records what it costs, a row per change, and a ceiling. This counts
 * by §11's method, cl100k over each entry's compact JSON with non-ASCII `\u`-escaped as Python's
 * json.dumps leaves it, so the figure here and the figure there are the same number.
 */
import { readFileSync } from "node:fs";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { describe, expect, it } from "vitest";
import { listServerTools } from "./helpers/tool-lists.js";

const enc = new Tiktoken(cl100k);

/** An entry as `json.dumps(entry, separators=(",", ":"))` writes it: compact, each non-ASCII code unit escaped. */
const pythonJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const tokens = (value: unknown): number => enc.encode(pythonJson(value)).length;

const architecture = readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8");
const figure = (pattern: RegExp): number => {
  const found = architecture.match(pattern);
  if (!found) throw new Error(`docs/ARCHITECTURE.md §11 has no match for ${pattern}`);
  return Number(found[1]!.replace(/,/g, ""));
};
const recorded = figure(/^\| Tool definitions \| \*\*~([\d,]+)\*\* \|/m);
const ceiling = figure(/^\*\*Ceiling: ([\d,]+)\.\*\*/m);

/** The budget table's rows below its baseline: each change's delta and the total after it. */
const budget = [...architecture.matchAll(/^\| [^|]+ \| ([+−-][\d,]+) \| \**([\d,]+)\** \| [^|]+ \|$/gm)]
  .map(([, delta, total]) => ({ delta: Number(delta!.replace(/,/g, "").replace("−", "-")), total: Number(total!.replace(/,/g, "")) }));
const baseline = figure(/^\| Baseline when #416 was filed \| \| ([\d,]+) \|/m);

describe("the tool listing's budget", () => {
  it("counts as §11's method does: cl100k, over JSON escaped as Python writes it", () => {
    expect(enc.encode("hello world")).toEqual([15339, 1917]);
    expect(pythonJson({ a: "x — y", b: [1, true] })).toBe('{"a":"x \\u2014 y","b":[1,true]}');
  });

  it("is the figure §11 records", async () => {
    const total = (await listServerTools()).reduce((sum, tool) => sum + tokens(tool), 0);
    expect(total, `§11 records ~${recorded}; the listing measures ${total}. Update its Tool definitions row and add a budget row`).toBe(recorded);
  });

  it("stays under §11's ceiling", () => {
    expect(recorded, `the listing is past §11's ceiling of ${ceiling}. Raising it is a decision recorded in §11`).toBeLessThanOrEqual(ceiling);
  });

  it("adds up: each budget row is the one before plus its delta, and the last change's total is the recorded figure", () => {
    const rows = budget.slice(0, -1);
    expect(budget.at(-1)?.total, "the budget table ends on the ceiling's row").toBe(ceiling);
    rows.reduce((before, row) => {
      expect(row.total, `a budget row's total is ${before} plus ${row.delta}`).toBe(before + row.delta);
      return row.total;
    }, baseline);
    expect(rows.at(-1)?.total).toBe(recorded);
  });
});
