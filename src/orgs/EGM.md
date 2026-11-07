# orgs

## Overview

Orgs and their audit trail: org policy and join refusals, audit rows and queries, the hash chain and SIEM sink,
the audit entries a grant writes, and invite mail. Runtime-free; `AuditDO` is in `src/workerd/audit-do.ts`.

## Interface

- `[src/orgs/orgs.ts:joinRefusal]`, `parsePolicyPatch`, `ownsByForm`, `scimSeatKey`;
  `[src/orgs/audit.ts:auditRows]`, `auditWhere`, `auditRefusal`; `[src/orgs/audit-sink.ts:chainHash]`, `chainWalk`,
  `deliverBatch`, `nextSinkState`; `[src/orgs/grant-audit.ts:grantAuditEntries]`; `[src/orgs/invite-mail.ts:inviteLink]`, `verifyInviteLink`, `inviteMailer`.

## Verification

- Run: `npm test`; `npm run verify` before every commit.
