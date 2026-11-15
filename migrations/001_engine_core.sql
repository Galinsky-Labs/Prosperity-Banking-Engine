-- Prosperity Banking Engine: durable synthetic ledger, transactional outbox and evidence metadata vault.
-- Synthetic data only. Every row carries synthetic_only = true and the constraint forbids anything else.

CREATE TABLE ledger_accounts (
  tenant_id      text    NOT NULL CHECK (tenant_id ~ '^tenant_[a-z0-9_-]+$'),
  account_id     text    NOT NULL,
  currency       text    NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor  bigint  NOT NULL CHECK (balance_minor >= 0),
  balance_as_of  bigint  CHECK (balance_as_of >= 0),
  version        bigint  NOT NULL DEFAULT 0 CHECK (version >= 0),
  synthetic_only boolean NOT NULL DEFAULT true CHECK (synthetic_only),
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE ledger_entries (
  seq              bigserial PRIMARY KEY,
  entry_key        text    NOT NULL UNIQUE,
  tenant_id        text    NOT NULL,
  account_id       text    NOT NULL,
  entry_id         text    NOT NULL,
  direction        text    NOT NULL CHECK (direction IN ('credit','debit')),
  amount_minor     bigint  NOT NULL CHECK (amount_minor > 0),
  currency         text    NOT NULL,
  description_code text    NOT NULL,
  posted_at        bigint  NOT NULL CHECK (posted_at >= 0),
  actor_issuer     text    NOT NULL,
  actor_subject    text    NOT NULL,
  synthetic_only   boolean NOT NULL DEFAULT true CHECK (synthetic_only),
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_accounts (tenant_id, account_id)
);
CREATE INDEX ledger_entries_account_seq ON ledger_entries (tenant_id, account_id, seq);

CREATE TABLE ledger_requests (
  request_key text        PRIMARY KEY,
  tenant_id   text        NOT NULL,
  digest      text        NOT NULL,
  result      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  seq              bigserial,
  event_key        text    PRIMARY KEY,
  tenant_id        text    NOT NULL,
  event_id         text    NOT NULL,
  envelope         jsonb   NOT NULL,
  state            text    NOT NULL CHECK (state IN ('PENDING','CLAIMED','PUBLISHED')),
  delivery_version integer NOT NULL DEFAULT 0 CHECK (delivery_version >= 0),
  lease_worker     text,
  lease_version    integer,
  lease_expires_at bigint,
  published_at     bigint,
  synthetic_only   boolean NOT NULL DEFAULT true CHECK (synthetic_only),
  CHECK ((state = 'CLAIMED') = (lease_worker IS NOT NULL AND lease_version IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'PUBLISHED') = (published_at IS NOT NULL))
);
CREATE INDEX outbox_events_claimable ON outbox_events (tenant_id, state, seq);

CREATE TABLE outbox_requests (
  request_key text PRIMARY KEY,
  tenant_id   text NOT NULL,
  digest      text NOT NULL,
  event_key   text NOT NULL REFERENCES outbox_events (event_key)
);

CREATE TABLE evidence_records (
  seq            bigserial,
  record_key     text    PRIMARY KEY,
  tenant_id      text    NOT NULL,
  evidence_id    text    NOT NULL,
  record         jsonb   NOT NULL,
  synthetic_only boolean NOT NULL DEFAULT true CHECK (synthetic_only)
);
CREATE INDEX evidence_records_tenant_seq ON evidence_records (tenant_id, seq);

CREATE TABLE evidence_requests (
  request_key text PRIMARY KEY,
  tenant_id   text NOT NULL,
  digest      text NOT NULL,
  record_key  text NOT NULL REFERENCES evidence_records (record_key)
);

-- Posted entries, idempotency records and evidence metadata are append-only.
CREATE FUNCTION engine_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % cannot be %', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
CREATE TRIGGER ledger_requests_append_only BEFORE UPDATE OR DELETE ON ledger_requests FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
CREATE TRIGGER outbox_requests_append_only BEFORE UPDATE OR DELETE ON outbox_requests FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
CREATE TRIGGER evidence_records_append_only BEFORE UPDATE OR DELETE ON evidence_records FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
CREATE TRIGGER evidence_requests_append_only BEFORE UPDATE OR DELETE ON evidence_requests FOR EACH ROW EXECUTE FUNCTION engine_reject_mutation();
