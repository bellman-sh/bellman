import type { ConnectResult, RoomsResult } from "../src/types.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

export function connectFixture(): ConnectResult {
  return {
    connect_token: "ct_test",
    connect_token_expires_at: iso(T0 + 10 * 60_000),
    session: { mode: "pair", active_members: 1, max_members: 2, org_only: false },
    room: {
      preset: "review",
      mode: "pair",
      your_role: "reviewer",
      your_verbs: ["send", "respond_actions"],
      heartbeat_on_seconds: null,
      you_report: false,
      creator_role: "author",
      roles: { author: ["send", "invite", "revoke", "request_actions", "respond_actions"], reviewer: ["send", "respond_actions"] },
      text: {
        trust: "untrusted",
        origin: { memberId: "m_author", label: "ada@acme" },
        data: { room: "payments-migration", purpose: "Port Stripe v2 to v3", descriptions: { author: "Brought the work.", reviewer: "Reviews the work." } },
      },
    },
    creator_brief: {
      trust: "untrusted",
      origin: { memberId: "m_author", label: "ada@acme" },
      data: {
        goal: "Ship the v3 migration", state: "Webhooks done, checkout half done",
        constraints: ["Rails 7.1"], open_questions: ["Idempotency under retries?"],
        agent: { provider: "anthropic", model: "claude-fable-5", client: "claude-code" },
      },
    },
  };
}

export function roomsFixture(): RoomsResult {
  return {
    rooms: [{
      session_id: "qs_1",
      status: "active",
      expires_at: iso(T0 + 3 * 3_600_000),
      max_members: 8,
      active_members: 2,
      your_member_id: "m_lead",
      room: {
        preset: null, mode: "swarm", your_role: "lead", your_verbs: ["send", "invite"],
        heartbeat_on_seconds: 300, you_report: true, creator_role: "lead",
        roles: { lead: ["send", "invite"], helper: ["send"] },
        text: { trust: "untrusted", origin: { memberId: "m_lead", label: "me@here" }, data: { room: "migration-swarm", purpose: null, descriptions: {} } },
      },
      members: [
        { member_id: "m_lead", label: "me@here", room_role: "lead", presence: "present", active: true,
          beat: { asked: true, last_report_at: iso(T0 - 60_000), silent_for_seconds: 60, silent: false,
            note: { trust: "untrusted", origin: { memberId: "m_lead", label: "me@here" }, data: { note: "on the migration" } } } },
        { member_id: "m_help", label: "them@there", room_role: "helper", presence: "stale", active: true,
          beat: { asked: true, last_report_at: null, silent_for_seconds: 900, silent: true, note: null } },
      ],
      join_codes: [{ role: "helper", expires_at: iso(T0 + 600_000), code: "BELL-AAAA-11-HELPER", join_url: "https://bellman.sh/j/BELL-AAAA-11-HELPER" }],
      last_event: { cursor: 7, type: "progress", at: iso(T0 - 60_000) },
    }],
  };
}

export const NOW = T0;
