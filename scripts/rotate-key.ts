#!/usr/bin/env node
/**
 * Rotate the Bellman bearer keys.
 *
 *   npm run rotate-key -- [--dry-run] [--print] [--no-claude] [--url <url>]
 *
 * A Worker secret cannot be read back, so there is no way to replace one key in
 * the map and keep the rest: the uploaded map has to be rebuilt from scratch.
 * This script therefore mints a FRESH key for every identity and uploads the
 * whole map — which is what you want after a leak anyway. The identities come
 * from ~/.config/bellman/identities.json, and the resulting map is written to
 * ~/.config/bellman/keys.json (mode 600) so you can hand keys out afterwards.
 *
 * Order matters: the previous map is backed up first, so a failed verification
 * has a one-line way back.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Identity, Plan, Role } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_DIR = process.env.BELLMAN_CONFIG_DIR ?? join(homedir(), ".config", "bellman");
const IDENTITIES_FILE = join(CONFIG_DIR, "identities.json");
const KEYS_FILE = join(CONFIG_DIR, "keys.json");
const BACKUP_FILE = `${KEYS_FILE}.bak`;
const DEFAULT_URL = "https://mcp.bellman.sh/mcp";

/** An identity plus where its key should be installed locally. */
export interface IdentitySpec extends Identity {
  /** Point the Claude Code `bellman` MCP entry at this identity's new key. */
  claude_code?: boolean;
}

const PLANS: Plan[] = ["free", "pro", "team"];
const ROLES: Role[] = ["member", "admin"];

export function newKey(): string {
  return `bk_${randomBytes(24).toString("hex")}`;
}

export function parseIdentities(raw: unknown): IdentitySpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("identities must be a non-empty array");
  }
  return raw.map((entry, i) => {
    const e = entry as Partial<IdentitySpec>;
    const at = `identity ${i}`;
    if (!e.userId) throw new Error(`${at}: userId is required`);
    if (!e.label) throw new Error(`${at}: label is required`);
    if (!e.plan || !PLANS.includes(e.plan)) throw new Error(`${at}: plan must be one of ${PLANS.join(", ")}`);
    if (!e.role || !ROLES.includes(e.role)) throw new Error(`${at}: role must be one of ${ROLES.join(", ")}`);
    if (e.orgId === undefined) throw new Error(`${at}: orgId is required (use null for no org)`);
    if ((e.plan === "team" || e.role === "admin") && e.orgId === null) {
      throw new Error(`${at}: a team/admin identity needs an orgId, or org scoping and audit can never apply`);
    }
    return {
      userId: e.userId, orgId: e.orgId, plan: e.plan, role: e.role, label: e.label,
      ...(e.claude_code ? { claude_code: true } : {}),
    };
  });
}

/** One fresh key per identity — the map uploaded as BELLMAN_KEYS. */
export function buildKeyMap(identities: IdentitySpec[]): Record<string, Identity> {
  const map: Record<string, Identity> = {};
  for (const { claude_code: _ignored, ...identity } of identities) {
    map[newKey()] = identity;
  }
  return map;
}

export function keyFor(
  map: Record<string, Identity>,
  identities: IdentitySpec[]
): string | undefined {
  const wanted = identities.find((i) => i.claude_code) ?? identities[0];
  if (!wanted) return undefined;
  return Object.keys(map).find((k) => map[k].userId === wanted.userId && map[k].label === wanted.label);
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, { cwd: REPO_ROOT, input, encoding: "utf8" });
}

async function verify(url: string, key: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "rotate-key", version: "0.1.0" },
      },
    }),
  });
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const print = argv.includes("--print");
  const skipClaude = argv.includes("--no-claude");
  const url = argv[argv.indexOf("--url") + 1]?.startsWith("http")
    ? argv[argv.indexOf("--url") + 1]
    : DEFAULT_URL;

  if (!existsSync(IDENTITIES_FILE)) {
    console.error(
      `No identities file at ${IDENTITIES_FILE}. Create it, for example:\n\n` +
        JSON.stringify(
          [{ userId: "u_you", orgId: "org_you", plan: "team", role: "admin", label: "you@org", claude_code: true }],
          null, 2
        ) + "\n"
    );
    process.exit(1);
  }

  const identities = parseIdentities(JSON.parse(readFileSync(IDENTITIES_FILE, "utf8")));
  const map = buildKeyMap(identities);
  const payload = JSON.stringify(map);
  const claudeKey = keyFor(map, identities);

  console.log(`Rotating ${identities.length} key(s) for ${url}`);
  for (const i of identities) console.log(`  ${i.label}  ${i.plan}/${i.role}  org=${i.orgId ?? "none"}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing uploaded. Map shape:");
    console.log(JSON.stringify(Object.fromEntries(Object.keys(map).map((k) => [`${k.slice(0, 7)}…`, map[k]])), null, 2));
    return;
  }

  // Back up before anything changes: this file is the way back.
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(KEYS_FILE)) copyFileSync(KEYS_FILE, BACKUP_FILE);

  console.log("\nUploading BELLMAN_KEYS…");
  const put = run("npx", ["wrangler", "secret", "put", "BELLMAN_KEYS"], payload);
  if (put.status !== 0) {
    console.error(put.stdout || "", put.stderr || "");
    console.error("Upload failed. Nothing changed on the server.");
    process.exit(1);
  }

  writeFileSync(KEYS_FILE, JSON.stringify(map, null, 2));
  chmodSync(KEYS_FILE, 0o600);
  console.log(`Wrote ${KEYS_FILE} (mode 600)`);

  // A secret change redeploys the Worker; give it a moment to take effect.
  console.log("\nVerifying…");
  let status = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    status = await verify(url, Object.keys(map)[0]);
    if (status === 200) break;
    await sleep(2000);
  }
  if (status !== 200) {
    console.error(`New key was rejected (HTTP ${status}).`);
    console.error(`Restore the previous map with:\n  npx wrangler secret put BELLMAN_KEYS < ${BACKUP_FILE}`);
    process.exit(1);
  }
  console.log("  new key accepted (HTTP 200)");

  const old = existsSync(BACKUP_FILE)
    ? (Object.keys(JSON.parse(readFileSync(BACKUP_FILE, "utf8")) as Record<string, Identity>)[0] ?? "")
    : "";
  if (old) {
    const oldStatus = await verify(url, old);
    console.log(
      oldStatus === 401
        ? "  previous key now rejected (HTTP 401)"
        : `  WARNING: previous key still returns HTTP ${oldStatus}`
    );
  }

  if (!skipClaude && claudeKey) {
    const claude = run("claude", ["--version"]);
    if (claude.status === 0) {
      run("claude", ["mcp", "remove", "bellman", "-s", "user"]);
      const add = run("claude", [
        "mcp", "add", "--scope", "user", "bellman",
        "-e", `BELLMAN_KEY=${claudeKey}`,
        "--", "node", join(REPO_ROOT, "dist", "channel.js"),
      ]);
      console.log(add.status === 0
        ? "  Claude Code MCP entry updated"
        : `  WARNING: could not update the Claude Code entry:\n${add.stderr}`);
    } else {
      console.log("  claude CLI not found — update the MCP entry yourself");
    }
  }

  console.log(print ? `\nKeys:\n${JSON.stringify(map, null, 2)}` : `\nDone. Keys are in ${KEYS_FILE} (--print to show them).`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(String(err));
    process.exit(1);
  });
}
