# Durable persistence

The engine API persists the BNK-008 synthetic ledger, the BNK-007 transactional outbox and the BNK-009 evidence metadata vault in Postgres when `DATABASE_URL` is set. Without it, the process-local `MemoryEngineStore` is used; both adapters pass the same behavioural contract suite (`tests/support/store-contract.mjs`).

## Write path

Durable services authorize through the deterministic policy gateway first, then ask the store for one atomic operation. Inside a single database transaction the store locks the account row (`SELECT ... FOR UPDATE`), reads any prior idempotency record, and hands both to the unchanged domain class, which re-validates identity, policy, MFA, amounts, currency, version and funds. The store then inserts the entry, updates the account with a version guard, records the request digest and inserts the `ledger.entry.posted` outbox event and its idempotency record before commit. Any failure rolls the whole transaction back. Concurrent posts on one account serialize on the row lock and losers receive `VERSION_CONFLICT`.

Outbox claims use `FOR UPDATE SKIP LOCKED` with bounded, versioned leases. Completion requires the exact unexpired lease. Evidence storage is metadata-only and keyed by tenant.

## Schema controls

`migrations/001_engine_core.sql` creates tenant-keyed tables with check constraints for tenant format, currency, nonnegative balances, positive amounts, directions and outbox lease consistency. Every table carries `synthetic_only boolean CHECK (synthetic_only)`. Triggers make posted entries, idempotency records and evidence metadata append-only. Integers are read back as safe JavaScript integers or rejected.

## Migrations

`bin/start.mjs` applies pending migrations before serving, using `MIGRATION_DATABASE_URL` (direct connection) when present, else `DATABASE_URL`. The runner holds a Postgres advisory lock, applies each file in its own transaction and pins a SHA-256 checksum; editing an applied migration fails start-up closed.

## Testing

`tests/postgres-store.test.mjs` runs the shared contract, migration idempotency and tamper detection, append-only and synthetic constraints, a concurrent posting race and a full start-up path against a disposable database named by `ENGINE_TEST_DATABASE_URL`, using a fresh schema per test. CI runs it in a separate `postgres` job against a Postgres 17 service. `DATABASE_URL` remains forbidden in the synthetic `check` job.

## Not included

The audit hash chain and consent ledger remain process-local. There is no backup, point-in-time recovery drill, retention policy, encryption key management, replication or production acceptance.
