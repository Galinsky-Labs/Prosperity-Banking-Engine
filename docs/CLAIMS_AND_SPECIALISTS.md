# Claims ledger and specialist agents

## BNK-023 claims and evidence ledger

`ClaimsLedger` keeps an append-only, SHA-256 hash-chained sequence per tenant and project with three entry kinds: `CLAIM`, `RETRACTION` and `ATTESTATION`.

- Claims have a supported type, a structured metric with a nonnegative integer value and one or more evidence references (vault ID plus content digest; never the evidence itself). Requests replay only exact terms; claim IDs are unique per project.
- AI-drafted claims enter only after a human author adopts them (`humanAdopted: true`), and stay marked `aiDrafted`.
- Every claim starts `UNVERIFIED`. Only the claim author can retract. State changes to `VERIFIED`, `REJECTED` or `INCONCLUSIVE` only through attestations minted by independent verification (BNK-030), bound to the exact claim entry hash and never from the claim author. Forged objects are refused.
- `verifyChain` recomputes the chain to detect tampering.

`src/studio/attestations.mjs` is internal and is not exported from the package index.

## BNK-024 specialist agents and tools

`SpecialistToolRouter` registers pure tool functions with a declared input data category and size bound, and specialist profiles (market research, pricing, technical feasibility, IP spotting, sprint planning, funding readiness) that list allowed tools.

- Tool names in money movement, ledger, banking, credit, fee, overdraft, approval, investment and dispute namespaces are refused.
- An invocation needs an active BNK-015 scheduler run for that specialist whose capabilities include `tool:<name>`, a tool in the specialist's profile, project access from the injected workspace check, and a model-eligible data category (BNK-002).
- Results are labelled `aiDraft` and `requiresHumanAdoption`; a tenant-scoped call log records every invocation.

Not included: persistence, tool sandboxing beyond pure functions, evidence fetching and production acceptance.
