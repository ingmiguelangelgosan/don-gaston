import { PersonalLoanService } from '../src/application/personal-loan-service.ts';
import { migration008 } from '../src/infrastructure/migrations/008-recurring-bills.ts';
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

const root = join(process.cwd(), '.cache', 'personal-loan-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const clock = () => '2026-11-16T12:00:00.000Z';
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
  return [
    ...oldTables,
    ...salaryTables,
    'bill_concepts',
    'bill_obligations',
    'bill_adjustments',
    'bill_payments',
    'bill_intents',
  ].map((table) => ({
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
test('loans migration: v8 complete history, salary and bill links survive rollback and additive v9', () => {
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
  const seedBills = new RecurringBillService(seed, policy, clock);
  const concept = seedBills.createConcept(context, 'internet', {
    description: 'Synthetic internet',
    categoryId: category.id,
  });
  const bill = seedBills.generateObligation(context, 'bill', {
    conceptId: concept.id,
    month: '2026-11',
    generatedOn: '2026-11-01',
    amount: '97000',
    amountStatus: 'estimated',
  });
  const billRevision = seedBills.adjustObligation(context, 'bill-actual', {
    obligationId: bill.id,
    expectedRevisionId: bill.id,
    amount: '98000',
    amountStatus: 'confirmed',
    reason: 'Synthetic actual',
  });
  const billPayment = seedBills.confirmPayment(context, 'bill-payment', {
    obligationId: bill.id,
    expectedRevisionId: billRevision.id,
    amount: '98000',
    paidOn: '2026-11-15',
    reference: 'synthetic',
  });
  seedBills.generateObligation(context, 'bill-december', {
    conceptId: concept.id,
    month: '2026-12',
    generatedOn: '2026-12-01',
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
    migration008,
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
    'PRAGMA application_id=1145520467; PRAGMA user_version=8; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  assert.throws(
    () =>
      new PersonalLoanService(readonly, policy).listPositions(context, {
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
    8,
  );
  assert.deepEqual(snapshot(rolledBack), before);
  assert.equal(
    rolledBack
      .prepare("SELECT name FROM sqlite_schema WHERE name='loan_intents'")
      .get(),
    undefined,
  );
  rolledBack.close();
  const migrated = new SqliteExpenseStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 10);
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
    assert.deepEqual(
      new RecurringBillService(migrated, policy).findIntent(
        context,
        'bill-payment',
      ),
      billPayment,
    );
    const loans = new PersonalLoanService(migrated, policy, clock);
    const party = loans.createCounterparty(context, 'person', {
      name: 'Synthetic counterpart',
    });
    loans.recordDisbursement(context, 'loan', {
      counterpartyId: party.id,
      direction: 'payable',
      amount: '80000',
      occurredOn: '2026-11-15',
      reference: 'synthetic',
    });
    loans.recordRepayment(context, 'repayment', {
      counterpartyId: party.id,
      direction: 'payable',
      amount: '30000',
      occurredOn: '2026-11-16',
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
  assert.equal(
    new RecurringBillService(reopened, policy).monthlyCashOutflow(context, {
      month: '2026-11',
    }).total.minor,
    9800000n,
  );
  assert.equal(
    new PersonalLoanService(reopened, policy).listPositions(context, {
      asOf: '2026-11-16',
    }).totalPayable.minor,
    5000000n,
  );
  reopened.close();
});

function setupLoan() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path),
    loans = new PersonalLoanService(store, policy, clock);
  const party = loans.createCounterparty(context, 'party', {
    name: 'Synthetic person',
  });
  const input = {
    counterpartyId: party.id,
    direction: 'receivable' as const,
    amount: '200000',
    occurredOn: '2026-11-15',
    reference: 'synthetic',
  };
  const disbursement = loans.recordDisbursement(context, 'lend', input);
  const repayment = loans.recordRepayment(context, 'returned', {
    ...input,
    amount: '70000',
  });
  const review = loans.recordRepayment(context, 'review', {
    ...input,
    amount: '200000',
  });
  return { path, store, loans, party, input, disbursement, repayment, review };
}
test('loans integrity: SQL enforces append-only, scoped reciprocal references, cash directions and global keys', () => {
  const f = setupLoan();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of [
      'loan_counterparties',
      'loan_movements',
      'loan_intents',
    ]) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET subject_ref='foreign'`));
    }
    const row = db
      .prepare('SELECT * FROM loan_movements WHERE id=?')
      .get(f.disbursement.id)!;
    const insert = (overrides: Record<string, unknown>) => {
      const changed = { ...row, id: 'new', intent_key: 'new', ...overrides };
      return db
        .prepare(
          `INSERT INTO loan_movements(${Object.keys(changed).join(',')}) VALUES(${Object.keys(
            changed,
          )
            .map(() => '?')
            .join(',')})`,
        )
        .run(...(Object.values(changed) as SQLInputValue[]));
    };
    assert.throws(() => insert({ cash_direction: 'inflow' }));
    assert.throws(() => insert({ subject_ref: 'foreign' }));
    assert.throws(() => insert({}));
    assert.throws(() =>
      insert({
        status: 'review_required',
        movement_type: 'repayment',
        review_reason: 'EXCEEDS_PENDING_BALANCE',
        cash_direction: 'inflow',
      }),
    );
    for (const table of [
      'intents',
      'debt_intents',
      'salary_intents',
      'bill_intents',
    ]) {
      // Malformed other-domain inserts also hit the namespace guard before FK checks.
      const intentKey = db
        .prepare('SELECT intent_key FROM loan_intents LIMIT 1')
        .get()!.intent_key;
      const trigger = db
        .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
        .get(`${table}_loan_key`);
      assert.ok(trigger);
      if (table === 'intents')
        assert.throws(() =>
          db
            .prepare(
              'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)',
            )
            .run(
              context.instanceRef,
              context.subjectRef,
              intentKey as string,
              'missing',
              'a'.repeat(64),
              '{}',
            ),
        );
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
for (const mutation of [
  'amount',
  'review',
  'counterparty',
  'chronology',
  'orphan',
] as const) {
  test(`loans integrity: rejects ${mutation} corruption in live query and reopening`, () => {
    const f = setupLoan(),
      db = new DatabaseSync(f.path);
    const table = mutation === 'review' ? 'loan_intents' : 'loan_movements';
    const trigger = db
      .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
      .get(`${table}_no_update`)?.sql;
    assert.equal(typeof trigger, 'string');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`DROP TRIGGER ${table}_no_update`);
    if (mutation === 'amount')
      db.prepare("UPDATE loan_movements SET amount_minor='1' WHERE id=?").run(
        f.repayment.id,
      );
    if (mutation === 'review')
      db.prepare(
        "UPDATE loan_intents SET result_json=json_set(result_json,'$.principalBalanceAfter.minor','1') WHERE movement_id=?",
      ).run(f.review.id);
    if (mutation === 'counterparty')
      db.prepare(
        "UPDATE loan_movements SET counterparty_id='foreign' WHERE id=?",
      ).run(f.repayment.id);
    if (mutation === 'chronology')
      db.prepare(
        "UPDATE loan_movements SET occurred_on='2026-11-01' WHERE id=?",
      ).run(f.repayment.id);
    if (mutation === 'orphan')
      db.exec(
        "INSERT INTO loan_movements SELECT instance_ref,subject_ref,'orphan','orphan',counterparty_id,direction,movement_type,amount_minor,currency,occurred_on,status,review_reason,cash_direction FROM loan_movements LIMIT 1",
      );
    db.exec(trigger as string);
    db.close();
    assert.throws(
      () => f.loans.listPositions(context, { asOf: '2026-11-16' }),
      { code: 'STORAGE_CORRUPT' },
    );
    f.store.close();
    assert.throws(() => new SqliteExpenseStore(f.path), {
      code: 'STORAGE_CORRUPT',
    });
  });
}
test('loans: busy, monetary limits, read-only and closed errors leave no partial intent', () => {
  const f = setupLoan(),
    blocker = new DatabaseSync(f.path),
    second = new SqliteExpenseStore(f.path, { busyTimeoutMs: 0 }),
    api = new PersonalLoanService(second, policy, clock);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => api.recordRepayment(context, 'busy', { ...f.input, amount: '1' }),
      { code: 'STORAGE_BUSY' },
    );
    blocker.exec('ROLLBACK');
    assert.equal(api.findIntent(context, 'busy'), undefined);
    assert.throws(
      () =>
        api.recordDisbursement(context, 'large', {
          ...f.input,
          amount: '1'.repeat(4097),
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(api.findIntent(context, 'large'), undefined);
    const receipt = api.recordRepayment(context, 'busy', {
      ...f.input,
      amount: '1',
    });
    const readonly = new SqliteExpenseStore(f.path, { readOnly: true }),
      read = new PersonalLoanService(readonly, policy, clock);
    assert.equal(read.findIntent(context, 'busy')?.id, receipt.id);
    assert.throws(
      () => read.recordRepayment(context, 'busy', { ...f.input, amount: '1' }),
      { code: 'STORAGE_READ_ONLY' },
    );
    readonly.close();
    assert.throws(() => read.listPositions(context, { asOf: '2026-11-16' }), {
      code: 'STORAGE_CLOSED',
    });
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    second.close();
    f.store.close();
  }
});
