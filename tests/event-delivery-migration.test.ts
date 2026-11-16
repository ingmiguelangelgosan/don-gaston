import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import { migration002 } from '../src/infrastructure/migrations/002-expense-corrections.ts';
import { migration003 } from '../src/infrastructure/migrations/003-monthly-budgets.ts';
import { primaryContext as context } from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'delivery-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'delivery-'));
const policy = { allows: () => true };
const clock = () => '2026-11-14T12:00:00.000Z';
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
function seed() {
  const path = pathFor();
  const store = new SqliteExpenseStore(path);
  const expenses = new ExpenseService(store, policy);
  const budgets = new MonthlyBudgetService(store, policy);
  const corrections = new ExpenseCorrectionsService(store, policy, clock);
  const delivery = new EventDeliveryService(store, policy, clock);
  const category = expenses.createCategory(context, 'cat', {
    name: 'Synthetic category',
  });
  budgets.setBudget(context, 'budget', {
    categoryId: category.id,
    month: '2026-11',
    amount: '100',
  });
  const first = expenses.recordExpense(context, 'first', {
    categoryId: category.id,
    occurredOn: '2026-11-01',
    amount: '80',
  });
  expenses.recordExpense(context, 'second', {
    categoryId: category.id,
    occurredOn: '2026-11-02',
    amount: '20',
  });
  return {
    path,
    store,
    expenses,
    budgets,
    corrections,
    delivery,
    category,
    first,
  };
}
const tables = [
  'facts',
  'corrections',
  'budgets',
  'intents',
  'budget_alerts',
] as const;
function history(db: DatabaseSync) {
  return tables.map((table) => ({
    table,
    rows: db
      .prepare(
        `SELECT * FROM ${table} ORDER BY ${table === 'intents' ? 'intent_key' : 'id'}`,
      )
      .all(),
  }));
}

test('event migration: v3 history preserved, backfill deterministic, rollback atomic and old read-only rejected explicitly', () => {
  const f = seed();
  f.corrections.voidExpense(context, 'void', {
    expenseId: f.first.id,
    reason: 'Synthetic correction',
  });
  const expectedEvents = f.delivery.listPending(context).events;
  f.store.close();
  const source = new DatabaseSync(f.path, { readOnly: true });
  const original = history(source);
  source.close();
  const path = pathFor();
  const old = new DatabaseSync(path);
  old.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  for (const migration of [migration001, migration002, migration003]) {
    old.exec(migration.sql);
    old
      .prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)')
      .run(
        migration.version,
        createHash('sha256').update(migration.sql).digest('hex'),
      );
  }
  old.exec(
    'PRAGMA application_id=1145520467; PRAGMA user_version=3; COMMIT; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE',
  );
  for (const { table, rows } of original) {
    const ordered =
      table === 'facts'
        ? [...rows].sort(
            (a, b) =>
              (a.kind === 'category' ? 0 : 1) - (b.kind === 'category' ? 0 : 1),
          )
        : table === 'budget_alerts'
          ? [...rows].sort((a, b) => Number(a.threshold) - Number(b.threshold))
          : rows;
    for (const row of ordered) {
      const columns = Object.keys(row);
      old
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    }
  }
  old.exec('COMMIT');
  old.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    assert.throws(
      () => new EventDeliveryService(readonly, policy).listPending(context),
      { code: 'STORAGE_SCHEMA' },
    );
    assert.equal(
      new MonthlyBudgetService(readonly, policy).getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-11',
      }).consumed.minor,
      2000n,
    );
  } finally {
    readonly.close();
  }
  assert.throws(
    () =>
      new SqliteExpenseStore(path, {
        afterMigration: () => {
          throw new Error('Synthetic migration failure');
        },
      }),
    { code: 'STORAGE_IO' },
  );
  const rollback = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      rollback.prepare('PRAGMA user_version').get()?.user_version,
      3,
    );
    assert.deepEqual(history(rollback), original);
    assert.equal(
      rollback
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='event_delivery_index'",
        )
        .get(),
      undefined,
    );
  } finally {
    rollback.close();
  }
  const migrated = new SqliteExpenseStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
      assert.deepEqual(history(db), original);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
    const api = new EventDeliveryService(migrated, policy, clock);
    assert.deepEqual(api.listPending(context).events, expectedEvents);
    api.acknowledge(context, { eventId: expectedEvents[0]!.id });
    assert.deepEqual(api.listPending(context).events, [expectedEvents[1]]);
    assert.equal(
      new ExpenseCorrectionsService(migrated, policy).getExpenseHistory(
        context,
        f.first.id,
      ).status,
      'voided',
    );
  } finally {
    migrated.close();
  }
});

test('event index: creation rolls back with its alert and sequence remains exact beyond JS safe integer', () => {
  const f = seed();
  f.store.close();
  const db = new DatabaseSync(f.path);
  db.prepare(
    "UPDATE sqlite_sequence SET seq=? WHERE name='event_delivery_index'",
  ).run(9007199254740991n);
  db.close();
  const store = new SqliteExpenseStore(f.path, {
    afterAlertInsert: () => {
      throw new Error('Synthetic alert failure');
    },
  });
  const budgets = new MonthlyBudgetService(store, policy);
  budgets.setBudget(context, 'december', {
    categoryId: f.category.id,
    month: '2026-12',
    amount: '100',
  });
  assert.throws(
    () =>
      new ExpenseService(store, policy).recordExpense(context, 'retry', {
        categoryId: f.category.id,
        occurredOn: '2026-12-01',
        amount: '80',
      }),
    { code: 'STORAGE_IO' },
  );
  assert.equal(
    new EventDeliveryService(store, policy).listPending(context).events.length,
    2,
  );
  store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const expenses = new ExpenseService(reopened, policy);
    expenses.recordExpense(context, 'retry', {
      categoryId: f.category.id,
      occurredOn: '2026-12-01',
      amount: '80',
    });
    expenses.recordExpense(context, 'next', {
      categoryId: f.category.id,
      occurredOn: '2026-12-02',
      amount: '20',
    });
    const api = new EventDeliveryService(reopened, policy);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = api.listPending(
        context,
        cursor ? { limit: 1, cursor } : { limit: 1 },
      );
      collected.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(collected.length, 4);
    assert.equal(new Set(collected).size, 4);
    const inspect = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        inspect
          .prepare(
            'SELECT CAST(MAX(sequence) AS TEXT) AS last FROM event_delivery_index',
          )
          .get()?.last,
        '9007199254740993',
      );
    } finally {
      inspect.close();
    }
  } finally {
    reopened.close();
  }
});

test('event integrity: immutable acknowledgements, scoped references and missing index fail closed', () => {
  const f = seed();
  const id = f.delivery.listPending(context).events[0]!.id;
  f.delivery.acknowledge(context, { eventId: id });
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of [
      'event_delivery_config',
      'event_delivery_index',
      'event_acknowledgements',
    ])
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
    assert.throws(() =>
      db.exec("UPDATE event_acknowledgements SET actor_ref='other'"),
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO event_acknowledgements VALUES(?,?,?,?,?)')
        .run(context.instanceRef, 'foreign', id, context.actorRef, clock()),
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO event_acknowledgements VALUES(?,?,?,?,?)')
        .run(
          context.instanceRef,
          context.subjectRef,
          id,
          context.actorRef,
          clock(),
        ),
    );
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='event_delivery_index_no_delete'",
      )
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('DROP TRIGGER event_delivery_index_no_delete');
    db.prepare('DELETE FROM event_delivery_index WHERE event_id<>?').run(id);
    db.exec(trigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(f.path), {
    code: 'STORAGE_CORRUPT',
  });
});

test('event integrity: malformed acknowledgement timestamp detected on reopen', () => {
  const f = seed();
  f.delivery.acknowledge(context, {
    eventId: f.delivery.listPending(context).events[0]!.id,
  });
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='event_acknowledgements_no_update'",
      )
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('DROP TRIGGER event_acknowledgements_no_update');
    db.exec(
      "UPDATE event_acknowledgements SET processed_at='2026-99-99T12:00:00.000Z'",
    );
    db.exec(trigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(f.path), {
    code: 'STORAGE_CORRUPT',
  });
});

test('event cursor: restored divergent history cannot reuse sequence anchors from another branch', () => {
  const f = seed();
  const backup = pathFor(),
    restoredPath = pathFor();
  f.store.backupTo(backup);
  const append = (store: SqliteExpenseStore, key: string) => {
    const expenses = new ExpenseService(store, policy);
    const category = expenses.createCategory(context, key, {
      name: 'Synthetic divergent category',
    });
    new MonthlyBudgetService(store, policy).setBudget(
      context,
      key + '-budget',
      { categoryId: category.id, month: '2026-12', amount: '100' },
    );
    expenses.recordExpense(context, key + '-80', {
      categoryId: category.id,
      occurredOn: '2026-12-01',
      amount: '80',
    });
    expenses.recordExpense(context, key + '-100', {
      categoryId: category.id,
      occurredOn: '2026-12-02',
      amount: '20',
    });
  };
  append(f.store, 'source');
  const cursor = f.delivery.listPending(context, { limit: 3 }).nextCursor;
  assert.ok(cursor);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restoredPath);
  const restored = new SqliteExpenseStore(restoredPath);
  try {
    append(restored, 'restored');
    const api = new EventDeliveryService(restored, policy);
    assert.throws(() => api.listPending(context, { cursor }), {
      code: 'INVALID_CURSOR',
    });
    assert.equal(api.listPending(context).events.length, 4);
  } finally {
    restored.close();
  }
});
