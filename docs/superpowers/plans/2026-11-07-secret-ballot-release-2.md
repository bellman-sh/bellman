# Secret Ballot Release 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room can declare `ballot: secret` on a decide kind; the parser refuses it with `single` and on a vetoed kind.

**Architecture:** Release 1 (PR #521) built every read, write and erase path and left one refusal in `resolveDecide`.
This change removes that refusal, adds the two refusals the spec names, and documents the option. No store, tool
or description changes: release 1 already ships them.

**Tech Stack:** TypeScript, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-secret-ballot-design.md` (Change 3, items 31 to 34; "Tools, manifest
and consent"; CUJ 5).

**Gate:** the trace check passed on 2026-11-07 (temporary `bellman-trace-check` Worker, deleted): storage spans carry
no key or value, and no trace held either choice or a `bv:` key.

## Global Constraints

- Refusal on `single`, verbatim: `decide.<kind>: single is one approver's action request; a secret ballot needs a vote.`
- Refusal on a veto, verbatim: `role "<key>" vetoes <kind>, which uses ballot: secret; drop veto on <kind> or use ballot: open; a veto reveals its holder's choice.`
- The guide carries every line of `SECRET_BALLOT_PROMISE` (`src/projections.ts`) word for word.
- No tool description changes, so no `docs:gen` run and no §11 row (spec item 34 is conditional and does not fire).
- `npm run verify` before every commit. Commits are signed.

## Review Focus

1. A saved preset (`PUT /presets/:name`) with `ballot: secret` and a veto: refused 400 `invalid_manifest` with the
   veto message, since a preset cited later would otherwise start a vetoed secret room. Test in Task 1.
2. `ballot: open` on `single`: still accepted; only `secret` is refused there. Test in Task 1.
3. A manifest with `secret` on `single` and a veto on that kind: refused with the `single` message, since
   `resolveDecide` runs before `checkDecide`. Test in Task 1.
4. A joiner's consent preview, reached through `bellman_connect` rather than `roomPreview` directly, shows
   `ballot: "secret"` and `ballot_promise`. Test in Task 1.
5. A rule with no `ballot` keeps its stored shape (no `ballot` key) and its decision hash: release 1 rooms are
   unchanged. Covered by release 1's tests; Task 1 asserts the resolved shape once more.

---

### Task 1: The parser accepts `ballot: secret` and refuses it with `single` or a veto

**Files:**
- Modify: `src/manifest.ts` (`resolveDecide`, `checkDecide`)
- Modify: `tests/decide-manifest.test.ts` (replace "refuses ballot: secret in release 1…")
- Modify: `tests/tools/decide.test.ts` (one case; imports `DEV_KEY`, `SECRET_BALLOT_PROMISE`)
- Modify: `tests/helpers/flows.ts` (`secretBallot`'s doc comment only)

**Interfaces:**
- Consumes: `resolveManifest`, `checkPreset` (already imported in the test), the `authored()` and `refusal()` helpers.
- Produces: `resolveManifest` returns `decide.rules[kind] = { rule, quorum, ballot: "secret" }` for a secret kind.

- [ ] **Step 1: Write the failing tests** in `tests/decide-manifest.test.ts`, replacing the release 1 case. `authored()`'s
  `security` role vetoes `surface_proposal`, so cases without the veto drop it:

```ts
const noVeto = { ...authored().roles, security: { can: ["send", "vote"] } };

it("accepts ballot: secret, keeps ballot: open, and reads a rule with no ballot as it was", () => {
  expect(resolveManifest(authored({ roles: noVeto, decide: { surface_proposal: { rule: "majority", ballot: "secret" } } })).decide!.rules)
    .toEqual({ surface_proposal: { rule: "majority", quorum: null, ballot: "secret" } });
  expect(resolveManifest(authored({ decide: { surface_proposal: { rule: "majority", ballot: "open" } } })).decide!.rules)
    .toEqual({ surface_proposal: { rule: "majority", quorum: null, ballot: "open" } });
  expect(resolveManifest(authored()).decide!.rules).toEqual({ surface_proposal: { rule: "majority", quorum: null } });
  expect(refusal(authored({ decide: { surface_proposal: { rule: "majority", ballot: "hidden" } } })))
    .toBe('decide.surface_proposal.ballot: unknown ballot "hidden" (valid: open, secret)');
});

it("refuses ballot: secret on single, and allows ballot: open there", () => {
  expect(refusal(authored({ roles: noVeto, decide: { surface_proposal: { rule: "single", ballot: "secret" } } })))
    .toBe("decide.surface_proposal: single is one approver's action request; a secret ballot needs a vote.");
  expect(resolveManifest(authored({ roles: noVeto, decide: { surface_proposal: { rule: "single", ballot: "open" } } })).decide!.rules)
    .toEqual({ surface_proposal: { rule: "single", quorum: null, ballot: "open" } });
  // single is checked in resolveDecide, before checkDecide reads the veto
  expect(refusal(authored({ decide: { surface_proposal: { rule: "single", ballot: "secret" } } })))
    .toContain("single is one approver's action request");
});

it("refuses ballot: secret on a kind a role vetoes, in a manifest and in a saved preset", () => {
  const veto = 'role "security" vetoes surface_proposal, which uses ballot: secret; drop veto on surface_proposal or use ballot: open; a veto reveals its holder\'s choice.';
  expect(refusal(authored({ decide: { surface_proposal: { rule: "majority", ballot: "secret" } } }))).toBe(veto);
  const { room: _room, ...body } = authored({ decide: { surface_proposal: { rule: "majority", ballot: "secret" } } });
  expect(checkPreset("council", body, 0)).toMatchObject({ ok: false, status: 400, error: "invalid_manifest", description: veto });
});
```

  Also in Step 1, the tool-level test in `tests/tools/decide.test.ts`, inside the existing
  `describe("secret ballots, release 1")` block, renamed `"secret ballots"`:
  `"a manifest that declares ballot: secret starts, shows its promise at connect, and opens a secret decision"`.
  - `creator = await h.connect(DEV_KEY.jesse)`; `bellman_start` with
    `manifest({ decide: { surface_proposal: { rule: "majority", ballot: "secret" } } })` (this file's `manifest()` has
    no veto) and the brief `pairUp` uses. Expect no error, and `started.data.room.decide.surface_proposal` to match
    `{ ballot: "secret", ballot_promise: SECRET_BALLOT_PROMISE }`.
  - `outsider = await h.connect(DEV_KEY.outsider)`; `bellman_connect` with `started.data.join_code`. Expect
    `preview.data.room.decide.surface_proposal.ballot_promise` to be `SECRET_BALLOT_PROMISE`.
  - `bellman_decide` `open` as the creator; the `decision_opened` event in `h.store.eventsAfter(sessionId, 0)` has
    `payload.rule` equal to `{ rule: "majority", ballot: "secret" }`.

- [ ] **Step 2: Run them.** `npx vitest run tests/decide-manifest.test.ts tests/tools/decide.test.ts`. Expected: the
  accept case and the tool case fail with "secret ballots are not enabled yet"; the `single` and veto cases fail on
  the message.

- [ ] **Step 3: Implement.**
  - `resolveDecide`: replace the `ballot === "secret"` refusal with
    `if (ballot === "secret" && rule === "single") throw new ManifestError(`${field}: single is one approver's action request; a secret ballot needs a vote.`)`.
  - `checkDecide`: inside the `for (const kind of def.veto)` loop, after the undeclared-kind check, throw the veto
    message when `m.decide!.rules[kind]!.ballot === "secret"`.

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5:** `secretBallot`'s doc comment in `tests/helpers/flows.ts` says release 1's parser refuses
  `ballot: secret`. Make it say the helper flips a stored rule so a test can keep a fixture that declares an open
  ballot. Code unchanged.

- [ ] **Step 6: Commit.** `npm run verify`, then
  `git commit -m "Secret ballot release 2: the manifest accepts ballot: secret, and refuses it on single and on a vetoed kind (#469)"`.

### Task 2: The guide, the ADR and the architecture page say secret ballots are on

**Files:**
- Modify: `docs-site/src/content/docs/guides/manifests.md` ("Deciding together")
- Modify: `docs/adr/0040-room-consensus.md` (the 2026-11-01 revision note)
- Modify: `docs/ARCHITECTURE.md` (§5 "Secret ballots": one sentence on how a room declares one)
- Modify: `tests/decide-manifest.test.ts`

- [ ] **Step 1: Write the failing test** `"the manifests guide carries the secret ballot promise word for word"`: read
  `docs-site/src/content/docs/guides/manifests.md` with `readFileSync`, and for each line of
  `SECRET_BALLOT_PROMISE.split("\n")` expect the file to contain it.

- [ ] **Step 2: Run it.** Expected: FAIL on the P1 line.

- [ ] **Step 3: Write the guide section** after the `decide` paragraphs, a `### Secret ballots` subsection:
  - a manifest example: the existing `budget` example with `security`'s veto dropped and
    `surface_proposal: { rule: majority, ballot: secret }`;
  - what changes for members: votes are logged with no voter and no choice; no reason and no advisory vote;
    `read` shows the tally and, while open, only whether your own account voted; who voted is shown at close; a
    retry answers `recorded`, and a change is a vote with a new idempotency key;
  - the promise and limits as a list, each item one line of `SECRET_BALLOT_PROMISE` verbatim;
  - the two refusals, verbatim from Global Constraints, and the small-electorate warning `open` returns.
  Plain prose, the guide's existing voice; no rationale beyond one clause per refusal.

- [ ] **Step 4:** ADR 0040's revision note: replace "whose release 1 builds every path while the manifest still
  refuses `ballot: secret`" with "built in release 1 and enabled in the manifest by release 2 (2026-11-07), after
  the trace check found no stored value in a trace span". §5 "Secret ballots": add that a room declares one with
  `decide.<kind>: { rule, ballot: secret }`, refused on `single` and on a vetoed kind.

- [ ] **Step 5: Run it.** `npx vitest run tests/decide-manifest.test.ts`, then
  `npm --prefix docs-site run build` (fails on a broken link). Expected: PASS, build succeeds.

- [ ] **Step 6: Commit.** `npm run verify`, then
  `git commit -m "Secret ballot release 2: the manifests guide, ADR 0040 and the architecture page"`.
