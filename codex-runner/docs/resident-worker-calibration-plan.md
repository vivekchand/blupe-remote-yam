# Fixed calibration for prepared SDK workers

The playground's selected Robo-house station configures Dream with live measured
robot geometry. DreamWorkerPool currently primes its SDK clients without that
profile and restores a visitor without it. The native worker correctly refuses
reuse when a visitor's binding differs, so the current prepared pool cannot be
substituted into this calibrated path.

Before-code plan:

1. Add an optional constructor-owned kinematics description to the generic pool.
   Snapshot bounded JSON before creating threads or SDK workers. None preserves
   existing command payloads. Reject non-object, non-finite or oversized input.
2. Pass a fresh copy of that exact description into physical worker prime and
   recovery configure. Never infer, update or replace a profile from a visitor
   command. Native worker calibration validation remains authoritative.
3. Preserve checkpoint selection, exclusive ownership, queue/lease, Stop,
   cancellation, SDK outcomes, prepared variants and bounded idle recovery.
   Do not perform inference or robot work during preparation, and never retry a
   failed inference. This adds no private capture implementation or credentials.
4. Add failing guards for immutable caller/worker isolation, prime/recovery
   profile propagation, default wire compatibility and invalid input before any
   thread/worker work. Run existing pool, worker observer and readiness tests.
   Obtain independent review, normal CI and merge in the user's fork.

This is a generic prerequisite. Host composition, live calibration freshness,
actual SDK capture between guests, latency and physical/browser acceptance stay
pending. A different calibration needs a new prepared physical process; this
change does not permit geometry changes inside an existing SDK process.
