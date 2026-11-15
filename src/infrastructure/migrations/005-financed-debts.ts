/** Debt openings and payment decisions are independent of consumption facts.
 * Reciprocal scoped FKs bind immutable records to their original intention. */
export const migration005 = {
  version: 5,
  sql: `
CREATE TABLE financed_debts (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500),
  financed_minor TEXT NOT NULL CHECK(length(financed_minor) BETWEEN 1 AND 4096 AND financed_minor NOT GLOB '*[^0-9]*' AND substr(financed_minor,1,1) BETWEEN '1' AND '9'),
  installment_count INTEGER NOT NULL CHECK(installment_count BETWEEN 1 AND 1200),
  installment_minor TEXT NOT NULL CHECK(length(installment_minor) BETWEEN 1 AND 4096 AND installment_minor NOT GLOB '*[^0-9]*' AND substr(installment_minor,1,1) BETWEEN '1' AND '9'),
  reference_on TEXT NOT NULL CHECK(length(reference_on)=10),
  reference_balance_minor TEXT NOT NULL CHECK(length(reference_balance_minor) BETWEEN 1 AND 4096 AND reference_balance_minor NOT GLOB '*[^0-9]*' AND (reference_balance_minor='0' OR substr(reference_balance_minor,1,1) BETWEEN '1' AND '9')),
  historical_paid_installments INTEGER NOT NULL CHECK(historical_paid_installments BETWEEN 0 AND installment_count),
  historical_paid_minor TEXT CHECK(historical_paid_minor IS NULL OR (length(historical_paid_minor) BETWEEN 1 AND 4096 AND historical_paid_minor NOT GLOB '*[^0-9]*' AND (historical_paid_minor='0' OR substr(historical_paid_minor,1,1) BETWEEN '1' AND '9'))),
  annual_effective_rate TEXT,
  terms TEXT,
  currency TEXT NOT NULL CHECK(currency='COP'),
  actor_ref TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
  PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,id,intent_key),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES debt_intents(instance_ref,subject_ref,intent_key,debt_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE debt_payment_results (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  debt_id TEXT NOT NULL,
  installment_number INTEGER NOT NULL CHECK(installment_number BETWEEN 1 AND 1200),
  amount_minor TEXT NOT NULL CHECK(length(amount_minor) BETWEEN 1 AND 4096 AND amount_minor NOT GLOB '*[^0-9]*' AND substr(amount_minor,1,1) BETWEEN '1' AND '9'),
  currency TEXT NOT NULL CHECK(currency='COP'),
  paid_on TEXT NOT NULL CHECK(length(paid_on)=10),
  reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 128),
  actor_ref TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
  status TEXT NOT NULL CHECK(status IN ('confirmed','review_required')),
  review_reason TEXT,
  estimated_balance_after TEXT NOT NULL CHECK(length(estimated_balance_after) BETWEEN 1 AND 4096 AND estimated_balance_after NOT GLOB '*[^0-9]*' AND (estimated_balance_after='0' OR substr(estimated_balance_after,1,1) BETWEEN '1' AND '9')),
  CHECK((status='confirmed' AND review_reason IS NULL) OR
    (status='review_required' AND review_reason IS NOT NULL AND review_reason IN ('EXCEEDS_ESTIMATED_BALANCE','EXCEEDS_INSTALLMENT_REMAINDER'))),
  UNIQUE(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,id,intent_key),
  FOREIGN KEY(instance_ref,subject_ref,debt_id) REFERENCES financed_debts(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES debt_intents(instance_ref,subject_ref,intent_key,payment_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX debt_payments_by_debt ON debt_payment_results(instance_ref,subject_ref,debt_id,sequence);
CREATE INDEX debt_payments_by_date ON debt_payment_results(instance_ref,subject_ref,paid_on);
CREATE TABLE debt_intents (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  debt_id TEXT,
  payment_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  PRIMARY KEY(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,intent_key,debt_id),
  UNIQUE(instance_ref,subject_ref,intent_key,payment_id),
  CHECK((debt_id IS NOT NULL AND payment_id IS NULL) OR (payment_id IS NOT NULL AND debt_id IS NULL)),
  FOREIGN KEY(instance_ref,subject_ref,debt_id,intent_key) REFERENCES financed_debts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,payment_id,intent_key) REFERENCES debt_payment_results(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER intents_debt_key BEFORE INSERT ON intents WHEN EXISTS (
  SELECT 1 FROM debt_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
CREATE TRIGGER debt_intents_existing_key BEFORE INSERT ON debt_intents WHEN EXISTS (
  SELECT 1 FROM intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
CREATE TRIGGER financed_debts_no_update BEFORE UPDATE ON financed_debts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER financed_debts_no_delete BEFORE DELETE ON financed_debts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_payments_no_update BEFORE UPDATE ON debt_payment_results BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_payments_no_delete BEFORE DELETE ON debt_payment_results BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_intents_no_update BEFORE UPDATE ON debt_intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_intents_no_delete BEFORE DELETE ON debt_intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
`,
} as const;
