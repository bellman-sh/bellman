import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { BriefShape, CapabilitiesShape, fail, ok } from "./kit.js";
import type { ToolResult } from "./kit.js";
import { roomPreview } from "../projections.js";
import { hostMember } from "../host.js";
import type { ArrivingMember, Identity, NewSession, RoomManifest } from "../types.js";
import { entitlementsFor, upgradeHint, type UpgradeLinks } from "../auth.js";
import { generateSessionId, joinUrl, publicRoomUrl, renderJoinCode } from "../codes.js";
import { ManifestError, ManifestShape, PRESET_NAMES, checkCiteCadence, isTopicRoom, resolveManifest, roomBeat } from "../manifest.js";
import { asManifest } from "../presets.js";
import { forbiddenCapabilityRefusal } from "../orgs.js";
import { claimName, publicNameRefusal } from "../public-names.js";
import { audit } from "../rooms.js";
import { JOIN_CODE_TTL, ROOM_MEMBER_CEILING } from "../store.js";
import type { BellmanStore } from "../store.js";
import { monthKey } from "../stored-session.js";
import { APP_UI_META } from "../ui/resource.js";

export function registerStart(server: McpServer, identity: Identity, s: BellmanStore, features: { hostedSeat: boolean; upgrade?: UpgradeLinks }): void {
  server.registerTool(
    "bellman_start",
    {
      title: "Start a Bellman session",
      description: `Create a room and get a join code for the members you want in it.

A join code (e.g. BELL-7F3K-92-PEER-B) is human-relayable: any MCP client with Bellman connected (Claude, ChatGPT, Cursor, Gemini) runs bellman_connect with it. Its last group is the seat it grants.

Args:
  - manifest: the room's declaration. Cite a preset:
    { room, purpose?, public?, preset: "pair" | "swarm" | "review" | "social" | "topic" | a preset saved at dash.bellman.sh/presets }, or author roles:
    { room, purpose?, public?, mode, roles: { <role>: { can: [verbs] } }, default_role, creator_role }.
    heartbeat: <duration, 30s to 24h> sets the room's tick; a role's heartbeat_on: true puts that seat on it, heartbeat_on: "<what to report>" adds an instruction. Top-level heartbeat_on and a role's reports/report are also accepted.
    Verbs: send, invite, revoke, request_actions, respond_actions, write_surface, answer, vote.
    Verbs are enforced by the server: a call outside a seat's verbs is refused. Reading the room and leaving it are never gated.
    invite mints a code for ANY role the manifest declares, the most capable included, so its holder can reach any seat, their own by leaving and rejoining; revoke retires any role's code. Give invite only to a seat you would trust with every seat's authority.
    The manifest sets the mode. A "pair" room holds exactly 2 members; a "swarm" room as many as you invite, up to ${ROOM_MEMBER_CEILING}, on every plan. pair and review make pair rooms; swarm, social and topic make swarm rooms.
    host: a seat Bellman runs that asks the room a question each heartbeat and answers replies. Needs the max or team plan, a heartbeat of at least 1h, and a swarm room; social declares one. The host never keeps a room open.
    public: true (pro, max or team plan): anyone with public_url reads the surface and the log, never a brief, members named by number. Joining still takes a code, and joiners are told before they accept. Default false, or a saved preset's. Share public_url for reading, never join_url, which seats whoever redeems it until it expires.
  - brief: your context summary (goal, state, constraints, open_questions, agent). Joiners preview it before committing: write it for outside eyes.
  - capabilities: what peers may do to you (default read_context, receive_messages). read_context lets peers read your brief; without it only you see it. Grant request_actions only if peers may ask your session to act.
  - org_only: only members of your org may join (team plan).
  - public_name: the room's link name, bellman.sh/r/<public_name> (needs public: true). A taken name is refused and nothing is created; see bellman_public_name.

Returns: { session_id, member_id, join_code, join_url, join_code_expires_at, public_url (public room only), plan, org_only (as recorded; org policy can force it true), room: {preset, mode, public, public_name, your_role, your_verbs, heartbeat_seconds, your_heartbeat_on, creator_role, roles, heartbeat_on (per role, whether that seat reports), host ({ role, model } or null), decide and veto (only when the room declares how it decides: each kind's rule, and the kinds each role can veto), housekeeping ({ quiet_after_seconds, answer_within_seconds, idle_after_seconds, repeat_after_seconds }, each null when off; or null), text (untrusted envelope)} }
Keep member_id: every later call needs it. room is the manifest as recorded, presets expanded: check it says what you meant. A room ends when its last member leaves, or after 90 days with no member seen.
Plans gate creating rooms only; joining is free.
Errors (nothing is created, no quota spent): "invalid manifest — ..." or a validation error naming the field; plan: "a hosted seat requires...", "swarm mode requires...", "a public room requires...", "org_only sessions require..."; "public_name needs a public room"; "public name "...": use 3 to 40 lowercase letters..."; "public name "..." is taken: choose another..."; "org_only was set but..." (no org); policy: "your org's policy lets only admins start rooms.", "your org's policy forbids granting ... to peers"; "hosted room limit reached: ... open" (a hosted room that closes frees its slot); "monthly session limit...". A plan or quota refusal ends with "Upgrade to <plan>: <url>" when this server sells a plan that allows it: show your human that link.`,
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
      const upgrade = (need: Parameters<typeof upgradeHint>[1]): string => upgradeHint(features.upgrade, need);
      // Before the mode check: a hosted room is always a swarm room, and on free the
      // swarm refusal would point at pro, which has no hosted seat either.
      if (manifest.host !== null && ent.hostedRooms === 0) {
        return fail(`a hosted seat requires the max or team plan (you are on "${identity.plan}").${upgrade((e) => e.hostedRooms > 0)}`);
      }
      if (!ent.modes.includes(manifest.mode)) {
        return fail(`swarm mode requires the pro, max or team plan (you are on "${identity.plan}"). Start a pair session instead, or upgrade.${upgrade((e) => e.modes.includes(manifest.mode))}`);
      }
      // Read from the resolved manifest, so a cite's public and a saved preset's default meet it too.
      if (manifest.public && !ent.publicRooms) {
        return fail(`a public room requires the pro, max or team plan (you are on "${identity.plan}"). Start it with public: false, or upgrade.${upgrade((e) => e.publicRooms)}`);
      }
      // The room's own, so an argument beside the manifest and never in it: a saved preset is
      // started many times, and a name is held by one room (public names spec, D4).
      if (public_name !== undefined) {
        const bad = publicNameRefusal(public_name);
        if (bad) return fail(`${bad}.`);
        if (!manifest.public) return fail("public_name needs a public room: add public: true, or leave public_name out.");
      }
      if (org_only && !ent.orgScoping) {
        return fail(`org_only sessions require the team plan (you are on "${identity.plan}").${upgrade((e) => e.orgScoping)}`);
      }
      if (org_only && !identity.orgId) {
        return fail("org_only was set but your identity has no org.");
      }
      // The creator's org's policy (ADR 0031), read once: who may start, what a member may not grant,
      // and whether every room its members start is org-only, whatever the call said.
      const org = identity.orgId ? await s.getOrg(identity.orgId) : undefined;
      const policy = org?.policy;
      if (policy?.whoMayCreate === "admins_only" && identity.role !== "admin") {
        return fail("your org's policy lets only admins start rooms.");
      }
      const forbidden = policy ? forbiddenCapabilityRefusal(policy, capabilities) : null;
      if (forbidden) return fail(forbidden);
      const orgOnly = org_only || policy?.requireOrgOnly === true;
      const used = await s.countCreatesThisMonth(identity.userId);
      if (used >= ent.monthlyCreates) {
        return fail(`monthly session limit reached (${ent.monthlyCreates} on the "${identity.plan}" plan).${upgrade((e) => e.monthlyCreates > ent.monthlyCreates)}`);
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
          return fail(`hosted room limit reached: ${slot.open} hosted rooms open, the most the "${identity.plan}" plan allows. A hosted room that closes frees its slot.${upgrade((e) => e.hostedRooms > ent.hostedRooms)}`);
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
        orgOnly,
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
        // A room opens on its canvas until its creator chooses the page (room pages spec, D3). A topic room opens as a
        // page (topic rooms spec, D6 and R4); its creator keeps PUT /rooms/:id/view.
        publicView: isTopicRoom(manifest) ? "page" : "canvas",
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
        mode: manifest.mode, org_only: orgOnly, preset: manifest.preset, hosted: manifest.host !== null,
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
        // As recorded: a policy can make a room org-only that the call did not ask to be.
        org_only: orgOnly,
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
