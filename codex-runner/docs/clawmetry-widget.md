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

`clawmetry_hosted.create_app(origin, runner_type=ApplicationSubclass)` accepts a trusted subclass of `ClawMetryPlayground`. Omitting the argument preserves the standard class and the existing HTTPS, queue, visitor-owned provider and localhost-only subscription restrictions. Application selection is server code, never a browser-supplied class or import path.

Applications can override `telemetry_secrets(visitor)` to extend the default in-memory secret tuple from `super().telemetry_secrets(visitor)`. The optional recorder resolves this method dynamically. Return a bounded tuple of known nonempty strings, or raise when the supplier is unavailable; failures and malformed values reach the private consumer rather than becoming an empty-secret success. Additional application secrets must also be remembered in that visitor's `public_redactor` before any native public output. This hook supplies existing in-memory values; it adds no credential loading, requests, polling or control authority.


## Trusted worker observation and packet decisions

`DreamWorker(..., observer_module=None, observer_context_path=None)` defaults to no
extension. Only service code selects these local paths; inherited observer path
variables are stripped. After the existing SDK1.0.0 version check, the worker loads
the module's `create_observer(context_path=...)`. The object may implement
`install(client, source_trace=...)`, `prediction(context)` as a context manager,
`drain()` and `close()`. The existing SDK trace object permits observation of
actual native stage identities. The extension owns its sanitized capture and
bounded asynchronous storage. It must never modify the SDK's request, response,
return values, exceptions or HTTP connection policy. No headers or model payloads
are added to the public event channel by these hooks.

`DreamAdapter(..., run_context=None)` accepts a trusted callable for native
attempt/session/episode/robot identifiers. Each worker prediction receives an
independent `call_id`, `first_step_id`, model and actual available observation
source/time. Additional context fields are discarded. The adapter does not load
credentials or change the selected checkpoint through this hook.

Every worker reply can include top-level `observer` metadata, including native
error/reset/release replies. Metadata is detached JSON, limited to32KiB,64rows
per list/object and depth8. The service's recorder consumes these references;
they are not a wire-payload transport or a public sharing grant. Missing,
throwing or malformed observers leave native action/error behavior intact and
report unavailable coverage. Shutdown is best effort; extensions must keep all
callbacks bounded and avoid blocking native control.

`RunnerController(..., trajectory_decision=None)` is an optional trusted service
callback `(waypoints, observation, context) -> {'decision': 'allow' | 'reject'}`.
Native plan/schema validation precedes it. Arguments are detached and returned
replacement targets are ignored. Context contains source attempt/session/episode,
robot/trajectory/first-step IDs and10Hz cadence; available measured timestamps
remain in the supplied observation. An installed callback must explicitly allow;
exceptions/malformed decisions/refusals send no packet. Native Stop, session,
lease, episode and attempt checks run again afterward and before submission.
Home/parking remain native and separate. Refusing a future packet does not prove
physical stopping. Default `None` preserves ordinary dispatch.

Source model/provider identity survives provider cleanup using only bounded
fields from that run's captured configuration in `status.source_model`. The live
`status.provider` still becomes null after cleanup. Unknown identity is shown as
`Model not recorded`, never inferred from a future model picker.

A service may supply `state.telemetry.detail = {path, attempt_id}` (or matching
`public_run_id`/`episode_id` when an attempt ID is unavailable). Only the exact
same-origin path `/clawmetry/trace/<32 lowercase hex characters>` for the displayed
source enables **Open full trace**, in a new tab with `noopener noreferrer`.
Queries, fragments, credentials and external URLs are rejected. The service must
implement ownership and sharing checks on that route; the link grants no access.
Absent metadata preserves the ordinary panel and adds no request or poll.


For actual native transformation evidence, `DreamAdapter(...,
evidence_observer=None)` accepts a trusted one-argument callback. Immediately
after each source calculation it receives detached JSON
`{layer, waypoints, first_step_id, context}`. The layers are `nominal_waypoints`
and `motion_limited_waypoints`; `context` carries the exact corresponding worker
prediction's call/source IDs. Returned values are ignored. Missing/throwing
callbacks do not change targets, results or native validation. This is a private
service observation seam, with no public publication or enforcement behavior.


Selected camera ticks retain a bounded `frame_sources` mapping using the same
model-video keys as `frames`, with actual `source_captured_at_s` (or null when
unavailable) and `received_at_s` per frame. These source camera clocks remain
separate from measured-state `observed_at` and SDK monotonic tick time. This adds
no images, public event or poll; service observation can preserve exact provenance.
