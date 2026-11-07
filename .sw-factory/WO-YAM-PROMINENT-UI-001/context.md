# Execution context

- Work order: WO-YAM-PROMINENT-UI-001; id yam-prominent-ui-20261107.
- Status: planned; product files not yet changed.
- Requirements: user's default ClawMetry tab, co-brand header, secondary cameras below, wider activity and clear model-to-robot story.
- Architecture: codex-runner/docs/clawmetry-widget.md; native meeting shell; sanitized telemetry and typed motion/Guard evidence.
- Referenced blueprints: none linked by the local architecture reference. Filesystem records substitute for unavailable Software Factory MCP.
- Branch: feat/yam-default-brand-20261107, base a8a996ef7e16a795f08c236d1a790b3829b4391e. Push only to user remote clawmetry; origin is upstream.
- Delivery: https://github.com/vivekchand/blupe-remote-yam and https://playground.clawmetry.com/ via private Cloud manifest and immutable VM. Reuse SDK942/Pro66/runtime df7.
- Exclusions: no Run, robot/model command, capture, safeguard/calibration change, private-data publication or JEPA/RL qualification.

## Local candidate verification

All457 existing/updated Node cases pass, plus6 focused room/contact cases pass (0 skips). Scoped Python extension/public-motion checks:103 pass. Full native Python suite is running before publication. A browser-only isolated fixture loads actual hosted.html, optional assets and native scripts with every request locally fulfilled. Six viewport sizes pass initial selection/open, branding, lower camera row, no horizontal overflow, native panel close/reopen and503→202 contact behavior. Fixture screenshots are explicitly simulated and are not production proof. Receipt: /private/tmp/yam-ui-local-browser-receipt.json. No robot/model/email request was sent externally.

Exploration found and fixed a deferred-script initialization race: telemetry could create the optional tab before the meeting shell existed. One DOMContentLoaded reconciliation completes branding and initial mobile-open state after the native shell, without a new observer or poller. Later explicit choices remain authoritative. A long robot label also exposed a375px native run-filter overflow; optional scoped min-width rules contain it.

## Review corrections and broader verification

Independent review found a bottom-sticky toolbar overlapping mobile Activity. Narrow/short layouts now place the native controls above the workspace and pin them at the top during scrolling. The native panel's inherited stacking/slide animation is removed only in the optional layout so expanded review can appear above the toolbar. Six viewport checks pass again, including scroll pinning, expanded-review hit tests/Escape, and mobile contact top-layer hit tests. Source screenshots remain explicitly simulated.

Broad native Python run:1961 passed,100 optional-environment skipped,353 subtests;4 failures were missing joblib in the isolated test venv. Installing the existing declared UMAP/numba runtime into that venv resolved all4 in a9-test targeted rerun (9 passed). No product dependency changed. Required repository CI will validate its fully provisioned environment.
