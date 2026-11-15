# Bound step-up approvals

BNK-019 binds every sensitive approval to the exact action it authorizes.

- Tenants configure action types, each with an explicit second-approver requirement and an optional amount ceiling. Unknown action types and amounts above the ceiling (or non-integer amounts) are refused at request time.
- A challenge carries a SHA-256 digest of the canonical JSON of tenant, initiator, action type, terms and contract version. Key order does not change the digest; any value change does.
- Approval requires the exact `approve` policy action with fresh multi-factor authentication, the exact digest and an unexpired pending challenge. Identities authenticated with workload, agent, service or client-credential methods can never approve.
- Self-approval is allowed only for action types without a second-approver requirement and never for challenges an agent initiated.
- The executing service calls `consume` with the terms it is about to act on; the digest is recomputed, and the approval is single-use and expires with the challenge.
- Request IDs replay only exact terms. All records are frozen and tenant-keyed.

Not included: the executing payment service (BNK-035), out-of-band approval channels, persistence and production acceptance.
