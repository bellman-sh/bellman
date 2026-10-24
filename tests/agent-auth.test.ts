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
import { IDENTITY } from "./helpers/panel.js";

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
