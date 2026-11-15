# Agent scheduling and budgets

BNK-015 adds a tenant-scoped scheduler for engine agents (for example, a forecast digest drafter). It decides when an agent may run and how much it may spend; it does not execute agents or grant them banking authority.

- Contracts compile a tenant capability allowlist. Capabilities that move money, post ledger entries, decide credit, assess fees, enable overdraft or approve step-up actions are rejected at contract compilation and at registration, whatever the tenant configures.
- Registration, pause, resume and the tenant-wide kill switch require the exact `manage` policy action; due listing, run start and finish require the exact `run` action.
- Agents have a bounded interval, run time limit and budget: runs and cost units per sliding window plus a maximum cost per run.
- A run starts only when the agent is due, active, not already running, the tenant is not paused, and the remaining window budget can cover a full run. Each run reserves its maximum cost up front.
- Only the worker that started a run can finish it, before its deadline. Expired runs become `TIMED_OUT` and keep their full reservation. A reported cost above the reservation records `BUDGET_OVERRUN` and pauses the agent until staff resume it with the current version.
- All records are frozen, tenant-keyed and synthetic-only.

Not included: durable persistence of schedules, a run executor, cost metering against a real model provider, cross-tenant fairness (BNK-032) and production acceptance.
