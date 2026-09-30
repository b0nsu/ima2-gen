# 002 wp2 execution plan (build lanes)

LOOP-CONTINUITY-01: wp1 D concluded "roadmap locked at d3a5d5a2 after 5 audit rounds; build wp2
from 010-040 with the amendment sections authoritative". This cycle keeps that direction.

Stale check (P, wp2): origin/dev is still 9237c870 and `git diff 9237c870 HEAD -- lib routes bin desktop
ui server.ts config.ts` is empty, so every file:line in 010-040 still holds.

## Lanes (Sol subagents, same checkout, disjoint write scopes, no git commands)

| Lane | Doc | Write scope | Starts |
|---|---|---|---|
| L1 npm core | 010 | lib/updateVersion.ts, lib/updateCache.ts, lib/updateCheck.ts, routes/update.ts, routes/index.ts, server.ts, config.ts, tests/update-core.test.ts, tests/update-routes.test.ts | now |
| L3 desktop | 030 | desktop/** (listed files), tests/desktop-updater.test.ts, tests/desktop-tray.test.ts, tests/desktop-update-state.test.ts | now |
| L4 web UI | 040 | ui/src (listed files), four locale files, tests/update-ui-contract.test.ts | now |
| L2 CLI | 020 | bin/lib/npmUpdate.ts, bin/lib/updateNotice.ts, bin/commands/update.ts, bin/ima2.ts, bin/lib/helpText.ts, tests/update-cli.test.ts, tests/cli-help-safety-contract.test.ts | after L1 (imports lib/updateCache.ts, lib/updateCheck.ts) |

Main owns: git commits per lane, docs/migration/runtime-test-inventory.md regeneration, CHANGELOG,
README, structure/, skills/ima2/SKILL.md, and full gates.

## Integration and gates (C)

`npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `node scripts/classify-tests.mjs` then
`npm run test:inventory`, focused `node --experimental-test-module-mocks --import tsx --test tests/update-*.test.ts
tests/desktop-update*.test.ts tests/desktop-tray.test.ts tests/cli-help-safety-contract.test.ts`, full `npm test`,
`cd ui && npm run build`, a CLI smoke (`node bin/ima2.js update --help`, `update --check` against the live registry with a
temp IMA2_CONFIG_DIR), a server smoke (`GET /api/update/badge` on a temp-config server) and the UI screenshot with a
seeded version.json.

