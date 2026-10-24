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
  subject: { memberId: string; userId: string; label: string } | { questionCursor: number; origin: string; userId: string } | null;
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

/**
 * The filing times still inside the rolling day at `now` (R10). A time stops counting exactly `REPORT_WINDOW_MS` after
 * it was made. Both stores' limit and the purge's forgetting of a spent row ask this one question.
 */
export const withinWindow = (times: readonly number[], now: number): number[] =>
  times.filter((t) => now - t < REPORT_WINDOW_MS);

/**
 * Whether a report belongs in its room's creator's list (section 1C review, Critical 1): it is about a member or a message,
 * and not about the creator's own account. A report about the room has no subject. One about a seat the creator holds or a
 * message it sent names the creator's own user id, and a creator who read it would learn that a report was filed about them
 * and, in a small room, which of the others filed it. It reaches the operators alone. The hosted seat is Bellman's account
 * (`u_bellman_host`), so a report about it passes: the creator is who sets its instructions.
 *
 * Both stores ask this one question at the source: the Durable Objects store before it writes the creator's row, and
 * `MemoryStore` when it lists, so the two cannot answer differently.
 */
export const reachesCreator = (r: Pick<NewReport, "creatorId" | "subject">): boolean =>
  r.subject !== null && r.subject.userId !== r.creatorId;

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

/** Where a report's email comes from and goes to (R13). */
export const REPORT_FROM = "reports@bellman.sh";
export const REPORT_TO = "support@bellman.sh";

/** The words the email uses for a target. A closed set, like the reasons, so the email carries nothing a person typed. */
const TARGET_WORDS = { room: "the room", member: "a member", message: "a message" } as const satisfies Record<ReportTarget["kind"], string>;

/**
 * The message support@ is sent (R13), and it is a notice: the queue holds the rest. It names the report and when it was filed,
 * the room, what the report is about in a word, and why, and points at the queue's two routes. It carries no reporter, no
 * note, no label or id of the person reported and no creator. An inbox keeps what it is sent with no expiry, and the privacy
 * page promises a reporter's account and a note are kept 180 days after the report is resolved, so they stay in the queue,
 * where the purge deletes them.
 *
 * Every word is the server's: the id it made, the time it stamped, the room's id, and the closed sets of reasons and target
 * words. A note or a label that carries CR/LF, a `Subject:` line or markup cannot reach a header or the body.
 */
export function reportMail(r: Report): { subject: string; text: string } {
  const about = TARGET_WORDS[r.target.kind];
  return {
    subject: `Bellman report ${r.id}: ${r.reason}, ${about}`,
    text: [
      `Report ${r.id}, filed ${new Date(r.at).toISOString()}.`,
      `Room: ${r.sessionId}`,
      `About: ${about}`,
      `Reason: ${r.reason}`,
      "",
      `Read the queue at GET /admin/reports, and close this report at POST /admin/reports/${r.id}/resolve.`,
    ].join("\n"),
  };
}

/** The `send_email` binding as the mailer uses it: the builder form, `env.SEND_EMAIL.send({ from, to, subject, text })` (R13). */
export interface MailBinding {
  send(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Mails one report, and never rejects: a caller awaits it after the report is stored and needs no `try`. */
export type ReportMailer = (r: Report) => Promise<void>;

/**
 * Sends one message to support@. A missing binding (the Node server, or a Worker whose binding is not set up yet)
 * and a failed send are each logged once and swallowed: the report is stored before this runs and the queue is the
 * record, so an email that did not go must not fail the call that filed the report. The log names the report and
 * the binding's own answer (`whyNotSent`), and never carries the note.
 */
export function reportMailer(binding: MailBinding | undefined): ReportMailer {
  return async (r) => {
    if (!binding) {
      console.error(`report ${r.id}: no send_email binding, so no email went; the queue holds it`);
      return;
    }
    try {
      await binding.send({ from: REPORT_FROM, to: REPORT_TO, ...reportMail(r) });
    } catch (err) {
      console.error(`report ${r.id}: the email was not sent (${whyNotSent(err)}); the queue holds it`);
    }
  };
}

/**
 * What a failed send says, in the log line itself: the binding's `code` (`E_SENDER_DOMAIN_NOT_AVAILABLE` for a domain not
 * onboarded to Email Service, `E_SENDER_NOT_VERIFIED`, and the rest) and its `message`, whichever it gave. A deployment
 * whose email does not go is then diagnosed from this one line, with no stack to fetch. A thrown value with neither, a
 * string or `null` say, is named as it is. The report is not read here: the note is untrusted text and stays out of the log.
 */
export function whyNotSent(err: unknown): string {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  const given = [code, message].filter((part): part is string => typeof part === "string" && part !== "");
  return given.length > 0 ? given.join(": ") : String(err);
}

/** A target as a view writes it. */
export type ReportTargetView = { kind: "room" } | { kind: "member"; member_id: string } | { kind: "message"; cursor: number };

/** What a room's creator reads about a report: what it is about and why, and never who filed it (R12), nor when to the minute. */
export interface CreatorReportView {
  id: string;
  target: ReportTargetView;
  /** The member, or the message's sender: the id and label a creator can act on, and no user id. Null for the room. */
  about: { member_id: string; label: string } | { question_cursor: number; origin: string } | null;
  reason: ReportReason;
  note: string | null;
  /** ISO 8601, to the hour: the minutes, seconds and milliseconds are zero. A creator cannot match a report to one member's activity. */
  at: string;
  resolved: boolean;
}

/** What an operator reads: all of it, the reporter and the account reported included. */
export interface OperatorReportView {
  id: string;
  session_id: string;
  creator_id: string;
  target: ReportTargetView;
  about: { member_id: string; user_id: string; label: string } | { question_cursor: number; origin: string; user_id: string } | null;
  reason: ReportReason;
  note: string | null;
  filed_by: { user_id: string; label: string };
  /** ISO 8601. */
  at: string;
  /** ISO 8601, or null while the report is open. */
  resolved_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
}

const targetView = (t: ReportTarget): ReportTargetView =>
  t.kind === "member" ? { kind: "member", member_id: t.memberId }
  : t.kind === "message" ? { kind: "message", cursor: t.cursor }
  : { kind: "room" };

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** A time to the hour, as ISO 8601: the minutes, seconds and milliseconds zeroed (section 1C review, declined 5). */
function toTheHour(ms: number): string {
  const hour = new Date(ms);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

/** Built field by field, never by spreading the report: a field added to `Report` reaches no creator until it is named here. */
export function creatorReportView(r: Report): CreatorReportView {
  return {
    id: r.id,
    target: targetView(r.target),
    about: !r.subject ? null
      : "questionCursor" in r.subject ? { question_cursor: r.subject.questionCursor, origin: r.subject.origin }
      : { member_id: r.subject.memberId, label: r.subject.label },
    reason: r.reason,
    note: r.note,
    at: toTheHour(r.at),
    resolved: r.resolvedAt !== null,
  };
}

export function operatorReportView(r: Report): OperatorReportView {
  return {
    id: r.id,
    session_id: r.sessionId,
    creator_id: r.creatorId,
    target: targetView(r.target),
    about: !r.subject ? null
      : "questionCursor" in r.subject
        ? { question_cursor: r.subject.questionCursor, origin: r.subject.origin, user_id: r.subject.userId }
        : { member_id: r.subject.memberId, user_id: r.subject.userId, label: r.subject.label },
    reason: r.reason,
    note: r.note,
    filed_by: { user_id: r.reporterUserId, label: r.reporterLabel },
    at: new Date(r.at).toISOString(),
    resolved_at: isoOrNull(r.resolvedAt),
    resolution: r.resolution,
    resolved_by: r.resolvedBy,
  };
}
