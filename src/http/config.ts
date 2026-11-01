/**
 * The governed config routes (#414): a room's settings, read by any seat in the room and written only by a person
 * in a signed-in dash session, from their own seat, whose role holds `govern`. An agent's bearer token is refused
 * even on a seat that holds the verb: room settings are human-written, so text like `room_instructions`, which every
 * joining agent is handed, never comes from an agent.
 *
 *   GET  /rooms/:id/config/:name?member_id=                      the current value (getGovernedConfig)
 *   GET  /rooms/:id/config/:name/history?member_id=[&rev=N]      the kept revisions, bodies only by rev
 *   PUT  /rooms/:id/config/:name?member_id=   { body, base_rev } a new revision
 *   POST /rooms/:id/config/:name/restore?member_id=  { rev, base_rev }  an old revision's body as a new revision
 *
 * Runtime-free, as rooms.ts: a web Request in, a Response out.
 */
import { csrfRefusal } from "../oauth/browser.js";
import { auditEntries, findMember, gateSeat } from "../rooms.js";
import {
  CONFIG_RESERVE_BYTES, bodyBytes, bodyHash, getGovernedConfig, isConfigName, isNarrowing, parseConfigBody,
} from "../config.js";
import type { ConfigName, ConfigRow } from "../types.js";
import { STATUS, adminWriteRefusal, json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export const CONFIG = /^\/rooms\/([^/]+)\/config\/([^/]+)$/;
export const CONFIG_HISTORY_ROUTE = /^\/rooms\/([^/]+)\/config\/([^/]+)\/history$/;
export const CONFIG_RESTORE = /^\/rooms\/([^/]+)\/config\/([^/]+)\/restore$/;

// ponytail: 70,000 bytes, not tuned. The largest body is 64 KiB of markdown; this leaves room for the JSON around it.
export const MAX_CONFIG_WRITE_BYTES = 70_000;

const NOT_FOUND = "no such room, or no member of yours in it";

/** Dispatch one config route, or undefined when `path` is not one. */
export async function configRoutes(request: Request, url: URL, path: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response | undefined> {
  const history = CONFIG_HISTORY_ROUTE.exec(path);
  if (history) {
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    return readConfig(request, url, history[1], history[2], origin, deps, true);
  }
  const restore = CONFIG_RESTORE.exec(path);
  if (restore) {
    if (request.method !== "POST") return methodNotAllowed("POST", origin);
    return writeConfigRoute(request, url, restore[1], restore[2], origin, deps, true);
  }
  const config = CONFIG.exec(path);
  if (config) {
    if (request.method === "PUT") return writeConfigRoute(request, url, config[1], config[2], origin, deps, false);
    if (request.method !== "GET") return methodNotAllowed("GET, PUT", origin);
    return readConfig(request, url, config[1], config[2], origin, deps, false);
  }
  return undefined;
}

const approverOf = (row: Pick<ConfigRow, "governance">) =>
  ({ member_id: row.governance.approverMemberId, label: row.governance.approverLabel });

/** A read: any seat of the caller's that is still in the room. Bearer or cookie alike. */
async function readConfig(
  request: Request, url: URL, sessionId: string, rawName: string, origin: string | undefined, deps: RoomRouteDeps, history: boolean,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (!isConfigName(rawName)) return problem(404, "not_found", `no config named "${rawName}"`, origin);
  const name: ConfigName = rawName;
  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const found = await deps.store.getSession(sessionId);
  const seat = found ? await findMember(deps.store, found, memberId, who.identity) : undefined;
  if (!found || !seat) return problem(404, "not_found", NOT_FOUND, origin);
  if (seat.leftAt !== null) return problem(403, "forbidden", "this seat has left the room", origin);

  if (!history) {
    const got = await getGovernedConfig(deps.store, sessionId, name);
    return json(200, {
      name, rev: got.rev, body: got.value,
      approver: got.approver === null ? null : { member_id: got.approver.memberId, label: got.approver.label },
    }, origin);
  }
  const rows = await deps.store.configHistory(sessionId, name);
  const revParam = url.searchParams.get("rev");
  if (revParam !== null) {
    const row = rows.find((r) => String(r.rev) === revParam);
    if (!row) return problem(404, "not_found", `revision ${revParam} is not kept`, origin);
    return json(200, { name, rev: row.rev, body: row.body, sha256: row.sha256, approver: approverOf(row), changed_at: row.changedAt }, origin);
  }
  return json(200, {
    name,
    revisions: rows.map((r) => ({ rev: r.rev, sha256: r.sha256, approver: approverOf(r), changed_at: r.changedAt })),
  }, origin);
}

/** A write or a restore: a dash session, the Origin check, the caller's own seat, `govern`, then the store. */
async function writeConfigRoute(
  request: Request, url: URL, sessionId: string, rawName: string, origin: string | undefined, deps: RoomRouteDeps, restore: boolean,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (who.via !== "cookie") {
    return problem(403, "dash_session_required", "room settings are changed by a person signed in to the dash, never with a bearer token", origin);
  }
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;
  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const found = await deps.store.getSession(sessionId);
  const seat = found ? await findMember(deps.store, found, memberId, who.identity) : undefined;
  if (!found || !seat) {
    return await adminWriteRefusal(deps.store, found, who.identity, origin) ?? problem(404, "not_found", NOT_FOUND, origin);
  }
  const gate = await gateSeat(deps.store, who.identity, sessionId, memberId, "govern");
  if (!gate.ok) return problem(STATUS[gate.code], gate.code, gate.reason, origin);
  const tooLong = lengthRefusal(request, MAX_CONFIG_WRITE_BYTES, "a config write", origin);
  if (tooLong) return tooLong;

  const raw: unknown = await request.json().catch(() => null);
  const keys = restore ? "base_rev,rev" : "base_rev,body";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).sort().join() !== keys) {
    return problem(400, "invalid_request", restore ? 'send {"rev": n, "base_rev": n}' : 'send {"body": {...}, "base_rev": n}', origin);
  }
  const req = raw as { body?: unknown; rev?: unknown; base_rev: unknown };
  if (!Number.isSafeInteger(req.base_rev) || (req.base_rev as number) < 0) {
    return problem(400, "invalid_request", "base_rev is the revision you read: 0 for none", origin);
  }
  let candidate: unknown = req.body;
  if (restore) {
    if (!isConfigName(rawName)) return problem(400, "invalid_request", `unknown config name "${rawName}"`, origin);
    const old = (await deps.store.configHistory(sessionId, rawName)).find((r) => r.rev === req.rev);
    if (!old) return problem(404, "not_found", `revision ${String(req.rev)} is not kept`, origin);
    candidate = old.body;
  }
  const parsed = parseConfigBody(rawName, candidate);
  if (!parsed.ok) return problem(400, "invalid_request", parsed.reason, origin);
  const { name, body } = parsed;

  const current = await getGovernedConfig(deps.store, sessionId, name);
  const narrowing = isNarrowing(name, current.value, body);
  const sha256 = bodyHash(body);
  const baseRev = req.base_rev as number;
  const session = gate.value;
  const result = await deps.store.writeConfig(sessionId, {
    name, body, sha256, bytes: bodyBytes(body), baseRev, narrowing,
    governance: { approvedBy: who.identity.userId, approverMemberId: memberId, approverLabel: seat.label, via: "dash_session", at: new Date().toISOString() },
  }, auditEntries(session, who.identity, "config_write", {
    name, rev: baseRev + 1, sha256, widening: !narrowing, via: "dash_session", ...(restore ? { restored_from: req.rev } : {}),
  }));
  if (result.ok) return json(200, { name, rev: result.rev }, origin);
  switch (result.reason) {
    case "stale":
      return json(409, { error: "stale", error_description: "the setting changed since you read it; read it again", current_rev: result.currentRev }, origin);
    case "over_reserve":
      return json(413, { error: "over_reserve", error_description: `a room's settings hold at most ${CONFIG_RESERVE_BYTES} bytes together; clearing one always succeeds`, reserve: CONFIG_RESERVE_BYTES }, origin);
    case "closed":
      return problem(409, "closed", "the room is closed", origin);
    case "not_found":
      return problem(404, "not_found", NOT_FOUND, origin);
  }
}
