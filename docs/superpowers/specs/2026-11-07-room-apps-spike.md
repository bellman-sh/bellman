# Room apps spike: answers before ADR B

**Date:** 2026-11-07 · **Issue:** #563 (epic #430) · **Answers:** the Open Questions in
`docs/superpowers/specs/2026-11-01-room-filesystem-and-apps-design.md`

## Verdict

Every question but one clears Artifacts and Dynamic Workers for ADR B. The exception is purge: Cloudflare does not
say whether, or when, it deletes the copies of a repo it keeps in object storage and snapshots after the repo is
deleted. The owner ruled to proceed as if it does (below).

**Ruling (owner, 2026-11-09):** proceed on the assumption that Cloudflare deletes a deleted repo's object-storage
copies and snapshots. ADR B goes ahead with the `TreeStore` seam as designed, and PR 5 builds the Artifacts
implementation. ADR B records the assumption as an accepted risk, and the purge promise in Bellman's docs names it.
If Cloudflare later says otherwise, app source moves to `fs:` rows (Alternative C) behind the same seam.

| # | Question | Answer | How we know |
|---|---|---|---|
| 1 | Platform | Both are in open beta on Workers Paid, no sign-up. A Worker Loader binding deployed and ran on Bellman's account. | Docs; deployed probe |
| 2 | Limits | The account's plan limits for CPU and subrequests, lowerable per load. 4 dynamic workers in flight per request, 10 per Durable Object. Memory per dynamic worker is not documented. | Docs |
| 3 | Commits | 243 KB library; 42–212 ms CPU for a first commit, 6–11 ms after. A push whose branch moved is refused `stale ref`, forced or not. | Measured (Node); 21 live races |
| 4 | Purge | The repo is gone at once. Snapshot deletion is not documented. | Live delete; docs silent |
| 5 | Sockets | Yes. `globalOutbound` receives `connect()` as well as `fetch()`, and `null` blocks both. | Docs; local and deployed probes |
| 6 | Cookies | `Partitioned` cookies work in Chrome 114+, Firefox 141+ and Safari 26.2+. Safari 18.5–26.1 drops them. | MDN, WebKit, Chrome docs |

## 1. Platform

- **Dynamic Workers** have been in open beta for all Workers Paid accounts since 2026-03-24, with no opt-in
  (developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/). They are paid-only
  (dynamic-workers/pricing/).
  - Price: 1,000 unique Dynamic Workers a month are included, then $0.002 per Dynamic Worker per day. Requests and CPU
    are billed at Workers Standard rates, and startup CPU is billed as well as execution.
- **Artifacts** has been in open beta since 2026-10-01, also paid-only (artifacts/platform/changelog/,
  artifacts/platform/pricing/).
  - Price: 10,000 operations a month and 1 GB are included, then $0.15 per 1,000 operations and $0.50 per GB-month.
  - Billing starts 2026-11-12 (the pricing page, updated 2026-10-28; the changelog says 2026-10-14).
- **Probe.** A worker named `apps-spike-loader` with a `worker_loaders` binding deployed to Bellman's account
  (wrangler 4.132.0) and loaded a child from a string module. A second worker, `apps-spike-artifacts`, deployed with
  an `[[artifacts]]` binding (namespace `default`, wrangler 4.158.0; the docs ask for 4.145.0 or later).

## 2. Limits

- A dynamic worker uses the account's plan limits for CPU time and subrequests unless the load passes lower ones:
  `limits: { cpuMs, subRequests }`. Going past a limit throws at once (dynamic-workers/usage/limits/).
- At most 4 distinct dynamic workers may have requests in flight per Worker request, and 10 per Durable Object
  (dynamic-workers/platform/limits/). An app request loads one app, so this does not constrain the apps Worker. It does
  bound the gate (PR 7) if it loads several versions at once.
- A loaded isolate may stay warm, "however, this is not guaranteed" (dynamic-workers/api-reference/). No cache size is
  published.
- **Not documented:** memory and script size for a dynamic worker. The general Workers limits are 128 MB an isolate
  and 64 MiB a script. ADR B's 5 MB bundle cap is far under the script limit; memory is untested.

## 3. Commits

**Cost.** isomorphic-git 1.44.11 with memfs, in Node 22, using base64 of random bytes so nothing compresses well.
CPU is `process.cpuUsage`; peak is RSS sampled every millisecond:

| Tree | First commit (write, add, commit all) | Later commit (one file changed) |
|---|---|---|
| 1 file, 2 KB | 42 ms CPU, +7 MB peak | 6 ms |
| 50 files, 2 KB each | 102 ms, +14 MB | 9 ms |
| 20 files, 256 KB each (5 MB) | 212 ms, +39 MB | 11 ms |

- **Bundle:** 243 KB minified and 75 KB gzipped. It needs `buffer`, which `nodejs_compat` provides.
- **Not measured:** the push over the network, and the same numbers inside workerd. CPU inside an isolate cannot be
  timed from inside it, so PR 5 measures from outside, under `wrangler dev`.

**Compare-and-set.** I created a scratch repo through the binding and seeded it. Each trial made two fresh clones at
the same head, committed a different change in each, and pushed both at once from the git CLI:

- Plain pushes, 10 trials: exactly one landed every time.
- Forced pushes (`+main`), 10 trials: exactly one landed every time.
- Neither result ever had both pushes land.

The loser's message was `! [remote rejected] main -> main (stale ref)`. A forced push has no fast-forward check, so
only a check of the old head can refuse it. The server compares each ref update's old object id with the ref, as
`TreeStore.commit`'s expected-head check needs. The docs do not say so (artifacts/api/git-protocol/: "Push uses the
standard v1 receive-pack flow").

**Limits** (artifacts/platform/limits/): 1 GB a repo, 64 MiB a push, 50,000 objects a push, 32 MiB a file, 1 TB an
account (raisable). The binding has no commit method: writes go through git push. Tokens came back as `art_v2_…`; the
docs show `art_v1_…`.

## 4. Purge

**What I saw.** I called `env.ARTIFACTS.delete(name)` on the scratch repo, which answered `true`. Then:

- the repo's write token was refused (403, "Invalid or expired token");
- `get(name)` answered "Repository not found";
- a new repo created under the same name was empty, with no refs.

**What the docs say.** A REST delete returns `202 Accepted` (artifacts/api/rest-api/). Cloudflare "copies it
asynchronously to object storage and snapshots" (artifacts/concepts/how-artifacts-works/), and the beta post names R2
for snapshots. The only retention statement is that repos "remain stored until you explicitly delete them". Nothing
says the snapshots are deleted, or when.

**Why it matters.** A room's purge and an account's deletion must remove app source, because an agent may write
peer content or memory-adjacent text into it. Bellman can promise that the repo is gone at once; that the snapshots go
too rests on the owner's ruling above, not on a Cloudflare statement.

## 5. Sockets

- **Docs:** `globalOutbound` "intercepts every `fetch()` and `connect()` call the dynamic Worker makes". Setting it
  to `null` makes every such call throw, and bindings still work (dynamic-workers/usage/egress-control/).
- **Probe,** the same child module under three settings:

  | `globalOutbound` | `fetch()` | `connect()` |
  |---|---|---|
  | `null` | throws "not permitted to access the internet" | throws, same message |
  | unset | reached the site | locally, reached it; deployed, refused for port 80 as an HTTP service |
  | the parent's `Egress` entrypoint | answered by the interceptor (418) | handed to the interceptor's `connect()`, which threw, so the socket closed |

  The last row shows in the live log (`wrangler tail`) as "egress saw connect". Same result locally and deployed.
- **Design note for PR 10:** the interceptor must be an entrypoint of the parent, passed as
  `ctx.exports.Egress({ props })`, which needs the `enable_ctx_exports` flag. An entrypoint of another loaded worker
  cannot be passed: "Entrypoints to dynamically-loaded workers cannot be transferred to other Workers".

## 6. Cookies

A cookie set with `SameSite=None; Secure; Partitioned` (CHIPS) is kept in a third-party frame by:

- **Chrome** 114 and later, by default (privacysandbox.google.com/cookies/chips).
- **Firefox** 141 and later, per MDN's compatibility data (v8.1.8, 2026-11-02).
- **Safari** 26.2 and later (webkit.org/blog/17640). Safari shipped CHIPS in 18.4, removed it in 18.5 and brought it
  back in 26.2, and "blocks setting and accessing cross-site cookies when partitioning was not requested".

So Safari 18.5 through 26.1 gets no viewer cookie, and an app frame there cannot keep a session (WebKit bug 292975 is
the only source for that, a bug tracker). ADR B should name Safari 26.2 as the minimum and show a "this browser cannot
open room apps" page there, rather than fail silently.

## Cleanup

- `apps-spike-loader` and `apps-spike-artifacts` were deleted with `wrangler delete`; both URLs answer 404.
- The scratch repo `spike-cas-1794093910` was deleted twice (after the race, and again after recreating it to check
  it came back empty).
- Nothing else was created on the account. The probe code stayed in a scratch directory and is not committed.
