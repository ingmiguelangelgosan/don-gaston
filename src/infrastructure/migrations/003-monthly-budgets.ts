/** Append-only budget revisions and internal alert events. Existing intent bytes
 * are copied unchanged; the runner verifies each version inside the transaction. */
export const migration003 = {
  version: 3,
  sql: `
CREATE TABLE budgets (
  sequence INTEGER PRIMARY KEY,
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  intent_key TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_kind TEXT NOT NULL DEFAULT 'category' CHECK(category_kind='category'),
  month TEXT NOT NULL CHECK(length(month)=7),
  amount_minor TEXT NOT NULL CHECK(length(amount_minor) BETWEEN 1 AND 4096
    AND amount_minor NOT GLOB '*[^0-9]*' AND (amount_minor='0' OR substr(amount_minor,1,1) BETWEEN '1' AND '9')),
  currency TEXT NOT NULL CHECK(currency='COP'),
  actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 128),
  UNIQUE(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,id,intent_key),
  UNIQUE(instance_ref,subject_ref,id,category_id,month),
  FOREIGN KEY(instance_ref,subject_ref,category_id,category_kind) REFERENCES facts(instance_ref,subject_ref,id,kind),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES intents(instance_ref,subject_ref,intent_key,budget_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX budgets_by_period ON budgets(instance_ref,subject_ref,category_id,month,sequence DESC);
CREATE TABLE intents_new (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  fact_id TEXT,
  correction_id TEXT,
  budget_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  PRIMARY KEY(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,fact_id),
  UNIQUE(instance_ref,subject_ref,intent_key,correction_id),
  UNIQUE(instance_ref,subject_ref,intent_key,budget_id),
  CHECK((budget_id IS NOT NULL AND fact_id IS NULL AND correction_id IS NULL)
    OR (budget_id IS NULL AND (fact_id IS NOT NULL OR correction_id IS NOT NULL))),
  FOREIGN KEY(instance_ref,subject_ref,fact_id,intent_key) REFERENCES facts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key) REFERENCES corrections(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,correction_id,intent_key,fact_id) REFERENCES corrections(instance_ref,subject_ref,id,intent_key,replacement_expense_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,budget_id,intent_key) REFERENCES budgets(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO intents_new(instance_ref,subject_ref,intent_key,fact_id,correction_id,fingerprint,result_json)
  SELECT instance_ref,subject_ref,intent_key,fact_id,correction_id,fingerprint,result_json FROM intents;
DROP TRIGGER facts_intent_match;
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
CREATE TRIGGER budgets_no_update BEFORE UPDATE ON budgets BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER budgets_no_delete BEFORE DELETE ON budgets BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE budget_alerts (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  category_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK(length(month)=7),
  threshold INTEGER NOT NULL CHECK(threshold IN (80,100)),
  budget_id TEXT NOT NULL,
  consumed_minor TEXT NOT NULL CHECK(length(consumed_minor) BETWEEN 1 AND 4101
    AND consumed_minor NOT GLOB '*[^0-9]*' AND substr(consumed_minor,1,1) BETWEEN '1' AND '9'),
  trigger_intent_key TEXT NOT NULL,
  PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,category_id,month,threshold),
  FOREIGN KEY(instance_ref,subject_ref,budget_id,category_id,month) REFERENCES budgets(instance_ref,subject_ref,id,category_id,month),
  FOREIGN KEY(instance_ref,subject_ref,trigger_intent_key) REFERENCES intents(instance_ref,subject_ref,intent_key)
) STRICT;
CREATE TRIGGER budget_alerts_no_update BEFORE UPDATE ON budget_alerts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER budget_alerts_no_delete BEFORE DELETE ON budget_alerts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER budget_alerts_no_late_80 BEFORE INSERT ON budget_alerts
WHEN NEW.threshold=80 AND EXISTS (
 SELECT 1 FROM budget_alerts WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref
 AND category_id=NEW.category_id AND month=NEW.month AND threshold=100
) BEGIN SELECT RAISE(ABORT,'threshold_consumed'); END;
`,
} as const;
