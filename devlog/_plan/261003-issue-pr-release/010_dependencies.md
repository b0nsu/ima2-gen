# Dependency inputs

Depends on wp0. C4 dependency/release-input change; bounded to manifest/lock pins and CodeQL. Reuse exact reviewed upstream patches in 011 companions; no production logic changes.

## File delta

- MODIFY package.json: @modelcontextprotocol/sdk 1.30.0 → 1.30.1; @openai/codex 0.155.1 → 0.158.0; eslint 10.10.0 → 10.11.0; typescript-eslint 8.70.0 → 8.70.1.
- MODIFY package-lock.json: carry #361 and #362 resolved dependency/integrity updates, preserving the current root version and all unrelated packages.
- MODIFY ui/package.json and ui/package-lock.json: @xyflow/react range ^12.11.6 → ^12.12.0, system 0.0.82 → 0.0.83, @types/d3-selection 3.0.11 → 3.0.12 and matching integrity.
- MODIFY .github/workflows/codeql.yml: init/analyze pinned SHA 1c5b675653bb5c22dbe9b12b556ec555138e09fd → 2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2; leave job permissions, checkout identity and triggers intact.
- MODIFY devlog/_plan/README.md: insert this active unit; docs-only changelog records dependency intent without premature release version claims.

No new data fields or persistence format. No-op leaves stale reviewed fixes; configuration reuse is sufficient, so no new runtime abstraction. Before applying, compare upstream patch baselines to current dev; amend any conflict explicitly.

## Execution and proof

Main applies each pinned patch preserving source author in commits; bounded worker verifies dependency compatibility, no branch operations. Install root and UI dependencies using npm ci with repository script policy. Run typecheck then npm test and UI build, plus lint/typecheck:tests/native-deps/inventory/audit gates as appropriate. Use hosted PR Fast Gate and CodeQL at the final head as authoritative Linux integration; post-merge CI covers supported platforms. New UI dependency alone does not change screen design; use existing Node UI smoke and screenshot of tested UI for the carry if the gate requires it.

Create an ordinary dev PR containing only this dependency delta and roadmap docs. Merge only after expected jobs execute successfully, then inspect dev CI. Source #360–363 may be superseded with exact carry references only after landing. Failed install, lock mismatch, lint regression or UI smoke is a blocker requiring repair.

## Fresh security amendment

Baseline raw audit: root 5 high (trash10.1.1→globby14.1.0→fast-glob3.3.3→micromatch4.0.8→braces3.0.3, GHSA-vfj7-8cjw-p6xm); UI 2 high propagated from image-size1.2.1 (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr). Pinned source #361 does not remove these paths.

Additional MODIFY ui/package.json: add `overrides: { pptxgenjs: { "image-size": "2.0.4" } }`; regenerate UI lock to this patched parser. MODIFY scripts/audit-exceptions.json: remove the two image-size exceptions after confirming raw UI high=0. This 1→2 override is accepted only for the actual browser-only PPTX use: pptxgenjs browser mapping excludes image-size; verify build/bundle exclusion and actual PPTX export before merging. This is not a claim of Node pptxgenjs API compatibility.

Root braces has no patched published version as of investigation. At wp1 P inspect npm's trash9 remediation candidate against actual systemTrash semantics and dependencies. No new root exception is authorized by this plan; unresolved high severity blocks merge/release. Exact root remediation must be documented and independently audited before B. If no compatible remedy exists, finish independent scoped work and obtain explicit direction for the concrete remaining security decision.
