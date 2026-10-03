# Release safety and publication

Depends on wp3 and successful post-merge integration. C4; existing gh credentials and repository workflows only. No token/cost/time budget was set. User explicitly authorized dev merges and deployment; scope includes this repository's npm-stable and desktop-production approvals, not unrelated pending deployments. No global CLI/app update or running desktop restart.

## Exact safety delta before release

MODIFY scripts/release.mjs in ensurePromoted after `if (ahead === 0) return;`, before checking --promote or reading promotion PRs:

```diff
   if (ahead === 0) return;
+  if (ctx.flags.has("--dry-run")) {
+    ctx.log("Dry-run requires dev to be promoted already; refusing to create or merge a promotion PR.");
+    throw new ExitError(2);
+  }
   if (!ctx.flags.has("--promote")) {
```

MODIFY tests/release-command.test.ts using existing scriptedRunner/BASE_RESPONSES fixtures: dev ahead + --promote --dry-run --approve --yes rejects with code 2; calls contain no pr create/merge, workflow run, pending deployment approval or git push. Dev aligned + same switches dispatches only dry_run=true with no promotion, tags or approval. Real --promote --yes still merges then dispatches expected_sha from changed origin/main. Test red before patch and green after. No actual release command is used as a test fixture.

MODIFY CONTRIBUTING.md release paragraph:

```diff
-and keeps watching until the desktop release is published. Add --dry-run to verify without touching any remote,
+and keeps watching until the desktop release is published. --dry-run runs a hosted validation workflow on already-promoted main without publishing branches, tags or packages; it refuses when dev needs promotion.
```

Preserve real/canary/resume behavior. Explain --canary creates a candidate ref and dispatches CI, and --promote with canary performs real promotion. This is a guard in the maintainer wrapper only (E7 application command), bypassable by direct gh workflow/PR operations; not repository enforcement. Final enforcement remains existing repository checks and protected environments.

## Verification and merge

Run node --import tsx --test tests/release-command.test.ts and npm run typecheck:tests. Inspect full diff and independent reviewer verdict. Publish safety repair as ordinary dev PR; wait for exact-head expected CI, merge, then inspect dev CI. Update source docs/CHANGELOG for all completed selected slices. Audit high/critical findings are blockers: no ignoring vulnerabilities to release. Scheduled audit 37111866226 was reported red on old main; re-evaluate the updated dependency set and fix any still-applicable findings through a documented amendment.

## Publication runbook

1. Refresh dev/main, open PR heads and unresolved review threads. Pin accepted dev code SHA and compare its post-merge CI/Agy/desktop/CodeQL run events, attempts and actual jobs. Required checks must finish successfully.
2. Existing maintainer command: `npm run release -- patch --promote --approve --yes`. Run in managed background after readiness is green. The script creates/merges dev→main promotion; attach its PR to this task, inspect promotion checks and main push CI. If automatic merge cannot satisfy protections, finish the same promotion only after actual gates pass.
3. The cut dispatch pins main SHA, publishes preview, tags version, lands version on dev, publishes stable npm, pushes desktop tag through signed-in maintainer, approves only this version's named environments, and watches desktop publication. Never equate dispatch success with publication.
4. If interrupted after cut, use `npm run release -- resume X.Y.Z --approve --yes` for the same version, after reading current tag/main/npm proof. Do not bump a second time to hide partial release.
5. Verify npm view ima2-gen@X.Y.Z version gitHead dist.integrity dist.tarball plus latest; GitHub vX.Y.Z/desktop-vX.Y.Z tags, published desktop release assets/checksums, workflow builder identities, and Pages deploy result. Use repository package-install/published UI smoke against released artifact; do not install globally. Record artifact digests and rollback path (previous immutable version/release retained; corrective release if needed).
6. Archive unit to devlog/_fin/261003-issue-pr-release after evidence closes; update active ledger and final summary. Report platform boundaries: hosted package/build proof does not establish real NSIS/Squirrel update installation.
