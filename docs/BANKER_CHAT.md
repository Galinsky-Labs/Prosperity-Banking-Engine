# Grounded banker chat

BNK-014 answers customer questions only from engine-computed facts: BNK-011 balances and freshness, BNK-012 normalized transactions and the BNK-013 forecast. `buildGroundingFacts` turns those results into immutable facts, each with an id and an exact display amount (`USD 1234.56`).

## Provider interface

A provider is `{id, kind: 'simulated' | 'model', label, respond({question, facts}) -> {text, citations} | {refused: true} | null}`.

- `createSimulatedResponder()` is the default. It is deterministic, offline and labelled "Simulated deterministic responder (no AI model)". The API uses it whenever `ANTHROPIC_API_KEY` is unset, and `/health` reports `chat.kind`.
- `createAnthropicChatProvider()` uses the official Anthropic SDK (`claude-opus-5-5` by default, overridable with `ENGINE_CHAT_MODEL`), low effort, server-side refusal fallbacks, and a minimized fact payload (ids, kinds, display amounts; no raw timestamps or minor units). It is enabled only when `ANTHROPIC_API_KEY` is set.

## Controls

- Exact `chat.ask` policy decision for a live verified identity; bounded question and fact lists.
- Deterministic pre-checks hand off, without calling any provider, when the question asks to move money, change accounts, credit, fees or overdraft settings, or probes the instructions.
- A model provider is allowed only for data categories that BNK-002 marks model-eligible. In synthetic mode facts are `synthetic_test_data`; `customer_financial_data` is denied before any provider call.
- Every reply is validated: citations must be known fact ids, and every money amount in the text must equal a cited fact's display string. Ungrounded, malformed, refused or failed replies become a human-banker handoff marked `grounded: false` where applicable.
- Replies carry `notFinancialAdvice: true`, the responder label and `syntheticOnly: true`.

## Not included

Conversation memory, streaming, multilingual support, real customer data, formal safety evaluation (BNK-042) and any action-taking capability. AI output never authorizes a payment, ledger change, credit decision or fee.
