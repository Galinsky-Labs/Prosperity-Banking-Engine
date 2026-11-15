# Overdraft conformance and credit explanations

## BNK-036 overdraft network certification (evidence only)

`runOverdraftConformance` runs a fixed engine suite against a tenant's compiled BNK-018 policy: no fee without opt-in on ATM and one-time debit rails, no fee on force-posted items without coverage, no fee or overdraft with sufficient funds, de minimis, daily cap, fee never above the overdraft, over-limit declines and negative balances. It reports per-case evidence and `engineSelfTest`. It always reports `networkCertification: 'not-obtained'` and `certifiedBy: null`; certification can only come from the relevant networks and sponsor partners.

## BNK-037 credit explanations

`explainCreditDecision` explains a decision made by a separate (here synthetic) scoring process; the engine makes no credit decision (`engineMadeDecision: false`). Factor contributions must reconcile exactly with the score; the decision must agree with the threshold; prohibited factors (protected characteristics and proxies) are refused; every factor needs plain-language text. Adverse outcomes list up to four principal reasons, points needed to reach the threshold and customer-actionable hints. The output is not a jurisdiction-reviewed adverse action notice.
