import { describe, expect, it } from "vitest";
import { DNS_JSON, domainOf, domainVerified, isDomain, newDomainToken, txtRecords, verificationRecord } from "../src/oauth/dns.js";

/** A domain is proven by a TXT record read over DNS-over-HTTPS (SSO spec, D11). */

interface Answer { name: string; type: number; data: string }
const fakeDoh = (answers: Answer[] | number | "not json", seen: string[] = []): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  seen.push(String(input));
  if (!String(input).startsWith(DNS_JSON)) return new Response("wrong host", { status: 500 });
  if (new Headers(init?.headers).get("accept") !== "application/dns-json") return new Response("wrong accept", { status: 406 });
  if (typeof answers === "number") return new Response("down", { status: answers });
  if (answers === "not json") return new Response("<html>", { status: 200 });
  return Response.json(answers.length === 0 ? { Status: 3 } : { Status: 0, Answer: answers });
}) as typeof fetch;
const txt = (data: string, name = "_bellman.acme.test"): Answer => ({ name, type: 16, data });

describe("what counts as a domain", () => {
  it("takes a lowercased hostname with a letters-only top level, bounded", () => {
    for (const good of ["acme.com", "sub.acme.co.uk", "xn--bcher-kva.example", "a-b.c-d.io", `${"a".repeat(63)}.test`]) {
      expect(isDomain(good), good).toBe(true);
    }
    for (const bad of ["ACME.com", "acme", "-acme.com", "acme-.com", "acme.com.", "acme..com", "acme.c0m", "acme.c", `${"a".repeat(64)}.test`, `${"a.".repeat(127)}test`, "", "acme.com/x", "a b.com"]) {
      expect(isDomain(bad), bad).toBe(false);
    }
  });

  it("reads the domain of an address, lowercased, after the last @", () => {
    expect(domainOf("Ana@Acme.COM")).toBe("acme.com");
    expect(domainOf("odd@user@acme.com")).toBe("acme.com");
    for (const bad of ["ana", "ana@", "@acme.com", "ana@acme", "ana@ACME"]) expect(domainOf(bad), bad).toBeNull();
  });
});

describe("the record to publish", () => {
  it("names _bellman under the domain, and carries the token", () => {
    expect(verificationRecord("acme.test", "tok")).toEqual({ name: "_bellman.acme.test", type: "TXT", value: "bellman-verify=tok" });
    const token = newDomainToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newDomainToken()).not.toBe(token);
  });
});

describe("reading TXT records", () => {
  it("asks the resolver for TXT with the JSON accept, and unquotes and joins each answer's strings", async () => {
    const seen: string[] = [];
    const records = await txtRecords("_bellman.acme.test", fakeDoh([txt('"bellman-verify=abc"'), txt('"bellman-" "verify=def"'), txt("v=spf1 -all")], seen));
    expect(records).toEqual(["bellman-verify=abc", "bellman-verify=def", "v=spf1 -all"]);
    const asked = new URL(seen[0]);
    expect([asked.searchParams.get("name"), asked.searchParams.get("type")]).toEqual(["_bellman.acme.test", "TXT"]);
  });

  it("answers nothing for a name that does not exist, and throws when the resolver fails", async () => {
    expect(await txtRecords("_bellman.nowhere.test", fakeDoh([]))).toEqual([]);
    await expect(txtRecords("_bellman.acme.test", fakeDoh(502))).rejects.toThrow(/502/);
    await expect(txtRecords("_bellman.acme.test", fakeDoh("not json"))).rejects.toThrow(/JSON/);
  });

  it("ignores answers that are not TXT records for the name asked", async () => {
    expect(await txtRecords("_bellman.acme.test", fakeDoh([{ name: "_bellman.acme.test", type: 5, data: "cname.target." }, txt('"bellman-verify=abc"')]))).toEqual(["bellman-verify=abc"]);
  });
});

describe("verifying a domain", () => {
  it("is verified when the value is among the records, and says what was found when it is not", async () => {
    expect(await domainVerified("acme.test", "abc", fakeDoh([txt("v=spf1 -all"), txt('"bellman-verify=abc"')]))).toEqual({ verified: true });
    expect(await domainVerified("acme.test", "abc", fakeDoh([txt('"bellman-verify=xyz"')]))).toEqual({ verified: false, found: ["bellman-verify=xyz"] });
    expect(await domainVerified("acme.test", "abc", fakeDoh([]))).toEqual({ verified: false, found: [] });
  });

  it("rethrows a resolver failure rather than reading it as unverified", async () => {
    await expect(domainVerified("acme.test", "abc", fakeDoh(503))).rejects.toThrow(/503/);
  });
});
