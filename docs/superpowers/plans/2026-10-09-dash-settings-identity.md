# Dash Settings: Which Key a Plan Resolved Through — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/account` tells a panel session the key its plan resolved through and the person's stable key, and dash's Settings page shows both, warning when the plan rests on a key the next re-check will not consult.

**Architecture:** Two repos, two PRs. In bellman, `resolvePlan` and `replanOnRefresh` return the `key` that decided the plan, the panel session stores it as `plan_key` (at sign-in and at every re-check), and `/account` adds `subject_key` and `plan_key` for cookie callers only. In dash, the settings route loads `/account` as billing does and renders the identity and one of four resolution messages; an absent field reads as "not reported", so either PR can merge first.

**Tech Stack:** bellman: TypeScript on Cloudflare Workers and Durable Objects, vitest in Node (`tests/`) and in workerd (`worker-tests/`). dash: React 19, TanStack Router, Tailwind 4, vitest with Testing Library in jsdom.

**Spec:** `docs/superpowers/specs/2026-10-09-dash-settings-identity-design.md` (bellman repo). Read it before starting; D1–D7 are cited below.

**Where:**

- Tasks 1–3, bellman: `/Users/mcfearsome/orca/workspaces/bellman/dash-settings-identity`, branch `mcfearsome/dash-settings-identity`. Its `package-lock.json` carries an unrelated change from Orca's setup `npm install`: never stage it.
- Tasks 4–5, dash: `/Users/mcfearsome/orca/workspaces/dash/settings-profile-identity-resolution-and-api-key`, branch `mcfearsome/settings-profile-identity-resolution-and-api-key`.

## Global Constraints

- Identity keys are exactly `<provider>:<subject>` (`github:4242`), `<provider>:<email>` and `email:<address>`. The subject key is the one `immutableKeys` keeps: `/^(?:github|google):\d+$/`.
- `plan_key` is a key string, or `null` when nothing matched (the default plan), or absent when not known. Absent and `null` must never be conflated, in the Worker or in the panel.
- `subject_key` and `plan_key` appear in the JSON form of `/account` for a cookie (panel) caller only. A bearer caller gets neither field. The HTML form of `/account` is unchanged.
- No change to which keys are consulted, their order, or the precedence of operator over grant over default. Authorization codes, refresh tokens and JWT claims do not gain the field.
- `AuthStorage.replanSession(id, identity, planSource, planKey, now)`: `planKey: string | null`, required, after `planSource`.
- dash copy, verbatim (D5, D6), with `<subject_key>` and `<plan_key>` standing for the values:
  - Stable id note: "The id an admin grants a plan to. It stays the same if you rename your login or change your email."
  - User id note: "What your rooms are filed under."
  - Stable id when absent or null: "Not reported yet"
  - `plan_key` absent: "This Worker does not report which key your plan resolved through yet."
  - `plan_key` null: "No grant or override is filed under your id. To be granted a plan, give an admin `<subject_key>`."
  - `plan_key` equal to `subject_key`: "Resolved through your stable id."
  - Any other `plan_key`: "Resolved through `<plan_key>`, an address. A plan filed under an address applies at sign-in only: the next check, within 10 minutes, looks at your stable id alone. Ask whoever set it to file it under `<subject_key>`."
- dash renders every value as text. The stable id is a `<code>` with `select-all`. No clipboard button.
- Commits: stage files by name. Messages are one sentence in each repo's voice, saying what now happens (see `git log --oneline`).

## Review Focus

1. **An operator-assigned user id.** A `BELLMAN_USERS` override with `userId: "u_jesse"`: `subject_key` must still be `github:4242`, read from the session's keys and never derived from `user_id`. Pinned in Task 3 ("an override under the subject, with an id of the operator's choosing").
2. **`subject_key: null`.** A record whose keys hold no subject: no sentence may end on an empty id, so the clauses that name the stable id are dropped. Pinned in Task 5 ("drops the clauses that name the stable id…").
3. **An address grant whose move throws.** The page must warn, because that grant really is gone at the re-check, while a grant that moved must not warn. Pinned in Task 1 and Task 3 (both branches).
4. **A session signed in before the deploy.** `/account` must omit `plan_key`, not send `null`, which would claim nothing matched; the re-check then writes it. And a `null` written by a re-check must overwrite an older key. Pinned in Task 2 (null merge) and Task 3 (keyless session, re-check).
5. **A dash ahead of its Worker.** The page renders with neither field, says "not reported", and warns about nothing. Pinned in Task 4 and Task 5.

---

### Task 1: The plan resolvers report the key that decided the plan

D1 and D2. bellman worktree.

**Files:**
- Modify: `src/oauth/routes.ts`: `resolvePlan` (about line 84–129), `replanOnRefresh` (131–176), `claimGrant` (223–262)
- Test: `tests/oauth-flow.test.ts`, inside `describe("plan resolution")` (line 347)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `resolvePlan(profile: ProviderProfile, config): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[]; key: string | null }>`
  - `replanOnRefresh(stored: Identity, keys: string[], config): Promise<{ identity: Identity; source: PlanSource; key: string | null }>`
  - `claimGrant(...)`, module-private, now resolves to `string`: the key the grant is filed under.

- [ ] **Step 1: Write the failing tests**

In `tests/oauth-flow.test.ts`, change line 2 and add an import after line 6:

```ts
import { handleOAuth, identityFromAccessToken, replanOnRefresh, resolvePlan, type OAuthConfig } from "../src/oauth/routes.js";
```

```ts
import type { ProviderProfile } from "../src/oauth/providers.js";
```

Inside `describe("plan resolution", () => {`, after the case `it("takes an operator override on the subject, as documented", …)` and before the describe's closing `});`, add:

```ts
  describe("the key it resolved through", () => {
    // The human fakeFetch signs in: GitHub id 4242, verified jesse@example.dev.
    const PROFILE: ProviderProfile = {
      provider: "github", subject: "4242", label: "mcfearsome", email: "jesse@example.dev",
    };
    const KEYS = ["github:4242", "github:jesse@example.dev", "email:jesse@example.dev"];
    const OVERRIDE: Identity = {
      userId: "u_github_4242", orgId: null, plan: "pro", role: "member", label: "jesse@example.dev",
    };

    it("is the override's key, whether subject or address", async () => {
      config.overrides = { "github:4242": OVERRIDE };
      expect((await resolvePlan(PROFILE, config)).key).toBe("github:4242");

      config.overrides = { "email:jesse@example.dev": OVERRIDE };
      expect((await resolvePlan(PROFILE, config)).key).toBe("email:jesse@example.dev");
    });

    it("is where a grant is filed once claimed, not the address it was found under", async () => {
      await config.plans!.putGrant(grant({ key: "email:jesse@example.dev" }));

      expect((await resolvePlan(PROFILE, config)).key).toBe("github:4242");
    });

    // The move is best effort and logs its failure, so a "could not pin a grant"
    // line in the output is expected.
    it("is the address when the grant could not be moved off it", async () => {
      await config.plans!.putGrant(grant({ key: "email:jesse@example.dev" }));
      config.plans!.moveGrant = () => Promise.reject(new Error("registry unreachable"));

      expect((await resolvePlan(PROFILE, config)).key).toBe("email:jesse@example.dev");
    });

    it("is null when nothing matched", async () => {
      expect((await resolvePlan(PROFILE, config)).key).toBeNull();
    });

    it("is the subject or null on a re-check, which consults nothing else", async () => {
      config.overrides = { "email:jesse@example.dev": OVERRIDE };
      expect((await replanOnRefresh(OVERRIDE, KEYS, config)).key).toBeNull();

      config.overrides = { "github:4242": OVERRIDE };
      expect((await replanOnRefresh(OVERRIDE, KEYS, config)).key).toBe("github:4242");

      config.overrides = {};
      await config.plans!.putGrant(grant({ key: "github:4242" }));
      expect((await replanOnRefresh(OVERRIDE, KEYS, config)).key).toBe("github:4242");
    });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/oauth-flow.test.ts -t "the key it resolved through"`
Expected: 5 failures, each receiving `undefined` for `key`.

- [ ] **Step 3: Make `claimGrant` answer where the grant is filed**

In `src/oauth/routes.ts`, replace:

```ts
 * grant keeps resolving by address until a later sign-in succeeds.
 */
async function claimGrant(
  plans: PlanStore,
  grant: PlanGrant,
  matchedKey: string,
  profile: ProviderProfile
): Promise<void> {
  const subjectKey = `${profile.provider}:${profile.subject}`;
  if (matchedKey === subjectKey) return;
  try {
    await plans.moveGrant(matchedKey, subjectKey);
  } catch (err) {
    console.error("could not pin a grant to its subject:", err);
  }
}
```

with:

```ts
 * grant keeps resolving by address until a later sign-in succeeds.
 *
 * Answers the key the grant is filed under when it returns: the subject's, or
 * the address it was found under when the move failed and left it there.
 */
async function claimGrant(
  plans: PlanStore,
  grant: PlanGrant,
  matchedKey: string,
  profile: ProviderProfile
): Promise<string> {
  const subjectKey = `${profile.provider}:${profile.subject}`;
  if (matchedKey === subjectKey) return subjectKey;
  try {
    await plans.moveGrant(matchedKey, subjectKey);
    return subjectKey;
  } catch (err) {
    console.error("could not pin a grant to its subject:", err);
    return matchedKey;
  }
}
```

- [ ] **Step 4: Make `resolvePlan` return `key`**

In `resolvePlan`'s doc comment, replace:

```ts
 * account. replanOnRefresh deliberately does not — see there.
 */
export async function resolvePlan(
```

with:

```ts
 * account. replanOnRefresh deliberately does not — see there.
 *
 * `key` is the identity key that decided the plan: the override's, or the
 * grant's where claimGrant left it, and null when nothing did. The panel's
 * settings page shows it, so that a plan resting on an address is visible.
 */
export async function resolvePlan(
```

Replace the return type line:

```ts
): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[] }> {
```

with:

```ts
): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[]; key: string | null }> {
```

Replace:

```ts
    if (override) return { identity: override, source: "operator", keys };
```

with:

```ts
    if (override) return { identity: override, source: "operator", keys, key };
```

Replace:

```ts
    // Sign-in is the only place with the profile, so it is the only place that
    // can pin an address-keyed grant to the subject behind it.
    await claimGrant(config.plans!, match.grant, match.key, profile);
```

with:

```ts
    // Sign-in is the only place with the profile, so it is the only place that
    // can pin an address-keyed grant to the subject behind it. Where the grant is
    // filed afterwards is the key worth reporting: one moved onto the subject is
    // found there at every re-check, and one that could not be moved is not.
    const filed = await claimGrant(config.plans!, match.grant, match.key, profile);
```

Replace:

```ts
      grantSource: grant.source,
      keys,
    };
  }
  return { identity: defaultIdentity(profile), source: "default", keys };
}
```

with:

```ts
      grantSource: grant.source,
      keys,
      key: filed,
    };
  }
  return { identity: defaultIdentity(profile), source: "default", keys, key: null };
}
```

- [ ] **Step 5: Make `replanOnRefresh` return `key`**

In `replanOnRefresh`, replace the return type line:

```ts
): Promise<{ identity: Identity; source: PlanSource }> {
```

with:

```ts
): Promise<{ identity: Identity; source: PlanSource; key: string | null }> {
```

Replace:

```ts
        identity: { ...base, plan: override.plan, role: override.role, orgId: override.orgId },
        source: "operator",
      };
```

with:

```ts
        identity: { ...base, plan: override.plan, role: override.role, orgId: override.orgId },
        source: "operator",
        key,
      };
```

Replace:

```ts
      identity: { ...base, plan: grant.plan, role: grant.role, orgId: grant.orgId },
      source: "grant",
    };
  }
  return { identity: base, source: "default" };
}
```

with:

```ts
      identity: { ...base, plan: grant.plan, role: grant.role, orgId: grant.orgId },
      source: "grant",
      key: match.key,
    };
  }
  return { identity: base, source: "default", key: null };
}
```

- [ ] **Step 6: Run the file and the typecheck**

Run: `npx vitest run tests/oauth-flow.test.ts`
Expected: PASS, the 5 new cases included.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/oauth/routes.ts tests/oauth-flow.test.ts
git commit -m "Say which key decided a plan: the override's, the grant's where its claim left it, or none"
```

---

### Task 2: The panel session keeps the key, and every re-check rewrites it

D3. bellman worktree.

**Files:**
- Modify: `src/oauth/storage.ts`: `PanelSession` (about line 68–82), `AuthStorage.replanSession` (doc and signature, 470–496), `MemoryAuthStore.replanSession` (681–691)
- Modify: `src/oauth/store.ts`: `AuthDO.replanSession` (doc and body, 510–540), `AuthStore.replanSession` (655–657)
- Modify: `src/oauth/routes.ts`: the `replanSession` call in `sessionCaller` (about line 1374) and the comment above it (1355)
- Test: `tests/panel-session.test.ts`, `worker-tests/auth-session.test.ts`, `worker-tests/auth-race.test.ts`

**Interfaces:**
- Consumes: `replanOnRefresh(...).key` from Task 1.
- Produces:
  - `PanelSession.plan_key?: string | null`
  - `AuthStorage.replanSession(id: string, identity: Identity, planSource: string, planKey: string | null, now: number): Promise<boolean>`

- [ ] **Step 1: Move every existing call to the new signature**

All 11 test calls pass `REPLANNED, "grant", ` and nothing else in these files does. Insert the key:

```bash
sed -i '' 's/REPLANNED, "grant", /REPLANNED, "grant", "github:4242", /' \
  tests/panel-session.test.ts worker-tests/auth-session.test.ts worker-tests/auth-race.test.ts
grep -c 'REPLANNED, "grant", "github:4242", ' tests/panel-session.test.ts worker-tests/auth-session.test.ts worker-tests/auth-race.test.ts
```

Expected counts: 5, 5, 1.

- [ ] **Step 2: Write the failing tests**

In `tests/panel-session.test.ts`, replace the first case of `describe("replanSession")`:

```ts
  it("merges the identity, plan source and time into the stored record, and nothing else", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());

    const merged = await store.replanSession("sid", REPLANNED, "grant", "github:4242", T0 + 5);

    expect(merged).toBe(true);
    expect(await store.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", replanned_at: T0 + 5 })
    );
  });
```

with:

```ts
  it("merges the identity, plan source, plan key and time into the stored record, and nothing else", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());

    const merged = await store.replanSession("sid", REPLANNED, "grant", "github:4242", T0 + 5);

    expect(merged).toBe(true);
    expect(await store.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", plan_key: "github:4242", replanned_at: T0 + 5 })
    );
  });

  // Null is "nothing matched" and has to land as null over an older key: a merge
  // that skipped a falsy key would leave the panel warning about a grant that is
  // already gone.
  it("writes a null plan key over the one before it", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession({ plan_key: "email:jesse@example.dev" }));

    await store.replanSession("sid", IDENTITY, "default", null, T0 + 5);

    expect((await store.touchSession("sid", T0 + 5))?.plan_key).toBeNull();
  });
```

In `worker-tests/auth-session.test.ts`, replace the first case of `describe("AuthDO replanSession")`:

```ts
  it("merges the identity, plan source and time into the stored record, and nothing else", async () => {
    const o = auth("s-replan");
    await o.putSession("sid", panelSession());

    const merged = await o.replanSession("sid", REPLANNED, "grant", "github:4242", T0 + 5);

    expect(merged).toBe(true);
    expect(await o.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", replanned_at: T0 + 5 })
    );
  });
```

with:

```ts
  it("merges the identity, plan source, plan key and time into the stored record, and nothing else", async () => {
    const o = auth("s-replan");
    await o.putSession("sid", panelSession());

    const merged = await o.replanSession("sid", REPLANNED, "grant", "github:4242", T0 + 5);

    expect(merged).toBe(true);
    expect(await o.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", plan_key: "github:4242", replanned_at: T0 + 5 })
    );
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/panel-session.test.ts -t "replanSession"`
Expected: FAIL. The 4-parameter store takes the key as `now`, so `replanned_at` comes back as `"github:4242"` and `plan_key` is missing.

- [ ] **Step 4: Implement the storage change**

In `src/oauth/storage.ts`, in `PanelSession`, replace:

```ts
  /** Where the plan came from, for /account. Same field the token path carries. */
  plan_source: string;
```

with:

```ts
  /** Where the plan came from, for /account. Same field the token path carries. */
  plan_source: string;
  /**
   * The identity key the plan resolved through, for /account: null when nothing
   * matched. Absent on a record written before the field, until its next re-plan
   * writes it, and absent is not null: one is "not known", the other "nothing
   * matched".
   */
  plan_key?: string | null;
```

In the `AuthStorage.replanSession` doc comment, replace:

```ts
   * Merges identity and plan_source into the stored record and sets replanned_at
```

with:

```ts
   * Merges identity, plan_source and plan_key into the stored record and sets replanned_at
```

and the signature:

```ts
  replanSession(id: string, identity: Identity, planSource: string, now: number): Promise<boolean>;
```

with:

```ts
  replanSession(id: string, identity: Identity, planSource: string, planKey: string | null, now: number): Promise<boolean>;
```

In `MemoryAuthStore`, replace:

```ts
  async replanSession(
    id: string,
    identity: Identity,
    planSource: string,
    now: number
  ): Promise<boolean> {
    const stored = this.sessions.get(id);
    if (!stored) return false;
    this.sessions.set(id, { ...stored, identity, plan_source: planSource, replanned_at: now });
    return true;
  }
```

with:

```ts
  async replanSession(
    id: string,
    identity: Identity,
    planSource: string,
    planKey: string | null,
    now: number
  ): Promise<boolean> {
    const stored = this.sessions.get(id);
    if (!stored) return false;
    this.sessions.set(id, { ...stored, identity, plan_source: planSource, plan_key: planKey, replanned_at: now });
    return true;
  }
```

In `src/oauth/store.ts`, in `AuthDO`, replace:

```ts
   * It writes its three fields onto the record as it is stored now, and onto
```

with:

```ts
   * It writes its four fields onto the record as it is stored now, and onto
```

and:

```ts
  async replanSession(
    id: string,
    identity: Identity,
    planSource: string,
    now: number
  ): Promise<boolean> {
```

with:

```ts
  async replanSession(
    id: string,
    identity: Identity,
    planSource: string,
    planKey: string | null,
    now: number
  ): Promise<boolean> {
```

and:

```ts
        ...stored, identity, plan_source: planSource, replanned_at: now,
```

with:

```ts
        ...stored, identity, plan_source: planSource, plan_key: planKey, replanned_at: now,
```

In `AuthStore`, replace:

```ts
  replanSession(id: string, identity: Identity, planSource: string, now: number): Promise<boolean> {
    return this.object.replanSession(id, identity, planSource, now);
  }
```

with:

```ts
  replanSession(id: string, identity: Identity, planSource: string, planKey: string | null, now: number): Promise<boolean> {
    return this.object.replanSession(id, identity, planSource, planKey, now);
  }
```

In `src/oauth/routes.ts`, in `sessionCaller`, replace:

```ts
  // ended. replanSession merges the three fields into what is stored now and
```

with:

```ts
  // ended. replanSession merges the four fields into what is stored now and
```

and:

```ts
    merged = await config.store.replanSession(id, current.identity, current.source, now);
```

with:

```ts
    merged = await config.store.replanSession(id, current.identity, current.source, current.key, now);
```

Then find the comments in the tests that still count three merged fields:

```bash
grep -n "three merged" tests/panel-session.test.ts worker-tests/auth-session.test.ts worker-tests/auth-race.test.ts
```

Change "three" to "four" in each line it prints.

- [ ] **Step 5: Run the tests, both runtimes, and both typechecks**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS (86 tests: the 85 there were, plus the null case).

Run: `npm run test:worker -- auth-session auth-race`
Expected: PASS. The first run installs `worker-tests` dependencies and builds the UI, which takes a few minutes.

Run: `npm run typecheck && npm run typecheck:worker`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/oauth/storage.ts src/oauth/store.ts src/oauth/routes.ts \
  tests/panel-session.test.ts worker-tests/auth-session.test.ts worker-tests/auth-race.test.ts
git commit -m "Keep the key a panel session's plan resolved through, and rewrite it at every re-plan"
```

---

### Task 3: `/account` tells a panel session its stable key and the key its plan resolved through

D3 (sign-in writes the key) and D4. bellman worktree.

**Files:**
- Modify: `src/oauth/routes.ts`: `finishSession`'s `putSession` (about line 546), `caller` (1291), `sessionCaller` (1327–1380), the `/account` route (1049–1090)
- Test: `tests/panel-session.test.ts`

**Interfaces:**
- Consumes: `resolvePlan(...).key` (Task 1), `PanelSession.plan_key` and the five-argument `replanSession` (Task 2).
- Produces: the wire contract dash mirrors in Task 4. `GET /account` with `accept: application/json`, called with a session cookie, gains `subject_key: string | null` (always, for a cookie caller) and `plan_key: string | null` (absent for a session that predates it). A bearer caller gets neither.

- [ ] **Step 1: Write the failing tests**

In `tests/panel-session.test.ts`, change:

```ts
import type { Identity } from "../src/types.js";
```

to:

```ts
import type { Identity, PlanGrant } from "../src/types.js";
```

At the end of `describe("caller, over a cookie", () => {`, before its closing `});`, add:

```ts
  it("tells a session signed in before plan keys its stable key, and no plan key", async () => {
    const sid = await seedSession(cfg); // as written before this change: no plan_key

    const body = (await (await route(withCookie("/account", sid, {
      headers: { accept: "application/json" },
    }))).json()) as Record<string, unknown>;

    expect(body.subject_key).toBe("github:4242");
    expect(body).not.toHaveProperty("plan_key");
  });

  it("tells a bearer caller neither key", async () => {
    const token = await signJwt(
      { iss: ISSUER, sub: PANEL_IDENTITY.userId, aud: RESOURCE, bellman: PANEL_IDENTITY, plan_source: "default" },
      cfg.secret, ACCESS_TOKEN_TTL_SECONDS
    );

    const body = (await (await route(new Request(`${ISSUER}/account`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    }))).json()) as Record<string, unknown>;

    expect(body.user_id).toBe(PANEL_IDENTITY.userId);
    expect(body).not.toHaveProperty("subject_key");
    expect(body).not.toHaveProperty("plan_key");
  });
```

At the end of `describe("the cookie's plan is re-resolved on the token's bound", () => {`, before its closing `});`, add:

```ts
  it("writes the plan key at the re-check, for a session that had none", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "keyless", { replanned_at: now });
    await cfg.plans!.putGrant({
      key: "github:4242", plan: "pro", role: "member", orgId: null,
      source: "operator", grantedAt: now, grantedBy: "test", expiresAt: null,
    });

    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000);
    const res = await route(withCookie("/account", sid, { headers: { accept: "application/json" } }));

    expect(await res.json()).toMatchObject({ plan: "pro", plan_source: "grant", plan_key: "github:4242" });
    expect((await cfg.store.touchSession(sid, Date.now()))?.plan_key).toBe("github:4242");
  });
```

In the same describe, in `it("still serves the request when the write-back itself fails", …)`, replace its last line:

```ts
    expect(((await res.json()) as { plan: string }).plan).toBe("free");
```

with:

```ts
    // The key comes from the re-check itself, so it is right without the write.
    expect(await res.json()).toMatchObject({ plan: "free", plan_key: null });
```

At the end of `describe("signing in to the panel", () => {`, before its closing `});`, add:

```ts
  describe("which key the plan resolved through", () => {
    const PRO: Identity = { ...PANEL_IDENTITY, plan: "pro" };
    const ADDRESS = "email:jesse@example.dev";
    const grantUnder = (key: string): PlanGrant => ({
      key, plan: "pro", role: "member", orgId: null,
      source: "operator", grantedAt: Date.now(), grantedBy: "test", expiresAt: null,
    });

    /** Sign in through the real flow, then read /account with the cookie it set. */
    async function signedInAccount(): Promise<{ id: string; body: Record<string, unknown> }> {
      const res = await signIn(PANEL);
      const id = /__Host-bellman_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
      const account = await route(withCookie("/account", id, { headers: { accept: "application/json" } }));
      return { id, body: (await account.json()) as Record<string, unknown> };
    }

    it.each<[string, () => unknown, Record<string, unknown>]>([
      ["an override under the subject, with an id of the operator's choosing",
        () => { cfg.overrides = { "github:4242": { ...PRO, userId: "u_jesse" } }; },
        { user_id: "u_jesse", plan_source: "operator", plan_key: "github:4242" }],
      ["an override under an address",
        () => { cfg.overrides = { [ADDRESS]: PRO }; },
        { plan_source: "operator", plan_key: ADDRESS }],
      ["a grant under the subject",
        () => cfg.plans!.putGrant(grantUnder("github:4242")),
        { plan_source: "grant", plan_key: "github:4242" }],
      ["a grant under an address, which sign-in moves onto the subject",
        () => cfg.plans!.putGrant(grantUnder(ADDRESS)),
        { plan_source: "grant", plan_key: "github:4242" }],
      // claimGrant logs the failed move: a "could not pin a grant" line is expected.
      ["a grant under an address that could not be moved",
        async () => {
          await cfg.plans!.putGrant(grantUnder(ADDRESS));
          cfg.plans!.moveGrant = () => Promise.reject(new Error("registry unreachable"));
        },
        { plan_source: "grant", plan_key: ADDRESS }],
      ["nothing", () => undefined, { plan: "free", plan_source: "default", plan_key: null }],
    ])("reports the stable key, and the key for %s", async (_what, arrange, expected) => {
      await arrange();

      const { body } = await signedInAccount();

      expect(body).toMatchObject({ subject_key: "github:4242", ...expected });
    });

    it("reports an address override until the first re-check, then that nothing matched", async () => {
      cfg.overrides = { [ADDRESS]: PRO };
      const { id, body } = await signedInAccount();
      expect(body).toMatchObject({ plan: "pro", plan_key: ADDRESS });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000);
      const later = await route(withCookie("/account", id, { headers: { accept: "application/json" } }));

      expect(await later.json()).toMatchObject({ plan: "free", plan_source: "default", plan_key: null });
    });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: the new cases FAIL on missing `subject_key` and `plan_key`; "tells a bearer caller neither key" already passes, which is the point of it.

- [ ] **Step 3: Write the key at sign-in**

In `finishSession`, replace:

```ts
    plan_source: resolved.source,
    identity_keys: resolved.keys,
```

with:

```ts
    plan_source: resolved.source,
    plan_key: resolved.key,
    identity_keys: resolved.keys,
```

- [ ] **Step 4: Carry both keys through `caller`**

Replace `caller`'s return type:

```ts
): Promise<{ identity: Identity; planSource: string; via: "bearer" | "cookie" } | null> {
```

with:

```ts
): Promise<{
  identity: Identity;
  planSource: string;
  /** The key the plan resolved through. A panel session's only, and absent on one that predates it. */
  planKey?: string | null;
  /** The stable `<provider>:<subject>` key. A panel session's only. */
  subjectKey?: string | null;
  via: "bearer" | "cookie";
} | null> {
```

In `sessionCaller`, replace its return type:

```ts
): Promise<{ identity: Identity; planSource: string; via: "cookie" } | null> {
```

with:

```ts
): Promise<{ identity: Identity; planSource: string; planKey?: string | null; subjectKey: string | null; via: "cookie" } | null> {
```

Replace:

```ts
  const stored = await config.store.touchSession(id, now);
  if (!stored) return null;

  if (now - replannedAt(stored) <= ACCESS_TOKEN_TTL_SECONDS * 1000) {
    return { identity: stored.identity, planSource: stored.plan_source, via: "cookie" };
  }
```

with:

```ts
  const stored = await config.store.touchSession(id, now);
  if (!stored) return null;
  // Read from the keys and not from userId, which an operator override may have
  // set to anything (u_jesse). The subject is the key an admin grants a plan to.
  const subjectKey = immutableKeys(stored.identity_keys)[0] ?? null;

  if (now - replannedAt(stored) <= ACCESS_TOKEN_TTL_SECONDS * 1000) {
    return { identity: stored.identity, planSource: stored.plan_source, planKey: stored.plan_key, subjectKey, via: "cookie" };
  }
```

Replace the last line of `sessionCaller`:

```ts
  return { identity: current.identity, planSource: current.source, via: "cookie" };
```

with:

```ts
  return { identity: current.identity, planSource: current.source, planKey: current.key, subjectKey, via: "cookie" };
```

- [ ] **Step 5: Put both on `/account`**

In the `/account` route, replace:

```ts
    const { identity, planSource } = who;
```

with:

```ts
    const { identity, planSource, planKey, subjectKey } = who;
```

and:

```ts
      plan_source: planSource,
      entitlements: limits,
```

with:

```ts
      plan_source: planSource,
      // A panel session's keys. Both are undefined for a bearer caller, and
      // plan_key is for a session signed in before it was kept. JSON leaves an
      // undefined field out, and absent is how the panel tells "not known" from
      // null, which means nothing matched.
      subject_key: subjectKey,
      plan_key: planKey,
      entitlements: limits,
```

`plan_source: planSource,` also appears in the token code near lines 955 and 1404; edit only the one inside `const account = {`.

- [ ] **Step 6: Run everything in this repo**

Run: `npx vitest run tests/panel-session.test.ts tests/oauth-flow.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck && npm run test:worker && npm run typecheck:worker`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/oauth/routes.ts tests/panel-session.test.ts
git commit -m "Tell a panel session, on /account, its stable key and the key its plan resolved through"
```

---

### Task 4: Settings loads the account and says who the person is

D5 and D7. dash worktree.

**Files:**
- Modify: `src/lib/api.ts`: `AccountInfo`, after `plan_source`
- Modify: `src/router.tsx`: `settingsRoute`
- Modify: `src/routes/settings.tsx`: replace the placeholder
- Test: `src/router.test.tsx`
- Not changed: `src/test-fixtures.ts`. `account()` keeps the old Worker's shape, which is the "absent" case; tests that need the keys pass them.

**Interfaces:**
- Consumes: the `/account` contract from Task 3; `getAccount` and `orSignIn`, already imported in `src/router.tsx`.
- Produces:
  - `export const settingsRoute`, whose loader answers `AccountInfo`
  - `AccountInfo.subject_key?: string | null` and `AccountInfo.plan_key?: string | null`
  - in `src/routes/settings.tsx`: `const KEY: string` (the class list for an identity key) and `function Fact({ label, note, children })`, both used again by Task 5

- [ ] **Step 1: Write the failing tests**

In `src/router.test.tsx`, in the `it.each` that starts `sends %s to sign-in, as the guard does`, replace:

```ts
    ["billing", "/billing"],
  ])("sends %s to sign-in
```

with:

```ts
    ["billing", "/billing"],
    ["settings", "/settings"],
  ])("sends %s to sign-in
```

Before `it("shows a room as a canvas: the loader's detail, the surface's items, and who is in it", …)`, add:

```ts
  it("shows who is signed in on settings: the stable id an admin grants to, the user id rooms are filed under, the role and the org", async () => {
    accountInfo = account({ user_id: "u_github_4242", role: "admin", org_id: "org_1", subject_key: "github:4242" });
    await boot("/settings");
    expect(await screen.findByText("github:4242")).toHaveClass("select-all");
    // The shell's footer names the person too, so the rest looks inside the page.
    const page = within(screen.getByRole("main"));
    expect(page.getByText("The id an admin grants a plan to. It stays the same if you rename your login or change your email.")).toBeInTheDocument();
    expect(page.getByText("u_github_4242")).toBeInTheDocument();
    expect(page.getByText("What your rooms are filed under.")).toBeInTheDocument();
    expect(page.getByText("jesse@codenerd")).toBeInTheDocument();
    expect(page.getByText("admin")).toBeInTheDocument();
    expect(page.getByText("org_1")).toBeInTheDocument();
    expect(calls).toContainEqual({ url: `${API}/account`, method: "GET", credentials: "include" });
  });

  it("says the stable id is not reported yet by a Worker that predates it, and leaves out an org there is none of", async () => {
    await boot("/settings");
    expect(await screen.findByText("Not reported yet")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByText("Org")).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/router.test.tsx -t settings`
Expected: FAIL. The page is still the placeholder and the route has no loader, so the refused-loader case never reaches sign-in.

- [ ] **Step 3: Mirror the fields**

In `src/lib/api.ts`, in `AccountInfo`, replace:

```ts
  plan_source: string;
  /** Mirrors `Entitlements`
```

with:

```ts
  plan_source: string;
  /**
   * The stable `<provider>:<subject>` key, the id an admin grants a plan to. Sent
   * to a panel session only, and absent from a Worker that predates it.
   */
  subject_key?: string | null;
  /**
   * The key the plan resolved through. Null when nothing matched and the plan is
   * the default; absent when the Worker, or a session signed in before the Worker
   * kept it, does not say. Absent is not null: one is "not known", the other
   * "nothing matched".
   */
  plan_key?: string | null;
  /** Mirrors `Entitlements`
```

- [ ] **Step 4: Load the account on the route**

In `src/router.tsx`, replace:

```ts
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: Settings,
})
```

with:

```ts
export const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: Settings,
  loader: ({ location }) => orSignIn(location.href, getAccount),
})
```

- [ ] **Step 5: Write the page**

Replace all of `src/routes/settings.tsx` with:

```tsx
import { Page } from "@/components/layout/app-shell"
import { settingsRoute } from "@/router"

/** An identity key as the page prints it: monospace, and free to break anywhere, since an address key can outrun the column. */
const KEY = "break-all font-mono text-[0.8rem]"

export function Settings() {
  const account = settingsRoute.useLoaderData()

  return (
    <Page title="Settings" description="Who you are, and how your plan was found.">
      <section className="rounded-xl border border-border p-5">
        <h2 className="text-base font-medium">Who you are</h2>
        <dl className="mt-4 grid gap-y-4 text-sm">
          <Fact label="Signed in as">{account.label}</Fact>
          <Fact
            label="Stable id"
            note="The id an admin grants a plan to. It stays the same if you rename your login or change your email."
          >
            {account.subject_key ? <code className={`${KEY} select-all`}>{account.subject_key}</code> : "Not reported yet"}
          </Fact>
          <Fact label="User id" note="What your rooms are filed under.">
            <code className={KEY}>{account.user_id}</code>
          </Fact>
          <Fact label="Role">{account.role}</Fact>
          {account.org_id ? <Fact label="Org">{account.org_id}</Fact> : null}
        </dl>
      </section>
    </Page>
  )
}

function Fact({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
      {note ? <dd className="mt-0.5 text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  )
}
```

- [ ] **Step 6: Run the tests, the typecheck and the linter**

Run: `npx vitest run src/router.test.tsx`
Expected: PASS (41 tests: 38 before, plus the two settings cases, plus the new `it.each` row).

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/router.tsx src/routes/settings.tsx src/router.test.tsx
git commit -m "Show who is signed in on settings: the stable id an admin grants to, and the user id rooms are filed under"
```

---

### Task 5: Settings says how the plan resolved, and warns when it rests on an address

D6 and D7. dash worktree.

**Files:**
- Modify: `src/routes/billing.tsx:112`: export `sourceText`
- Modify: `src/routes/settings.tsx`: the plan section and `Resolution`
- Test: `src/router.test.tsx`

**Interfaces:**
- Consumes: `settingsRoute` and `AccountInfo` (Task 4); `KEY` and `Fact` in `settings.tsx` (Task 4); `sourceText(source: string): string` from `src/routes/billing.tsx`.
- Produces: nothing later work relies on.

- [ ] **Step 1: Write the failing tests**

In `src/router.test.tsx`, after the two settings cases from Task 4, add:

```ts
  it("says a plan resolved through the stable id, with its source, and links to its limits", async () => {
    accountInfo = account({ plan: "pro", plan_source: "grant", subject_key: "github:4242", plan_key: "github:4242" });
    await boot("/settings");
    expect(await screen.findByText("Resolved through your stable id.")).toBeInTheDocument();
    const page = within(screen.getByRole("main"));
    expect(page.getByRole("heading", { name: "pro plan" })).toBeInTheDocument();
    expect(page.getByText("active")).toBeInTheDocument();
    expect(page.getByRole("link", { name: "Limits and usage" })).toHaveAttribute("href", "/billing");
    expect(page.queryByText(/applies at sign-in only/)).toBeNull();
  });

  it("names the id to give an admin when nothing matched", async () => {
    accountInfo = account({ subject_key: "github:4242", plan_key: null });
    await boot("/settings");
    expect(await screen.findByText(/No grant or override is filed under your id\./)).toHaveTextContent(
      "No grant or override is filed under your id. To be granted a plan, give an admin github:4242."
    );
  });

  it("warns when the plan rests on an address, naming it and the id to file it under", async () => {
    accountInfo = account({ plan: "pro", plan_source: "operator", subject_key: "github:4242", plan_key: "email:jesse@example.dev" });
    await boot("/settings");
    const warning = await screen.findByText(/applies at sign-in only/);
    expect(warning).toHaveTextContent("Resolved through email:jesse@example.dev, an address.");
    expect(warning).toHaveTextContent("the next check, within 10 minutes, looks at your stable id alone.");
    expect(warning).toHaveTextContent("Ask whoever set it to file it under github:4242.");
  });

  it("says a Worker that predates plan keys does not report one, and warns about nothing", async () => {
    await boot("/settings");
    expect(await screen.findByText("This Worker does not report which key your plan resolved through yet.")).toBeInTheDocument();
    expect(screen.queryByText(/applies at sign-in only/)).toBeNull();
  });

  it("drops the clauses that name the stable id when the Worker sends none", async () => {
    accountInfo = account({ subject_key: null, plan_key: null });
    await boot("/settings");
    expect(await screen.findByText("No grant or override is filed under your id.")).toBeInTheDocument();
    expect(screen.queryByText(/give an admin/)).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/router.test.tsx -t "settings|stable id|address|plan keys|nothing matched"`
Expected: the five new cases FAIL, because the page has no plan section yet.

- [ ] **Step 3: Share Billing's words for a plan's source**

In `src/routes/billing.tsx`, replace:

```ts
function sourceText(source: string): string {
```

with:

```ts
export function sourceText(source: string): string {
```

- [ ] **Step 4: Add the plan section**

In `src/routes/settings.tsx`, replace the imports:

```tsx
import { Page } from "@/components/layout/app-shell"
import { settingsRoute } from "@/router"
```

with:

```tsx
import { Link } from "@tanstack/react-router"
import { Page } from "@/components/layout/app-shell"
import type { AccountInfo } from "@/lib/api"
import { sourceText } from "@/routes/billing"
import { settingsRoute } from "@/router"
```

Replace:

```tsx
        </dl>
      </section>
    </Page>
```

with:

```tsx
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">
            <span className="capitalize">{account.plan}</span> plan
          </h2>
          <span className="text-xs text-muted-foreground">{sourceText(account.plan_source)}</span>
        </div>
        <Resolution account={account} />
        <Link to="/billing" className="mt-4 inline-block text-sm underline underline-offset-4">
          Limits and usage
        </Link>
      </section>
    </Page>
```

At the end of the file, add:

```tsx
/**
 * Which key the plan resolved through, in the one of four messages that fits
 * (the settings design, D6). Absent and null differ: absent is a Worker or a
 * session that does not say, null is nothing matched.
 */
function Resolution({ account }: { account: AccountInfo }) {
  const { plan_key: key, subject_key: stable } = account
  const stableId = stable ? <code className={KEY}>{stable}</code> : null

  if (key === undefined) {
    return <p className="mt-2 text-sm">This Worker does not report which key your plan resolved through yet.</p>
  }
  if (key === null) {
    return (
      <p className="mt-2 text-sm">
        No grant or override is filed under your id.
        {stableId ? <> To be granted a plan, give an admin {stableId}.</> : null}
      </p>
    )
  }
  if (key === stable) return <p className="mt-2 text-sm">Resolved through your stable id.</p>
  return (
    <p className="mt-3 rounded-xl border border-border bg-muted p-4 text-sm">
      Resolved through <code className={KEY}>{key}</code>, an address. A plan filed under an address applies at sign-in
      only: the next check, within 10 minutes, looks at your stable id alone.
      {stableId ? <> Ask whoever set it to file it under {stableId}.</> : null}
    </p>
  )
}
```

- [ ] **Step 5: Run everything in this repo**

Run: `npx vitest run src/router.test.tsx`
Expected: PASS (46 tests).

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/billing.tsx src/routes/settings.tsx src/router.test.tsx
git commit -m "Say on settings which key the plan resolved through, and warn when it rests on an address the next check will not consult"
```

---

## Finish

- [ ] bellman, whole suite: `npm test && npm run typecheck && npm run test:worker && npm run typecheck:worker`
- [ ] dash, whole suite: `npm test && npm run typecheck && npm run lint && npm run build`
- [ ] Ask before pushing either branch or opening a PR (superpowers:finishing-a-development-branch). The bellman PR links the spec. The dash PR says "Part of #9", not "Closes", and links the bellman PR.
- [ ] Ask before filing the three follow-ups in the spec's last section.
