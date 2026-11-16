/** Additive salary ledger. Money is canonical text; immutable scoped intentions
 * retain original commands/results and the order needed to verify FIFO. */
const money = `TEXT NOT NULL CHECK(length(amount_minor) BETWEEN 1 AND 4096 AND amount_minor NOT GLOB '*[^0-9]*' AND substr(amount_minor,1,1) BETWEEN '1' AND '9')`;
const identity = `instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, id TEXT NOT NULL, intent_key TEXT NOT NULL`;
const keys = (column: string) => `PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,id,intent_key),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES salary_intents(instance_ref,subject_ref,intent_key,${column}) DEFERRABLE INITIALLY DEFERRED`;
export const migration007 = {
  version: 7,
  sql: `
CREATE TABLE salary_versions (
  ${identity}, amount_minor ${money}, effective_from TEXT NOT NULL CHECK(length(effective_from)=10),
  due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
  UNIQUE(instance_ref,subject_ref,effective_from), ${keys('version_id')}
) STRICT;
CREATE TABLE salary_periods (
  ${identity}, amount_minor ${money}, month TEXT NOT NULL CHECK(length(month)=7),
  source TEXT NOT NULL CHECK(source IN ('opening','closed')), version_id TEXT,
  available_on TEXT NOT NULL CHECK(length(available_on)=10), due_on TEXT NOT NULL CHECK(length(due_on)=10),
  CHECK((source='opening' AND version_id IS NULL) OR (source='closed' AND version_id IS NOT NULL)),
  UNIQUE(instance_ref,subject_ref,month),
  FOREIGN KEY(instance_ref,subject_ref,version_id) REFERENCES salary_versions(instance_ref,subject_ref,id), ${keys('period_id')}
) STRICT;
CREATE TABLE salary_payments (
  ${identity}, amount_minor ${money}, received_on TEXT NOT NULL CHECK(length(received_on)=10),
  status TEXT NOT NULL CHECK(status IN ('confirmed','review_required')),
  ${keys('payment_id')}
) STRICT;
CREATE TABLE salary_intents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, intent_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('configure','opening','close','receive')),
  version_id TEXT, period_id TEXT, payment_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB))<=32768 AND json_valid(draft_json)),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  UNIQUE(instance_ref,subject_ref,intent_key),
  UNIQUE(instance_ref,subject_ref,intent_key,version_id),
  UNIQUE(instance_ref,subject_ref,intent_key,period_id),
  UNIQUE(instance_ref,subject_ref,intent_key,payment_id),
  CHECK((operation='configure' AND version_id IS NOT NULL AND period_id IS NULL AND payment_id IS NULL)
    OR (operation IN ('opening','close') AND period_id IS NOT NULL AND version_id IS NULL AND payment_id IS NULL)
    OR (operation='receive' AND payment_id IS NOT NULL AND version_id IS NULL AND period_id IS NULL)),
  FOREIGN KEY(instance_ref,subject_ref,version_id,intent_key) REFERENCES salary_versions(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,period_id,intent_key) REFERENCES salary_periods(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,payment_id,intent_key) REFERENCES salary_payments(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE salary_allocations (
  instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, payment_id TEXT NOT NULL, period_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9999), amount_minor ${money},
  PRIMARY KEY(instance_ref,subject_ref,payment_id,period_id), UNIQUE(instance_ref,subject_ref,payment_id,ordinal),
  FOREIGN KEY(instance_ref,subject_ref,payment_id) REFERENCES salary_payments(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,period_id) REFERENCES salary_periods(instance_ref,subject_ref,id)
) STRICT;
CREATE INDEX salary_intents_scope ON salary_intents(instance_ref,subject_ref,sequence);
CREATE TRIGGER salary_allocation_confirmed BEFORE INSERT ON salary_allocations WHEN NOT EXISTS (
  SELECT 1 FROM salary_payments WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.payment_id AND status='confirmed'
) BEGIN SELECT RAISE(ABORT,'unconfirmed_salary_payment'); END;
CREATE TRIGGER salary_intents_existing_key BEFORE INSERT ON salary_intents WHEN EXISTS (
  SELECT 1 FROM intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM debt_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
${['intents', 'debt_intents']
  .map(
    (
      table,
    ) => `CREATE TRIGGER ${table}_salary_key BEFORE INSERT ON ${table} WHEN EXISTS (
  SELECT 1 FROM salary_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;`,
  )
  .join('\n')}
${[
  'salary_versions',
  'salary_periods',
  'salary_payments',
  'salary_intents',
  'salary_allocations',
]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;`,
  )
  .join('\n')}
`,
} as const;
