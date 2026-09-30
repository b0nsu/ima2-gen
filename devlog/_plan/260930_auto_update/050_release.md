# 050 release 3.26.0 (wp3)

## Steps

1. Push `codex/260930-auto-update`, open a PR to `dev` with the summary, test evidence and the UI
   screenshot (uploaded to the orphan `pr-assets` branch, linked by commit SHA).
2. Wait for `PR fast gate` and the screenshot gate; fix forward on the branch until green.
3. Merge the PR (merge commit, repository default), then watch the post-merge `CI`, Agy matrix and
   macOS desktop build on `dev` (AGENTS.md "CI Layout"); fix forward on dev when red.
4. Cut the release from a maintainer checkout: `npm run release -- minor --promote --approve`
   (CONTRIBUTING.md "Releasing"). It merges the dev -> main promotion PR, dispatches release.yml,
   approves npm-stable and desktop-production, pushes `desktop-v3.26.0` and waits for the desktop release.
   If it stops after the tag: `npm run release -- resume 3.26.0 --approve`.
5. Verify: `npm view ima2-gen dist-tags` shows latest 3.26.0; `gh release view desktop-v3.26.0` lists
   the mac/win/linux assets and latest-mac.yml; `gh release view v3.26.0` exists.
6. Record the outcome in `devlog/_plan/260930_auto_update/060_outcome.md` via a docs PR to dev
   (the pattern of #354).

## Authority

The user asked to "patch and deploy" in this session: push, PR, merge to dev, the release command
and its approvals are in scope. Signing or notarization failures that need a human secret are
NEEDS_HUMAN, not something to bypass.

