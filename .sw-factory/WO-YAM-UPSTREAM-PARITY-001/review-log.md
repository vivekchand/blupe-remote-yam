<!--lint disable strong-marker-->

# Review Log: WO-YAM-UPSTREAM-PARITY-001

**Work Order:** WO-YAM-UPSTREAM-PARITY-001 — Sync current BluPe upstream and verify task execution parity
**Initialized At (UTC):** 2026-11-07T21:51:10Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

---

## Independent controller/Dream review, round 1

Reviewer: `/root/prominent_ui_review`. Reviewed the complete current delta from PR base `703116bb2726ead344396d48771fb2caf63f2302`, including untracked `trajectory_provenance.py` and both new regression files, controller/Dream edits, upstream Hosted Works label changes, documentation and scoped plan. No product source changes or live browser/model/robot/camera/queue/email calls by reviewer.

### Requirements and blueprint alignment

The correction addresses a real source mismatch: Dream limits against a later collector sample while the prior controller compared call-entry feedback. The candidate retains raw native degrees separately, binds a detached packet receipt to controller context/digest, uses the exact limiter baseline for path/start metrics, preserves original planning timestamps and leaves the strict 0.25-degree/0.01-gripper thresholds unchanged. Explicit Dream stale-unsubmitted recovery reuses the existing MAX2 zero-submit path and acknowledged between-prediction SDK reset; Home, Guard refusal and ambiguous transport remain excluded. Full physical task parity/success remains unmeasured.

### Architecture and conventions

The new helper is transport-free and uses exact bounded schema/source/digest validation. Private lease/origin context remains out of public interaction details and the installed callback. Existing optional feature-off behavior has a targeted regression. No broad unrelated implementation is included.

### Tests and build

Independently ran `/Users/vivek/projects/blupe-remote-yam/.venv/bin/python -m pytest codex-runner/tests/test_dream_plan_baseline.py codex-runner/tests/test_trajectory_provenance.py -q --tb=short`: **105 passed, zero skips**. `git diff --check` passed. These green tests do not cover the two real lifecycle gaps reproduced below.

### Blocking findings: source evidence lifecycle

1. **Blocking, security/data safety and requirements:** `dream_policy.py::_collect` clears history for actual `DreamObservationError` or generic collector failure without retiring the generation/pending receipt; `trajectory_baseline_current` also ignores `_failure`. An in-flight consumed receipt therefore remains admissible through an actual collector outage during fresh-station I/O or the installed Guard callback. Independently reproduced using the real inert `dream_case` adapter/controller seam: station-read hook calls actual `_collect` with a nonretryable `DreamObservationError`; afterward collector failure is true, generation remains 0, pending receipt remains present and **one packet is submitted**. Ordinary ticks must not invalidate receipts, but failed/retired capture streams must. Add regressions invoking actual collector transient, terminal and generic failure branches at both asynchronous boundaries.

2. **Blocking, source evidence freshness:** `trajectory_baseline_current` checks generation and digest but never revalidates receipt age/clock after asynchronous I/O or Guard. The initial qualification requires at most five seconds, yet a slow callback can return allow after that bound and still dispatch. Independently reproduced on the real inert seam: Guard advances a controlled wall clock six seconds then returns allow; baseline age is 6.0 seconds and **one packet is submitted**. Recheck the raw qualified timestamp and finite-clock gate on every current-receipt validation, including after Guard; do not refresh or substitute the timestamp. Add slow station/Guard and clock-regression/overflow tests.

Both reproductions used synthetic local frames/SDK/API objects only. No network or actuation occurred.

### User-facing verification

No new visible UI implementation beyond two canonical upstream Hosted Works link-label lines. Existing approved integrated room remains unchanged. Root separately supplied actual Safari evidence for the currently served prior fork; that is not candidate task-success proof. No new physical run is required or claimed by this source review.

### Verdict

**CHANGES_REQUESTED: two blocking lifecycle findings.** Keep normal CI/publication held until fixes and an independent rereview of the exact final source. No additional privacy, packet identity, threshold-widening, Home/retry-scope or task-success-claim blocker identified in this pass.


## Independent controller/Dream review, round 2

Reviewer: `/root/prominent_ui_review`. Re-reviewed the complete candidate controller, Dream adapter, new provenance helper, both new test files and root-authored architecture documentation. The untracked source/tests are included in the review. Product source unchanged by reviewer; the untouched initial placeholder review template was removed at root's request, retaining substantive round 1.

### Requirements and blueprint alignment

**No remaining technical blocker.** The exact raw native limiter baseline is detached and bound to plan nonce, full packet digest/cursor/count, source attempt/session/episode/lease/robot/API identity and cadence. The controller preserves call-entry planning provenance separately, uses the real limiter sample for start/path metrics, compares against independently fetched current station feedback, and checks receipt/cadence liveness after asynchronous I/O and the installed callback. Thresholds remain 0.25 degrees and 0.01 normalized gripper.

Dream recovery discards an exact positively unsubmitted packet, resets SDK action/frame state between predictions after acknowledgement, retires capture generations and requires newer input before another predict at the same cursor. The existing MAX2 cap remains; Home, invalid feedback/source/clock, Guard refusal and ambiguous transport cannot enter the replan path. This is bounded replanning, not learning or measured task success.

### Resolved round-1 blockers

1. Actual transient, terminal and generic collector failures now increment the capture generation, clear pending receipts/history and mark the stream unavailable. Recovery may restore new input but cannot resurrect the prior receipt. Inference generation is captured before prediction and must still match when the limited packet is produced. Normal successful ticks do not retire the stream. Independently reran the original real `_collect` terminal-failure reproduction during station I/O: **zero submissions**, generation advanced to 1, pending receipt absent, fixed refusal emitted.

2. Every current-receipt check now revalidates the original raw timestamp, finite local clock and five-second baseline age, with a nonregressing local-check watermark. Independently reran the original Guard callback advancing the controlled clock six seconds: **zero submissions** and fixed receipt refusal. New regressions cover station and Guard boundaries, expired/regressed/NaN/infinite/overflow clocks, actual transient/terminal/generic outages and recovered-outage retirement.

### Architecture, privacy and error contracts

Pure provenance helper adds no I/O/dependency. Private source context remains local and absent from public interaction/callback metadata. New refusal diagnostics are fixed tokens/numbers; hook/reset exceptions do not publish their arbitrary text. Receipt validation remains opt-in for hardware Dream runs with an installed decision callback; absence of a callback preserves existing behavior. No camera/model evidence timestamp is refreshed to make a packet pass. Source/context replacement, Stop and deadline checks remain in force.

### Independent verification

- Original two adversarial inert real adapter/controller reproductions both now refuse before any dispatch.
- New focused receipt/Dream suites: **127 passed, zero skips**.
- Broader Dream/controller/trajectory-decision/pose-recovery/feedback/steering/startup/Home suites: **452 passed, 2 skipped, 3 subtests passed**. The two optional `test_home_scene_integration.py` checks require companion station/API checkouts that were not supplied; no physical or network test was substituted.
- `git diff --check`: pass.
- Root's full native suite/normal CI and deployment checks remain separate; no claim of their completion is made here.

Reviewed source SHA256:

- controller.py: `7052bcb3caa61522eca3bd9444f9bdf3e49a1a61aab069d6668d17c126fa4768`
- dream_policy.py: `22f03d67c8fdb095281b432f18ccbd591fcc721a233f17646e89c2f7ac210e44`
- trajectory_provenance.py: `03dace23782778e2b2586896aee92a3b1983886f70bae3f5db5772e6734f8e46`
- test_dream_plan_baseline.py: `99cda5b9e3c6296920659b597aa715a968405db3ce2511d4634cbd2ca944177f`
- test_trajectory_provenance.py: `7af7c032672a01733d6d4964bfce80a44c8da7f46a31fb97dda186f0b2a19fd1`

### Upstream and user-facing scope

The two `5b406...` Hosted Works label lines and retained optional UI are scoped. Also inspected exact `5b406fb1ce69f94558acfe788e77b59ab7b358cd..7a008f0` upstream delta: only a trusted class-level `session_run_limit` defaulting to the existing 20-run limit, with `None` opt-out and corresponding copy, changes in playground.py. Five-second launch spacing and other admission gates remain. That upstream delta was reviewed from Git source before root brings it into this worktree; source/tree identity and normal CI must be pinned after the actual merge. No task-performance equivalence is inferred.

No new visible UI redesign is included. Root's actual Safari check of previously served 703116 establishes that existing room only. No candidate model request, physical task, camera acquisition, queue action or email was made by reviewer.

### Verdict

**APPROVED for the exact technical source above: both blocking findings resolved.** One minor documentation wording advisory was sent to root: call `planning_observed_at` the call-entry planning timestamp rather than implying it is necessarily the SDK's selected model-input tick time. Actual camera/tick provenance stays separate. Production/browser/physical success remains unverified by this source review; normal final CI/provenance/release are root-owned.


### Round 2 documentation confirmation

Independently inspected the corrected architecture text: it now says **call-entry planning timestamp** and explicitly preserves each selected camera/model tick's actual provenance separately. This resolves the only wording advisory. All five final technical source/test hashes above remain unchanged. The exact `7a008f0` Git delta is included in this review as described above, subject to final merged file/tree identity confirmation.

**Final verdict: APPROVED, zero remaining blocking findings or advisories.**


### Final merged source identity confirmation

Confirmed merged candidate `a38f109f9082e56bbc59610fdf6453de37808d21` (tree `3a4c00f1a54ac9c942b0a10889daa4491fd04f92`), after the reviewed `8fecdec` merge plus canonical upstream `7a008f04f2179c6beea0b6ff462ed89b6f2da956`. `HEAD^..HEAD` changes **only playground.py**, with five added and two removed lines. Independently compared all added/removed code lines against the actual upstream commit: exact match. All five technical source/test SHA256 values recorded above remain unchanged. The root-updated Current upstream sync paragraph accurately records `7a008f0`, its configurable browser-run count and preserved default20; no physical-success claim.

**APPROVED remains in effect for this merged technical source.** Root's documentation/review-log commit, normal exact-head CI and private provenance publication remain separate subsequent steps.
