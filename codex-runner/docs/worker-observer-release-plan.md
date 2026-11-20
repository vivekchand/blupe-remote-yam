# Optional observer release for resident workers

This is a generic extension lifecycle change. It contains no private capture,
recording paths, provider credentials, model selection or robot commands.

Plan before code:
1. Have WorkerObserver.close return a sticky cleanup result. A disabled observer
   closes successfully; a throwing extension stays unsuccessful on repeat calls.
   Preserve the rule that extension errors cannot replace native SDK results.
2. After successful SDK episode release, close the current optional observer.
   Only successful cleanup clears the reference and re-arms the existing
   constructor-fixed deferred binding. Failed cleanup remains sticky for the
   worker lifetime: later release stays unsuccessful and other commands are
   refused before SDK work until that process is retired.
   Return observer_cleanup_ok only for observer-configured workers. An ordinary
   unconfigured worker keeps its existing empty release result.
3. The prepared pool refuses reuse after an explicitly unsuccessful or malformed
   cleanup result. Retire the worker and use existing bounded idle recovery.
   Never repeat inference, submit motion, change queue/lease or delay native Stop.
4. Test actual JSON-lines worker exchanges with the existing inert SDK, distinct
   capture scopes across releases, capture-off, sticky cleanup failure and pool
   retirement. No real model or robot is called by these software tests.
5. Independent review and normal fork CI/merge. Deployment and actual SDK/session
   isolation, startup latency, full capture and physical acceptance stay separate.

Constructor-fixed observer module/config paths remain service-owned. No command
may supply or change either path. A private host must serialize its own context
updates after exclusive guest admission. This change alone does not enable any
resident pool in a hosted app or establish a latency improvement.
