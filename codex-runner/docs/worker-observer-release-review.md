# Optional observer release review

## Round 1: changes requested

Scope: generic worker observation lifecycle and prepared-pool reuse. This review
contains no private capture implementation or host enablement. The source base is
`060792304c058363fc63be56cb1ab40a77a086ae`.

The existing 73 worker-observer, prepared-pool and readiness tests pass in an
independent sanitized environment. Four additional inert-SDK cases confirm that
null, array or integer release results and object-valued cleanup flags retire the
physical worker. Default-off release still returns an empty result; constructor
paths stay service-owned and command-supplied observer paths remain ignored.

### Blocking finding: failed cleanup loses its sticky result at worker release

Area: `remote_yam/dream_worker.py`, release handling after SDK reset.
Review dimension: requirements alignment, lifecycle correctness and privacy.

The bridge correctly remembers a throwing extension close as unsuccessful.
The worker immediately clears that bridge even when close returned false. A
second JSON-lines release then sees no observer and returns
`observer_cleanup_ok: true` while the same process is still alive. The first
failed cleanup has therefore been converted into a successful receipt. Normal
pool close retires the first failed receipt, but direct worker IPC or an explicit
release before handle close can lose this failure before a later pool decision.

An independent real JSON-lines exchange with the inert SDK reproduced:

```json
{"first_release":{"observer_cleanup_ok":false},"second_release":{"observer_cleanup_ok":true},"worker_alive":true}
```

Required correction: retain the failed observer or an equivalent sticky worker
cleanup-failure state until process retirement. Clear and re-arm observation only
after successful cleanup. Add a native IPC regression guard for repeated failed
release and subsequent fixed-context updates so failure cannot authorize a fresh
capture binding. Keep native SDK outcomes, queue/lease, Stop and model selection
unchanged. A fresh review is required after correction.

## Scope and remaining gates

No model, robot, credential or real Dream SDK call was made. The tests use local
controlled SDK subprocesses. Prepared host composition, private observer behavior,
actual SDK reset/session isolation, latency, full capture, deployment, browser
acceptance and physical robot acceptance remain separate pending gates.

The first independent test attempt omitted the system utility directory from its
sanitized PATH, causing five MuJoCo-import sysctl lookup failures. Correcting the
test environment produced 73 passes; no implementation change was made for that
setup error.

Reviewed tracked diff SHA256: `b75ca21abd89d5b554f12fa2bce4d694011efab8f5c4a94f2d69ec0ee83b93bb`.

## Round 2: approved

The failed-cleanup result now stays sticky for the entire worker lifetime.
Successful observer cleanup alone clears the observer and re-arms the existing
constructor-fixed deferred binding. A throwing close retains its bridge and
marks the process unsuitable for future work. Further release returns false
without SDK calls; all other commands fail before SDK work until process restart.
Normal prepared-pool release retires that process through the existing bounded
recovery path. This refuses future work after uncertain cleanup; it does not
rewrite the preceding native SDK inference result or replay inference.

Independent verification:

- All 74 observer, prepared-pool and readiness tests pass in a sanitized
  environment, including actual JSON-lines exchanges with the inert SDK.
- Additional IPC checks cover RuntimeError, SystemExit and KeyboardInterrupt
  during extension close. Release stays false on three further attempts,
  extension close is called once, and prime/configure/reset/predict/unknown
  commands add no SDK calls.
- An independently prepared inert worker also rejects later configure, predict
  and reset after failed cleanup, with no new SDK calls.
- Four fake-worker recovery cases reject false/string cleanup flags and
  null/array result containers, close replacement workers, keep readiness false
  and perform no inference.
- The new committed regression test guards first-scope capture, repeated failed
  release, a changed service-owned context and refusal of later capture. Its
  failure on the prior implementation is retained in the implementation record.

NATIVE-OBS-RELEASE-001 is resolved. No blocking findings remain for this generic
source change. No private observer implementation, host wiring, real SDK/model,
robot or credential behavior was exercised or enabled by this approval.

Plan alignment advisory: clarify original plan step 2 to say reference clearing
and re-arming occur only after observer cleanup succeeds. Failed cleanup now
requires process retirement and refuses later work. This review round records
that intentional privacy boundary; the default-off and successful paths keep
their existing behavior.

Deployment, actual SDK/session isolation, per-guest private capture, hot latency,
public browser traces and physical robot acceptance remain pending separately.

Round 2 reviewed tracked diff SHA256: `1c564681376a9b2e34f1b53e2e7d2da79e040114b48e7610b7a3b1c85c55d864`.
