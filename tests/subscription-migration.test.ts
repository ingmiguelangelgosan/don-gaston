import { SubscriptionService } from '../src/application/subscription-service.ts';
import { migration009 } from '../src/infrastructure/migrations/009-personal-loans.ts';
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

const root = join(process.cwd(), '.cache', 'subscription-migration-tests');
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
    'loan_counterparties',
    'loan_movements',
    'loan_intents',
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
test('subscriptions migration: complete v9 history survives rollback and additive v10', () => {
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
  const seedLoans = new PersonalLoanService(seed, policy, clock);
  const party = seedLoans.createCounterparty(context, 'person', {
    name: 'Synthetic person',
  });
  seedLoans.recordDisbursement(context, 'loan', {
    counterpartyId: party.id,
    direction: 'payable',
    amount: '80000',
    occurredOn: '2026-11-15',
    reference: 'synthetic',
  });
  const loanPayment = seedLoans.recordRepayment(context, 'repayment', {
    counterpartyId: party.id,
    direction: 'payable',
    amount: '30000',
    occurredOn: '2026-11-16',
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
    migration008,
    migration009,
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
    'PRAGMA application_id=1145520467; PRAGMA user_version=9; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  assert.throws(
    () =>
      new SubscriptionService(readonly, policy).listObligations(context, {
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
    9,
  );
  assert.deepEqual(snapshot(rolledBack), before);
  assert.equal(
    rolledBack
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='subscription_intents'",
      )
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
    assert.deepEqual(
      new PersonalLoanService(migrated, policy).findIntent(
        context,
        'repayment',
      ),
      loanPayment,
    );
    const subscriptions = new SubscriptionService(migrated, policy, clock);
    const subscription = subscriptions.createSubscription(
      context,
      'subscription',
      {
        name: 'Synthetic sharing',
        categoryId: category.id,
        mode: 'shared',
        monthlyAmount: '30000',
        effectiveMonth: '2026-11',
        includesHolder: true,
        counterpartyIds: [party.id],
      },
    );
    subscriptions.generateObligation(context, 'subscription-month', {
      subscriptionId: subscription.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
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

function subscriptionFixture() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path),
    api = new SubscriptionService(store, policy, clock);
  const category = new ExpenseService(store, policy).createCategory(
    context,
    'category',
    { name: 'Synthetic subscription' },
  );
  const person = new PersonalLoanService(
    store,
    policy,
    clock,
  ).createCounterparty(context, 'person', { name: 'Synthetic participant' });
  const input = {
    name: 'Synthetic shared',
    categoryId: category.id,
    mode: 'shared' as const,
    monthlyAmount: '30000',
    effectiveMonth: '2026-11',
    includesHolder: true,
    counterpartyIds: [person.id],
  };
  const subscription = api.createSubscription(context, 'create', input);
  const obligation = api.generateObligation(context, 'generate', {
    subscriptionId: subscription.id,
    month: '2026-11',
    generatedOn: '2026-11-01',
  });
  const payment = api.confirmPayment(context, 'pay', {
    obligationId: obligation.id,
    amount: '30000',
    paidOn: '2026-11-05',
    reference: 'synthetic',
  });
  const reimbursement = api.receiveReimbursement(context, 'receive', {
    counterpartyId: person.id,
    amount: '10000',
    receivedOn: '2026-11-06',
    reference: 'synthetic',
  });
  return {
    path,
    store,
    api,
    person,
    input,
    subscription,
    obligation,
    payment,
    reimbursement,
  };
}
test('subscriptions integrity: SQL enforces immutable scoped links, unique payments and shared intent namespace', () => {
  const f = subscriptionFixture();
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of [
      'subscription_records',
      'subscription_intents',
      'subscription_participants',
      'subscription_shares',
      'subscription_allocations',
    ]) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`UPDATE ${table} SET subject_ref='foreign'`));
    }
    const payment = db
      .prepare('SELECT * FROM subscription_records WHERE id=?')
      .get(f.payment.id)!;
    const insertRecord = (overrides: Record<string, unknown>) => {
      const row = {
        ...payment,
        id: 'another',
        intent_key: 'another',
        expense_id: null,
        expense_intent_key: null,
        own_minor: '0',
        ...overrides,
      };
      db.prepare(
        `INSERT INTO subscription_records(${Object.keys(row).join(',')}) VALUES(${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')})`,
      ).run(...(Object.values(row) as SQLInputValue[]));
    };
    assert.throws(() => insertRecord({})); // one effective payment per obligation
    assert.throws(() => insertRecord({ subject_ref: 'foreign' }));
    assert.throws(() =>
      insertRecord({ status: 'review_required', own_minor: '1' }),
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO subscription_shares VALUES(?,?,?,?,?)')
        .run(context.instanceRef, 'foreign', f.payment.id, f.person.id, '1'),
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO subscription_allocations VALUES(?,?,?,?,?,?)')
        .run(
          context.instanceRef,
          context.subjectRef,
          f.reimbursement.id,
          'missing',
          f.person.id,
          '1',
        ),
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO subscription_participants VALUES(?,?,?,?)')
        .run(
          context.instanceRef,
          context.subjectRef,
          f.payment.id,
          f.person.id,
        ),
    );
    for (const table of [
      'intents',
      'debt_intents',
      'salary_intents',
      'bill_intents',
      'loan_intents',
    ]) {
      assert.ok(
        db
          .prepare('SELECT 1 FROM sqlite_schema WHERE name=?')
          .get(`${table}_subscription_key`),
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO ${table}(instance_ref,subject_ref,intent_key) VALUES(?,?,?)`,
            )
            .run(context.instanceRef, context.subjectRef, 'pay'),
        /intent_key_conflict/,
      );
    }
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO subscription_intents(instance_ref,subject_ref,intent_key) VALUES(?,?,?)',
          )
          .run(context.instanceRef, context.subjectRef, 'person'),
      /intent_key_conflict/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO corrections(instance_ref,subject_ref,original_expense_id) VALUES(?,?,?)',
          )
          .run(context.instanceRef, context.subjectRef, f.payment.id),
      /subscription_payment_correction_required/,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

for (const mutation of [
  'amount',
  'shares',
  'allocation',
  'participants',
  'result',
  'version',
  'expense',
  'orphan',
] as const) {
  test(`subscriptions integrity: ${mutation} corruption is rejected by live reads and reopening`, () => {
    const f = subscriptionFixture(),
      db = new DatabaseSync(f.path);
    const table =
      mutation === 'shares'
        ? 'subscription_shares'
        : mutation === 'allocation'
          ? 'subscription_allocations'
          : mutation === 'participants'
            ? 'subscription_participants'
            : mutation === 'result'
              ? 'subscription_intents'
              : mutation === 'expense'
                ? 'facts'
                : 'subscription_records';
    const name = `${table}_no_update`;
    // Existing facts use a different immutable-trigger name.
    const trigger = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'",
      )
      .get(table)!;
    assert.ok(trigger, name);
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`DROP TRIGGER ${String(trigger.name)}`);
    if (mutation === 'amount')
      db.prepare(
        "UPDATE subscription_records SET amount_minor='1' WHERE id=?",
      ).run(f.payment.id);
    if (mutation === 'shares')
      db.prepare(
        "UPDATE subscription_shares SET amount_minor='1' WHERE payment_id=?",
      ).run(f.payment.id);
    if (mutation === 'allocation')
      db.prepare(
        "UPDATE subscription_allocations SET amount_minor='1' WHERE reimbursement_id=?",
      ).run(f.reimbursement.id);
    if (mutation === 'participants')
      db.prepare(
        "UPDATE subscription_participants SET counterparty_id='foreign' WHERE record_id=?",
      ).run(f.obligation.id);
    if (mutation === 'result')
      db.prepare(
        "UPDATE subscription_intents SET result_json=json_set(result_json,'$.ownAmount.minor','1') WHERE record_id=?",
      ).run(f.payment.id);
    if (mutation === 'version')
      db.prepare(
        "UPDATE subscription_records SET version_id='missing' WHERE id=?",
      ).run(f.obligation.id);
    if (mutation === 'expense')
      db.prepare("UPDATE facts SET amount_minor='1' WHERE id=?").run(
        f.payment.id,
      );
    if (mutation === 'orphan') {
      const row = {
        ...db
          .prepare('SELECT * FROM subscription_records WHERE id=?')
          .get(f.subscription.id)!,
        id: 'orphan',
        intent_key: 'orphan',
      };
      db.prepare(
        `INSERT INTO subscription_records(${Object.keys(row).join(',')}) VALUES(${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')})`,
      ).run(...(Object.values(row) as SQLInputValue[]));
    }
    db.exec(String(trigger.sql));
    db.close();
    assert.throws(
      () => f.api.listObligations(context, { asOf: '2026-11-30' }),
      { code: 'STORAGE_CORRUPT' },
    );
    f.store.close();
    assert.throws(() => new SqliteExpenseStore(f.path), {
      code: 'STORAGE_CORRUPT',
    });
  });
}
test('subscriptions: busy, limits, readonly and closed errors do not leave partial intents', () => {
  const f = subscriptionFixture(),
    blocker = new DatabaseSync(f.path),
    second = new SqliteExpenseStore(f.path, { busyTimeoutMs: 0 }),
    api = new SubscriptionService(second, policy, clock);
  const input = {
    counterpartyId: f.person.id,
    amount: '1',
    receivedOn: '2026-11-07',
    reference: 'synthetic',
  };
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.throws(() => api.receiveReimbursement(context, 'busy', input), {
      code: 'STORAGE_BUSY',
    });
    blocker.exec('ROLLBACK');
    assert.equal(api.findIntent(context, 'busy'), undefined);
    assert.throws(
      () =>
        api.createSubscription(context, 'large', {
          ...f.input,
          monthlyAmount: '1'.repeat(4097),
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(api.findIntent(context, 'large'), undefined);
    const receipt = api.receiveReimbursement(context, 'busy', input);
    const readonly = new SqliteExpenseStore(f.path, { readOnly: true }),
      read = new SubscriptionService(readonly, policy, clock);
    assert.equal(read.findIntent(context, 'busy')?.id, receipt.id);
    assert.throws(() => read.receiveReimbursement(context, 'busy', input), {
      code: 'STORAGE_READ_ONLY',
    });
    readonly.close();
    assert.throws(() => read.listObligations(context, { asOf: '2026-11-30' }), {
      code: 'STORAGE_CLOSED',
    });
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    second.close();
    f.store.close();
  }
});
