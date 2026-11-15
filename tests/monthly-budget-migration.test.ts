import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import { migration002 } from '../src/infrastructure/migrations/002-expense-corrections.ts';
import { primaryContext as context } from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'budget-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'migration-'));
const policy = { allows: () => true };
const clock = () => '2026-11-14T12:00:00.000Z';
const oldIntentColumns =
  'instance_ref,subject_ref,intent_key,fact_id,correction_id,fingerprint,result_json';

test('budget migration: v2 history and intention bytes survive rollback and v3 migration', () => {
  // Build an independent synthetic v2 fixture from public financial operations.
  // Never downgrade or touch an existing application database.
  const seedPath = join(directory, 'seed.sqlite');
  const seed = new SqliteExpenseStore(seedPath);
  const expenses = new ExpenseService(seed, policy);
  const corrections = new ExpenseCorrectionsService(seed, policy, clock);
  const category = expenses.createCategory(context, 'category', {
    name: 'Fixture fuel',
  });
  const original = expenses.recordExpense(context, 'expense', {
    amount: '99',
    categoryId: category.id,
    occurredOn: '2026-11-01',
  });
  const replacementInput = {
    amount: '80',
    currency: 'COP',
    categoryId: category.id,
    occurredOn: '2026-11-02',
  };
  const replaced = corrections.replaceExpense(context, 'replace', {
    expenseId: original.id,
    reason: 'Fixture correction',
    replacement: replacementInput,
  });
  const extra = expenses.recordExpense(context, 'extra', {
    amount: '7',
    categoryId: category.id,
    occurredOn: '2026-10-01',
  });
  const voided = corrections.voidExpense(context, 'void', {
    expenseId: extra.id,
    reason: 'Fixture void',
  });
  seed.close();
  const source = new DatabaseSync(seedPath, { readOnly: true });
  const facts = source.prepare('SELECT * FROM facts ORDER BY id').all();
  const events = source.prepare('SELECT * FROM corrections ORDER BY id').all();
  const intents = source
    .prepare(`SELECT ${oldIntentColumns} FROM intents ORDER BY intent_key`)
    .all();
  source.close();
  const path = join(directory, 'v2.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  for (const migration of [migration001, migration002]) {
    legacy.exec(migration.sql);
    legacy
      .prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)')
      .run(
        migration.version,
        createHash('sha256').update(migration.sql).digest('hex'),
      );
  }
  legacy.exec(
    'PRAGMA application_id=1145520467; PRAGMA user_version=2; COMMIT; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE',
  );
  for (const [table, rows] of [
    ['facts', facts],
    ['corrections', events],
    ['intents', intents],
  ] as const) {
    const ordered =
      table === 'facts'
        ? [...rows].sort(
            (a, b) =>
              (a.kind === 'category' ? 0 : 1) - (b.kind === 'category' ? 0 : 1),
          )
        : rows;
    for (const row of ordered) {
      const columns = Object.keys(row);
      legacy
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    }
  }
  legacy.exec('COMMIT');
  assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
  legacy.close();

  const readOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    assert.deepEqual(
      new ExpenseCorrectionsService(readOnly, policy).findIntent(
        context,
        'replace',
      ),
      replaced,
    );
    const status = new MonthlyBudgetService(readOnly, policy).getBudgetStatus(
      context,
      { categoryId: category.id, month: '2026-11' },
    );
    assert.equal(status.budget, null);
    assert.equal(status.consumed.minor, 8000n);
  } finally {
    readOnly.close();
  }
  assert.throws(
    () =>
      new SqliteExpenseStore(path, {
        afterMigration: () => {
          throw new Error('synthetic migration fault');
        },
      }),
    { code: 'STORAGE_IO' },
  );
  const rolledBack = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      rolledBack.prepare('PRAGMA user_version').get()?.user_version,
      2,
    );
    assert.equal(
      rolledBack
        .prepare("SELECT name FROM sqlite_schema WHERE name='budgets'")
        .get(),
      undefined,
    );
    assert.deepEqual(
      rolledBack.prepare('SELECT * FROM facts ORDER BY id').all(),
      facts,
    );
    assert.deepEqual(
      rolledBack.prepare('SELECT * FROM corrections ORDER BY id').all(),
      events,
    );
    assert.deepEqual(
      rolledBack
        .prepare(`SELECT ${oldIntentColumns} FROM intents ORDER BY intent_key`)
        .all(),
      intents,
    );
  } finally {
    rolledBack.close();
  }

  const migrated = new SqliteExpenseStore(path);
  try {
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        inspect.prepare('PRAGMA user_version').get()?.user_version,
        3,
      );
      assert.deepEqual(
        inspect.prepare('SELECT * FROM facts ORDER BY id').all(),
        facts,
      );
      assert.deepEqual(
        inspect.prepare('SELECT * FROM corrections ORDER BY id').all(),
        events,
      );
      assert.deepEqual(
        inspect
          .prepare(
            `SELECT ${oldIntentColumns} FROM intents ORDER BY intent_key`,
          )
          .all(),
        intents,
      );
    } finally {
      inspect.close();
    }
    const api = new ExpenseCorrectionsService(migrated, policy, clock);
    assert.deepEqual(
      api.replaceExpense(context, 'replace', {
        expenseId: original.id,
        reason: 'Fixture correction',
        replacement: replacementInput,
      }),
      replaced,
    );
    assert.deepEqual(
      api.voidExpense(context, 'void', {
        expenseId: extra.id,
        reason: 'Fixture void',
      }),
      voided,
    );
    assert.deepEqual(
      new ExpenseService(migrated, policy).findIntent(context, 'expense'),
      original,
    );
    const budgets = new MonthlyBudgetService(migrated, policy);
    budgets.setBudget(context, 'budget', {
      categoryId: category.id,
      month: '2026-11',
      amount: '100',
    });
    const status = budgets.getBudgetStatus(context, {
      categoryId: category.id,
      month: '2026-11',
    });
    assert.equal(status.consumed.minor, 8000n);
    assert.deepEqual(
      status.alerts.map((alert) => alert.threshold),
      [80],
    );
  } finally {
    migrated.close();
  }
});

test('budget integrity: immutable rows, scoped FKs, unique thresholds and corrupt events rejected', () => {
  const path = join(directory, 'integrity.sqlite');
  const store = new SqliteExpenseStore(path);
  const expenses = new ExpenseService(store, policy);
  const category = expenses.createCategory(context, 'cat', { name: 'Fixture' });
  const budgets = new MonthlyBudgetService(store, policy);
  budgets.setBudget(context, 'budget', {
    categoryId: category.id,
    month: '2026-11',
    amount: '100',
  });
  expenses.recordExpense(context, 'spend', {
    categoryId: category.id,
    occurredOn: '2026-11-01',
    amount: '80',
  });
  store.close();
  const db = new DatabaseSync(path);
  try {
    for (const table of ['budgets', 'budget_alerts']) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET month='2026-12'`));
    }
    const row = db.prepare('SELECT * FROM budget_alerts').get();
    assert.ok(row);
    const columns = Object.keys(row);
    const insert = db.prepare(
      `INSERT INTO budget_alerts(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    );
    assert.throws(() =>
      insert.run(
        ...(Object.values({ ...row, id: 'duplicate' }) as SQLInputValue[]),
      ),
    );
    assert.throws(() =>
      insert.run(
        ...(Object.values({
          ...row,
          id: 'other',
          subject_ref: 'foreign-subject',
        }) as SQLInputValue[]),
      ),
    );
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='budget_alerts_no_update'",
      )
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('DROP TRIGGER budget_alerts_no_update');
    db.exec("UPDATE budget_alerts SET consumed_minor='1'");
    db.exec(trigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(path), {
    code: 'STORAGE_CORRUPT',
  });
});

test('budget integrity: changed canonical amount cannot bypass persisted result validation', () => {
  const path = join(directory, 'corrupt-budget.sqlite');
  const store = new SqliteExpenseStore(path);
  const category = new ExpenseService(store, policy).createCategory(
    context,
    'cat',
    { name: 'Fixture' },
  );
  new MonthlyBudgetService(store, policy).setBudget(context, 'budget', {
    categoryId: category.id,
    month: '2026-11',
    amount: '100',
  });
  store.close();
  const db = new DatabaseSync(path);
  try {
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='budgets_no_update'")
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('DROP TRIGGER budgets_no_update');
    db.exec("UPDATE budgets SET amount_minor='9999'");
    db.exec(trigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(path), {
    code: 'STORAGE_CORRUPT',
  });
});
