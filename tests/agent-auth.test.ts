import { describe, expect, test } from "vitest";
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
import { REFRESH_TOKEN_TTL_MS } from "../src/oauth/tokens.js";
import { IDENTITY, ISSUER, panelConfig, routeWith } from "./helpers/panel.js";

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
