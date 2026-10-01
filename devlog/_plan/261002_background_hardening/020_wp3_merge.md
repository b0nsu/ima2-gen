# 020 wp3 — merge #365 into dev

1. Push wp2 commits to `origin devin/1790865725-background-mode` (fast-forward on 1e528690; if Devin pushed meanwhile, rebase onto its head and re-run the focused suites).
2. Update PR body: add a "Follow-up hardening (review)" section with D1-D8 behavior and the human checks; reply in the PR with the review synthesis summary.
3. Wait for PR checks on the pushed head: `gh pr view 365 --json headRefOid,statusCheckRollup`; confirm PR fast gate backend + frontend jobs ran (desktop/ and routes/ changed) on that sha, event pull_request.
4. Merge: `gh pr merge 365 --merge` (repo uses merge commits for feature PRs into dev, e.g. c953f854). Screenshot gate already passed on the description.
5. Verify the dev push CI: `gh run list --branch dev --commit <merge-sha> --json databaseId,event,workflowName,status,conclusion`; CI (ci aggregate with ubuntu/windows/macos), Agy artifact filesystem check and the desktop unsigned build must conclude success for the merge sha, event push.
6. A red dev run is fixed forward on dev (CONTRIBUTING ## CI) with a new PR.
