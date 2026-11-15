# Synthetic engine HTTP API

The engine API exposes the merged BNK-004 to BNK-013 domain units over HTTP for **non-production, synthetic-only** use. It is an engine demonstration surface, not a bank, not a bank-branded application and not a customer channel. It refuses to start unless `DATA_MODE=synthetic`, serves only invented tenants, subjects and accounts, and never connects to a bank, card network or payment rail.

Runtime: Node.js 22 `node:http`, no web framework. Start with `DATA_MODE=synthetic npm start` (`PORT` defaults to 3000).

## Identity

`POST /v1/synthetic/sessions` with `{"tenantId","subject"}` issues a short-lived HMAC session token for a subject listed in the synthetic directory (`GET /v1/synthetic/directory`). The token is verified by the same BNK-004 `authenticateIdentity` contract the engine uses for any verifier. Role assignments come from the server-side synthetic directory, never from request fields. This issuer is a demo stand-in, not a production identity provider; a regulated deployment must replace it with an approved verifier.

`ENGINE_SESSION_SECRET` (at least 32 characters) signs tokens. If it is unset the process generates an ephemeral secret and sessions reset on restart.

## Endpoints

| Method and path | Unit | Notes |
| --- | --- | --- |
| `GET /`, `GET /health` | BNK-010 | Public. Health reports `dataMode`, `nonProduction` and storage reachability. |
| `GET /v1/synthetic/directory`, `POST /v1/synthetic/sessions` | BNK-004 | Public synthetic directory and session issuer. |
| `GET /v1/me` | BNK-004 | Verified identity and server-side roles. |
| `GET /v1/home?accountIds=a,b` | BNK-011 | Balances, totals and freshness. |
| `GET /v1/accounts/:id` | BNK-008 | Synthetic account. |
| `GET /v1/accounts/:id/transactions?limit=` | BNK-012 | Normalized posted transactions. |
| `POST /v1/accounts/:id/forecast` | BNK-013 | `{currency,horizonDays,lookbackDays,scheduledItems}`. |
| `POST /v1/accounts/:id/entries` | BNK-008, BNK-007 | Synthetic operator with fresh MFA only. Exact-replay idempotency, optimistic version, and a transactional `ledger.entry.posted` outbox event. |
| `POST/GET /v1/evidence`, `GET /v1/evidence/:id` | BNK-009 | Metadata only; raw content fields are rejected. |
| `POST/GET /v1/audit` | BNK-010 | Hash-chained, allowlisted attributes. Process-local in this release. |
| `POST /v1/chat` | BNK-014 | Grounded banker chat; simulated responder unless `ANTHROPIC_API_KEY` is set. |
| `POST /v1/outbox/notes`, `GET /v1/outbox/events`, `POST /v1/outbox/claims`, `POST /v1/outbox/events/:id/complete` | BNK-007 | Synthetic operator only; bounded leases. |

Errors use `{"error":{"code","message"},"requestId"}`. Engine codes map to 400 (invalid), 401 (identity), 403 (`*_DENIED`), 404, 409 (replay, version, conflicts, leases), 413, 415, 422 (funds, raw or sensitive data) and 429.

## Transport controls

Bodies must be `application/json` objects of at most 64 KiB. Responses are `no-store` with `nosniff`, `DENY` framing and a restrictive CSP. A fixed-window per-client limiter bounds abuse of the public demo. Logs contain method, normalized path, status and duration only: no bodies, tokens or identifiers from request payloads.

## Storage

Writes for the ledger, outbox and evidence vault go through store-backed durable services (`src/runtime/durable-services.mjs`); see [durable persistence](PERSISTENCE.md) for the Postgres adapter. Each write re-runs the unchanged domain validation on a snapshot loaded from the store, then persists atomically. `MemoryEngineStore` is the process-local adapter used by tests and when `DATABASE_URL` is unset. Accounts are tenant-scoped synthetic fixtures shared by the tenant's synthetic subjects; per-customer account ownership is not modelled yet.

## Not included

Production identity, delivery to a broker, real provider connectivity, multi-region operation and any production acceptance.

## Module operations

`POST /v1/modules/:module/:operation` runs a journaled engine operation with a JSON body; the verified caller, server-side role assignments and server time are always supplied by the engine, never by the body. `GET /v1/modules` lists every operation. Write operations are journaled (see [durable persistence](PERSISTENCE.md)) and rebuilt on restart; read operations are not journaled.

| Module prefix | Unit | Who |
| --- | --- | --- |
| `consents.*`, `audit.*` | BNK-005, BNK-010 | customers (own consents); operators and bankers (audit) |
| `agents.*` | BNK-015 | operators and bankers manage; agents and operators run |
| `hardship.*` | BNK-016 | customers open and respond for held accounts; agents and bankers draft; bankers approve with fresh MFA |
| `overdraft.*` | BNK-017, BNK-018 | customers, for held accounts; `evaluate` reads the server-side balance |
| `stepup.*` | BNK-019 | customers request and approve; bankers approve second-approver actions; agents never approve |
| `disputes.*` | BNK-020 | customers file against server-fetched transactions on held accounts; bankers work and resolve |
| `founders.*`, `projects.*`, `claims.*` | BNK-021 to BNK-023 | founders; verifiers read claims |
| `tools.invoke` | BNK-024 | agents, inside a run they started for that project, where the founder's licence permits evaluation |
| `feasibility.*`, `market.*`, `economics.*`, `issues.*`, `sprints.*` | BNK-025 to BNK-029 | project members (sprint changes need a non-mentor member) |
| `verification.*` | BNK-030 | verifiers enroll and decide; the project owner requests system assignment |
| `funding.*`, `fairness.*` | BNK-031, BNK-032 | founders match and refer (verified claims counted server-side); operators and bankers see allocation and costs |
| `onboarding.*` | BNK-033 | customers start with their own consent (mock adapter; only PII-free outcomes are journaled); bankers review |
| `reconcile.run`, `deposits.availability` | BNK-034 | operators reconcile against server-side entries; customers see hold schedules |
| `payments.*` | BNK-035 | customers create from held accounts and authorize with their own step-up; operators submit, settle, fail and return on the sandbox rail | `POST /v1/audit` and `GET /v1/audit` use the same journaled audit chain. Unknown operations return 404.
