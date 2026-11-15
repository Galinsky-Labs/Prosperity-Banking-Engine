# Deposits, reconciliation and payments lifecycle

## BNK-034 deposits and reconciliation

`reconcile` compares engine-ledger entries with a bank-of-record statement. It matches by reference first, then by exact amount within a date tolerance (flagged `needsConfirmation`), reports amount mismatches, unmatched items on both sides and statement balance continuity, and returns `breaks-require-review` for any break. The bank core is authoritative and nothing is auto-corrected.

`depositAvailability` builds a funds-availability schedule from a tenant hold policy: immediate for cash and electronic deposits; for checks, a next-day portion, then a standard or new-account hold, and a longer hold for the portion above a large-deposit threshold. The schedule always covers the full deposit and flags when a hold notice is needed. Hold amounts and periods are tenant configuration, not a claim of compliance with any specific regulation.

## BNK-035 payments lifecycle and returns

`SandboxPaymentLifecycle` runs payments on a simulated `sandbox-*` rail only; live rails are refused and `realFundsMoved` is always false. Payments are created idempotently within a sandbox amount limit, then follow `CREATED -> AUTHORIZED -> SUBMITTED -> SETTLED | FAILED`, with cancellation before submission and `SETTLED -> RETURNED`. Authorization consumes a BNK-019 step-up approval for the payment's exact terms and initiator, so tampered terms, missing approvals and reused approvals fail. Returns are accepted only after settlement, within the return window and with a known return code; they produce a reversal instruction (`requiresAdapterExecution`) and flag unauthorized-return claims.
