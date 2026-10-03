# Issue and PR release train

This train fixes the OAuth image-job deadline, integrates reviewed dependency and video sound-intent PRs, and publishes the result through the existing release pipeline. Durable job recovery (#338) and the provider-adapter RFC (#150) remain open because their execution/compatibility contracts require independent designs.

- Archetype: satisfy-spec; trigger: maintainer request on 2026-10-03 to delegate with inherited context, repeat PABCD, merge dev, and deploy.
- Goal: land selected changes with passing per-PR and post-merge gates, then verify npm, desktop release assets, and Pages.
- Non-goals: paid provider generation, persistent role changes, native GitHub stacks, new credentials, data migrations, local app installation/restarts, #338/#150 implementation.
- Verifiers: focused behavior tests, typechecks, lint, inventory, UI build and rendered interaction evidence, exact-head PR Fast Gate/CodeQL, post-merge CI, tagged release/publish/desktop/Pages runs. Conditional cases are specified per decade document.
- Stop: selected slices merged and publication evidence recorded. Missing external access is reported honestly; queued or skipped required checks are not completion.
- Memory artifact: this numbered implementation unit and session-local .codexclaw receipts. Existing structure and devlog conventions are reused.
- Outcomes: DONE with all selected proof; individually NOOP only when already resolved; unresolved external dependency reported as BLOCKED/NEEDS_HUMAN without pretending release success.
- Escalation: scope changes return to a documented P amendment; failed checks are repaired, not waived. No cost/token/wall-clock bound was requested. Existing gh credentials and repository publication mechanisms only; no additional spending or provider-generation probes.

## Work-phase map

| Cycle | Document | Outcome | Dependency |
|---|---|---|---|
| wp0 | 000/001 and all decade documents | Audited docs-only roadmap | none |
| wp1 | 010_dependencies.md | Reviewed dependency update carry merged to dev | wp0 |
| wp2 | 020_oauth-deadline.md | Whole OAuth job timeout implemented and merged | wp1 |
| wp3 | 030_sound-intent.md | Audio rejection and sound presets integrated and merged | wp2 |
| wp4 | 040_release.md | Release safety verified, selected dev changes published | wp3 |

The ordering freezes dependency/runtime inputs before behavior changes, then integrates the UI and finally publishes the tested tree. These are ordinary sequential PRs; no native stack registration. Main owns git, goal and FSM; V1 multi_agent_v1 children inherit model/history, have bounded file scopes and never own branches or goals.

## Source baseline and tree

origin/dev = 862e0bd73f59a3b419503a9dec39b6f83ef2bed6. Managed checkout adopted in place as codex/261003-issue-pr-release. Node 24.17.0, npm 11.18.0.

```
lib/oauthImages.ts, responsesTransport.ts, oauthRateLimit.ts  # deadline owners
ui/src/components/, lib/, i18n/                            # sound intent
package*.json, ui/package*.json, .github/workflows/codeql.yml # dependency pins
tests/, ui/e2e/                                             # behavior proof
scripts/release.mjs, .github/workflows/                     # existing publication
structure/, devlog/_plan/                                  # existing source of truth
```

SoT sync: update the owning architecture notes for OAuth/UI contracts and devlog/_plan/README.md; regenerate test inventory and structure line counts when targets change. Archive this unit only after every work-phase closes.

## Consultation

Architect: 01a1020f-23c4-7fa0-a5e4-1e627cd5e059. ARCH-01 (ordinary carries), ARCH-02 (dependency-first verification), ARCH-03 (one deadline), ARCH-04 (composer audio rejection), ARCH-05 (persisted prompt chips), ARCH-06 (bounded deferrals), ARCH-07 (post-merge release gates) accepted. Concrete docs submitted for same-agent reflection; independent A audit follows reflection.

## Baseline verifier observations

2026-10-03: npm ci and npm --prefix ui ci exit 0 (Node 24.17.0/npm 11.18.0). npm run typecheck exit 0. node scripts/classify-tests.mjs --check --fail-js-runtime exit 0; node scripts/refresh-structure-line-counts.mjs --check exit 0. node --import tsx --test tests/release-command.test.ts: 18/18 pass. Existing OAuth focused tests: 26/26 pass (see .codexclaw/oauth-baseline.log). These commands directly read existing target modules/test files; new planned tests cannot execute before implementation and remain explicitly unverified. Hosted release verification is not invoked during roadmap planning.

Architect reflection: ARCH-01..07 ALIGNED. Main folded four 030/010 clarity corrections and the ARCH-03 provider-conditional compatibility correction into the concrete docs. No open architectural decision remains; implementation acceptance rows remain required at their cycles.

## wp0 roadmap closeout

Independent reviewer 01a10217-edfa-7812-9645-9a3a2bcf1560: VERDICT PASS, no roadmap blockers. Accepted synthesis: API-key persistence must remain un-raced; wp2 requires named activation fixtures before B, wp1 must resolve applicable high advisories, wp3 must execute rendered matrix, wp4 must verify actual publication. This docs-only cycle locks the roadmap; no production code has changed. Next direction is dependency/remediation wp1, with root remedy resolved in P before implementation. Existing baseline green tests did not test the newly proposed deadline and do not prove a fix.

## wp1 closeout

PR #369 merged to dev as be63eb0ece2a5c16ef53100453e3675b9a723f52 after PR Fast Gate run 37129880344 (pull_request, attempt1, head055f9cd0, merge-ref fa449b8319549051e0fc941018510814a2010ddf) completed all four jobs successfully; CodeQL37129880348 and screenshot gate succeeded. Independent implementation reviewer 01a10228-446d-7922-b08e-dc37202c4fa4: PASS, zero blockers. No unresolved review threads after merge.

Local full suite:4131 total,4128 pass,3skip,0fail. Hosted backend:4131 total,4127pass,4skip,0fail (runner ffmpeg coverage differs). Typechecks, lint0errors/92warnings, runtime/UI builds, native-deps, inventory, install policy and audit gate pass. UI raw audit0; root retains5high under one evidence-backed unreachable-path exception expiring2026-10-17UTC, plus5moderate. This is not a clean raw root audit. Browser NodeCanvas drag/connect/selection, keyboard preview, panning at390px and real PNG+editable-memo PPTX export passed; console/pageerrors0 and teardown complete. PPTX SHA25635ecdd3cdcea1b7609e457165b0f27749d07b2bd0135321e953f045a9d1f5d6d; screenshot pr-assets d141618d. Native PowerPoint rendering and real trash OS operations were not tested.

Initial full-suite failures exposed missing generated runtime JS, required cleanup retry options, and billing fixture socket reuse. Runtime build and scoped fixture corrections made the original suite green; no gate/threshold was weakened. Downgrading trash was rejected because platform fixes would be lost.

Next direction: wp2 OAuth deadline from020 with API preservation and explicit remaining test fixtures. Post-merge dev CI37130901715, desktop37130901665, Agy37130901684 and CodeQL37130901676 were observed queued/running at be63eb0e; they remain mandatory before the next merge/release and are not claimed passed here. Source dependency slice itself is verified and merged.
