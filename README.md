# Prosperity Banking Engine

Bank-neutral, AI-native infrastructure for customer-first banking and entrepreneur development.

The engine is designed for financial institutions to configure and white-label independently. Its initial implementation is a non-production, synthetic-data foundation: **no live customer funds, accounts, or financial transactions**.

Development takes place in reviewed pull requests. Do not develop any downstream bank-branded application until every engine roadmap unit is completed, verified, and accepted.

See the foundation pull request for architecture, security controls, module contracts, tests, and the canonical `registry/prs.json` implementation roadmap.

The [threat model and data classification](docs/THREAT_MODEL.md) defines protected assets, trust boundaries, fail-closed handling rules, and the controls that later roadmap units must implement before production use.

The [synthetic engine HTTP API](docs/HTTP_API.md) exposes merged units over Node.js `node:http` for non-production demonstration only. It refuses to start unless `DATA_MODE=synthetic`.
