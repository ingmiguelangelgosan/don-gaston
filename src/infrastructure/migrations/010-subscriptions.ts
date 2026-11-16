const scope = 'instance_ref TEXT NOT NULL, subject_ref TEXT NOT NULL';
const money = (column: string) =>
  `${column} TEXT NOT NULL CHECK(length(${column}) BETWEEN 1 AND 4096 AND ${column} NOT GLOB '*[^0-9]*' AND (${column}='0' OR substr(${column},1,1) BETWEEN '1' AND '9'))`;
const namespaces = [
  'intents',
  'debt_intents',
  'salary_intents',
  'bill_intents',
  'loan_intents',
];
/** Additive subscription ledger. Cash total and personal consumption are distinct projections. */
export const migration010 = {
  version: 10,
  sql: `
CREATE TABLE subscription_records (
  ${scope}, id TEXT NOT NULL, intent_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('subscription','subscription-participants','subscription-obligation','subscription-payment','subscription-reimbursement')),
  subscription_id TEXT, obligation_id TEXT, counterparty_id TEXT, category_id TEXT, version_id TEXT,
  month TEXT, occurred_on TEXT, status TEXT CHECK(status IN ('confirmed','review_required')),
  ${money('amount_minor')}, ${money('own_minor')}, expense_id TEXT, expense_intent_key TEXT,
  PRIMARY KEY(instance_ref,subject_ref,id), UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,id,intent_key),
  CHECK((expense_id IS NULL AND expense_intent_key IS NULL) OR (kind='subscription-payment' AND status='confirmed' AND own_minor<>'0' AND expense_id=id AND expense_intent_key IS NOT NULL)),
  CHECK(kind<>'subscription-payment' OR ((status='review_required' AND own_minor='0' AND expense_id IS NULL) OR (status='confirmed' AND ((own_minor='0' AND expense_id IS NULL) OR (own_minor<>'0' AND expense_id IS NOT NULL))))),
  CHECK((kind='subscription' AND subscription_id IS NULL AND obligation_id IS NULL AND counterparty_id IS NULL AND category_id IS NOT NULL AND month IS NOT NULL AND status IS NULL) OR
    (kind='subscription-participants' AND subscription_id IS NOT NULL AND obligation_id IS NULL AND counterparty_id IS NULL AND month IS NOT NULL AND status IS NULL) OR
    (kind='subscription-obligation' AND subscription_id IS NOT NULL AND obligation_id IS NULL AND counterparty_id IS NULL AND category_id IS NOT NULL AND month IS NOT NULL AND occurred_on IS NOT NULL AND status IS NULL) OR
    (kind='subscription-payment' AND subscription_id IS NOT NULL AND obligation_id IS NOT NULL AND counterparty_id IS NULL AND category_id IS NOT NULL AND month IS NOT NULL AND occurred_on IS NOT NULL AND status IS NOT NULL) OR
    (kind='subscription-reimbursement' AND subscription_id IS NULL AND obligation_id IS NULL AND counterparty_id IS NOT NULL AND occurred_on IS NOT NULL AND status IS NOT NULL)),
  FOREIGN KEY(instance_ref,subject_ref,subscription_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,obligation_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,version_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,counterparty_id) REFERENCES loan_counterparties(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,category_id) REFERENCES facts(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,expense_id,expense_intent_key) REFERENCES facts(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref,subject_ref,intent_key,id) REFERENCES subscription_intents(instance_ref,subject_ref,intent_key,record_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX subscription_period_unique ON subscription_records(instance_ref,subject_ref,subscription_id,month) WHERE kind='subscription-obligation';
CREATE UNIQUE INDEX subscription_version_unique ON subscription_records(instance_ref,subject_ref,subscription_id,month) WHERE kind='subscription-participants';
CREATE UNIQUE INDEX subscription_payment_unique ON subscription_records(instance_ref,subject_ref,obligation_id) WHERE kind='subscription-payment' AND status='confirmed';
CREATE TABLE subscription_intents (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, ${scope}, intent_key TEXT NOT NULL, record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','change','generate','pay','reimburse')),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB))<=32768 AND json_valid(draft_json)),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=32768 AND json_valid(result_json)),
  UNIQUE(instance_ref,subject_ref,intent_key), UNIQUE(instance_ref,subject_ref,intent_key,record_id),
  FOREIGN KEY(instance_ref,subject_ref,record_id,intent_key) REFERENCES subscription_records(instance_ref,subject_ref,id,intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE subscription_participants (
  ${scope}, record_id TEXT NOT NULL, counterparty_id TEXT NOT NULL,
  PRIMARY KEY(instance_ref,subject_ref,record_id,counterparty_id),
  FOREIGN KEY(instance_ref,subject_ref,record_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,counterparty_id) REFERENCES loan_counterparties(instance_ref,subject_ref,id)
) STRICT;
CREATE TABLE subscription_shares (
  ${scope}, payment_id TEXT NOT NULL, counterparty_id TEXT NOT NULL, ${money('amount_minor')},
  CHECK(amount_minor<>'0'), PRIMARY KEY(instance_ref,subject_ref,payment_id,counterparty_id),
  FOREIGN KEY(instance_ref,subject_ref,payment_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,counterparty_id) REFERENCES loan_counterparties(instance_ref,subject_ref,id)
) STRICT;
CREATE TABLE subscription_allocations (
  ${scope}, reimbursement_id TEXT NOT NULL, payment_id TEXT NOT NULL, counterparty_id TEXT NOT NULL, ${money('amount_minor')},
  CHECK(amount_minor<>'0'), PRIMARY KEY(instance_ref,subject_ref,reimbursement_id,payment_id,counterparty_id),
  FOREIGN KEY(instance_ref,subject_ref,reimbursement_id) REFERENCES subscription_records(instance_ref,subject_ref,id),
  FOREIGN KEY(instance_ref,subject_ref,payment_id,counterparty_id) REFERENCES subscription_shares(instance_ref,subject_ref,payment_id,counterparty_id)
) STRICT;
CREATE TRIGGER subscription_record_links BEFORE INSERT ON subscription_records WHEN
  (NEW.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.subscription_id AND kind='subscription')) OR
  (NEW.obligation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.obligation_id AND subscription_id=NEW.subscription_id AND kind='subscription-obligation')) OR
  (NEW.category_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.category_id AND kind='category')) OR
  (NEW.kind='subscription-obligation' AND (NEW.version_id IS NULL OR NOT EXISTS(SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.version_id AND ((kind='subscription' AND id=NEW.subscription_id) OR (kind='subscription-participants' AND subscription_id=NEW.subscription_id)))))
BEGIN SELECT RAISE(ABORT,'subscription_link'); END;
CREATE TRIGGER subscription_participant_owner BEFORE INSERT ON subscription_participants WHEN NOT EXISTS(
 SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.record_id AND kind IN ('subscription','subscription-participants','subscription-obligation'))
BEGIN SELECT RAISE(ABORT,'subscription_link'); END;
CREATE TRIGGER subscription_share_owner BEFORE INSERT ON subscription_shares WHEN NOT EXISTS(
 SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.payment_id AND kind='subscription-payment' AND status='confirmed')
BEGIN SELECT RAISE(ABORT,'subscription_link'); END;
CREATE TRIGGER subscription_allocation_owner BEFORE INSERT ON subscription_allocations WHEN NOT EXISTS(
 SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND id=NEW.reimbursement_id AND kind='subscription-reimbursement' AND status='confirmed' AND counterparty_id=NEW.counterparty_id)
BEGIN SELECT RAISE(ABORT,'subscription_link'); END;
CREATE TRIGGER subscription_expense_no_correction BEFORE INSERT ON corrections WHEN EXISTS(
 SELECT 1 FROM subscription_records WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND expense_id=NEW.original_expense_id)
BEGIN SELECT RAISE(ABORT,'subscription_payment_correction_required'); END;
CREATE TRIGGER subscription_expense_not_corrected BEFORE INSERT ON subscription_records WHEN NEW.expense_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM corrections WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND original_expense_id=NEW.expense_id)
BEGIN SELECT RAISE(ABORT,'subscription_payment_correction_required'); END;
CREATE TRIGGER subscription_intent_existing_key BEFORE INSERT ON subscription_intents WHEN EXISTS(
 ${namespaces.map((table) => `SELECT 1 FROM ${table} WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key`).join(' UNION ALL ')}
) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;
${namespaces.map((table) => `CREATE TRIGGER ${table}_subscription_key BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM subscription_intents WHERE instance_ref=NEW.instance_ref AND subject_ref=NEW.subject_ref AND intent_key=NEW.intent_key) BEGIN SELECT RAISE(ABORT,'intent_key_conflict'); END;`).join('\n')}
${[
  'subscription_records',
  'subscription_intents',
  'subscription_participants',
  'subscription_shares',
  'subscription_allocations',
]
  .map(
    (
      table,
    ) => `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END;`,
  )
  .join('\n')}
`,
} as const;
