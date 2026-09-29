# Role-Carrying Join Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room can mint one join code per role — `BELL-7F3K-92-REVIEWER` — and revoke that role's code without disturbing the others.

**Architecture:** `Session.joinCode` (one nullable string) becomes `Session.joinCodes`, a map from role name to `{ code, expiresAt }`. The map key is the one-per-role invariant. The full rendered string, role group included, is the index key, so a hand-edited suffix is simply a code that was never issued. The server renders codes and never parses them.

**Tech Stack:** TypeScript, Node + Cloudflare Workers (Durable Objects), vitest, MCP SDK, zod.

**Spec:** `docs/superpowers/specs/2026-09-27-role-carrying-join-codes-design.md`

## Global Constraints

- **`npm run verify` must pass before every commit.** It runs `typecheck && typecheck:worker && build && test` — both TypeScript programs, not one.
- **Role keys are `^[a-z][a-z0-9_]{0,30}$`** (`src/manifest.ts:59`). Maximum 31 characters. No hyphen is possible in a role name, which is what makes the `_` → `-` rendering a bijection.
- **The random groups' alphabet is unchanged:** `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (`src/codes.ts:4`). The role group is a word and is not subject to it.
- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly.
- **Store reads return detached copies.** Never mutate what you read back and expect it to stick.
- **`JOIN_CODE_TTL` stays 15 minutes and room-wide.** No per-role TTL.
- **Workers-only files are excluded from the Node build** (`src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`). Anything importing `cloudflare:workers` cannot be imported by a vitest test — put the testable shape in a runtime-free module beside it (`src/stored-session.ts` is the one this plan uses).
- **`tests/helpers/store-contract.ts` is the conformance suite.** Both `MemoryStore` and `DurableObjectStore` must pass it identically.
- **Run every new test against a deliberately broken implementation before counting it as passing.** Steps below name the specific breakage.
- **Commits are signed and stay on this branch.** `main` moves only through merges. Never `git add CLAUDE.md` — it is dirty by injection and is not part of this work.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has its test added to the task that owns the code.

1. **A legacy session whose `joinCode` is already `null`** must lift to `{}`, not to a record holding a null code. Task 3.
2. **A code relayed with underscores throughout** — someone retypes `bell_7f3k_92_peer_a` from memory — must resolve to the issued code. Task 1.
3. **A 31-character role name** (the `RoleKeyShape` maximum) must render and resolve. Task 1.
4. **A bare `revoke` against a room with no live codes** must be idempotent and report success, not error. Task 4.
5. **A frozen room** must refuse a per-role issue and leave every other role's code untouched. Task 4.

---

### Task 1: Render a role into the code

Pure functions, no callers changed. `generateJoinCode` stays for now so the build remains green; Task 2 deletes it.

**Files:**
- Modify: `src/codes.ts`
- Test: `tests/codes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderJoinCode(role: string): string`. `normalizeJoinCode(raw: string): string` gains a `_` → `-` fold.

- [ ] **Step 1: Write the failing tests**

Add to `tests/codes.test.ts`, inside the existing `describe("join codes", ...)` block, and add `renderJoinCode` to the import from `../src/codes.js`:

```ts
  it("renders the role as a third group", () => {
    expect(renderJoinCode("reviewer")).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-REVIEWER$/);
  });

  /** RoleKeyShape allows `_` but not `-`, so the mapping back is unambiguous. */
  it("renders an underscore in a role name as a hyphen", () => {
    expect(renderJoinCode("peer_a")).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-PEER-A$/);
  });

  /** Review Focus 3: the longest role RoleKeyShape permits. */
  it("renders a 31-character role name whole", () => {
    const longest = "a" + "b".repeat(30);
    expect(longest).toMatch(/^[a-z][a-z0-9_]{0,30}$/);
    expect(renderJoinCode(longest).endsWith(`-${longest.toUpperCase()}`)).toBe(true);
  });

  it("keeps two roles distinct when only one has an underscore", () => {
    const group = (role: string) => renderJoinCode(role).split("-").slice(3).join("-");
    expect(group("peer_a")).toBe("PEER-A");
    expect(group("peera")).toBe("PEERA");
  });

  /** Review Focus 2: relayed from memory with the wrong separator throughout. */
  it("folds an underscore-separated relay onto the canonical form", () => {
    expect(normalizeJoinCode(" bell_7f3k_92_peer_a ")).toBe("BELL-7F3K-92-PEER-A");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/codes.test.ts`
Expected: FAIL. The first four with `renderJoinCode is not a function` (or a TypeScript import error); the fifth with `expected 'BELL_7F3K_92_PEER_A' to be 'BELL-7F3K-92-PEER-A'`.

- [ ] **Step 3: Implement**

In `src/codes.ts`, add `renderJoinCode` below `generateJoinCode` and amend `normalizeJoinCode`:

```ts
/**
 * Human-relayable join code carrying its role, e.g. BELL-7F3K-92-REVIEWER.
 *
 * The role group is a word, so the restricted alphabet above does not apply to
 * it: that alphabet exists because the random groups have no word context to
 * disambiguate O from 0. `_` renders as `-` because RoleKeyShape
 * (`[a-z][a-z0-9_]{0,30}`) forbids `-` inside a role name, which makes the
 * mapping a bijection. Nothing ever parses this back — see the store.
 */
export function renderJoinCode(role: string): string {
  return `BELL-${chunk(4)}-${chunk(2)}-${role.toUpperCase().replaceAll("_", "-")}`;
}

export function normalizeJoinCode(raw: string): string {
  // `_` -> `-` so a code retyped from memory with the wrong separator resolves.
  return raw.trim().toUpperCase().replace(/\s+/g, "").replaceAll("_", "-");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/codes.test.ts`
Expected: PASS, including the pre-existing `normalizeJoinCode("QRA 7F3K 92") === "QRA7F3K92"` case, which has no underscore and is unaffected.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/codes.ts tests/codes.test.ts
git commit -m "feat(codes): render a role as the join code's third group"
```

---

### Task 2: `joinCodes` map replaces `joinCode`

The shape change, landing atomically because `npm run verify` typechecks both programs. **Behaviour is identical to today** — every code is still minted for `manifest.defaultRole` and there is still only ever one. Later tasks use the new shape; this one only installs it.

**Files:**
- Modify: `src/types.ts` (Session), `src/store.ts` (interface + `MemoryStore`), `src/store-do.ts` (`SessionDO` + `DurableObjectStore`), `src/server.ts` (start, connect, confirm, invite), `src/codes.ts` (delete `generateJoinCode`)
- Modify: `tests/helpers/fixtures.ts`, `tests/helpers/store-contract.ts`
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `renderJoinCode(role)` from Task 1.
- Produces:
  - `interface JoinCodeRecord { code: string; expiresAt: number }`
  - `Session.joinCodes: Record<string, JoinCodeRecord>` (`joinCode` and `joinCodeExpiresAt` are gone)
  - `getSessionByJoinCode(code: string): Promise<{ session: Session; role: string } | undefined>`
  - `setJoinCode(sessionId: string, role: string, code: string, expiresAt: number): Promise<boolean>`
  - `consumeJoinCode(sessionId: string, role: string): Promise<void>`
  - `clearJoinCodes(sessionId: string): Promise<void>`
  - `SessionDO.setJoinCode(role, code, expiresAt): Promise<string | null | false>` — returns the retired code
  - `SessionDO.consumeJoinCode(role): Promise<string | null>` — returns the retired code
  - `SessionDO.clearJoinCodes(): Promise<string[]>` — returns every retired code
  - `oneCode(code: string, role?: string)` test fixture helper

- [ ] **Step 1: Change the types**

In `src/types.ts`, add above `interface Session`:

```ts
/** One live join code, and when it stops resolving. */
export interface JoinCodeRecord {
  code: string;
  expiresAt: number;
}
```

In `interface Session`, replace the two `joinCode` lines with:

```ts
  /**
   * Live join codes, one per role. The map key IS the one-per-role invariant:
   * two live codes for the same seat are unrepresentable rather than prevented
   * by a check. Bounded by the manifest, which is immutable after createSession.
   *
   * There is no `joinCode` beside this, for the reason the `mode` comment above
   * gives: two fields for one fact could disagree.
   */
  joinCodes: Record<string, JoinCodeRecord>;
```

- [ ] **Step 2: Change the store interface**

In `src/store.ts`, replace the three join-code signatures:

```ts
  /**
   * Resolve a code to its session and the role it carries.
   *
   * The whole rendered string is the key, role group included, so a code with a
   * hand-edited suffix was never issued and does not resolve. The role comes
   * from the record, never from reading the string — there is no code path that
   * parses a suffix, which is what makes the tamper case fail closed.
   */
  getSessionByJoinCode(code: string): Promise<{ session: Session; role: string } | undefined>;

  /** Retire one role's code. Idempotent. */
  consumeJoinCode(sessionId: string, role: string): Promise<void>;

  /** Retire every live code — a pair session filling, a session closing. Idempotent. */
  clearJoinCodes(sessionId: string): Promise<void>;

  /** Issue a code for one role, retiring only that role's previous code. False means frozen. */
  setJoinCode(sessionId: string, role: string, code: string, expiresAt: number): Promise<boolean>;
```

- [ ] **Step 3: Implement `MemoryStore`**

In `src/store.ts`, in `createSession` replace the `if (stored.joinCode)` line with:

```ts
    for (const rec of Object.values(stored.joinCodes)) this.byJoinCode.set(rec.code, stored.id);
```

Replace `getSessionByJoinCode`, `consumeJoinCode` and `setJoinCode` with:

```ts
  async getSessionByJoinCode(code: string): Promise<{ session: Session; role: string } | undefined> {
    const id = this.byJoinCode.get(code);
    if (!id) return undefined;
    const session = await this.getSession(id);
    if (!session || session.closed) return undefined;
    const hit = Object.entries(session.joinCodes).find(([, rec]) => rec.code === code);
    if (!hit) return undefined; // consumed or rotated
    const [role, rec] = hit;
    if (Date.now() > rec.expiresAt) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    const rec = s?.joinCodes[role];
    if (!s || !rec) return;
    this.byJoinCode.delete(rec.code);
    delete s.joinCodes[role];
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    const previous = s.joinCodes[role];
    if (previous) this.byJoinCode.delete(previous.code); // only THIS role's old code
    s.joinCodes[role] = { code, expiresAt };
    this.byJoinCode.set(code, sessionId);
    return true;
  }
```

In `expireIfDue`, replace the two `joinCode` lines with:

```ts
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
```

- [ ] **Step 4: Implement `SessionDO` and `DurableObjectStore`**

In `src/store-do.ts`, replace `SessionDO.consumeJoinCode` and `SessionDO.setJoinCode`, and add `clearJoinCodes`:

```ts
  /** Returns the retired code, so the caller can drop it from the registry. */
  async consumeJoinCode(role: string): Promise<string | null> {
    const s = await this.stored();
    const rec = s?.joinCodes[role];
    if (!s || !rec) return null;
    const { [role]: _retired, ...rest } = s.joinCodes;
    await this.ctx.storage.put("session", { ...s, joinCodes: rest });
    return rec.code;
  }

  /** Returns every retired code, for the same reason. */
  async clearJoinCodes(): Promise<string[]> {
    const s = await this.stored();
    if (!s) return [];
    const codes = Object.values(s.joinCodes).map((rec) => rec.code);
    if (codes.length > 0) await this.ctx.storage.put("session", { ...s, joinCodes: {} });
    return codes;
  }

  /** `false` means frozen; a string (or null) means set, and names this role's old code. */
  async setJoinCode(role: string, code: string, expiresAt: number): Promise<string | null | false> {
    const s = await this.stored();
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    const previous = s.joinCodes[role]?.code ?? null;
    await this.ctx.storage.put("session", {
      ...s,
      joinCodes: { ...s.joinCodes, [role]: { code, expiresAt } },
    });
    return previous;
  }
```

In `DurableObjectStore`, replace `createSession`'s registry line, `getSessionByJoinCode`, `consumeJoinCode` and `setJoinCode`, and add `clearJoinCodes`:

```ts
    for (const rec of Object.values(s.joinCodes)) {
      await this.registry.putJoinCode(rec.code, s.id);
    }
```

```ts
  async getSessionByJoinCode(code: string): Promise<{ session: Session; role: string } | undefined> {
    const id = await this.registry.lookupJoinCode(code);
    if (!id) return undefined;
    const session = await this.getSession(id);
    if (!session || session.closed) return undefined;
    const hit = Object.entries(session.joinCodes).find(([, rec]) => rec.code === code);
    if (!hit) return undefined; // consumed or rotated
    const [role, rec] = hit;
    if (Date.now() > rec.expiresAt) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    const retired = await this.session(sessionId).consumeJoinCode(role);
    if (retired) await this.registry.dropJoinCode(retired);
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    for (const code of await this.session(sessionId).clearJoinCodes()) {
      await this.registry.dropJoinCode(code);
    }
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number
  ): Promise<boolean> {
    const previous = await this.session(sessionId).setJoinCode(role, code, expiresAt);
    if (previous === false) return false;
    if (previous) await this.registry.dropJoinCode(previous);
    await this.registry.putJoinCode(code, sessionId);
    return true;
  }
```

In `SessionDO`'s `expireIfDue`, replace `joinCode: null` with `joinCodes: {}`.

- [ ] **Step 5: Update the four `src/server.ts` call sites**

In `bellman_start`, above `const session: Session = {`:

```ts
      const defaultCode = {
        code: renderJoinCode(manifest.defaultRole),
        expiresAt: now + JOIN_CODE_TTL,
      };
```

replace the two `joinCode` fields with `joinCodes: { [manifest.defaultRole]: defaultCode },`, and in the response replace the two `join_code` lines with:

```ts
        join_code: defaultCode.code,
        join_code_expires_at: new Date(defaultCode.expiresAt).toISOString(),
```

Change the import of `generateJoinCode` to `renderJoinCode`.

In `bellman_connect`, replace the lookup and the `room:` line:

```ts
      const hit = await s.getSessionByJoinCode(normalizeJoinCode(join_code));
      if (!hit) {
        return fail("join code not found or expired. Codes expire 15 minutes after creation if unused, and are consumed when a pair session fills. Ask the creator to start a new session.");
      }
      const { session, role } = hit;
```

```ts
          room: roomPreview(session, role),
```

In `bellman_confirm`, the pair-fill branch becomes:

```ts
      // A full pair session has no seat for ANY role, so every code goes.
      if (activeMembers(joined).length >= joined.maxMembers) {
        await s.clearJoinCodes(joined.id);
      }
```

In `bellman_invite`, the revoke branch and the issue path:

```ts
      if (revoke) {
        if (Object.keys(session.joinCodes).length === 0) return ok({ revoked: true, join_code: null });
        await s.clearJoinCodes(session_id);
```

```ts
      const role = session.manifest.defaultRole;
      const previous = Boolean(session.joinCodes[role]);
      const code = renderJoinCode(role);
      const expiresAt = Date.now() + JOIN_CODE_TTL;
      if (!(await s.setJoinCode(session_id, role, code, expiresAt))) return fail(FROZEN);
```

and replace both `Boolean(session.joinCode)` occurrences with `previous`.

- [ ] **Step 6: Delete `generateJoinCode`**

Remove it from `src/codes.ts` and from the import list in `tests/codes.test.ts`, deleting the three tests that call it (`matches the human-relayable BELL-XXXX-XX shape`, `never emits 0, O, 1, I or L`, `does not repeat itself across a large sample`) and rewriting them against `renderJoinCode("reviewer")`:

Do NOT re-add a shape assertion here — Task 1's `renders the role as a third group` already asserts that exact regex, and repeating it is duplication for its own sake. Keep only the two that test different properties:

```ts
  /** Codes get read aloud and retyped, so the ambiguous glyphs are excluded. */
  it("never emits 0, O, 1, I or L in the random groups", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of renderJoinCode("reviewer").split("-").slice(1, 3).join("")) {
        seen.add(ch);
      }
    }
    for (const banned of ["0", "O", "1", "I", "L"]) {
      expect([...seen], `alphabet should exclude ${banned}`).not.toContain(banned);
    }
    expect(seen.size).toBeGreaterThan(20); // the generator is actually varying
  });

  it("does not repeat itself across a large sample", () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => renderJoinCode("reviewer")));
    expect(codes.size).toBe(2_000);
  });
```

- [ ] **Step 7: Update the fixtures**

In `tests/helpers/fixtures.ts`, import `JoinCodeRecord` from `../../src/types.js`, add the helper, and rewrite `session()`:

```ts
/** One live code for `role`, expiring in the standard 15 minutes. */
export function oneCode(code: string, role = "peer_b"): Record<string, JoinCodeRecord> {
  return { [role]: { code, expiresAt: Date.now() + 15 * 60 * 1000 } };
}

export function session(over: Partial<Session> = {}): Session {
  const now = Date.now();
  const manifest = over.manifest ?? roomManifest();
  return {
    id: "qs_test",
    manifest,
    frozenAt: null,
    createdBy: "u_jesse",
    orgId: "org_codenerd",
    orgOnly: false,
    joinCodes: { [manifest.defaultRole]: { code: "BELL-TEST-01", expiresAt: now + 15 * 60 * 1000 } },
    expiresAt: now + 4 * 60 * 60 * 1000,
    maxMembers: 2,
    members: [member()],
    events: [],
    closed: false,
    ...over,
  };
}
```

The default manifest is the pair preset, so `manifest.defaultRole` is `"peer_b"` — which is why `oneCode()`'s default role matches.

- [ ] **Step 8: Update the contract suite's existing join-code cases**

In `tests/helpers/store-contract.ts`, import `oneCode` from `./fixtures.js` and rewrite the five existing cases:

```ts
    it("finds a session by join code", async () => {
      const s = session({ joinCodes: oneCode("BELL-ABCD-12") });
      (await store.createSession(s));
      const hit = await store.getSessionByJoinCode("BELL-ABCD-12");
      expect(hit?.session.id).toBe(s.id);
      expect(hit?.role).toBe("peer_b");
      expect((await store.getSessionByJoinCode("BELL-ZZZZ-99"))).toBeUndefined();
    });

    /** INVARIANT 2: unused join codes expire after 15 minutes. */
    it("stops resolving a join code once its TTL elapses", async () => {
      const s = session({ joinCodes: oneCode("BELL-TTL0-01") });
      (await store.createSession(s));
      expect((await store.getSessionByJoinCode("BELL-TTL0-01"))).toBeDefined();

      vi.advanceTimersByTime(JOIN_CODE_TTL + 1);
      expect((await store.getSessionByJoinCode("BELL-TTL0-01"))).toBeUndefined();
    });

    /** INVARIANT 2: join codes are single-use. */
    it("consumeJoinCode makes the code unusable and idempotent", async () => {
      const s = session({ joinCodes: oneCode("BELL-ONCE-01") });
      (await store.createSession(s));

      (await store.consumeJoinCode(s.id, "peer_b"));
      expect((await store.getSessionByJoinCode("BELL-ONCE-01"))).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCodes).toEqual({});

      await expect(store.consumeJoinCode(s.id, "peer_b")).resolves.not.toThrow();
    });

    it("never resolves a join code for a closed session", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.closeSession(s.id));
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    it("issues a new join code and retires the old one", async () => {
      const a = session({ joinCodes: oneCode("BELL-AAAA-01") });
      (await store.createSession(a));

      (await store.setJoinCode(a.id, "peer_b", "BELL-BBBB-02", Date.now() + JOIN_CODE_TTL));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-BBBB-02"))?.session.id).toBe(a.id);
      expect((await store.getSession(a.id))?.joinCodes["peer_b"].code).toBe("BELL-BBBB-02");
    });
```

In the `issues a code after the previous one was consumed` case and the sweep case near the end of the file, pass `"peer_b"` to `consumeJoinCode` and replace `expect(fresh.joinCode).toBeNull()` with `expect(fresh.joinCodes).toEqual({})`.

- [ ] **Step 9: Add the per-role contract cases**

Append after `issues a new join code and retires the old one`:

```ts
    it("holds a live code for two roles at once, each resolving to its own role", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    /** The invariant the whole issue turns on. */
    it("issuing for one role leaves another role's code resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.setJoinCode(s.id, "peer_a", "BELL-DDDD-04", Date.now() + JOIN_CODE_TTL));

      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-DDDD-04"))?.role).toBe("peer_a");
      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
    });

    it("consuming one role's code leaves the other resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.consumeJoinCode(s.id, "peer_b"));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    it("clearJoinCodes retires every code, idempotently", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.clearJoinCodes(s.id));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
      await expect(store.clearJoinCodes(s.id)).resolves.not.toThrow();
    });

    /** The whole string is the key, so a doctored suffix was never issued. */
    it("does not resolve a code whose role group was edited or stripped", async () => {
      const s = session({ joinCodes: oneCode("BELL-7F3K-92-PEER-B", "peer_b") });
      (await store.createSession(s));

      expect((await store.getSessionByJoinCode("BELL-7F3K-92-PEER-B"))?.role).toBe("peer_b");
      expect(await store.getSessionByJoinCode("BELL-7F3K-92-PEER-A")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-7F3K-92")).toBeUndefined();
    });
```

- [ ] **Step 10: Update `tests/store-do-wiring.test.ts`**

Its `legacyRow` builds a session in the OLD storage shape deliberately, so it must now strip `joinCodes` and write the legacy fields itself — which incidentally makes it exercise Task 3's lift through a real `SessionDO`:

```ts
function legacyRow(over: Partial<Session> = {}): Record<string, unknown> {
  const { manifest, events, joinCodes, ...rest } = session({ id: LEGACY_ID, ...over });
  return {
    ...rest,
    joinCode: LEGACY_CODE,
    joinCodeExpiresAt: Date.now() + 15 * 60 * 1000,
    mode: manifest.mode,
    members: rest.members.map(({ roomRole, ...m }) => m),
  };
}
```

In `keeps its manifest through createSession, on both read paths`, replace the `joinCode` field and the lookup, importing the `oneCode` helper from `./helpers/fixtures.js`:

```ts
    const s = session({
      id: "qs_current",
      joinCodes: oneCode("BELL-NEW-01"),
      manifest: roomManifest({ room: "kept", purpose: "keep me" }),
    });
```

```ts
    expect((await store.getSessionByJoinCode("BELL-NEW-01"))?.session.manifest).toEqual(s.manifest);
```

In both `toMatchObject` assertions on an expired row — the `still expires when its alarm fires` case and the negative-control case — replace `joinCode: null` with `joinCodes: {}`.

Finally, repair the negative-control test `hands the legacy row to every read path, and manifest.mode throws`. Its point is that the guard prevents a REAL crash, and after this task the crash from an unguarded lookup happens inside the call — the per-role resolver dereferences `joinCodes`, which a pre-manifest row does not have. Assert the rejection rather than a returned value, which keeps the control's intent intact:

```ts
    const leaked = [
      await legacy.getSession(),
      await store.getSession(LEGACY_ID),
    ];

    for (const s of leaked) {
      expect(s).toBeDefined();
      expect(() => s!.manifest.mode).toThrow(TypeError);
    }

    // The third read path now crashes inside the lookup itself: resolving a code
    // per role dereferences joinCodes, which a pre-manifest row has never had.
    await expect(store.getSessionByJoinCode(LEGACY_CODE)).rejects.toThrow(TypeError);
```

- [ ] **Step 11: Run the tests and watch the new ones fail against a broken store**

First confirm they pass: `npx vitest run`
Then break `MemoryStore.setJoinCode` by replacing its two `previous` lines with `s.joinCodes = {};` before the assignment — the whole-map clear the spec warns about — and re-run.
Expected: `issuing for one role leaves another role's code resolving` FAILS with `expected undefined to be 'peer_b'`, and `holds a live code for two roles at once` FAILS. Restore the correct implementation and re-run to green.

Then break `getSessionByJoinCode` by keying the `find` on the random groups only (`rec.code.startsWith(code.split("-").slice(0, 3).join("-"))`) and re-run.
Expected: `does not resolve a code whose role group was edited or stripped` FAILS on the `PEER-A` assertion. Restore and re-run to green.

- [ ] **Step 12: Verify and commit**

```bash
npm run verify
git add src/types.ts src/store.ts src/store-do.ts src/server.ts src/codes.ts \
        tests/helpers/fixtures.ts tests/helpers/store-contract.ts tests/codes.test.ts \
        tests/store-do-wiring.test.ts
git commit -m "refactor(store): joinCodes map keyed by role replaces the single joinCode"
```

---

### Task 3: Lift legacy sessions on read

A `SessionDO` in production holds `{ joinCode, joinCodeExpiresAt }`, and that code may be in someone's clipboard for another 15 minutes. `hydrateStoredSession` is already the documented single gate for exactly this kind of field migration — it has two precedents, `manifest` and `frozenAt`.

**Files:**
- Modify: `src/stored-session.ts`
- Create: `tests/stored-session.test.ts`

**Interfaces:**
- Consumes: `Session.joinCodes` from Task 2.
- Produces: `hydrateStoredSession` returns rows with `joinCodes` populated and no legacy fields. Signature unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/stored-session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hydrateStoredSession } from "../src/stored-session.js";
import { session } from "./helpers/fixtures.js";

/** Rows written before join codes carried a role. */
function legacyRow(over: Record<string, unknown> = {}) {
  const { joinCodes: _dropped, events: _events, ...rest } = session();
  return { ...rest, joinCode: "BELL-7F3K-92", joinCodeExpiresAt: 1_800_000, ...over };
}

describe("hydrateStoredSession — legacy join codes", () => {
  it("lifts a legacy code under the manifest's default role", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row.joinCodes).toEqual({
      peer_b: { code: "BELL-7F3K-92", expiresAt: 1_800_000 },
    });
  });

  /** The code has no role group, and needs none: the whole string is the key. */
  it("keeps the legacy string verbatim", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row.joinCodes["peer_b"].code).toBe("BELL-7F3K-92");
  });

  it("strips both legacy fields so no stale mirror survives", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row).not.toHaveProperty("joinCode");
    expect(row).not.toHaveProperty("joinCodeExpiresAt");
  });

  /** Review Focus 1: a consumed legacy code is an empty map, not a null record. */
  it("lifts an already-consumed legacy code to an empty map", () => {
    const row = hydrateStoredSession(legacyRow({ joinCode: null }))!;
    expect(row.joinCodes).toEqual({});
  });

  it("leaves a row that already has joinCodes alone", () => {
    const current = { ...session(), events: undefined };
    delete (current as Record<string, unknown>).events;
    const row = hydrateStoredSession(current)!;
    expect(row.joinCodes).toEqual(session().joinCodes);
  });

  it("still refuses a row with no manifest", () => {
    expect(hydrateStoredSession({ ...legacyRow(), manifest: undefined })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/stored-session.test.ts`
Expected: FAIL. `lifts a legacy code under the manifest's default role` reports `expected undefined to deeply equal { peer_b: ... }`; `strips both legacy fields` reports the row still has `joinCode`.

- [ ] **Step 3: Implement the lift**

In `src/stored-session.ts`, extend the doc comment's list and the return:

```ts
 * - **joinCode / joinCodeExpiresAt** are lifted into `joinCodes`, keyed by the
 *   manifest's default role, and then stripped. Stripped rather than kept
 *   because a `joinCode` beside `joinCodes` is the stale mirror the Session
 *   type forbids. The legacy string has no role group and needs none: the whole
 *   string is the index key, so it resolves as written and expires naturally.
 *   Read-time rather than a bulk migration because there is no list of sessions
 *   to iterate — the registry indexes by creator and by code, never by "all".
 */
export function hydrateStoredSession(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = (raw as { manifest?: unknown }).manifest;
  if (!m || typeof m !== "object") return undefined;
  const roles = (m as { roles?: unknown }).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return undefined;

  const {
    joinCode, joinCodeExpiresAt, ...row
  } = raw as StoredSession & { joinCode?: string | null; joinCodeExpiresAt?: number };

  return {
    ...row,
    frozenAt: row.frozenAt ?? null,
    joinCodes:
      row.joinCodes ??
      (joinCode ? { [row.manifest.defaultRole]: { code: joinCode, expiresAt: joinCodeExpiresAt ?? 0 } } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/stored-session.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Watch the Review Focus test fail on purpose**

Change the lift's ternary to `{ [row.manifest.defaultRole]: { code: joinCode!, expiresAt: joinCodeExpiresAt ?? 0 } }` with no `joinCode ?` guard, and re-run.
Expected: `lifts an already-consumed legacy code to an empty map` FAILS with `expected { peer_b: { code: null ... } } to deeply equal {}`. Restore the guard and re-run to green.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/stored-session.ts tests/stored-session.test.ts
git commit -m "feat(store-do): lift legacy joinCode into joinCodes on read"
```

---

### Task 4: `bellman_invite` takes a role

**Files:**
- Modify: `src/server.ts` (`bellman_invite`)
- Test: `tests/tools/invite.test.ts`

**Interfaces:**
- Consumes: `setJoinCode(sessionId, role, code, expiresAt)`, `consumeJoinCode(sessionId, role)`, `clearJoinCodes(sessionId)`, `renderJoinCode(role)`.
- Produces: `bellman_invite` accepts `role?: string`. Returns `{ join_code, join_code_expires_at, role, replaced_previous }` or `{ revoked: true, roles: string[] }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools/invite.test.ts`:

```ts
  it("mints a code per role, each resolving to its own seat", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });

    const a = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    expect(a.isError, a.text).toBe(false);
    expect(a.data.role).toBe("helper");
    expect(String(a.data.join_code)).toMatch(/-HELPER$/);

    const b = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(b.data.role).toBe("lead");

    const outsider = await h.connect(DEV_KEY.outsider);
    const preview = await outsider.call("bellman_connect", { join_code: String(a.data.join_code) });
    expect(preview.data.room.your_role).toBe("helper");
  });

  it("issuing for one role leaves another role's code live", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead1 = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });

    const lead2 = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(lead2.data.replaced_previous).toBe(true);

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(lead1.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });

  it("revoking one role leaves the others live", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });

    await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead", revoke: true });

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(lead.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });

  it("a bare revoke retires every code", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });

    const revoked = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });
    expect(revoked.data.revoked).toBe(true);

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(lead.data.join_code) })).isError).toBe(true);
  });

  /** Review Focus 4. */
  it("a bare revoke against a room with no live codes succeeds", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });

    const again = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.revoked).toBe(true);
  });

  it("refuses a role the manifest does not declare, naming the ones it does", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const bad = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "admin" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("lead");
    expect(bad.text).toContain("helper");
  });
```

No new fixture is needed: `manifestFixture()` already takes overrides, so `manifestFixture({ preset: "swarm" })` is the swarm preset. Import `manifestFixture` and `DEV_KEY` in the test file. The swarm preset declares two roles — `lead` (the creator's) and `helper` (the default).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/invite.test.ts`
Expected: FAIL. `role` is not in the input schema, so the SDK rejects the argument or ignores it and every code comes back for the default role.

- [ ] **Step 3: Implement**

In `bellman_invite`'s `inputSchema`, add:

```ts
        role: z.string().min(1).max(31).optional(),
```

Replace the handler body from the verb guard onward:

```ts
      const denial = denyVerb(session, me, revoke ? "revoke" : "invite");
      if (denial) return fail(denial);

      // An absent role means the usual seat when issuing, and EVERY seat when
      // revoking. Deliberately asymmetric: over-revoking is recoverable by
      // minting again, while under-revoking leaves a door open behind someone
      // who believes they shut it.
      if (role !== undefined && !Object.hasOwn(session.manifest.roles, role)) {
        return fail(
          `this room declares no role "${role}" (it declares: ${Object.keys(session.manifest.roles).join(", ")}).`
        );
      }

      if (revoke) {
        const retired = role ? [role] : Object.keys(session.joinCodes);
        if (role) await s.consumeJoinCode(session_id, role);
        else await s.clearJoinCodes(session_id);
        await s.appendEvent(session.id, {
          type: "invite_revoked",
          fromMemberId: member_id,
          fromUserId: identity.userId,
          fromLabel: identity.label,
          payload: { roles: retired },
          refId: null,
        });
        await audit(s, session, identity, "invite_revoked", { roles: retired });
        return ok({ revoked: true, roles: retired, join_code: null });
      }

      if (activeMembers(session).length >= session.maxMembers) {
        return fail(`session is full (${session.maxMembers} members) — a new code could not be used. Wait for someone to leave, or start a swarm session.`);
      }

      const issuedRole = role ?? session.manifest.defaultRole;
      const previous = Boolean(session.joinCodes[issuedRole]);
      const code = renderJoinCode(issuedRole);
      const expiresAt = Date.now() + JOIN_CODE_TTL;
      if (!(await s.setJoinCode(session_id, issuedRole, code, expiresAt))) return fail(FROZEN);
      await s.appendEvent(session.id, {
        type: "invite_issued",
        fromMemberId: member_id,
        fromUserId: identity.userId,
        fromLabel: identity.label,
        payload: { role: issuedRole, expires_at: new Date(expiresAt).toISOString() },
        refId: null,
      });
      await audit(s, session, identity, "invite_issued", { role: issuedRole, replaced_previous: previous });

      return ok({
        join_code: code,
        join_code_expires_at: new Date(expiresAt).toISOString(),
        role: issuedRole,
        replaced_previous: previous,
        share_instructions:
          `Give this code to the joining session. It seats them as "${issuedRole}". Any code issued earlier for that role has stopped working; other roles' codes are unaffected.`,
      });
```

Destructure `role` in the handler signature alongside `session_id`, `member_id`, `revoke`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/invite.test.ts`
Expected: PASS, including the pre-existing `stale code stops resolving` case.

- [ ] **Step 5: Add and check the frozen-room case (Review Focus 5)**

```ts
  it("a frozen room refuses a per-role issue and leaves other codes untouched", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    await h.store.freezeSession(sessionId, Date.now());

    const denied = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(denied.isError).toBe(true);

    await h.store.freezeSession(sessionId, null);
    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });
```

Run it, then break `MemoryStore.setJoinCode` by deleting its `if (s.frozenAt !== null) return false;` line and re-run.
Expected: the new case FAILS on `expect(denied.isError).toBe(true)`. Restore and re-run to green.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/server.ts tests/tools/invite.test.ts
git commit -m "feat(invite): mint and revoke a join code per role"
```

---

### Task 5: The joiner is seated in the code's role

**Files:**
- Modify: `src/types.ts` (`PendingConnect`), `src/server.ts` (`bellman_connect`, `bellman_confirm`)
- Modify: `tests/helpers/flows.ts`
- Test: `tests/tools/handshake.test.ts`

**Interfaces:**
- Consumes: `getSessionByJoinCode` returning `{ session, role }` from Task 2; `bellman_invite`'s `role` from Task 4.
- Produces: `PendingConnect.roomRole: string`. `pairUp(h, { joinAs })` joins via a role-specific code.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/handshake.test.ts`:

```ts
  it("seats the joiner in the role their code carried", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, role: "lead",
    });

    const joiner = await h.connect(DEV_KEY.outsider);
    const preview = await joiner.call("bellman_connect", { join_code: String(invited.data.join_code) });
    // "lead", NOT the swarm preset's default role "helper". That difference is the
    // whole point, and is what lets the negative control in Step 6 actually fail.
    expect(preview.data.room.your_role).toBe("lead");

    const confirmed = await joiner.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief(),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(confirmed.data.room.your_role).toBe("lead");

    const seated = (await h.store.getSession(sessionId))!
      .members.find((m) => m.memberId === String(confirmed.data.member_id))!;
    expect(seated.roomRole).toBe("lead");
  });

  /** The preview and the seat must agree, or the preview is a lie. */
  it("revoking after the preview does not retroactively change the seat", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, role: "lead",
    });
    const joiner = await h.connect(DEV_KEY.outsider);
    const preview = await joiner.call("bellman_connect", { join_code: String(invited.data.join_code) });

    await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, role: "lead", revoke: true,
    });

    const confirmed = await joiner.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief(),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(confirmed.data.room.your_role).toBe("lead");
  });
```

Import `manifestFixture`, `brief` and `DEV_KEY` in the test file if they are not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/handshake.test.ts`
Expected: FAIL on `expect(seated.roomRole).toBe("lead")` with `expected 'helper' to be 'lead'` — confirm still seats `manifest.defaultRole`, which for the swarm preset is `helper`. The preview assertion already passes, from Task 2.

- [ ] **Step 3: Implement**

In `src/types.ts`, add to `PendingConnect`:

```ts
  /**
   * The seat the code carried, captured here because bellman_confirm receives
   * only the token. A revoke landing in between therefore does not cancel an
   * in-flight confirm, bounded by the token's own 10-minute TTL. Re-resolving
   * at confirm would be worse: issuing retires the previous code for a role, so
   * a joiner who previewed legitimately would be bumped by an unrelated reissue.
   */
  roomRole: string;
```

In `bellman_connect`'s `putPendingConnect` call, add `roomRole: role,`.

In `bellman_confirm`, change the member's seat and the returned preview:

```ts
        roomRole: pending.roomRole,
```

```ts
          room: roomPreview(joined, pending.roomRole),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/handshake.test.ts`
Expected: PASS.

- [ ] **Step 5: Teach `pairUp` to join in a role**

In `tests/helpers/flows.ts`, add `joinAs?: string` to the options and, when set, mint a role code before previewing:

```ts
  let joinCode = String(started.data.join_code);
  if (opts.joinAs) {
    const invited = await creator.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      role: opts.joinAs,
    });
    expect(invited.isError, invited.text).toBe(false);
    joinCode = String(invited.data.join_code);
  }
```

- [ ] **Step 6: Run the whole suite and break confirm on purpose**

Run: `npx vitest run`
Then change `roomRole: pending.roomRole` back to `session.manifest.defaultRole` and re-run.
Expected: `seats the joiner in the role their code carried` FAILS with `expected 'helper' to be 'lead'` — `helper` is the swarm preset's default role, which is exactly the value the code's role has to override. Restore and re-run to green.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/types.ts src/server.ts tests/helpers/flows.ts tests/tools/handshake.test.ts
git commit -m "feat(handshake): seat a joiner in the role their code carried"
```

---

### Task 6: Closing a room clears its codes

The spec's D7. `SessionDO.closeSession` leaves codes and their registry rows live, relying on the `closed` guard; the expiry path clears them. The two disagree, and the per-role model multiplies the orphan rows by the role count.

**Files:**
- Modify: `src/store.ts` (`MemoryStore.closeSession`), `src/store-do.ts` (`DurableObjectStore.closeSession`)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `clearJoinCodes` from Task 2.
- Produces: nothing new; `closeSession` keeps its signature.

- [ ] **Step 1: Write the failing test**

Add to the join-code section of `tests/helpers/store-contract.ts`:

```ts
    it("closing a session clears every code, not just the default role's", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.closeSession(s.id));

      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store.test.ts tests/store-do.test.ts`
Expected: FAIL with `expected { peer_b: {...}, peer_a: {...} } to deeply equal {}`.

- [ ] **Step 3: Implement**

In `src/store.ts`:

```ts
  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closed = true;
    // Agree with expireIfDue: a closed room's codes stop resolving AND stop
    // occupying the index, rather than relying on the `closed` guard alone.
    await this.clearJoinCodes(sessionId);
  }
```

In `src/store-do.ts`:

```ts
  async closeSession(sessionId: string): Promise<void> {
    await this.session(sessionId).closeSession();
    await this.clearJoinCodes(sessionId);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS. The pre-existing `never resolves a join code for a closed session` case still passes — it did so via the `closed` guard and now does so via both.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git commit -m "fix(store): closing a session clears its join codes and index rows"
```

---

### Task 7: Tool descriptions and README

The descriptions are what an agent reads before calling. Four of them now describe behaviour that changed.

**Files:**
- Modify: `src/server.ts` (descriptions for `bellman_start`, `bellman_connect`, `bellman_confirm`, `bellman_invite`)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Update `bellman_start`'s description**

Change the join-code sentence to name the format:

```
The join code (e.g. BELL-7F3K-92-PEER-B) is human-relayable: paste it into another Claude/ChatGPT/Cursor/Gemini session that has Bellman connected, and that session runs bellman_connect with it. The last group is the seat the code grants. Works across users, machines, surfaces, and model providers.
```

- [ ] **Step 2: Update `bellman_connect`'s description**

Replace the `join_code` arg line and add a sentence to the returns block:

```
  - join_code (string): e.g. "BELL-7F3K-92-REVIEWER" (case, whitespace and _/- insensitive)
```

```
The code's last group names the seat it grants, and your_role/your_verbs in the preview are that seat — not the room's default. A code with a hand-edited role group is not a code that was issued, and does not resolve.
```

- [ ] **Step 3: Update `bellman_confirm`'s description**

Add after the existing args block:

```
You are seated in the role the code you previewed carried. That seat was fixed when you ran bellman_connect: a code revoked in between does not change it, and the connect token's 10-minute TTL bounds the window.
```

- [ ] **Step 4: Update `bellman_invite`'s description**

Replace the args and the paragraph about retirement:

```
Args: session_id, member_id (yours), role (optional), revoke (default false)
Returns: { join_code, join_code_expires_at, role, replaced_previous } or { revoked: true, roles }

A room mints one live code per role. Issuing for a role RETIRES that role's previous code immediately and leaves every other role's code alone — so you can hand a reviewer code and a contributor code to different people.

Omitting `role` issues for the room's default seat. Omitting it when revoking retires EVERY code: over-revoking is recoverable by minting again, while under-revoking leaves a door open behind someone who believes they shut it. Pass a role to revoke exactly one.
```

- [ ] **Step 5: Update the README**

Run `grep -n "BELL-" README.md` and update every example code to the role-carrying form, and any sentence describing one code per room.

- [ ] **Step 6: Check the descriptions are actually shipped**

Run: `npx vitest run tests/tools/surface.test.ts`
Expected: PASS. If that suite pins description text, update the pins in the same commit.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/server.ts README.md tests/tools/surface.test.ts
git commit -m "docs: describe role-carrying join codes in the tool surface"
```

---

## Done when

- `npm run verify` is green.
- `npm run smoke` against a local `npm start` completes a role-specific join.
- A swarm room can hold a `lead` code and a `helper` code at once, revoke one, and keep the other.
