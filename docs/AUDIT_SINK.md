# Observability and audit sink

BNK-010 adds an in-memory, bank-neutral append-only sink for synthetic operational audit metadata. Every write and read requires a live verifier-produced tenant identity and an exact allow decision from the canonical deny-by-default policy gateway.

Contracts define a bounded allowlist of non-sensitive scalar attributes. Records reject raw payloads, messages, stack traces, credentials, prompts, documents and customer fields. Each tenant has an independent monotonically increasing sequence and SHA-256 hash chain. Exact retries return the original record; changed terms and duplicate record IDs fail closed. Queries are tenant-scoped, bounded and policy authorized.

This unit is synthetic and memory-only. It does not provide durable log storage, distributed ordering, external metrics or tracing adapters, alert delivery, retention enforcement, export, key management, trusted timestamping, independent verification or production deployment. Those controls require later independently accepted units and authorized infrastructure.
