# surface

## Overview

The working surface: normalizing and applying a surface write, frames and placement, card and message search,
and topic-room proposals. Runtime-free, imported by both stores, the tools and the routes.

## Interface

- Surface: `[src/surface/surface.ts:normalizeSurfaceWrite]`, `normalizeSurfaceBatch`, `applySurfaceWrite`, `withPlacement`,
  `SURFACE_KINDS`; `[src/surface/frames.ts:readWindow]`, `placeSurfaceWrite`, `parseWindow`, `MAX_FRAMES = 100`,
  `SURFACE_PAGE = 64`; `[src/surface/search.ts:searchCards]`, `searchMessages`.
- `[src/surface/proposal.ts:decideApproval]` a topic-room proposal approved, refused or stale against the card it names.

## Invariants

- Surface: 1,000 items `[src/surface/surface.ts:MAX_SURFACE_ITEMS]` (enforced in `[src/room/rooms.ts:checkAgainstFacts]` as a
  read-then-write courtesy bound), 100 frames `[src/surface/frames.ts:MAX_FRAMES]`, batches of 1 to 100
  `[src/surface/surface.ts:MAX_SURFACE_BATCH]`, bodies of 8,000 characters.

## Verification

- Run: `npm test`; `npm run verify` before every commit.
