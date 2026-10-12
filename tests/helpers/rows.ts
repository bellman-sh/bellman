/**
 * A room as the Workers tests reach into its Durable Object storage (ADR 0019): the record,
 * which names the members in the room in `present`, and a row per member, `mb:<memberId>`.
 * Runtime-free, so both test programs can import it; it reads and writes through the slice of
 * storage it is handed.
 */
import type { Member } from "../../src/types.js";
import { MEMBER_PREFIX, loadPresent, memberKey, putRows, type RowReader } from "../../src/member-rows.js";
import { isActiveMember } from "../../src/store.js";

/** The slice of Durable Object storage these read and write. */
export interface RoomStorage extends RowReader {
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
}

/** The record with the members in the room now, in join order, as the object reads it; undefined for no room. */
export async function roomIn<T = Record<string, unknown>>(storage: RoomStorage): Promise<(T & { members: Member[] }) | undefined> {
  const record = await storage.get<T & { present: string[] }>("session");
  if (!record) return undefined;
  return { ...record, members: await loadPresent(storage, record.present) };
}

/** A member's row, in the room or gone from it. */
export const memberIn = (storage: RoomStorage, memberId: string): Promise<Member | undefined> =>
  storage.get<Member>(memberKey(memberId));

/**
 * Rewrite a room as a test needs it, in a state no call produces: `member` over every member
 * row, those who left included, and `record` over the record. The record's `present` is then
 * read from the rows, so a member the edit sends away or brings back is out of the room or in
 * it as its row says.
 */
export async function editRoom(
  storage: RoomStorage,
  edit: { member?: (m: Member) => Member; record?: (r: Record<string, unknown>) => Record<string, unknown> },
): Promise<void> {
  const record = await storage.get<Record<string, unknown>>("session");
  if (!record) throw new Error("editRoom: no room in this storage");
  const members = [...(await storage.list<Member>({ prefix: MEMBER_PREFIX })).values()].map(edit.member ?? ((m) => m));
  const present = members.filter(isActiveMember).sort((a, b) => a.seq - b.seq).map((m) => m.memberId);
  await putRows(storage, {
    ...Object.fromEntries(members.map((m) => [memberKey(m.memberId), m])),
    session: { ...(edit.record ? edit.record(record) : record), present },
  });
}
