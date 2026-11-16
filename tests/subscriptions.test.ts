import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SubscriptionService } from '../src/application/subscription-service.ts';
import { PersonalLoanService } from '../src/application/personal-loan-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { SalaryService } from '../src/application/salary-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { Money } from '../src/domain/money.ts';
import { decideSubscriptionCommand } from '../src/domain/subscriptions.ts';
import type {
  Subscription,
  SubscriptionObligation,
  SubscriptionState,
} from '../src/domain/subscriptions.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'subscription-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `subscription-${++sequence}.sqlite`);
const clock = () => '2026-11-16T12:00:00.000Z';
const encoded = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;

function setup() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path);
  const actions = new Set<Action>([
    'subscription:write',
    'subscription:pay',
    'subscription:receive',
    'subscription:read',
    'loan:counterparty',
    'loan:disburse',
    'loan:repay',
    'loan:read',
    'category:create',
    'expense:record',
    'expense:read',
    'expense:correct',
    'budget:write',
    'budget:read',
    'event:read',
    'salary:configure',
    'salary:close',
    'salary:receive',
    'salary:read',
  ]);
  const contexts = [
    context,
    otherSubjectContext,
    otherInstanceContext,
    otherActorContext,
  ];
  const policy: AccessPolicy = {
    allows: (bound, action) =>
      actions.has(action) &&
      contexts.some(
        (allowed) =>
          allowed.actorRef === bound.actorRef &&
          allowed.subjectRef === bound.subjectRef &&
          allowed.instanceRef === bound.instanceRef,
      ),
  };
  const api = new SubscriptionService(store, policy, clock);
  const expenses = new ExpenseService(store, policy);
  const budgets = new MonthlyBudgetService(store, policy);
  const loans = new PersonalLoanService(store, policy, clock);
  const category = expenses.createCategory(context, 'category', {
    name: 'Synthetic subscriptions',
  });
  const juan = loans.createCounterparty(context, 'juan', {
    name: 'Synthetic Juan',
  });
  const ana = loans.createCounterparty(context, 'ana', {
    name: 'Synthetic Ana',
  });
  return {
    path,
    store,
    actions,
    policy,
    api,
    expenses,
    budgets,
    loans,
    category,
    juan,
    ana,
  };
}

const paymentInput = (
  obligationId: string,
  amount = '45000',
  paidOn = '2026-11-05',
) => ({
  obligationId,
  amount,
  paidOn,
  reference: 'synthetic subscription payment',
});
const reimbursementInput = (
  counterpartyId: string,
  amount: string,
  receivedOn = '2026-11-10',
) => ({
  counterpartyId,
  amount,
  receivedOn,
  reference: 'synthetic reimbursement',
});

type Fixture = ReturnType<typeof setup>;
function createInput(
  f: Fixture,
  mode: 'personal' | 'shared' = 'shared',
  monthlyAmount = mode === 'personal' ? '30000' : '45000',
) {
  return {
    name: 'Synthetic streaming',
    categoryId: f.category.id,
    mode,
    monthlyAmount,
    effectiveMonth: '2026-11',
    includesHolder: true,
    counterpartyIds: mode === 'personal' ? [] : [f.juan.id, f.ana.id],
  };
}
function shared(f: Fixture, key = 'subscription', monthlyAmount = '45000') {
  return f.api.createSubscription(
    context,
    key,
    createInput(f, 'shared', monthlyAmount),
  );
}
function generate(
  f: Fixture,
  subscriptionId: string,
  month = '2026-11',
  key = `period-${month}`,
) {
  return f.api.generateObligation(context, key, {
    subscriptionId,
    month,
    generatedOn: `${month}-01`,
  });
}
function paid(f: Fixture) {
  const subscription = shared(f),
    obligation = generate(f, subscription.id);
  const payment = f.api.confirmPayment(
    context,
    'paid',
    paymentInput(obligation.id),
  );
  return { subscription, obligation, payment };
}
const receivables = (
  f: Fixture,
  counterpartyId = f.juan.id,
  asOf = '2027-01-31',
) => f.api.getReceivables(context, { counterpartyId, asOf });

test('subscriptions unit: exact equal division preserves cash = own consumption + external shares without mutating its ledger', () => {
  const audit = { actorRef: context.actorRef, recordedAt: clock() };
  const subscription: Subscription = {
    kind: 'subscription',
    id: 'subscription',
    name: 'Synthetic unit',
    categoryId: 'category',
    mode: 'shared',
    monthlyAmount: Money.fromDecimal('45000'),
    effectiveMonth: '2026-11',
    includesHolder: true,
    counterpartyIds: ['ana', 'juan'],
    ...audit,
  };
  const obligation: SubscriptionObligation = {
    kind: 'subscription-obligation',
    id: 'obligation',
    subscriptionId: subscription.id,
    versionId: subscription.id,
    categoryId: 'category',
    month: '2026-11',
    generatedOn: '2026-11-01',
    amount: subscription.monthlyAmount,
    includesHolder: true,
    counterpartyIds: subscription.counterpartyIds,
    ...audit,
  };
  const state: SubscriptionState = {
    subscriptions: [subscription],
    obligations: [obligation],
    counterparties: [],
    changes: [],
    payments: [],
    reimbursements: [],
  };
  const before = encoded(state);
  const result = decideSubscriptionCommand(
    state,
    {
      operation: 'pay',
      draft: {
        ...paymentInput(obligation.id),
        amount: subscription.monthlyAmount,
        ...audit,
      },
    },
    'payment',
  );
  assert.equal(result.kind, 'subscription-payment');
  if (result.kind !== 'subscription-payment') assert.fail('Expected payment');
  assert.equal(result.amount.minor, 4500000n);
  assert.equal(result.ownAmount.minor, 1500000n);
  assert.equal(
    result.shares.reduce(
      (sum, share) => sum + share.amount.minor,
      result.ownAmount.minor,
    ),
    result.amount.minor,
  );
  assert.equal(result.expenseId, result.id);
  assert.deepEqual(encoded(state), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.shares), true);
});

test('subscriptions: personal obligation remains pending until one confirmed payment produces matching cash and consumption', () => {
  const f = setup();
  try {
    const subscription = f.api.createSubscription(
      context,
      'personal',
      createInput(f, 'personal'),
    );
    const obligation = generate(f, subscription.id);
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2026-11-30',
      }).status,
      'pending',
    );
    assert.equal(
      f.api.listObligations(context, { asOf: '2026-11-30' }).pending.minor,
      3000000n,
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      0n,
    );
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    const payment = f.api.confirmPayment(
      context,
      'pay',
      paymentInput(obligation.id, '30000'),
    );
    assert.equal(payment.status, 'confirmed');
    assert.equal(payment.ownAmount.minor, 3000000n);
    assert.deepEqual(payment.shares, []);
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2026-11-30',
      }).status,
      'paid',
    );
    const cash = f.api.monthlyCashFlow(context, { month: '2026-11' });
    assert.equal(cash.outflow.minor, 3000000n);
    assert.equal(cash.personalConsumption.minor, 3000000n);
    assert.equal(cash.payments.length, 1);
    assert.equal(cash.payments[0]!.id, payment.id);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      3000000n,
    );
    assert.equal(receivables(f).pending.minor, 0n);
  } finally {
    f.store.close();
  }
});

test('subscriptions: shared 45000 records one full outflow, 15000 own budget consumption and two independent receivables', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '18750',
    });
    const { payment } = paid(f);
    assert.equal(payment.ownAmount.minor, 1500000n);
    assert.equal(payment.shares.length, 2);
    assert.equal(receivables(f).pending.minor, 1500000n);
    assert.equal(receivables(f, f.ana.id).pending.minor, 1500000n);
    const cash = f.api.monthlyCashFlow(context, { month: '2026-11' });
    assert.equal(cash.outflow.minor, 4500000n);
    assert.equal(cash.personalConsumption.minor, 1500000n);
    assert.equal(cash.payments.length, 1);
    const budget = f.budgets.getBudgetStatus(context, {
      categoryId: f.category.id,
      month: '2026-11',
    });
    assert.equal(budget.consumed.minor, 1500000n);
    assert.deepEqual(
      budget.alerts.map((alert) => alert.threshold),
      [80],
    );
    assert.equal(f.store.listExpenses(context).length, 1);
    assert.equal(f.store.listExpenses(context)[0]!.id, payment.expenseId);
  } finally {
    f.store.close();
  }
});

test('subscriptions: partial reimbursements 10000 and 5000 settle Juan while Ana stays pending without new consumption', () => {
  const f = setup();
  try {
    const { payment } = paid(f);
    const first = f.api.receiveReimbursement(
      context,
      'juan-part',
      reimbursementInput(f.juan.id, '10000'),
    );
    assert.equal(first.status, 'confirmed');
    assert.equal(first.allocations[0]!.paymentId, payment.id);
    assert.equal(receivables(f).pending.minor, 500000n);
    const final = f.api.receiveReimbursement(
      context,
      'juan-rest',
      reimbursementInput(f.juan.id, '5000', '2026-11-11'),
    );
    assert.equal(final.status, 'confirmed');
    assert.equal(receivables(f).pending.minor, 0n);
    assert.equal(receivables(f).totalReimbursed.minor, 1500000n);
    assert.equal(receivables(f).reimbursements.length, 2);
    assert.equal(receivables(f, f.ana.id).pending.minor, 1500000n);
    const cash = f.api.monthlyCashFlow(context, { month: '2026-11' });
    assert.equal(cash.inflow.minor, 1500000n);
    assert.equal(cash.outflow.minor, 4500000n);
    assert.equal(cash.reimbursements.length, 2);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      1500000n,
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: January reimbursement uses November then December FIFO without moving cash back to obligation months', () => {
  const f = setup();
  try {
    const { subscription, payment } = paid(f);
    const december = generate(f, subscription.id, '2026-12');
    const next = f.api.confirmPayment(
      context,
      'dec-paid',
      paymentInput(december.id, '45000', '2026-12-05'),
    );
    const reimbursement = f.api.receiveReimbursement(
      context,
      'january',
      reimbursementInput(f.juan.id, '20000', '2027-01-05'),
    );
    assert.deepEqual(
      reimbursement.allocations.map((item) => [
        item.paymentId,
        item.amount.minor,
      ]),
      [
        [payment.id, 1500000n],
        [next.id, 500000n],
      ],
    );
    assert.deepEqual(
      receivables(f).periods.map((item) => [item.month, item.pending.minor]),
      [
        ['2026-11', 0n],
        ['2026-12', 1000000n],
      ],
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2027-01' }).inflow.minor,
      2000000n,
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      0n,
    );
    assert.equal(
      receivables(f, f.juan.id, '2026-12-31').pending.minor,
      3000000n,
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: FIFO is global per person across subscriptions and uses a stable tie order for one month', () => {
  const f = setup();
  try {
    const first = shared(f, 'first'),
      second = shared(f, 'second');
    const obligations = [
      generate(f, first.id, '2026-11', 'first-period'),
      generate(f, second.id, '2026-11', 'second-period'),
    ];
    const payments = obligations.map((obligation, index) =>
      f.api.confirmPayment(
        context,
        `pay-${index}`,
        paymentInput(obligation.id),
      ),
    );
    const sorted = [...payments].sort((a, b) =>
      a.subscriptionId < b.subscriptionId ? -1 : 1,
    );
    const reimbursement = f.api.receiveReimbursement(
      context,
      'across',
      reimbursementInput(f.juan.id, '20000'),
    );
    assert.deepEqual(
      reimbursement.allocations.map((item) => [
        item.paymentId,
        item.amount.minor,
      ]),
      [
        [sorted[0]!.id, 1500000n],
        [sorted[1]!.id, 500000n],
      ],
    );
    assert.equal(receivables(f).pending.minor, 1000000n);
    assert.equal(receivables(f, f.ana.id).pending.minor, 3000000n);
  } finally {
    f.store.close();
  }
});

test('subscriptions: participant revisions preserve earlier snapshots and receivables and only affect later periods', () => {
  const f = setup();
  try {
    const { subscription, obligation, payment } = paid(f);
    const change = f.api.changeParticipants(context, 'remove-ana', {
      subscriptionId: subscription.id,
      effectiveMonth: '2026-12',
      includesHolder: true,
      counterpartyIds: [f.juan.id],
    });
    const december = generate(f, subscription.id, '2026-12');
    assert.equal(december.versionId, change.id);
    assert.deepEqual(december.counterpartyIds, [f.juan.id]);
    assert.equal(obligation.versionId, subscription.id);
    assert.equal(obligation.counterpartyIds.length, 2);
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2027-01-31',
      }).payment!.id,
      payment.id,
    );
    const next = f.api.confirmPayment(
      context,
      'dec-paid',
      paymentInput(december.id, '45000', '2026-12-05'),
    );
    assert.equal(next.ownAmount.minor, 2250000n);
    assert.equal(receivables(f, f.ana.id).pending.minor, 1500000n);
    assert.equal(receivables(f).pending.minor, 3750000n);
    assert.throws(
      () =>
        f.api.changeParticipants(context, 'retroactive', {
          subscriptionId: subscription.id,
          effectiveMonth: '2026-12',
          includesHolder: true,
          counterpartyIds: [f.ana.id],
        }),
      { code: 'SUBSCRIPTION_PERIOD_REQUIRES_REVIEW' },
    );
    assert.equal(f.api.findIntent(context, 'retroactive'), undefined);
    assert.deepEqual(
      f.api.changeParticipants(context, 'remove-ana', {
        subscriptionId: subscription.id,
        effectiveMonth: '2026-12',
        includesHolder: true,
        counterpartyIds: [f.juan.id],
      }),
      change,
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: holder excluded records full cash and external shares with zero own consumption and no zero-valued Expense', () => {
  const f = setup();
  try {
    const subscription = f.api.createSubscription(context, 'no-holder', {
      ...createInput(f),
      includesHolder: false,
    });
    const obligation = generate(f, subscription.id);
    f.budgets.setBudget(context, 'zero-budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '0',
    });
    const payment = f.api.confirmPayment(
      context,
      'paid',
      paymentInput(obligation.id),
    );
    assert.equal(payment.status, 'confirmed');
    assert.equal(payment.ownAmount.minor, 0n);
    assert.equal(payment.expenseId, null);
    assert.equal(receivables(f).pending.minor, 2250000n);
    assert.equal(receivables(f, f.ana.id).pending.minor, 2250000n);
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      4500000n,
    );
    assert.equal(f.store.listExpenses(context).length, 0);
    assert.deepEqual(
      f.budgets.getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-11',
      }).alerts,
      [],
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: indivisible centavos create durable review without payment effects, receivables or budget alerts', () => {
  const f = setup();
  try {
    const subscription = shared(f, 'indivisible', '100.00'),
      obligation = generate(f, subscription.id);
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '1',
    });
    const draft = paymentInput(obligation.id, '100.00'),
      result = f.api.confirmPayment(context, 'review', draft);
    assert.equal(result.status, 'review_required');
    assert.equal(result.reviewReason, 'NON_DIVISIBLE_AMOUNT');
    assert.equal(result.expenseId, null);
    assert.equal(result.ownAmount.minor, 0n);
    assert.deepEqual(result.shares, []);
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2026-11-30',
      }).status,
      'pending',
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      0n,
    );
    assert.equal(receivables(f).pending.minor, 0n);
    assert.deepEqual(
      f.budgets.getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-11',
      }).alerts,
      [],
    );
    assert.deepEqual(f.api.confirmPayment(context, 'review', draft), result);
    f.store.close();
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = new SubscriptionService(reopened, f.policy, clock);
      assert.deepEqual(api.confirmPayment(context, 'review', draft), result);
      assert.equal(
        api.monthlyCashFlow(context, { month: '2026-11' }).payments.length,
        0,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.store.close();
  }
});

test('subscriptions: excess reimbursement is durable review and never partially settles or invents cash', () => {
  const f = setup();
  try {
    const { subscription } = paid(f);
    const input = reimbursementInput(f.juan.id, '15000.01'),
      review = f.api.receiveReimbursement(context, 'excess', input);
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_PENDING_BALANCE');
    assert.deepEqual(review.allocations, []);
    assert.equal(receivables(f).pending.minor, 1500000n);
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      0n,
    );
    const next = generate(f, subscription.id, '2026-12');
    f.api.confirmPayment(
      context,
      'next-paid',
      paymentInput(next.id, '45000', '2026-12-05'),
    );
    assert.deepEqual(
      f.api.receiveReimbursement(context, 'excess', input),
      review,
    );
    assert.equal(receivables(f).pending.minor, 3000000n);
  } finally {
    f.store.close();
  }
});

test('subscriptions: paid date governs consumption and cash, while billed month and explicit asOf remain distinct', () => {
  const f = setup();
  try {
    const subscription = shared(f),
      obligation = generate(f, subscription.id);
    f.api.confirmPayment(
      context,
      'december-payment',
      paymentInput(obligation.id, '45000', '2026-12-02'),
    );
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2026-11-30',
      }).status,
      'pending',
    );
    assert.equal(
      f.api.getObligation(context, {
        obligationId: obligation.id,
        asOf: '2026-12-02',
      }).status,
      'paid',
    );
    assert.equal(receivables(f, f.juan.id, '2026-11-30').pending.minor, 0n);
    assert.equal(receivables(f).periods[0]!.month, '2026-11');
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-12' }).total.minor,
      1500000n,
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-12' }).outflow.minor,
      4500000n,
    );
    assert.throws(
      () =>
        f.api.getObligation(context, {
          obligationId: obligation.id,
          asOf: '2026-10-31',
        }),
      { code: 'SUBSCRIPTION_OBLIGATION_NOT_FOUND' },
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: retroactive reimbursement and retroactive payment cannot rewrite already confirmed FIFO assignments', () => {
  const f = setup();
  try {
    const subscription = shared(f),
      december = generate(f, subscription.id, '2026-12');
    f.api.confirmPayment(
      context,
      'dec-paid',
      paymentInput(december.id, '45000', '2026-12-05'),
    );
    const received = f.api.receiveReimbursement(
      context,
      'jan-received',
      reimbursementInput(f.juan.id, '10000', '2027-01-05'),
    );
    const earlier = f.api.receiveReimbursement(
      context,
      'backdate-reimbursement',
      reimbursementInput(f.juan.id, '1', '2027-01-04'),
    );
    assert.equal(earlier.reviewReason, 'PAYMENT_DATE_REQUIRES_REVIEW');
    assert.deepEqual(earlier.allocations, []);
    const november = generate(f, subscription.id, '2026-11');
    const payment = f.api.confirmPayment(
      context,
      'backdate-payment',
      paymentInput(november.id),
    );
    assert.equal(payment.status, 'review_required');
    assert.equal(payment.reviewReason, 'PAYMENT_DATE_REQUIRES_REVIEW');
    assert.deepEqual(f.api.findIntent(context, 'jan-received'), received);
    assert.equal(receivables(f).pending.minor, 500000n);
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: greater-than-64-bit equal shares and centavo reimbursements survive restart exactly', () => {
  const f = setup();
  const amount = '27670116110564327424.51';
  const subscription = shared(f, 'huge', amount),
    obligation = generate(f, subscription.id);
  const payment = f.api.confirmPayment(
    context,
    'huge-pay',
    paymentInput(obligation.id, amount),
  );
  assert.equal(payment.ownAmount.minor, 922337203685477580817n);
  const reimbursed = f.api.receiveReimbursement(
    context,
    'centavo',
    reimbursementInput(f.juan.id, '0.01'),
  );
  f.store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new SubscriptionService(reopened, f.policy, clock);
    assert.equal(
      api.getReceivables(context, {
        counterpartyId: f.juan.id,
        asOf: '2026-11-30',
      }).pending.minor,
      922337203685477580816n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      2767011611056432742451n,
    );
    assert.deepEqual(api.findIntent(context, 'huge-pay'), payment);
    assert.deepEqual(api.findIntent(context, 'centavo'), reimbursed);
    assert.deepEqual(
      api.confirmPayment(
        context,
        'huge-pay',
        paymentInput(obligation.id, amount),
      ),
      payment,
    );
  } finally {
    reopened.close();
  }
});

interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; kind: string; status: string };
  code?: string;
}

test('subscriptions: each mutation replays its original identity and conflicts on changed financial content', () => {
  const f = setup();
  try {
    const input = createInput(f),
      subscription = f.api.createSubscription(context, 'new', input);
    assert.deepEqual(
      f.api.createSubscription(otherActorContext, 'new', {
        ...input,
        counterpartyIds: [...input.counterpartyIds].reverse(),
      }),
      subscription,
    );
    assert.throws(
      () =>
        f.api.createSubscription(context, 'new', { ...input, name: 'Changed' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const period = {
      subscriptionId: subscription.id,
      month: '2026-11',
      generatedOn: '2026-11-01',
    };
    const obligation = f.api.generateObligation(context, 'period', period);
    assert.deepEqual(
      f.api.generateObligation(context, 'period', period),
      obligation,
    );
    assert.throws(
      () =>
        f.api.generateObligation(context, 'period', {
          ...period,
          generatedOn: '2026-11-02',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const change = {
      subscriptionId: subscription.id,
      effectiveMonth: '2026-12',
      includesHolder: true,
      counterpartyIds: [f.juan.id],
    };
    const changed = f.api.changeParticipants(context, 'change', change);
    assert.deepEqual(
      f.api.changeParticipants(context, 'change', change),
      changed,
    );
    assert.throws(
      () =>
        f.api.changeParticipants(context, 'change', {
          ...change,
          includesHolder: false,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const pay = paymentInput(obligation.id),
      payment = f.api.confirmPayment(context, 'pay', pay);
    assert.deepEqual(f.api.confirmPayment(context, 'pay', pay), payment);
    assert.throws(
      () =>
        f.api.confirmPayment(context, 'pay', { ...pay, reference: 'changed' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const refund = reimbursementInput(f.juan.id, '10000'),
      received = f.api.receiveReimbursement(context, 'refund', refund);
    assert.deepEqual(
      f.api.receiveReimbursement(context, 'refund', refund),
      received,
    );
    assert.throws(
      () =>
        f.api.receiveReimbursement(context, 'refund', {
          ...refund,
          amount: '1',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).payments.length,
      1,
    );
    assert.equal(receivables(f).pending.minor, 500000n);
  } finally {
    f.store.close();
  }
});

test('subscriptions: global financial intent namespace conflicts in both directions without leaking other-domain results', () => {
  const f = setup();
  try {
    const subscription = shared(f);
    assert.throws(
      () => f.api.createSubscription(context, 'category', createInput(f)),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () => f.api.createSubscription(context, 'juan', createInput(f)),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        f.expenses.createCategory(context, 'subscription', {
          name: 'collision',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        f.loans.createCounterparty(context, 'subscription', {
          name: 'collision',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.api.findIntent(context, 'juan'), undefined);
    assert.equal(f.api.findIntent(context, 'category'), undefined);
    assert.equal(f.loans.findIntent(context, 'subscription'), undefined);
    assert.deepEqual(f.api.findIntent(context, 'subscription'), subscription);
  } finally {
    f.store.close();
  }
});

test('subscriptions: all reads and writes isolate subject and instance while another authorized actor may replay original audit', () => {
  const f = setup();
  try {
    const { obligation, payment } = paid(f);
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.equal(f.api.findIntent(foreign, 'paid'), undefined);
      assert.equal(
        f.api.listObligations(foreign, { asOf: '2026-11-30' }).obligations
          .length,
        0,
      );
      assert.equal(
        f.api.monthlyCashFlow(foreign, { month: '2026-11' }).outflow.minor,
        0n,
      );
      assert.throws(
        () =>
          f.api.getObligation(foreign, {
            obligationId: obligation.id,
            asOf: '2026-11-30',
          }),
        { code: 'SUBSCRIPTION_OBLIGATION_NOT_FOUND' },
      );
      assert.throws(
        () =>
          f.api.confirmPayment(foreign, 'paid', paymentInput(obligation.id)),
        { code: 'SUBSCRIPTION_OBLIGATION_NOT_FOUND' },
      );
      assert.throws(
        () =>
          f.api.getReceivables(foreign, {
            counterpartyId: f.juan.id,
            asOf: '2026-11-30',
          }),
        { code: 'SUBSCRIPTION_COUNTERPARTY_NOT_FOUND' },
      );
      const category = f.expenses.createCategory(foreign, 'category', {
        name: 'Synthetic foreign',
      });
      assert.throws(
        () =>
          f.api.createSubscription(foreign, 'foreign', {
            ...createInput(f),
            categoryId: category.id,
          }),
        { code: 'SUBSCRIPTION_COUNTERPARTY_NOT_FOUND' },
      );
    }
    assert.deepEqual(
      f.api.confirmPayment(
        otherActorContext,
        'paid',
        paymentInput(obligation.id),
      ),
      payment,
    );
    assert.equal(payment.actorRef, context.actorRef);
  } finally {
    f.store.close();
  }
});

test('subscriptions: permissions are revalidated before every replay and read, and untrusted payload identity is rejected', () => {
  const f = setup();
  try {
    const { obligation } = paid(f);
    const refund = reimbursementInput(f.juan.id, '10000');
    f.api.receiveReimbursement(context, 'refund', refund);
    for (const [action, invoke] of [
      ['subscription:write', () => shared(f)],
      [
        'subscription:pay',
        () =>
          f.api.confirmPayment(context, 'paid', paymentInput(obligation.id)),
      ],
      [
        'subscription:receive',
        () => f.api.receiveReimbursement(context, 'refund', refund),
      ],
      ['subscription:read', () => f.api.findIntent(context, 'paid')],
    ] as const) {
      f.actions.delete(action);
      assert.throws(invoke, { code: 'FORBIDDEN' });
      f.actions.add(action);
    }
    const denied = new SubscriptionService(
      f.store,
      { allows: () => false },
      clock,
    );
    for (const invoke of [
      () =>
        denied.getObligation(context, {
          obligationId: obligation.id,
          asOf: '2026-11-30',
        }),
      () => denied.listObligations(context, { asOf: '2026-11-30' }),
      () =>
        denied.getReceivables(context, {
          counterpartyId: f.juan.id,
          asOf: '2026-11-30',
        }),
      () => denied.monthlyCashFlow(context, { month: '2026-11' }),
    ])
      assert.throws(invoke, { code: 'FORBIDDEN' });
    assert.throws(
      () =>
        f.api.createSubscription(
          { ...context, actorRef: 'unbound' },
          'bad',
          createInput(f),
        ),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        f.api.confirmPayment(
          context,
          'bad',
          Object.assign(paymentInput(obligation.id), { actorRef: 'injected' }),
        ),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(f.api.findIntent(context, 'bad'), undefined);
  } finally {
    f.store.close();
  }
});

test('subscriptions: malformed groups, foreign categories, nonpositive amounts, wrong currency and invalid dates do not write', () => {
  const f = setup();
  try {
    for (const input of [
      { ...createInput(f), counterpartyIds: [f.juan.id, f.juan.id] },
      { ...createInput(f), includesHolder: false, counterpartyIds: [] },
      { ...createInput(f, 'personal'), counterpartyIds: [f.juan.id] },
      { ...createInput(f), monthlyAmount: '0' },
      { ...createInput(f), monthlyAmount: '-1' },
      { ...createInput(f), currency: 'USD' },
      { ...createInput(f), effectiveMonth: '2026-13' },
      { ...createInput(f), categoryId: f.juan.id },
    ])
      assert.throws(() => f.api.createSubscription(context, 'invalid', input));
    assert.equal(f.api.findIntent(context, 'invalid'), undefined);
    const subscription = shared(f),
      obligation = generate(f, subscription.id);
    assert.throws(
      () =>
        f.api.confirmPayment(
          context,
          'wrong-total',
          paymentInput(obligation.id, '44999'),
        ),
      { code: 'SUBSCRIPTION_AMOUNT_MISMATCH' },
    );
    assert.throws(() =>
      f.api.confirmPayment(
        context,
        'invalid-date',
        paymentInput(obligation.id, '45000', '2026-02-30'),
      ),
    );
    assert.throws(
      () =>
        f.api.confirmPayment(
          context,
          'before-period',
          paymentInput(obligation.id, '45000', '2026-10-31'),
        ),
      { code: 'INVALID_SUBSCRIPTION_PAYMENT_DATE' },
    );
    assert.equal(
      f.api.monthlyCashFlow(context, { month: '2026-11' }).payments.length,
      0,
    );
  } finally {
    f.store.close();
  }
});

test('subscriptions: linked consumption cannot be corrected independently from its payment and shares', () => {
  const f = setup();
  try {
    const { payment } = paid(f);
    assert.throws(
      () =>
        new ExpenseCorrectionsService(f.store, f.policy, clock).voidExpense(
          context,
          'void',
          { expenseId: payment.expenseId!, reason: 'synthetic mistake' },
        ),
      { code: 'SUBSCRIPTION_PAYMENT_CORRECTION_REQUIRED' },
    );
    assert.equal(f.api.findIntent(context, 'void'), undefined);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      1500000n,
    );
    assert.equal(receivables(f).pending.minor, 1500000n);
  } finally {
    f.store.close();
  }
});

test('subscriptions: reimbursements leave earned and received salary, principal loans, consumption and budget events unchanged', () => {
  const f = setup();
  try {
    const salary = new SalaryService(f.store, f.policy, clock),
      events = new EventDeliveryService(f.store, f.policy, clock);
    salary.configureSalary(context, 'salary', {
      netAmount: '3000000',
      effectiveFrom: '2026-10-01',
    });
    salary.closePeriod(context, 'close', {
      month: '2026-10',
      closedOn: '2026-11-01',
    });
    salary.receivePayment(context, 'salary-paid', {
      amount: '800000',
      receivedOn: '2026-11-02',
      reference: 'synthetic',
    });
    f.loans.recordDisbursement(context, 'loan', {
      counterpartyId: f.juan.id,
      direction: 'receivable',
      amount: '200000',
      occurredOn: '2026-11-01',
      reference: 'synthetic',
    });
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '18750',
    });
    paid(f);
    const snapshot = () =>
      encoded({
        salary: salary.getReceivables(context, { asOf: '2026-11-30' }),
        salaryCash: salary.monthlyCashInflow(context, { month: '2026-11' }),
        loan: f.loans.listPositions(context, { asOf: '2026-11-30' }),
        loanCash: f.loans.monthlyCashFlow(context, { month: '2026-11' }),
        consumption: f.expenses.monthlyTotals(context, { month: '2026-11' }),
        budget: f.budgets.getBudgetStatus(context, {
          categoryId: f.category.id,
          month: '2026-11',
        }),
        events: events.listPending(context),
      });
    const before = snapshot();
    f.api.receiveReimbursement(
      context,
      'juan-refund',
      reimbursementInput(f.juan.id, '15000'),
    );
    assert.deepEqual(snapshot(), before);
    assert.equal(receivables(f).pending.minor, 0n);
    assert.equal(
      f.loans.listPositions(context, { asOf: '2026-11-30' }).totalReceivable
        .minor,
      20000000n,
    );
  } finally {
    f.store.close();
  }
});

for (const hook of [
  'afterSubscriptionRecordInsert',
  'afterSubscriptionExpenseInsert',
  'afterAlertInsert',
] as const) {
  test(`subscriptions: ${hook} rolls back payment, consumption, shares, intent and alerts together`, () => {
    const f = setup(),
      subscription = shared(f),
      obligation = generate(f, subscription.id);
    f.budgets.setBudget(context, 'budget', {
      categoryId: f.category.id,
      month: '2026-11',
      amount: '18750',
    });
    f.store.close();
    const broken = new SqliteExpenseStore(f.path, {
      [hook]: () => {
        throw new Error('synthetic failure');
      },
    });
    const api = new SubscriptionService(broken, f.policy, clock);
    assert.throws(
      () => api.confirmPayment(context, 'pay', paymentInput(obligation.id)),
      { code: 'STORAGE_IO' },
    );
    assert.equal(api.findIntent(context, 'pay'), undefined);
    assert.equal(
      api.getReceivables(context, {
        counterpartyId: f.juan.id,
        asOf: '2026-11-30',
      }).pending.minor,
      0n,
    );
    assert.equal(broken.listExpenses(context).length, 0);
    assert.deepEqual(
      new MonthlyBudgetService(broken, f.policy).getBudgetStatus(context, {
        categoryId: f.category.id,
        month: '2026-11',
      }).alerts,
      [],
    );
    broken.close();
    const recovered = new SqliteExpenseStore(f.path);
    try {
      const result = new SubscriptionService(
        recovered,
        f.policy,
        clock,
      ).confirmPayment(context, 'pay', paymentInput(obligation.id));
      assert.equal(result.status, 'confirmed');
      assert.equal(recovered.listExpenses(context).length, 1);
    } finally {
      recovered.close();
    }
  });
}

test('subscriptions: allocation failure rolls back the entire FIFO reimbursement and preserves all pending shares', () => {
  const f = setup(),
    { subscription } = paid(f),
    december = generate(f, subscription.id, '2026-12');
  f.api.confirmPayment(
    context,
    'dec-paid',
    paymentInput(december.id, '45000', '2026-12-05'),
  );
  f.store.close();
  const broken = new SqliteExpenseStore(f.path, {
    afterSubscriptionAllocationInsert: () => {
      throw new Error('synthetic allocation failure');
    },
  });
  const api = new SubscriptionService(broken, f.policy, clock),
    input = reimbursementInput(f.juan.id, '20000', '2027-01-05');
  assert.throws(() => api.receiveReimbursement(context, 'refund', input), {
    code: 'STORAGE_IO',
  });
  assert.equal(api.findIntent(context, 'refund'), undefined);
  assert.equal(
    api.getReceivables(context, {
      counterpartyId: f.juan.id,
      asOf: '2027-01-31',
    }).pending.minor,
    3000000n,
  );
  assert.equal(
    api.monthlyCashFlow(context, { month: '2027-01' }).inflow.minor,
    0n,
  );
  broken.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const result = new SubscriptionService(
      reopened,
      f.policy,
      clock,
    ).receiveReimbursement(context, 'refund', input);
    assert.equal(result.allocations.length, 2);
  } finally {
    reopened.close();
  }
});

test('subscriptions: a lost postcommit response is recovered after reopening with the same intention and no duplicated effect', () => {
  const f = setup(),
    subscription = shared(f),
    obligation = generate(f, subscription.id);
  f.store.close();
  const broken = new SqliteExpenseStore(f.path, {
    afterSubscriptionCommit: () => {
      throw new Error('synthetic response lost');
    },
  });
  const input = paymentInput(obligation.id),
    api = new SubscriptionService(broken, f.policy, clock);
  assert.throws(() => api.confirmPayment(context, 'uncertain', input), {
    code: 'STORAGE_IO',
  });
  const committed = api.findIntent(context, 'uncertain');
  assert.ok(committed);
  assert.deepEqual(api.confirmPayment(context, 'uncertain', input), committed);
  broken.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const recovered = new SubscriptionService(reopened, f.policy, clock);
    assert.deepEqual(
      recovered.confirmPayment(context, 'uncertain', input),
      committed,
    );
    assert.equal(
      recovered.monthlyCashFlow(context, { month: '2026-11' }).payments.length,
      1,
    );
    assert.equal(reopened.listExpenses(context).length, 1);
    assert.equal(
      recovered.getReceivables(context, {
        counterpartyId: f.juan.id,
        asOf: '2026-11-30',
      }).pending.minor,
      1500000n,
    );
  } finally {
    reopened.close();
  }
});

test('subscriptions: a separate restored backup preserves snapshots, own expense links, shares, FIFO allocations and replay', () => {
  const f = setup(),
    { subscription, obligation, payment } = paid(f),
    december = generate(f, subscription.id, '2026-12');
  f.api.confirmPayment(
    context,
    'dec-paid',
    paymentInput(december.id, '45000', '2026-12-05'),
  );
  const input = reimbursementInput(f.juan.id, '20000', '2027-01-05'),
    refund = f.api.receiveReimbursement(context, 'refund', input);
  const before = encoded(receivables(f));
  const backup = pathFor(),
    restoredPath = pathFor();
  f.store.backupTo(backup);
  f.api.receiveReimbursement(
    context,
    'after-backup',
    reimbursementInput(f.juan.id, '1', '2027-01-06'),
  );
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restoredPath);
  const restored = new SqliteExpenseStore(restoredPath);
  try {
    const api = new SubscriptionService(restored, f.policy, clock);
    assert.deepEqual(
      encoded(
        api.getReceivables(context, {
          counterpartyId: f.juan.id,
          asOf: '2027-01-31',
        }),
      ),
      before,
    );
    assert.deepEqual(
      api.receiveReimbursement(context, 'refund', input),
      refund,
    );
    assert.deepEqual(
      api.confirmPayment(context, 'paid', paymentInput(obligation.id)),
      payment,
    );
    assert.equal(api.findIntent(context, 'after-backup'), undefined);
    assert.equal(restored.listExpenses(context).length, 2);
    assert.equal(
      api.monthlyCashFlow(context, { month: '2027-01' }).inflow.minor,
      2000000n,
    );
  } finally {
    restored.close();
  }
});

for (const scenario of [
  'same-intention',
  'conflicting-payload',
  'same-obligation',
] as const) {
  test(`subscriptions processes: ${scenario} produces exactly one payment and consumption component`, async () => {
    const f = setup(),
      subscription = shared(f),
      obligation = generate(f, subscription.id);
    f.store.close();
    const input = paymentInput(obligation.id);
    const replies = await race(f.path, [
      { key: 'pay', operation: 'pay', input },
      {
        key: scenario === 'same-obligation' ? 'other-pay' : 'pay',
        operation: 'pay',
        input:
          scenario === 'conflicting-payload'
            ? { ...input, reference: 'other-reference' }
            : input,
      },
    ]);
    const successes = replies.filter((reply) => reply.type === 'result');
    if (scenario === 'same-intention') {
      assert.equal(successes.length, 2);
      assert.equal(successes[0]!.result!.id, successes[1]!.result!.id);
    } else {
      assert.equal(successes.length, 1);
      assert.equal(
        replies.find((reply) => reply.type === 'error')?.code,
        scenario === 'conflicting-payload'
          ? 'IDEMPOTENCY_CONFLICT'
          : 'SUBSCRIPTION_ALREADY_PAID',
      );
    }
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = new SubscriptionService(reopened, f.policy, clock);
      assert.equal(
        api.monthlyCashFlow(context, { month: '2026-11' }).payments.length,
        1,
      );
      assert.equal(
        api.getReceivables(context, {
          counterpartyId: f.juan.id,
          asOf: '2026-11-30',
        }).pending.minor,
        1500000n,
      );
      assert.equal(reopened.listExpenses(context).length, 1);
    } finally {
      reopened.close();
    }
  });
}

test('subscriptions processes: concurrent reimbursements cannot over-allocate the same receivable', async () => {
  const f = setup();
  paid(f);
  f.store.close();
  const input = reimbursementInput(f.juan.id, '10000');
  const replies = await race(f.path, [
    { key: 'refund-a', operation: 'receive', input },
    { key: 'refund-b', operation: 'receive', input },
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.type),
    ['result', 'result'],
  );
  assert.deepEqual(replies.map((reply) => reply.result!.status).sort(), [
    'confirmed',
    'review_required',
  ]);
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new SubscriptionService(reopened, f.policy, clock);
    assert.equal(
      api.getReceivables(context, {
        counterpartyId: f.juan.id,
        asOf: '2026-11-30',
      }).pending.minor,
      500000n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      1000000n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).reimbursements.length,
      1,
    );
  } finally {
    reopened.close();
  }
});
async function race(
  path: string,
  jobs: readonly { key: string; operation: 'pay' | 'receive'; input: object }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/subscription-worker.ts', import.meta.url),
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
      const error = new Error('Synthetic subscription worker timed out');
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
        const error = new Error(
          `Subscription worker exited without result (${code})`,
        );
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
