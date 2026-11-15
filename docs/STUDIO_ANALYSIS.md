# Studio analysis tools

## BNK-025 technical feasibility sandbox

`runFeasibilityExperiment` evaluates a short, engine-authored expression over synthetic inputs in a fresh V8 context with a null-prototype global, no `require`, `process`, timers, network or filesystem, string code generation disabled, a time limit and a bounded result. Forbidden identifiers (`require`, `process`, `globalThis`, `Function`, `eval`, `constructor`, `prototype` and others) are refused before execution. Only `synthetic_test_data` is accepted. Results record SHA-256 digests of the expression, inputs and result and state `securityBoundary: false`: `node:vm` is not a security boundary, so founder-supplied code must never be run here. `assessFeasibility` turns criteria into `feasible-in-sandbox`, `not-feasible` or `inconclusive`, with a caveat that sandbox results do not establish production feasibility.

## BNK-026 market validation

`summarizeMarketValidation` groups structured interview, survey and pilot responses by segment, ignores duplicate respondents, and reports positive rate and a Wilson 95% interval in basis points. Warnings flag small samples, mostly incentivized responses and single-source evidence. A segment shows a signal only with no warnings and an interval lower bound above the threshold. Output notes that stated intent is not purchase behaviour.

## BNK-027 pricing and unit economics

`computeUnitEconomics` uses integer minor units and basis points to compute payment fees, monthly contribution, gross margin, expected lifetime, churn-based LTV, LTV:CAC (x100) and CAC payback, with warnings for negative contribution, LTV:CAC below 3x, payback over 24 months and churn before payback. `unitEconomicsSensitivity` builds a bounded price-by-churn grid. Results are planning estimates (`notAdvice: true`), not credit, investment or pricing approvals.
