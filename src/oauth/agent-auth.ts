import type { Identity } from "../types.js";
import { randomId } from "./tokens.js";

/**
 * auth.md agent registration (spec 2026-10-23-auth-md-design.md). The records
 * and every decision about them live here, free of any Workers import, so
 * MemoryAuthStore and AuthDO apply the same rules and tests can run them under
 * Node. The decisions never mutate a record; the store applies what they say.
 */

export const AGENT_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_CODE_TTL_MS = 10 * 60 * 1000;
export const AGENT_POLL_INTERVAL_MS = 5_000;
export const AGENT_MAX_CODE_FAILURES = 5;
export const AGENT_REGS_PER_HOUR = 20;
export const AGENT_UNCLAIMED_CAP = 10_000;
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const ASSERTION_AUDIENCE = "bellman:agent-assertion";
/** Unclaimed registrations, for the cap. Absent means zero. */
export const AGENT_COUNT_KEY = "agentregs:count";

export interface AgentAttempt {
  attempt_token: string;
  attempt_id: string;
  user_code: string;
  expires_at: number;
  failures: number;
}

/** What the approving session held, copied so the grant outlives it. */
export interface AgentClaimed {
  identity: Identity;
  plan_source: string;
  plan_key?: string | null;
  identity_keys: string[];
}

export interface AgentRegistration {
  registration_id: string;
  login_hint: string;
  created_at: number;
  expires_at: number;
  last_poll_at: number | null;
  attempt: AgentAttempt;
  claimed: AgentClaimed | null;
}

export interface AgentGrant extends AgentClaimed {
  expires_at: number;
}

export function emailKey(loginHint: string): string {
  return `email:${loginHint.trim().toLowerCase()}`;
}

export function newUserCode(): string {
  // Modulo bias is about 0.02%, which buys nothing against five tries.
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
}

export function newAttempt(now: number): AgentAttempt {
  return {
    attempt_token: randomId(),
    attempt_id: `cla_${randomId(16)}`,
    user_code: newUserCode(),
    expires_at: now + AGENT_CODE_TTL_MS,
    failures: 0,
  };
}

const attemptDead = (a: AgentAttempt, now: number) => now > a.expires_at || a.failures >= AGENT_MAX_CODE_FAILURES;

export type PollVerdict =
  | { kind: "unknown" }
  | { kind: "expired" }
  | { kind: "slow_down" }
  | { kind: "pending" }
  | { kind: "granted"; registration_id: string; claimed: AgentClaimed };

export function decidePoll(reg: AgentRegistration | undefined, now: number): PollVerdict {
  if (!reg) return { kind: "unknown" };
  if (now > reg.expires_at) return { kind: "expired" };
  if (reg.claimed) return { kind: "granted", registration_id: reg.registration_id, claimed: reg.claimed };
  if (reg.last_poll_at !== null && now - reg.last_poll_at < AGENT_POLL_INTERVAL_MS) return { kind: "slow_down" };
  if (attemptDead(reg.attempt, now)) return { kind: "expired" };
  return { kind: "pending" };
}

export type ApproveVerdict =
  | { kind: "approved" }
  | { kind: "wrong_code"; left: number }
  | { kind: "dead" }
  | { kind: "wrong_account" }
  | { kind: "code_expired" }
  | { kind: "reg_expired" }
  | { kind: "already" }
  | { kind: "unknown" };

export function decideApprove(
  reg: AgentRegistration | undefined,
  attemptToken: string,
  code: string,
  identityKeys: string[],
  now: number
): ApproveVerdict {
  if (!reg) return { kind: "unknown" };
  // An older attempt's page: the agent minted a new code since.
  if (reg.attempt.attempt_token !== attemptToken) return { kind: "code_expired" };
  if (now > reg.expires_at) return { kind: "reg_expired" };
  if (reg.claimed) return { kind: "already" };
  if (attemptDead(reg.attempt, now)) return { kind: "code_expired" };
  // Before the code, so someone in the wrong account spends none of the tries.
  if (!identityKeys.includes(emailKey(reg.login_hint))) return { kind: "wrong_account" };
  if (code !== reg.attempt.user_code) {
    const left = AGENT_MAX_CODE_FAILURES - (reg.attempt.failures + 1);
    return left > 0 ? { kind: "wrong_code", left } : { kind: "dead" };
  }
  return { kind: "approved" };
}

export type ReissueVerdict = "ok" | "unknown" | "expired" | "claimed" | "mismatch";

export function decideReissue(reg: AgentRegistration | undefined, email: string, now: number): ReissueVerdict {
  if (!reg) return "unknown";
  if (now > reg.expires_at) return "expired";
  if (reg.claimed) return "claimed";
  if (emailKey(email) !== emailKey(reg.login_hint)) return "mismatch";
  return "ok";
}
