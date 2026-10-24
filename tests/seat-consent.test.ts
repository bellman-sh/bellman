/**
 * Seat consent (ADR 0027), end to end: an admin's seat for a person the org does not own by its form is
 * an invite, the person answers it on a page their next sign-in stops at, and until they join, the org
 * reaches nothing of theirs: not their sign-in, not their plan, not their rooms. GitHub is faked at the
 * fetch boundary; the org routes, the authorization server, the tools and the room routes are the real
 * ones, over one MemoryStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBlobStore } from "../src/blobs.js";
import { orgRoutes } from "../src/http/orgs.js";
import { roomRoutes, type RoomCaller } from "../src/http/rooms.js";
import { scimRoutes } from "../src/http/scim.js";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { seal } from "../src/oauth/sealed.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import { PATCH_SCHEMA, SCIM_JSON, USER_SCHEMA } from "../src/scim/resource.js";
import { MemoryStore } from "../src/store.js";
import type { Identity, Org, PlanGrant } from "../src/types.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { INVITE_TTL_MS } from "../src/orgs.js";
import { brief, manifestFixture, member as seatOf, session } from "./helpers/fixtures.js";
import { Harness } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const PANEL = "https://dash.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const NONCE_COOKIE = "__Host-bellman_signin";
const SESSION_COOKIE = "__Host-bellman_session";

/** The person signing in: GitHub 4242, whose verified address is jesse@example.dev. */
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh" });
  if (url === "https://api.github.com/user") return Response.json({ id: 4242, login: "jesse", email: null });
  if (url === "https://api.github.com/user/emails") return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  return new Response(`unexpected upstream call: ${url}`, { status: 500 });
}) as typeof fetch;

const acme: Org = {
  orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "operator", active: true,
  createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY,
};
const ownerGrant: PlanGrant = { key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null };
const ACME_ADMIN: Identity = { userId: "u_github_1", orgId: "org_acme", plan: "team", role: "admin", label: "ana@acme.test" };
const B_ADMIN: Identity = { userId: "u_github_2", orgId: "org_b", plan: "team", role: "admin", label: "bo@b.test" };
const by = { actorUserId: "u_op" };

let plans: MemoryStore;
let config: OAuthConfig;
let harness: Harness;

beforeEach(async () => {
  plans = new MemoryStore();
  config = {
    issuer: ISSUER, resource: RESOURCE, secret: "test-signing-secret", sealSecret: "test-seal-secret",
    store: new MemoryAuthStore(), credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {}, panelOrigins: [PANEL], plans, fetchImpl: fakeFetch,
  };
  harness = new Harness(plans);
  await plans.createOrg(acme, ownerGrant, by);
  await plans.createOrg({ ...acme, orgId: "org_b", name: "Bee", ownerUserId: "u_github_2" }, { ...ownerGrant, key: "github:2", orgId: "org_b" }, by);
});

afterEach(async () => {
  await harness.close();
});

const oauth = async (path: string, init?: RequestInit) => (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;

/** What an org's admin sends `POST /org/members`, over a bearer token. */
async function seat(admin: Identity, key: string, role = "member") {
  const caller = async (): Promise<RoomCaller> => ({ identity: admin, via: "bearer" });
  const body = JSON.stringify({ key, role });
  return (await orgRoutes(new Request(`${ISSUER}/org/members`, {
    method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), authorization: "Bearer x" },
  }), { store: plans, caller, panelOrigins: [PANEL], issuer: ISSUER }))!;
}

/** A client's GitHub sign-in up to the callback's answer: the invites page, or the redirect with a code. */
async function githubCallback() {
  const registered = await oauth("/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const challenge = await sha256Base64url(VERIFIER);
  const chooser = await oauth(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=st-1&resource=${encodeURIComponent(RESOURCE)}`);
  const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);
  return { clientId, res: await oauth(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`) };
}

/** The held sign-in a page's forms carry. */
const heldOf = (page: string) => /name="held" value="([^"]+)"/.exec(page)![1];

/** Every button's label, in the page's order. */
const buttons = (page: string) => [...page.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

/** An answer to the invites page, as its form posts it. */
const answer = (held: string, choice: string, org?: string, cookie?: string) => oauth("/auth/invites", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams({ held, choice, ...(org ? { org } : {}) }).toString(),
});

/** The identity a redirect's code redeems for, or null when the redirect carried none. */
async function redeemed(clientId: string, res: Response): Promise<{ identity: Identity | null; target: URL }> {
  const target = new URL(res.headers.get("location") ?? "https://none.test/");
  const code = target.searchParams.get("code");
  if (!code) return { identity: null, target };
  const tokens = (await (await oauth("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
  })).json()) as { access_token: string };
  return { identity: await identityFromAccessToken(tokens.access_token, config), target };
}

/** The token endpoint's answer for a redirect's code, as it is: a used code answers `invalid_grant`. */
async function redeemOnce(clientId: string, res: Response): Promise<Record<string, unknown>> {
  const code = new URL(res.headers.get("location") ?? "https://none.test/").searchParams.get("code") ?? "";
  return (await (await oauth("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
  })).json()) as Record<string, unknown>;
}

/** A whole sign-in that answers every page it stops at with `choice` for `org`, then carries on. */
async function signIn(choice: "join" | "decline" | "continue" = "continue", org = "org_acme") {
  const { clientId, res } = await githubCallback();
  if (res.status !== 200) return { ...(await redeemed(clientId, res)), page: null as string | null };
  const page = await res.text();
  let after = await answer(heldOf(page), choice, org);
  if (after.status === 200) after = await answer(heldOf(await after.text()), "continue");
  return { ...(await redeemed(clientId, after)), page };
}

describe("the invites page (ADR 0027)", () => {
  it("stops a sign-in that has invites at a page naming each org, by the subject and by the verified address", async () => {
    expect((await seat(ACME_ADMIN, "github:4242", "admin")).status).toBe(202);
    expect((await seat(B_ADMIN, "email:jesse@example.dev")).status).toBe(202);
    const { res } = await githubCallback();
    expect([res.status, res.headers.get("location")]).toEqual([200, null]);
    const page = await res.text();
    expect(page).toContain("<strong><bdi>Acme</bdi></strong> invited you to join it as an admin.");
    expect(page).toContain("<strong><bdi>Bee</bdi></strong> invited you to join it as a member.");
    expect(buttons(page)).toEqual(["Join", "Decline", "Join", "Decline", "Not now: continue signing in"]);
    expect(page.match(/name="choice" value="join"/g)).toHaveLength(2);
    expect(page.match(/name="choice" value="decline"/g)).toHaveLength(2);
    expect(page).toContain('name="choice" value="continue"');
    expect(page).toContain('action="/auth/invites" method="post"');
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  /** An org's name is its admin's text: on the page it is drawn once, as text, and never as a button's label. */
  it("labels its buttons itself, whatever the org is called, and draws the name once, isolated", async () => {
    await plans.updateOrg("org_acme", { name: "Not now: continue signing in" }, by);
    await seat(ACME_ADMIN, "github:4242");
    const page = await (await githubCallback()).res.text();
    expect(buttons(page)).toEqual(["Join", "Decline", "Not now: continue signing in"]);
    expect(page.match(/Not now: continue signing in/g)).toHaveLength(2);
    expect(page).toContain("<strong><bdi>Not now: continue signing in</bdi></strong> invited you");
  });

  it("draws a name stored before names were checked without its control and format characters", async () => {
    await plans.updateOrg("org_acme", { name: "Ac\u202eme\u200b \u2066Co\u0007" }, by);
    await seat(ACME_ADMIN, "github:4242");
    const page = await (await githubCallback()).res.text();
    expect(page).toContain("<strong><bdi>Acme Co</bdi></strong> invited you");
    expect(page).not.toMatch(/[\u202e\u200b\u2066\u0007]/u);
  });

  it("carries a sign-in with no invites straight on, as before", async () => {
    const { res } = await githubCallback();
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("makes the grant on Join, under the subject, with the invite's role, and the sign-in lands in the org", async () => {
    await seat(ACME_ADMIN, "email:jesse@example.dev", "admin");
    await seat(ACME_ADMIN, "github:4242", "member");
    const { identity, target } = await signIn("join");
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: "org_acme", plan: "team", role: "member" });
    expect(await plans.getGrant("github:4242")).toMatchObject({ plan: "team", role: "member", orgId: "org_acme", source: "invite", grantedBy: "u_github_1" });
    expect(await plans.getGrant("email:jesse@example.dev")).toBeUndefined();
    expect(await plans.invitesFor(["github:4242", "email:jesse@example.dev"])).toEqual([]);
    expect((await plans.auditForOrg("org_acme", 50)).at(-1)).toMatchObject({ action: "plan_granted", actorUserId: "u_github_4242", detail: { key: "github:4242", source: "invite" } });
  });

  /**
   * A decline is kept on the person's side: the org's invites stay as its admin wrote them, so nothing
   * the admin can read changes, not even which of the keys they invited were one account's.
   */
  it("keeps a Decline on the person's side: the org's page stops, and its admin sees nothing change", async () => {
    await seat(ACME_ADMIN, "github:4242");
    await seat(ACME_ADMIN, "email:jesse@example.dev");
    const before = { invites: await plans.listOrgInvites("org_acme", 10), rows: await plans.auditForOrg("org_acme", 50) };
    const { identity, page } = await signIn("decline");
    expect(page).toContain("Acme");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    expect(await plans.listOrgInvites("org_acme", 10)).toEqual(before.invites);
    expect(await plans.auditForOrg("org_acme", 50)).toEqual(before.rows);
    expect((await plans.declinedOrgs("github:4242")).map((d) => d.orgId)).toEqual(["org_acme"]);
    expect((await signIn()).page).toBeNull();
  });

  it("declines only an org that made this sign-in an offer, and names no other", async () => {
    await plans.createOrg({ ...acme, orgId: "org_secret", name: "Secret Co", ownerUserId: "u_github_3" }, { ...ownerGrant, key: "github:3", orgId: "org_secret" }, by);
    await seat(B_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const after = await answer(heldOf(await res.text()), "decline", "org_secret");
    expect(after.status).toBe(200);
    const page = await after.text();
    expect(page).toContain("That invitation is no longer open.");
    expect(page).not.toContain("Secret Co");
    expect(await plans.declinedOrgs("github:4242")).toEqual([]);
    expect(page).toContain("<strong><bdi>Bee</bdi></strong> invited you");
  });

  it("keeps the invite when the person carries on without answering, and asks again next time", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const first = await signIn("continue");
    expect(first.page).toContain("Acme");
    expect(first.identity).toMatchObject({ orgId: null, plan: "free" });
    expect(await plans.invitesFor(["github:4242"])).toEqual([expect.objectContaining({ orgId: "org_acme" })]);
    expect((await signIn("continue")).page).toContain("Acme");
  });

  it("offers no expired invite at a sign-in, and keeps the row for the admin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
    await seat(ACME_ADMIN, "github:4242");
    vi.setSystemTime(1_000_000 + INVITE_TTL_MS + 1);
    const { identity, page } = await signIn("continue");
    expect([page, identity?.orgId]).toEqual([null, null]);
    const roster = await (await orgRoutes(new Request(`${ISSUER}/org/members`, { headers: { authorization: "Bearer x" } }),
      { store: plans, caller: async () => ({ identity: ACME_ADMIN, via: "bearer" }), panelOrigins: [PANEL], issuer: ISSUER }))!.json() as { members: { key: string; status: string }[] };
    expect(roster.members.find((m) => m.key === "github:4242")?.status).toBe("expired");
    vi.useRealTimers();
  });

  it("escapes the org's name, which is its admin's text", async () => {
    await plans.updateOrg("org_acme", { name: `<img src=x onerror="alert(1)"> & Co` }, by);
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const page = await res.text();
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co");
    expect(page).not.toContain("<img");
    const after = await answer(heldOf(page), "decline", "org_acme");
    expect(after.status).toBe(302);
  });

  it("refuses a Join while the person holds a seat elsewhere, or the org is full, keeping the invite and showing why", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "github:4242", role: "member", orgId: "org_b", source: "org" }, "org_b", by);
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const refused = await answer(heldOf(await res.text()), "join", "org_acme");
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("already in another organisation or holds a plan of its own, so it cannot join <bdi>Acme</bdi>.");
    expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_b" });
    expect(await plans.invitesFor(["github:4242"])).toHaveLength(1);

    await plans.deleteGrant("github:4242");
    await plans.updateOrg("org_acme", { seats: 1 }, by);
    const full = await answer(heldOf(await (await githubCallback()).res.text()), "join", "org_acme");
    expect(await full.text()).toContain("<bdi>Acme</bdi> has no free seat: ask its admin for one.");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("escapes the org's name in the line an answer shows, as in the invitation", async () => {
    await plans.updateOrg("org_acme", { name: "<b>Bold</b> & Co", seats: 1 }, by);
    // Stored, not POSTed: the route refuses an invite into a full org (ADR 0036, D5), and this one already is.
    const now = Date.now();
    await plans.putOrgInvite({ orgId: "org_acme", key: "github:4242", role: "member", invitedBy: ACME_ADMIN.userId, invitedAt: now, expiresAt: now + INVITE_TTL_MS }, by);
    const full = await answer(heldOf(await (await githubCallback()).res.text()), "join", "org_acme");
    const page = await full.text();
    expect(page).toContain('<p class="notice"><bdi>&lt;b&gt;Bold&lt;/b&gt; &amp; Co</bdi> has no free seat');
    expect(page).not.toContain("<b>Bold");
  });

  /**
   * The Join's check and its write are one operation in the store, so what the route read before it
   * cannot seat anyone: here the route's own read is held at its stale answer, and the admin's withdrawal
   * has landed in the store between it and the Join.
   */
  it("seats nobody when the invite is withdrawn before the Join, whatever an earlier read said", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const held = heldOf(await res.text());
    const stale = await plans.invitesFor(["github:4242", "github:jesse@example.dev", "email:jesse@example.dev"]);
    expect(await plans.deleteOrgInvite("org_acme", "github:4242", { actorUserId: "u_github_1" })).toBe("deleted");
    plans.invitesFor = async () => stale;
    const after = await answer(held, "join", "org_acme");
    expect(await after.text()).toContain("That invitation is no longer open.");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("refuses an answer with no held sign-in, a forged one, and a choice the page does not offer", async () => {
    await seat(ACME_ADMIN, "github:4242");
    expect((await answer("forged", "join", "org_acme")).status).toBe(400);
    const { res } = await githubCallback();
    expect((await answer(heldOf(await res.text()), "seat-me", "org_acme")).status).toBe(400);
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  /**
   * The held sign-in is spent by its first answer: an answer after it with the same one applies nothing
   * and mints nothing. It follows the first answer to where that left the browser, so a page answered
   * twice ends as it did once.
   */
  it("takes one answer for each page: the same held sign-in a second time applies nothing and mints nothing", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const { clientId, res } = await githubCallback();
    const held = heldOf(await res.text());
    const first = await answer(held, "continue");
    const again = await answer(held, "continue");
    const joined = await answer(held, "join", "org_acme");
    expect([again.status, joined.status]).toEqual([302, 302]);
    expect([again.headers.get("location"), joined.headers.get("location")]).toEqual([first.headers.get("location"), first.headers.get("location")]);
    expect((await redeemed(clientId, first)).identity).toMatchObject({ userId: "u_github_4242", orgId: null });
    expect(await redeemOnce(clientId, again)).toMatchObject({ error: "invalid_grant" });
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    expect(await plans.invitesFor(["github:4242"])).toHaveLength(1);

    await seat(B_ADMIN, "github:4242");
    const twice = heldOf(await (await githubCallback()).res.text());
    const redrawn = await answer(twice, "decline", "org_b");
    expect(redrawn.status).toBe(200);
    expect(heldOf(await redrawn.text())).not.toBe(twice);
    const replayed = await answer(twice, "join", "org_acme");
    expect(replayed.status).toBe(200);
    expect(await replayed.text()).toContain("<strong><bdi>Acme</bdi></strong> invited you");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("binds a panel sign-in's answer to the browser that started it, and keeps the nonce until the end", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const start = await oauth(`/auth/signin?return_to=${encodeURIComponent(`${PANEL}/org`)}`);
    const nonce = /__Host-bellman_signin=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1];
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await start.text())![1]);
    const cookie = `${NONCE_COOKIE}=${nonce}`;
    const page = await oauth(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    const held = heldOf(await page.text());

    const stranger = await answer(held, "join", "org_acme");
    expect(stranger.status).toBe(400);
    expect(await plans.getGrant("github:4242")).toBeUndefined();

    const done = await answer(held, "join", "org_acme", cookie);
    expect([done.status, done.headers.get("location")]).toEqual([302, `${PANEL}/org`]);
    expect(done.headers.get("set-cookie")).toContain(`${NONCE_COOKIE}=;`);
    const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(done.headers.get("set-cookie") ?? "")![1];
    const session = await oauth("/auth/session", { headers: { cookie: `${SESSION_COOKIE}=${sid}`, origin: PANEL } });
    expect(await session.json()).toMatchObject({ user_id: "u_github_4242", org_id: "org_acme", plan: "team" });
  });
});

describe("a seat on an address the org no longer owns by its form (ADR 0027)", () => {
  /** example.dev proven by acme, so its address could be seated without the person, then released. */
  const releasedSeat = async () => {
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    expect((await seat(ACME_ADMIN, "email:jesse@example.dev", "admin")).status).toBe(201);
    expect(await plans.releaseDomain("org_acme", "example.dev", by)).toBe("released");
  };

  it("takes no effect once the domain is released: no org, no claim, and the page offers it", async () => {
    await releasedSeat();
    const { clientId, res } = await githubCallback();
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<strong><bdi>Acme</bdi></strong> invited you to join it as an admin.");
    const { identity } = await redeemed(clientId, await answer(heldOf(page), "continue"));
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    expect(await plans.getGrant("email:jesse@example.dev")).toMatchObject({ orgId: "org_acme", source: "org" });
  });

  it("is claimed onto the subject when the person joins, with the role it was given", async () => {
    await releasedSeat();
    const { identity } = await signIn("join");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: "org_acme", role: "admin", plan: "team" });
    expect(await plans.getGrant("email:jesse@example.dev")).toBeUndefined();
    expect(await plans.getGrant("github:4242")).toMatchObject({ role: "admin", source: "invite", grantedBy: "u_github_1" });
  });

  /** A seat written before invites existed, for an address the org never owned, reads the same way. */
  it("reads an address seat the org never owned as an invite too, on the page and on the roster", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:jesse@example.dev", role: "member", source: "org" }, "org_acme", by);
    const { identity, page } = await signIn("continue");
    expect(page).toContain("<strong><bdi>Acme</bdi></strong> invited you");
    expect(identity).toMatchObject({ orgId: null, plan: "free" });
    const caller = async (): Promise<RoomCaller> => ({ identity: ACME_ADMIN, via: "bearer" });
    const roster = await orgRoutes(new Request(`${ISSUER}/org/members`, { headers: { authorization: "Bearer x" } }), { store: plans, caller, panelOrigins: [PANEL], issuer: ISSUER });
    const members = ((await roster!.json()) as { members: { key: string; status: string }[] }).members;
    expect(members.map((m) => [m.key, m.status])).toEqual([["github:1", "member"], ["email:jesse@example.dev", "invited"]]);
  });

  it("keeps its effect while the org still owns the address", async () => {
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    await seat(ACME_ADMIN, "email:jesse@example.dev");
    const { identity, page } = await signIn();
    expect(page).toBeNull();
    expect(identity).toMatchObject({ orgId: "org_acme", plan: "team" });
    expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_acme", source: "org" });
  });
});

describe("seats that hold nothing, declines, and pages answered twice (ADR 0027)", () => {
  /** Bee seated the address on main, never owning it: the seat holds nothing, here or for a Join elsewhere. */
  it("lets a person another org seated on an address it never owned join the org that invited them", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:jesse@example.dev", role: "member", orgId: "org_b", source: "org" }, "org_b", by);
    await seat(ACME_ADMIN, "github:4242");
    const { clientId, res } = await githubCallback();
    const page = await res.text();
    expect([page.includes("<bdi>Acme</bdi>"), page.includes("<bdi>Bee</bdi>")]).toEqual([true, true]);
    const join = await answer(heldOf(page), "join", "org_acme");
    expect(join.status).toBe(200);
    const after = await join.text();
    expect(after).toContain("You joined <bdi>Acme</bdi>.");
    const { identity } = await redeemed(clientId, await answer(heldOf(after), "continue"));
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: "org_acme", plan: "team" });
    expect(await plans.getGrant("email:jesse@example.dev")).toMatchObject({ orgId: "org_b" });
  });

  it("gives an address to the org that owns it by its form, replacing another org's seat that held nothing", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:jesse@example.dev", role: "admin", orgId: "org_b", source: "org" }, "org_b", by);
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    expect((await seat(ACME_ADMIN, "email:jesse@example.dev")).status).toBe(201);
    expect(await plans.getGrant("email:jesse@example.dev")).toMatchObject({ orgId: "org_acme", source: "org", role: "member" });
    const bee = await plans.auditForOrg("org_b", 20);
    expect(bee.at(-1)).toMatchObject({ action: "plan_revoked", actorUserId: "system", detail: { key: "email:jesse@example.dev" } });
    expect(JSON.stringify(bee)).not.toMatch(/org_acme|u_github_1|ana@acme/);
    expect((await signIn()).identity).toMatchObject({ orgId: "org_acme", plan: "team" });
  });

  it("moves both unowned seats one org holds on a person's addresses, and never answers member for them", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:jesse@example.dev", role: "member", source: "org" }, "org_acme", by);
    await plans.putGrantIfOwned({ ...ownerGrant, key: "github:jesse@example.dev", role: "member", source: "org" }, "org_acme", by);
    const { identity } = await signIn("join");
    expect(identity).toMatchObject({ orgId: "org_acme", plan: "team" });
    expect([await plans.getGrant("email:jesse@example.dev"), await plans.getGrant("github:jesse@example.dev")]).toEqual([undefined, undefined]);
    expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_acme", source: "invite" });
    expect((await signIn()).page).toBeNull();
  });

  /** A decline answers the invites it saw: one the org makes afterwards is a new question, and shows. */
  it("hides only the invites a decline answered, and shows one made after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await seat(ACME_ADMIN, "github:4242");
      expect((await signIn("decline")).page).toContain("Acme");
      expect((await signIn()).page).toBeNull();
      expect(await plans.deleteOrgInvite("org_acme", "github:4242", { actorUserId: "u_github_1" })).toBe("deleted");
      vi.setSystemTime(Date.now() + 60_000);
      expect((await seat(ACME_ADMIN, "github:4242", "admin")).status).toBe(202);
      const { res } = await githubCallback();
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<strong><bdi>Acme</bdi></strong> invited you to join it as an admin.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a name stored as Hangul fillers as the org's id", async () => {
    await plans.updateOrg("org_acme", { name: "\u3164\u3164\u3164" }, by);
    await seat(ACME_ADMIN, "github:4242");
    const page = await (await githubCallback()).res.text();
    expect(page).toContain("<strong><bdi>org_acme</bdi></strong> invited you");
  });

  /** A browser shows the response to the last press, so each press must lead to the one code the first Join minted. */
  it("completes a sign-in once when Join is pressed twice: one grant, one code, and both presses lead to it", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const { clientId, res } = await githubCallback();
    const held = heldOf(await res.text());
    const presses = await Promise.all([answer(held, "join", "org_acme"), answer(held, "join", "org_acme")]);
    const ends = await Promise.all(presses.map(async (press) => (press.status === 302 ? press : answer(heldOf(await press.text()), "continue"))));
    const [one, two] = ends.map((end) => end.headers.get("location"));
    expect(one).toContain("code=");
    expect(two).toBe(one);
    expect((await redeemed(clientId, ends[0])).identity).toMatchObject({ userId: "u_github_4242", orgId: "org_acme" });
    expect(await redeemOnce(clientId, ends[1])).toMatchObject({ error: "invalid_grant" });
    expect((await plans.auditForOrg("org_acme", 50)).filter((e) => e.action === "plan_granted" && e.actorUserId === "u_github_4242")).toHaveLength(1);
  });

  it("follows a panel sign-in's first answer only with its nonce cookie, and gives nobody else its session", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const start = await oauth(`/auth/signin?return_to=${encodeURIComponent(`${PANEL}/org`)}`);
    const nonce = /__Host-bellman_signin=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1];
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await start.text())![1]);
    const cookie = `${NONCE_COOKIE}=${nonce}`;
    const held = heldOf(await (await oauth(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`, { headers: { cookie } })).text());
    const first = await answer(held, "join", "org_acme", cookie);
    expect(first.status).toBe(302);
    const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(first.headers.get("set-cookie") ?? "")![1];
    const second = await answer(held, "join", "org_acme", cookie);
    expect([second.status, second.headers.get("location")]).toEqual([302, `${PANEL}/org`]);
    expect(second.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=${sid}`);
    const stranger = await answer(held, "join", "org_acme");
    expect(stranger.status).toBe(400);
    expect(stranger.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);
    const forged = await answer("forged", "join", "org_acme", cookie);
    expect([forged.status, forged.headers.get("set-cookie")]).toEqual([400, null]);
  });

  it("ends a held sign-in ten minutes after the provider's exchange, however often the page is drawn again", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    let held = heldOf(await res.text());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const redraw = await answer(held, "decline", "org_none");
      expect(redraw.status).toBe(200);
      held = heldOf(await redraw.text());
      vi.setSystemTime(Date.now() + 5 * 60_000);
      const late = await answer(held, "continue");
      expect(late.status).toBe(400);
      expect(await late.text()).toContain("This sign-in link expired");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A seat an org's identity provider pushes (ADR 0029) is an admin's seat by another door: for an address the
 * org does not own by its form it takes effect only when the person accepts it, and a deprovision still
 * ends it once they have.
 */
describe("a seat the org's identity provider pushes (ADR 0027, ADR 0029)", () => {
  const TOKENS = { org_acme: "bst_seat-consent-acme", org_b: "bst_seat-consent-bee" } as const;
  beforeEach(async () => {
    for (const [orgId, token] of Object.entries(TOKENS)) {
      await plans.issueScimToken(orgId, { tokenHash: await sha256Base64url(token), issuedAt: 2, issuedBy: "u_op" }, { actorUserId: "u_op" });
    }
  });
  const scim = async (orgId: keyof typeof TOKENS, path: string, method: string, body?: unknown) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return (await scimRoutes(new Request(`${ISSUER}${path}`, {
      method, body: text,
      headers: { authorization: `Bearer ${TOKENS[orgId]}`, "content-type": SCIM_JSON, ...(text ? { "content-length": String(text.length) } : {}) },
    }), { store: plans }))!;
  };
  const push = async (userName: string, orgId: keyof typeof TOKENS = "org_acme") =>
    (await (await scim(orgId, "/scim/v2/Users", "POST", { schemas: [USER_SCHEMA], userName })).json()) as { id: string };
  const setActive = (id: string, active: boolean, orgId: keyof typeof TOKENS = "org_acme") =>
    scim(orgId, `/scim/v2/Users/${id}`, "PATCH", { schemas: [PATCH_SCHEMA], Operations: [{ op: "replace", value: { active } }] });
  const deactivate = (id: string, orgId: keyof typeof TOKENS = "org_acme") => setActive(id, false, orgId);
  /** A person who joined through a pushed seat on an address Acme does not own, then was deprovisioned. */
  const joinedThenDeprovisioned = async () => {
    const { id } = await push("jesse@example.dev");
    expect((await signIn("join")).identity).toMatchObject({ orgId: "org_acme" });
    expect((await deactivate(id)).status).toBe(200);
    expect((await signIn()).identity).toMatchObject({ orgId: null });
    return id;
  };

  it("takes no effect for an address the org does not own by its form: the sign-in stays free, and the page offers it", async () => {
    await push("jesse@example.dev");
    expect(await plans.getGrant("email:jesse@example.dev")).toMatchObject({ orgId: "org_acme", source: "scim" });
    const { identity, page } = await signIn("continue");
    expect(page).toContain("<strong><bdi>Acme</bdi></strong> invited you to join it as a member.");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("is the IdP's to end once the person has joined: a deprovision takes the seat", async () => {
    const { id } = await push("jesse@example.dev");
    const joined = await signIn("join");
    expect(joined.page).toContain("<bdi>Acme</bdi>");
    expect(joined.identity).toMatchObject({ orgId: "org_acme", plan: "team" });
    expect(await plans.scimUserByKey("github:4242")).toMatchObject({ id, key: "github:4242" });
    expect((await deactivate(id)).status).toBe(200);
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    expect((await signIn()).identity).toMatchObject({ orgId: null, plan: "free" });
  });

  it("takes effect at once for an address on a domain the org verified, as before", async () => {
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    await push("jesse@example.dev");
    const { identity, page } = await signIn();
    expect(page).toBeNull();
    expect(identity).toMatchObject({ orgId: "org_acme", plan: "team" });
  });

  it("offers a reactivated seat again rather than restoring it on the account the person joined with", async () => {
    const id = await joinedThenDeprovisioned();
    expect((await setActive(id, true)).status).toBe(200);
    const again = await signIn("continue");
    expect(again.page).toContain("<strong><bdi>Acme</bdi></strong> invited you");
    expect(again.identity).toMatchObject({ orgId: null, plan: "free" });
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("offers a re-push after a delete again rather than seating the account the person joined with", async () => {
    const { id } = await push("jesse@example.dev");
    expect((await signIn("join")).identity).toMatchObject({ orgId: "org_acme" });
    expect((await scim("org_acme", `/scim/v2/Users/${id}`, "DELETE")).status).toBe(204);
    expect((await scim("org_acme", "/scim/v2/Users", "POST", { schemas: [USER_SCHEMA], userName: "jesse@example.dev" })).status).toBe(201);
    const again = await signIn("continue");
    expect(again.page).toContain("<strong><bdi>Acme</bdi></strong> invited you");
    expect(again.identity).toMatchObject({ orgId: null, plan: "free" });
  });

  it("leaves a former member's own sign-in open when the IdP reactivates them with single sign-on required", async () => {
    const id = await joinedThenDeprovisioned();
    await plans.claimDomain("org_acme", "acme.test", "tok", 1, by);
    await plans.verifyDomain("org_acme", "acme.test", 2, by);
    await plans.putOrgIdp("org_acme", {
      protocol: "oidc", issuer: "https://idp.test", clientId: "0oa", clientSecret: await seal("test-seal-secret", "shh"), tokenAuth: "client_secret_basic",
      authorizationEndpoint: "https://idp.test/authorize", tokenEndpoint: "https://idp.test/token", userinfoEndpoint: null, configuredAt: 3, configuredBy: "u_github_1",
    }, by);
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    expect((await setActive(id, true)).status).toBe(200);
    const after = await signIn("continue");
    expect(after.page).toContain("<strong><bdi>Acme</bdi></strong> invited you");
    expect(after.target.searchParams.get("error")).toBeNull();
    expect(after.identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
  });

  /** The IdP names the user: renamed onto a domain Acme owns and reactivated, the person is still not its to seat. */
  it("seats no former member's account when the IdP renames them onto an owned domain and reactivates, with single sign-on required", async () => {
    const id = await joinedThenDeprovisioned();
    await plans.claimDomain("org_acme", "acme.test", "tok", 1, by);
    await plans.verifyDomain("org_acme", "acme.test", 2, by);
    await plans.putOrgIdp("org_acme", {
      protocol: "oidc", issuer: "https://idp.test", clientId: "0oa", clientSecret: await seal("test-seal-secret", "shh"), tokenAuth: "client_secret_basic",
      authorizationEndpoint: "https://idp.test/authorize", tokenEndpoint: "https://idp.test/token", userinfoEndpoint: null, configuredAt: 3, configuredBy: "u_github_1",
    }, by);
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    const renamed = await scim("org_acme", `/scim/v2/Users/${id}`, "PATCH", {
      schemas: [PATCH_SCHEMA], Operations: [{ op: "replace", value: { userName: "jesse@acme.test", active: true } }],
    });
    expect(renamed.status).toBe(200);
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    const after = await signIn();
    expect(after.target.searchParams.get("error")).toBeNull();
    expect(after.identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
  });

  /** A deprovision froze the org's rooms of a personal account that its owned address linked; the reactivation thaws them. */
  it("thaws the rooms a deprovision froze at a reactivation, though the seat goes back on the address", async () => {
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    const { id } = await push("jesse@example.dev");
    expect((await signIn()).identity).toMatchObject({ orgId: "org_acme" });
    const room = "qs_jesse_org";
    const seated = (memberId: string, userId: string, roomRole: string) => seatOf({ memberId, userId, label: userId, orgId: "org_acme", roomRole });
    await plans.createSession(session({
      id: room, createdBy: "u_github_4242", orgId: "org_acme", members: [seated("m_jesse", "u_github_4242", "peer_a"), seated("m_ana", "u_github_1", "peer_b")],
    }));
    expect((await deactivate(id)).status).toBe(200);
    expect((await plans.getSession(room))?.frozenAt).not.toBeNull();
    expect((await setActive(id, true)).status).toBe(200);
    expect((await plans.getSession(room))?.frozenAt).toBeNull();
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    expect((await signIn()).identity).toMatchObject({ orgId: "org_acme", plan: "team" });
  });

  /** The domain's owner takes the address from another org's pushed seat; that org's IdP keeps no hold on the person it never seated. */
  it("leaves another org's IdP no hold on an address the domain's owner takes", async () => {
    const bee = await push("jesse@example.dev", "org_b");
    await plans.claimDomain("org_acme", "example.dev", "tok", 1, by);
    await plans.verifyDomain("org_acme", "example.dev", 2, by);
    expect((await seat(ACME_ADMIN, "email:jesse@example.dev")).status).toBe(201);
    expect((await signIn()).identity).toMatchObject({ orgId: "org_acme" });
    expect(await plans.scimUserByKey("github:4242")).toBeUndefined();
    expect((await deactivate(bee.id, "org_b")).status).toBe(200);
    expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_acme", source: "org" });
  });
});

describe("require_sso and an invite (ADR 0027, SSO spec D13)", () => {
  beforeEach(async () => {
    await plans.claimDomain("org_acme", "acme.test", "tok", 1, by);
    await plans.verifyDomain("org_acme", "acme.test", 2, by);
    await plans.putOrgIdp("org_acme", {
      protocol: "oidc", issuer: "https://idp.test", clientId: "0oa", clientSecret: await seal("test-seal-secret", "shh"), tokenAuth: "client_secret_basic",
      authorizationEndpoint: "https://idp.test/authorize", tokenEndpoint: "https://idp.test/token", userinfoEndpoint: null, configuredAt: 3, configuredBy: "u_github_1",
    }, by);
  });

  it("does not refuse a sign-in an org only invited, and will not seat it into an org that requires SSO", async () => {
    await seat(ACME_ADMIN, "github:4242");
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    const { res, clientId } = await githubCallback();
    expect(res.status).toBe(200);
    const join = await answer(heldOf(await res.text()), "join", "org_acme");
    const page = await join.text();
    expect(page).toContain("<bdi>Acme</bdi> requires single sign-on: to join it, start again and enter your work email.");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    const { identity } = await redeemed(clientId, await answer(heldOf(page), "continue"));
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
  });

  it("refuses the sign-in once the person has accepted the seat", async () => {
    await seat(ACME_ADMIN, "github:4242");
    expect((await signIn("join")).identity).toMatchObject({ orgId: "org_acme" });
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    const { identity, target } = await signIn();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error_description")).toContain("Acme requires single sign-on");
  });
});

describe("the rooms an org sat in (ADR 0027)", () => {
  /** A room the signed-in person starts and leaves, so it closes: what the admin's list and read look for. */
  async function closedRoomOf(identity: Identity): Promise<string> {
    const peer = await harness.connectAs(identity);
    const started = await peer.call("bellman_start", { manifest: manifestFixture(), brief: brief(), capabilities: ["read_context"] });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const left = await peer.call("bellman_leave", { session_id: sessionId, member_id: String(started.data.member_id) });
    expect(left.isError, left.text).toBe(false);
    return sessionId;
  }

  const adminList = async () => {
    const caller = async (): Promise<RoomCaller> => ({ identity: ACME_ADMIN, via: "bearer" });
    const res = (await roomRoutes(new Request(`${ISSUER}/rooms?as=admin`, { headers: { authorization: "Bearer x" } }), {
      store: plans, blobs: new MemoryBlobStore(), caller, panelOrigins: [PANEL],
    }))!;
    return ((await res.json()) as { rooms: { id: string }[] }).rooms.map((r) => r.id);
  };

  it("writes no record of a room an invited person sits in, and lists none of theirs to the admin, until they join", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const invited = (await signIn("continue")).identity!;
    expect(invited.orgId).toBeNull();
    const before = await closedRoomOf(invited);
    expect((await plans.getSession(before))?.orgs).toEqual([]);
    expect(await plans.sessionsForOrg("org_acme", 50)).toEqual([]);
    expect(await adminList()).toEqual([]);

    const member = (await signIn("join")).identity!;
    expect(member.orgId).toBe("org_acme");
    const after = await closedRoomOf(member);
    expect(await plans.sessionsForOrg("org_acme", 50)).toEqual([after]);
    expect(await adminList()).toEqual([after]);
  });
});
