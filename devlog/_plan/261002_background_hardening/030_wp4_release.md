# 030 wp4 — patch release and outcome

1. Preconditions: dev CI green (020 step 5); local `main`/`dev` refs fetched; `gh api repos/lidge-ai/ima2-gen --jq .permissions.admin` is true (desktop tag ruleset requires admin).
2. No `--dry-run` step: scripts/release.mjs:417 runs `ensurePromoted` (which merges the promotion PR, :251) before it reads `--dry-run`, so a "dry run" with `--promote` is a real promotion (audit B5). The real run below is user-authorized. Follow-up recorded in 040: make `--dry-run` skip the promotion merge.
3. Run: `npm run release -- patch --promote --approve --yes` from a clean checkout of dev (scripts/release.mjs). It merges the promotion PR, dispatches release.yml on that main sha, approves npm-stable and desktop-production, pushes desktop-v3.26.1, and watches until the desktop release publishes. If it stops after the tag: `npm run release -- resume 3.26.1 --approve`.
4. Verify:
   - `npm view ima2-gen dist-tags --json` → latest 3.26.1.
   - `gh release view v3.26.1` and `gh release view desktop-v3.26.1 --json assets` (DMG/ZIP/NSIS/AppImage + blockmaps + latest*.yml).
   - Manifest mirror: `curl -fsSIL -o /dev/null -w '%{http_code}' https://github.com/lidge-ai/ima2-gen/releases/download/v3.26.1/latest-mac.yml` and `latest.yml` → final 200 after the 302 redirect (desktop.yml mirror job, #359).
   - Pages deploy run dispatched and green.
5. Outcome: write 040_outcome.md (versions, run ids, shas, what was not verified), update devlog/_plan/README.md active lane, PR to dev, merge after PR fast gate (docs-only skip path).
6. BLOCKED/NEEDS_HUMAN: an approval or signing step that needs a human or admin token the CLI lacks; record the exact stopped step and resume command.
