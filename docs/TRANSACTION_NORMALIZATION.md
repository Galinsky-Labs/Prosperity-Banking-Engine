# Transaction normalization

BNK-012 converts authorized synthetic adapter entries into a bounded, deterministic transaction view. It preserves the source account, currency, integer minor-unit amount, direction, booking time and controlled description code; debit amounts are negative and credit amounts are positive. Results are ordered by booking time and source identifier.

The current fake adapter produces only posted entries, so the normalizer reports only `posted`. It does not infer pending, authorized, returned, reversed or disputed states without corresponding authoritative adapter evidence. Every read requires a live verifier-produced tenant identity, exact transaction policy authorization and the adapter's independent account-read authorization.

This unit is synthetic and memory-only. It does not provide provider-specific mappings, durable cursors, reconciliation, enrichment, merchant identity, category inference, pending/posted matching, dispute handling or production deployment.
