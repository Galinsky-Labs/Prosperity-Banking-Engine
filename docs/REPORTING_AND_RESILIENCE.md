# Synthetic regulatory reporting and failure injection

## BNK-040 regulatory reporting generators (synthetic)

`generateSyntheticReport` builds `deposit-balances`, `overdraft-fee-summary` and `disputes-and-complaints` artifacts from engine data. Totals must reconcile with rows; a canonical SHA-256 checksum makes regeneration verifiable (row order does not change it). Every report carries the watermark `SYNTHETIC - NOT FOR REGULATORY FILING`, `filingStatus: 'not-filed'` and no filing channel. `renderReportCsv` refuses unwatermarked input. These are not official report formats; real formats, schedules and filings belong to the institution's compliance function.

## BNK-041 failure injection and recovery

`createFaultInjectingStore` wraps any engine store and fails chosen operations on chosen calls, either before the call runs or after it commits (a lost acknowledgement). Injected faults surface as HTTP 503. The tests show three recovery properties:

- a fault before a ledger post leaves no partial entry, version change or outbox event, and the retry succeeds;
- a lost acknowledgement after commit is recovered by an exact idempotent retry with no duplicate effect;
- a failed journal append fails stop (all further requests 503) and a restart rebuilds module state that contains only durably journaled changes.

The start script never enables fault injection.
