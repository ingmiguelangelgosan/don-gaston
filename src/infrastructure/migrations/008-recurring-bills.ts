/** Additive monthly obligations and immutable payment metadata. A payment points
 * to ONE existing-format expense fact; its cash view never creates another fact. */
const identity = `instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, id TEXT NOT NULL, intent_key TEXT NOT NULL`;
const keys = (column: string) => `PRIMARY KEY(instance_ref,subject_ref,id),
  UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,id,intent_key),
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES bill_intents(instance_ref,subject_ref,intent_key,${column}) DEFERRABLE INITIALLY DEFERRED`;
const amountCheck = (column: string) =>
  `length(${column}) BETWEEN 1 AND 4096 AND ${column} NOT GLOB '*[^0-9]*' AND substr(${column},1,1) BETWEEN '1' AND '9'`;
export const migration008 = {
  version: 8,
  sql: `
CREATE TABLE bill_concepts (
  ${identity}, category_id TEXT NOT NULL, category_kind TEXT NOT NULL DEFAULT 'category' CHECK(category_kind='category'),
  fixed_minor TEXT CHECK(fixed_minor IS NULL OR (${amountCheck('fixed_minor')})),
  due_day INTEGER, due_month_offset INTEGER,
  CHECK((due_day IS NULL AND due_month_offset IS NULL) OR (due_day IS NOT NULL AND due_day BETWEEN 1 AND 31 AND due_month_offset IS NOT NULL AND due_month_offset IN (0,1))),
  FOREIGN KEY(instance_ref,subject_ref,category_id,category_kind) REFERENCES facts(instance_ref,subject_ref,id,kind), ${keys('concept_id')}
) STRICT;
CREATE TABLE bill_obligations (
  ${identity}, concept_id TEXT NOT NULL, month TEXT NOT NULL CHECK(length(month)=7),
  generated_on TEXT NOT NULL CHECK(length(generated_on)=10), due_on TEXT CHECK(due_on IS NULL OR length(due_on)=10),
  amount_minor TEXT, amount_status TEXT NOT NULL CHECK(amount_status IN ('unknown','estimated','confirmed')),
  source_payment_id TEXT,
  CHECK((amount_status='unknown' AND amount_minor IS NULL) OR (amount_status IN ('estimated','confirmed') AND amount_minor IS NOT NULL AND (${amountCheck('amount_minor')}))),
  UNIQUE(instance_ref,subject_ref,concept_id,month),
  FOREIGN KEY(instance_ref,subject_ref,concept_id) REFERENCES bill_concepts(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,source_payment_id) REFERENCES bill_payments(instance_ref,subject_ref,id), ${keys('obligation_id')}
) STRICT;
CREATE TABLE bill_adjustments (
  ${identity}, obligation_id TEXT NOT NULL, previous_revision_id TEXT NOT NULL,
  amount_minor TEXT NOT NULL CHECK(${amountCheck('amount_minor')}),
  amount_status TEXT NOT NULL CHECK(amount_status IN ('estimated','confirmed')),
  UNIQUE(instance_ref,subject_ref,previous_revision_id),
  FOREIGN KEY(instance_ref,subject_ref,obligation_id) REFERENCES bill_obligations(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,previous_revision_id) REFERENCES bill_intents(instance_ref,subject_ref,result_id), ${keys('adjustment_id')}
) STRICT;
CREATE TABLE bill_payments (
  ${identity}, obligation_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  expense_intent_key TEXT NOT NULL, expense_kind TEXT NOT NULL DEFAULT 'expense' CHECK(expense_kind='expense'),
  paid_on TEXT NOT NULL CHECK(length(paid_on)=10),
  UNIQUE(instance_ref,subject_ref,obligation_id), UNIQUE(instance_ref,subject_ref,expense_intent_key),
  FOREIGN KEY(instance_ref,subject_ref,obligation_id) REFERENCES bill_obligations(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,revision_id) REFERENCES bill_intents(instance_ref,subject_ref,result_id),
  FOREIGN KEY(instance_ref,subject_ref,id,expense_kind) REFERENCES facts(instance_ref,subject_ref,id,kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,id,expense_intent_key) REFERENCES facts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  ${keys('payment_id')}
) STRICT;
CREATE TABLE bill_intents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL, intent_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('concept','generate','adjust','pay')),
  result_id TEXT NOT NULL, concept_id TEXT, obligation_id TEXT, adjustment_id TEXT, payment_id TEXT,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB))<=32768 AND json_valid(draft_json)),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,result_id),
  UNIQUE(instance_ref,subject_ref,intent_key,concept_id), UNIQUE(instance_ref,subject_ref,intent_key,obligation_id),
  UNIQUE(instance_ref,subject_ref,intent_key,adjustment_id), UNIQUE(instance_ref,subject_ref,intent_key,payment_id),
  CHECK((operation='concept' AND concept_id IS NOT NULL AND concept_id=result_id AND obligation_id IS NULL AND adjustment_id IS NULL AND payment_id IS NULL)
    OR (operation='generate' AND obligation_id IS NOT NULL AND obligation_id=result_id AND concept_id IS NULL AND adjustment_id IS NULL AND payment_id IS NULL)
    OR (operation='adjust' AND adjustment_id IS NOT NULL AND adjustment_id=result_id AND concept_id IS NULL AND obligation_id IS NULL AND payment_id IS NULL)
    OR (operation='pay' AND payment_id IS NOT NULL AND payment_id=result_id AND concept_id IS NULL AND obligation_id IS NULL AND adjustment_id IS NULL)),
  FOREIGN KEY(instance_ref,subject_ref,concept_id,intent_key) REFERENCES bill_concepts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,obligation_id,intent_key) REFERENCES bill_obligations(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,adjustment_id,intent_key) REFERENCES bill_adjustments(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,payment_id,intent_key) REFERENCES bill_payments(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX bill_intents_scope ON bill_intents(instance_ref,subject_ref,sequence);
CREATE TRIGGER bill_intents_existing_key BEFORE INSERT ON bill_intents WHEN EXISTS (
  SELECT 1 FROM intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM debt_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
  UNION ALL SELECT 1 FROM salary_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
${['intents', 'debt_intents', 'salary_intents']
  .map(
    (
      table,
    ) => `CREATE TRIGGER ${table}_bill_key BEFORE INSERT ON ${table} WHEN EXISTS (
  SELECT 1 FROM bill_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;`,
  )
  .join('\n')}
CREATE TRIGGER corrections_no_bill_payment BEFORE INSERT ON corrections WHEN EXISTS (
  SELECT 1 FROM bill_payments WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.original_expense_id
) BEGIN SELECT RAISE(ABORT,'bill_payment_correction_required'); END;
CREATE TRIGGER bill_payments_not_corrected BEFORE INSERT ON bill_payments WHEN EXISTS (
  SELECT 1 FROM corrections WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND original_expense_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'bill_payment_correction_required'); END;
CREATE TRIGGER bill_adjustments_not_paid BEFORE INSERT ON bill_adjustments WHEN EXISTS (
  SELECT 1 FROM bill_payments WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND obligation_id=NEW.obligation_id
) BEGIN SELECT RAISE(ABORT,'bill_already_paid'); END;
${[
  ['bill_adjustments', 'previous_revision_id'],
  ['bill_payments', 'revision_id'],
]
  .map(
    ([table, revision]) => `
CREATE TRIGGER ${table}_current_revision BEFORE INSERT ON ${table} WHEN NOT (
  (NEW.${revision}=NEW.obligation_id OR EXISTS (
    SELECT 1 FROM bill_adjustments a WHERE a.instance_ref=NEW.instance_ref AND a.subject_ref=NEW.subject_ref
      AND a.id=NEW.${revision} AND a.obligation_id=NEW.obligation_id))
  AND NOT EXISTS (SELECT 1 FROM bill_adjustments a WHERE a.instance_ref=NEW.instance_ref AND a.subject_ref=NEW.subject_ref
    AND a.obligation_id=NEW.obligation_id AND a.previous_revision_id=NEW.${revision})
) BEGIN SELECT RAISE(ABORT,'bill_revision_conflict'); END;`,
  )
  .join('\n')}
${[
  'bill_concepts',
  'bill_obligations',
  'bill_adjustments',
  'bill_payments',
  'bill_intents',
]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;`,
  )
  .join('\n')}
`,
} as const;
