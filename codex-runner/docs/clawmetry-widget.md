# Optional ClawMetry evidence panel

The optional panel sits inside the existing Blüpe playground. It receives the existing status flow and makes no status, model or camera request. Robot controls, queue admission and the camera viewer remain upstream-owned. The normal launcher loads none of these assets.

## Design plan

Use the playground's own paper, ink, line and Manrope/system typography. One compact disclosure directly after the camera/chat layout opens into paired columns for published decisions and execution/feedback. It takes normal page space before run history, outside the viewport-sized camera grid. The camera scene remains dominant. A visible source-age label ages even if polling stops. On a phone, the panel uses one column; no fixed overlay covers Run or Stop. Every selector is scoped to the panel.

The palette inherits `--paper`, `--ink`, `--muted` and `--line`; restrained blue identifies ClawMetry, blue/amber identify the left/right arm readings. There is no decorative animation or replacement dashboard. This deliberately follows the actual robot console rather than introducing a separate marketing surface.

## Application contract

Inject `telemetry-status.js`, `clawmetry-widget.css` and `clawmetry-widget.js` through the existing `application-head` slot. Scripts must load before the deferred `hosted.js`.

`hosted.js` calls optional `window.yamTelemetry.observe(view)` after the existing run/robot guards. The neutral projection is `window.YamTelemetryStatus.project(state, {robot_id, displayed_identity, received_at_s})`, schema `yam.telemetry.v1`. The displayed identity contains only the existing guarded run's attempt/run/episode IDs; a stale public run cannot fill a new attempt's gap. New submissions call the optional payload-free `reset` observer to clear old browser evidence. Poll failures call `window.yamTelemetry.connection(view)`. Observer exceptions and rejected promises do not affect controls.

The server must attest `state.telemetry.public_run_shared === true` before task text, model labels, published notes or tool requests enter the projection. Missing attestation means no model content. Only `state.public_run` is used for model events. Owner interactions, raw requests, system prompts, credentials, capabilities, leases, CSRF and private reasoning are excluded. A few credential patterns are additionally redacted from public text; this does not replace server-side per-run secret handling.

`run.present` is a boolean from the guarded displayed identity, so idle copy differs from a task with sharing disabled without publishing that task's identifiers or contents.

Recording IDs, attempt IDs and episode IDs are separate. A queue's public run ID can be its episode ID. Own controller receipts and `state.telemetry.recording = {state, trace_id}` are used only when the published run matches that controller's attempt or episode. Otherwise execution/persistence remain unconfirmed. Station feedback has its own source timestamp and is never treated as proof of a model action.

The panel keeps at most 80 changed snapshots and 96 deduplicated public events in browser memory. Its optional download is explicitly browser evidence, not a durable ClawMetry export. A recorder receipt is needed before local recording can be described as active; waiting, recording, closed, incomplete, disabled and unavailable are distinct local journal states. Database persistence remains unconfirmed in this panel and must be verified separately. Station reports are explicitly independent of session feedback, including when a later station report differs from a completed task's measurement. No browser state is persisted to localStorage.

## Verification

`node --test codex-runner/tests/test_clawmetry_widget.cjs` covers projection allowlists, source clocks, sharing defaults, independent IDs, scope matching, bounds/deduplication, history reset, observer error containment and zero-network rendering. The complete upstream Python and Node suites remain required. Real fork-browser acceptance and recorder-to-DuckDB evidence are separate checks, and must precede an upstream PR.

## Existing hosted products

A hosted application can retain its own billing, analytics and provider hooks:

```python
from clawmetry_playground import with_clawmetry
InstrumentedProduct = with_clawmetry(ExistingHostedRunnerSubclass)
```

The mixin composes with the application's page, session, public/action and status hooks. It also supports pages that have already consumed the application-head marker. The ordinary CLI stays unchanged; local users opt in with `./run-clawmetry.sh` or `./run-playground.sh --clawmetry`.

Publication consent is captured with the actual source journal/attempt. A future launch's sharing preference cannot authorize an older run. Known in-memory credentials are masked before native shared output is serialized; private owner recordings retain their original content. The optional Pro attachment additionally binds each recorder to its own source session and journal.
