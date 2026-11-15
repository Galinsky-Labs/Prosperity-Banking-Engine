# Hardship assistance workflows

BNK-016 models a customer-first hardship case: `OPEN -> PROPOSED -> OFFERED -> ACCEPTED | DECLINED`, with expiry returning an unanswered offer to `OPEN`.

- Customers open cases with tenant-configured reason codes and bounded account lists; exact replays return the same case and changed terms fail closed.
- Agents and staff with the `draft` action may only propose options from the tenant catalog (deferral, fee waiver, payment plan, rate reduction, referral) within each option's duration bound.
- A different human with the `decide` action and fresh multi-factor authentication approves which drafted options are offered. Drafters and the case customer cannot approve.
- Only the case customer can respond. Acceptance requires `affirmative: true`, the current disclosure version and an offered option before expiry. The resulting arrangement is a record with `requiresAdapterExecution: true`; this unit never posts entries, waives fees or changes credit.
- Every transition is version-checked and appended to a frozen history. `collectionsPaused` reports whether any unresolved case covers an account so collections contact can be suppressed.

Not included: persistence, notifications, adapter execution of arrangements, regulatory hardship rules for specific jurisdictions and production acceptance.
