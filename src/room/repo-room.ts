/**
 * A repo's default room (docs/superpowers/specs/2026-11-08-repo-default-room-design.md): an account binds a git
 * remote to a room it created, and its sessions started in that repo join the room at launch. Runtime-free.
 */
import { homeRoomId } from "../files/home.js";
import type { BellmanStore } from "../storage/store.js";
import type { StoredSession } from "../storage/stored-session.js";
import type { Identity, RepoRoom } from "../types.js";
import { CONNECT_TOKEN_TTL, generateConnectToken } from "./codes.js";
import { isPublic } from "./manifest.js";
import { audit } from "./rooms.js";

/** `scp`-style `user@host:path`, which `URL` does not parse. */
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;

/**
 * A git remote as `host/owner/repo`: the host lower-cased and without a user or port, the path as given without
 * `.git` or a trailing slash. Null for anything that is not an ssh, scp-style or http(s) remote with at least two
 * path segments, so a local path or a bare host never binds.
 */
export function normalizeRemote(raw: string): string | null {
  const text = raw.trim();
  let host: string;
  let path: string;
  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? null : SCP.exec(text);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!["http:", "https:", "ssh:", "git+ssh:"].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  }
  const segments = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (!host || segments.length < 2) return null;
  return [host.toLowerCase(), ...segments].join("/");
}

/** A refusal with the HTTP status and code the routes answer it with. */
export type RepoRoomResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; reason: string };

const no = (status: number, code: string, reason: string): RepoRoomResult<never> => ({ ok: false, status, code, reason });

/** The account's bindings, as stored. */
export async function listRepoRooms(store: BellmanStore, actor: Identity): Promise<RepoRoom[]> {
  return store.readRepoRooms(homeRoomId(actor.userId));
}

/**
 * Why `actor` may not be seated in `session` as `role` through a binding, or null: an unknown or closed room, one
 * someone else created, a public room, or a role the manifest no longer has. Checked when a binding is made and again
 * at every connect, since the room can change in between.
 */
export function bindRefusal(session: StoredSession | undefined, actor: Identity, role: string): RepoRoomResult<never> | null {
  if (!session || session.closed) return no(404, "not_found", "no open room has that id");
  if (session.createdBy !== actor.userId) return no(403, "not_creator", "only a room you created can be a repo's default room");
  if (isPublic(session)) return no(409, "public_room", "a session never joins a public room on its own");
  if (!Object.hasOwn(session.manifest.roles, role)) return no(400, "unknown_role", `the room has no role "${role}"`);
  return null;
}

/**
 * Make `sessionId` the default room of `remote` for the account, as `role`, replacing any binding of that remote, and
 * mark the room kept open. The row is written before the flag, so a failure between them leaves the binding without
 * its flag; the next bind of it sets the flag again.
 */
export async function bindRepoRoom(
  store: BellmanStore,
  actor: Identity,
  input: { remote: string; sessionId: string; role: string },
): Promise<RepoRoomResult<RepoRoom>> {
  const remote = normalizeRemote(input.remote);
  if (!remote) return no(400, "invalid_request", "remote must be a git remote URL with an owner and a repo");
  const refused = bindRefusal(await store.getSession(input.sessionId), actor, input.role);
  if (refused) return refused;
  const home = homeRoomId(actor.userId);
  const row: RepoRoom = { remote, sessionId: input.sessionId, role: input.role, createdAt: Date.now() };
  const others = (await store.readRepoRooms(home)).filter((r) => r.remote !== remote);
  await store.writeRepoRooms(home, [...others, row]);
  await store.setKeptOpen(input.sessionId, true);
  return { ok: true, value: row };
}

/**
 * Remove the account's binding of `remote`, and clear the room's kept-open flag when no binding of the account still
 * names it. Only the room's creator can bind it, so the account's rows are the only ones that can.
 */
export async function unbindRepoRoom(store: BellmanStore, actor: Identity, raw: string): Promise<RepoRoomResult<{ removed: true }>> {
  const remote = normalizeRemote(raw);
  if (!remote) return no(400, "invalid_request", "remote must be a git remote URL with an owner and a repo");
  const home = homeRoomId(actor.userId);
  const rows = await store.readRepoRooms(home);
  const gone = rows.find((r) => r.remote === remote);
  if (!gone) return no(404, "not_found", "no binding for that remote");
  const kept = rows.filter((r) => r !== gone);
  await store.writeRepoRooms(home, kept);
  if (!kept.some((r) => r.sessionId === gone.sessionId)) await store.setKeptOpen(gone.sessionId, false);
  return { ok: true, value: { removed: true } };
}

/**
 * A connect token for the account's binding of `remote`, written as `bellman_connect` writes one, with
 * `via: "binding"`; the bridge redeems it with `bellman_confirm`, which runs every seating check (bans, org policy,
 * capacity, frozen). The binding is re-checked against the room as it is now, since it may have closed.
 */
export async function connectFromBinding(
  store: BellmanStore,
  actor: Identity,
  raw: string,
): Promise<RepoRoomResult<{ connectToken: string; sessionId: string; role: string }>> {
  const remote = normalizeRemote(raw);
  if (!remote) return no(400, "invalid_request", "remote must be a git remote URL with an owner and a repo");
  const binding = (await store.readRepoRooms(homeRoomId(actor.userId))).find((r) => r.remote === remote);
  if (!binding) return no(404, "no_binding", "this repo has no default room");
  const session = await store.getSession(binding.sessionId);
  const refused = bindRefusal(session, actor, binding.role);
  if (refused || !session) return refused ?? no(404, "not_found", "no open room has that id");
  const token = generateConnectToken();
  const now = Date.now();
  await store.putPendingConnect({
    token, sessionId: session.id, userId: actor.userId, roomRole: binding.role, via: "binding", createdAt: now, expiresAt: now + CONNECT_TOKEN_TTL,
  });
  await audit(store, session, actor, "connect_previewed", { via: "binding" }, [], []);
  return { ok: true, value: { connectToken: token, sessionId: session.id, role: binding.role } };
}
