# Synthetic bank adapter boundary

BNK-008 defines the first bank-neutral adapter contract and a deterministic in-memory fake ledger for tests. It does not connect to a bank, payment rail, account aggregator, database, or real customer account.

The compiled contract fixes an adapter ID, version, supported currencies, and exact read/post policy actions. Every operation requires a live verifier-produced tenant identity and an allow decision from the canonical deny-by-default policy gateway. The adapter calls the canonical gateway implementation directly, so an overriding subclass cannot fabricate authorization.

Synthetic seed accounts are tenant-bound and use safe integer minor units. Reads expose immutable snapshots. Posts require an exact optimistic account version, positive minor-unit amount, matching currency, non-overdrawn result, unique entry ID, and a tenant/adapter-scoped idempotency key. Exact retries return the original immutable result; changed terms fail closed. Entry evidence retains only bounded identifiers, description codes, actor provenance, and integer amounts.

This fake is deliberately unsuitable for production. It has no network transport, durable storage, credential handling, reconciliation, holds, returns, disputes, provider signatures, bank-core authority, or real-funds capability. Later roadmap units must add those controls behind independently reviewed adapters without weakening this contract.

Durable stores may rebuild a `FakeBankLedger` snapshot by supplying validated account `version` values and historical `entries`. Seeded entries are validated for account, currency, amount, direction, time and tenant-unique entry IDs; they do not change the supplied authoritative balance.
