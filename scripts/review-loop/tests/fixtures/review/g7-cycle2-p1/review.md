The login limiter introduces an unauthenticated denial-of-service path despite its per-IP protection. All 65 offline tests passed, but they do not cover email-bucket consumption by IP-rejected requests.

Review comment:

- [P1] Stop IP-blocked requests before updating email limits — C:\Users\GN User\cbc-codex-trial\lib\security\rateLimit.ts:181-183
  An unauthenticated attacker on one IP can fill all 10,000 email buckets by submitting distinct emails, because the email limiter is updated even after the IP limiter rejects the request. This blocks all previously unseen emails on that instance for up to 15 minutes, and continued traffic can sustain the denial. IP-blocked requests can also refresh targeted email lockouts indefinitely. Return the IP rejection before calling `byEmail.hit`, and add a regression test proving rejected IPs cannot consume email buckets.