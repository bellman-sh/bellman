#!/usr/bin/env node
/**
 * Grant a signed-in human a plan.
 *
 *   npm run grant-plan -- --github <login> --plan team --role admin --org org_x
 *   npm run grant-plan -- --key google:<sub> --plan pro --role member --org none
 *   npm run grant-plan -- --email <addr>    --plan pro --role member --org none
 *   npm run grant-plan -- --list
 *   npm run grant-plan -- --revoke --github <login>
 *   npm run grant-plan -- --dry-run …          # show the merged map, upload nothing
 *
 * Signing in with GitHub or Google gets you the default identity — free plan,
 * member role, no org. BELLMAN_USERS names the people who get more, keyed by
 * upstream identity. It is a Worker secret, and a Worker secret cannot be read
 * back, so there is no way to merge one entry into the deployed map: it has to
 * be rebuilt and re-uploaded whole. The source of truth is therefore local,
 * ~/.config/bellman/users.json, exactly as identities.json is for BELLMAN_KEYS.
 *
 * The failure mode is quieter than a key rotation's and so worth more care. A
 * broken BELLMAN_KEYS locks everyone out loudly; a broken BELLMAN_USERS is
 * swallowed by parseOverrides and silently drops every granted human back to
 * free. Hence parseUsers below: the file is validated here, before upload,
 * because the server will not complain.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Identity, Plan, Role } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_DIR = process.env.BELLMAN_CONFIG_DIR ?? join(homedir(), ".config", "bellman");
const USERS_FILE = join(CONFIG_DIR, "users.json");
const BACKUP_FILE = `${USERS_FILE}.bak`;
const DEFAULT_URL = "https://mcp.bellman.sh/mcp";

const PLANS: Plan[] = ["free", "pro", "team"];
const ROLES: Role[] = ["member", "admin"];

/**
 * The prefixes identityFor tries, in its order. `github:<login>` resolves too,
 * so a hand-written file stays valid — this script just prefers the numeric id.
 */
const KEY_PREFIXES = ["github:", "google:", "email:"];

/** Who the grant is for, before the upstream id is known. */
export interface Subject {
  /** Set by --github: a handle that still needs resolving. */
  provider?: "github";
  handle?: string;
  /** Set by --key or --email: a key to write verbatim. */
  literal?: string;
}

export interface Grant extends Subject {
  plan: Plan;
  role: Role;
  orgId: string | null;
  label?: string;
  userId?: string;
}

export interface ResolvedGrant {
  key: string;
  identity: Identity;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseSubject(argv: string[]): Subject {
  const handle = flag(argv, "--github");
  const key = flag(argv, "--key");
  const email = flag(argv, "--email");
  const given = [handle, key, email].filter((v) => v !== undefined);

  if (given.length === 0) {
    throw new Error("name who the grant is for: --github <login>, --key <provider:id>, or --email <address>");
  }
  if (given.length > 1) throw new Error("give exactly one of --github, --key, --email");

  if (handle !== undefined) return { provider: "github", handle };
  return { literal: email !== undefined ? `email:${email}` : key };
}

export function parseGrant(argv: string[]): Grant {
  const subject = parseSubject(argv);
  const plan = flag(argv, "--plan") as Plan | undefined;
  const role = flag(argv, "--role") as Role | undefined;
  const org = flag(argv, "--org");
  const label = flag(argv, "--label");
  const userId = flag(argv, "--user-id");

  if (!plan || !PLANS.includes(plan)) throw new Error(`--plan must be one of ${PLANS.join(", ")}`);
  if (!role || !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
  if (org === undefined) throw new Error("--org is required (use --org none for no org)");

  const orgId = org === "none" ? null : org;
  // org_only scoping and the audit log both key off orgId. Same rule as rotate-key.
  if ((plan === "team" || role === "admin") && orgId === null) {
    throw new Error("a team/admin grant needs an orgId, or org scoping and audit can never apply");
  }

  return { ...subject, plan, role, orgId, ...(label ? { label } : {}), ...(userId ? { userId } : {}) };
}

/**
 * A users file the server would silently ignore has to fail here instead.
 * parseOverrides catches its own JSON error and returns {}, so uploading
 * anything malformed demotes every granted human without a word.
 */
export function parseUsers(raw: string | undefined): Record<string, Identity> {
  if (raw === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("users file is not valid JSON — the server would ignore it and everyone would drop to free");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("users file must be a JSON object of key → identity");
  }

  const users: Record<string, Identity> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_PREFIXES.some((p) => key.startsWith(p))) {
      throw new Error(`${key}: key must start with ${KEY_PREFIXES.join(", ")}`);
    }
    const e = value as Partial<Identity>;
    if (!e.userId) throw new Error(`${key}: userId is required`);
    if (!e.label) throw new Error(`${key}: label is required`);
    if (!e.plan || !PLANS.includes(e.plan)) throw new Error(`${key}: plan must be one of ${PLANS.join(", ")}`);
    if (!e.role || !ROLES.includes(e.role)) throw new Error(`${key}: role must be one of ${ROLES.join(", ")}`);
    if (e.orgId === undefined) throw new Error(`${key}: orgId is required (use null for no org)`);
    users[key] = { userId: e.userId, orgId: e.orgId, plan: e.plan, role: e.role, label: e.label };
  }
  return users;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * A GitHub login can be renamed and the old one re-registered by someone else;
 * the numeric id cannot. So a handle is resolved to `github:<id>` before it is
 * written, and only a literal --key skips the lookup. Google has no public
 * handle lookup, which is why there is no --google.
 */
export async function resolveSubjectKey(subject: Subject, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { literal, handle } = subject;
  if (literal !== undefined) {
    if (!KEY_PREFIXES.some((p) => literal.startsWith(p))) {
      throw new Error(`${literal}: key must start with ${KEY_PREFIXES.join(", ")}`);
    }
    return literal;
  }

  const res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(handle!)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "bellman-grant-plan" },
  });
  if (!res.ok) throw new Error(`no GitHub user named ${handle} (HTTP ${res.status})`);

  const user = (await res.json()) as { id?: number };
  if (!user.id) throw new Error(`GitHub returned no id for ${handle}`);
  return `github:${user.id}`;
}

export async function resolveKey(grant: Grant, fetchImpl: typeof fetch = fetch): Promise<ResolvedGrant> {
  const key = await resolveSubjectKey(grant, fetchImpl);
  const colon = key.indexOf(":");
  const [scheme, rest] = [key.slice(0, colon), key.slice(colon + 1)];

  return {
    key,
    identity: {
      // Byte-identical to what identityFor mints on the default path, or the
      // grant orphans every session this human created before it. An email:
      // grant has no provider to mirror, so it pins a userId of its own.
      userId: grant.userId ?? `u_${scheme}_${rest}`,
      orgId: grant.orgId,
      plan: grant.plan,
      role: grant.role,
      label: grant.label ?? (grant.handle ? `${grant.handle}@github` : scheme === "email" ? rest : key),
    },
  };
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export function mergeGrant(
  users: Record<string, Identity>,
  key: string,
  identity: Identity
): Record<string, Identity> {
  return { ...users, [key]: identity };
}

export function removeGrant(users: Record<string, Identity>, key: string): Record<string, Identity> {
  if (!(key in users)) throw new Error(`no grant for ${key} — nothing to revoke`);
  const { [key]: _removed, ...rest } = users;
  return rest;
}

export function formatUsers(users: Record<string, Identity>): string {
  const entries = Object.entries(users);
  if (entries.length === 0) return "  (no grants — everyone who signs in is free/member, no org)";
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([key, i]) => `  ${key.padEnd(width)}  ${i.plan}/${i.role}  org=${i.orgId ?? "none"}  ${i.label}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function readUsersFile(): Record<string, Identity> {
  return parseUsers(existsSync(USERS_FILE) ? readFileSync(USERS_FILE, "utf8") : undefined);
}

/**
 * There is no honest end-to-end check here. Confirming a BELLMAN_USERS entry
 * took effect needs a completed OAuth sign-in, which this script cannot drive.
 * So it checks only that the Worker came back up after the secret redeploy: an
 * unauthenticated request should be refused, not error.
 */
async function verifyHealthy(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "grant-plan", version: "0.1.0" },
      },
    }),
  });
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const url = argv[argv.indexOf("--url") + 1]?.startsWith("http") ? argv[argv.indexOf("--url") + 1] : DEFAULT_URL;
  const users = readUsersFile();

  if (argv.includes("--list")) {
    console.log(`${USERS_FILE}\n${formatUsers(users)}`);
    return;
  }

  let next: Record<string, Identity>;
  if (argv.includes("--revoke")) {
    const key = await resolveSubjectKey(parseSubject(argv));
    next = removeGrant(users, key);
    console.log(`Revoking ${key}`);
  } else {
    const { key, identity } = await resolveKey(parseGrant(argv));
    next = mergeGrant(users, key, identity);
    console.log(`Granting ${key}  ${identity.plan}/${identity.role}  org=${identity.orgId ?? "none"}`);
  }

  console.log(`\nBELLMAN_USERS after merge:\n${formatUsers(next)}`);
  if (dryRun) {
    console.log("\n--dry-run: nothing uploaded.");
    return;
  }

  // Back up before anything changes: this file is the way back.
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(USERS_FILE)) copyFileSync(USERS_FILE, BACKUP_FILE);

  console.log("\nUploading BELLMAN_USERS…");
  const put = spawnSync("npx", ["wrangler", "secret", "put", "BELLMAN_USERS"], {
    cwd: REPO_ROOT, input: JSON.stringify(next), encoding: "utf8",
  });
  if (put.status !== 0) {
    console.error(put.stdout || "", put.stderr || "");
    console.error("Upload failed. Nothing changed on the server.");
    process.exit(1);
  }

  writeFileSync(USERS_FILE, JSON.stringify(next, null, 2));
  chmodSync(USERS_FILE, 0o600);
  console.log(`Wrote ${USERS_FILE} (mode 600)`);

  // A secret change redeploys the Worker; give it a moment to take effect.
  console.log("\nVerifying the Worker came back…");
  let status = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    status = await verifyHealthy(url);
    if (status === 401) break;
    await sleep(2000);
  }
  console.log(
    status === 401
      ? "  reachable, unauthenticated requests refused (HTTP 401)"
      : `  WARNING: expected HTTP 401, got ${status}`
  );
  if (status >= 500) {
    console.error(`Restore the previous map with:\n  npx wrangler secret put BELLMAN_USERS < ${BACKUP_FILE}`);
    process.exit(1);
  }

  console.log("\nDone. The grant applies the next time that human signs in.");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
