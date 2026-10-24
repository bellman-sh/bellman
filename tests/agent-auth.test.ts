import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AGENT_CODE_TTL_MS,
  AGENT_REGS_PER_HOUR,
  AGENT_UNCLAIMED_CAP,
  AGENT_POLL_INTERVAL_MS,
  AGENT_REGISTRATION_TTL_MS,
  type AgentClaimed,
  type AgentRegistration,
  decideApprove,
  decidePoll,
  decideReissue,
  emailKey,
  newAttempt,
  newUserCode,
} from "../src/oauth/agent-auth.js";
import { MemoryAuthStore, REGISTRATION_WINDOW_MS } from "../src/oauth/storage.js";
import { REFRESH_TOKEN_TTL_MS, signJwt } from "../src/oauth/tokens.js";
import { identityFromAccessToken } from "../src/oauth/routes.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { IDENTITY, ISSUER, panelConfig, routeWith, seedSession, withCookie } from "./helpers/panel.js";

const CLAIMED: AgentClaimed = {
  identity: IDENTITY,
  plan_source: "default",
  plan_key: null,
  identity_keys: ["github:4242", "email:jesse@example.dev"],
};

function reg(now: number): AgentRegistration {
  return {
    registration_id: "reg_x",
    login_hint: "jesse@example.dev",
    created_at: now,
    expires_at: now + AGENT_REGISTRATION_TTL_MS,
    last_poll_at: null,
    attempt: { attempt_token: "att", attempt_id: "cla_x", user_code: "123456", expires_at: now + AGENT_CODE_TTL_MS, failures: 0 },
    claimed: null,
  };
}

describe("agent-auth decisions", () => {
  test("newUserCode is six digits", () => {
    for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(/^\d{6}$/);
  });

  test("emailKey trims and lowercases", () => {
    expect(emailKey(" Jesse@Example.dev ")).toBe("email:jesse@example.dev");
  });

  test("decidePoll order", () => {
    const t = 1_000_000;
    expect(decidePoll(undefined, t)).toEqual({ kind: "unknown" });
    expect(decidePoll(reg(t), t + AGENT_REGISTRATION_TTL_MS + 1)).toEqual({ kind: "expired" });
    // A granted poll is not made to wait out the interval.
    expect(decidePoll({ ...reg(t), claimed: CLAIMED, last_poll_at: t }, t + 1)).toMatchObject({ kind: "granted", registration_id: "reg_x", claimed: CLAIMED });
    expect(decidePoll({ ...reg(t), last_poll_at: t }, t + AGENT_POLL_INTERVAL_MS - 1)).toEqual({ kind: "slow_down" });
    expect(decidePoll(reg(t), t + AGENT_CODE_TTL_MS + 1)).toEqual({ kind: "expired" });
    expect(decidePoll(reg(t), t + 1)).toEqual({ kind: "pending" });
  });

  test("decideApprove order", () => {
    const t = 1_000_000;
    const ok = ["github:1", "email:jesse@example.dev"];
    const failed = (failures: number) => ({ ...reg(t), attempt: { ...reg(t).attempt, failures } });
    expect(decideApprove(undefined, "att", "123456", ok, t)).toEqual({ kind: "unknown" });
    expect(decideApprove(reg(t), "older", "123456", ok, t)).toEqual({ kind: "code_expired" });
    expect(decideApprove(reg(t), "att", "123456", ok, t + AGENT_REGISTRATION_TTL_MS + 1)).toEqual({ kind: "reg_expired" });
    expect(decideApprove({ ...reg(t), claimed: CLAIMED }, "att", "123456", ok, t)).toEqual({ kind: "already" });
    expect(decideApprove(reg(t), "att", "123456", ok, t + AGENT_CODE_TTL_MS + 1)).toEqual({ kind: "code_expired" });
    // The account is checked before the code, so a wrong account burns no tries.
    expect(decideApprove(reg(t), "att", "000000", ["github:1"], t)).toEqual({ kind: "wrong_account" });
    expect(decideApprove(reg(t), "att", "000000", ok, t)).toEqual({ kind: "wrong_code", left: 4 });
    expect(decideApprove(failed(4), "att", "000000", ok, t)).toEqual({ kind: "dead" });
    expect(decideApprove(failed(5), "att", "123456", ok, t)).toEqual({ kind: "code_expired" });
    expect(decideApprove(reg(t), "att", "123456", ok, t)).toEqual({ kind: "approved" });
  });

  test("decideReissue", () => {
    const t = 1_000_000;
    expect(decideReissue(undefined, "jesse@example.dev", t)).toBe("unknown");
    expect(decideReissue(reg(t), "jesse@example.dev", t + AGENT_REGISTRATION_TTL_MS + 1)).toBe("expired");
    expect(decideReissue({ ...reg(t), claimed: CLAIMED }, "jesse@example.dev", t)).toBe("claimed");
    expect(decideReissue(reg(t), "other@example.dev", t)).toBe("mismatch");
    expect(decideReissue(reg(t), " JESSE@example.dev", t)).toBe("ok");
  });
});

describe("agent-auth storage", () => {
  const t = 1_800_000_000_000;

  function fresh(i: number, now = t): AgentRegistration {
    return {
      registration_id: `reg_${i}`,
      login_hint: "jesse@example.dev",
      created_at: now,
      expires_at: now + AGENT_REGISTRATION_TTL_MS,
      last_poll_at: null,
      attempt: newAttempt(now),
      claimed: null,
    };
  }

  /**
   * Up to the cap through the public method, spread over enough addresses that the
   * per-IP limit never answers: the cap, not one address's allowance, is under test.
   */
  async function fill(store: MemoryAuthStore, n: number) {
    for (let i = 0; i < n; i++) {
      const ip = `10.0.${Math.floor(i / AGENT_REGS_PER_HOUR)}`;
      expect(await store.admitAgentRegistration(`clm_${i}`, fresh(i), ip, t)).toBe("ok");
    }
  }

  test("admits 20 per hour per IP then rate_limited", async () => {
    const store = new MemoryAuthStore();
    for (let i = 0; i < AGENT_REGS_PER_HOUR; i++) {
      expect(await store.admitAgentRegistration(`clm_${i}`, fresh(i), "1.1.1.1", t)).toBe("ok");
    }
    expect(await store.admitAgentRegistration("clm_over", fresh(99), "1.1.1.1", t)).toBe("rate_limited");
    expect(await store.admitAgentRegistration("clm_other", fresh(98), "2.2.2.2", t)).toBe("ok");
    const later = t + REGISTRATION_WINDOW_MS + 1;
    expect(await store.admitAgentRegistration("clm_later", fresh(97, later), "1.1.1.1", later)).toBe("ok");
  });

  test("unclaimed cap answers full", async () => {
    const store = new MemoryAuthStore();
    await fill(store, AGENT_UNCLAIMED_CAP);
    expect(await store.admitAgentRegistration("clm_full", fresh(-1), "9.9.9.9", t)).toBe("full");
  });

  test("granted poll spends the registration once", async () => {
    const store = new MemoryAuthStore();
    await fill(store, AGENT_UNCLAIMED_CAP);
    expect(await store.readAgentAttempt("missing", t)).toBeNull();
    expect(await store.pollAgentClaim("clm_0", t)).toEqual({ kind: "pending" });

    // fill() kept no handle on clm_0's attempt; a reissue hands one back.
    const stored = await store.reissueAgentCode("clm_0", "jesse@example.dev", t);
    expect(stored.verdict).toBe("ok");
    const attempt = stored.reg!.attempt;
    expect(await store.readAgentAttempt(attempt.attempt_token, t)).toMatchObject({ registration_id: "reg_0" });

    expect(await store.approveAgentClaim(attempt.attempt_token, attempt.user_code, CLAIMED, t)).toEqual({ kind: "approved" });
    const granted = await store.pollAgentClaim("clm_0", t + 1);
    expect(granted).toMatchObject({ kind: "granted", registration_id: "reg_0", claimed: CLAIMED });
    expect(await store.pollAgentClaim("clm_0", t + 2)).toEqual({ kind: "unknown" });
    expect(await store.readAgentAttempt(attempt.attempt_token, t + 2)).toBeNull();

    expect(await store.getAgentGrant("reg_0", t + 2)).toEqual({ ...CLAIMED, expires_at: t + 1 + REFRESH_TOKEN_TTL_MS });
    // The grant took its registration out of the unclaimed count.
    expect(await store.admitAgentRegistration("clm_next", fresh(-1), "9.9.9.9", t)).toBe("ok");
  });

  test("a reissued code retires the old attempt", async () => {
    const store = new MemoryAuthStore();
    const reg = fresh(1);
    await store.admitAgentRegistration("clm_1", reg, "1.1.1.1", t);
    const { verdict, reg: next } = await store.reissueAgentCode("clm_1", "JESSE@example.dev ", t);
    expect(verdict).toBe("ok");
    expect(next!.attempt.attempt_token).not.toBe(reg.attempt.attempt_token);
    expect(await store.readAgentAttempt(reg.attempt.attempt_token, t)).toBeNull();
    expect(await store.reissueAgentCode("clm_1", "someone@else.dev", t)).toEqual({ verdict: "mismatch" });
  });

  test("wrong codes count and the fifth kills the attempt", async () => {
    const store = new MemoryAuthStore();
    const reg = fresh(1);
    await store.admitAgentRegistration("clm_1", reg, "1.1.1.1", t);
    const tok = reg.attempt.attempt_token;
    const wrong = reg.attempt.user_code === "000000" ? "111111" : "000000";
    for (const left of [4, 3, 2, 1]) {
      expect(await store.approveAgentClaim(tok, wrong, CLAIMED, t)).toEqual({ kind: "wrong_code", left });
    }
    expect(await store.approveAgentClaim(tok, wrong, CLAIMED, t)).toEqual({ kind: "dead" });
    expect(await store.approveAgentClaim(tok, reg.attempt.user_code, CLAIMED, t)).toEqual({ kind: "unknown" });
    expect(await store.pollAgentClaim("clm_1", t)).toEqual({ kind: "expired" });
  });

  test("purgeStale reclaims expired registrations and frees the cap", async () => {
    const store = new MemoryAuthStore();
    await store.admitAgentRegistration("clm_1", fresh(1), "1.1.1.1", t);
    const later = t + AGENT_REGISTRATION_TTL_MS + 1;
    expect(await store.purgeStale(later)).toMatchObject({ agent: 2, complete: true });
    expect(await store.pollAgentClaim("clm_1", later)).toEqual({ kind: "unknown" });

    const full = new MemoryAuthStore();
    await fill(full, AGENT_UNCLAIMED_CAP);
    await full.purgeStale(later);
    expect(await full.admitAgentRegistration("clm_next", fresh(-1, later), "9.9.9.9", later)).toBe("ok");
  });

  test("getAgentGrant is null after expiry and after delete", async () => {
    const store = new MemoryAuthStore();
    const reg = fresh(1);
    await store.admitAgentRegistration("clm_1", reg, "1.1.1.1", t);
    await store.approveAgentClaim(reg.attempt.attempt_token, reg.attempt.user_code, CLAIMED, t);
    await store.pollAgentClaim("clm_1", t);
    expect(await store.getAgentGrant("reg_1", t)).not.toBeNull();
    expect(await store.getAgentGrant("reg_1", t + REFRESH_TOKEN_TTL_MS + 1)).toBeNull();
    await store.deleteAgentGrant("reg_1");
    expect(await store.getAgentGrant("reg_1", t)).toBeNull();
  });
});

describe("agent registration endpoints", () => {
  const setup = () => {
    const config = panelConfig();
    const route = routeWith(config);
    const post = (path: string, body: unknown, ip = "203.0.113.9") =>
      route(
        new Request(`${ISSUER}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })
      );
    const register = (hint: unknown = "jesse@example.dev", ip?: string) =>
      post("/agent/identity", { type: "service_auth", login_hint: hint }, ip);
    return { config, route, post, register };
  };
  const body = async (res: Response) => (await res.json()) as Record<string, any>;

  test("metadata carries agent_auth", async () => {
    const { route } = setup();
    const meta = await body(await route(new Request(`${ISSUER}/.well-known/oauth-authorization-server`)));
    expect(meta.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "urn:workos:agent-auth:grant-type:claim",
    ]);
    expect(meta.agent_auth).toEqual({
      skill: "https://bellman.sh/auth.md",
      identity_endpoint: `${ISSUER}/agent/identity`,
      claim_endpoint: `${ISSUER}/agent/identity/claim`,
      register_uri: `${ISSUER}/agent/identity`,
      claim_uri: `${ISSUER}/agent/identity/claim`,
      identity_types_supported: ["service_auth"],
    });
  });

  test("anonymous and identity_assertion are not enabled", async () => {
    const { post } = setup();
    const anon = await post("/agent/identity", { type: "anonymous" });
    expect(anon.status).toBe(400);
    expect((await body(anon)).error).toBe("anonymous_not_enabled");
    const asserted = await post("/agent/identity", { type: "identity_assertion" });
    expect(asserted.status).toBe(400);
    expect((await body(asserted)).error).toBe("issuer_not_enabled");
  });

  test("a bad body is invalid_request", async () => {
    const { post, register, route } = setup();
    for (const res of [
      await post("/agent/identity", "not json"),
      await post("/agent/identity", "[]"),
      await post("/agent/identity", { type: "service_auth" }),
      await post("/agent/identity", { type: "bogus", login_hint: "jesse@example.dev" }),
      await register("no-at-sign"),
      await register("a@b@c"),
      await register("@example.dev"),
      await register(`${"a".repeat(250)}@x.dev`),
    ]) {
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe("invalid_request");
    }
    const get = await route(new Request(`${ISSUER}/agent/identity`));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  test("login_hint is trimmed and lowercased", async () => {
    const { post, register } = setup();
    const reg = await body(await register(" Jesse@Example.dev "));
    const res = await post("/agent/identity/claim", { claim_token: reg.claim_token, email: "jesse@example.dev" });
    expect(res.status).toBe(200);
  });

  test("registration response shape", async () => {
    const { register } = setup();
    const res = await register();
    expect(res.status).toBe(200);
    const reg = await body(res);
    expect(reg.registration_id).toMatch(/^reg_/);
    expect(reg.registration_type).toBe("service_auth");
    expect(reg.claim_url).toBe(`${ISSUER}/agent/identity/claim`);
    expect(reg.claim_token).toMatch(/^clm_/);
    expect(Date.parse(reg.claim_token_expires)).toBeGreaterThan(Date.now() + AGENT_REGISTRATION_TTL_MS - 60_000);
    expect(reg.post_claim_scopes).toEqual(["bellman"]);
    expect(reg.claim.user_code).toMatch(/^\d{6}$/);
    expect(reg.claim.verification_uri.startsWith(`${ISSUER}/agent/claim?claim_attempt_token=`)).toBe(true);
    expect(reg.claim.expires_in).toBe(600);
    expect(reg.claim.interval).toBe(5);
  });

  test("reissue errors", async () => {
    const { config, post, register } = setup();
    const claim = (claim_token: unknown, email: unknown = "jesse@example.dev") =>
      post("/agent/identity/claim", { claim_token, email });

    const unknown = await claim("clm_nope");
    expect(unknown.status).toBe(400);
    expect((await body(unknown)).error).toBe("invalid_claim_token");

    const reg = await body(await register());
    const mismatch = await claim(reg.claim_token, "someone@else.dev");
    expect(mismatch.status).toBe(400);
    expect((await body(mismatch)).error).toBe("invalid_request");
    const missing = await post("/agent/identity/claim", { claim_token: reg.claim_token });
    expect((await body(missing)).error).toBe("invalid_request");

    const token = new URL(reg.claim.verification_uri).searchParams.get("claim_attempt_token")!;
    expect((await config.store.approveAgentClaim(token, reg.claim.user_code, CLAIMED, Date.now())).kind).toBe("approved");
    const claimed = await claim(reg.claim_token);
    expect(claimed.status).toBe(400);
    expect((await body(claimed)).error).toBe("claimed_or_in_flight");

    const later = await body(await register());
    const real = Date.now;
    Date.now = () => real() + AGENT_REGISTRATION_TTL_MS + 1;
    try {
      const expired = await claim(later.claim_token);
      expect(expired.status).toBe(410);
      expect((await body(expired)).error).toBe("claim_expired");
    } finally {
      Date.now = real;
    }
  });

  test("reissue mints a new code and only it works", async () => {
    const { config, post, register } = setup();
    const reg = await body(await register());
    const res = await post("/agent/identity/claim", { claim_token: reg.claim_token, email: "jesse@example.dev" });
    expect(res.status).toBe(200);
    const again = await body(res);
    expect(again.registration_id).toBe(reg.registration_id);
    expect(again.claim_attempt_id).toMatch(/^cla_/);
    expect(again.status).toBe("initiated");
    expect(again.expires_at).toBe(reg.claim_token_expires);
    expect(again.claim_attempt.user_code).toMatch(/^\d{6}$/);
    expect(again.claim_attempt.expires_in).toBe(600);
    expect(again.claim_attempt.interval).toBe(5);
    const token = (uri: string) => new URL(uri).searchParams.get("claim_attempt_token")!;
    expect(await config.store.readAgentAttempt(token(reg.claim.verification_uri), Date.now())).toBeNull();
    expect(await config.store.readAgentAttempt(token(again.claim_attempt.verification_uri), Date.now())).not.toBeNull();
  });

  test("the 21st registration from one IP is 429", async () => {
    const { register } = setup();
    for (let i = 0; i < AGENT_REGS_PER_HOUR; i++) expect((await register()).status).toBe(200);
    const res = await register();
    expect(res.status).toBe(429);
    expect((await body(res)).error).toBe("rate_limited");
    expect((await register("jesse@example.dev", "198.51.100.1")).status).toBe(200);
  });
});

describe("claim page", () => {
  const KEYS = ["github:4242", "email:jesse@example.dev"];
  const setup = async (keys = KEYS, label = IDENTITY.label) => {
    const config = panelConfig();
    const route = routeWith(config);
    const sid = await seedSession(config, "sid", { identity: { ...IDENTITY, label }, identity_keys: keys });
    const registered = (await (
      await route(
        new Request(`${ISSUER}/agent/identity`, {
          method: "POST",
          body: JSON.stringify({ type: "service_auth", login_hint: "jesse@example.dev" }),
        })
      )
    ).json()) as Record<string, any>;
    const page = new URL(registered.claim.verification_uri);
    const pagePath = page.pathname + page.search;
    const open = async (id = sid, path = pagePath) => route(withCookie(path, id));
    const submit = (held: string, code: string, id = sid) =>
      route(
        withCookie("/agent/claim", id, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ held, code }).toString(),
        })
      );
    return { config, route, sid, registered, pagePath, open, submit };
  };
  const heldIn = async (res: Response) => /name="held" value="([^"]+)"/.exec(await res.text())![1];
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  test("signed-out GET redirects to sign-in", async () => {
    const { route, pagePath } = await setup();
    const res = await route(new Request(`${ISSUER}${pagePath}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/signin?return_to=${encodeURIComponent(`${ISSUER}${pagePath}`)}`);
  });

  test("return_to round-trips to the claim page", async () => {
    const { route } = await setup();
    const sealed = async (returnTo: string) => {
      const chooser = await route(new Request(`${ISSUER}/auth/signin?return_to=${encodeURIComponent(returnTo)}`));
      const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);
      const payload = JSON.parse(Buffer.from(req.split(".")[1], "base64url").toString());
      return payload.bellman.return_to as string;
    };
    expect(await sealed(`${ISSUER}/agent/claim?claim_attempt_token=x`)).toBe(`${ISSUER}/agent/claim?claim_attempt_token=x`);
    for (const refused of [`${ISSUER}/agent/claimx`, `${ISSUER}/agent/identity`, `${ISSUER}/token`]) {
      expect(await sealed(refused)).not.toBe(refused);
    }
  });

  test("the page escapes the label and states the grant", async () => {
    const { open } = await setup(KEYS, "<script>x</script>");
    const res = await open();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<h1>Approve an agent?</h1>");
    expect(text).toContain("Signed in as <b>&lt;script&gt;x&lt;/script&gt;</b>.");
    expect(text).not.toContain("<script>x");
    expect(text).toContain("for 30 days or until an operator removes it");
    expect(text).toContain('autocomplete="one-time-code"');
    expect(text).toContain("Not you?");
  });

  test("full ceremony", async () => {
    const { config, registered, open, submit } = await setup();
    const res = await submit(await heldIn(await open()), registered.claim.user_code);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Approved. Your agent can continue.");
    const poll = await config.store.pollAgentClaim(registered.claim_token, Date.now());
    expect(poll.kind).toBe("granted");
  });

  test("wrong code then right code approves", async () => {
    const { registered, open, submit } = await setup();
    const miss = await submit(await heldIn(await open()), wrong(registered.claim.user_code));
    const text = await miss.text();
    expect(text).toContain("That code didn't match. You have 4 tries left.");
    const held = /name="held" value="([^"]+)"/.exec(text)![1];
    expect(await (await submit(held, registered.claim.user_code)).text()).toContain("Approved.");
  });

  test("five wrong codes kill the attempt", async () => {
    const { registered, open, submit } = await setup();
    let held = await heldIn(await open());
    for (let i = 4; i >= 1; i--) {
      const text = await (await submit(held, wrong(registered.claim.user_code))).text();
      expect(text).toContain(`You have ${i} ${i === 1 ? "try" : "tries"} left.`);
      held = /name="held" value="([^"]+)"/.exec(text)![1];
    }
    expect(await (await submit(held, wrong(registered.claim.user_code))).text()).toContain("that was the last try");
    expect(await (await open()).text()).toContain("This code has expired. Ask your agent for a new one.");
  });

  test("a superseded attempt answers code expired", async () => {
    const { config, route, registered, open, submit } = await setup();
    const held = await heldIn(await open());
    const again = (await (
      await route(
        new Request(`${ISSUER}/agent/identity/claim`, {
          method: "POST",
          body: JSON.stringify({ claim_token: registered.claim_token, email: "jesse@example.dev" }),
        })
      )
    ).json()) as Record<string, any>;
    expect(await (await submit(held, registered.claim.user_code)).text()).toContain("This code has expired.");
    const token = new URL(again.claim_attempt.verification_uri).searchParams.get("claim_attempt_token")!;
    expect((await config.store.readAgentAttempt(token, Date.now()))!.attempt.failures).toBe(0);
  });

  test("the wrong account is refused", async () => {
    const { registered, open, submit } = await setup(["github:4242", "email:other@example.dev"], "other@example.dev");
    const text = await (await submit(await heldIn(await open()), registered.claim.user_code)).text();
    expect(text).toContain("This request is for a different account.");
    expect(text).not.toContain("jesse@example.dev");
  });

  test("a GitHub session with no email key is refused", async () => {
    const { registered, open, submit } = await setup(["github:4242"], "octocat");
    expect(await (await submit(await heldIn(await open()), registered.claim.user_code)).text()).toContain(
      "This request is for a different account."
    );
  });

  test("a replayed held is refused", async () => {
    const { registered, open, submit } = await setup();
    const held = await heldIn(await open());
    await submit(held, wrong(registered.claim.user_code));
    const res = await submit(held, registered.claim.user_code);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This form was already used. Open the link from your agent again.");
  });

  test("a held from another session is refused", async () => {
    const { config, registered, open, submit } = await setup();
    const other = await seedSession(config, "sid2", { identity_keys: KEYS });
    const res = await submit(await heldIn(await open()), registered.claim.user_code, other);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link isn't valid. Ask your agent for a new one.");
  });
});

describe("token grants", () => {
  afterEach(() => vi.useRealTimers());
  const body = async (res: Response) => (await res.json()) as Record<string, any>;
  const setup = async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const config = panelConfig();
    const route = routeWith(config);
    const token = (fields: Record<string, string>) =>
      route(
        new Request(`${ISSUER}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        })
      );
    const registered = await body(
      await route(
        new Request(`${ISSUER}/agent/identity`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "service_auth", login_hint: "jesse@example.dev" }),
        })
      )
    );
    const attemptToken = new URL(registered.claim.verification_uri).searchParams.get("claim_attempt_token")!;
    const poll = () => token({ grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: registered.claim_token });
    const approve = () => config.store.approveAgentClaim(attemptToken, registered.claim.user_code, CLAIMED, Date.now());
    const exchange = (assertion: string, extra: Record<string, string> = {}) =>
      token({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion, ...extra });
    const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
    /** Approve, wait out the interval, and take the grant. */
    const granted = async () => {
      expect((await approve()).kind).toBe("approved");
      later(AGENT_POLL_INTERVAL_MS + 1);
      const res = await poll();
      expect(res.status).toBe(200);
      return body(res);
    };
    return { config, route, token, registered, poll, approve, exchange, later, granted };
  };

  test("poll pending then granted once then invalid_grant", async () => {
    const { poll, granted } = await setup();
    const pending = await poll();
    expect(pending.status).toBe(400);
    expect(await body(pending)).toMatchObject({ error: "authorization_pending", status: "pending" });
    const ok = await granted();
    expect(ok.identity_assertion).toEqual(expect.any(String));
    expect(ok.refresh_token).toBeUndefined();
    expect(ok.scope).toBe("bellman");
    expect(ok.expires_in).toBe(600);
    expect(ok.token_type).toBe("Bearer");
    const assertion = JSON.parse(Buffer.from(ok.identity_assertion.split(".")[1], "base64url").toString());
    expect(new Date(ok.assertion_expires).getTime()).toBe(Date.now() + REFRESH_TOKEN_TTL_MS);
    expect(assertion).toMatchObject({ iss: ISSUER, sub: IDENTITY.userId, aud: "bellman:agent-assertion" });
    expect(assertion.jti).toMatch(/^reg_/);
    const again = await poll();
    expect(await body(again)).toMatchObject({ error: "invalid_grant" });
  });

  test("the access token resolves", async () => {
    const { config, granted } = await setup();
    const ok = await granted();
    expect((await identityFromAccessToken(ok.access_token, config))?.userId).toBe(IDENTITY.userId);
  });

  test("slow_down under 5 s", async () => {
    const { poll, later } = await setup();
    await poll();
    later(AGENT_POLL_INTERVAL_MS - 1);
    const res = await poll();
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("slow_down");
  });

  test("expired_token after the code window and after 24 h", async () => {
    const short = await setup();
    short.later(AGENT_CODE_TTL_MS + 1);
    expect(await body(await short.poll())).toMatchObject({ error: "expired_token", status: "expired" });
    vi.useRealTimers();
    const long = await setup();
    long.later(AGENT_REGISTRATION_TTL_MS + 1);
    expect(await body(await long.poll())).toMatchObject({ error: "expired_token", status: "expired" });
  });

  test("jwt-bearer exchanges twice", async () => {
    const { config, granted, exchange } = await setup();
    const { identity_assertion } = await granted();
    for (let i = 0; i < 2; i++) {
      const res = await exchange(identity_assertion);
      expect(res.status).toBe(200);
      const ok = await body(res);
      expect(ok.refresh_token).toBeUndefined();
      expect(ok.scope).toBe("bellman");
      expect((await identityFromAccessToken(ok.access_token, config))?.userId).toBe(IDENTITY.userId);
    }
  });

  test("exchange after deleteAgentGrant is invalid_grant", async () => {
    const { config, granted, exchange } = await setup();
    const { identity_assertion } = await granted();
    const jti = JSON.parse(Buffer.from(identity_assertion.split(".")[1], "base64url").toString()).jti;
    await config.store.deleteAgentGrant(jti);
    expect((await body(await exchange(identity_assertion))).error).toBe("invalid_grant");
  });

  test("exchange after SignInRefused is invalid_grant and deletes the grant", async () => {
    const { config, granted, exchange } = await setup();
    const { identity_assertion } = await granted();
    const owner = {
      key: "github:1", plan: "team" as const, role: "admin" as const, orgId: "org_acme", source: "operator" as const,
      grantedAt: 1, grantedBy: "u_op", expiresAt: null,
    };
    const acme = {
      orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "operator" as const,
      active: true, createdAt: 1, requireSso: true, domains: [], policy: DEFAULT_POLICY,
    };
    await config.plans!.createOrg(acme, owner, { actorUserId: "u_op" });
    await config.plans!.putGrant({ ...owner, key: "github:4242", role: "member", source: "org" });
    const res = await exchange(identity_assertion);
    expect(await body(res)).toMatchObject({ error: "invalid_grant" });
    const jti = JSON.parse(Buffer.from(identity_assertion.split(".")[1], "base64url").toString()).jti;
    expect(await config.store.getAgentGrant(jti, Date.now())).toBeNull();
  });

  test("wrong resource is invalid_target", async () => {
    const { granted, exchange } = await setup();
    const { identity_assertion } = await granted();
    const res = await exchange(identity_assertion, { resource: "https://elsewhere.test/mcp" });
    expect((await body(res)).error).toBe("invalid_target");
  });

  test("malformed grants answer 400", async () => {
    const { config, token, exchange } = await setup();
    const claim = "urn:workos:agent-auth:grant-type:claim";
    const cases: [Promise<Response>, string][] = [
      [token({ grant_type: claim, claim_token: "clm_nope" }), "invalid_grant"],
      [token({ grant_type: claim }), "invalid_request"],
      [token({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" }), "invalid_request"],
      [exchange("x.y.z"), "invalid_grant"],
      [
        exchange(await signJwt(
          { iss: ISSUER, sub: IDENTITY.userId, aud: "bellman:session-state", bellman: null as never },
          config.secret, 60
        )),
        "invalid_grant",
      ],
    ];
    for (const [pending, error] of cases) {
      const res = await pending;
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe(error);
    }
    const unknown = await body(await token({ grant_type: "password" }));
    expect(unknown).toMatchObject({
      error: "unsupported_grant_type",
      error_description: "use authorization_code, refresh_token, jwt-bearer or the agent claim grant",
    });
  });
});
