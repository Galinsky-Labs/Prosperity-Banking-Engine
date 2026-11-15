# Entrepreneur studio foundation

## BNK-021 founder onboarding and IP rights

`FounderRegistry` onboards a verified founder only on an affirmative acceptance of the exact studio terms (version and SHA-256 digest). The founder is always the IP owner. The licence posture is explicit and founder-controlled: `founder-owned-no-license` (default), `founder-owned-evaluation-license` or `founder-owned-collaboration-license`. `studioUsePermitted` never allows commercialization, model training or publishing of a founder's work under any posture. Pre-existing IP is declared by asset kind and content digest only; raw works are not accepted. Changes are versioned and recorded in a frozen history. Staff can see only a founder's posture summary.

## BNK-022 project workspace and milestones

`ProjectWorkspace` isolates projects by tenant and explicit membership (`owner`, `collaborator`, `mentor` with read-only access). Non-members get `PROJECT_NOT_FOUND`, so project existence is not disclosed. Milestones follow `PLANNED -> IN_PROGRESS -> SUBMITTED` (with `CANCELLED` and rework back to `IN_PROGRESS`); submission requires evidence references, and `VERIFIED` is reserved for independent verification (BNK-030). Every change is version-checked and bounded.

Not included: persistence, document storage (only references and digests), legal review of studio terms and production acceptance.
