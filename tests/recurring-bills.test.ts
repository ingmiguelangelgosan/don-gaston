import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecurringBillService } from '../src/application/recurring-bill-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { Money } from '../src/domain/money.ts';
import {
  decideBillCommand,
  buildBillList,
} from '../src/domain/recurring-bills.ts';
import type {
  BillConcept,
  BillPayment,
  BillObligation,
} from '../src/domain/recurring-bills.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'recurring-bill-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `bill-${++sequence}.sqlite`);
const clock = () => '2026-11-16T12:00:00.000Z';
const encoded = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

test('bills unit: estimation selects latest eligible payment date and registration tie, without mutating inputs', () => {
  const concept: BillConcept = {
    kind: 'bill-concept',
    id: 'synthetic-concept',
    description: 'Synthetic internet',
    categoryId: 'synthetic-category',
    currency: 'COP',
    fixedAmount: null,
    dueDay: null,
    dueMonthOffset: null,
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
  const makePayment = (
    id: string,
    paidOn: string,
    amount: string,
  ): BillPayment => ({
    kind: 'bill-payment',
    id,
    expenseId: id,
    obligationId: `obligation-${id}`,
    revisionId: `obligation-${id}`,
    conceptId: concept.id,
    categoryId: concept.categoryId,
    month: '2026-10',
    amount: Money.fromDecimal(amount),
    paidOn,
    reference: 'synthetic-unit',
    actorRef: context.actorRef,
    recordedAt: clock(),
  });
  const payments = [
    makePayment('latest-date', '2026-11-10', '95000'),
    makePayment('backdated', '2026-11-01', '98000'),
    makePayment('same-date', '2026-11-10', '96000'),
    makePayment('future', '2026-12-01', '100000'),
  ];
  const state = {
    concepts: [concept],
    obligations: [],
    adjustments: [],
    payments,
  };
  const before = encoded(state);
  const result = decideBillCommand(
    state,
    {
      operation: 'generate',
      draft: {
        conceptId: concept.id,
        month: '2026-12',
        generatedOn: '2026-11-16',
        amount: null,
        amountStatus: null,
        dueOn: null,
        overrideDueOn: false,
        actorRef: context.actorRef,
        recordedAt: clock(),
      },
    },
    'new-period',
  );
  assert.equal(result.kind, 'bill-obligation');
  if (result.kind !== 'bill-obligation') assert.fail('Expected obligation');
  assert.equal(result.sourcePaymentId, 'same-date');
  assert.equal(result.amount?.minor, 9600000n);
  assert.equal(result.amountStatus, 'estimated');
  assert.deepEqual(encoded(state), before);
  assert.equal(Object.isFrozen(result), true);
});

test('bills unit: obligations with known, estimated and unknown amounts aggregate separately and exactly', () => {
  const makeObligation = (
    id: string,
    amount: Money | null,
    amountStatus: BillObligation['amountStatus'],
  ): BillObligation => ({
    kind: 'bill-obligation',
    id,
    conceptId: 'synthetic-concept',
    categoryId: 'synthetic-category',
    currency: 'COP',
    month: '2026-11',
    generatedOn: '2026-11-01',
    amount,
    amountStatus,
    amountSource: amount === null ? 'unknown' : 'explicit',
    sourcePaymentId: null,
    dueOn: '2026-11-05',
    actorRef: context.actorRef,
    recordedAt: clock(),
  });
  const value = Money.fromDecimal('9223372036854775808.17');
  const obligations = [
    makeObligation('confirmed', value, 'confirmed'),
    makeObligation('estimated', Money.fromDecimal('0.01'), 'estimated'),
    makeObligation('unknown', null, 'unknown'),
  ];
  const list = buildBillList(
    { concepts: [], obligations, adjustments: [], payments: [] },
    { asOf: '2026-11-06' },
  );
  assert.equal(list.confirmedPending.minor, 922337203685477580817n);
  assert.equal(list.confirmedOverdue.minor, 922337203685477580817n);
  assert.equal(list.estimatedPending.minor, 1n);
  assert.equal(list.estimatedOverdue.minor, 1n);
  assert.equal(list.unknownPendingCount, 1);
  assert.equal(list.unknownOverdueCount, 1);
  assert.equal(list.obligations.length, 3);
});

test('bills unit: successful payment reuses its expense identity and preserves the factured period', () => {
  const obligation: BillObligation = {
    kind: 'bill-obligation',
    id: 'november',
    conceptId: 'internet',
    categoryId: 'services',
    currency: 'COP',
    month: '2026-11',
    generatedOn: '2026-11-01',
    amount: Money.fromDecimal('95000'),
    amountStatus: 'confirmed',
    amountSource: 'explicit',
    sourcePaymentId: null,
    dueOn: null,
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
  const result = decideBillCommand(
    { concepts: [], obligations: [obligation], adjustments: [], payments: [] },
    {
      operation: 'pay',
      draft: {
        obligationId: obligation.id,
        expectedRevisionId: obligation.id,
        amount: Money.fromDecimal('95000'),
        paidOn: '2026-12-03',
        reference: 'synthetic-paid',
        actorRef: context.actorRef,
        recordedAt: clock(),
      },
    },
    'one-financial-fact',
  );
  assert.equal(result.kind, 'bill-payment');
  if (result.kind !== 'bill-payment') assert.fail('Expected payment');
  assert.equal(result.id, result.expenseId);
  assert.equal(result.month, '2026-11');
  assert.equal(result.paidOn, '2026-12-03');
  assert.equal(result.amount.minor, 9500000n);
});
function services(store: SqliteExpenseStore, policy: AccessPolicy) {
  return {
    bills: new RecurringBillService(store, policy, clock),
    expenses: new ExpenseService(store, policy),
    corrections: new ExpenseCorrectionsService(store, policy, clock),
    budgets: new MonthlyBudgetService(store, policy),
    delivery: new EventDeliveryService(store, policy, clock),
  };
}
function setup() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path);
  const actions = new Set<Action>([
    'bill:write',
    'bill:pay',
    'bill:read',
    'category:create',
    'expense:record',
    'expense:read',
    'expense:correct',
    'budget:write',
    'budget:read',
    'event:read',
  ]);
  const allowed = [
    context,
    otherSubjectContext,
    otherInstanceContext,
    otherActorContext,
  ];
  const policy: AccessPolicy = {
    allows: (candidate, action) =>
      actions.has(action) &&
      allowed.some(
        (bound) =>
          bound.actorRef === candidate.actorRef &&
          bound.instanceRef === candidate.instanceRef &&
          bound.subjectRef === candidate.subjectRef,
      ),
  };
  const api = services(store, policy);
  const category = api.expenses.createCategory(context, 'category', {
    name: 'Synthetic services',
  });
  const concept = api.bills.createConcept(context, 'internet', {
    description: 'Synthetic internet',
    categoryId: category.id,
  });
  return { path, store, actions, policy, ...api, category, concept };
}
type Fixture = ReturnType<typeof setup>;
function obligation(
  f: Fixture,
  key = 'november',
  amount = '98000',
  month = '2026-11',
) {
  return f.bills.generateObligation(context, key, {
    conceptId: f.concept.id,
    month,
    generatedOn: `${month}-01`,
    amount,
    amountStatus: 'confirmed',
  });
}
function paymentInput(id: string, amount = '98000', paidOn = '2026-11-16') {
  return {
    obligationId: id,
    expectedRevisionId: id,
    amount,
    paidOn,
    reference: 'synthetic-confirmed-bill',
  };
}
interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; kind: string };
  code?: string;
}
async function race(
  path: string,
  jobs: readonly {
    key: string;
    operation: 'pay' | 'adjust' | 'generate';
    input: object;
  }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/bill-worker.ts', import.meta.url),
      [path, job.key, job.operation, JSON.stringify(job.input)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let doneResolve!: (reply: Reply) => void,
      doneReject!: (error: Error) => void;
    const done = new Promise<Reply>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    let reply: Reply | undefined;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('Synthetic bill worker timed out');
      readyReject(error);
      doneReject(error);
    }, 15000);
    child.on('message', (message: Reply) => {
      if (message.type !== 'ready') reply = message;
      readyResolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      readyReject(error);
      doneReject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (reply) {
        readyResolve();
        doneResolve(reply);
      } else {
        const error = new Error(`Bill worker exited without result (${code})`);
        readyReject(error);
        doneReject(error);
      }
    });
    return { child, ready, done };
  });
  const completion = Promise.all(workers.map((worker) => worker.done));
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers)
      if (worker.child.connected) worker.child.send('start');
    return await completion;
  } finally {
    for (const worker of workers)
      if (worker.child.exitCode === null) worker.child.kill();
  }
}

test('bills: independent monthly obligations estimate from last actual payment, never from unpaid invoice', () => {
  const f = setup();
  try {
    const october = obligation(f, 'october', '95000', '2026-10');
    const paidOctober = f.bills.confirmPayment(
      context,
      'paid-october',
      paymentInput(october.id, '95000', '2026-10-10'),
    );
    const november = obligation(f);
    const decemberInput = {
      conceptId: f.concept.id,
      month: '2026-12',
      generatedOn: '2026-12-01',
    };
    const december = f.bills.generateObligation(
      context,
      'december',
      decemberInput,
    );
    assert.equal(december.amountStatus, 'estimated');
    assert.equal(december.amount?.minor, 9500000n);
    assert.equal(december.sourcePaymentId, paidOctober.id);
    assert.equal(
      f.bills.getObligation(context, november.id, { asOf: '2026-12-01' })
        .status,
      'pending',
    );
    const adjustment = f.bills.adjustObligation(context, 'actual-november', {
      obligationId: november.id,
      expectedRevisionId: november.id,
      amount: '99000',
      amountStatus: 'confirmed',
      reason: 'Synthetic corrected bill',
    });
    const payInput = {
      ...paymentInput(november.id, '99000', '2026-12-03'),
      expectedRevisionId: adjustment.id,
    };
    const paidNovember = f.bills.confirmPayment(
      context,
      'paid-november',
      payInput,
    );
    assert.deepEqual(
      f.bills.confirmPayment(context, 'paid-november', payInput),
      paidNovember,
    );
    assert.deepEqual(
      f.bills.generateObligation(context, 'december', decemberInput),
      december,
    );
    const retained = f.bills.getObligation(context, december.id, {
      asOf: '2026-12-04',
    });
    assert.equal(retained.amount?.minor, 9500000n);
    assert.equal(retained.status, 'pending');
    const history = f.bills.getObligation(context, november.id, {
      asOf: '2026-12-04',
    });
    assert.equal(history.obligation.amount?.minor, 9800000n);
    assert.equal(history.revisions.length, 1);
    assert.equal(history.currentRevisionId, adjustment.id);
    assert.equal(history.payment?.id, paidNovember.id);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-12' }).total.minor,
      9900000n,
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-12' }).total.minor,
      9900000n,
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-12' }).payments.length,
      1,
    );
  } finally {
    f.store.close();
  }
});

test('bills: unknown and configured estimates remain distinct from confirmed payable amounts', () => {
  const f = setup();
  try {
    const unknown = f.bills.generateObligation(context, 'unknown', {
      conceptId: f.concept.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
    });
    assert.equal(unknown.amount, null);
    assert.equal(unknown.amountStatus, 'unknown');
    assert.equal(unknown.dueOn, null);
    const fixed = f.bills.createConcept(context, 'fixed', {
      description: 'Synthetic rent',
      categoryId: f.category.id,
      fixedAmount: '1000000',
    });
    const estimated = f.bills.generateObligation(context, 'estimated', {
      conceptId: fixed.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
    });
    assert.equal(estimated.amountStatus, 'estimated');
    assert.equal(estimated.amount?.minor, 100000000n);
    const summary = f.bills.listObligations(context, { asOf: '2026-11-16' });
    assert.equal(summary.unknownPendingCount, 1);
    assert.equal(summary.confirmedPending.minor, 0n);
    assert.equal(summary.estimatedPending.minor, 100000000n);
    for (const item of [unknown, estimated])
      assert.throws(() =>
        f.bills.confirmPayment(
          context,
          `pay-${item.id}`,
          paymentInput(item.id, '1000000'),
        ),
      );
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('bills: absent due dates never become overdue and explicit deadlines are inclusive', () => {
  const f = setup();
  try {
    const without = obligation(f);
    assert.equal(
      f.bills.getObligation(context, without.id, { asOf: '2027-12-31' }).status,
      'pending',
    );
    const due = f.bills.generateObligation(context, 'dated', {
      conceptId: f.concept.id,
      month: '2026-12',
      generatedOn: '2026-12-01',
      amount: '100',
      amountStatus: 'confirmed',
      dueOn: '2026-12-05',
    });
    assert.equal(
      f.bills.getObligation(context, due.id, { asOf: '2026-12-05' }).status,
      'pending',
    );
    assert.equal(
      f.bills.getObligation(context, due.id, { asOf: '2026-12-06' }).status,
      'overdue',
    );
    assert.equal(
      f.bills.listObligations(context, { asOf: '2026-12-06' }).confirmedOverdue
        .minor,
      10000n,
    );
    f.bills.confirmPayment(
      context,
      'dated-paid',
      paymentInput(due.id, '100', '2026-12-07'),
    );
    assert.equal(
      f.bills.getObligation(context, due.id, { asOf: '2026-12-06' }).status,
      'overdue',
    );
    assert.equal(
      f.bills.getObligation(context, due.id, { asOf: '2026-12-07' }).status,
      'paid',
    );
  } finally {
    f.store.close();
  }
});

test('bills: habitual due date requires explicit offset and clamps leap February without inventing a date', () => {
  const f = setup();
  try {
    assert.throws(() =>
      f.bills.createConcept(context, 'partial-rule', {
        description: 'Synthetic',
        categoryId: f.category.id,
        dueDay: 5,
      }),
    );
    assert.throws(() =>
      f.bills.createConcept(context, 'offset-only', {
        description: 'Synthetic',
        categoryId: f.category.id,
        dueMonthOffset: 1,
      }),
    );
    const concept = f.bills.createConcept(context, 'day31', {
      description: 'Synthetic variable',
      categoryId: f.category.id,
      dueDay: 31,
      dueMonthOffset: 1,
    });
    const generated = f.bills.generateObligation(context, 'leap', {
      conceptId: concept.id,
      month: '2028-01',
      generatedOn: '2028-01-01',
    });
    assert.equal(generated.dueOn, '2028-02-29');
    const override = f.bills.generateObligation(context, 'override', {
      conceptId: concept.id,
      month: '2028-02',
      generatedOn: '2028-02-01',
      dueOn: null,
    });
    assert.equal(override.dueOn, null);
  } finally {
    f.store.close();
  }
});

test('bills: generation uses payment date cutoff and immutable estimate snapshot', () => {
  const f = setup();
  try {
    const october = obligation(f, 'october', '95000', '2026-10');
    f.bills.confirmPayment(
      context,
      'late-october',
      paymentInput(october.id, '95000', '2026-12-02'),
    );
    const before = f.bills.generateObligation(context, 'before', {
      conceptId: f.concept.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
    });
    assert.equal(before.amountStatus, 'unknown');
    assert.equal(before.amount, null);
    const after = f.bills.generateObligation(context, 'after', {
      conceptId: f.concept.id,
      month: '2027-01',
      generatedOn: '2027-01-01',
    });
    assert.equal(after.amount?.minor, 9500000n);
    assert.equal(
      f.bills.getObligation(context, before.id, { asOf: '2027-01-01' }).amount,
      null,
    );
  } finally {
    f.store.close();
  }
});

test('bills: adjusted amounts retain history and compare revision prevents stale payment', () => {
  const f = setup();
  try {
    const invoice = obligation(f);
    const adjustment = f.bills.adjustObligation(context, 'adjust', {
      obligationId: invoice.id,
      expectedRevisionId: invoice.id,
      amount: '100000',
      amountStatus: 'confirmed',
      reason: 'Synthetic final reading',
    });
    assert.throws(() =>
      f.bills.confirmPayment(context, 'stale', paymentInput(invoice.id)),
    );
    assert.equal(f.bills.findIntent(context, 'stale'), undefined);
    assert.throws(() =>
      f.bills.adjustObligation(context, 'stale-adjust', {
        obligationId: invoice.id,
        expectedRevisionId: invoice.id,
        amount: '1',
        amountStatus: 'confirmed',
        reason: 'Stale synthetic adjustment',
      }),
    );
    const paid = f.bills.confirmPayment(context, 'correct', {
      ...paymentInput(invoice.id, '100000'),
      expectedRevisionId: adjustment.id,
    });
    assert.equal(paid.amount.minor, 10000000n);
    assert.throws(() =>
      f.bills.adjustObligation(context, 'after-paid', {
        obligationId: invoice.id,
        expectedRevisionId: adjustment.id,
        amount: '99999',
        amountStatus: 'confirmed',
        reason: 'After synthetic payment',
      }),
    );
    assert.equal(
      f.bills.getObligation(context, invoice.id, { asOf: '2026-11-16' })
        .revisions.length,
      1,
    );
  } finally {
    f.store.close();
  }
});

test('bills: only exact full payment is accepted and a second intention cannot pay it again', () => {
  const f = setup();
  try {
    const invoice = obligation(f);
    for (const amount of ['1', '97999.99', '98000.01']) {
      assert.throws(() =>
        f.bills.confirmPayment(
          context,
          `wrong-${amount}`,
          paymentInput(invoice.id, amount),
        ),
      );
      assert.equal(f.bills.findIntent(context, `wrong-${amount}`), undefined);
    }
    f.bills.confirmPayment(context, 'paid', paymentInput(invoice.id));
    assert.throws(() =>
      f.bills.confirmPayment(context, 'paid-again', paymentInput(invoice.id)),
    );
    assert.equal(f.bills.findIntent(context, 'paid-again'), undefined);
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments.length,
      1,
    );
  } finally {
    f.store.close();
  }
});

test('bills: paying a November obligation in December consumes December budget exactly once', () => {
  const f = setup();
  try {
    const invoice = obligation(f, 'november', '80000');
    for (const month of ['2026-11', '2026-12'])
      f.budgets.setBudget(context, `budget-${month}`, {
        categoryId: f.category.id,
        month,
        amount: '100000',
      });
    assert.equal(f.delivery.listPending(context).events.length, 0);
    const input = paymentInput(invoice.id, '80000', '2026-12-05');
    const paid = f.bills.confirmPayment(context, 'paid', input);
    assert.equal(paid.expenseId, paid.id);
    assert.deepEqual(f.bills.confirmPayment(context, 'paid', input), paid);
    const status = f.budgets.getBudgetStatus(context, {
      categoryId: f.category.id,
      month: '2026-12',
    });
    assert.equal(status.consumed.minor, 8000000n);
    assert.deepEqual(
      status.alerts.map((alert) => alert.threshold),
      [80],
    );
    assert.equal(
      f.budgets.getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-11',
      }).consumed.minor,
      0n,
    );
    assert.equal(
      f.expenses.monthlyTotals(context, {
        month: '2026-12',
        categoryId: f.category.id,
      }).total.minor,
      8000000n,
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-12' }).total.minor,
      8000000n,
    );
    f.expenses.recordExpense(context, 'ordinary', {
      categoryId: f.category.id,
      amount: '20000',
      occurredOn: '2026-12-06',
    });
    assert.equal(
      f.budgets.getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-12',
      }).consumed.minor,
      10000000n,
    );
    assert.deepEqual(
      f.delivery.listPending(context).events.map((event) => event.threshold),
      [80, 100],
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-12' }).total.minor,
      8000000n,
    );
  } finally {
    f.store.close();
  }
});

test('bills: direct full budget crossing emits only 100 and paid fact cannot be corrected independently', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '98000',
    });
    const invoice = obligation(f),
      paid = f.bills.confirmPayment(context, 'paid', paymentInput(invoice.id));
    assert.deepEqual(
      f.delivery.listPending(context).events.map((event) => event.threshold),
      [100],
    );
    assert.throws(
      () =>
        f.corrections.voidExpense(context, 'void', {
          expenseId: paid.expenseId,
          reason: 'Synthetic wrong path',
        }),
      { code: 'BILL_PAYMENT_CORRECTION_REQUIRED' },
    );
    assert.throws(
      () =>
        f.corrections.replaceExpense(context, 'replace', {
          expenseId: paid.expenseId,
          reason: 'Synthetic wrong path',
          replacement: {
            amount: '1',
            categoryId: f.category.id,
            currency: 'COP',
            occurredOn: '2026-11-16',
          },
        }),
      { code: 'BILL_PAYMENT_CORRECTION_REQUIRED' },
    );
    assert.equal(
      f.bills.getObligation(context, invoice.id, { asOf: '2026-11-16' }).status,
      'paid',
    );
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      9800000n,
    );
  } finally {
    f.store.close();
  }
});

test('bills: same keys replay original results and changed payloads conflict across financial domains', () => {
  const f = setup();
  try {
    assert.deepEqual(
      f.bills.createConcept(context, 'internet', {
        description: 'Synthetic internet',
        categoryId: f.category.id,
      }),
      f.concept,
    );
    assert.throws(
      () =>
        f.bills.createConcept(context, 'internet', {
          description: 'Other synthetic',
          categoryId: f.category.id,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const invoice = obligation(f);
    assert.deepEqual(obligation(f), invoice);
    assert.throws(() => obligation(f, 'duplicate'), {
      code: 'BILL_OBLIGATION_EXISTS',
    });
    assert.throws(() => obligation(f, 'november', '99000'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(
      () =>
        f.bills.createConcept(context, 'category', {
          description: 'Conflict',
          categoryId: f.category.id,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.bills.findIntent(context, 'category'), undefined);
    assert.equal(f.expenses.findIntent(context, 'internet'), undefined);
    assert.throws(
      () =>
        f.expenses.recordExpense(context, 'internet', {
          amount: '1',
          categoryId: f.category.id,
          occurredOn: '2026-11-16',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.store.close();
  }
});

test('bills: exact centavos above signed 64 bits survive payment and reopening', () => {
  const f = setup(),
    amount = '9223372036854775808.17';
  const invoice = obligation(f, 'large', amount),
    input = paymentInput(invoice.id, amount),
    paid = f.bills.confirmPayment(context, 'paid', input);
  f.store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy);
    assert.deepEqual(api.bills.confirmPayment(context, 'paid', input), paid);
    assert.equal(
      api.bills.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      922337203685477580817n,
    );
    assert.equal(
      api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      922337203685477580817n,
    );
  } finally {
    reopened.close();
  }
});

test('bills: explicit amount status, currency, dates and matching period are required', () => {
  const f = setup();
  try {
    for (const amount of ['0', '-1', '98.000', '1e4', 'NaN'])
      assert.throws(() =>
        f.bills.generateObligation(context, `amount-${amount}`, {
          conceptId: f.concept.id,
          month: '2026-11',
          generatedOn: '2026-11-01',
          amount,
          amountStatus: 'confirmed',
        }),
      );
    assert.throws(() =>
      f.bills.generateObligation(context, 'amount-only', {
        conceptId: f.concept.id,
        month: '2026-11',
        generatedOn: '2026-11-01',
        amount: '98000',
      }),
    );
    assert.throws(() =>
      f.bills.generateObligation(context, 'status-only', {
        conceptId: f.concept.id,
        month: '2026-11',
        generatedOn: '2026-11-01',
        amountStatus: 'confirmed',
      }),
    );
    assert.throws(() =>
      f.bills.generateObligation(context, 'currency', {
        conceptId: f.concept.id,
        month: '2026-11',
        generatedOn: '2026-11-01',
        amount: '98000',
        amountStatus: 'confirmed',
        currency: 'USD',
      }),
    );
    assert.throws(() =>
      f.bills.generateObligation(context, 'date', {
        conceptId: f.concept.id,
        month: '2026-11',
        generatedOn: '2026-02-30',
      }),
    );
    const invoice = obligation(f);
    assert.throws(() =>
      f.bills.confirmPayment(
        context,
        'too-early',
        paymentInput(invoice.id, '98000', '2026-10-31'),
      ),
    );
    assert.throws(() =>
      // @ts-expect-error An ambiguous report lacks the exact obligation.
      f.bills.confirmPayment(context, 'missing-period', {
        expectedRevisionId: invoice.id,
        amount: '98000',
        paidOn: '2026-11-16',
        reference: 'synthetic ambiguous',
      }),
    );
    assert.equal(
      f.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments.length,
      0,
    );
  } finally {
    f.store.close();
  }
});

test('bills: subjects and instances may reuse keys but cannot reference foreign concepts or obligations', () => {
  const f = setup();
  try {
    const invoice = obligation(f);
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(() =>
        f.bills.getObligation(foreign, invoice.id, { asOf: '2026-11-16' }),
      );
      assert.throws(() =>
        f.bills.generateObligation(foreign, 'foreign', {
          conceptId: f.concept.id,
          month: '2026-11',
          generatedOn: '2026-11-01',
        }),
      );
      assert.throws(() =>
        f.bills.confirmPayment(
          foreign,
          'foreign-paid',
          paymentInput(invoice.id),
        ),
      );
      assert.throws(
        () =>
          f.bills.createConcept(foreign, 'foreign-category', {
            description: 'Foreign synthetic',
            categoryId: f.category.id,
          }),
        { code: 'CATEGORY_NOT_FOUND' },
      );
      assert.equal(f.bills.findIntent(foreign, 'november'), undefined);
      assert.equal(
        f.bills.listObligations(foreign, { asOf: '2026-11-16' }).obligations
          .length,
        0,
      );
      const category = f.expenses.createCategory(foreign, 'category', {
        name: 'Other synthetic category',
      });
      const concept = f.bills.createConcept(foreign, 'internet', {
        description: 'Other internet',
        categoryId: category.id,
      });
      const other = f.bills.generateObligation(foreign, 'november', {
        conceptId: concept.id,
        month: '2026-11',
        generatedOn: '2026-11-01',
        amount: '1',
        amountStatus: 'confirmed',
      });
      assert.notEqual(other.id, invoice.id);
      assert.equal(
        f.bills.listObligations(foreign, { asOf: '2026-11-16' })
          .confirmedPending.minor,
        100n,
      );
    }
    assert.equal(
      f.bills.listObligations(context, { asOf: '2026-11-16' }).confirmedPending
        .minor,
      9800000n,
    );
  } finally {
    f.store.close();
  }
});

test('bills: permissions are revalidated for replay and actor metadata cannot be injected', () => {
  const f = setup();
  try {
    const invoice = obligation(f),
      input = paymentInput(invoice.id),
      paid = f.bills.confirmPayment(context, 'paid', input);
    assert.deepEqual(
      f.bills.confirmPayment(otherActorContext, 'paid', input),
      paid,
    );
    assert.equal(paid.actorRef, context.actorRef);
    assert.throws(
      () =>
        f.bills.confirmPayment(
          { ...context, actorRef: 'unbound-actor' },
          'forged',
          input,
        ),
      { code: 'FORBIDDEN' },
    );
    const malicious = {
      ...input,
      subjectRef: otherSubjectContext.subjectRef,
      actorRef: 'payload-actor',
    };
    assert.throws(() => f.bills.confirmPayment(context, 'payload', malicious));
    f.actions.delete('bill:pay');
    assert.throws(() => f.bills.confirmPayment(context, 'paid', input), {
      code: 'FORBIDDEN',
    });
    f.actions.delete('bill:read');
    for (const query of [
      () => f.bills.findIntent(context, 'paid'),
      () => f.bills.getObligation(context, invoice.id, { asOf: '2026-11-16' }),
      () => f.bills.listObligations(context, { asOf: '2026-11-16' }),
      () => f.bills.monthlyCashOutflow(context, { month: '2026-11' }),
    ])
      assert.throws(query, { code: 'FORBIDDEN' });
    f.actions.delete('bill:write');
    assert.throws(
      () =>
        f.bills.createConcept(context, 'internet', {
          description: 'Synthetic internet',
          categoryId: f.category.id,
        }),
      { code: 'FORBIDDEN' },
    );
  } finally {
    f.store.close();
  }
});

for (const hook of [
  'afterBillConceptInsert',
  'afterBillObligationInsert',
  'afterBillAdjustmentInsert',
  'afterBillPaymentInsert',
  'afterBillExpenseInsert',
  'afterAlertInsert',
] as const) {
  test(`bills: ${hook} rollback preserves obligation, cash, consumption, alerts and retry identity`, () => {
    const f = setup();
    const invoice = obligation(f);
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '98000',
    });
    f.store.close();
    const failing = new SqliteExpenseStore(f.path, {
      [hook]: () => {
        throw new Error('Synthetic transactional bill failure');
      },
    });
    const invoke = (api: RecurringBillService) =>
      hook === 'afterBillConceptInsert'
        ? api.createConcept(context, 'operation', {
            description: 'Synthetic electricity',
            categoryId: f.category.id,
          })
        : hook === 'afterBillObligationInsert'
          ? api.generateObligation(context, 'operation', {
              conceptId: f.concept.id,
              month: '2026-12',
              generatedOn: '2026-12-01',
            })
          : hook === 'afterBillAdjustmentInsert'
            ? api.adjustObligation(context, 'operation', {
                obligationId: invoice.id,
                expectedRevisionId: invoice.id,
                amount: '99000',
                amountStatus: 'confirmed',
                reason: 'Synthetic adjustment',
              })
            : api.confirmPayment(
                context,
                'operation',
                paymentInput(invoice.id),
              );
    try {
      const api = services(failing, f.policy);
      assert.throws(() => invoke(api.bills), { code: 'STORAGE_IO' });
      assert.equal(api.bills.findIntent(context, 'operation'), undefined);
      assert.equal(
        api.bills.getObligation(context, invoice.id, { asOf: '2026-11-16' })
          .currentRevisionId,
        invoice.id,
      );
      assert.equal(
        api.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments
          .length,
        0,
      );
      assert.equal(
        api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
        0n,
      );
      assert.equal(api.delivery.listPending(context).events.length, 0);
    } finally {
      failing.close();
    }
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = services(reopened, f.policy),
        result = invoke(api.bills);
      assert.equal(api.bills.findIntent(context, 'operation')?.id, result.id);
      assert.deepEqual(invoke(api.bills), result);
      if (
        hook === 'afterBillPaymentInsert' ||
        hook === 'afterBillExpenseInsert' ||
        hook === 'afterAlertInsert'
      ) {
        assert.equal(
          api.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments
            .length,
          1,
        );
        assert.equal(
          api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
          9800000n,
        );
        assert.equal(api.delivery.listPending(context).events.length, 1);
      }
    } finally {
      reopened.close();
    }
  });
}

test('bills: lost response after committed payment is recovered after reopening with one cash fact', () => {
  const f = setup(),
    invoice = obligation(f),
    input = paymentInput(invoice.id);
  f.budgets.setBudget(context, 'budget', {
    categoryId: f.category.id,
    month: '2026-11',
    amount: '98000',
  });
  f.store.close();
  const uncertain = new SqliteExpenseStore(f.path, {
    afterBillCommit: () => {
      throw new Error('Synthetic response lost');
    },
  });
  try {
    assert.throws(
      () =>
        new RecurringBillService(uncertain, f.policy, clock).confirmPayment(
          context,
          'paid',
          input,
        ),
      { code: 'STORAGE_IO' },
    );
  } finally {
    uncertain.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy),
      original = api.bills.findIntent(context, 'paid');
    assert.ok(original);
    const recovered = api.bills.confirmPayment(context, 'paid', input);
    assert.deepEqual(recovered, original);
    assert.equal(
      api.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments
        .length,
      1,
    );
    assert.equal(
      api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      9800000n,
    );
    assert.equal(api.delivery.listPending(context).events.length, 1);
  } finally {
    reopened.close();
  }
});

test('bills: restored backup retains estimation source, revisions, payment links and exact replays', () => {
  const f = setup(),
    october = obligation(f, 'october', '95000', '2026-10');
  const input = paymentInput(october.id, '95000', '2026-10-16'),
    paid = f.bills.confirmPayment(context, 'paid', input);
  const november = f.bills.generateObligation(context, 'november', {
    conceptId: f.concept.id,
    month: '2026-11',
    generatedOn: '2026-11-01',
  });
  const adjustment = f.bills.adjustObligation(context, 'actual', {
    obligationId: november.id,
    expectedRevisionId: november.id,
    amount: '98000',
    amountStatus: 'confirmed',
    reason: 'Synthetic invoice received',
  });
  const original = encoded(
    f.bills.listObligations(context, { asOf: '2026-11-16' }),
  );
  const backup = pathFor(),
    restored = pathFor();
  f.store.backupTo(backup);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restored);
  const store = new SqliteExpenseStore(restored);
  try {
    const api = services(store, f.policy);
    assert.deepEqual(
      encoded(api.bills.listObligations(context, { asOf: '2026-11-16' })),
      original,
    );
    assert.deepEqual(api.bills.confirmPayment(context, 'paid', input), paid);
    assert.equal(
      api.bills.getObligation(context, november.id, { asOf: '2026-11-16' })
        .currentRevisionId,
      adjustment.id,
    );
    assert.equal(
      api.bills.getObligation(context, november.id, { asOf: '2026-11-16' })
        .obligation.sourcePaymentId,
      paid.id,
    );
    assert.equal(
      api.expenses.monthlyTotals(context, { month: '2026-10' }).total.minor,
      9500000n,
    );
  } finally {
    store.close();
  }
});

test('bills: concurrent processes retry one payment with a stable identity', async () => {
  const f = setup(),
    invoice = obligation(f),
    input = paymentInput(invoice.id);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'paid', operation: 'pay', input },
    { key: 'paid', operation: 'pay', input },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 2);
  assert.equal(replies[0]?.result?.id, replies[1]?.result?.id);
  const store = new SqliteExpenseStore(f.path);
  try {
    const api = services(store, f.policy);
    assert.equal(
      api.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments
        .length,
      1,
    );
    assert.equal(
      api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      9800000n,
    );
  } finally {
    store.close();
  }
});

test('bills: concurrent same-key incompatible references commit one result and one conflict', async () => {
  const f = setup(),
    invoice = obligation(f),
    input = paymentInput(invoice.id);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'paid', operation: 'pay', input },
    {
      key: 'paid',
      operation: 'pay',
      input: { ...input, reference: 'Different synthetic reference' },
    },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.deepEqual(
    replies
      .filter((reply) => reply.type === 'error')
      .map((reply) => reply.code),
    ['IDEMPOTENCY_CONFLICT'],
  );
  const store = new SqliteExpenseStore(f.path);
  try {
    assert.equal(
      new RecurringBillService(store, f.policy, clock).monthlyCashOutflow(
        context,
        { month: '2026-11' },
      ).payments.length,
      1,
    );
  } finally {
    store.close();
  }
});

test('bills: competing payment intentions cannot pay one monthly obligation twice', async () => {
  const f = setup(),
    invoice = obligation(f),
    input = paymentInput(invoice.id);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'first', operation: 'pay', input },
    { key: 'second', operation: 'pay', input },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.equal(replies.filter((reply) => reply.type === 'error').length, 1);
  const store = new SqliteExpenseStore(f.path);
  try {
    const api = services(store, f.policy);
    assert.equal(
      api.bills.monthlyCashOutflow(context, { month: '2026-11' }).payments
        .length,
      1,
    );
    assert.equal(
      api.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      9800000n,
    );
  } finally {
    store.close();
  }
});

test('bills: payment racing an amount adjustment never confirms a different revision', async () => {
  const f = setup(),
    invoice = obligation(f);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'paid', operation: 'pay', input: paymentInput(invoice.id) },
    {
      key: 'adjust',
      operation: 'adjust',
      input: {
        obligationId: invoice.id,
        expectedRevisionId: invoice.id,
        amount: '99000',
        amountStatus: 'confirmed',
        reason: 'Synthetic race',
      },
    },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.equal(replies.filter((reply) => reply.type === 'error').length, 1);
  const store = new SqliteExpenseStore(f.path);
  try {
    const api = services(store, f.policy),
      state = api.bills.getObligation(context, invoice.id, {
        asOf: '2026-11-16',
      });
    if (state.status === 'paid') {
      assert.equal(state.currentRevisionId, invoice.id);
      assert.equal(state.revisions.length, 0);
      assert.equal(
        api.bills.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
        9800000n,
      );
    } else {
      assert.equal(state.amount?.minor, 9900000n);
      assert.equal(state.revisions.length, 1);
      assert.equal(state.payment, null);
      assert.equal(
        api.bills.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
        0n,
      );
    }
  } finally {
    store.close();
  }
});

test('bills: concurrent generation preserves one obligation per concept and period', async () => {
  const f = setup(),
    input = {
      conceptId: f.concept.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
    };
  f.store.close();
  const replies = await race(f.path, [
    { key: 'first', operation: 'generate', input },
    { key: 'second', operation: 'generate', input },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.equal(replies.filter((reply) => reply.type === 'error').length, 1);
  const store = new SqliteExpenseStore(f.path);
  try {
    assert.equal(
      new RecurringBillService(store, f.policy, clock).listObligations(
        context,
        { asOf: '2026-11-16' },
      ).obligations.length,
      1,
    );
  } finally {
    store.close();
  }
});
