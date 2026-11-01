# ADR 0045: Room cost is captured raw into a CostDO and priced when read

**Date:** 2026-11-01 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-11-01-room-cost-metering-design.md`

## Context

The operator needs each room's cost and each plan's margin to set plan prices (#473, epic #477). Cloudflare bills the
account, not the room, but its GraphQL Analytics reports duration, requests and rows per Durable Object for 90 days.
Grants and org records hold only their current state, so who held which plan last month is lost once it changes.

## Decision

1. **Cloudflare measures, Bellman records.** Nothing meters inside a room. A daily cron reads Cloudflare's per-object
   usage and maps each object id to a room by `idFromName`. It lists the blob bucket for each room's bytes.
2. **A dedicated `CostDO`** (`idFromName("cost")`, SQL tables) holds everything the capture records. None of it
   goes in `RegistryDO`, which every join and sign-in waits on. The capture reaches rooms only through
   `listRoomsPage`.
3. **Raw capture, classified at read time.** Each day records each room creator's plan through `planOf` with
   `raw: true` (no `honourPurchases`, no org standing), each org's seats, source and standing, and counts of
   individual purchase grants. Paid, comped and free are decided when the cost page is read, so a corrected rule
   reprices every past day.
4. **Creator-pays.** A room's cost goes to its org, or to its creator when it has none. Its whole month goes to the
   plan that owner held on the most days. Revenue is list price, prorated by the days each plan was held.

## Consequences

- The capture wakes no room. Its registry reads delete a lapsed grant when they meet one, as every sign-in does.
- A run resolves at most 150 creators (`MAX_COST_CREATORS`) to stay inside one invocation's 1,000 subrequests. Past
  that, the day records `creatorsCapped`.
- Without `CF_ANALYTICS_TOKEN`, a run still records plans, rooms and blobs. Usage can be recovered for 90 days.
- `CostDO` is a class added by migration `v4`. A build without it cannot be redeployed over it. To stop the capture,
  remove the cron, not the class.
- Room cost misses SQLite storage per room, R2 operations, and work in the registry, auth and audit objects.
  Coverage, the share of each namespace's usage that maps to a room, is the check that says how much is missed.
