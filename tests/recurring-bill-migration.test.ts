import { RecurringBillService } from '../src/application/recurring-bill-service.ts';
import { migration007 } from '../src/infrastructure/migrations/007-salary-receivables.ts';
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

const root = join(process.cwd(), '.cache', 'recurring-bill-migration-tests');
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
  return [...oldTables, ...salaryTables].map((table) => ({
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
test('bills migration: v7 financial history and salaries survive rollback and additive v8', () => {
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
  const salaryApi = new SalaryService(seed, policy, clock);
  salaryApi.configureSalary(context, 'salary', {
    netAmount: '3000000',
    effectiveFrom: '2026-10-01',
  });
  salaryApi.closePeriod(context, 'salary-close', {
    month: '2026-10',
    closedOn: '2026-11-01',
  });
  const salaryReceipt = salaryApi.receivePayment(context, 'salary-receipt', {
    amount: '800000',
    receivedOn: '2026-11-15',
    reference: 'synthetic',
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
    migration007,
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
    'PRAGMA application_id=1145520467; PRAGMA user_version=7; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  assert.throws(
    () =>
      new RecurringBillService(readonly, policy).listObligations(context, {
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
    7,
  );
  assert.deepEqual(snapshot(rolledBack), before);
  assert.equal(
    rolledBack
      .prepare("SELECT name FROM sqlite_schema WHERE name='bill_intents'")
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
    assert.deepEqual(
      new SalaryService(migrated, policy).findIntent(context, 'salary-receipt'),
      salaryReceipt,
    );
    const bills = new RecurringBillService(migrated, policy, clock);
    const concept = bills.createConcept(context, 'internet', {
      description: 'Synthetic internet',
      categoryId: category.id,
    });
    const obligation = bills.generateObligation(context, 'bill-november', {
      conceptId: concept.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
      amount: '98000',
      amountStatus: 'confirmed',
    });
    const after = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(snapshot(after), before);
    after.close();
    bills.confirmPayment(context, 'bill-payment', {
      obligationId: obligation.id,
      expectedRevisionId: obligation.id,
      amount: '98000',
      paidOn: '2026-11-15',
      reference: 'synthetic',
    });
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
  assert.equal(
    new RecurringBillService(reopened, policy).monthlyCashOutflow(context, {
      month: '2026-11',
    }).total.minor,
    9800000n,
  );
  reopened.close();
});

function setupBill() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path),
    bills = new RecurringBillService(store, policy, clock);
  const expenses = new ExpenseService(store, policy);
  const category = expenses.createCategory(context, 'category', {
    name: 'Synthetic internet',
  });
  const concept = bills.createConcept(context, 'internet', {
    description: 'Synthetic internet',
    categoryId: category.id,
  });
  const obligation = bills.generateObligation(context, 'october', {
    conceptId: concept.id,
    month: '2026-10',
    generatedOn: '2026-10-01',
    amount: '95000',
    amountStatus: 'confirmed',
  });
  const payment = bills.confirmPayment(context, 'paid', {
    obligationId: obligation.id,
    expectedRevisionId: obligation.id,
    amount: '95000',
    paidOn: '2026-10-15',
    reference: 'synthetic',
  });
  const next = bills.generateObligation(context, 'november', {
    conceptId: concept.id,
    month: '2026-11',
    generatedOn: '2026-11-01',
  });
  const revision = bills.adjustObligation(context, 'actual', {
    obligationId: next.id,
    expectedRevisionId: next.id,
    amount: '98000',
    amountStatus: 'confirmed',
    reason: 'Synthetic actual invoice',
  });
  return {
    path,
    store,
    bills,
    expenses,
    category,
    concept,
    obligation,
    payment,
    next,
    revision,
  };
}
const billTables = [
  'bill_concepts',
  'bill_obligations',
  'bill_adjustments',
  'bill_payments',
  'bill_intents',
] as const;
test('bills integrity: immutable records, scoped links, current revision and expense correction guards enforced by SQL', () => {
  const f = setupBill();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of billTables) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET subject_ref='foreign'`));
    }
    const original = db.prepare('SELECT * FROM bill_payments LIMIT 1').get()!;
    const insert = (row: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO bill_payments(${Object.keys(row).join(',')}) VALUES(${Object.keys(
            row,
          )
            .map(() => '?')
            .join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    assert.throws(() =>
      insert({
        ...original,
        id: 'orphan',
        intent_key: 'orphan',
        expense_intent_key: 'orphan',
        obligation_id: f.next.id,
        revision_id: f.next.id,
      }),
    );
    assert.throws(() =>
      insert({
        ...original,
        id: 'orphan',
        intent_key: 'orphan',
        expense_intent_key: 'orphan',
        obligation_id: f.next.id,
        revision_id: f.revision.id,
      }),
    );
    assert.throws(() =>
      insert({
        ...original,
        id: 'foreign',
        intent_key: 'foreign',
        expense_intent_key: 'foreign',
        subject_ref: 'foreign',
      }),
    );
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO corrections(instance_ref,subject_ref,id,intent_key,original_expense_id,replacement_expense_id,replacement_kind,replacement_json,replacement_fingerprint,reason,recorded_at,actor_ref) VALUES(?,?,?, ?,?,NULL,NULL,NULL,NULL,?,?,?)`,
        )
        .run(
          context.instanceRef,
          context.subjectRef,
          'bad-correction',
          'bad-correction',
          f.payment.id,
          'synthetic',
          clock(),
          context.actorRef,
        ),
    );
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?, ?,?,?)',
        )
        .run(
          context.instanceRef,
          context.subjectRef,
          'actual',
          'missing',
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
  'estimate',
  'result',
  'revision',
  'expense',
  'orphan',
] as const) {
  test(`bills integrity: rejects ${mutation} corruption in live read and reopening`, () => {
    const f = setupBill(),
      db = new DatabaseSync(f.path);
    const table =
      mutation === 'estimate'
        ? 'bill_obligations'
        : mutation === 'result'
          ? 'bill_intents'
          : mutation === 'revision'
            ? 'bill_adjustments'
            : mutation === 'expense'
              ? 'facts'
              : 'bill_payments';
    const trigger = db
      .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
      .get(`${table}_no_update`)?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`DROP TRIGGER ${table}_no_update`);
    if (mutation === 'estimate')
      db.prepare(
        'UPDATE bill_obligations SET source_payment_id=NULL WHERE id=?',
      ).run(f.next.id);
    if (mutation === 'result')
      db.exec(
        "UPDATE bill_intents SET result_json=json_set(result_json,'$.description','changed') WHERE operation='concept'",
      );
    if (mutation === 'revision')
      db.exec("UPDATE bill_adjustments SET amount_minor='1'");
    if (mutation === 'expense')
      db.prepare("UPDATE facts SET amount_minor='1' WHERE id=?").run(
        f.payment.id,
      );
    if (mutation === 'orphan')
      db.prepare(
        `INSERT INTO bill_payments(instance_ref,subject_ref,id,intent_key,obligation_id,revision_id,expense_intent_key,paid_on) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        context.instanceRef,
        context.subjectRef,
        'orphan',
        'orphan',
        f.next.id,
        f.revision.id,
        'orphan',
        '2026-11-15',
      );
    db.exec(trigger as string);
    db.close();
    assert.throws(
      () => f.bills.listObligations(context, { asOf: '2026-11-15' }),
      { code: 'STORAGE_CORRUPT' },
    );
    f.store.close();
    assert.throws(() => new SqliteExpenseStore(f.path), {
      code: 'STORAGE_CORRUPT',
    });
  });
}
test('bills: explicit busy, size, read-only and closed errors preserve state and stable retry key', () => {
  const f = setupBill(),
    blocker = new DatabaseSync(f.path),
    second = new SqliteExpenseStore(f.path, { busyTimeoutMs: 0 }),
    api = new RecurringBillService(second, policy, clock);
  const input = {
    obligationId: f.next.id,
    expectedRevisionId: f.revision.id,
    amount: '98000',
    paidOn: '2026-11-15',
    reference: 'synthetic',
  };
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(() => api.confirmPayment(context, 'pay', input), {
      code: 'STORAGE_BUSY',
    });
    blocker.exec('ROLLBACK');
    assert.equal(api.findIntent(context, 'pay'), undefined);
    assert.throws(
      () =>
        api.adjustObligation(context, 'large', {
          obligationId: f.next.id,
          expectedRevisionId: f.revision.id,
          amount: '1'.repeat(4097),
          amountStatus: 'confirmed',
          reason: 'synthetic',
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(api.findIntent(context, 'large'), undefined);
    const paid = api.confirmPayment(context, 'pay', input);
    const readonly = new SqliteExpenseStore(f.path, { readOnly: true }),
      read = new RecurringBillService(readonly, policy, clock);
    assert.equal(read.findIntent(context, 'pay')?.id, paid.id);
    assert.throws(() => read.confirmPayment(context, 'pay', input), {
      code: 'STORAGE_READ_ONLY',
    });
    readonly.close();
    assert.throws(() => read.listObligations(context, { asOf: '2026-11-15' }), {
      code: 'STORAGE_CLOSED',
    });
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    second.close();
    f.store.close();
  }
});
