# Optional ClawMetry evidence panel

The optional panel sits inside the existing Blüpe playground. It receives the existing status flow and makes no status, model or camera request. Robot controls, queue admission and the camera viewer remain upstream-owned. The normal launcher loads none of these assets.

## Room layout and integration contact

The optional integration uses the existing dark meeting console. Its header shows
ClawMetry × BluPe, Robot room and the native navigation. ClawMetry is selected once
at first mount and Activity opens after the native meeting shell is ready. Later
tab selections and closing Activity remain authoritative. Ordinary BluPe loads
none of these optional assets and keeps its own defaults.

On desktop, the main camera is beside a wider Activity column; other camera tiles
sit below the main camera. On narrow or short screens, cameras, Activity and the
native prompt stack vertically. Native camera expansion, Stop, queue admission
and conversation controls retain their owners. Scoped optional CSS changes grid
placement without rebuilding camera or control elements.

Integrate your robot opens an email-only contact dialog on the canonical
ClawMetry playground. Other hosts link to that canonical form. An explicit form
submission sends `{email, consent:true}` once to the same-origin
`POST /api/robot-integration` endpoint with `X-Clawmetry-Contact: 1`, without
cookies. The private hosting application owns validation, storage and email
follow-up. This form does not write to robot records, newsletter lists or
browser storage. Success acknowledges a saved request and offers the configured
meeting link; it does not claim that an email was delivered. Failed submissions
retain the email for a deliberate retry. There is no background contact request.

## Readable activity

`clawmetry-activity.js` summarizes projected native motion rows into a bounded
story of model stage timings, submitted targets, gateway receipts and encoder
feedback. Progress folds per trajectory and only the latest feedback row remains
in the primary list; technical Details retain the larger journal window. Native
journal IDs establish native order. Unchanged snapshots retain the existing row
nodes and scroll position.

A separate model card uses only sharing-approved model events and the actual
reported model identity. It is not joined causally to the native journal or Guard
sequence. Latest Guard evidence remains separate and requires its existing
recorded provenance. Request duration, gateway acceptance, packet completion and
encoder readings are distinct from verified task success. No raw HTTP payload,
private reasoning or arbitrary native message enters the primary activity list.

## Move log tab

A fifth conversation mode, `clawmetry`, shows the station's move log: packets,
waypoints, gateway receipts, stage timings and measured arm feedback, newest
last. The button and its panel are created at runtime by `clawmetry-widget.js`
and appended to upstream's own `.conversationModes` strip and beside
`#liveConversationPanel`. Neither `hosted.html` nor `hosted.js` is edited, so an
upstream merge cannot conflict with the tab. Because the button carries
`data-conversation-mode`, upstream's generic handler wires it like the rest; the
panel settles its own visibility on upstream's `yam:conversation-mode` event,
which that handler dispatches last. The widget's own click handler performs the
whole switch too, so the tab works whether or not upstream wired it.

**Motion is not behind the conversation sharing consent.** `public_run_shared`
still gates task text, model labels, published notes and tool requests. Motion is
a separate, narrower channel published for every run on the station, because it
carries no text from the run: `remote_yam.public_motion` emits only an event id,
a timestamp, the journal kind, bounded tokens such as a gateway code, counts,
durations, waypoint vectors and measured joint angles. Conversation kinds
(`model_request`, `model_response`, `model_progress`, `steering_*`) and wire
kinds (`http_exchange`, `http_connect`) are absent from `MOTION_KINDS` and cannot
enter. `telemetry-status.js` re-applies the same allowlist, so a new server field
reaches the page only if both lists are edited. Every sentence in the tab is
written in the browser from the kind and its numbers; no journal `message`
string is published.

A 10/20/30 Hz `packet_progress` stream folds to one advancing row per trajectory, in
place, so a move reads as a live counter rather than hundreds of rows. The server
publishes at most 200 rows projected from the last 600 journal events, cached on
the journal's own monotonic sequence so an idle journal is not re-projected for
every visitor's poll. The browser accumulates up to 500 rows per run so a long
run's early moves survive the server window sliding past them. Measured payload
for a realistic twelve-packet run: 73 rows, 17KB per poll; the full 200-row
window is 50KB. Activity rendering adds no request, poll, socket or camera. The contact form is the separate explicit POST described above.

The station's own journal is the only source. When the published run belongs to
another host, or the journal cannot be read, the tab names that gap
(`remote_host`, `unavailable`) instead of rendering an empty log, because an
empty move log reads as a robot that never moved.

## Application contract

Inject `telemetry-status.js`, `clawmetry-activity.js`, `clawmetry-room.js`, `clawmetry-widget.css` and `clawmetry-widget.js` through the existing `application-head` slot. Scripts load before the deferred `hosted.js`. Room branding finishes at DOMContentLoaded after the later native meeting script creates its shell.

`hosted.js` calls optional `window.yamTelemetry.observe(view)` after the existing run/robot guards. The neutral projection is `window.YamTelemetryStatus.project(state, {robot_id, displayed_identity, received_at_s})`, schema `yam.telemetry.v1`. The displayed identity contains only the existing guarded run's attempt/run/episode IDs; a stale public run cannot fill a new attempt's gap. New submissions call the optional payload-free `reset` observer to clear old browser evidence. Poll failures call `window.yamTelemetry.connection(view)`. Observer exceptions and rejected promises do not affect controls.

The server must attest `state.telemetry.public_run_shared === true` before task text, model labels, published notes or tool requests enter the projection. Missing attestation means no model content. Only `state.public_run` is used for model events. Owner interactions, raw requests, system prompts, credentials, capabilities, leases, CSRF and private reasoning are excluded. A few credential patterns are additionally redacted from public text; this does not replace server-side per-run secret handling.

`run.present` is a boolean from the guarded displayed identity, so idle copy differs from a task with sharing disabled without publishing that task's identifiers or contents.

Recording IDs, attempt IDs and episode IDs are separate. A queue's public run ID can be its episode ID. Own controller receipts and `state.telemetry.recording = {state, trace_id}` are used only when the published run matches that controller's attempt or episode. Otherwise execution/persistence remain unconfirmed. Station feedback has its own source timestamp and is never treated as proof of a model action.

The panel keeps at most 80 changed snapshots and 96 deduplicated public events in browser memory. Its optional download is explicitly browser evidence, not a durable ClawMetry export. A recorder receipt is needed before local recording can be described as active; waiting, recording, closed, incomplete, disabled and unavailable are distinct local journal states. Database persistence remains unconfirmed in this panel and must be verified separately. Station reports are explicitly independent of session feedback, including when a later station report differs from a completed task's measurement. No browser state is persisted to localStorage.

## Verification

`node --test codex-runner/tests/test_clawmetry_widget.cjs` and `pytest codex-runner/tests/test_public_motion.py` cover projection allowlists, source clocks, sharing defaults, independent IDs, scope matching, bounds/deduplication, history reset, observer error containment and zero-network rendering. The motion checks additionally cover the conversation/wire exclusions, the numeric field bounds, publication without the sharing consent, the per-trajectory fold, the window cap, the named journal gaps and the tab's own visibility against upstream's handler. The complete upstream Python and Node suites remain required. Real fork-browser acceptance and recorder-to-DuckDB evidence are separate checks, and must precede an upstream PR.

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
robot/trajectory/first-step IDs and the actual selected 10/20/30 Hz cadence; available measured timestamps
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


### Latest upstream carry-forward (local validation)

This composition is based on Andrew's shared upstream commit `04d8d2768172ee0b1fc290c3b2a3bb25995b18db`. The meeting shell, run library, task cloud, durable native recordings and configurable cadence remain upstream-owned. ClawMetry adds its optional tab through `application-head`; it selects ClawMetry once as the initial Activity tab and extends the existing dark meeting palette with scoped optional CSS. Status still comes from the native fetch, with no additional widget poller. The pre-dispatch callback and private Dream capture receive the actual selected cadence.

The new upstream optional task-cloud stack includes `sentence-transformers`, `umap-learn` and `numba`; these are not required by the optional ClawMetry pane and have not been installed during this local carry-forward. Existing native public-catalog proxy behavior remains unchanged. Live browser acceptance, local Pro attachment and a physical run require separate operator verification. The carry-forward itself commanded no physical run. Subsequent optional room changes retain the same control and sharing contracts.
