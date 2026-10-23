import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { roomPreview } from "../projections.js";
import { hostMember } from "../host.js";
import type { ArrivingMember, Identity, NewSession, RoomManifest } from "../types.js";
import { entitlementsFor } from "../auth.js";
import { generateSessionId, joinUrl, publicRoomUrl, renderJoinCode } from "../codes.js";
import { ManifestError, ManifestShape, PRESET_NAMES, checkCiteCadence, resolveManifest, roomBeat } from "../manifest.js";
import { asManifest } from "../presets.js";
import { claimName, publicNameRefusal } from "../public-names.js";
import { audit } from "../rooms.js";
import { JOIN_CODE_TTL, ROOM_MEMBER_CEILING } from "../store.js";
import type { BellmanStore } from "../store.js";
import { monthKey } from "../stored-session.js";
import { APP_UI_META } from "../ui/resource.js";

export function registerStart(server: McpServer, identity: Identity, s: BellmanStore, features: { hostedSeat: boolean }): void {
  server.registerTool(
    "bellman_start",
    {
      title: "Start a Bellman session",
      description: `Create a collaboration room and get a join code to share with the sessions you want in it.

The join code (e.g. BELL-7F3K-92-PEER-B) is human-relayable: paste it into another Claude/ChatGPT/Cursor/Gemini session that has Bellman connected, and that session runs bellman_connect with it. The last group is the seat the code grants. Works across users, machines, surfaces, and model providers.

Args:
  - manifest: the room's declaration. Either cite a preset —
    { room, purpose?, public?, preset: "pair" | "swarm" | "review" | "social", or the name of a preset you saved at dash.bellman.sh/presets } — or author roles:
    { room, purpose?, public?, mode, roles: { <role>: { can: [verbs] } }, default_role, creator_role }.
    heartbeat: <duration, 30s to 24h> sets how often the room's heartbeat ticks; a role's heartbeat_on: true puts that seat on it, and heartbeat_on: "<what to report>" does so with your instruction. The older top-level heartbeat_on and a role's reports/report still work.
    Verbs: send, invite, revoke, request_actions, respond_actions, write_surface.
    Verbs are enforced by the server: a role's list is what each seat may actually do, and a call outside it is refused; reading the room and leaving it are never gated.
    invite reaches outside its own seat: holding it lets you mint a join code for ANY role this manifest declares, not only your own or the default, so you can seat someone — including yourself, by leaving and rejoining — in the most capable role the room has. revoke is likewise not self-scoped: a seat holding it may retire any role's code, not only its own. Give invite only to a seat you would trust with every seat's authority.
    The manifest sets the room's mode; there is no separate mode argument. A "pair"
    room holds exactly 2 members; a "swarm" room holds as many as you invite, up to
    ${ROOM_MEMBER_CEILING} — Bellman's ceiling for one room, the same on every plan.
    The pair and review presets make pair rooms; the swarm and social presets make swarm rooms.
    A manifest may declare a \`host\`, a seat Bellman runs that asks the room a question on each heartbeat and answers replies; it needs the max or team plan, a \`heartbeat\` of at least 1h, and a swarm room. The social preset declares one. The host never keeps a room open.
    public: true (pro, max or team plan) lets anyone with the room's public_url read its surface and its log, never a brief, with members named by number; joining still takes a code, and joiners are told before they accept. False unless given; a saved preset's is the default for its rooms. Share public_url for people to read, never join_url, which seats whoever redeems it until it expires.
  - brief: your structured context summary (goal, state, constraints, open_questions, agent). This is what a joiner PREVIEWS before committing — write it for outside eyes.
  - capabilities: what you allow peers to do to you (default: read_context, receive_messages). read_context lets peers read your brief; it is on by default, and without it only you see your brief. Grant request_actions only if you want peers to be able to ask your session to do things.
  - org_only (boolean): restrict joining to members of your org (team plan)
  - public_name: a public room's name in its link, dash.bellman.sh/r/<public_name> (needs public: true). A taken name is refused and nothing is created; check or set one with bellman_public_name.

Returns: { session_id, member_id, join_code, join_url, join_code_expires_at, public_url (a public room only: its name's link when named), plan, room: {preset, mode, public, public_name, your_role, your_verbs, heartbeat_seconds, your_heartbeat_on, creator_role, roles, heartbeat_on (per role, whether that seat is asked to report), host ({ role, model } of the hosted seat, or null), housekeeping ({ quiet_after_seconds, answer_within_seconds, idle_after_seconds, repeat_after_seconds }, each null when off, or null when the room names no one), text (untrusted envelope)} }
Keep member_id — every subsequent call needs it. The room has no lifetime: it ends when its last member leaves, or after 90 days in which nobody in it was seen. room is the manifest as the server recorded it: a preset comes back expanded, and your_role / your_verbs are yours. Read it back to check it says what you meant.

Plan gating applies to CREATING sessions only; joining is free on every plan.
Errors: "invalid manifest — ..." (a default_role or creator_role that names no role, or a verb repeated within a role) or an input validation error naming the field (a malformed manifest) — either way nothing is created and no quota is spent; "a hosted seat requires..." (plan), "swarm mode requires..." (plan), "a public room requires..." (plan), "public_name needs a public room", "public name "...": use 3 to 40 lowercase letters...", "public name "..." is taken: choose another..." (nothing is created), "org_only sessions require..." (plan), "org_only was set but..." (no org), "hosted room limit reached: ... open" (your plan's hosted rooms are all open; one that closes frees its slot), "monthly session limit..." (quota).`,
      inputSchema: {
        manifest: ManifestShape,
        brief: BriefShape,
        capabilities: CapabilitiesShape,
        org_only: z.boolean().default(false),
        public_name: z.string().max(200).optional(),
      },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
      // Rendered as the room card, the join code and its links, by a host that supports MCP Apps;
      // the text result is unchanged for every other host (#28, the UI spec's deferred room card).
      _meta: APP_UI_META,
    },
    async ({ manifest: manifestInput, brief, capabilities, org_only, public_name }): Promise<ToolResult> => {
      // Resolve FIRST. A malformed manifest must not reach the store, and the
      // plan check below reads the mode the manifest declares.
      let manifest: RoomManifest;
      try {
        // A cited name that is not a built-in is one of the caller's saved presets
        // (designer spec D6): the room is authored from it here, so resolveManifest
        // only ever sees a built-in cite or an author arm and stays pure. Unknown
        // everywhere, the refusal names both lists. A saved preset's `host` comes
        // with it, so the hosted-seat refusals and the slot below meet it as they
        // meet an inline `host` block: there is one path to a hosted room.
        let input: unknown = manifestInput;
        if ("preset" in manifestInput && !(PRESET_NAMES as readonly string[]).includes(manifestInput.preset)) {
          const saved = await s.getPreset(identity.userId, manifestInput.preset);
          if (!saved) {
            const yours = (await s.listPresets(identity.userId)).map((p) => p.name);
            throw new ManifestError(
              `unknown preset "${manifestInput.preset}" (built-in: ${PRESET_NAMES.join(", ")}; yours: ${yours.length > 0 ? yours.join(", ") : "none"})`,
            );
          }
          // The rule resolveManifest holds a built-in cite to, held here for a saved one.
          // Either spelling of a cite's frequency (vocabulary spec D3), refused in the one it used (D5).
          const beat = roomBeat(manifestInput);
          checkCiteCadence(manifestInput.preset, saved.host != null, beat.raw, beat.word ?? "heartbeat_on");
          // A block the cite carries (#66, D5) replaces the preset's whole; asManifest says how.
          input = asManifest(saved, manifestInput.room, manifestInput.purpose, beat.raw, manifestInput.housekeeping, manifestInput.public);
        }
        manifest = resolveManifest(input);
      } catch (e) {
        if (e instanceof ManifestError) return fail(`invalid manifest — ${e.message}`);
        throw e;
      }

      // The hosted seat's switch (BELLMAN_HOSTED_SEAT), ahead of every other host check: while
      // it is off no plan has a seat, and the plan refusal below would send a caller to buy
      // one. Read from the resolved manifest, so an inline block, `social` and a saved preset
      // meet it the same way.
      if (manifest.host !== null && !features.hostedSeat) return fail("hosted seats are not available yet");

      const ent = entitlementsFor(identity);
      // Before the mode check: a hosted room is always a swarm room, and on free the
      // swarm refusal would point at pro, which has no hosted seat either.
      if (manifest.host !== null && ent.hostedRooms === 0) {
        return fail(`a hosted seat requires the max or team plan (you are on "${identity.plan}").`);
      }
      if (!ent.modes.includes(manifest.mode)) {
        return fail(`swarm mode requires the pro, max or team plan (you are on "${identity.plan}"). Start a pair session instead, or upgrade.`);
      }
      // Read from the resolved manifest, so a cite's public and a saved preset's default meet it too.
      if (manifest.public && !ent.publicRooms) {
        return fail(`a public room requires the pro, max or team plan (you are on "${identity.plan}"). Start it with public: false, or upgrade.`);
      }
      // The room's own, so an argument beside the manifest and never in it: a saved preset is
      // started many times, and a name is held by one room (public names spec, D4).
      if (public_name !== undefined) {
        const bad = publicNameRefusal(public_name);
        if (bad) return fail(`${bad}.`);
        if (!manifest.public) return fail("public_name needs a public room: add public: true, or leave public_name out.");
      }
      if (org_only && !ent.orgScoping) {
        return fail(`org_only sessions require the team plan (you are on "${identity.plan}").`);
      }
      if (org_only && !identity.orgId) {
        return fail("org_only was set but your identity has no org.");
      }
      const used = await s.countCreatesThisMonth(identity.userId);
      if (used >= ent.monthlyCreates) {
        return fail(`monthly session limit reached (${ent.monthlyCreates} on the "${identity.plan}" plan).`);
      }

      // The refusals that write come last. A name first: refused, it holds nothing, and claimed for a
      // room that is then not created, it names a room that does not hold it, which is free (public
      // names spec, D5). Then a hosted room's slot, counted and recorded in one call (I7), and given
      // back if the room is not created after all.
      const sessionId = generateSessionId();
      const claim = public_name === undefined ? null : await claimName(s, public_name, sessionId);
      if (public_name !== undefined && claim === null) {
        return fail(`public name "${public_name}" is taken: choose another, or start without one and set it later with bellman_public_name.`);
      }
      // Given back when a later step refuses, so a retry with the same name finds it free (D5 as amended).
      const giveBack = async (): Promise<void> => {
        if (public_name !== undefined && claim !== null) await s.releasePublicName(public_name, claim);
      };
      if (manifest.host !== null) {
        const slot = await s.reserveHostedRoom(identity.userId, sessionId, ent.hostedRooms);
        if (!slot.ok) {
          await giveBack();
          return fail(`hosted room limit reached: ${slot.open} hosted rooms open, the most the "${identity.plan}" plan allows. A hosted room that closes frees its slot.`);
        }
      }

      const now = Date.now();
      const memberId = `m_${randomUUID().slice(0, 8)}`;
      const creator: ArrivingMember = {
        memberId,
        userId: identity.userId,
        label: identity.label,
        orgId: identity.orgId,
        capabilities,
        roomRole: manifest.creatorRole,
        brief,
        joinedAt: now,
        lastSeenAt: now,
        leftAt: null,
      };
      const defaultCode = {
        code: renderJoinCode(manifest.defaultRole),
        expiresAt: now + JOIN_CODE_TTL,
      };
      const session: NewSession = {
        id: sessionId,
        manifest,
        createdBy: identity.userId,
        orgId: identity.orgId,
        orgOnly: org_only,
        joinCodes: { [manifest.defaultRole]: defaultCode },
        // The room's own byte ceiling (#183), from the plan creating it. Nothing
        // downstream asks a plan again.
        blobBytesCeiling: ent.blobBytesPerRoom,
        // The hosted seat's allowance for this month (hosted seat spec, D2), from the plan
        // creating the room. Each later month's is read from the creator's plan then (I7).
        hostUnitsPerMonth: manifest.host === null ? 0 : ent.hostUnitsPerRoom,
        hostUnits: { month: monthKey(now), used: 0, wakes: [] },
        // The window a closed room is kept for (#65, D1), stamped as the ceiling above is: a plan
        // change after the fact never shortens a room that was promised one.
        retainAfterCloseMs: ent.retainAfterCloseMs,
        closedAt: null,
        purgeAt: null,
        blobsSwept: false,
        // Housekeeping's books (#66), empty at birth: the stores keep them at the write, for a
        // room whose manifest declared housekeeping.
        raised: {},
        openRequests: {},
        lastMemberEventAt: null,
        thawedAt: null,
        // Public or not is the manifest's; this is set only when the creator makes a public room private (public rooms spec D2).
        unpublishedAt: null,
        // The name claimed above, if any (public names spec, D4): the record is what holds it.
        publicName: public_name ?? null,
        // The host is seated here, beside the creator, and never joins by code.
        members: manifest.host === null ? [creator] : [creator, hostMember(manifest, now)],
        events: [],
        closed: false,
        frozenAt: null,
      };
      try {
        await s.createSession(session);
      } catch (err) {
        if (manifest.host !== null) await s.releaseHostedRoom(identity.userId, sessionId);
        await giveBack();
        throw err;
      }
      await s.recordCreate(identity.userId);
      // The room as the store keeps it, read back: each member numbered and with its brief's agent,
      // the brief beside it, and the creator and orgs the store took from them (ADR 0018, ADR 0019).
      const room = await s.getSession(session.id);
      if (!room) throw new Error(`room ${session.id} was created and cannot be read back`);
      await audit(s, room, identity, "session_created", {
        mode: manifest.mode, org_only, preset: manifest.preset, hosted: manifest.host !== null,
      });

      return ok({
        session_id: session.id,
        member_id: memberId,
        join_code: defaultCode.code,
        // The same code, as a link: clickable in chat, and it tells the person
        // who opens it what to say to their agent. The page is rendered from
        // the URL alone, so sharing the link reveals nothing the code does not.
        join_url: joinUrl(defaultCode.code),
        join_code_expires_at: new Date(defaultCode.expiresAt).toISOString(),
        // A public room's page to read, apart from the code to join (plan B's final review): asked
        // for "the link", an agent holding only join_url would hand out a seat.
        ...(manifest.public === true ? { public_url: publicRoomUrl(room) } : {}),
        plan: identity.plan,
        // What the server recorded, seen from the creator's seat. Without it the
        // author of a manifest, especially one parsed from .bellman/room.yaml,
        // cannot see a preset or role that validated but is not what they meant.
        room: roomPreview(room, manifest.creatorRole, identity.userId),
        // A preview shows the creator's brief only when the creator grants read_context, so a joiner is told to review it only then.
        share_instructions:
          `Give the join code to whoever you want in the room. In their session (any MCP client — Claude, ChatGPT, Cursor, Gemini), they run bellman_connect with the code, ${capabilities.includes("read_context") ? "review your brief, " : ""}then bellman_confirm with their own. A swarm room holds as many members as you invite, up to ${ROOM_MEMBER_CEILING}; reissue a code with bellman_invite to add members later.`,
      });
    }
  );
}
