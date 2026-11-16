import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { SalaryService } from '../src/application/salary-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import { DebtPaymentCorrectionsService } from '../src/application/debt-payment-corrections-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import { migration002 } from '../src/infrastructure/migrations/002-expense-corrections.ts';
import { migration003 } from '../src/infrastructure/migrations/003-monthly-budgets.ts';
import { migration004 } from '../src/infrastructure/migrations/004-event-delivery.ts';
import { migration005 } from '../src/infrastructure/migrations/005-financed-debts.ts';
import { migration006 } from '../src/infrastructure/migrations/006-debt-payment-corrections.ts';
import { primaryContext as context } from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'salary-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const clock = () => '2026-11-15T12:00:00.000Z';
const policy = { allows: () => true };
const oldTables = [
  'facts',
  'corrections',
  'budgets',
  'intents',
  'budget_alerts',
  'event_delivery_config',
  'event_delivery_index',
  'event_acknowledgements',
  'financed_debts',
  'debt_payment_results',
  'debt_payment_corrections',
  'debt_intents',
  'debt_payment_actions',
] as const;
const salaryTables = [
  'salary_versions',
  'salary_periods',
  'salary_payments',
  'salary_intents',
  'salary_allocations',
] as const;
function snapshot(db: DatabaseSync) {
  return oldTables.map((table) => ({
    table,
    rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}
const debtInput = {
  description: 'Synthetic phone',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-11-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
};
test('salary migration: v6 expenses, corrections, budgets, delivery, debts and intent bytes survive rollback and v7', () => {
  const seedPath = pathFor(),
    seed = new SqliteExpenseStore(seedPath);
  const expenses = new ExpenseService(seed, policy),
    budgets = new MonthlyBudgetService(seed, policy),
    delivery = new EventDeliveryService(seed, policy, clock);
  const category = expenses.createCategory(context, 'category', {
    name: 'Synthetic fuel',
  });
  budgets.setBudget(context, 'budget', {
    categoryId: category.id,
    month: '2026-11',
    amount: '100',
  });
  const expense = expenses.recordExpense(context, 'expense', {
    categoryId: category.id,
    amount: '80',
    occurredOn: '2026-11-01',
  });
  expenses.recordExpense(context, 'expense2', {
    categoryId: category.id,
    amount: '20',
    occurredOn: '2026-11-02',
  });
  const page = delivery.listPending(context, { limit: 1 });
  assert.ok(page.nextCursor);
  delivery.acknowledge(context, { eventId: page.events[0]!.id });
  const correction = new ExpenseCorrectionsService(
    seed,
    policy,
    clock,
  ).voidExpense(context, 'void', {
    expenseId: expense.id,
    reason: 'Synthetic error',
  });
  const debts = new FinancedDebtService(seed, policy, clock),
    debt = debts.registerDebt(context, 'debt', debtInput);
  const payment = debts.confirmPayment(context, 'debt-payment', {
    debtId: debt.id,
    installmentNumber: 9,
    amount: '250000',
    paidOn: '2026-11-15',
    reference: 'synthetic',
  });
  const debtCorrection = new DebtPaymentCorrectionsService(
    seed,
    policy,
    clock,
  ).replacePayment(context, 'debt-correction', {
    paymentId: payment.id,
    reason: 'Synthetic amount',
    replacement: {
      installmentNumber: 9,
      amount: '200000',
      currency: 'COP',
      paidOn: '2026-11-15',
      reference: 'synthetic corrected',
    },
  });
  seed.close();
  const source = new DatabaseSync(seedPath, { readOnly: true }),
    before = snapshot(source);
  source.close();
  const path = pathFor(),
    old = new DatabaseSync(path);
  old.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  for (const migration of [
    migration001,
    migration002,
    migration003,
    migration004,
    migration005,
    migration006,
  ]) {
    old.exec(migration.sql);
    old
      .prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)')
      .run(
        migration.version,
        createHash('sha256').update(migration.sql).digest('hex'),
      );
  }
  const triggers = [
    'budget_alerts_delivery_index',
    'debt_payment_action_insert',
    'debt_correction_action_insert',
  ].map((name) => {
    const sql = old
      .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
      .get(name)?.sql;
    assert.equal(typeof sql, 'string');
    old.exec(`DROP TRIGGER ${name}`);
    return sql as string;
  });
  for (const { table, rows } of before)
    for (const row of rows) {
      const columns = Object.keys(row);
      old
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    }
  for (const sql of triggers) old.exec(sql);
  old.exec(
    'PRAGMA application_id=1145520467; PRAGMA user_version=6; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  assert.throws(
    () =>
      new SalaryService(readonly, policy).getReceivables(context, {
        asOf: '2026-11-15',
      }),
    { code: 'STORAGE_SCHEMA' },
  );
  readonly.close();
  assert.throws(
    () =>
      new SqliteExpenseStore(path, {
        afterMigration: () => {
          throw new Error('synthetic failure');
        },
      }),
    { code: 'STORAGE_IO' },
  );
  const rolledBack = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    rolledBack.prepare('PRAGMA user_version').get()?.user_version,
    6,
  );
  assert.deepEqual(snapshot(rolledBack), before);
  assert.equal(
    rolledBack
      .prepare("SELECT name FROM sqlite_schema WHERE name='salary_intents'")
      .get(),
    undefined,
  );
  rolledBack.close();
  const migrated = new SqliteExpenseStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 8);
    assert.deepEqual(snapshot(db), before);
    db.close();
    assert.deepEqual(
      new ExpenseCorrectionsService(migrated, policy).findIntent(
        context,
        'void',
      ),
      correction,
    );
    assert.deepEqual(
      new DebtPaymentCorrectionsService(migrated, policy).findIntent(
        context,
        'debt-correction',
      ),
      debtCorrection,
    );
    assert.equal(
      new EventDeliveryService(migrated, policy).listPending(context, {
        limit: 1,
        cursor: page.nextCursor,
      }).events.length,
      1,
    );
    const salaries = new SalaryService(migrated, policy, clock);
    salaries.configureSalary(context, 'salary', {
      netAmount: '3000000',
      effectiveFrom: '2026-10-01',
    });
    salaries.closePeriod(context, 'close', {
      month: '2026-10',
      closedOn: '2026-11-01',
    });
    salaries.receivePayment(context, 'receipt', {
      amount: '800000',
      receivedOn: '2026-11-15',
      reference: 'synthetic',
    });
    const after = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(snapshot(after), before);
    after.close();
  } finally {
    migrated.close();
  }
  const reopened = new SqliteExpenseStore(path);
  assert.equal(
    new SalaryService(reopened, policy).getReceivables(context, {
      asOf: '2026-11-15',
    }).pending.minor,
    220000000n,
  );
  assert.equal(
    new FinancedDebtService(reopened, policy).getDebt(context, debt.id)
      .estimatedBalance.minor,
    380000000n,
  );
  reopened.close();
});

function setupSalary() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path),
    api = new SalaryService(store, policy, clock);
  api.configureSalary(context, 'version', {
    netAmount: '3000000',
    effectiveFrom: '2026-09-01',
  });
  api.closePeriod(context, 'september', {
    month: '2026-09',
    closedOn: '2026-10-01',
  });
  api.closePeriod(context, 'october', {
    month: '2026-10',
    closedOn: '2026-11-01',
  });
  const payment = api.receivePayment(context, 'receipt', {
    amount: '800000',
    receivedOn: '2026-11-15',
    reference: 'synthetic',
  });
  return { path, store, api, payment };
}
test('salary integrity: append-only, reciprocal scoped FKs and cross-domain intention uniqueness', () => {
  const f = setupSalary();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of salaryTables) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET subject_ref='other'`));
    }
    const row = db.prepare('SELECT * FROM salary_payments LIMIT 1').get()!;
    const columns = Object.keys(row);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO salary_payments(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(
          ...(Object.values({
            ...row,
            id: 'orphan',
            intent_key: 'orphan',
          }) as SQLInputValue[]),
        ),
    );
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO salary_allocations(instance_ref,subject_ref,payment_id,period_id,ordinal,amount_minor) VALUES(?,?,?,?,?,?)',
        )
        .run(
          context.instanceRef,
          'foreign',
          f.payment.id,
          'foreign-period',
          0,
          '1',
        ),
    );
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,correction_id,budget_id,fingerprint,result_json) VALUES(?,?,?,NULL,NULL,?,?,?)',
        )
        .run(
          context.instanceRef,
          context.subjectRef,
          'receipt',
          'fake',
          'a'.repeat(64),
          '{}',
        ),
    );
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO debt_intents(instance_ref,subject_ref,intent_key,debt_id,payment_id,correction_id,fingerprint,result_json) VALUES(?,?,?, ?,NULL,NULL,?,?)',
        )
        .run(
          context.instanceRef,
          context.subjectRef,
          'receipt',
          'fake',
          'a'.repeat(64),
          '{}',
        ),
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

for (const mutation of [
  'amount',
  'fifo',
  'missing-allocation',
  'decision',
  'orphan',
] as const) {
  test(`salary integrity: rejects ${mutation} corruption on live read and reopen`, () => {
    const f = setupSalary();
    const db = new DatabaseSync(f.path);
    // Deliberately bypass append-only guards in an isolated synthetic corruption fixture.
    // Restore trigger SQL so failure proves ledger verification rather than schema mismatch.
    const table =
      mutation === 'decision'
        ? 'salary_intents'
        : mutation === 'orphan'
          ? 'salary_payments'
          : 'salary_allocations';
    const operation = mutation === 'missing-allocation' ? 'delete' : 'update';
    const trigger = db
      .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
      .get(`${table}_no_${operation}`)?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`DROP TRIGGER ${table}_no_${operation}`);
    if (mutation === 'amount')
      db.exec("UPDATE salary_allocations SET amount_minor='1'");
    if (mutation === 'fifo')
      db.exec(
        "UPDATE salary_allocations SET period_id=(SELECT id FROM salary_periods WHERE month='2026-10')",
      );
    if (mutation === 'missing-allocation')
      db.exec('DELETE FROM salary_allocations');
    if (mutation === 'decision')
      db.exec(
        "UPDATE salary_intents SET result_json=json_set(result_json,'$.reference','changed') WHERE operation='receive'",
      );
    if (mutation === 'orphan')
      db.exec(
        "INSERT INTO salary_payments SELECT instance_ref,subject_ref,'orphan','orphan',amount_minor,received_on,status FROM salary_payments LIMIT 1",
      );
    db.exec(trigger as string);
    db.close();
    assert.throws(() => f.api.getReceivables(context, { asOf: '2026-11-15' }), {
      code: 'STORAGE_CORRUPT',
    });
    f.store.close();
    assert.throws(() => new SqliteExpenseStore(f.path), {
      code: 'STORAGE_CORRUPT',
    });
  });
}

test('salary: busy and storage limits are explicit and leave no partial salary state', () => {
  const f = setupSalary(),
    blocker = new DatabaseSync(f.path);
  const second = new SqliteExpenseStore(f.path, { busyTimeoutMs: 0 }),
    api = new SalaryService(second, policy, clock);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(
      () =>
        api.receivePayment(context, 'blocked', {
          amount: '1',
          receivedOn: '2026-11-15',
          reference: 'synthetic',
        }),
      { code: 'STORAGE_BUSY' },
    );
    blocker.exec('ROLLBACK');
    assert.equal(api.findIntent(context, 'blocked'), undefined);
    assert.throws(
      () =>
        api.configureSalary(context, 'oversized', {
          netAmount: '1'.repeat(4097),
          effectiveFrom: '2027-01-01',
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(api.findIntent(context, 'oversized'), undefined);
    assert.equal(
      api.receivePayment(context, 'blocked', {
        amount: '1',
        receivedOn: '2026-11-15',
        reference: 'synthetic',
      }).status,
      'confirmed',
    );
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    second.close();
    f.store.close();
  }
});
