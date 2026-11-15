# Fraud and AML handoff interfaces, and vendor controls

## BNK-038 fraud and AML handoffs (mock)

`monitorTransactions` applies deterministic rules (possible structuring just below a reporting threshold, threshold credits, debit velocity, large debits) to normalized transactions. `FinancialCrimeCaseQueue` turns alerts into cases that only human analysts can clear or escalate. `draftReport` creates a mock report draft for escalated cases with `filed: false`, `filingChannel: 'none-sandbox'` and a "not a regulatory filing" watermark; the engine has no path to file anything. `customerStatus` is identical for every case and never mentions monitoring, so customers are not tipped off. Thresholds are tenant configuration, not claims about any jurisdiction's rules.

## BNK-039 affiliate and vendor controls

`VendorRegistry` records each vendor's services, data scopes, risk tier, affiliation and contract end. Restricted data scopes need the high tier. Approval requires every due-diligence item for the tier (evidence by digest), a human approver who is not the submitter, a current contract and, for affiliates, a customer-facing disclosure. `authorizeAccess` fails closed for unapproved vendors, expired contracts, overdue periodic reviews and out-of-scope data categories.
