# Banking home and balance freshness

BNK-011 provides a bank-neutral, tenant-isolated home projection over the canonical adapter. Every projection requires a live verifier-produced identity, an exact banking-home policy decision and the adapter's independent account-read authorization.

Balances remain integer minor units and totals are separated by currency. Each account reports provider evidence as `fresh`, `stale` or `unknown` against a bounded deployment-configured window. Missing observation time is never presented as fresh, future timestamps fail closed, and the projection does not estimate or mutate a balance.

This unit is synthetic and memory-only. It does not provide a customer interface, provider connectivity, durable preferences, pending-transaction reconciliation, real-time guarantees, branding, accessibility acceptance or production deployment.
