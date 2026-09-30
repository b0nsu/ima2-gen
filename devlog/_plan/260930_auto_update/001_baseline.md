# 001 baseline and architect consultation

## Baseline gates (origin/dev 9237c870, before any change)

| Command | Exit | Reads the change target |
|---|---|---|
| npm run typecheck | 0 | yes — tsconfig.json include covers lib/, routes/, server.ts, config.ts |
| npm run typecheck:tests | 0 | yes — tsconfig.tests.json covers tests/*.ts |
| npm run lint | 0 | yes — eslint.config.mjs covers server/lib/routes/bin/scripts/ui/src/desktop |
| npm run test:inventory | 0 | yes — scripts/classify-tests.mjs:26 lists tests/*.test.* |

Logs: /tmp/ima2-au/base-*.log (outside the repo).

## Architect consultation

- Handle: Sol architect agent 01a0f201-1087-7721-bbd2-6085f950aa6a (read-only).
- Proposal: decisions D1-D10 (module layout, cache schema, scheduler, routes, CLI update,
  desktop state machine, IPC, served UI, macOS template dot, tests).
- Main dispositions: D1 accepted (flat lib/update*.ts owners); D2 amended (re-read + merge +
  atomic rename, no cross-process lock); D3 accepted, env name IMA2_DISABLE_UPDATE_CHECK kept from
  the goal; D4 accepted; D5 accepted (artifact-based service detection, new CLI performs the
  restart); D6 amended (autoDownload default stays true because the user asked for auto-update);
  D7 accepted; D8 amended (indicator in SidebarTopStrip, which every mode renders, instead of
  SidebarChrome; state in a hook instead of a new zustand store); D9 accepted; D10 accepted.
- Reflection (same architect): MISALIGNED with 8 gaps; all folded as R1-R8 into 010 (R1 cache lock,
  R2 channel match, R3 shared coalescing), 020 (R4 service ownership + health proof, R5 CLI
  updated notice, R8 clean JSON), 030 (R7 sticky download states + autoUpdate timer toggle) and
  040 (R6 shared update store, mobile indicator, notice host). The architect's D1-D10 mapping
  confirmed every accepted decision has a plan section; the two rejections (autoDownload default,
  plain lock-free writes) are recorded in 000 — the second is now superseded by R1.
