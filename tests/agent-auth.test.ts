import { describe, expect, test } from "vitest";
import {
  AGENT_CODE_TTL_MS,
  AGENT_POLL_INTERVAL_MS,
  AGENT_REGISTRATION_TTL_MS,
  type AgentClaimed,
  type AgentRegistration,
  decideApprove,
  decidePoll,
  decideReissue,
  emailKey,
  newUserCode,
} from "../src/oauth/agent-auth.js";
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
