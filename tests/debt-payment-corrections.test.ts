import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DebtPaymentCorrectionsService } from '../src/application/debt-payment-corrections-service.ts';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'debt-correction-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'corrections-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const clock = () => '2026-11-15T12:00:00.000Z';
const opening = {
  description: 'Synthetic iPhone',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-10-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
  historicalPaidAmount: '2000000',
};
const payment = {
  installmentNumber: 9,
  amount: '250000',
  paidOn: '2026-11-14',
  reference: 'synthetic-payment',
};
const corrected = {
  installmentNumber: 9,
  amount: '200000',
  currency: 'COP',
  paidOn: '2026-11-15',
  reference: 'synthetic-corrected',
};
const reason = 'Synthetic correction';
function services(store: SqliteExpenseStore, policy: AccessPolicy) {
  return {
    debts: new FinancedDebtService(store, policy, clock),
    corrections: new DebtPaymentCorrectionsService(store, policy, clock),
  };
}
function setup(input = opening) {
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
    'debt:correct',
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
        (item) =>
          item.actorRef === candidate.actorRef &&
          item.instanceRef === candidate.instanceRef &&
          item.subjectRef === candidate.subjectRef,
      ),
  };
  const api = services(store, policy);
  const debt = api.debts.registerDebt(context, 'opening', input);
  const original = api.debts.confirmPayment(context, 'payment', {
    ...payment,
    debtId: debt.id,
  });
  return { path, store, policy, actions, ...api, debt, original };
}
interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; status: string; replacement: { id: string } | null };
  code?: string;
}
async function race(
  path: string,
  paymentId: string,
  jobs: readonly { key: string; mode: 'void' | 'replace'; amount: string }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/debt-correction-worker.ts', import.meta.url),
      [path, job.key, paymentId, job.mode, job.amount],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let readyResolve!: () => void,
      readyReject!: (error: Error) => void,
      doneResolve!: (reply: Reply) => void,
      doneReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const done = new Promise<Reply>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    let reply: Reply | undefined;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('Synthetic correction worker timeout');
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
        const error = new Error(`Synthetic correction worker exit ${code}`);
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

test('debt correction: 250000 becomes 200000 with 3800000 estimated balance and one effective cash outflow', () => {
  const f = setup();
  try {
    const result = f.corrections.replacePayment(context, 'correct', {
      paymentId: f.original.id,
      reason,
      replacement: corrected,
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.estimatedBalanceAfter.minor, 380000000n);
    assert.equal(result.originalPaymentId, f.original.id);
    assert.ok(result.replacement);
    assert.notEqual(result.replacement.id, f.original.id);
    assert.equal(result.replacement.amount.minor, 20000000n);
    assert.equal(result.reason, reason);
    assert.equal(result.actorRef, context.actorRef);
    assert.equal(result.recordedAt, clock());
    const status = f.debts.getDebt(context, f.debt.id);
    assert.equal(status.estimatedBalance.minor, 380000000n);
    assert.equal(status.balanceKind, 'estimated');
    assert.equal(status.principalBalance, null);
    assert.equal(status.interestPaid, null);
    assert.equal(status.payments.length, 2);
    assert.deepEqual(status.effectivePayments, [result.replacement]);
    assert.equal(status.confirmedPaymentsTotal.minor, 20000000n);
    const installment = status.installments.find((item) => item.number === 9)!;
    assert.equal(installment.status, 'partial');
    assert.equal(installment.pending?.minor, 5000000n);
    const cash = f.debts.monthlyCashOutflow(context, { month: '2026-11' });
    assert.equal(cash.total.minor, 20000000n);
    assert.deepEqual(cash.payments, [result.replacement]);
    const oldHistory = f.corrections.getPaymentHistory(context, f.original.id);
    assert.deepEqual(oldHistory.payment, f.original);
    assert.equal(oldHistory.status, 'replaced');
    assert.deepEqual(oldHistory.correctedBy, result);
    assert.deepEqual(
      f.corrections.getPaymentHistory(context, result.replacement.id).replaces,
      result,
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: void retains original and increases estimated balance without refund or negative payment', () => {
  const f = setup();
  try {
    const result = f.corrections.voidPayment(context, 'void', {
      paymentId: f.original.id,
      reason,
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.replacement, null);
    assert.equal(result.proposedReplacement, null);
    assert.equal(result.estimatedBalanceAfter.minor, 400000000n);
    const status = f.debts.getDebt(context, f.debt.id);
    assert.equal(status.estimatedBalance.minor, 400000000n);
    assert.deepEqual(status.payments, [f.original]);
    assert.deepEqual(status.effectivePayments, []);
    assert.equal(
      status.installments.find((item) => item.number === 9)?.status,
      'pending',
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.corrections.getPaymentHistory(context, f.original.id).status,
      'voided',
    );
    assert.deepEqual(
      f.debts.confirmPayment(context, 'payment', {
        ...payment,
        debtId: f.debt.id,
      }),
      f.original,
    );
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      400000000n,
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: changing date, reference and installment moves current cash but preserves old period audit', () => {
  const f = setup();
  try {
    const result = f.corrections.replacePayment(context, 'move', {
      paymentId: f.original.id,
      reason,
      replacement: {
        ...corrected,
        installmentNumber: 10,
        amount: '250000',
        paidOn: '2026-10-31',
        reference: 'synthetic-october',
      },
    });
    assert.equal(result.replacement?.reference, 'synthetic-october');
    assert.equal(result.replacement?.paidOn, '2026-10-31');
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-10' }).total.minor,
      25000000n,
    );
    const status = f.debts.getDebt(context, f.debt.id);
    assert.equal(
      status.installments.find((item) => item.number === 9)?.status,
      'pending',
    );
    assert.equal(
      status.installments.find((item) => item.number === 10)?.status,
      'paid',
    );
    assert.equal(status.estimatedBalance.minor, 375000000n);
    assert.equal(
      f.corrections.getPaymentHistory(context, f.original.id).payment.paidOn,
      '2026-11-14',
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: correction chains count only the final replacement and preserve both audit links', () => {
  const f = setup();
  try {
    const first = f.corrections.replacePayment(context, 'first-correction', {
      paymentId: f.original.id,
      reason,
      replacement: corrected,
    });
    const second = f.corrections.replacePayment(context, 'second-correction', {
      paymentId: first.replacement!.id,
      reason: 'Second synthetic correction',
      replacement: { ...corrected, amount: '150000' },
    });
    const middle = f.corrections.getPaymentHistory(
      context,
      first.replacement!.id,
    );
    assert.deepEqual(middle.replaces, first);
    assert.deepEqual(middle.correctedBy, second);
    assert.equal(middle.status, 'replaced');
    assert.deepEqual(f.debts.getDebt(context, f.debt.id).effectivePayments, [
      second.replacement,
    ]);
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      385000000n,
    );
    f.corrections.voidPayment(context, 'final-void', {
      paymentId: second.replacement!.id,
      reason,
    });
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      400000000n,
    );
    assert.equal(f.debts.getDebt(context, f.debt.id).payments.length, 3);
    assert.deepEqual(
      f.corrections.replacePayment(context, 'first-correction', {
        paymentId: f.original.id,
        reason,
        replacement: corrected,
      }),
      first,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: retries preserve original actor, timestamp and result and changed content conflicts', () => {
  const f = setup();
  try {
    const input = { paymentId: f.original.id, reason, replacement: corrected };
    const first = f.corrections.replacePayment(context, 'correction', input);
    const later = new DebtPaymentCorrectionsService(
      f.store,
      f.policy,
      () => '2026-12-01T00:00:00.000Z',
    );
    assert.deepEqual(
      later.replacePayment(otherActorContext, 'correction', {
        ...input,
        replacement: { ...corrected, amount: '200000.00' },
      }),
      first,
    );
    assert.deepEqual(f.corrections.findIntent(context, 'correction'), first);
    assert.throws(
      () =>
        f.corrections.replacePayment(context, 'correction', {
          ...input,
          reason: 'different',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'correction', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'another', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'PAYMENT_ALREADY_CORRECTED' },
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: later confirmed installment payments constrain replacement and require durable review', () => {
  const f = setup({ ...opening, installmentAmount: '500000' });
  try {
    const later = f.debts.confirmPayment(context, 'later', {
      ...payment,
      debtId: f.debt.id,
      amount: '200000',
      paidOn: '2026-11-15',
    });
    const input = {
      paymentId: f.original.id,
      reason,
      replacement: { ...corrected, amount: '350000' },
    };
    const review = f.corrections.replacePayment(context, 'review', input);
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_INSTALLMENT_REMAINDER');
    assert.equal(review.replacement, null);
    assert.equal(review.proposedReplacement?.amount.minor, 35000000n);
    assert.equal(review.estimatedBalanceAfter.minor, 355000000n);
    assert.equal(
      f.corrections.getPaymentHistory(context, f.original.id).status,
      'active',
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      45000000n,
    );
    f.corrections.voidPayment(context, 'void-later', {
      paymentId: later.id,
      reason,
    });
    assert.deepEqual(
      f.corrections.replacePayment(context, 'review', input),
      review,
    );
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      375000000n,
    );
    const accepted = f.corrections.replacePayment(
      context,
      'new-correction',
      input,
    );
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.estimatedBalanceAfter.minor, 365000000n);
  } finally {
    f.store.close();
  }
});

test('debt correction: all later effective payments constrain estimated balance before replacement', () => {
  const f = setup({
    ...opening,
    referenceBalance: '500000',
    installmentAmount: '500000',
  });
  try {
    f.debts.confirmPayment(context, 'later', {
      ...payment,
      debtId: f.debt.id,
      installmentNumber: 10,
      amount: '200000',
    });
    const review = f.corrections.replacePayment(context, 'review', {
      paymentId: f.original.id,
      reason,
      replacement: { ...corrected, amount: '350000' },
    });
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_ESTIMATED_BALANCE');
    assert.equal(review.estimatedBalanceAfter.minor, 5000000n);
    assert.equal(f.debts.getDebt(context, f.debt.id).payments.length, 2);
    assert.equal(
      f.debts.getDebt(context, f.debt.id).effectivePayments.length,
      2,
    );
    assert.equal(
      f.corrections.getPaymentHistory(context, f.original.id).correctedBy,
      null,
    );
    const accepted = f.corrections.replacePayment(context, 'safe', {
      paymentId: f.original.id,
      reason,
      replacement: { ...corrected, amount: '300000' },
    });
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.estimatedBalanceAfter.minor, 0n);
  } finally {
    f.store.close();
  }
});

test('debt correction: changing installment validates the destination against already-paid amounts', () => {
  const f = setup();
  try {
    f.debts.confirmPayment(context, 'later', {
      ...payment,
      debtId: f.debt.id,
      installmentNumber: 10,
      amount: '100000',
    });
    const review = f.corrections.replacePayment(context, 'move', {
      paymentId: f.original.id,
      reason,
      replacement: { ...corrected, installmentNumber: 10 },
    });
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_INSTALLMENT_REMAINDER');
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      365000000n,
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: historical review payments are never promoted after a void restores balance', () => {
  const f = setup({ ...opening, referenceBalance: '300000' });
  try {
    const review = f.debts.confirmPayment(context, 'payment-review', {
      ...payment,
      debtId: f.debt.id,
      installmentNumber: 10,
      amount: '100000',
    });
    assert.equal(review.status, 'review_required');
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'bad-target', {
          paymentId: review.id,
          reason,
        }),
      { code: 'PAYMENT_NOT_CONFIRMED' },
    );
    assert.equal(f.corrections.findIntent(context, 'bad-target'), undefined);
    assert.equal(
      f.corrections.getPaymentHistory(context, review.id).status,
      'review_required',
    );
    f.corrections.voidPayment(context, 'void', {
      paymentId: f.original.id,
      reason,
    });
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      30000000n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.deepEqual(f.debts.findIntent(context, 'payment-review'), review);
  } finally {
    f.store.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy);
    assert.equal(
      api.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      30000000n,
    );
    assert.equal(
      api.debts.findIntent(context, 'payment-review')?.kind,
      'debt-payment',
    );
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.deepEqual(
      api.debts.getDebt(context, f.debt.id).effectivePayments,
      [],
    );
  } finally {
    reopened.close();
  }
});

test('debt correction: new confirmed payments use corrected capacity and survive restart', () => {
  const f = setup();
  const result = f.corrections.replacePayment(context, 'correct', {
    paymentId: f.original.id,
    reason,
    replacement: corrected,
  });
  const later = f.debts.confirmPayment(context, 'fill', {
    ...payment,
    debtId: f.debt.id,
    amount: '50000',
  });
  assert.equal(later.status, 'confirmed');
  f.store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy);
    const status = api.debts.getDebt(context, f.debt.id);
    assert.equal(status.estimatedBalance.minor, 375000000n);
    assert.equal(
      status.installments.find((item) => item.number === 9)?.status,
      'paid',
    );
    assert.deepEqual(status.effectivePayments, [result.replacement, later]);
    assert.deepEqual(api.corrections.findIntent(context, 'correct'), result);
  } finally {
    reopened.close();
  }
});

test('debt correction: dates and amounts remain exact above 64 bits without changing consumption or events', () => {
  const f = setup({
    ...opening,
    financedAmount: '1000000000000000000000',
    installmentAmount: '100000000000000000000',
    referenceBalance: '1000000000000000000000',
  });
  try {
    const result = f.corrections.replacePayment(context, 'big', {
      paymentId: f.original.id,
      reason,
      replacement: { ...corrected, amount: '99999999999999999999.99' },
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.replacement?.amount.minor, 9999999999999999999999n);
    assert.equal(
      f.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      90000000000000000000001n,
    );
    assert.equal(
      f.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      9999999999999999999999n,
    );
    const expenses = new ExpenseService(f.store, f.policy);
    const category = expenses.createCategory(context, 'cat', {
      name: 'Synthetic category',
    });
    const budgets = new MonthlyBudgetService(f.store, f.policy);
    budgets.setBudget(context, 'budget', {
      categoryId: category.id,
      month: '2026-11',
      amount: '1',
    });
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
    assert.deepEqual(
      new EventDeliveryService(f.store, f.policy).listPending(context).events,
      [],
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: invalid fields, missing currency and oversized amounts do not consume intentions', () => {
  const f = setup();
  try {
    for (const replacement of [
      { ...corrected, amount: '0' },
      { ...corrected, amount: '-1' },
      { ...corrected, amount: '1.001' },
      { ...corrected, paidOn: '2026-09-30' },
      { ...corrected, installmentNumber: 8 },
      { ...corrected, installmentNumber: 25 },
      { ...corrected, currency: 'USD' },
      { ...corrected, reference: '' },
      { ...corrected, subjectRef: 'editable' },
    ]) {
      assert.throws(() =>
        f.corrections.replacePayment(context, 'invalid', {
          paymentId: f.original.id,
          reason,
          replacement,
        }),
      );
      assert.equal(f.corrections.findIntent(context, 'invalid'), undefined);
    }
    const { currency: omitted, ...withoutCurrency } = corrected;
    assert.equal(omitted, 'COP');
    assert.throws(() =>
      f.corrections.replacePayment(context, 'invalid', {
        paymentId: f.original.id,
        reason,
        replacement: withoutCurrency as typeof corrected,
      }),
    );
    assert.throws(
      () =>
        f.corrections.replacePayment(context, 'invalid', {
          paymentId: f.original.id,
          reason,
          replacement: { ...corrected, amount: '1' + '0'.repeat(4096) },
        }),
      { code: 'STORAGE_LIMIT' },
    );
    for (const badReason of ['', ' '.repeat(2), 'x'.repeat(501), 'bad\nreason'])
      assert.throws(() =>
        f.corrections.voidPayment(context, 'invalid', {
          paymentId: f.original.id,
          reason: badReason,
        }),
      );
    assert.equal(f.corrections.findIntent(context, 'invalid'), undefined);
    assert.equal(
      f.corrections.getPaymentHistory(context, f.original.id).status,
      'active',
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: foreign scopes cannot read or correct payment identity', () => {
  const f = setup();
  try {
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(
        () => f.corrections.getPaymentHistory(foreign, f.original.id),
        { code: 'PAYMENT_NOT_FOUND' },
      );
      assert.throws(
        () =>
          f.corrections.voidPayment(foreign, 'void', {
            paymentId: f.original.id,
            reason,
          }),
        { code: 'PAYMENT_NOT_FOUND' },
      );
      assert.throws(
        () =>
          f.corrections.replacePayment(foreign, 'replace', {
            paymentId: f.original.id,
            reason,
            replacement: corrected,
          }),
        { code: 'PAYMENT_NOT_FOUND' },
      );
      assert.equal(f.corrections.findIntent(foreign, 'void'), undefined);
    }
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'unknown', {
          paymentId: 'missing',
          reason,
        }),
      { code: 'PAYMENT_NOT_FOUND' },
    );
  } finally {
    f.store.close();
  }
});

test('debt correction: independent correction permission and read permission are revalidated before replay', () => {
  const f = setup();
  try {
    const result = f.corrections.voidPayment(context, 'void', {
      paymentId: f.original.id,
      reason,
    });
    f.actions.delete('debt:correct');
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'void', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'FORBIDDEN' },
    );
    assert.deepEqual(f.corrections.findIntent(context, 'void'), result);
    f.actions.delete('debt:read');
    assert.throws(
      () => f.corrections.getPaymentHistory(context, f.original.id),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() => f.corrections.findIntent(context, 'void'), {
      code: 'FORBIDDEN',
    });
  } finally {
    f.store.close();
  }
});

test('debt correction: shared namespace rejects other operation keys without leaking through expense or budget readers', () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.corrections.voidPayment(context, 'payment', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const result = f.corrections.replacePayment(context, 'correction', {
      paymentId: f.original.id,
      reason,
      replacement: corrected,
    });
    assert.equal(f.corrections.findIntent(context, 'payment'), undefined);
    assert.equal(
      new ExpenseService(f.store, f.policy).findIntent(context, 'correction'),
      undefined,
    );
    assert.equal(
      new ExpenseCorrectionsService(f.store, f.policy).findIntent(
        context,
        'correction',
      ),
      undefined,
    );
    assert.equal(
      new MonthlyBudgetService(f.store, f.policy).findIntent(
        context,
        'correction',
      ),
      undefined,
    );
    assert.throws(
      () =>
        f.debts.confirmPayment(context, 'correction', {
          ...payment,
          debtId: f.debt.id,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        new ExpenseService(f.store, f.policy).createCategory(
          context,
          'correction',
          { name: 'Synthetic conflict' },
        ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.deepEqual(f.corrections.findIntent(context, 'correction'), result);
  } finally {
    f.store.close();
  }
});

test('debt correction: failures after correction or replacement insert roll back all effects and permit same key', () => {
  for (const hook of [
    'afterDebtCorrectionInsert',
    'afterDebtPaymentInsert',
  ] as const) {
    const f = setup();
    f.store.close();
    const failing = new SqliteExpenseStore(f.path, {
      [hook]: () => {
        throw new Error('Synthetic transaction failure');
      },
    });
    try {
      const api = services(failing, f.policy);
      assert.throws(
        () =>
          api.corrections.replacePayment(context, 'correct', {
            paymentId: f.original.id,
            reason,
            replacement: corrected,
          }),
        { code: 'STORAGE_IO' },
      );
      assert.equal(api.corrections.findIntent(context, 'correct'), undefined);
      assert.equal(
        api.corrections.getPaymentHistory(context, f.original.id).status,
        'active',
      );
      assert.equal(
        api.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
        375000000n,
      );
      assert.equal(api.debts.getDebt(context, f.debt.id).payments.length, 1);
    } finally {
      failing.close();
    }
    const reopened = new SqliteExpenseStore(f.path);
    try {
      assert.equal(
        services(reopened, f.policy).corrections.replacePayment(
          context,
          'correct',
          { paymentId: f.original.id, reason, replacement: corrected },
        ).status,
        'applied',
      );
    } finally {
      reopened.close();
    }
  }
});

test('debt correction: void rollback leaves the original effective and no partial intention', () => {
  const f = setup();
  f.store.close();
  const failing = new SqliteExpenseStore(f.path, {
    afterDebtCorrectionInsert: () => {
      throw new Error('Synthetic void failure');
    },
  });
  try {
    const api = services(failing, f.policy);
    assert.throws(
      () =>
        api.corrections.voidPayment(context, 'void', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'STORAGE_IO' },
    );
    assert.equal(api.corrections.findIntent(context, 'void'), undefined);
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      25000000n,
    );
  } finally {
    failing.close();
  }
});

test('debt correction: lost response after commit recovers durable correction without another cash movement', () => {
  const f = setup();
  f.store.close();
  const failing = new SqliteExpenseStore(f.path, {
    afterDebtCommit: () => {
      throw new Error('Synthetic lost response');
    },
  });
  let id: string | undefined;
  try {
    const api = services(failing, f.policy);
    assert.throws(
      () =>
        api.corrections.replacePayment(context, 'correct', {
          paymentId: f.original.id,
          reason,
          replacement: corrected,
        }),
      { code: 'STORAGE_IO' },
    );
    id = api.corrections.findIntent(context, 'correct')?.id;
    assert.ok(id);
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      20000000n,
    );
  } finally {
    failing.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy);
    const replay = api.corrections.replacePayment(context, 'correct', {
      paymentId: f.original.id,
      reason,
      replacement: corrected,
    });
    assert.equal(replay.id, id);
    assert.equal(api.debts.getDebt(context, f.debt.id).payments.length, 2);
  } finally {
    reopened.close();
  }
});

test('debt correction: backup restored separately preserves links, original intentions and current projections', () => {
  const f = setup();
  const result = f.corrections.replacePayment(context, 'correct', {
    paymentId: f.original.id,
    reason,
    replacement: { ...corrected, paidOn: '2026-10-31' },
  });
  const backup = pathFor(),
    restoredPath = pathFor();
  f.store.backupTo(backup);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restoredPath);
  const restored = new SqliteExpenseStore(restoredPath);
  try {
    const api = services(restored, f.policy);
    assert.deepEqual(api.corrections.findIntent(context, 'correct'), result);
    assert.deepEqual(
      api.corrections.getPaymentHistory(context, f.original.id).correctedBy,
      result,
    );
    assert.deepEqual(
      api.corrections.getPaymentHistory(context, result.replacement!.id)
        .replaces,
      result,
    );
    assert.deepEqual(api.debts.findIntent(context, 'payment'), f.original);
    assert.equal(
      api.debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      380000000n,
    );
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-10' }).total.minor,
      20000000n,
    );
  } finally {
    restored.close();
  }
});

test('debt correction: readonly history works and correction mutation fails explicitly', () => {
  const f = setup();
  f.corrections.voidPayment(context, 'void', {
    paymentId: f.original.id,
    reason,
  });
  f.store.close();
  const readOnly = new SqliteExpenseStore(f.path, { readOnly: true });
  try {
    const api = services(readOnly, f.policy);
    assert.equal(
      api.corrections.getPaymentHistory(context, f.original.id).status,
      'voided',
    );
    assert.throws(
      () =>
        api.corrections.voidPayment(context, 'void', {
          paymentId: f.original.id,
          reason,
        }),
      { code: 'STORAGE_READ_ONLY' },
    );
  } finally {
    readOnly.close();
  }
});

test('debt correction: concurrent same-key retries produce one correction and replacement then recover after process exit', async () => {
  const f = setup();
  f.store.close();
  const replies = await race(f.path, f.original.id, [
    { key: 'correct', mode: 'replace', amount: '200000' },
    { key: 'correct', mode: 'replace', amount: '200000.00' },
  ]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.equal(replies[0]?.result?.id, replies[1]?.result?.id);
  assert.equal(
    replies[0]?.result?.replacement?.id,
    replies[1]?.result?.replacement?.id,
  );
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = services(reopened, f.policy);
    assert.equal(api.debts.getDebt(context, f.debt.id).payments.length, 2);
    assert.equal(
      api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
      20000000n,
    );
  } finally {
    reopened.close();
  }
});

test('debt correction: concurrent incompatible corrections on one payment select one applied result', async () => {
  for (const sameKey of [true, false]) {
    const f = setup();
    f.store.close();
    const replies = await race(f.path, f.original.id, [
      { key: 'correct', mode: 'replace', amount: '200000' },
      { key: sameKey ? 'correct' : 'other', mode: 'void', amount: '0' },
    ]);
    assert.equal(
      replies.filter((reply) => reply.type === 'result').length,
      1,
      JSON.stringify(replies),
    );
    assert.deepEqual(
      replies
        .filter((reply) => reply.type === 'error')
        .map((reply) => reply.code),
      [sameKey ? 'IDEMPOTENCY_CONFLICT' : 'PAYMENT_ALREADY_CORRECTED'],
    );
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = services(reopened, f.policy);
      const history = api.corrections.getPaymentHistory(context, f.original.id);
      assert.ok(history.correctedBy);
      assert.equal(
        history.correctedBy.id,
        replies.find((reply) => reply.type === 'result')?.result?.id,
      );
      assert.equal(
        api.debts.monthlyCashOutflow(context, { month: '2026-11' }).total.minor,
        history.status === 'voided' ? 0n : 20000000n,
      );
    } finally {
      reopened.close();
    }
  }
});
