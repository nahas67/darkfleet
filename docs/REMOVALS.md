# DarkFleet Removal Log

> Hard rule: no useful capability disappears silently. Every intentional removal
> records old feature, reason, replacement, migration, and verification.
> An undocumented removal is a failure.

| Date | Old feature | Reason | Replacement | Migration | Verification |
|---|---|---|---|---|---|
| — | *(no removals executed yet; Gate 0A in progress)* | — | — | — | — |

## Queued (approved, not yet executed)

1. `App.tsx:runLocalScan` + `server.ts` inline DEMO pipeline — duplicate TS
   implementations. Replacement: single Python authority (DEMO provider).
   Execute only after golden-vector parity proof (Gate 3).
2. `App.tsx:238-246` silent REAL→DEMO fallback — spec-forbidden anti-pattern.
   Replacement: explicit `REAL_DATA_UNAVAILABLE` error. Execute during API build.
3. `App.tsx:212-217` + `:253-256` fake timer stage progression. Replacement:
   real 15-state job events over SSE. Execute during job-system build.
