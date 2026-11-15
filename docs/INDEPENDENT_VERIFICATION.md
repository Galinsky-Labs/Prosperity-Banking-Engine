# Independent evidence verification

BNK-030 completes the BNK-023 claims ledger with independent review.

- Human verifiers enroll with declared conflicts (project IDs and founder IDs). Identities authenticated with workload, agent, service or client-credential methods cannot enroll or decide.
- Assignment is by system policy, never chosen by the requester: the least-loaded eligible verifier in the tenant who is not the claim author, not a project member and not conflicted with the project or founder. With no eligible verifier, verification is refused rather than weakened.
- Only the assigned verifier can decide, once. The verifier records the digest observed for each evidence item. Any mismatch forces `rejected` (`EVIDENCE_DIGEST_MISMATCH`); a `verified` verdict with unreviewed evidence becomes `inconclusive` (`EVIDENCE_NOT_REVIEWED`).
- The decision mints an attestation bound to the exact claim entry hash and appends it to the hash-chained claims ledger, which also rejects self-attestation.

Not included: retrieval of evidence from the vault store, verifier qualification, sampling audits of verifiers and production acceptance.
