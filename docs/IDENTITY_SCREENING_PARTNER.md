# Identity and screening partner integration (sandbox only)

BNK-033 defines the adapter contract for identity verification and sanctions/PEP screening and an onboarding orchestration over it. **Only the deterministic mock adapter exists.** `createIdentityScreeningAdapter({mode: 'live'})` throws `PARTNER_APPROVAL_REQUIRED`: live onboarding remains blocked by the unit's external prerequisite, approval of a regulated partner, which has not been obtained.

- The mock never contacts a provider. Synthetic document numbers start with `SYN-`; names containing `REVIEW` return an inconclusive liveness check; a small synthetic watchlist yields exact and partial matches.
- `SyntheticOnboarding.start` requires the applicant's own active `identity:verify` consent, validates bounded fields, runs verification and screening, and stores only provider references, decision and reason codes; raw identity data is not kept in the result.
- Potential sanctions matches and inconclusive identity checks always go to `manual-review`; the engine never auto-declines on a fuzzy match. Failed checks decline with adverse-action reason codes. No live account is opened (`liveAccountOpened: false`).
- Manual review needs the exact policy action and a human analyst.
- `createCallbackVerifier` checks partner callbacks with HMAC-SHA256 over `timestamp.body`, a freshness window and one-time event IDs.

Owner and partner actions required before any live use: select and contract a regulated identity/screening partner, complete its due diligence and approval, obtain legal and compliance sign-off on onboarding policy, and add a reviewed live adapter in a separate unit.
