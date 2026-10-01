# 020 wp3 — merge #365 into dev

1. Push wp2 commits to `origin devin/1790865725-background-mode` (fast-forward on 1e528690; if Devin pushed meanwhile, rebase onto its head and re-run the focused suites).
2. Update PR body: add a "Follow-up hardening (review)" section with D1-D8 behavior and the human checks; reply in the PR with the review synthesis summary.
3. Record the reviewed sha (`sha=$(git rev-parse HEAD)` after push, equal to `gh pr view 365 --json headRefOid`). Check runs: `gh run list --commit $sha --json databaseId,event,headSha,workflowName,status,conclusion`, then `gh run view <id> --json event,headSha,attempt,jobs,conclusion` for PR fast gate (event pull_request, headSha == sha, backend + frontend jobs success and not skipped), CodeQL and screenshot-gate.
4. Merge pinned to that sha: `gh pr merge 365 --merge --match-head-commit $sha` (merge commits for feature PRs into dev, e.g. c953f854). A later push invalidates the proof and the merge refuses (audit B4).
5. Verify the dev push CI: `gh run list --branch dev --commit <merge-sha> --json databaseId,event,workflowName,status,conclusion`; CI (ci aggregate with ubuntu/windows/macos), Agy artifact filesystem check and the desktop unsigned build must conclude success for the merge sha, event push.
6. A red dev run is fixed forward on dev (CONTRIBUTING ## CI) with a new PR.
