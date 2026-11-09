/**
 * The seats this machine's bridges took from repos' default rooms (#603), so a session started again in the same
 * directory takes back the seat the last one left behind instead of joining with a new one.
 *
 * A bridge leaves its default-room seat when it closes cleanly (`leaveBoundSeats` in bridge.ts), but a session that
 * is killed, crashes, or has its MCP server restarted never gets there, and in a room with room to spare nothing
 * reclaims the seat: one room reached 113 seats of one account in a day. Each entry is the seat, where it was taken
 * (server, repo remote and directory), and the pid of the bridge holding it. A seat whose bridge is gone can be
 * claimed by the next bridge started in the same place.
 *
 * It lives beside the inbox and the bus (`~/.claude/bellman`): runtime state, not configuration. A file nobody can
 * read is an empty one, so the worst a damaged file costs is a fresh join, which is what happened before it existed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HeldSeat {
  url: string;
  remote: string;
  cwd: string;
  session_id: string;
  member_id: string;
  role: string;
  verbs: string[];
  /** The last cursor the holding bridge had delivered through, so a resume pages forward from there. */
  cursor: number;
  /** The bridge holding the seat. */
  pid: number;
}

/** Where a seat was taken: two bridges reuse each other's seat only when all three agree. */
export type SeatPlace = Pick<HeldSeat, "url" | "remote" | "cwd">;

export function seatsFile(): string {
  return process.env.BELLMAN_SEATS_FILE ?? join(homedir(), ".claude", "bellman", "default-seats.json");
}

function read(file: string): HeldSeat[] {
  try {
    const seats: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(seats) ? seats.filter((s): s is HeldSeat => typeof s?.member_id === "string") : [];
  } catch {
    return [];
  }
}

function write(file: string, seats: HeldSeat[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seats, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const samePlace = (s: HeldSeat, p: SeatPlace): boolean => s.url === p.url && s.remote === p.remote && s.cwd === p.cwd;

/** Whether a process is still running. EPERM is a live process that belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim a seat taken in `place` whose bridge is gone: it is re-held under `pid` before it is returned, so a second
 * bridge started a moment later finds it held. Undefined when there is none.
 *
 * ponytail: read-modify-write with no lock, so two bridges started in the same directory within the same few
 * milliseconds can both claim one seat; take the credential lock (credentials.ts `acquireLock`) around it if that
 * is ever seen.
 */
export function claim(file: string, place: SeatPlace, pid: number, alive: (pid: number) => boolean = pidAlive): HeldSeat | undefined {
  const seats = read(file);
  const found = seats.find((s) => samePlace(s, place) && s.pid !== pid && !alive(s.pid));
  if (!found) return undefined;
  const claimed = { ...found, pid };
  write(file, seats.map((s) => (s === found ? claimed : s)));
  return claimed;
}

/** Record a seat as held by `seat.pid`, replacing any entry for the same member. */
export function hold(file: string, seat: HeldSeat): void {
  write(file, [...read(file).filter((s) => s.member_id !== seat.member_id), seat]);
}

/** Move a held seat's cursor forward. A seat that is not recorded is left alone. */
export function advance(file: string, memberId: string, cursor: number): void {
  const seats = read(file);
  const found = seats.find((s) => s.member_id === memberId);
  if (!found || found.cursor >= cursor) return;
  write(file, seats.map((s) => (s === found ? { ...s, cursor } : s)));
}

/** Forget a seat: it was left, or it can no longer be taken back. */
export function release(file: string, memberId: string): void {
  const seats = read(file);
  if (seats.some((s) => s.member_id === memberId)) write(file, seats.filter((s) => s.member_id !== memberId));
}
