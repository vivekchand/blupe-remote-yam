# Fixed calibration prerequisite review

## Independent source review, 2026-11-21T00:15:58.888224+00:00

Verdict: **Approved for the generic native prerequisite only.** Base
`11285dc122c0db1928aec1a12523343269d6abb0`. The optional constructor profile is serialized before
threads, retained as bounded immutable JSON and decoded separately for physical
prime and owner recovery configure. No visitor command updates that snapshot.
None preserves the previous command shape. Native worker calibration validation
and refusal of different bindings remain unchanged.

Independent verification: all 84 pool, observer, readiness and calibration tests
pass with no skips in a sanitized environment. Eleven additional inert cases
cover dict/list cycles, excessive encoder recursion, unsupported values/keys,
negative infinity, the exact 256 KiB boundary and one byte over, caller/copy/worker
mutation, owned recovery propagation, default wire compatibility and refusing a
closed owner's recovery. Recovery retains its existing None return contract.
No prediction is replayed or introduced in preparation/recovery.

No blocking or advisory source finding. Constructor checks establish JSON
serialization and encoded-size bounds; they do not certify geometry semantics,
freshness or station identity. Existing native calibration validation remains
the authority. A different geometry requires a new prepared physical process.

The reviewer changed no implementation. Tests use inert workers or the existing
controlled SDK fixtures, with no actual SDK/model/robot/network or credential
operation. Host composition, live calibration, actual SDK behavior, per-guest
capture, latency, deployment and browser/physical acceptance remain separate.

Normal own-fork CI and merge remain required. This review adds no upstream
publication request and no private capture implementation.

Reviewed tracked diff SHA256: `8ed67e7d5b71ae6987ae7b7f2e5a58ee3ee8242d5dce26b337ac583806ec1c64`. Untracked new test
and plan files are pinned separately in the private review receipt.
