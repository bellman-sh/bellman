/**
 * What a deprovision does to rooms (SCIM spec, D6), and what a reprovision undoes (D7), after the registry
 * has answered. Not atomic with that write (ARCHITECTURE section 9) and not needing to be: the registry's write
 * is the decision, the rooms are its consequence, and both walks are idempotent, so a pass cut short is
 * finished by the next deactivation of the same user.
 */
import { audit, evictionRequest } from "../rooms.js";
import { JOINED_SCAN, isActiveMember, type BellmanStore } from "../store.js";
import type { Identity } from "../types.js";

/** The identity SCIM acts as in a room's events and rows: the org's own connector. */
export const scimIdentity = (orgId: string): Identity => ({ userId: "scim", orgId, plan: "team", role: "admin", label: "SCIM" });

// ponytail: the creator index is read in rounds of this many until a round names nothing new, at most
// ROUNDS rounds. A person who created more open rooms than ROUNDS times this leaves some unfrozen; a cursor on
// the index is the upgrade.
const CREATED_PAGE = 500;
const ROUNDS = 10;

/** Every open room this person created, as the index lists them, each once. */
async function createdRooms(store: BellmanStore, userId: string): Promise<string[]> {
  const seen = new Set<string>();
  for (let round = 0; round < ROUNDS; round++) {
    const before = seen.size;
    for (const id of await store.sessionsCreatedBy(userId, CREATED_PAGE)) seen.add(id);
    if (seen.size === before) break;
  }
  return [...seen];
}

/**
 * Every handle of theirs removed from every open room they are in, each room closed if that emptied it; then
 * every open room they created frozen, with a `room_frozen` row to its orgs. The removals first, since a room of
 * theirs that empties closes rather than freezes. A room already frozen is left as it is.
 */
export async function departedRooms(store: BellmanStore, userId: string, actor: Identity, now: number): Promise<{ left: number; frozen: string[] }> {
  let left = 0;
  for (const id of await store.sessionsJoinedBy(userId, JOINED_SCAN)) {
    const room = await store.getSession(id);
    if (!room || room.closed) continue;
    let removed = false;
    for (const m of room.members.filter((mm) => mm.userId === userId && isActiveMember(mm))) {
      const request = evictionRequest(room, m, actor, undefined, undefined, { frozen: "allow", byUserId: undefined, reason: "deprovisioned" });
      removed = (await store.removeMember(id, m.memberId, request)).removed || removed;
    }
    if (removed) {
      left++;
      await store.closeSessionIfEmpty(id);
    }
  }
  const frozen: string[] = [];
  for (const id of await createdRooms(store, userId)) {
    const room = await store.getSession(id);
    if (!room || room.closed || room.frozenAt !== null) continue;
    await store.freezeSession(id, now);
    await audit(store, room, actor, "room_frozen", { reason: "deprovisioned", user_id: userId });
    frozen.push(id);
  }
  return { left, frozen };
}

/** Every open, frozen room they created thawed, with a `room_thawed` row. Nothing freezes a room but a deprovision, so each is one it froze. */
export async function thawRooms(store: BellmanStore, userId: string, actor: Identity, now: number): Promise<string[]> {
  const thawed: string[] = [];
  for (const id of await createdRooms(store, userId)) {
    const room = await store.getSession(id);
    if (!room || room.closed || room.frozenAt === null) continue;
    await store.freezeSession(id, null);
    await audit(store, room, actor, "room_thawed", { reason: "reprovisioned", user_id: userId, frozen_at: room.frozenAt, at: now });
    thawed.push(id);
  }
  return thawed;
}
