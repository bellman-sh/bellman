/**
 * A git remote as one key, for a repo's default room. Its own module, with no imports, because the bridge bundles it
 * (src/client/repo-remote.ts) and must not bundle the room's operations with it.
 */

/** The form `normalizeRemote` answers, `host/owner/repo` with a dotted host, taken back as it is. */
const NORMALIZED = /^([^\s/:@]+\.[^\s/:@]+)\/(.+)$/;
/** `scp`-style `user@host:path`, which `URL` does not parse. */
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;

/**
 * A git remote as `host/owner/repo`, lower-cased: the host without a user or port, the path without `.git` or a
 * trailing slash. Null for anything that is not an ssh, scp-style or http(s) remote with at least two
 * path segments, so a local path or a bare host never binds.
 */
export function normalizeRemote(raw: string): string | null {
  const text = raw.trim();
  let host: string;
  let path: string;
  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? null : SCP.exec(text) ?? NORMALIZED.exec(text);
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
  // Lower-cased whole: GitHub and GitLab match owner and repo without case, so a link copied from the browser binds.
  return [host, ...segments].join("/").toLowerCase();
}
