/** Delivery metadata is additive: no existing financial/event rows are rewritten. */
export const migration004 = {
  version: 4,
  sql: `
CREATE TABLE event_delivery_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  cursor_key TEXT NOT NULL CHECK(length(cursor_key)=64 AND cursor_key NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER event_delivery_config_no_update BEFORE UPDATE ON event_delivery_config BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER event_delivery_config_no_delete BEFORE DELETE ON event_delivery_config BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE event_delivery_index (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence>0),
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  UNIQUE(instance_ref,subject_ref,event_id),
  FOREIGN KEY(instance_ref,subject_ref,event_id) REFERENCES budget_alerts(instance_ref,subject_ref,id)
) STRICT;
CREATE INDEX event_delivery_by_scope ON event_delivery_index(instance_ref,subject_ref,sequence);
INSERT INTO event_delivery_index(instance_ref,subject_ref,event_id)
  SELECT instance_ref,subject_ref,id FROM budget_alerts
  ORDER BY instance_ref,subject_ref,category_id,month,threshold,id;
CREATE TRIGGER event_delivery_index_no_update BEFORE UPDATE ON event_delivery_index BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER event_delivery_index_no_delete BEFORE DELETE ON event_delivery_index BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER budget_alerts_delivery_index AFTER INSERT ON budget_alerts BEGIN
  INSERT INTO event_delivery_index(instance_ref,subject_ref,event_id) VALUES(NEW.instance_ref,NEW.subject_ref,NEW.id);
END;
CREATE TABLE event_acknowledgements (
  instance_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 128),
  processed_at TEXT NOT NULL CHECK(length(processed_at)=24),
  PRIMARY KEY(instance_ref,subject_ref,event_id),
  FOREIGN KEY(instance_ref,subject_ref,event_id) REFERENCES event_delivery_index(instance_ref,subject_ref,event_id)
) STRICT;
CREATE TRIGGER event_acknowledgements_no_update BEFORE UPDATE ON event_acknowledgements BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER event_acknowledgements_no_delete BEFORE DELETE ON event_acknowledgements BEGIN SELECT RAISE(ABORT,'append_only'); END;
`,
} as const;
