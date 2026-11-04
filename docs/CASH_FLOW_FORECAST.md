# Cash-flow forecasting

BNK-013 produces a bounded, deterministic cash-flow projection for one authorized synthetic account and currency. It derives a truncated integer daily baseline from posted transactions inside an explicit lookback window, then adds only caller-supplied future items whose currency, amount, identifier and expected time pass strict validation. Daily buckets show the historical baseline, scheduled adjustment, projected net change and cumulative net change.

The service independently requires a live verifier-produced tenant identity, exact forecast authorization and the transaction normalizer's exact read authorization. It rejects duplicate schedules, out-of-horizon dates, mixed currencies, unsafe arithmetic and unbounded inputs. Results state the method and preserve uncertainty warnings.

This is a mechanical synthetic projection, not a promised balance, credit decision, financial advice or autonomous banking action. It excludes pending transactions, recurrence inference, merchant categorization, external events, durable schedules, provider connectivity, statistical confidence, model output and production deployment.
