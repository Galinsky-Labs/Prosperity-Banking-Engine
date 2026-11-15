# Overdraft opt-in and rail-specific policy

## BNK-017 opt-in interface

`OverdraftEnrollment` keeps fee-bearing overdraft coverage **off by default** for each account holder and account.

- Opt-in is granular per rail (`atm`, `one-time-debit`, `recurring-debit`, `ach`, `check`).
- It requires the exact policy `change` action with fresh multi-factor authentication, `affirmative: true` (pre-checked or implied consent is rejected), the exact current disclosure version and SHA-256 digest, and an active BNK-005 consent from the same verified subject for the `overdraft:fees` scope.
- Requests are idempotent with exact-term replay; changes are version-checked and recorded in a frozen history.
- Revocation of one rail or all rails is immediate and never needs a reason. Revoking the underlying consent also ends fee-bearing coverage, because `feeBearingCoverage` re-checks the consent ledger on every decision.

## BNK-018 rail-specific policy

`createOverdraftPolicy` compiles each tenant's rule per rail: `decline`, `cover-no-fee` or `cover-with-opt-in`, plus a fee, de minimis threshold, daily fee cap and overdraft limit. `evaluateOverdraft` is a pure decision function that returns a frozen record with reasons and `executesNothing: true`.

- A fee is possible only on a `cover-with-opt-in` rail, for an opted-in customer with active consent, above the de minimis threshold and under the daily cap, and never above the overdraft amount itself.
- ATM and one-time debit items without opt-in are declined (`OPT_IN_REQUIRED`), never covered for a fee.
- Force-posted items are approved but carry no fee unless fee-bearing coverage existed for that rail at decision time.
- Items over the overdraft limit are declined.

Neither unit posts entries or assesses fees. Network certification (BNK-036), persistence, notices and jurisdiction-specific legal review remain later work.
