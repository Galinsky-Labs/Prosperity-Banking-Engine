-- Account ownership and the durable command journal for engine modules (BNK-014 onward, audit chain, consents).

CREATE TABLE ledger_account_holders (
  tenant_id      text    NOT NULL,
  account_id     text    NOT NULL,
  holder_issuer  text    NOT NULL,
  holder_subject text    NOT NULL,
  relationship   text    NOT NULL CHECK (relationship IN ('owner','joint')),
  synthetic_only boolean NOT NULL DEFAULT true CHECK (synthetic_only),
  PRIMARY KEY (tenant_id, account_id, holder_issuer, holder_subject),
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_accounts (tenant_id, account_id)
);
CREATE INDEX ledger_account_holders_subject ON ledger_account_holders (tenant_id, holder_issuer, holder_subject);

-- Single global sequence: a writer appends seq = last + 1. A primary-key conflict means another writer
-- advanced the journal, and the process fails stop so it can rebuild from the journal.
CREATE TABLE module_journal (
  seq            bigint      PRIMARY KEY CHECK (seq >= 1),
  tenant_id      text        NOT NULL,
  op             text        NOT NULL,
  actor          jsonb       NOT NULL,
  body           jsonb       NOT NULL,
  at             bigint      NOT NULL CHECK (at >= 0),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  synthetic_only boolean     NOT NULL DEFAULT true CHECK (synthetic_only)
);
CREATE TRIGGER module_journal_append_only BEFORE UPDATE OR DELETE ON module_journal FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
CREATE TRIGGER ledger_account_holders_append_only BEFORE UPDATE OR DELETE ON ledger_account_holders FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
