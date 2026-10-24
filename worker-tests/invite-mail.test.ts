/**
 * The Worker mails an org's invite (ADR 0036, D1) through its own binding, INVITE_EMAIL. SEND_EMAIL is bound to
 * support@ alone (wrangler.toml), so an invite sent through it could never reach the person invited.
 */
import { afterEach, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import { DurableObjectStore } from "../src/store-do.js";
import { DEFAULT_POLICY, type Identity } from "../src/types.js";

const ORIGIN = "https://mcp.example.test";
const SECRET = "test-signing-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ADMIN: Identity = { userId: "u_github_1", orgId: "org_acme", plan: "team", role: "admin", label: "Ana" };

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

it("mails an address invite through INVITE_EMAIL, from invites@ to the address, and nothing through SEND_EMAIL", async () => {
  await new DurableObjectStore(env as never).createOrg(
    { orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "purchase", active: true,
      createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY },
    { key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null },
    { actorUserId: "u_op" },
  );
  const invites: { from: string; to: string }[] = [];
  const reports: unknown[] = [];
  const mailing = {
    ...env, BELLMAN_TOKEN_SECRET: SECRET,
    INVITE_EMAIL: { send: async (m: { from: string; to: string }) => { invites.push(m); return { messageId: "m1" }; } },
    SEND_EMAIL: { send: async (m: unknown) => { reports.push(m); return { messageId: "m2" }; } },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const token = await signJwt(
    { iss: ORIGIN, sub: ADMIN.userId, aud: canonicalResource(`${ORIGIN}/mcp`), bellman: ADMIN, plan_source: "default" },
    SECRET, ACCESS_TOKEN_TTL_SECONDS,
  );
  const res = await worker.fetch(new Request(`${ORIGIN}/org/members`, {
    method: "POST", body: JSON.stringify({ key: "email:pat@example.org", role: "member" }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  }), mailing, ctx);
  expect(res.status, await res.clone().text()).toBe(202);
  expect(((await res.json()) as { mailed: boolean }).mailed).toBe(true);
  expect(invites).toEqual([expect.objectContaining({ from: "invites@bellman.sh", to: "pat@example.org" })]);
  expect(reports).toEqual([]);
});
