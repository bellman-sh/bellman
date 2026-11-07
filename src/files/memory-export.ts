/**
 * The Markdown document `GET /me/memory/export` returns (#531, ADR 0047 decision 14): the account's home notes, then
 * its notes in each room, one section each. Runtime-free (imports only types), so the route and its test share it.
 *
 * Note content is written verbatim. It is the account's own notes served as a download, never rendered server-side,
 * so nothing is escaped; a peer's content never reaches it, since room notes are read from the account's own memory
 * path alone.
 */
import type { FsRow } from "../types.js";

export interface ExportRoom { sessionId: string; room: string; notes: FsRow[] }

const byPath = (a: FsRow, b: FsRow): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A peer-chosen room name on one line, so a newline in it cannot open a heading of its own. */
const oneLine = (name: string): string => name.replace(/\s+/g, " ").trim();

function note(heading: string, r: FsRow): string {
  return `${heading} ${r.path}\n\nRevision ${r.rev} · ${new Date(r.at).toISOString()}\n\n${r.content}\n\n---\n`;
}

/** The one Markdown document `GET /me/memory/export` returns. Note content is verbatim; headings carry the path, revision and time. */
export function renderExport(input: { label: string; at: number; home: FsRow[]; rooms: ExportRoom[] }): string {
  let md = `# Bellman memory export\n\nAccount: ${input.label}\nExported: ${new Date(input.at).toISOString()}\n\n## Home memory\n\n`;
  md += input.home.length === 0 ? "_No home notes._\n\n" : [...input.home].sort(byPath).map((r) => note("###", r)).join("\n") + "\n";
  md += "## Room notes\n\n";
  md += input.rooms.length === 0 ? "_No room notes._\n" : input.rooms.map((room) => `### ${oneLine(room.room)} (${room.sessionId})\n\n${[...room.notes].sort(byPath).map((r) => note("####", r)).join("\n")}`).join("\n");
  return md;
}
