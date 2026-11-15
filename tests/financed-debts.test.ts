import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { Money } from '../src/domain/money.ts';
import {
  buildDebtStatus,
  decidePayment,
  validateDebtDraft,
} from '../src/domain/financed-debts.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'financed-debt-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'debts-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const clock = () => '2026-11-14T12:00:00.000Z';
const opening = {
  description: 'Synthetic iPhone purchase',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-11-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
  historicalPaidAmount: '2000000',
};
const payment = {
  installmentNumber: 9,
  amount: '250000',
  paidOn: '2026-11-14',
  reference: 'synthetic-payment-9',
};
function setup() {
  const path = pathFor();
  const store = new SqliteExpenseStore(path);
  const actions = new Set<Action>([
    'category:create',
    'expense:record',
    'expense:read',
    'expense:correct',
    'budget:write',
    'budget:read',
    'event:read',
    'event:ack',
    'debt:write',
    'debt:pay',
    'debt:read',
  ]);
  const allowed = [
    context,
    otherSubjectContext,
    otherInstanceContext,
    otherActorContext,
  ];
  const policy: AccessPolicy = {
    allows(candidate, action) {
      return (
        actions.has(action) &&
        allowed.some(
          (bound) =>
            bound.actorRef === candidate.actorRef &&
            bound.instanceRef === candidate.instanceRef &&
            bound.subjectRef === candidate.subjectRef,
        )
      );
    },
  };
  const debts = new FinancedDebtService(store, policy, clock);
  return { path, store, actions, policy, debts };
}
function encoded(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; status: string };
  code?: string;
}
async function race(
  path: string,
  debtId: string,
  jobs: readonly { key: string; amount: string; installmentNumber?: number }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/debt-worker.ts', import.meta.url),
      [path, job.key, debtId, job.amount, String(job.installmentNumber ?? 9)],
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
      const error = new Error('Synthetic debt worker timed out');
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
        const error = new Error(`Debt worker exited without result (${code})`);
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

test('financed debt: iPhone opening, eight historical installments and one confirmed payment never inflate consumption', () => {
  const f = setup();
  try {
    const expenses = new ExpenseService(f.store, f.policy),
      budgets = new MonthlyBudgetService(f.store, f.policy),
      events = new EventDeliveryService(f.store, f.policy);
    const category = expenses.createCategory(context, 'category', {
      name: 'Synthetic shopping',
    });
    budgets.setBudget(context, 'budget', {
      categoryId: category.id,
      month: '2026-11',
      amount: '100000',
    });
    const debt = f.debts.registerDebt(context, 'opening', opening);
    const before = f.debts.getDebt(context, debt.id);
    assert.equal(before.estimatedBalance.minor, 400000000n);
    assert.equal(before.confirmedPaymentsTotal.minor, 0n);
    assert.equal(before.payments.length, 0);
    assert.equal(
      before.installments.filter((item) => item.status === 'historical').length,
      8,
    );
    assert.equal(
      before.installments.filter((item) => item.status === 'pending').length,
      16,
    );
    assert.ok(
      before.installments
        .slice(0, 8)
        .every((item) => item.paid === null && item.pending === null),
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    const result = f.debts.confirmPayment(context, 'payment', {
      ...payment,
      debtId: debt.id,
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.reviewReason, null);
    assert.equal(result.estimatedBalanceAfter.minor, 375000000n);
    const status = f.debts.getDebt(context, debt.id);
    assert.equal(status.balanceKind, 'estimated');
    assert.equal(status.principalBalance, null);
    assert.equal(status.interestPaid, null);
    assert.equal(status.confirmedPaymentsTotal.minor, 25000000n);
    assert.equal(
      status.installments.find((item) => item.number === 9)?.status,
      'paid',
    );
    assert.equal(
      status.installments.filter((item) => item.status === 'pending').length,
      15,
    );
    assert.deepEqual(status.payments, [result]);
    const cash = f.debts.monthlyCashOutflow(context, { month: '2026-11' });
    assert.equal(cash.total.minor, 25000000n);
    assert.deepEqual(cash.payments, [result]);
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      budgets.getBudgetStatus(context, {
        categoryId: category.id,
        month: '2026-11',
      }).consumed.minor,
      0n,
    );
    assert.deepEqual(events.listPending(context).events, []);
    assert.deepEqual(
      f.debts.confirmPayment(context, 'payment', {
        ...payment,
        debtId: debt.id,
      }),
      result,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      25000000n,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt domain: exact balance and installment boundary distinguish confirmation from review', () => {
  const minor = 10n ** 30n + 1n;
  const debt = Object.freeze({
    ...validateDebtDraft({
      kind: 'financed-debt',
      description: 'Synthetic pure debt',
      financedAmount: Money.fromMinor(minor),
      installmentCount: 1,
      installmentAmount: Money.fromMinor(minor),
      referenceOn: '2026-11-01',
      referenceBalance: Money.fromMinor(minor),
      historicalPaidInstallments: 0,
      historicalPaidAmount: null,
      annualEffectiveRate: null,
      terms: null,
      actorRef: context.actorRef,
      recordedAt: clock(),
    }),
    id: 'synthetic-debt',
  });
  const status = buildDebtStatus(debt, []);
  const draft = {
    debtId: debt.id,
    installmentNumber: 1,
    amount: Money.fromMinor(minor),
    paidOn: '2026-11-14',
    reference: 'synthetic-payment',
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
  const exact = decidePayment(debt, status, draft);
  assert.equal(exact.status, 'confirmed');
  assert.equal(exact.estimatedBalanceAfter.minor, 0n);
  const excess = decidePayment(debt, status, {
    ...draft,
    amount: Money.fromMinor(minor + 1n),
  });
  assert.equal(excess.status, 'review_required');
  assert.equal(excess.reviewReason, 'EXCEEDS_ESTIMATED_BALANCE');
  assert.equal(excess.estimatedBalanceAfter.minor, minor);
  assert.equal(status.estimatedBalance.minor, minor);
  const closed = buildDebtStatus(debt, [
    { ...draft, ...exact, id: 'synthetic-payment-id', kind: 'debt-payment' },
  ]);
  assert.equal(closed.requiresReview, false);
  assert.equal(closed.installments[0]?.status, 'paid');
});

test('financed debt: unknown interest and historical disbursement remain unknown instead of invented', () => {
  const f = setup();
  try {
    const { historicalPaidAmount: omitted, ...input } = opening;
    assert.ok(omitted);
    const debt = f.debts.registerDebt(context, 'opening', input);
    assert.equal(debt.annualEffectiveRate, null);
    assert.equal(debt.historicalPaidAmount, null);
    assert.equal(debt.terms, null);
    assert.equal(debt.historicalPaidInstallments, 8);
    assert.equal(f.debts.getDebt(context, debt.id).principalBalance, null);
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: exact E.A. and supplied conditions are preserved without fabricated amortization', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', {
      ...opening,
      annualEffectiveRate: '12.340000',
      terms: 'Synthetic variable fees not itemized',
    });
    assert.equal(debt.annualEffectiveRate, '12.34');
    assert.equal(debt.terms, 'Synthetic variable fees not itemized');
    const paid = f.debts.confirmPayment(context, 'payment', {
      ...payment,
      debtId: debt.id,
    });
    assert.equal(paid.estimatedBalanceAfter.minor, 375000000n);
    const state = f.debts.getDebt(context, debt.id);
    assert.equal(state.balanceKind, 'estimated');
    assert.equal(state.interestPaid, null);
    assert.equal(state.principalBalance, null);
    assert.deepEqual(
      f.debts.registerDebt(context, 'opening', {
        ...opening,
        annualEffectiveRate: '12.34',
        terms: 'Synthetic variable fees not itemized',
      }),
      debt,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: partial payments complete only their explicitly selected installment', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    f.debts.confirmPayment(context, 'partial-one', {
      ...payment,
      debtId: debt.id,
      amount: '100000',
    });
    let quota = f.debts
      .getDebt(context, debt.id)
      .installments.find((item) => item.number === 9);
    assert.equal(quota?.status, 'partial');
    assert.equal(quota?.paid?.minor, 10000000n);
    assert.equal(quota?.pending?.minor, 15000000n);
    f.debts.confirmPayment(context, 'partial-two', {
      ...payment,
      debtId: debt.id,
      amount: '150000',
      reference: 'synthetic-partial-two',
    });
    quota = f.debts
      .getDebt(context, debt.id)
      .installments.find((item) => item.number === 9);
    assert.equal(quota?.status, 'paid');
    assert.equal(quota?.pending?.minor, 0n);
    assert.equal(
      f.debts
        .getDebt(context, debt.id)
        .installments.find((item) => item.number === 10)?.paid?.minor,
      0n,
    );
    assert.equal(
      f.debts.getDebt(context, debt.id).confirmedPaymentsTotal.minor,
      25000000n,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: payment month uses its explicit civil date and opening history is never current cash', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    f.debts.confirmPayment(context, 'november', {
      ...payment,
      debtId: debt.id,
      paidOn: '2026-11-01',
    });
    f.debts.confirmPayment(context, 'december', {
      ...payment,
      debtId: debt.id,
      installmentNumber: 10,
      paidOn: '2026-12-01',
    });
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-10' }).total.minor,
      0n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      25000000n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-12' }).total.minor,
      25000000n,
    );
    assert.throws(
      () =>
        f.debts.confirmPayment(context, 'before-opening', {
          ...payment,
          debtId: debt.id,
          paidOn: '2026-10-31',
        }),
      { code: 'INVALID_PAYMENT' },
    );
    assert.equal(f.debts.findIntent(context, 'before-opening'), undefined);
  } finally {
    f.store.close();
  }
});

test('financed debt: overpayment returns a durable review result without cash or balance change', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', {
      ...opening,
      referenceBalance: '100000',
    });
    const review = f.debts.confirmPayment(context, 'excess', {
      ...payment,
      debtId: debt.id,
    });
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_ESTIMATED_BALANCE');
    assert.equal(review.estimatedBalanceAfter.minor, 10000000n);
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.debts.getDebt(context, debt.id).estimatedBalance.minor,
      10000000n,
    );
    assert.equal(
      f.debts
        .getDebt(context, debt.id)
        .installments.find((item) => item.number === 9)?.paid?.minor,
      0n,
    );
    const accepted = f.debts.confirmPayment(context, 'accepted', {
      ...payment,
      debtId: debt.id,
      amount: '100000',
    });
    assert.equal(accepted.estimatedBalanceAfter.minor, 0n);
    assert.deepEqual(
      f.debts.confirmPayment(context, 'excess', {
        ...payment,
        debtId: debt.id,
      }),
      review,
    );
    assert.equal(f.debts.getDebt(context, debt.id).payments.length, 2);
    assert.equal(f.debts.getDebt(context, debt.id).requiresReview, true);
  } finally {
    f.store.close();
  }
});

test('financed debt: excess for one installment is not automatically distributed to the next', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    f.debts.confirmPayment(context, 'partial', {
      ...payment,
      debtId: debt.id,
      amount: '200000',
    });
    const review = f.debts.confirmPayment(context, 'excess', {
      ...payment,
      debtId: debt.id,
      amount: '60000',
    });
    assert.equal(review.reviewReason, 'EXCEEDS_INSTALLMENT_REMAINDER');
    assert.equal(review.status, 'review_required');
    assert.equal(
      f.debts.getDebt(context, debt.id).estimatedBalance.minor,
      380000000n,
    );
    assert.equal(
      f.debts
        .getDebt(context, debt.id)
        .installments.find((item) => item.number === 10)?.paid?.minor,
      0n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      20000000n,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: contradictory reported opening remains explicit and requires review', () => {
  const f = setup();
  try {
    const complete = f.debts.registerDebt(context, 'complete', {
      ...opening,
      historicalPaidInstallments: 24,
    });
    assert.equal(f.debts.getDebt(context, complete.id).requiresReview, true);
    const unallocated = f.debts.registerDebt(context, 'unallocated', {
      ...opening,
      historicalPaidInstallments: 0,
    });
    assert.equal(f.debts.getDebt(context, unallocated.id).requiresReview, true);
    assert.equal(
      f.debts
        .getDebt(context, unallocated.id)
        .installments.filter((item) => item.status === 'historical').length,
      0,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: retry preserves original identity, actor, time and decision while changed payload conflicts', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    const result = f.debts.confirmPayment(context, 'payment', {
      ...payment,
      debtId: debt.id,
    });
    const later = new FinancedDebtService(
      f.store,
      f.policy,
      () => '2027-01-01T00:00:00.000Z',
    );
    assert.deepEqual(
      later.registerDebt(otherActorContext, 'opening', {
        ...opening,
        financedAmount: '4800000.00',
        currency: 'COP',
      }),
      debt,
    );
    assert.deepEqual(
      later.confirmPayment(otherActorContext, 'payment', {
        ...payment,
        debtId: debt.id,
        amount: '250000.00',
        currency: 'COP',
      }),
      result,
    );
    for (const input of [
      { ...payment, debtId: debt.id, amount: '1' },
      { ...payment, debtId: debt.id, reference: 'changed' },
      { ...payment, debtId: debt.id, installmentNumber: 10 },
    ])
      assert.throws(() => later.confirmPayment(context, 'payment', input), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    assert.throws(
      () =>
        later.registerDebt(context, 'opening', {
          ...opening,
          referenceBalance: '1',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.debts.getDebt(context, debt.id).payments.length, 1);
  } finally {
    f.store.close();
  }
});

test('financed debt: invalid openings fail before consuming the intention', () => {
  const f = setup();
  try {
    for (const input of [
      { ...opening, description: '' },
      { ...opening, financedAmount: '0' },
      { ...opening, installmentAmount: '0' },
      { ...opening, installmentCount: 0 },
      { ...opening, installmentCount: 1.5 },
      { ...opening, installmentCount: 1201 },
      { ...opening, historicalPaidInstallments: 25 },
      { ...opening, historicalPaidInstallments: -1 },
      { ...opening, referenceOn: '2026-02-30' },
      { ...opening, referenceBalance: '-1' },
      { ...opening, currency: 'USD' },
      { ...opening, subjectRef: 'editable' },
    ]) {
      assert.throws(() => f.debts.registerDebt(context, 'invalid', input));
      assert.equal(f.debts.findIntent(context, 'invalid'), undefined);
    }
    assert.equal(
      f.debts.registerDebt(context, 'invalid', opening).description,
      opening.description,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: noncanonical rates and unsafe precision are rejected; zero rate remains known zero', () => {
  const f = setup();
  try {
    for (const rate of [
      '-1',
      '1e2',
      ' 12',
      '1.0000001',
      'NaN',
      '01.2',
      '9'.repeat(101),
    ]) {
      assert.throws(
        () =>
          f.debts.registerDebt(context, 'rate', {
            ...opening,
            annualEffectiveRate: rate,
          }),
        { code: 'INVALID_RATE' },
      );
      assert.equal(f.debts.findIntent(context, 'rate'), undefined);
    }
    assert.equal(
      f.debts.registerDebt(context, 'rate', {
        ...opening,
        annualEffectiveRate: '0.000000',
      }).annualEffectiveRate,
      '0',
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: invalid payments and unconfirmed payloads have no financial effect', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    for (const input of [
      { ...payment, debtId: debt.id, amount: '0' },
      { ...payment, debtId: debt.id, amount: '-1' },
      { ...payment, debtId: debt.id, amount: '1.001' },
      { ...payment, debtId: debt.id, installmentNumber: 8 },
      { ...payment, debtId: debt.id, installmentNumber: 25 },
      { ...payment, debtId: debt.id, installmentNumber: 9.5 },
      { ...payment, debtId: debt.id, paidOn: '2026-13-01' },
      { ...payment, debtId: debt.id, reference: '' },
      { ...payment, debtId: debt.id, confirmed: false },
      { ...payment, debtId: debt.id, actorRef: 'editable' },
    ]) {
      assert.throws(() => f.debts.confirmPayment(context, 'invalid', input));
      assert.equal(f.debts.findIntent(context, 'invalid'), undefined);
    }
    assert.equal(
      f.debts.getDebt(context, debt.id).confirmedPaymentsTotal.minor,
      0n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).payments.length,
      0,
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: amounts above 64 bits stay exact and oversized amounts fail explicitly', () => {
  const f = setup();
  try {
    const amount = '1000000000000000000000000000000.01';
    const debt = f.debts.registerDebt(context, 'opening', {
      ...opening,
      financedAmount: amount,
      installmentAmount: amount,
      referenceBalance: amount,
    });
    const result = f.debts.confirmPayment(context, 'part', {
      ...payment,
      debtId: debt.id,
      amount: '0.01',
    });
    assert.equal(
      result.estimatedBalanceAfter.minor,
      100000000000000000000000000000000n,
    );
    assert.equal(
      f.debts.getDebt(context, debt.id).debt.referenceBalance.minor,
      100000000000000000000000000000001n,
    );
    assert.throws(
      () =>
        f.debts.registerDebt(context, 'huge', {
          ...opening,
          financedAmount: '1' + '0'.repeat(4096),
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(f.debts.findIntent(context, 'huge'), undefined);
    assert.throws(
      () =>
        f.debts.confirmPayment(context, 'huge-payment', {
          ...payment,
          debtId: debt.id,
          amount: '1' + '0'.repeat(4096),
        }),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal(f.debts.findIntent(context, 'huge-payment'), undefined);
  } finally {
    f.store.close();
  }
});

test('financed debt: instance and subject isolation applies to queries, mutations and intentions', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(() => f.debts.getDebt(foreign, debt.id), {
        code: 'DEBT_NOT_FOUND',
      });
      assert.throws(
        () =>
          f.debts.confirmPayment(foreign, 'payment', {
            ...payment,
            debtId: debt.id,
          }),
        { code: 'DEBT_NOT_FOUND' },
      );
      assert.equal(f.debts.findIntent(foreign, 'opening'), undefined);
      assert.equal(
        f.debts.monthlyCashOutflow(foreign, { month: '2026-11' }).total.minor,
        0n,
      );
      const own = f.debts.registerDebt(foreign, 'opening', opening);
      assert.notEqual(own.id, debt.id);
    }
    assert.equal(f.debts.getDebt(context, debt.id).payments.length, 0);
  } finally {
    f.store.close();
  }
});

test('financed debt: permission revocation prevents replay, payment and reads', () => {
  const f = setup();
  try {
    const debt = f.debts.registerDebt(context, 'opening', opening);
    f.debts.confirmPayment(context, 'payment', { ...payment, debtId: debt.id });
    f.actions.delete('debt:write');
    assert.throws(() => f.debts.registerDebt(context, 'opening', opening), {
      code: 'FORBIDDEN',
    });
    f.actions.delete('debt:pay');
    assert.throws(
      () =>
        f.debts.confirmPayment(context, 'payment', {
          ...payment,
          debtId: debt.id,
        }),
      { code: 'FORBIDDEN' },
    );
    f.actions.delete('debt:read');
    assert.throws(() => f.debts.getDebt(context, debt.id), {
      code: 'FORBIDDEN',
    });
    assert.throws(() => f.debts.findIntent(context, 'payment'), {
      code: 'FORBIDDEN',
    });
    assert.throws(
      () => f.debts.monthlyCashOutflow(context, { month: '2026-11' }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () => f.debts.getDebt({ ...context, actorRef: 'intruder' }, debt.id),
      { code: 'FORBIDDEN' },
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: shared intention namespace conflicts without leaking debt data through other readers', () => {
  const f = setup();
  try {
    const expenses = new ExpenseService(f.store, f.policy),
      corrections = new ExpenseCorrectionsService(f.store, f.policy),
      budgets = new MonthlyBudgetService(f.store, f.policy);
    const category = expenses.createCategory(context, 'category', {
      name: 'Synthetic category',
    });
    budgets.setBudget(context, 'budget', {
      categoryId: category.id,
      month: '2026-11',
      amount: '1',
    });
    const debt = f.debts.registerDebt(context, 'opening', opening);
    f.debts.confirmPayment(context, 'payment', { ...payment, debtId: debt.id });
    for (const key of ['opening', 'payment']) {
      assert.equal(expenses.findIntent(context, key), undefined);
      assert.equal(corrections.findIntent(context, key), undefined);
      assert.equal(budgets.findIntent(context, key), undefined);
    }
    for (const key of ['category', 'budget']) {
      assert.equal(f.debts.findIntent(context, key), undefined);
      assert.throws(() => f.debts.registerDebt(context, key, opening), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
    assert.throws(
      () =>
        expenses.recordExpense(context, 'payment', {
          categoryId: category.id,
          amount: '1',
          occurredOn: '2026-11-14',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        budgets.setBudget(context, 'opening', {
          categoryId: category.id,
          month: '2026-11',
          amount: '1',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.store.close();
  }
});

test('financed debt: failure after opening insert rolls back debt and intention and permits same key', () => {
  const f = setup();
  f.store.close();
  const failed = new SqliteExpenseStore(f.path, {
    afterDebtInsert: () => {
      throw new Error('Synthetic fault');
    },
  });
  try {
    const api = new FinancedDebtService(failed, f.policy, clock);
    assert.throws(() => api.registerDebt(context, 'opening', opening), {
      code: 'STORAGE_IO',
    });
    assert.equal(api.findIntent(context, 'opening'), undefined);
  } finally {
    failed.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new FinancedDebtService(reopened, f.policy, clock);
    const debt = api.registerDebt(context, 'opening', opening);
    assert.equal(
      api.getDebt(context, debt.id).estimatedBalance.minor,
      400000000n,
    );
  } finally {
    reopened.close();
  }
});

test('financed debt: failure after payment insert leaves balance, cash and key unchanged', () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  f.store.close();
  const failed = new SqliteExpenseStore(f.path, {
    afterDebtPaymentInsert: () => {
      throw new Error('Synthetic fault');
    },
  });
  try {
    const api = new FinancedDebtService(failed, f.policy, clock);
    assert.throws(
      () =>
        api.confirmPayment(context, 'payment', { ...payment, debtId: debt.id }),
      { code: 'STORAGE_IO' },
    );
    assert.equal(api.findIntent(context, 'payment'), undefined);
    assert.equal(
      api.getDebt(context, debt.id).estimatedBalance.minor,
      400000000n,
    );
    assert.equal(
      api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
  } finally {
    failed.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    assert.equal(
      new FinancedDebtService(reopened, f.policy, clock).confirmPayment(
        context,
        'payment',
        { ...payment, debtId: debt.id },
      ).status,
      'confirmed',
    );
  } finally {
    reopened.close();
  }
});

test('financed debt: lost response after commit recovers original opening and payment without duplicate cash', () => {
  const f = setup();
  f.store.close();
  const uncertain = new SqliteExpenseStore(f.path, {
    afterDebtCommit: () => {
      throw new Error('Synthetic lost response');
    },
  });
  let debtId: string;
  try {
    const api = new FinancedDebtService(uncertain, f.policy, clock);
    assert.throws(() => api.registerDebt(context, 'opening', opening), {
      code: 'STORAGE_IO',
    });
    const debt = api.registerDebt(context, 'opening', opening);
    debtId = debt.id;
    assert.throws(
      () => api.confirmPayment(context, 'payment', { ...payment, debtId }),
      { code: 'STORAGE_IO' },
    );
    const result = api.confirmPayment(context, 'payment', {
      ...payment,
      debtId,
    });
    assert.equal(result.status, 'confirmed');
    assert.equal(api.getDebt(context, debtId).payments.length, 1);
  } finally {
    uncertain.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new FinancedDebtService(reopened, f.policy, clock);
    assert.equal(api.registerDebt(context, 'opening', opening).id, debtId);
    assert.equal(
      api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      25000000n,
    );
  } finally {
    reopened.close();
  }
});

test('financed debt: restart and isolated restored backup preserve opening, payments and replay', () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  const first = f.debts.confirmPayment(context, 'payment', {
    ...payment,
    debtId: debt.id,
  });
  const snapshot = f.debts.getDebt(context, debt.id);
  const backup = pathFor(),
    restoredPath = pathFor();
  f.store.backupTo(backup);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restoredPath);
  for (const path of [f.path, restoredPath]) {
    const store = new SqliteExpenseStore(path);
    try {
      const api = new FinancedDebtService(store, f.policy, clock);
      assert.deepEqual(api.getDebt(context, debt.id), snapshot);
      assert.deepEqual(
        api.confirmPayment(context, 'payment', { ...payment, debtId: debt.id }),
        first,
      );
      assert.equal(
        api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
        25000000n,
      );
    } finally {
      store.close();
    }
  }
});

test('financed debt: read-only storage preserves projections and refuses payment mutations', () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  f.store.close();
  const store = new SqliteExpenseStore(f.path, { readOnly: true });
  try {
    const api = new FinancedDebtService(store, f.policy, clock);
    assert.equal(
      api.getDebt(context, debt.id).estimatedBalance.minor,
      400000000n,
    );
    assert.throws(
      () =>
        api.confirmPayment(context, 'payment', { ...payment, debtId: debt.id }),
      { code: 'STORAGE_READ_ONLY' },
    );
  } finally {
    store.close();
  }
});

test('financed debt: concurrent same-key retries produce one payment and one cash outflow', async () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  f.store.close();
  const replies = await race(f.path, debt.id, [
    { key: 'payment', amount: '250000' },
    { key: 'payment', amount: '250000.00' },
  ]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.deepEqual(replies[0]?.result, replies[1]?.result);
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new FinancedDebtService(reopened, f.policy, clock);
    assert.equal(api.getDebt(context, debt.id).payments.length, 1);
    assert.equal(
      api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      25000000n,
    );
    assert.deepEqual(
      encoded(api.findIntent(context, 'payment')),
      replies[0]?.result,
    );
  } finally {
    reopened.close();
  }
});

test('financed debt: concurrent conflicting retries select one original payment', async () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  f.store.close();
  const replies = await race(f.path, debt.id, [
    { key: 'payment', amount: '100000' },
    { key: 'payment', amount: '200000' },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.deepEqual(
    replies
      .filter((reply) => reply.type === 'error')
      .map((reply) => reply.code),
    ['IDEMPOTENCY_CONFLICT'],
  );
  const reopened = new SqliteExpenseStore(f.path);
  try {
    assert.equal(
      new FinancedDebtService(reopened, f.policy, clock).getDebt(
        context,
        debt.id,
      ).payments.length,
      1,
    );
  } finally {
    reopened.close();
  }
});

test('financed debt: concurrent payments cannot both consume the same remaining balance', async () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', {
    ...opening,
    referenceBalance: '250000',
  });
  f.store.close();
  const replies = await race(f.path, debt.id, [
    { key: 'one', amount: '200000', installmentNumber: 9 },
    { key: 'two', amount: '200000', installmentNumber: 10 },
  ]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.deepEqual(replies.map((reply) => reply.result?.status).sort(), [
    'confirmed',
    'review_required',
  ]);
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new FinancedDebtService(reopened, f.policy, clock);
    assert.equal(
      api.getDebt(context, debt.id).estimatedBalance.minor,
      5000000n,
    );
    assert.equal(
      api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      20000000n,
    );
    assert.equal(api.getDebt(context, debt.id).payments.length, 2);
  } finally {
    reopened.close();
  }
});

test('financed debt: concurrent distinct keys cannot overfill the same installment', async () => {
  const f = setup();
  const debt = f.debts.registerDebt(context, 'opening', opening);
  f.store.close();
  const replies = await race(f.path, debt.id, [
    { key: 'one', amount: '150000' },
    { key: 'two', amount: '150000' },
  ]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.deepEqual(replies.map((reply) => reply.result?.status).sort(), [
    'confirmed',
    'review_required',
  ]);
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new FinancedDebtService(reopened, f.policy, clock);
    const status = api.getDebt(context, debt.id);
    assert.equal(
      status.payments.find((item) => item.status === 'review_required')
        ?.reviewReason,
      'EXCEEDS_INSTALLMENT_REMAINDER',
    );
    assert.equal(
      status.installments.find((item) => item.number === 9)?.pending?.minor,
      10000000n,
    );
    assert.equal(status.estimatedBalance.minor, 385000000n);
    assert.equal(
      api.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      15000000n,
    );
  } finally {
    reopened.close();
  }
});
