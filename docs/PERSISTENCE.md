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

## Account ownership

`migrations/002_ownership_and_journal.sql` adds `ledger_account_holders` (owner or joint, append-only, synthetic-only). The synthetic directory seeds holders. Customers can read, forecast, chat about and dispute only accounts they hold; a request for any other account returns `ACCOUNT_NOT_FOUND`, so existence is not disclosed. Staff roles remain limited to their tenant by the policy gateway. `GET /v1/me/accounts` lists the caller's held accounts (`null` for staff).

## Module command journal

Engine modules from BNK-014 onward, the BNK-010 audit hash chain and the BNK-005 consent ledger keep their state in memory and are made durable by a command journal (`src/runtime/command-journal.mjs`, table `module_journal`):

- Each operation has an async `prepare` that may read the store and resolve server-side evidence, and a synchronous, deterministic `apply` against the domain modules. Read operations are not journaled.
- After a successful `apply`, the resolved command, the verified actor claims and the time are appended with the next global sequence number. Failed operations are never journaled.
- At start-up the journal is replayed in order through `apply` with the recorded actor and time, rebuilding identical module state. Replay errors are counted and reported on `/health`.
- Single writer: a sequence-number conflict means another process appended first. The process then fails stop: it rejects further requests with 503, reports `journal.fatal` on `/health` and exits so the platform restarts it, and the restart rebuilds from the journal. A failed append fails stop the same way, because memory would be ahead of storage.
- The journal is append-only (trigger enforced) and synthetic-only.

Trade-offs: replay time grows with the journal, and scaling beyond one writer needs per-aggregate storage rather than a single journal.
