import type { Brief, Member, Session } from "../../src/types.js";

export const anthropicAgent = {
  provider: "anthropic",
  model: "claude-fable-5",
  client: "claude-code",
};

export const openaiAgent = {
  provider: "openai",
  model: "gpt-5",
  client: "chatgpt",
};

export function brief(over: Partial<Brief> = {}): Brief {
  return {
    goal: "Debug flaky invoice reconciliation job",
    state: "Fails ~5% of runs; suspect a race in the webhook handler",
    constraints: ["Rails 7.1"],
    open_questions: ["Idempotency-key collisions under retry storms?"],
    agent: anthropicAgent,
    ...over,
  };
}

export function member(over: Partial<Member> = {}): Member {
  return {
    memberId: "m_creator",
    userId: "u_jesse",
    label: "jesse@codenerd",
    orgId: "org_codenerd",
    capabilities: ["read_context", "receive_messages"],
    brief: brief(),
    joinedAt: Date.now(),
    leftAt: null,
    ...over,
  };
}

export function session(over: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: "qs_test",
    mode: "pair",
    createdBy: "u_jesse",
    orgId: "org_codenerd",
    orgOnly: false,
    joinCode: "BELL-TEST-01",
    joinCodeExpiresAt: now + 15 * 60 * 1000,
    expiresAt: now + 4 * 60 * 60 * 1000,
    maxMembers: 2,
    members: [member()],
    events: [],
    closed: false,
    frozenAt: null,
    ...over,
  };
}
