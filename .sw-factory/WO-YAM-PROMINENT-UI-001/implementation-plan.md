# Default ClawMetry room and readable activity

## Summary

Make optional ClawMetry the first visible Activity view, give it a readable prominent column, move secondary cameras below the main view, and place the existing ClawMetry and BluPe branding in the room header. Explain received model calls, Guard decisions, submitted motion and measured feedback in a compact chronological story. Existing privacy, source and control boundaries remain authoritative.

## Code reuse and package structure

Use native `static/meeting.js` and `meeting.css`, optional `clawmetry-widget.js` and its scoped CSS, and existing `clawmetry-logo.svg`. Reuse the sanitized `yam.telemetry.v1` projection, typed motion rows, DuckDB-backed Guard attestations, native conversation-mode events and existing status delivery. No additional status fetch, poller, dependency, model request or control transport. The explicit contact POST and bounded submission deadline are described below.

Architecture reference: `codex-runner/docs/clawmetry-widget.md`. Update its default/layout contract. The user task supplies requirements; no external requirements or blueprint service is connected. Delivery follows the existing fork-to-Cloud-manifest-to-immutable-VM path, retaining SDK942, Pro66 and runtime df7.

## Components and flow

Select the optional native conversation-mode button once at its first successful mount. Open that selected panel during meeting initialization; later explicit tab/close actions must remain authoritative. Vanilla BluPe without the optional integration keeps existing behavior.

Keep native camera DOM, expand controls and Stop intact. CSS places the main camera across the top and other cameras in a lower row. Give Activity more desktop width; narrow and short screens retain accessible cameras, panel, composer and Stop without horizontal overflow.

Build readable activity from already-sanitized model events and motion rows. Attribute Dream only to actual reported Dream model/stage evidence. Guard allow/hold requires validated recorded Guard evidence. Sent commands, execution receipts, encoder readings and verified task outcomes remain distinct. Name missing/private data honestly. Keep joint vectors/raw stage tokens in Details. Bound and deduplicate the story so high-rate updates do not create a request storm or visual jump.

## Design plan and review against brief

Retain room #202124, activity #111b21, event surface #202c33, primary text #e9edef, muted #aebac1, mint #7ce0c3 and existing coral logo #e94644. Keep current Arial/system typography, sentence case and no decorative motion. The co-brand header is the sole strong branding accent. Camera and evidence lead; no marketing badges, invented counters or sample activity in the live product.

Desktop: co-brand and Robot room in the header; main camera on the left, wider ClawMetry on the right; three smaller cameras below the main camera; native composer and controls below. This follows the requested dark console and exposes the decision-to-action chain without replacing the shared application.

## Steps

1. Record scope and reused contracts before product edits.
2. Implement optional default selection, co-brand header and responsive lower camera row.
3. Present model, Guard, motion and feedback as a bounded readable story using existing fields.
4. Run relevant existing frontend/native tests and browser layout acceptance without commanding hardware.
5. Obtain independent review; publish fork through normal PR/CI, then Cloud provenance PR/CI/deploy and fresh-idle immutable VM activation.
6. Verify real served assets and default UI in production; save screenshot and record unchanged physical-learning limits.

## Testing

Use existing Node widget/privacy/ownership, native layout and control suites. Extend meaningful behavior coverage for default selection, chronology and stage labeling where needed. Run scoped Python extension/public-motion suites and required CI. Use a non-actuating local browser fixture for desktop/narrow layout and synthetic isolated events, never as live-robot proof. Real production acceptance must load afresh, show co-brand and selected/open ClawMetry without a click, lower cameras, accessible controls and working switch/close/reopen. No Run, queue join, movement or new camera capture is needed for this UI release.

## Email-only robot integration request

The user added an Integrate your robot entry point. Add a small email-only opt-in dialog to the optional room header. The private Cloud component owns same-origin POST /api/robot-integration, private Postgres lead storage, rate/idempotency protection and a short Resend invitation using the existing booking URL https://calendly.com/vivek-clawmetry/30min. Acknowledge durable request receipt without exposing recipient membership or provider send state; show inline retry errors. Consent copy states the specific integration-email purpose. No email address or delivery secret goes in public source, logs, screenshots or robot records. No account, subscription or newsletter enrollment is introduced. The Cloud delegate owns this component within the same work order and writes its plan before edits. No external canary email is sent until its recipient and scope are resolved. Include this endpoint in deployment/normal contract tests and verify form keyboard/error/success behavior with an isolated non-sending fixture.
