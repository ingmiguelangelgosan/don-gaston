/** Versioned SQL embedded in TS so the same migration ships with source and build. */
export const migration001 = {
  version: 1,
  sql: `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL
) STRICT;
CREATE TABLE facts (
  instance_ref TEXT NOT NULL CHECK(length(instance_ref) BETWEEN 1 AND 128),
  subject_ref TEXT NOT NULL CHECK(length(subject_ref) BETWEEN 1 AND 128),
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  intent_key TEXT NOT NULL CHECK(length(intent_key) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('category','expense')),
  actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 128),
  name TEXT,
  category_id TEXT,
  category_kind TEXT,
  amount_minor TEXT,
  currency TEXT,
  occurred_on TEXT,
  PRIMARY KEY(instance_ref, subject_ref, id),
  UNIQUE(instance_ref, subject_ref, intent_key),
  UNIQUE(instance_ref, subject_ref, id, intent_key),
  UNIQUE(instance_ref, subject_ref, id, kind),
  CHECK (
    (kind='category' AND name IS NOT NULL AND length(name) BETWEEN 1 AND 100
     AND category_id IS NULL AND category_kind IS NULL AND amount_minor IS NULL
     AND currency IS NULL AND occurred_on IS NULL)
    OR
    (kind='expense' AND name IS NULL AND category_id IS NOT NULL
     AND category_kind IS NOT NULL AND category_kind='category'
     AND amount_minor IS NOT NULL AND length(amount_minor) BETWEEN 1 AND 4096
     AND amount_minor NOT GLOB '*[^0-9]*' AND substr(amount_minor,1,1) BETWEEN '1' AND '9'
     AND currency IS NOT NULL AND currency='COP' AND occurred_on IS NOT NULL
     AND length(occurred_on)=10)
  ),
  FOREIGN KEY(instance_ref, subject_ref, intent_key)
    REFERENCES intents(instance_ref, subject_ref, intent_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(instance_ref, subject_ref, category_id, category_kind)
    REFERENCES facts(instance_ref, subject_ref, id, kind)
) STRICT;
CREATE TABLE intents (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 32768 AND json_valid(result_json)),
  PRIMARY KEY(instance_ref, subject_ref, intent_key),
  UNIQUE(instance_ref, subject_ref, fact_id),
  FOREIGN KEY(instance_ref, subject_ref, fact_id, intent_key)
    REFERENCES facts(instance_ref, subject_ref, id, intent_key) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX expenses_by_scope_date ON facts(instance_ref, subject_ref, occurred_on, category_id) WHERE kind='expense';
CREATE TRIGGER facts_no_update BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER intents_no_update BEFORE UPDATE ON intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER intents_no_delete BEFORE DELETE ON intents BEGIN SELECT RAISE(ABORT,'append_only'); END;
`,
} as const;
