# Dash settings: which key a plan resolved through

**Issues:** bellman-sh/dash#9, the identity-resolution part. The rest of #9
(API keys, profile edits, deleting an account) needs Worker routes that do not
exist and moves to follow-ups. Builds on the panel's browser session
([dash browser session](2026-10-02-dash-browser-session-design.md)) and on
plans as runtime data (`resolvePlan`, `replanOnRefresh` and `claimGrant` in
`src/oauth/routes.ts`).

**Status:** design agreed 2026-10-09; this document is in review.

**Scope:** the Worker tells a panel session the key its plan resolved through
and the person's stable key; the panel's Settings page shows both, says what
they mean, and warns when a plan rests on a key the next re-check will not
consult. Two PRs, one here and one in dash, mergeable in either order (D7).

## Problem

dash#9 asks that a person can see which identity key their entitlements
resolved through, so that a plan which silently disappears is diagnosable from
the panel rather than discovered later. Today `/account` says where a plan came
from (`plan_source`: `operator`, `grant` or `default`) but not which key it was
found under, and the panel has no reliable way to work it out.

#9 was written against four keys, `<provider>:<login>` among them, with a
renamed login as its example. That case is gone: `identityKeys` returns
`<provider>:<subject>`, `<provider>:<email>` and `email:<address>`, and nothing
resolves through a login. What remains is narrower and still silent:

- A sign-in consults all three keys. Every later re-check consults only
  `immutableKeys`, which is the subject. A panel session re-checks on its first
  request more than `ACCESS_TOKEN_TTL_SECONDS` (10 minutes) after the last one,
  as a refresh does.
- A grant found under an address is moved onto the subject at sign-in
  (`claimGrant`), so it survives the re-check. If the move fails, it does not.
- An operator override in `BELLMAN_USERS` filed under an address is never
  moved, and cannot be: it lives in a Worker secret. It applies at sign-in and
  is gone at the first re-check. The person sees their plan fall to free about
  ten minutes after signing in, and `/account` says only `default`.

There is a second gap underneath. The id an admin needs in order to grant a
plan is the person's subject key, `github:4308278`. The panel cannot show it:
`user_id` is `u_<provider>_<subject>` on the default and grant paths, but an
override supplies the whole identity, so an operator-assigned id such as
`u_jesse` says nothing about the subject behind it.

## Decisions

### D1. `plan_key` is the key the current plan resolved through

Three states, and the difference between the last two matters:

- a key, such as `github:4308278` or `email:jesse@example.com`: the override or
  grant that decided the plan is filed under it;
- `null`: nothing matched, and the plan is the default;
- absent: not known. The session was signed in before this change, or the
  caller is not a panel session (D4).

`resolvePlan` returns it as `key`, beside `source` and `keys`: the matching
override's key, the grant's key as D2 defines it, or `null`. `replanOnRefresh`
returns `key` the same way. It consults the subject alone, so after a re-check
`key` is the subject key or `null`.

### D2. A grant is reported where it is filed after the claim, not where it was found

`claimGrant` returns the key the grant is filed under when it finishes: the
subject key when the grant was found there or the move succeeded, and the
address key it was found under when the move threw. `resolvePlan` reports that
as `key`.

Reporting the key the lookup matched would warn about a grant that is fine. An
address-keyed grant is found under the address once, at the sign-in that moves
it, and is under the subject from then on. A failed move is the one case in
which the grant stays under the address, and there the warning (D6) is true:
the next re-check will not find it.

### D3. The session record carries `plan_key`, and every re-check rewrites it

`PanelSession` gains `plan_key?: string | null`. `finishSession` writes
`resolved.key`. `AuthStorage.replanSession` takes `planKey` as a new argument
after `planSource` and merges it with the identity and plan source under the
rules it has today: merge into what is stored now, and do nothing when the
record is gone. Four places change with the signature: the interface,
`MemoryAuthStore`, `AuthDO` and `AuthStore`, which forwards to it.

A record written before this change has no `plan_key`, and reports none until
its first re-check: within ten minutes of the deploy for a session in use. No
migration.

Authorization codes and refresh tokens do not gain the field. Nothing on the
token path reads it (D4).

### D4. `/account` reports `subject_key` and `plan_key` to a panel session

`sessionCaller` returns `planKey`, the stored `plan_key` or the re-check's
`key`, and `subjectKey`, `immutableKeys(stored.identity_keys)[0] ?? null`.
`caller`'s return type gains both as optional. The JSON form of `/account`
adds:

```json
{ "subject_key": "github:4308278", "plan_key": "github:4308278" }
```

A bearer caller gets neither field: the access token carries no keys, and its
clients, agent sessions and the bridge, have no use for them. The fields are
absent rather than `null`, because `null` means "nothing matched" (D1). The
HTML form of `/account` is unchanged.

### D5. Settings shows who the person is, stable key first

`/settings` loads `/account` through `orSignIn`, as `/billing` does, and
replaces the placeholder with two sections.

**Who you are:** the label, the role, the org when there is one, and two ids:

- **Stable id**, `subject_key`, in a `<code>` with `select-all`, so that one
  click selects it: "The id an admin grants a plan to. It stays the same if you
  rename your login or change your email."
- **User id**, `user_id`, smaller: "What your rooms are filed under."

No copy button. `select-all` is plain CSS, and a clipboard call brings
permission and focus edge cases for the sake of one string.

### D6. How the plan resolved, in one of four messages

The plan, its source in the words Billing's `sourceText` uses, and a link to
Billing for limits and usage. Then one message, chosen by `plan_key`:

| `plan_key` | Message |
|---|---|
| absent | This Worker does not report which key your plan resolved through yet. |
| `null` | No grant or override is filed under your id. To be granted a plan, give an admin `github:…`. |
| equal to `subject_key` | Resolved through your stable id. |
| any other key | Resolved through `email:…`, an address. A plan filed under an address applies at sign-in only: the next check, within 10 minutes, looks at your stable id alone. Ask whoever set it to file it under `github:…`. |

The last row is the case #9 exists for. It shows only until the first
re-check; after that the page shows the `null` row, which is also true and
says what to send an admin.

### D7. A panel ahead of its Worker says "not reported"

The panel deploys on its own schedule. `AccountInfo` types both fields as
optional, and an absent field is read as not reported, the way `listRooms`
reads an absent `truncated`. The stable id reads "Not reported yet", the first
message in D6 shows, and nothing warns. The two PRs can merge in either order.

## What this does not do

- Change which keys are consulted, their order, or the precedence of operator
  over grant over default.
- Fix the address-keyed override. Making it durable would reopen what
  `immutableKeys` closed: an address can change hands, and a re-check must not
  resolve a stranger's plan onto this session. Refusing one at parse time is a
  follow-up.
- Report keys to bearer clients, or put them in tokens.
- Edit anything. Settings is read-only.
- API keys, profile fields or account deletion.

## Errors

- `/account` keeps its refusals: a 401 with no session, which the panel turns
  into sign-in, and anything else surfaces on the route's error screen with its
  retry.
- `claimGrant` still swallows a failed move. It now also returns the key it
  left the grant under, so the failure shows on the page as an address key
  (D2).
- A failed `replanSession` write is handled as today: logged, the session kept,
  and the next request re-checks again. The request's `planKey` comes from the
  re-check itself, so the page is right even when the write fails.

## Testing

Worker, in `tests/panel-session.test.ts`:

- `replanSession` merges `plan_key` with the identity and plan source and
  nothing else: the existing merge case, extended.
- Sign in through the panel flow and read `/account` on each branch: an
  override under the subject, an override under an address, a grant under the
  subject, a grant under an address that moves, a grant under an address whose
  move throws, and nothing. Each asserts `subject_key` and `plan_key`.
- Past `ACCESS_TOKEN_TTL_SECONDS`, the address override's session re-checks
  and reports `plan_key: null` with the default plan.
- A session record without `plan_key` answers `/account` without the field, and
  has it after its re-check.
- A bearer call to `/account` gets neither field.

Worker, in `worker-tests/auth-session.test.ts`: `AuthDO.replanSession` stores
`plan_key`.

Dash, in `src/router.test.tsx`, against the stubbed Worker:

- stable id: both ids and the label, "Resolved through your stable id", and
  `/account` asked with the cookie;
- default: names the id to give an admin;
- address key: the warning, naming both keys;
- fields absent: the page renders, the stable id reads "Not reported yet", and
  nothing warns;
- `/settings` joins the existing case that sends a refused loader to sign-in.

## Files

bellman:

- `src/oauth/routes.ts`: `resolvePlan`, `replanOnRefresh`, `claimGrant`,
  `finishSession`, `sessionCaller`, `caller`, `/account`
- `src/oauth/storage.ts`: `PanelSession.plan_key`, `AuthStorage.replanSession`,
  `MemoryAuthStore.replanSession`
- `src/oauth/store.ts`: `AuthDO.replanSession`, `AuthStore.replanSession`
- `tests/panel-session.test.ts`, `worker-tests/auth-session.test.ts`

dash:

- `src/lib/api.ts`: `AccountInfo.subject_key`, `AccountInfo.plan_key`
- `src/router.tsx`: the settings route's loader
- `src/routes/settings.tsx`: the page; `src/routes/billing.tsx` exports
  `sourceText`
- `src/test-fixtures.ts`, `src/router.test.tsx`

## Follow-ups, not this spec

- **Per-user API keys.** `BELLMAN_KEYS` is one operator secret, and
  `rotate-key` rebuilds all of it at once. Listing, minting, revoking and
  rotating a person's own keys needs a store, `/api/me/keys` and a bearer path
  that reads it. dash#9 points at #49 for this, but #49 covers rooms and audit,
  so it needs an issue of its own. Rotating the operator's map stays a
  deploy-access action (#61) and does not come to the panel.
- **Profile and account deletion.** The Worker keeps no display name or
  avatar, has no PATCH, and nothing deletes an account or decides what happens
  to the rooms, grants and subscription of one that is deleted.
- **Address keys in `BELLMAN_USERS`.** Refuse them or warn at parse time, since
  they apply at sign-in only. The comment on `isStableIdentityKey` says
  overrides still accept a label; `identityKeys` no longer produces one, so the
  comment should say so.
