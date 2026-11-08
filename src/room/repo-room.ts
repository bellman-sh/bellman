/**
 * A repo's default room (docs/superpowers/specs/2026-11-08-repo-default-room-design.md): an account binds a git
 * remote to a room it created, and its sessions started in that repo join the room at launch. Runtime-free.
 */

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
