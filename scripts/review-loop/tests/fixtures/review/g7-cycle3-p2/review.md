The offline tests pass (75 passed, 0 failed), but the shared admission cap does not enforce the claimed rolling provider-call budget when asynchronous execution is delayed.

Review comment:

- [P2] Enforce the provider budget when queued work executes — C:\Users\GN User\cbc-codex-trial\infra\supabase\migrations\001_scan_admission.sql:104-104
  When Inngest processing or retries are delayed, the admission expires from this window before its reserved Web Risk calls necessarily execute. `inngest/functions/processScan.ts` calls providers without rechecking the reservation, so delayed jobs from an expired admission window can execute alongside newly admitted jobs and exceed the advertised 1,000 calls per rolling 24 hours. Reserve or consume the provider budget at execution time, or prevent expired reservations from making calls; counting admission timestamps alone does not enforce that cost bound.