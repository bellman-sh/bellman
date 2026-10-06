import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ActionResponseShape, BriefShape, ProgressShape, SEND_KINDS, SEND_VERB, appendOrFrozen, fail, ok,
} from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Brief, Identity, SessionEvent } from "../types.js";
import { denyVerb } from "../roles.js";
import { FROZEN, activeMembers, audit, findMember, touchMember } from "../rooms.js";
import type { AppendExtras, BellmanStore, EventWrite } from "../store.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH, PayloadTooDeepError, assertPayloadDepth } from "../payload.js";

export function registerSend(server: McpServer, identity: Identity, s: BellmanStore): void {
  // --------------------------------------------------------------- bellman_send
  server.registerTool(
    "bellman_send",
    {
      title: "Send to Bellman session members",
      description: `Send a message, artifact, action request, action response, brief update, or progress report to the room.

Args:
  - session_id, member_id: your handles from start/confirm
  - type:
      "message"        — free-form text for the peer agent+human
      "artifact"       — code/doc/data payload ({ name, content })
      "action_request" — ask the room to do something. Only members that granted request_actions may act on it, and THEIR HUMAN approves, not their agent.
                         It ends in exactly one of three states and cannot sit between them: answered, declined (a human said no), or expired (30 minutes passed and nobody did). Silence and refusal are different answers, and this is what tells them apart. Until it ends it appears in every member's bellman_sync as \`outstanding\`. An answer that arrives after the deadline still lands and still counts.
      "action_response"— answer an action_request; set ref_id to the request's cursor id and include { approved: boolean, result?: string }
      "brief_update"   — replace your brief as things progress (payload = full Brief object)
      "progress"       — answer the room's heartbeat: where you are now ({ note, step?, eta_seconds? }). Peers are not interrupted by it; it reaches them when they next look.
  - payload: object, ≤ ${MAX_PAYLOAD_CHARS} chars serialized and ≤ ${MAX_PAYLOAD_DEPTH} levels deep. Both bounds matter: a deeply nested payload can be small and still be undeliverable, so flatten rather than nest.
  - ref_id: required for action_response
  - idempotency_key: optional. Names this send. Retrying with the SAME key returns the original result instead of delivering a second copy — use it when a call timed out or the connection dropped and you cannot tell whether it landed. Use a fresh key for a new message; reusing one for different content is an error.

Returns: { room_members, cursor, replayed? }
  - room_members: who was in the room when this was appended. It is NOT a read receipt. It does not mean a peer's session has seen this (that happens on its next bellman_sync), that its model acted on it, or — for action_request — that any human has approved it. The store is truth; the channel is transport.
  - replayed: true means this key had already been used and nothing new was sent.
Errors: a verb your role does not hold is refused by name, and nothing is delivered. Capability errors name the member lacking the grant.`,
      inputSchema: {
        session_id: z.string().min(4),
        member_id: z.string().min(4),
        type: z.enum(SEND_KINDS),
        payload: z.record(z.string(), z.unknown()),
        ref_id: z.string().optional(),
        idempotency_key: z.string().min(8).max(80).optional(),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
    },
    async ({ session_id, member_id, type, payload, ref_id, idempotency_key }): Promise<ToolResult> => {
      const session = await s.getSession(session_id);
      if (!session || session.closed) return fail("session not found or closed.");
      if (session.frozenAt !== null) return fail(FROZEN);
      const me = findMember(session, member_id, identity);
      if (!me || me.leftAt !== null) return fail("member_id is not yours or has left the session.");

      // Sending is as good a sign of life as polling. Before the verb check, so
      // a member whose role forbids this kind still counts as present — it is
      // here, and refusing the send does not make it absent.
      await touchMember(s, session, me);

      // Authority first: before the payload, before who is listening. A seat that
      // may not act hears why, rather than being sent off to shorten a message it
      // was never allowed to send or learning who is present by probing. Which verb
      // each kind needs is SEND_VERB's business, at the top of the file.
      const denial = denyVerb(session, me, SEND_VERB[type]);
      if (denial) return fail(denial);

      // Depth before length, because length cannot stand in for it: `{"a":`
      // costs about six characters a level, so a payload can pass the length
      // bound and still nest past where a projected event's own JSON.stringify
      // overflows — one level deeper than this handler's, inside publicEvent's
      // wrapper. Such a row is durable, and SessionDO.fetch projects every
      // missed event with no per-event guard, so one of them makes the room
      // unwatchable over /ws forever: every later connect from before its
      // cursor replays it and fails again (#136). The door is the only place a
      // fix does not have to choose between shipping a partial replay and
      // migrating stored rows.
      //
      // Applied to every send. It used to ride along with the fingerprint,
      // which runs only for a keyed one, and the asymmetry was recorded as a
      // ruling — read as costing the sender a retry, when it cost the room its
      // replay.
      try {
        assertPayloadDepth(payload);
      } catch (err) {
        if (err instanceof PayloadTooDeepError) {
          return fail(
            `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels, which cannot be delivered or replayed. ` +
            `Flatten it — send the deep part as text, or as an artifact that names where it came from.`
          );
        }
        throw err;
      }

      const serialized = JSON.stringify(payload);
      if (serialized.length > MAX_PAYLOAD_CHARS) {
        return fail(`payload too large (${serialized.length} chars, limit ${MAX_PAYLOAD_CHARS}). Send a summary and offer details on request.`);
      }

      // Hoisted past the guard, not moved into it: the capability checks below,
      // and `room_members` in the result, read it on every kind.
      const others = activeMembers(session).filter((m) => m.memberId !== member_id);
      // A progress report answers the SERVER's tick, not a peer. Its readers are the
      // room's log and the next tick's snapshot, both of which exist with nobody
      // else in the room — and the tick asks for it whether or not anyone has
      // joined, because D7 makes the cadence observable rather than conditional on
      // an audience: the startup window is exactly when a human wants to know the
      // lone agent is alive. Refusing it here would interrupt a member every
      // cadence with an instruction this same server then rejects, forever.
      //
      // Type-aware rather than dropped: the other five kinds are addressed TO the
      // room, and a member sending one into an empty room has misunderstood where
      // it is. Only the refusal is conditional.
      if (type !== "progress" && others.length === 0) {
        return fail("no other active members yet — share the join code and wait for a bellman_confirm (watch via bellman_sync).");
      }

      if (type === "message" || type === "artifact") {
        const deaf = others.filter((m) => !m.capabilities.includes("receive_messages"));
        if (deaf.length === others.length) {
          return fail(`no recipient allows receive_messages (${deaf.map((m) => m.label).join(", ")}).`);
        }
      }
      if (type === "action_request") {
        const refusing = others.filter((m) => !m.capabilities.includes("request_actions"));
        if (refusing.length > 0) {
          return fail(`action_request blocked: ${refusing.map((m) => m.label).join(", ")} did not grant request_actions.`);
        }
      }
      if (type === "action_response") {
        if (!ref_id) return fail("action_response requires ref_id (the cursor id of the action_request).");
        // One key, not the whole history (#25). String-compared, not numeric:
        // "007" never matched cursor 7 and must not start to.
        const at = Number(ref_id);
        const req = Number.isSafeInteger(at) && at > 0
          ? await s.eventAt(session_id, at)
          : undefined;
        if (!req || String(req.cursor) !== ref_id || req.type !== "action_request") {
          return fail(`no action_request with cursor id ${ref_id}.`);
        }
        if (req.fromMemberId === member_id) return fail("you cannot respond to your own action_request.");
      }
      // Validated here so an invalid brief never appends an event; applied
      // after the append, because a send the store refuses must not leave a
      // brief written. The frozen guard above catches the common case, but a
      // reused key does not reach the store until the append, and neither does
      // a freeze that lands after that guard's read.
      let updatedBrief: Brief | undefined;
      if (type === "brief_update") {
        const parsed = BriefShape.safeParse(payload);
        if (!parsed.success) return fail(`brief_update payload must be a full Brief object: ${parsed.error.issues[0]?.message}`);
        updatedBrief = parsed.data as Brief;
      }
      // Validated for the same reason, and refused before the append: a payload the
      // shape rejects must leave neither an event nor a stamp behind.
      //
      // `approved` was never checked, and `action-state.ts` has to read it to tell
      // "your human said no" from "nobody was there". A non-boolean reaching the log
      // is a refusal that cannot be told from an approval afterwards, so it is
      // refused here, where the caller can still fix it.
      if (type === "action_response") {
        const parsed = ActionResponseShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`action_response payload must be { approved: boolean, result?: string }: ${parsed.error.issues[0]?.message}`);
        }
      }
      if (type === "progress") {
        const parsed = ProgressShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`progress payload must be { note, step?, eta_seconds? }: ${parsed.error.issues[0]?.message}`);
        }
      }

      const draft = {
        type,
        fromMemberId: member_id,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        payload,
        refId: ref_id ?? null,
      };

      /**
       * A `progress` send credits this member's own `lastReportAt`, in the
       * append's own operation.
       *
       * It was a second `s.updateMember(...)` call after the append, which is two
       * Durable Object RPCs into two transactions — and `appendEvent` wakes
       * listeners before the second one runs, so a due alarm could read the
       * committed progress event while the stale stamp still named this member
       * silent. Worse, the patch sat inside the `if (!replayed)` block below, so
       * an idempotent retry skipped it outright: a stamp the first attempt never
       * landed was lost for good rather than merely late.
       *
       * A flag rather than the store reading `draft.type`: nothing in either
       * store branches on an event's kind, and this is the one write that would
       * have made it. The decision stays here, beside the verb check and the
       * payload validation that already established what this send is.
       */
      const extras: AppendExtras | undefined =
        type === "progress" ? { creditReport: true } : undefined;

      let event: SessionEvent;
      let replayed = false;
      if (idempotency_key) {
        // No PayloadTooDeepError catch here any more. `appendEventOnce`
        // fingerprints, `canonical` throws that on a payload past the bound,
        // and this used to translate it — which is how the bound came to be
        // enforced only on keyed sends. The door above now refuses every such
        // payload before the append, and tests/payload.test.ts holds the two
        // walks to the same bound, so this branch can no longer see one.
        const write: EventWrite =
          await s.appendEventOnce(session_id, draft, idempotency_key, extras);
        if (write.outcome === "conflict") {
          return fail(
            `idempotency_key "${idempotency_key}" was already used for a different message. ` +
            `Reuse a key only to retry the same send; pick a new one for new content.`
          );
        }
        if (write.outcome === "frozen") return fail(FROZEN);
        event = write.event;
        replayed = write.outcome === "replayed";
      } else {
        event = await appendOrFrozen(s, session_id, draft, extras);
      }

      // Nothing below happens twice. A replay's original call did all of it,
      // and re-running it would grow the audit log on every retry — the bug
      // #68 shipped, one layer down.
      if (!replayed) {
        if (updatedBrief) {
          await s.updateMember(session_id, member_id, { brief: updatedBrief });
        }
        // The report stamp is NOT here. It rides in the append, for the reason
        // `extras` above gives — including that this block is skipped on a
        // replay, which is exactly where it went missing.
        await audit(s, session, identity, `sent_${type}`, {
          chars: serialized.length,
          ...(ref_id ? { ref_id } : {}),
        });
      }

      return ok({
        // The members active NOW, not the ones active when this was first
        // appended, and no history is kept to do better.
        //
        // This was `delivered_to` until #82. The name claimed a delivery the
        // server cannot observe: appending an event is not a peer reading it,
        // and a comment retracting the claim does not outrank the identifier
        // the model reads in every result. The honest predicate is the name.
        //
        // It does NOT answer who can read this either, and used to say it did.
        // A member who left of their own accord goes on reading the room and
        // is not listed here (#113 R3). The two predicates are different on
        // purpose: this one answers who is in the room.
        room_members: others.map((m) => m.label),
        cursor: event.cursor,
        ...(replayed ? { replayed: true } : {}),
        note: type === "action_request"
          ? "The peer's HUMAN must approve this — expect an action_response event, possibly after a delay."
          : undefined,
      });
    }
  );
}
