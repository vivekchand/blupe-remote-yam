# Interactive Blüpe playground with ClawMetry

## Summary
Deliver REQ-BLUPE-006 using the actual upstream playground in the owner's fork, with an optional embedded evidence panel. The earlier station-only viewer remains a monitoring baseline and does not satisfy this clarified goal. Raise no upstream PR before real end-to-end acceptance.

## Code Reuse And Package Structure
Reuse codex-runner/static/hosted.html, hosted.js, hosted.css, playground.HostedRunner, local_playground.LocalPlayground, multi_robot.fleet and existing providers/camera/stream/history modules at fb1aaa9. Preserve vendor attribution and upstream controls.

Public fork: add telemetry-status.js, clawmetry-widget.js/css, a guarded observer in the existing render/poll lifecycle, a supported application extension/launcher, tests and documentation. Use application-head for optional assets; normal upstream launch must work without ClawMetry. Paid parser/recorder implementations remain private in clawmetry-pro. Reuse instrument_blupe, BlupeObserver, RobotRecorder, daemon ingestion and DuckDB. Private HostedRunner attachment/lifecycle glue and dynamic secret handling may be added there; deployment configuration belongs in clawmetry-cloud.

## Components And Flow
HostedRunner retains visitor, Origin, CSRF, provider admission, queue and controller ownership. Optional private instrumentation observes the owned controller and writes through RobotRecorder; the daemon remains the only DuckDB writer. Telemetry errors cannot alter original results, exceptions or control authority.

After existing run/switch guards select the correct live run, the one-second status flow emits an optional detached allowlisted view model. Fields: schema version, robot, independent attempt/recording/episode identities, public task/model/status, bounded published note/tool events and source-timed numeric observations/receipt states. Exclude provider keys/headers/endpoints, capabilities, lease/CSRF tokens, raw requests/system prompts and opaque reasoning. Episode IDs are not recording IDs; nearby station samples do not prove causal motion.

ClawMetryWidget renders task, published note, requested action, sent/accepted action and reported feedback distinctly. It adds no status/model/camera requests. A display-only clock may age stale evidence. Robot/run switches clear old evidence; repeated delivery deduplicates. Missing data stays unavailable; malicious text uses text nodes; extension errors and rejected promises are contained. Source sharing consent and owner/private scope remain explicit.

Public hosting retains upstream restrictions: visitor-owned model connections unless separately approved bounded inference is configured; Codex/Claude subscription access remains localhost. Never tunnel the current operator runner or rewrite a third-party Origin/auth/CSP boundary. Use a dedicated stable runtime for in-memory visitors/background workers, not the autoscaled SaaS app. Root finalizes hosting after runtime audit.

## Steps
1. Fork upstream into vivekchand/blupe-remote-yam; use isolated feat/clawmetry-widget. Reopen Factory WO73 with requirement v3/blueprint v8 and REQ-BLUPE-006.
2. Implement public projection/widget and private attachment in parallel with disjoint file ownership. Root owns app composition, launcher, Factory and deployment.
3. Launch the actual fork on a separate localhost port; retain current services. Verify original/fork desktop/mobile UI and real read-only camera/queue paths.
4. Run a real bounded non-motion model task in an explicitly labelled test environment. Trace actual source identities through widget, recorder, daemon/DuckDB and export/reopen. Simulation cannot prove hardware outcomes; physical execution requires actual readiness/feedback.
5. Independently review code, privacy and control boundaries. Run required suites and meaningful red-before/green-after regressions.
6. Deliver private changes via normal Pro/cloud release if needed; deploy pinned fork at canonical domain and verify actual served files/interactive model flow. Retain working monitor until replacement passes.
7. Prepare minimal optional upstream PR only after real acceptance. Report genuine external model/hardware prerequisites without manufacturing success.

## Testing
Run the upstream codex-runner Python suite with its isolated venv and node --test codex-runner/tests/*.cjs. Extend shared-conversation, local-playground and session-switch tests. Add widget tests for absent/throwing/rejecting integration, safe projections with secret sentinels, sharing off, cross-robot/run races, dedupe/bounds, malicious text, stale/missing samples, and requested versus confirmed movement. Assert zero extra network polling and unchanged control flow.

Private tests exercise actual upstream controller/log seams, recorder/daemon/store, lifecycle cleanup, per-run secret redaction and disabled/unentitled behavior. CUA acceptance uses actual fork UI, cameras and a real model turn; verify persisted/rendered values and source IDs, not synthetic production seeds. Check Host/Origin/CSRF/session ownership, private isolation, mobile layout and licensed artifact delivery. Save screenshots and sanitized proof. No upstream PR until real acceptance is complete.
