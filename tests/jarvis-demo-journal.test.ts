import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DemoRequestJournal } from '../src/interfaces/jarvis-demo-journal.ts';

const root = join(process.cwd(), '.cache', 'jarvis-demo-journal');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let counter = 0;
const pathFor = () => join(directory, `metadata-${++counter}.sqlite`);
const key = `jg1-${'a'.repeat(64)}`,
  hash = 'b'.repeat(64);
test('demo journal: reserve before effect, stable replay after reopen and conflicting hash rejected', () => {
  const path = pathFor();
  const first = new DemoRequestJournal(path, { create: true });
  first.reserve(key, hash);
  first.close();
  const recovered = new DemoRequestJournal(path);
  try {
    assert.equal(recovered.has(key), true);
    recovered.reserve(key, hash);
    assert.throws(() => recovered.reserve(key, 'c'.repeat(64)), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const inspect = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      inspect.prepare('SELECT count(*) AS n FROM demo_requests').get()?.n,
      1,
    );
    const columns = inspect
      .prepare('PRAGMA table_info(demo_requests)')
      .all()
      .map((c) => c.name);
    assert.deepEqual(columns, ['intent_key', 'fingerprint']);
    inspect.close();
  } finally {
    recovered.close();
  }
});
test('demo journal: absent, empty and foreign files never recreate on recovery', () => {
  assert.throws(() => new DemoRequestJournal(pathFor()), {
    code: 'STORAGE_IO',
  });
  const empty = pathFor();
  writeFileSync(empty, '');
  assert.throws(() => new DemoRequestJournal(empty), {
    code: 'STORAGE_SCHEMA',
  });
  assert.throws(() => new DemoRequestJournal(empty, { create: true }), {
    code: 'STORAGE_DESTINATION_EXISTS',
  });
  const foreign = pathFor();
  writeFileSync(foreign, 'synthetic non-sqlite');
  assert.throws(() => new DemoRequestJournal(foreign), {
    code: 'STORAGE_CORRUPT',
  });
});
test('demo journal: missing reservation with existing financial effect fails closed', () => {
  const journal = new DemoRequestJournal(pathFor(), { create: true });
  try {
    assert.throws(() => journal.reserve(key, hash, true), {
      code: 'STORAGE_CORRUPT',
    });
    assert.equal(journal.has(key), false);
  } finally {
    journal.close();
  }
});
test('demo journal: concurrent connections serialize, busy does not reserve, SQL is append-only', () => {
  const path = pathFor(),
    a = new DemoRequestJournal(path, { create: true }),
    b = new DemoRequestJournal(path, { busyTimeoutMs: 0 }),
    db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => b.reserve(key, hash), { code: 'STORAGE_BUSY' });
    db.exec('ROLLBACK');
    assert.equal(b.has(key), false);
    a.reserve(key, hash);
    b.reserve(key, hash);
    assert.throws(() => b.reserve(key, 'd'.repeat(64)), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(() => db.exec('DELETE FROM demo_requests'));
    assert.throws(() => db.exec("UPDATE demo_requests SET fingerprint='bad'"));
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    a.close();
    b.close();
  }
});
test('demo journal: schema tampering and closed access are explicit errors', () => {
  const path = pathFor(),
    journal = new DemoRequestJournal(path, { create: true }),
    db = new DatabaseSync(path);
  db.exec('DROP TRIGGER demo_requests_no_delete');
  db.close();
  assert.throws(() => journal.has(key), { code: 'STORAGE_SCHEMA' });
  journal.close();
  assert.throws(() => new DemoRequestJournal(path), { code: 'STORAGE_SCHEMA' });
  assert.throws(() => journal.has(key), { code: 'STORAGE_CLOSED' });
});
