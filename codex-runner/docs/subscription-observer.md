# Passive subscription observations

Hosting products can override `HostedRunner.subscription_observer` to return a
callback for one authenticated subscription verification. The default returns
`None`. No telemetry is stored, published or sent by the shared runner.

The hook receives the trusted visitor and validated provider/model, plus
`operation='run'` or `'check'`. Request fields cannot select a callback. Run
validation, the existing visitor lock and the busy check still precede the
verification hook. The explicit Check again route retains Origin, CSRF and
visitor authentication. The hook does not run while loading the page.

The callback accepts one independent event dictionary. It must perform only
bounded, nonblocking work. The hosting product owns secret redaction, capture
consent, expiry, ownership and bounded storage. Do not persist a visitor, access
token, adapter or controller through the hook. An ordinary callback exception disables
observation for that call and emits a fixed warning without exception text.
Native verification, its result and its errors continue unchanged.
Process interrupts and exits propagate. Coroutine functions, async callable
objects and async results are rejected. Returned native coroutines are closed;
host tasks and futures are never awaited or cancelled by this observer.

`verify_subscription(..., observer=callback)` and
`probe_subscription(..., observer=callback)` also expose the same optional seam.
These calls never create robot authority or a task. A call ID is correlation
metadata, not a capability. Separate calls use separate IDs, even when a callback
is reused. The internal sink is shared only within a verification and its probe.

Events contain `name`, `state`, `call_id`, string nanosecond wall/monotonic clocks
and `clock_domain='runner_process'`. Names are:

| Name | Meaning |
| --- | --- |
| `subscription.verify` | The complete status/check result |
| `subscription.status` | Local sign-in/setup status |
| `subscription.probe` | Adapter setup, real text-only probe and cleanup |
| `subscription.model` | Actual structured CLI model call, only if invoked |
| `subscription.validate` | Whether the returned decision passes the existing connection-check validation |

`state='returned'` means the function returned. Check `ready`, `verified` and
`result_state` on verification events before describing a connection as verified.
Model return and validated connection are separate boundaries. A missing login
does not produce a model event. Errors report a class name, not an exception
message or raw CLI diagnostics. No extra inference, retry or robot API call is
introduced.

The model boundary includes the actual fixed text-only probe input. It has no
user task or images. Its output contains only public structured tool decisions;
internal reasoning, unknown tool types/names and unknown response fields are excluded. Declared adapter
reasoning effort, response speed and timeout are marked `configured_*` when
available. They do not claim upstream resolved settings or usage. The task's
later requested settings are not applied to this fresh subscription probe.

Payloads are independent JSON copies with a 256 KiB event limit. Before encoding,
capture rejects shapes above 4,096 nodes, 16 levels or 262,144 characters per string. The
serialized event limit is not a process memory limit. The observer
cannot mutate the actual request/result. Unsupported or oversized capture emits
the boundary with `capture_coverage='payload_unavailable'` and no input/output.
The actual model call and return value are not truncated. A capture limit is
missing evidence, not a model failure. Source fields may still require trusted
host redaction before storage.

These are runner boundaries, not upstream HTTP attempts. This seam does not
change the existing visitor-lock wait around preflight, promise preflight
cancellation, prove physical stopping or verify a robot task. Private request
history and correlation with admitted tasks belong to the hosting product.

The authenticated explicit check routes use
`HostedRunner.check_local_subscription(visitor, provider, model='')`. This
synchronous entry includes the existing model selection/validation before
calling `verify_local_subscription(..., operation='check')` once. A trusted
host can wrap that entry to retain a rejected model check, without creating a
task or changing the observer factory's post-validation contract. The routes
retain their fixed provider and availability gates and schedule one worker
call. Authentication, Origin and CSRF checks still precede the entry.

A host wrapping both entries must retain one call-local request context and
finalize it in the owning synchronous worker. A blank model may become the
native canonical default, so raw-model equality is not an ownership check.
Cancelling an HTTP await does not cancel the worker or prove the probe stopped.
