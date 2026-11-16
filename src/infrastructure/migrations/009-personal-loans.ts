/** Personal-loan capital is its own cash fact, never a consumption or earned-income fact. */
const identity = `instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, id TEXT NOT NULL, intent_key TEXT NOT NULL`;
const keys = (column: string) => `PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,id,intent_key),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES loan_intents(instance_ref,subject_ref,intent_key,${column}) DEFERRABLE INITIALLY DEFERRED`;
export const migration009 = {
  version: 9,
  sql: `
CREATE TABLE loan_counterparties (
  ${identity}, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), ${keys('counterparty_id')}
) STRICT;
CREATE TABLE loan_movements (
  ${identity}, counterparty_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
  movement_type TEXT NOT NULL CHECK(movement_type IN ('disbursement','repayment')),
  amount_minor TEXT NOT NULL CHECK(length(amount_minor) BETWEEN 1 AND 4096 AND amount_minor NOT GLOB '*[^0-9]*' AND substr(amount_minor,1,1) BETWEEN '1' AND '9'),
  currency TEXT NOT NULL CHECK(currency='COP'), occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10),
  status TEXT NOT NULL CHECK(status IN ('confirmed','review_required')), review_reason TEXT, cash_direction TEXT,
  CHECK((status='confirmed' AND review_reason IS NULL AND cash_direction IS NOT NULL AND cash_direction IN ('inflow','outflow')) OR
    (status='review_required' AND movement_type='repayment' AND cash_direction IS NULL AND review_reason IS NOT NULL AND review_reason IN ('EXCEEDS_PENDING_BALANCE','PAYMENT_DATE_REQUIRES_REVIEW'))),
  CHECK(status='review_required' OR
    (cash_direction='inflow' AND ((direction='payable' AND movement_type='disbursement') OR (direction='receivable' AND movement_type='repayment'))) OR
    (cash_direction='outflow' AND ((direction='receivable' AND movement_type='disbursement') OR (direction='payable' AND movement_type='repayment')))),
  FOREIGN KEY(instance_ref,subject_ref,counterparty_id) REFERENCES loan_counterparties(instance_ref,subject_ref,id), ${keys('movement_id')}
) STRICT;
CREATE INDEX loan_movements_by_position ON loan_movements(instance_ref,subject_ref,counterparty_id,direction,occurred_on);
CREATE TABLE loan_intents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, intent_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('counterparty','disburse','repay')),
  counterparty_id TEXT, movement_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB))<=32768 AND json_valid(draft_json)),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  UNIQUE(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,intent_key,counterparty_id), UNIQUE(instance_ref,subject_ref,intent_key,movement_id),
  CHECK((operation='counterparty' AND counterparty_id IS NOT NULL AND movement_id IS NULL) OR
    (operation IN ('disburse','repay') AND counterparty_id IS NULL AND movement_id IS NOT NULL)),
  FOREIGN KEY(instance_ref,subject_ref,counterparty_id,intent_key) REFERENCES loan_counterparties(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,movement_id,intent_key) REFERENCES loan_movements(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX loan_intents_scope ON loan_intents(instance_ref,subject_ref,sequence);
CREATE TRIGGER loan_intents_existing_key BEFORE INSERT ON loan_intents WHEN EXISTS (
  SELECT 1 FROM intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM debt_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM salary_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM bill_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
${['intents', 'debt_intents', 'salary_intents', 'bill_intents']
  .map(
    (
      table,
    ) => `CREATE TRIGGER ${table}_loan_key BEFORE INSERT ON ${table} WHEN EXISTS (
  SELECT 1 FROM loan_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;`,
  )
  .join('\n')}
${['loan_counterparties', 'loan_movements', 'loan_intents']
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;`,
  )
  .join('\n')}
`,
} as const;
