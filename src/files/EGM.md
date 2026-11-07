# files

## Overview

Room files (ADR 0046), governed config (ADR 0044), home memory (ADR 0047) and blobs: path normalization, the
planning and charge of each file write, the `/.bellman/` view, the config schemas, the `bellman_memory`
operations, and the blob store interface. Runtime-free; `R2BlobStore` is in `src/workerd/blobs-r2.ts`.

## Interface

- `[src/files/blobs.ts:BlobStore]` `put`, `head`, `get`, `delete`, `list`, `deleteAll`; `[src/files/blobs.ts:MemoryBlobStore]`;
  helpers `blobKey`, `newBlobId`, `storedType`, `sanitizeName`, `exactLength`, `MAX_BLOB_BYTES` (25 MB).
- `[src/files/fs.ts:planWrite]` room files (ADR 0046): the pure planning of each write op, `decideFsCharge` (the byte
  charge), `diffText` (the history diff), `decideFsWrite`, `resolveFsPath`, `pageFs`, `hiddenMemory`; limits
  `FS_FILE_MAX_BYTES`, `FS_HISTORY`, `FS_LIST_PAGE`, `FS_FIND_MAX`. Both stores call these inside the write's own
  transaction.
- `[src/files/fs-path.ts:normalizePath]` every path normalized before any authorization reads it; `namespaceOf`,
  `OWN_MEMORY`, `MAX_PATH_CHARS`, `MAX_PATH_SEGMENTS`.
- `[src/files/governed-view.ts:governedView]` `/.bellman/` (ADR 0046, decision 8): governed config shown as read-only files,
  rendered on every read and never stored.
- `[src/files/config.ts:getGovernedConfig]` governed room config (ADR 0044, #414): the closed set of names (`CONFIG_NAMES`),
  their schemas (`parseConfigBody`), and what each reads as when missing or untrustworthy; `decideConfigWrite`,
  `configEvent`. The only reader of `cfg:` rows.
- `[src/files/memory.ts]` home memory operations (ADR 0047), what `bellman_memory` does: `writeHome`, `readHome`, `listHome`,
  `shareHome`, `unshareNotes`, `setMemoryCapture`. `[src/files/home.ts:homeRoomId]` where an account's notes live
  (`HOME_ID_PREFIX`, `isHomeRoomId`, `homeSession`).

## Invariants

- Blobs: 25 MB `[src/files/blobs.ts:MAX_BLOB_BYTES]`; image
  types are kept only when `sniffImageType` agrees `[src/files/blobs.ts:storedType]`.

## Verification

- Run: `npm test`; `npm run verify` before every commit.
