/**
 * Governed room config (#414): the closed set of config names, their strict schemas, and what each reads as when
 * it is missing or untrustworthy. Runtime-free, as decision.ts is, so both stores, the routes and the tools share
 * one definition. A new name is one entry here plus the consumer that reads it.
 */
import { z } from "zod";
import { canonical } from "./decision.js";
import { createHash } from "node:crypto";
import type { ConfigName, ConfigRow } from "./types.js";
import type { BellmanStore } from "./store.js";

export const CONFIG_NAMES = ["room_instructions"] as const satisfies readonly ConfigName[];

/** Every config body in a room, together. A narrowing write is accepted even past it. */
export const CONFIG_RESERVE_BYTES = 64 * 1024;
/** Room instructions are delivered to agents up to this many UTF-8 bytes; the rest is read in the dash. */
export const ROOM_INSTRUCTIONS_DELIVERY_BYTES = 8 * 1024;
/** History rows kept per name. */
export const CONFIG_HISTORY = 20;

const RoomInstructionsBody = z.object({ markdown: z.string().max(65_536) }).strict();
export type RoomInstructionsBody = z.infer<typeof RoomInstructionsBody>;

const SCHEMAS: Record<ConfigName, z.ZodType<RoomInstructionsBody>> = {
  room_instructions: RoomInstructionsBody,
};

export const isConfigName = (name: string): name is ConfigName =>
  (CONFIG_NAMES as readonly string[]).includes(name);

/** Strict: unknown names and unknown keys, `governance` included, are refused. */
export function parseConfigBody(
  name: string,
  raw: unknown,
): { ok: true; name: ConfigName; body: RoomInstructionsBody } | { ok: false; reason: string } {
  if (!isConfigName(name)) return { ok: false, reason: `unknown config name "${name}" (known: ${CONFIG_NAMES.join(", ")})` };
  const parsed = SCHEMAS[name].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `${name}: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, name, body: parsed.data };
}

/**
 * Whether `next` only narrows what the room had. Narrowing is accepted past the reserve; anything else is recorded
 * as widening. Room instructions have no width, so only clearing them narrows.
 */
export function isNarrowing(name: ConfigName, _prev: unknown | null, next: unknown): boolean {
  switch (name) {
    case "room_instructions":
      return (next as RoomInstructionsBody).markdown === "";
  }
}

/** What a name reads as when its row is missing, invalid or unapproved: the most restrictive value. */
export function restrictive(name: ConfigName): null {
  switch (name) {
    case "room_instructions":
      return null;
  }
}

/** sha256 hex of the canonical body, so key order never changes it. */
export const bodyHash = (body: unknown): string => createHash("sha256").update(canonical(body)).digest("hex");

/** UTF-8 bytes of the canonical body. */
export const bodyBytes = (body: unknown): number => new TextEncoder().encode(canonical(body)).length;

/** Cut room instructions to 8 KiB on a character boundary, and say how much more the dash holds. */
export function truncateForDelivery(markdown: string): { content: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.length <= ROOM_INSTRUCTIONS_DELIVERY_BYTES) return { content: markdown, truncated: false };
  let kept = "";
  let used = 0;
  for (const ch of markdown) {
    const n = new TextEncoder().encode(ch).length;
    if (used + n > ROOM_INSTRUCTIONS_DELIVERY_BYTES) break;
    kept += ch;
    used += n;
  }
  return {
    content: `${kept}\n\n[truncated: ${bytes.length - used} bytes more; read the full text in the dash]`,
    truncated: true,
  };
}

/** What a governed config name reads as. `approver` is the approving seat; the approver's user id never leaves. */
export interface GovernedValue {
  value: RoomInstructionsBody | null;
  rev: number;
  approver: { memberId: string; label: string } | null;
  /** The fields a clamp narrowed. None today: no manifest block or org policy field covers a name yet (#397). */
  clamped: string[];
}

/**
 * The one reader of governed config (#414; `tests/delivery-paths.test.ts` pins it). A missing row, a body its
 * schema refuses, or a row without server-written governance reads as the most restrictive value, so nothing a
 * row holds is trusted unless the dash route wrote it. Cleared room instructions read as none.
 */
export async function getGovernedConfig(store: BellmanStore, sessionId: string, name: ConfigName): Promise<GovernedValue> {
  const row = await store.getConfigRow(sessionId, name);
  const none: GovernedValue = { value: restrictive(name), rev: row?.rev ?? 0, approver: null, clamped: [] };
  if (row === null) return { ...none, rev: 0 };
  const g = row.governance as Partial<ConfigRow["governance"]> | undefined;
  if (!g || g.via !== "dash_session" || !g.approvedBy || !g.approverMemberId) return none;
  const parsed = parseConfigBody(name, row.body);
  if (!parsed.ok || parsed.body.markdown === "") return none;
  return { value: parsed.body, rev: row.rev, approver: { memberId: g.approverMemberId, label: g.approverLabel ?? "" }, clamped: [] };
}

