# Disputes and human handoff

BNK-020 lets customers dispute their own posted debits and routes every dispute and escalation to a human queue.

- Filing requires the exact `file` policy action, a tenant reason code and BNK-012 normalized posted debit evidence inside the filing window. Requests replay only exact terms, and a transaction can have only one unresolved dispute.
- Each dispute carries acknowledgement, provisional-decision and resolution deadlines from the tenant contract and opens a `dispute` handoff ticket.
- `handoff` accepts escalations from chat (BNK-014), agents, hardship, fraud suspicion and complaints, with standard or urgent priority. The queue lists urgent and earliest-due tickets first and flags overdue items.
- Claiming tickets, deciding provisional credit and resolving disputes require a human: identities authenticated with workload, agent, service or client-credential methods are refused. Agents may add notes, which are marked as drafts. The filer cannot resolve their own dispute.
- Provisional credit and resolution are decision records with `requiresAdapterExecution: true`; a merchant-favor outcome after granted provisional credit flags its reversal. Late acknowledgements and decisions are recorded.
- Customers can view only their own disputes; staff see their tenant's queue only.

Not included: card-network chargeback messaging, Regulation E or other jurisdiction-specific timelines (tenants configure deadlines), customer notices, persistence and accessibility review (BNK-044).
