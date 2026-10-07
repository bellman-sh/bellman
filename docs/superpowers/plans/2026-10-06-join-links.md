# Join Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A join code can be shared as `https://bellman.sh/j/<code>` — a link that is clickable in chat, unfurls with a title, and tells a person what to say to their agent — and `bellman_start` and `bellman_invite` return that link beside the code.

**Architecture:** The page is rendered by the site's Cloudflare Worker from the URL alone — it never calls the server, so an unfurl bot fetching it consumes and reveals nothing. The Worker fills a static template (`public/_join.html`) and answers 301 for non-canonical spellings and 404 for anything that is not a code. The server's only change is a `joinUrl()` helper and a `join_url` field on two tool returns.

**Tech Stack:** Site — Cloudflare Workers (vanilla ESM JavaScript, `worker.js`), static assets, tests with Node 22's built-in `node:test`, git. Server — TypeScript, zod, vitest, the in-memory MCP harness (`tests/helpers/harness.ts`), jj.

**Spec:** `docs/superpowers/specs/2026-10-06-join-links-design.md`

## Global Constraints

- The page makes **no request to any server**. It is a pure function of the URL (spec, *The constraint that decides the design*).
- Route regex, applied after percent-decoding and normalisation, exactly: `^BELL-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}(?:-[A-Z][A-Z0-9-]{0,30})?$` (D2).
- Normalisation is `normalizeJoinCode`'s: trim, upper-case, strip whitespace, `_` → `-` (D3).
- Join-code TTL is 15 minutes: `JOIN_CODE_TTL_MS = 15 * 60 * 1000` in `src/store.ts`. The page states "15 minutes" as the homepage does.
- `JOIN_URL_BASE = "https://bellman.sh/j/"` — one constant, not configuration (D9).
- Response headers on a rendered page: `Cache-Control: public, max-age=300`, `X-Robots-Tag: noindex`; `<meta name="robots" content="noindex">` in the page (D6, D8).
- The page shows no room name, purpose, creator or brief (D4).
- Copy: a room holds members, not two — never "the other session", "both sessions", "pairs". No phrase from `~/.claude/projects/-Users-mcfearsome-src-github-com-bellman-sh-bellman/memory/banned-phrases.md`.
- Every new assertion is run against a broken implementation before it counts (spec, *Testing*).
- Bellman: `main` moves only through merges; work on `mcfearsome/join-links` with jj; commits must be signed (repo-local signing is configured; check `git cat-file commit <id> | grep -c 'BEGIN SSH SIGNATURE'` is 1 before pushing).

## Review Focus

1. **A trailing slash or a query string** — `/j/BELL-7F3K-92-REVIEWER/` and `/j/BELL-7F3K-92-REVIEWER?utm_source=slack`. A person expects the page; an unfurl cache expects one URL per code. Both must 301 to the canonical URL. *(Task 7)*
2. **A `HEAD` request** — unfurlers often HEAD before GET. Must answer 200 with the same headers as GET, not 404 or 405. *(Task 7)*
3. **`bellman_invite` with `revoke: true`** — returns `join_code: null`; it must return no `join_url`, never `https://bellman.sh/j/null`. *(Task 3)*
4. **A role group at the maximum, 31 characters** — `BELL-7F3K-92-A` + 30 more. Must render, not 404, and display the role whole. *(Task 7)*
5. **An empty role group** — `/j/BELL-7F3K-92-` (trailing hyphen, nothing after). Not a code; must 404, not render a page with an empty role. *(Task 7)*

---

## Part A — Server (`bellman-sh/bellman`, branch `mcfearsome/join-links`)

The spec commit is already the tip of `mcfearsome/join-links`. Start a child change for the implementation:

```bash
cd ~/src/github.com/bellman-sh/bellman
jj new mcfearsome/join-links -m "wip: join links, server"
```

Each task ends with `jj commit -m "<message>"`, which commits the working copy and opens a new empty change on top. The bookmark is moved once, in Task 4.

### Task 1: `joinUrl` in `src/codes.ts`

**Files:**
- Modify: `src/codes.ts` (append after `normalizeJoinCode`)
- Test: `tests/codes.test.ts`

**Interfaces:**
- Consumes: `renderJoinCode(role)` from `src/codes.ts` (exists).
- Produces: `export const JOIN_URL_BASE: string` and `export function joinUrl(code: string): string`, used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/codes.test.ts`, and add `joinUrl, JOIN_URL_BASE` to the existing import from `../src/codes.js`:

```ts
describe("join links", () => {
  /** The page is rendered from the code alone, so the code must arrive in the URL untouched. */
  it("prefixes the base and changes nothing else", () => {
    const code = renderJoinCode("reviewer");
    expect(joinUrl(code)).toBe(`https://bellman.sh/j/${code}`);
    expect(JOIN_URL_BASE).toBe("https://bellman.sh/j/");
  });

  it("puts the whole code in the last path segment, hyphens and all", () => {
    const code = renderJoinCode("peer_a"); // renders as ...-PEER-A
    const url = new URL(joinUrl(code));
    expect(url.hostname).toBe("bellman.sh");
    expect(url.pathname).toBe(`/j/${code}`);
    expect(url.search).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/codes.test.ts`
Expected: FAIL — `joinUrl` / `JOIN_URL_BASE` are not exported (a TypeScript error at import, or `undefined is not a function`).

- [ ] **Step 3: Implement**

Append to `src/codes.ts`:

```ts
/**
 * The page a join code is shared as. bellman.sh renders it from the code
 * alone — it never calls back here — so a self-hosted server's codes get the
 * same page. One constant, not configuration: an operator who wants their own
 * page changes this line. Spec: docs/superpowers/specs/2026-10-06-join-links-design.md, D9.
 */
export const JOIN_URL_BASE = "https://bellman.sh/j/";

export function joinUrl(code: string): string {
  return `${JOIN_URL_BASE}${code}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/codes.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Mutation check**

Change the base to `"https://bellman.sh/join/"`, run the file, see both new tests fail, change it back. Run again: PASS.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: joinUrl, the page a join code is shared as"
```

### Task 2: `bellman_start` returns `join_url`

**Files:**
- Modify: `src/tools/start.ts` — the `Returns:` line in the description, and the `ok({...})` block that returns `join_code`
- Test: `tests/tools/join-links.test.ts` (create)

**Interfaces:**
- Consumes: `joinUrl(code)` from Task 1.
- Produces: `bellman_start`'s result gains `join_url: string`, equal to `joinUrl(join_code)`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/join-links.test.ts`:

```ts
/**
 * A join code is shared as a link, and the link must carry the code
 * unchanged: the page it opens is rendered from the URL alone, so a code the
 * server mints and the code a person reads on the page are the same string.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
import { joinUrl } from "../../src/codes.js";

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

describe("bellman_start", () => {
  it("returns the link the code is shared as", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    expect(started.data.join_url).toBe(joinUrl(String(started.data.join_code)));
    expect(String(started.data.join_url)).toMatch(/^https:\/\/bellman\.sh\/j\/BELL-/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/join-links.test.ts`
Expected: FAIL — `expected undefined to be 'https://bellman.sh/j/BELL-…'`.

- [ ] **Step 3: Implement**

In `src/tools/start.ts`:

Add to the imports from `"../codes.js"` (the file already imports `renderJoinCode` and `generateSessionId` from there): `joinUrl`.

In the description string, change the `Returns:` line to:

```
Returns: { session_id, member_id, join_code, join_url, join_code_expires_at, session_expires_at, plan, room: {preset, mode, your_role, your_verbs, heartbeat_on_seconds, you_report, creator_role, roles, text (untrusted envelope)} }
```

In the `ok({...})` block, directly after `join_code: defaultCode.code,` add:

```ts
        // The same code, as a link: clickable in chat, and it tells the person
        // who opens it what to say to their agent. The page is rendered from
        // the URL alone, so sharing the link reveals nothing the code does not.
        join_url: joinUrl(defaultCode.code),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools/join-links.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Change the new line to `join_url: joinUrl("BELL-0000-00"),`, run, see the test fail, change it back. Run: PASS.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: bellman_start returns join_url beside join_code"
```

### Task 3: `bellman_invite` returns `join_url`, and says so in `share_instructions`

**Files:**
- Modify: `src/tools/invite.ts` — the `Returns:` line, the `ok({...})` block for an issue, and its `share_instructions`
- Test: `tests/tools/join-links.test.ts` (extend)

**Interfaces:**
- Consumes: `joinUrl(code)` from Task 1.
- Produces: `bellman_invite`'s issue result gains `join_url: string`; its `share_instructions` contains that link. The revoke result is unchanged and has no `join_url`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/join-links.test.ts`:

```ts
describe("bellman_invite", () => {
  it("returns the link, and leads the sharing instructions with it", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }),
    });
    const issued = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, role: "helper",
    });
    expect(issued.isError, issued.text).toBe(false);

    const url = String(issued.data.join_url);
    expect(url).toBe(joinUrl(String(issued.data.join_code)));
    expect(String(issued.data.share_instructions)).toContain(url);
    expect(String(issued.data.share_instructions)).toContain(String(issued.data.join_code));
    expect(String(issued.data.share_instructions)).toContain('"helper"');
  });

  // Review Focus 3: a revoke returns join_code: null and must not invent a link for it.
  it("returns no link when revoking", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }),
    });
    const revoked = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, revoke: true,
    });
    expect(revoked.isError, revoked.text).toBe(false);
    expect(revoked.data.revoked).toBe(true);
    expect("join_url" in revoked.data).toBe(false);
    expect(JSON.stringify(revoked.data)).not.toContain("bellman.sh/j/");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/join-links.test.ts`
Expected: the first `bellman_invite` case FAILS (`expected 'undefined' to be 'https://bellman.sh/j/…'`). The revoke case PASSES already — that is expected; it is a guard against Step 3 going wrong, and Step 5 proves it can fail.

- [ ] **Step 3: Implement**

In `src/tools/invite.ts`:

Add the import: `import { joinUrl } from "../codes.js";`

Change the `Returns:` line in the description to:

```
Returns: { join_code, join_url, join_code_expires_at, role, replaced_previous, share_instructions } or { revoked: true, roles }
```

Replace the issue-path `ok({...})` block with:

```ts
      const url = joinUrl(r.value.code);
      return ok({
        join_code: r.value.code,
        join_url: url,
        join_code_expires_at: new Date(r.value.expiresAt).toISOString(),
        role: r.value.role,
        replaced_previous: r.value.replacedPrevious,
        share_instructions:
          `Share this link with the joining session's human: ${url} — the page tells them what to say to their agent. ` +
          `The code in it, ${r.value.code}, seats them as "${r.value.role}". ` +
          `Any code issued earlier for that role has stopped working; other roles' codes are unaffected.`,
      });
```

The revoke path (`ok({ revoked: true, roles: r.value.roles, join_code: null })`) is not touched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/join-links.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mutation checks**

(a) In the revoke path, add `join_url: joinUrl("x"),` — run, see "returns no link when revoking" fail, remove it.
(b) In `share_instructions`, delete `${url}` — run, see the first case fail, restore it.
Run: PASS.

- [ ] **Step 6: Run the whole invite suite, since the return shape changed**

Run: `npx vitest run tests/tools/invite.test.ts tests/tools/join-links.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: bellman_invite returns join_url, and shares the link first"
```

### Task 4: README, full verification, push, PR

**Files:**
- Modify: `README.md` — line 5 (the sentence introducing the code) and the `bellman_invite` row of the tool table (line 27)

**Interfaces:** none — prose.

- [ ] **Step 1: Edit the README**

Line 5 currently reads, in part:

```
One session starts a room and gets a human-relayable code that carries a role (`BELL-7F3K-92-PEER-B`). Any other MCP-connected session …
```

Change it to:

```
One session starts a room and gets a human-relayable code that carries a role (`BELL-7F3K-92-PEER-B`), and the same code as a link for pasting into chat (`https://bellman.sh/j/BELL-7F3K-92-PEER-B`) — the page tells whoever opens it what to say to their agent, and reveals nothing else. Any other MCP-connected session …
```

The `bellman_invite` row of the tool table currently ends `Issuing needs the `invite` verb; revoking needs `revoke`. |`. Append one sentence before the closing pipe:

```
Returns the code and the link it is shared as. |
```

- [ ] **Step 2: Run the whole gate**

Run: `npm run verify`
Expected: exit 0 — both typechecks, build, Node tests, Worker tests. If the Worker suite reports an unhandled-error red with every test green, check whether main fails the same way before treating it as yours (`ci-red-with-every-test-green` in memory).

- [ ] **Step 3: Commit, move the bookmark, confirm signing, push**

```bash
jj commit -m "docs: the README says a code is also a link"
jj bookmark set mcfearsome/join-links -r @-
git cat-file commit "$(jj log -r @- --no-graph -T commit_id)" | grep -c 'BEGIN SSH SIGNATURE'   # expect 1
jj git push --bookmark mcfearsome/join-links
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head mcfearsome/join-links \
  --title "Join links: the code, as a page a person can open" \
  --body "$(cat <<'BODY'
A join code can now be shared as `https://bellman.sh/j/<code>`. `bellman_start`
and `bellman_invite` return `join_url` beside `join_code`, and `bellman_invite`'s
`share_instructions` leads with the link.

The page is the site's: rendered from the URL alone, never calling this server,
so an unfurl bot fetching a pasted link consumes and reveals nothing. Spec in
`docs/superpowers/specs/2026-10-06-join-links-design.md`; the page itself is a
PR on bellman-sh/bellman.sh, linked below.

Mutations: a changed base fails `tests/codes.test.ts`; a wrong code in
`bellman_start`'s `join_url` fails `tests/tools/join-links.test.ts`; a link
invented on the revoke path fails the same file; a `share_instructions` that
drops the link fails it too.

No new tool, so `extension/manifest.json` is untouched.
BODY
)"
```

Record the PR number; Task 8 cross-links it.

---

## Part B — Site (`bellman-sh/bellman.sh`, branch `join-links`)

```bash
cd ~/src/github.com/bellman-sh/site
git fetch -q origin && git switch -c join-links origin/main
```

### Task 5: A test harness for the Worker, proving the existing redirect

**Files:**
- Create: `tools/test_worker.mjs`

**Interfaces:**
- Produces: the stub `env` (an `ASSETS` binding that serves `public/`) and the helper `get(pathAndQuery, init?)`, used by every later site test. `worker.js`'s default export is imported as `worker`.

- [ ] **Step 1: Write the harness and one test that passes against today's Worker**

Create `tools/test_worker.mjs`:

```js
// Tests for worker.js. Run: node --test tools/
//
// The Worker is plain ESM, so Node imports it directly. The one thing it
// needs from the platform is the ASSETS binding; `env` below stands in for
// it by serving files out of public/, and answering 404 for anything else,
// which is what the real binding does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// wrangler.toml sets not_found_handling = "404-page", so the real binding
// answers a missing path with public/404.html at status 404. The stub does
// the same, which is what lets a request that falls through the Worker
// untouched still land on the site's 404 in these tests.
function assetsFrom(dir, { missing = [] } = {}) {
  const html = { "content-type": "text/html; charset=utf-8" };
  const notFound = async () =>
    new Response(await readFile(path.join(dir, "404.html")), { status: 404, headers: html });
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (missing.includes(pathname)) return notFound();
      try {
        return new Response(await readFile(path.join(dir, pathname)), { status: 200, headers: html });
      } catch {
        return notFound();
      }
    },
  };
}

export const env = { ASSETS: assetsFrom(path.join(ROOT, "public")) };

export const get = (pathAndQuery, init = {}) =>
  worker.fetch(new Request(`https://bellman.sh${pathAndQuery}`, init), env);

export const notFoundBody = () => readFile(path.join(ROOT, "public", "404.html"), "utf8");

test("www redirects to the apex, carrying the path", async () => {
  const res = await worker.fetch(new Request("https://www.bellman.sh/pricing"), env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://bellman.sh/pricing");
});

test("a static asset is served through the binding", async () => {
  const res = await get("/404.html");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Not found/);
});

export { assetsFrom };
```

- [ ] **Step 2: Run it**

Run: `node --test tools/`
Expected: 2 passing. (Node's test runner only picks up files matching `test*`/`*test*`; `test_worker.mjs` matches. The Python test file is ignored by Node.)

- [ ] **Step 3: Positive control for the harness**

In `worker.js`, temporarily change `url.hostname = "bellman.sh"` to `url.hostname = "bellman.com"`. Run: the redirect test FAILS. Revert. Run: PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/test_worker.mjs
git commit -m "test: a harness for worker.js, and the www redirect pinned"
```

### Task 6: The template, `public/_join.html`

**Files:**
- Create: `public/_join.html`
- Test: `tools/test_worker.mjs` (extend — a static check on the file)

**Interfaces:**
- Produces: a file with the text placeholders `{{CODE}}`, `{{ROLE}}`, `{{ROLE_SUFFIX}}` and the block markers `<!--role-->` … `<!--/role-->`, consumed by Task 7's `joinPage`.

- [ ] **Step 1: Write the failing test**

Append to `tools/test_worker.mjs`:

```js
test("the join template carries every placeholder the Worker fills", async () => {
  const tpl = await readFile(path.join(ROOT, "public", "_join.html"), "utf8");
  for (const needle of ["{{CODE}}", "{{ROLE}}", "{{ROLE_SUFFIX}}", "<!--role-->", "<!--/role-->"]) {
    assert.ok(tpl.includes(needle), `template is missing ${needle}`);
  }
  assert.ok(tpl.includes('<meta name="robots" content="noindex">'), "template must not be indexed");
  assert.ok(tpl.includes('<link rel="icon" href="/icon.svg" type="image/svg+xml">'), "template uses the site icon");
  // Every <!--role--> opens a block that closes.
  assert.equal((tpl.match(/<!--role-->/g) ?? []).length, (tpl.match(/<!--\/role-->/g) ?? []).length);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/`
Expected: FAIL — `ENOENT … public/_join.html`.

- [ ] **Step 3: Write the template**

Create `public/_join.html`. The chrome is the homepage's (`public/index.html`): same `<head>` links, the same `.bar` header, the same `.foot` footer, `site.js` for the copy buttons.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Filled by worker.js for /j/<code>: {{CODE}}, {{ROLE}}, {{ROLE_SUFFIX}}
     are substituted, and <!--role--> blocks are removed when the code has no
     role group. Requesting this file directly answers 404. -->
<title>Join{{ROLE_SUFFIX}} &mdash; Bellman</title>
<meta name="description" content="You have been given a Bellman join code. Open this with your agent and it joins the room. Single use, 15 minutes.">
<meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bellman">
<meta property="og:title" content="Join a Bellman room{{ROLE_SUFFIX}}">
<meta property="og:description" content="Open this with your agent and it joins the room. Single use, 15 minutes.">
<meta property="og:image" content="https://bellman.sh/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Join a Bellman room{{ROLE_SUFFIX}}">
<meta name="twitter:description" content="Open this with your agent and it joins the room. Single use, 15 minutes.">
<meta name="twitter:image" content="https://bellman.sh/og.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400;12..96,75..100,600;12..96,75..100,800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>

<a class="skip" href="#join">Skip to the code</a>

<header class="bar">
  <a class="bar__mark" href="/">
    <svg class="bar__bell" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7c-3.6 0-6 2.5-6 6v4.2L8 20v1.6h16V20l-2-2.8V13c0-3.5-2.4-6-6-6Zm0 18a2.4 2.4 0 0 0 2.3-1.8h-4.6A2.4 2.4 0 0 0 16 25Z"/></svg>
    bellman
  </a>
  <nav class="bar__nav" aria-label="Site">
    <a href="/#install">Install</a>
    <a href="/compare/">Compare</a>
    <a href="/pricing">Pricing</a>
    <a href="https://github.com/bellman-sh/bellman">Repo</a>
  </nav>
</header>

<main>

<section class="hero hero--short" id="join">
  <p class="eyebrow">You have been invited</p>
  <h1 class="hero__title">Join the room</h1>
  <p class="hero__lede">
    Someone has opened a Bellman room to you. Give this code to your agent and
    it joins &mdash; from Claude Code, Claude Desktop, ChatGPT, Cursor, or any
    client that speaks MCP.
  </p>
</section>

<section class="section">
  <div class="keycard" aria-label="Join code {{CODE}}">
    <div class="keycard__head">
      <span>Room key</span>
      <!--role--><span class="keycard__mode">{{ROLE}}</span><!--/role-->
    </div>
    <div class="keycard__code">{{CODE}}</div>
    <div class="keycard__foot">
      <span>single use</span>
      <span class="keycard__punch" aria-hidden="true"></span>
      <span>15 minutes</span>
    </div>
  </div>
  <!--role-->
  <p>
    This code seats you as <code>{{ROLE}}</code>. The room decides what that
    seat may do, and your agent shows you before you join.
  </p>
  <!--/role-->
</section>

<section class="section">
  <h2>What to say</h2>
  <p>Tell your agent:</p>
  <pre><code>Join the Bellman room {{CODE}}</code></pre>
  <button class="copy" type="button" data-copy="{{CODE}}">Copy the code</button>
  <p>
    Your agent previews the room &mdash; who opened it, and what your seat may
    do &mdash; and joins only when you say so. Nothing of yours crosses until
    then.
  </p>
</section>

<section class="section">
  <h2>No Bellman yet?</h2>
  <p>One command, then say the line above.</p>
  <pre><code>curl -fsSL https://bellman.sh/install.sh | sh</code></pre>
  <button class="copy" type="button" data-copy="curl -fsSL https://bellman.sh/install.sh | sh">Copy</button>
  <p class="fine">
    Read the script first &mdash; it is about 230 lines of POSIX shell, and
    <code>--dry-run</code> prints every step without touching your machine.
    <a href="/#install">More about installing.</a>
  </p>
</section>

</main>

<footer class="foot">
  <div class="foot__row">
    <span class="foot__mark">bellman</span>
    <nav aria-label="Footer">
      <a href="/">Home</a>
      <a href="/compare/">Compare</a>
      <a href="/pricing">Pricing</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds</a>
      <a href="/contact">Contact</a>
    </nav>
  </div>
  <p class="foot__note">
    Cross-session, cross-provider agent collaboration over MCP. MIT licensed.
  </p>
</footer>

<script src="/site.js" defer></script>
</body>
</html>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/`
Expected: PASS.

- [ ] **Step 5: Look at it once**

Open the file in a browser (`open public/_join.html`) with the placeholders in place. Check the keycard renders and the two copy buttons are present. One look; fix what it shows; no loop.

- [ ] **Step 6: Commit**

```bash
git add public/_join.html tools/test_worker.mjs
git commit -m "The join page template: a code, a role, and what to say"
```

### Task 7: The `/j/<code>` route in `worker.js`

**Files:**
- Modify: `worker.js` (whole file; today it is the 18-line www redirect)
- Test: `tools/test_worker.mjs` (extend)

**Interfaces:**
- Consumes: `public/_join.html` from Task 6; `public/404.html` (exists).
- Produces: `GET`/`HEAD /j/<code>` → 200 page, 301 to canonical, or 404; `/_join.html` → 404; everything else unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tools/test_worker.mjs`:

```js
const CANON = "/j/BELL-7F3K-92-REVIEWER";

test("a canonical code renders the page", async () => {
  const res = await get(CANON);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  const body = await res.text();
  assert.ok(body.includes('<div class="keycard__code">BELL-7F3K-92-REVIEWER</div>'));
  assert.ok(body.includes('data-copy="BELL-7F3K-92-REVIEWER"'));
  assert.ok(body.includes("seats you as <code>reviewer</code>"));
  assert.ok(body.includes('<meta property="og:title" content="Join a Bellman room as reviewer">'));
  assert.ok(body.includes("<title>Join as reviewer &mdash; Bellman</title>"));
  assert.ok(body.includes('<meta name="robots" content="noindex">'));
  assert.ok(!body.includes("{{"), "a placeholder was left unfilled");
  assert.ok(!body.includes("<!--role-->"), "a block marker was left in");
});

test("a code with no role group renders with no role line", async () => {
  const res = await get("/j/BELL-7F3K-92");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('<div class="keycard__code">BELL-7F3K-92</div>'));
  assert.ok(!body.includes("seats you as"));
  assert.ok(!body.includes("keycard__mode"));
  assert.ok(body.includes('<meta property="og:title" content="Join a Bellman room">'));
  assert.ok(body.includes("<title>Join &mdash; Bellman</title>"));
  assert.ok(!body.includes("{{"));
});

test("a role rendered with hyphens displays as the manifest key", async () => {
  const body = await (await get("/j/BELL-7F3K-92-RELEASE-AGENT")).text();
  assert.ok(body.includes("seats you as <code>release_agent</code>"));
  const digits = await (await get("/j/BELL-7F3K-92-PEER-2")).text();
  assert.ok(digits.includes("seats you as <code>peer_2</code>"));
});

// Review Focus 4: the longest legal role name.
test("a 31-character role group renders whole", async () => {
  const role = "A" + "B".repeat(30);
  const res = await get(`/j/BELL-7F3K-92-${role}`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes(`seats you as <code>${role.toLowerCase()}</code>`));
});

for (const [name, requested] of [
  ["lowercase", "/j/bell-7f3k-92-reviewer"],
  ["underscores", "/j/BELL_7F3K_92_REVIEWER"],
  ["encoded whitespace", "/j/BELL-7F3K-92-REVIEWER%20"],
  ["a trailing slash", "/j/BELL-7F3K-92-REVIEWER/"],          // Review Focus 1
  ["a query string", "/j/BELL-7F3K-92-REVIEWER?utm_source=x"], // Review Focus 1
]) {
  test(`${name} redirects to the canonical URL`, async () => {
    const res = await get(requested, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), `https://bellman.sh${CANON}`);
  });
}

test("the canonical URL does not redirect", async () => {
  assert.equal((await get(CANON, { redirect: "manual" })).status, 200);
});

// Review Focus 2: unfurlers HEAD before they GET.
test("HEAD answers like GET", async () => {
  const res = await get(CANON, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("a method other than GET or HEAD is refused", async () => {
  const res = await get(CANON, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

for (const [name, p] of [
  ["not a code", "/j/nope"],
  ["an O in a random group", "/j/BELL-7F3O-92"],
  ["an I in a random group", "/j/BELL-7F3K-9I"],
  ["an empty role group", "/j/BELL-7F3K-92-"],                     // Review Focus 5
  ["a role group that starts with a digit", "/j/BELL-7F3K-92-2A"],
  ["a role group over 31 characters", `/j/BELL-7F3K-92-A${"B".repeat(31)}`],
  ["no code at all, with a slash", "/j/"],
  ["no code at all", "/j"],
  ["two segments", "/j/BELL-7F3K-92-REVIEWER/extra"],
  ["the raw template", "/_join.html"],
  ["markup in the path", "/j/%3Cscript%3E"],
  ["markup after a code", "/j/BELL-7F3K-92-REVIEWER%3Cb%3E"],
  ["a bad percent escape", "/j/BELL-7F3K-92-%E0%A4%A"],
]) {
  test(`${name} is the site's 404`, async () => {
    const res = await get(p);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), await notFoundBody());
  });
}

test("a missing template is a plain 500, not a half page", async () => {
  const broken = { ASSETS: assetsFrom(path.join(ROOT, "public"), { missing: ["/_join.html"] }) };
  const res = await worker.fetch(new Request(`https://bellman.sh${CANON}`), broken);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/`
Expected: every new test FAILS. Today `/j/…` falls through to the asset binding, which answers 404 for all of them — so the 404 cases pass vacuously, and the 200/301/405/500 cases fail. That is the expected shape; Step 5 covers the 404 cases.

- [ ] **Step 3: Implement**

Replace `worker.js` with:

```js
// bellman.sh is served as static assets. This Worker does two things in front
// of them. It makes www canonical: it runs before the asset handler
// (run_worker_first) so the redirect also catches "/", which index.html would
// otherwise answer before any code ran. And it renders /j/<code>, the page a
// join code is shared as.
//
// The join page is a pure function of the URL. It calls no server: Slack,
// Discord and iMessage GET every pasted link to unfurl it, a join code is
// single-use and expires in fifteen minutes, and a page that looked the code
// up would hand every unfurl cache the room's name. So the page shows the
// code, what it seats you as, and what to say to your agent — and nothing it
// did not already have from the URL. Spec: bellman/docs/superpowers/specs/
// 2026-10-06-join-links-design.md.

// The code grammar from src/codes.ts in the server: BELL, four and two of the
// code alphabet (no 0/O, 1/I/L), then an optional role group — a manifest
// role key upper-cased with "_" as "-". The random groups are matched against
// the alphabet itself, not [A-Z2-9]: a code with an O in it was never minted,
// and the page should not pretend one exists.
const CODE = /^BELL-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}(?:-[A-Z][A-Z0-9-]{0,30})?$/;

const TEMPLATE = "/_join.html";

// normalizeJoinCode's rules, so a link retyped by hand lands.
function normalize(raw) {
  return raw.trim().toUpperCase().replace(/\s+/g, "").replaceAll("_", "-");
}

// Belt and braces: CODE already admits nothing that needs escaping.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function notFound(request, env) {
  const page = await env.ASSETS.fetch(new Request(new URL("/404.html", request.url)));
  return new Response(page.body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function joinPage(request, env, segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return notFound(request, env);
  }
  const code = normalize(decoded);
  if (!CODE.test(code)) return notFound(request, env);

  // One URL per code, so an unfurl cache holds one entry rather than one per
  // spelling. Anything that is not the canonical path, query included, is
  // sent there.
  const url = new URL(request.url);
  const canonical = `${url.origin}/j/${code}`;
  if (url.pathname !== `/j/${code}` || url.search !== "") {
    return Response.redirect(canonical, 301);
  }

  // Display only. The server never parses a role out of a code; the registry
  // resolves the whole string, and bellman_connect decides the seat.
  const groups = code.split("-");
  const role = groups.length > 3
    ? groups.slice(3).join("-").toLowerCase().replaceAll("-", "_")
    : null;

  const tpl = await env.ASSETS.fetch(new Request(new URL(TEMPLATE, request.url)));
  if (!tpl.ok) {
    return new Response("The join page is unavailable.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let html = await tpl.text();
  if (role === null) {
    html = html.replace(/<!--role-->[\s\S]*?<!--\/role-->/g, "");
  } else {
    html = html.replaceAll("<!--role-->", "").replaceAll("<!--/role-->", "")
               .replaceAll("{{ROLE}}", escapeHtml(role));
  }
  html = html
    .replaceAll("{{CODE}}", escapeHtml(code))
    .replaceAll("{{ROLE_SUFFIX}}", role === null ? "" : escapeHtml(` as ${role}`));

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page reveals nothing that changes, so caching it is harmless;
      // short, so a template fix lands within minutes.
      "cache-control": "public, max-age=300",
      // A code is an invitation. Search engines do not get invitations.
      "x-robots-tag": "noindex",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.bellman.sh") {
      url.hostname = "bellman.sh";
      // 301: the apex is the canonical host and that is not going to change.
      // Path and query are carried over, so a shared deep link still lands.
      return Response.redirect(url.toString(), 301);
    }

    // The template is filled by the route below and never served raw.
    if (url.pathname === TEMPLATE) return notFound(request, env);

    const join = url.pathname.match(/^\/j(?:\/([^/]*))?\/?$/);
    if (join) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed.", {
          status: 405,
          headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (!join[1]) return notFound(request, env);
      return joinPage(request, env, join[1]);
    }

    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/`
Expected: PASS, all of them.

- [ ] **Step 5: Mutation checks — every new assertion seen to fail**

Each one: edit, run `node --test tools/`, confirm the named test fails, revert.

| Mutation in `worker.js` | Must fail |
|---|---|
| `CODE` → `[A-Z2-9]{4}` for the first group | "an O in a random group is the site's 404" |
| Delete `\|\| url.search !== ""` | "a query string redirects" |
| Make the redirect condition `if (false)` | every redirect test |
| `"x-robots-tag": "index"` | "a canonical code renders", "HEAD answers like GET" |
| Always take the `else` branch (never strip the role block) | "no role group renders with no role line" |
| `.replaceAll("-", "_")` → `.replaceAll("-", "-")` | "a role rendered with hyphens" |
| Refuse `HEAD` (`request.method !== "GET"`) | "HEAD answers like GET" |
| `if (!tpl.ok)` → `if (false)` | "a missing template is a plain 500" |
| Remove the `url.pathname === TEMPLATE` line | "the raw template is the site's 404" |
| `{0,30}` → `{0,31}` in `CODE` | "a role group over 31 characters is the site's 404" |

Run after reverting everything: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker.js tools/test_worker.mjs
git commit -m "Render /j/<code>: the join page, from the URL alone"
```

### Task 8: CI runs the Worker tests and smoke-tests the live route; push; PR

**Files:**
- Modify: `.github/workflows/deploy.yml` — the `check` job gains Node and the Worker tests; the smoke test gains three lines

**Interfaces:** none.

- [ ] **Step 1: Edit the workflow**

In the `check` job, after the `actions/setup-python@v5` step and before `Unit tests`, add:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Worker tests
        run: node --test tools/
```

In the `deploy` job's smoke test, after the `a missing path 404s` check and before `exit $fail`, add:

```bash
          check "a join link renders" \
            "$(curl -sL -o /dev/null -w '%{http_code}' --max-time 30 https://bellman.sh/j/BELL-7F3K-92-REVIEWER)" 200

          check "a join link is not indexed" \
            "$(curl -sI --max-time 30 https://bellman.sh/j/BELL-7F3K-92-REVIEWER | tr -d '\r' | awk -F': ' 'tolower($1)=="x-robots-tag"{print $2}')" \
            "noindex"

          check "a non-code under /j/ 404s" \
            "$(curl -sL -o /dev/null -w '%{http_code}' --max-time 30 https://bellman.sh/j/not-a-code)" 404
```

- [ ] **Step 2: Run everything the `check` job runs, locally**

```bash
python3 -m unittest discover -s tools -p 'test_*.py'
node --test tools/
python3 tools/build-pricing.py && python3 tools/build-compare.py && git diff --quiet && echo "generated pages current"
```

Expected: all green; no diff from regeneration.

- [ ] **Step 3: Commit, push, open the PR**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: run the Worker tests, and smoke-test a join link after deploy"
git push -u origin join-links
gh pr create --base main --head join-links \
  --title "Join links: /j/<code>, rendered from the URL alone" \
  --body "$(cat <<'BODY'
`https://bellman.sh/j/BELL-7F3K-92-REVIEWER` is the page a join code is shared
as: the code, what it seats you as, and what to say to your agent.

It is rendered by the Worker from a template, from the URL alone — no call to
the server. Slack, Discord and iMessage GET every pasted link to unfurl it, and
a join code is single-use and expires in fifteen minutes, so a page that looked
the code up would hand every unfurl cache the room's name. This one has nothing
to hand over.

Non-canonical spellings — lowercase, underscores, a trailing slash, a query —
301 to the one canonical URL. Anything that is not a code is the site's 404,
including an `O` in a random group, which the code alphabet does not contain.
`noindex` in a header and a meta tag.

Tests: `tools/test_worker.mjs`, run with `node --test tools/`, now in the
`check` job. Ten mutations, each seen to fail the test that owns it; the list
is in the plan. The deploy smoke test fetches a join link.

Spec: bellman-sh/bellman `docs/superpowers/specs/2026-10-06-join-links-design.md`.
Server side (the `join_url` field): bellman-sh/bellman PR linked below.
BODY
)"
```

- [ ] **Step 4: Cross-link the two PRs**

```bash
gh pr comment <site PR number> --body "Server side, the join_url field: bellman-sh/bellman#<bellman PR number>."
cd ~/src/github.com/bellman-sh/bellman
gh pr comment <bellman PR number> --body "The page: bellman-sh/bellman.sh#<site PR number>."
```

---

## Order of landing

The site PR can merge first and alone: the page works for any code, whether or not the server mints the link. The bellman PR should merge after the site is live, so the first `join_url` anyone sees opens a page that exists.
