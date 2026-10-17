/**
 * Reports (abuse protections spec, section 3): what a member, or a signed-in reader of a public room, files about a
 * room, a member or a message, and the queue an operator works through.
 *
 * It imports nothing, as bans.ts does, so the stores, the tools and the HTTP routes can all reach these types
 * without one of them pulling in another's dependencies.
 */

/** Why a report is filed. A closed set, so an email's subject is built from it and never from the note. */
export const REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** What a report is about: the room, one member, or one message by its cursor. */
export type ReportTarget = { kind: "room" } | { kind: "member"; memberId: string } | { kind: "message"; cursor: number };

/** A note is untrusted text, however long it is kept: this is the most a report takes. */
export const MAX_REPORT_NOTE_CHARS = 500;
/** What one account may file in a rolling `REPORT_WINDOW_MS` (R10). A fold into an open report is not counted (R9). */
export const REPORTS_PER_DAY = 10;
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a report is kept once it is resolved. An unresolved one stays (R15). */
export const REPORT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** The name the registry's one alarm runs the deletion of resolved reports under (R15). */
export const REPORT_PURGE_HANDLER = "report_purge";

/** What a filer hands the store: the report before it has an id, a time or a resolution. */
export interface NewReport {
  sessionId: string;
  creatorId: string;
  target: ReportTarget;
  /** Whom a member or message report is about (R12), so an operator can suspend the account; null for the room. */
  subject: { memberId: string; userId: string; label: string } | null;
  reason: ReportReason;
  note: string | null;
  reporterUserId: string;
  reporterLabel: string;
}

/** A report as the registry keeps it. Resolving stamps the last three fields once, and the first resolution stands. */
export interface Report extends NewReport {
  id: string;
  at: number;
  resolvedAt: number | null;
  resolution: string | null;
  resolvedBy: string | null;
}

/**
 * The store's answer to a filing: `filed` is a new report, and the one a caller emails about. `folded` is a repeat of a
 * target the same account already has open, answered with that report, and writes nothing. `limited` is the account's
 * 10 a day, with how long until its oldest filing leaves the window.
 */
export type FiledReport = { outcome: "filed" | "folded"; report: Report } | { outcome: "limited"; retryAfterMs: number };

/** "room", "member:<id>" or "message:<cursor>": what makes two reports of one target the same. */
export function targetKey(t: ReportTarget): string {
  switch (t.kind) {
    case "room":
      return "room";
    case "member":
      return `member:${t.memberId}`;
    case "message":
      return `message:${t.cursor}`;
  }
}

/**
 * `rpt_`, the time padded to 15 digits, `_`, and 8 random hex characters: string order is filing order, which is
 * what lets the queue be a key listing. Padded, because unpadded "10000" sorts before "9999".
 */
export function reportId(at: number): string {
  return `rpt_${String(at).padStart(15, "0")}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}
