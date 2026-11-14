/** Rebuild only the intent relation; all historical values are copied unchanged.
 * Runner must disable FK enforcement before BEGIN and verify FKs before COMMIT.
 */
export const migration002 = {
  version: 2,
  sql: `
CREATE TABLE corrections (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  intent_key TEXT NOT NULL,
  original_expense_id TEXT NOT NULL,
  original_kind TEXT NOT NULL DEFAULT 'expense' CHECK(original_kind='expense'),
  replacement_expense_id TEXT,
  replacement_kind TEXT CHECK(replacement_kind='expense'),
  replacement_json TEXT,
  replacement_fingerprint TEXT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
  actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 128),
  PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,original_expense_id),
  UNIQUE(instance_ref,subject_ref,replacement_expense_id),
  UNIQUE(instance_ref,subject_ref,id,intent_key),
  UNIQUE(instance_ref,subject_ref,id,intent_key,replacement_expense_id),
  CHECK(replacement_expense_id IS NULL OR replacement_expense_id<>original_expense_id),
  CHECK((replacement_expense_id IS NULL AND replacement_kind IS NULL AND replacement_json IS NULL AND replacement_fingerprint IS NULL)
    OR (replacement_expense_id IS NOT NULL AND replacement_kind IS NOT NULL AND replacement_kind='expense'
      AND replacement_json IS NOT NULL AND json_valid(replacement_json)
      AND length(CAST(replacement_json AS BLOB))<=32768 AND replacement_fingerprint IS NOT NULL
      AND length(replacement_fingerprint)=64 AND replacement_fingerprint NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(instance_ref,subject_ref,original_expense_id,original_kind) REFERENCES facts(instance_ref,subject_ref,id,kind),
  FOREIGN KEY(instance_ref,subject_ref,replacement_expense_id,replacement_kind) REFERENCES facts(instance_ref,subject_ref,id,kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,replacement_expense_id,intent_key) REFERENCES facts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES intents(instance_ref,subject_ref,intent_key,correction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE intents_new (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  fact_id TEXT,
  correction_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  PRIMARY KEY(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,fact_id),
  UNIQUE(instance_ref,subject_ref,intent_key,correction_id),
  CHECK(fact_id IS NOT NULL OR correction_id IS NOT NULL),
  FOREIGN KEY(instance_ref,subject_ref,fact_id,intent_key) REFERENCES facts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key) REFERENCES corrections(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key,fact_id) REFERENCES corrections(instance_ref,subject_ref,id,intent_key,replacement_expense_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO intents_new(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json)
  SELECT instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json FROM intents;
DROP TABLE intents;
ALTER TABLE intents_new RENAME TO intents;
CREATE TRIGGER intents_no_update BEFORE UPDATE ON intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER intents_no_delete BEFORE DELETE ON intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER correction_intent_match BEFORE INSERT ON intents
WHEN NEW.correction_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM corrections c WHERE c.instance_ref=NEW.instance_ref AND c.subject_ref=NEW.subject_ref
    AND c.intent_key=NEW.intent_key AND c.id=NEW.correction_id AND c.replacement_expense_id IS NEW.fact_id
) BEGIN SELECT RAISE(ABORT,'correction_mismatch'); END;
CREATE TRIGGER facts_intent_match BEFORE INSERT ON facts
WHEN EXISTS (
  SELECT 1 FROM intents i WHERE i.instance_ref=NEW.instance_ref AND i.subject_ref=NEW.subject_ref
    AND i.intent_key=NEW.intent_key AND i.fact_id IS NOT NEW.id
) BEGIN SELECT RAISE(ABORT,'fact_intent_mismatch'); END;
CREATE TRIGGER intents_fact_match BEFORE INSERT ON intents
WHEN EXISTS (
  SELECT 1 FROM facts f WHERE f.instance_ref=NEW.instance_ref AND f.subject_ref=NEW.subject_ref
    AND f.intent_key=NEW.intent_key AND f.id IS NOT NEW.fact_id
) BEGIN SELECT RAISE(ABORT,'fact_intent_mismatch'); END;
CREATE TRIGGER corrections_no_update BEFORE UPDATE ON corrections BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER corrections_no_delete BEFORE DELETE ON corrections BEGIN SELECT RAISE(ABORT,'append_only'); END;
`,
} as const;
