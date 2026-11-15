import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import { migration002 } from '../src/infrastructure/migrations/002-expense-corrections.ts';
import { migration003 } from '../src/infrastructure/migrations/003-monthly-budgets.ts';
import { migration004 } from '../src/infrastructure/migrations/004-event-delivery.ts';
import { primaryContext as context } from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'debt-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'debt-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const policy = { allows: () => true };
const clock = () => '2026-11-15T12:00:00.000Z';
const opening = {
  description: 'Synthetic iPhone',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-11-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
  historicalPaidAmount: '2000000',
};
const tables = [
  'facts',
  'corrections',
  'budgets',
  'intents',
  'budget_alerts',
  'event_delivery_config',
  'event_delivery_index',
  'event_acknowledgements',
] as const;
function snapshot(db: DatabaseSync) {
  return tables.map((table) => ({
    table,
    rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}
function setup() {
  const path = pathFor();
  const store = new SqliteExpenseStore(path);
  const api = new FinancedDebtService(store, policy, clock);
  const debt = api.registerDebt(context, 'opening', opening);
  const payment = api.confirmPayment(context, 'payment', {
    debtId: debt.id,
    installmentNumber: 9,
    amount: '250000',
    paidOn: '2026-11-15',
    reference: 'synthetic',
  });
  return { path, store, api, debt, payment };
}

test('financed debt migration: v4 history, cursor and acknowledgements survive v5; failure rolls back schema', () => {
  const seedPath = pathFor();
  const seed = new SqliteExpenseStore(seedPath);
  const expenses = new ExpenseService(seed, policy);
  const budgets = new MonthlyBudgetService(seed, policy);
  const corrections = new ExpenseCorrectionsService(seed, policy, clock);
  const delivery = new EventDeliveryService(seed, policy, clock);
  const category = expenses.createCategory(context, 'category', {
    name: 'Synthetic fuel',
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
  const page = delivery.listPending(context, { limit: 1 });
  assert.ok(page.nextCursor);
  const receipt = delivery.acknowledge(context, {
    eventId: page.events[0]!.id,
  });
  const correction = corrections.replaceExpense(context, 'correct', {
    expenseId: first.id,
    reason: 'Synthetic change',
    replacement: {
      categoryId: category.id,
      occurredOn: '2026-10-01',
      currency: 'COP',
      amount: '70',
    },
  });
  seed.close();
  const source = new DatabaseSync(seedPath, { readOnly: true });
  const before = snapshot(source);
  source.close();
  const path = pathFor();
  const old = new DatabaseSync(path);
  old.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  for (const migration of [
    migration001,
    migration002,
    migration003,
    migration004,
  ]) {
    old.exec(migration.sql);
    old
      .prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)')
      .run(
        migration.version,
        createHash('sha256').update(migration.sql).digest('hex'),
      );
  }
  const indexTrigger = old
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE name='budget_alerts_delivery_index'",
    )
    .get()?.sql;
  assert.equal(typeof indexTrigger, 'string');
  old.exec('DROP TRIGGER budget_alerts_delivery_index');
  for (const { table, rows } of before) {
    for (const row of rows) {
      const columns = Object.keys(row);
      old
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    }
  }
  old.exec(indexTrigger as string);
  old.exec(
    'PRAGMA application_id=1145520467; PRAGMA user_version=4; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
  const readOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    assert.throws(
      () =>
        new FinancedDebtService(readOnly, policy).getDebt(context, 'unknown'),
      { code: 'STORAGE_SCHEMA' },
    );
    assert.equal(
      new EventDeliveryService(readOnly, policy).listPending(context).events
        .length,
      1,
    );
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
      4,
    );
    assert.deepEqual(snapshot(rolledBack), before);
    assert.equal(
      rolledBack
        .prepare("SELECT name FROM sqlite_schema WHERE name='financed_debts'")
        .get(),
      undefined,
    );
  } finally {
    rolledBack.close();
  }
  const migrated = new SqliteExpenseStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6);
      assert.deepEqual(snapshot(db), before);
    } finally {
      db.close();
    }
    const eventApi = new EventDeliveryService(migrated, policy, clock);
    assert.equal(
      eventApi.listPending(context, { cursor: page.nextCursor }).events.length,
      1,
    );
    assert.deepEqual(
      eventApi.acknowledge(context, { eventId: receipt.eventId }),
      receipt,
    );
    assert.deepEqual(
      new ExpenseCorrectionsService(migrated, policy).findIntent(
        context,
        'correct',
      ),
      correction,
    );
    const debts = new FinancedDebtService(migrated, policy, clock);
    const debt = debts.registerDebt(context, 'opening', opening);
    debts.confirmPayment(context, 'payment', {
      debtId: debt.id,
      installmentNumber: 9,
      amount: '250000',
      paidOn: '2026-11-15',
      reference: 'synthetic',
    });
    assert.equal(
      debts.getDebt(context, debt.id).estimatedBalance.minor,
      375000000n,
    );
    assert.equal(
      new ExpenseService(migrated, policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
      2000n,
    );
    assert.equal(eventApi.listPending(context).events.length, 1);
  } finally {
    migrated.close();
  }
});

test('financed debt integrity: immutable rows, reciprocal FKs and cross-module intent constraints', () => {
  const f = setup();
  new ExpenseService(f.store, policy).createCategory(context, 'old-category', {
    name: 'Synthetic category',
  });
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of [
      'financed_debts',
      'debt_payment_results',
      'debt_intents',
    ]) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET intent_key='changed'`));
    }
    const debtIntent = db
      .prepare("SELECT * FROM debt_intents WHERE intent_key='opening'")
      .get();
    assert.ok(debtIntent);
    const oldIntent = db
      .prepare("SELECT * FROM intents WHERE intent_key='old-category'")
      .get();
    assert.ok(oldIntent);
    for (const [table, row, key] of [
      ['debt_intents', debtIntent, 'old-category'],
      ['intents', oldIntent, 'opening'],
    ] as const) {
      const clone = { ...row, intent_key: key };
      const columns = Object.keys(clone);
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
            )
            .run(...(Object.values(clone) as SQLInputValue[])),
        /intent_key_conflict/,
      );
    }
    const row = db.prepare('SELECT * FROM debt_payment_results LIMIT 1').get();
    assert.ok(row);
    const clone = {
      ...row,
      sequence: null,
      id: 'orphan',
      intent_key: 'orphan',
      subject_ref: 'foreign',
    };
    const columns = Object.keys(clone);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO debt_payment_results(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(clone) as SQLInputValue[])),
    );
  } finally {
    db.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  reopened.close();
});

test('financed debt integrity: coherent JSON cannot hide a wrong estimated balance decision', () => {
  const f = setup();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    const paymentTrigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='debt_payments_no_update'",
      )
      .get()?.sql;
    const intentTrigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='debt_intents_no_update'",
      )
      .get()?.sql;
    assert.equal(typeof paymentTrigger, 'string');
    assert.equal(typeof intentTrigger, 'string');
    db.exec(
      'DROP TRIGGER debt_payments_no_update; DROP TRIGGER debt_intents_no_update',
    );
    db.exec(
      "UPDATE debt_payment_results SET estimated_balance_after='370000000'",
    );
    const row = db
      .prepare(
        "SELECT result_json FROM debt_intents WHERE intent_key='payment'",
      )
      .get();
    assert.equal(typeof row?.result_json, 'string');
    const result = JSON.parse(row!.result_json as string) as {
      estimatedBalanceAfter: { minor: string };
    };
    result.estimatedBalanceAfter.minor = '370000000';
    db.prepare(
      "UPDATE debt_intents SET result_json=? WHERE intent_key='payment'",
    ).run(JSON.stringify(result));
    db.exec(paymentTrigger as string);
    db.exec(intentTrigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(f.path), {
    code: 'STORAGE_CORRUPT',
  });
});

test('financed debt integrity: noncanonical opening data is rejected without repair', () => {
  const f = setup();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='financed_debts_no_update'",
      )
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('DROP TRIGGER financed_debts_no_update');
    db.exec("UPDATE financed_debts SET annual_effective_rate='-1'");
    db.exec(trigger as string);
  } finally {
    db.close();
  }
  assert.throws(() => new SqliteExpenseStore(f.path), {
    code: 'STORAGE_CORRUPT',
  });
});
