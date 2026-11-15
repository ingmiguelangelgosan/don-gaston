/** Preserve v5 records and add append-only corrections plus a durable action order. */
export const migration006 = {
  version: 6,
  sql: `
CREATE UNIQUE INDEX debt_payment_scope_identity ON debt_payment_results(instance_ref,subject_ref,id,debt_id);
CREATE TABLE debt_payment_corrections (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  debt_id TEXT NOT NULL,
  original_payment_id TEXT NOT NULL,
  proposed_json TEXT CHECK(proposed_json IS NULL OR (json_valid(proposed_json) AND length(CAST(proposed_json AS BLOB))<=32768)),
  replacement_payment_id TEXT,
  replacement_json TEXT,
  replacement_fingerprint TEXT,
  status TEXT NOT NULL CHECK(status IN ('applied','review_required')),
  review_reason TEXT,
  estimated_balance_after TEXT NOT NULL CHECK(length(estimated_balance_after) BETWEEN 1 AND 4096 AND estimated_balance_after NOT GLOB '*[^0-9]*' AND (estimated_balance_after='0' OR substr(estimated_balance_after,1,1) BETWEEN '1' AND '9')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  actor_ref TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
  PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,id,intent_key),
  UNIQUE(instance_ref,subject_ref,id,intent_key,replacement_payment_id),
  UNIQUE(instance_ref,subject_ref,id,debt_id),
  UNIQUE(instance_ref,subject_ref,replacement_payment_id),
  CHECK(replacement_payment_id IS NULL OR replacement_payment_id<>original_payment_id),
  CHECK((status='applied' AND review_reason IS NULL AND ((proposed_json IS NULL AND replacement_payment_id IS NULL) OR (proposed_json IS NOT NULL AND replacement_payment_id IS NOT NULL)))
    OR (status='review_required' AND proposed_json IS NOT NULL AND replacement_payment_id IS NULL AND review_reason IS NOT NULL AND review_reason IN ('EXCEEDS_ESTIMATED_BALANCE','EXCEEDS_INSTALLMENT_REMAINDER'))),
  CHECK((replacement_payment_id IS NULL AND replacement_json IS NULL AND replacement_fingerprint IS NULL)
    OR (replacement_payment_id IS NOT NULL AND replacement_json IS NOT NULL AND json_valid(replacement_json) AND length(CAST(replacement_json AS BLOB))<=32768
      AND replacement_fingerprint IS NOT NULL AND length(replacement_fingerprint)=64 AND replacement_fingerprint NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(instance_ref,subject_ref,original_payment_id,debt_id) REFERENCES debt_payment_results(instance_ref,subject_ref,id,debt_id),
  FOREIGN KEY(instance_ref,subject_ref,replacement_payment_id,debt_id) REFERENCES debt_payment_results(instance_ref,subject_ref,id,debt_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,replacement_payment_id,intent_key) REFERENCES debt_payment_results(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES debt_intents(instance_ref,subject_ref,intent_key,correction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX debt_correction_single_applied ON debt_payment_corrections(instance_ref,subject_ref,original_payment_id) WHERE status='applied';
CREATE TABLE debt_intents_new (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  debt_id TEXT,
  payment_id TEXT,
  correction_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  PRIMARY KEY(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,intent_key,debt_id),
  UNIQUE(instance_ref,subject_ref,intent_key,payment_id),
  UNIQUE(instance_ref,subject_ref,intent_key,correction_id),
  CHECK((correction_id IS NULL AND ((debt_id IS NOT NULL AND payment_id IS NULL) OR (payment_id IS NOT NULL AND debt_id IS NULL))) OR (correction_id IS NOT NULL AND debt_id IS NULL)),
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key) REFERENCES debt_payment_corrections(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key,payment_id) REFERENCES debt_payment_corrections(instance_ref,subject_ref,id,intent_key,replacement_payment_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,debt_id,intent_key) REFERENCES financed_debts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,payment_id,intent_key) REFERENCES debt_payment_results(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO debt_intents_new(instance_ref,subject_ref,intent_key,debt_id,payment_id,fingerprint,result_json)
  SELECT instance_ref,subject_ref,intent_key,debt_id,payment_id,fingerprint,result_json FROM debt_intents;
DROP TRIGGER intents_debt_key;
DROP TABLE debt_intents;
ALTER TABLE debt_intents_new RENAME TO debt_intents;
CREATE TRIGGER intents_debt_key BEFORE INSERT ON intents WHEN EXISTS (
  SELECT 1 FROM debt_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
CREATE TRIGGER debt_intents_existing_key BEFORE INSERT ON debt_intents WHEN EXISTS (
  SELECT 1 FROM intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
CREATE TRIGGER debt_intents_no_update BEFORE UPDATE ON debt_intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_intents_no_delete BEFORE DELETE ON debt_intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_intents_correction_match BEFORE INSERT ON debt_intents
WHEN NEW.correction_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM debt_payment_corrections c WHERE c.instance_ref=NEW.instance_ref AND c.subject_ref=NEW.subject_ref
  AND c.id=NEW.correction_id AND c.intent_key=NEW.intent_key AND c.replacement_payment_id IS NEW.payment_id
) BEGIN SELECT RAISE(ABORT,'correction_mismatch'); END;
CREATE TRIGGER debt_payment_corrections_no_update BEFORE UPDATE ON debt_payment_corrections BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_payment_corrections_no_delete BEFORE DELETE ON debt_payment_corrections BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE debt_payment_actions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  debt_id TEXT NOT NULL,
  payment_id TEXT,
  correction_id TEXT,
  CHECK((payment_id IS NOT NULL AND correction_id IS NULL) OR (correction_id IS NOT NULL AND payment_id IS NULL)),
  UNIQUE(instance_ref,subject_ref,payment_id),
  UNIQUE(instance_ref,subject_ref,correction_id),
  FOREIGN KEY(instance_ref,subject_ref,payment_id,debt_id) REFERENCES debt_payment_results(instance_ref,subject_ref,id,debt_id),
  FOREIGN KEY(instance_ref,subject_ref,correction_id,debt_id) REFERENCES debt_payment_corrections(instance_ref,subject_ref,id,debt_id)
) STRICT;
CREATE INDEX debt_payment_actions_by_debt ON debt_payment_actions(instance_ref,subject_ref,debt_id,sequence);
INSERT INTO debt_payment_actions(instance_ref,subject_ref,debt_id,payment_id)
  SELECT instance_ref,subject_ref,debt_id,id FROM debt_payment_results ORDER BY sequence;
CREATE TRIGGER debt_payment_action_insert AFTER INSERT ON debt_payment_results
WHEN NOT EXISTS(SELECT 1 FROM debt_payment_corrections c WHERE c.instance_ref=NEW.instance_ref AND c.subject_ref=NEW.subject_ref AND c.replacement_payment_id=NEW.id)
BEGIN INSERT INTO debt_payment_actions(instance_ref,subject_ref,debt_id,payment_id) VALUES(NEW.instance_ref,NEW.subject_ref,NEW.debt_id,NEW.id); END;
CREATE TRIGGER debt_correction_action_insert AFTER INSERT ON debt_payment_corrections
BEGIN INSERT INTO debt_payment_actions(instance_ref,subject_ref,debt_id,correction_id) VALUES(NEW.instance_ref,NEW.subject_ref,NEW.debt_id,NEW.id); END;
CREATE TRIGGER debt_payment_actions_no_update BEFORE UPDATE ON debt_payment_actions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER debt_payment_actions_no_delete BEFORE DELETE ON debt_payment_actions BEGIN SELECT RAISE(ABORT,'append_only'); END;
`,
} as const;
