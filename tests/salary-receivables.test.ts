import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SalaryService } from '../src/application/salary-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { Money } from '../src/domain/money.ts';
import {
  allocateSalaryPayment,
  buildSalaryReceivables,
  decideSalaryCommand,
} from '../src/domain/salary-receivables.ts';
import type { SalaryPeriod } from '../src/domain/salary-receivables.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'salary-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `salary-${++sequence}.sqlite`);
const clock = () => '2026-11-15T12:00:00.000Z';
const configuration = { netAmount: '3000000', effectiveFrom: '2026-09-01' };
const payment = {
  amount: '800000',
  receivedOn: '2026-11-15',
  reference: 'synthetic-employer-payment',
};
function setup() {
  const path = pathFor();
  const store = new SqliteExpenseStore(path);
  const actions = new Set<Action>([
    'salary:configure',
    'salary:close',
    'salary:receive',
    'salary:read',
    'category:create',
    'expense:read',
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
  return {
    path,
    store,
    actions,
    policy,
    salaries: new SalaryService(store, policy, clock),
  };
}
function opening(service: SalaryService, amount = '3000000') {
  return ['2026-09', '2026-10'].map((month) =>
    service.importPendingPeriod(context, `opening-${month}`, {
      month,
      amount,
      asOf: '2026-11-01',
    }),
  );
}
const encoded = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

function syntheticPeriod(month: string): SalaryPeriod {
  return {
    kind: 'salary-period',
    id: `synthetic-${month}`,
    month,
    amount: Money.fromDecimal('3000000'),
    source: 'opening',
    salaryVersionId: null,
    availableOn: '2026-11-01',
    dueOn: `${month === '2026-09' ? '2026-10' : '2026-11'}-05`,
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
}

test('salary unit: FIFO sorts unsorted periods and conserves exact allocated and remaining money', () => {
  const periods = [syntheticPeriod('2026-10'), syntheticPeriod('2026-09')];
  const before = encoded(periods);
  const decision = allocateSalaryPayment(
    periods.map((period) => ({ period, pending: period.amount })),
    {
      amount: Money.fromDecimal('3500000.17'),
      receivedOn: '2026-11-15',
      reference: 'synthetic-unit',
      actorRef: context.actorRef,
      recordedAt: clock(),
    },
  );
  assert.equal(decision.status, 'confirmed');
  assert.deepEqual(
    decision.allocations.map((item) => [item.month, item.amount.minor]),
    [
      ['2026-09', 300000000n],
      ['2026-10', 50000017n],
    ],
  );
  assert.equal(
    decision.allocations.reduce((sum, item) => sum + item.amount.minor, 0n),
    350000017n,
  );
  assert.deepEqual(encoded(periods), before);
});

test('salary unit: projection excludes review receipts and rejects overallocated confirmed facts', () => {
  const period = syntheticPeriod('2026-09');
  const receipt = {
    kind: 'salary-payment' as const,
    id: 'synthetic-receipt',
    status: 'review_required' as const,
    reviewReason: 'EXCEEDS_PENDING_BALANCE' as const,
    amount: Money.fromDecimal('3000000.01'),
    receivedOn: '2026-11-15',
    reference: 'synthetic-unit',
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
  const allocation = {
    paymentId: receipt.id,
    periodId: period.id,
    amount: receipt.amount,
  };
  assert.equal(
    buildSalaryReceivables([period], [receipt], [allocation], '2026-11-15')
      .received.minor,
    0n,
  );
  assert.throws(
    () =>
      buildSalaryReceivables(
        [period],
        [{ ...receipt, status: 'confirmed', reviewReason: null }],
        [allocation],
        '2026-11-15',
      ),
    { code: 'SALARY_INVARIANT_VIOLATION' },
  );
});

test('salary unit: command evaluator produces opening obligation with no cash or allocation', () => {
  const decision = decideSalaryCommand(
    { versions: [], periods: [], payments: [], allocations: [] },
    {
      operation: 'opening',
      draft: {
        month: '2026-09',
        amount: Money.fromDecimal('3000000'),
        asOf: '2026-11-01',
        dueDay: 5,
        actorRef: context.actorRef,
        recordedAt: clock(),
      },
    },
    'synthetic-opening',
  );
  assert.equal(decision.result.kind, 'salary-period');
  assert.deepEqual(decision.allocations, []);
  assert.equal('status' in decision.result, false);
});

interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; status?: string };
  code?: string;
}
async function race(
  path: string,
  jobs: readonly { key: string; amount: string; mode?: string }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/salary-worker.ts', import.meta.url),
      [path, job.key, job.amount, job.mode ?? 'payment'],
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
      const error = new Error('Synthetic salary worker timed out');
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
          `Salary worker exited without result (${code})`,
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

test('salary: September and October opening, partial FIFO receipt and replay create one cash inflow', () => {
  const f = setup();
  try {
    f.salaries.configureSalary(context, 'configuration', configuration);
    const periods = opening(f.salaries);
    assert.equal(
      f.salaries.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    const receipt = f.salaries.receivePayment(context, 'receipt', payment);
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.amount.minor, 80000000n);
    assert.equal(receipt.actorRef, context.actorRef);
    assert.equal(receipt.recordedAt, clock());
    assert.equal('pending' in receipt, false);
    assert.equal('allocations' in receipt, false);
    assert.deepEqual(
      f.salaries.receivePayment(context, 'receipt', payment),
      receipt,
    );
    const detail = f.salaries.getPayment(context, receipt.id);
    assert.deepEqual(
      detail.allocations.map((item) => [
        item.periodId,
        item.month,
        item.amount.minor,
      ]),
      [[periods[0]!.id, '2026-09', 80000000n]],
    );
    const status = f.salaries.getReceivables(context, { asOf: '2026-11-15' });
    assert.equal(status.closedEarned.minor, 0n);
    assert.equal(status.openingReceivable.minor, 600000000n);
    assert.equal(status.received.minor, 80000000n);
    assert.equal(status.pending.minor, 520000000n);
    assert.deepEqual(
      status.periods.map((item) => item.pending.minor),
      [220000000n, 300000000n],
    );
    const cash = f.salaries.monthlyCashInflow(context, { month: '2026-11' });
    assert.equal(cash.total.minor, 80000000n);
    assert.equal(cash.payments.length, 1);
    assert.equal(
      new ExpenseService(f.store, f.policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
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

test('salary: receipt spans several months chronologically and final payment settles exactly', () => {
  const f = setup();
  try {
    opening(f.salaries);
    const receipt = f.salaries.receivePayment(context, 'multiple', {
      ...payment,
      amount: '3500000',
    });
    assert.deepEqual(
      f.salaries
        .getPayment(context, receipt.id)
        .allocations.map((item) => [item.month, item.amount.minor]),
      [
        ['2026-09', 300000000n],
        ['2026-10', 50000000n],
      ],
    );
    f.salaries.receivePayment(context, 'final', {
      ...payment,
      amount: '2500000',
    });
    const status = f.salaries.getReceivables(context, { asOf: '2026-11-15' });
    assert.equal(status.pending.minor, 0n);
    assert.equal(status.overdue.minor, 0n);
    assert.ok(status.periods.every((item) => item.status === 'paid'));
    assert.equal(
      f.salaries.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      600000000n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: excess receipt is durable review without partial allocations or cash', () => {
  const f = setup();
  try {
    opening(f.salaries);
    const payload = { ...payment, amount: '6000000.01' };
    const result = f.salaries.receivePayment(context, 'excess', payload);
    assert.equal(result.status, 'review_required');
    assert.equal(result.reviewReason, 'EXCEEDS_PENDING_BALANCE');
    assert.deepEqual(f.salaries.getPayment(context, result.id).allocations, []);
    assert.equal(
      f.salaries.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    f.salaries.importPendingPeriod(context, 'new-period', {
      month: '2026-11',
      amount: '3000000',
      asOf: '2026-12-01',
    });
    assert.deepEqual(
      f.salaries.receivePayment(context, 'excess', payload),
      result,
    );
    assert.throws(
      () =>
        f.salaries.receivePayment(context, 'excess', {
          ...payload,
          amount: '6000000',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.store.close();
  }
});

test('salary: no open receivable never fabricates a destination for a receipt', () => {
  const f = setup();
  try {
    f.salaries.configureSalary(context, 'configuration', configuration);
    assert.equal(
      f.salaries.receivePayment(context, 'receipt', payment).status,
      'review_required',
    );
    assert.equal(
      f.salaries.getReceivables(context, { asOf: '2026-11-15' }).received.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: closing is explicit, idempotent and snapshots the salary version without cash', () => {
  const f = setup();
  try {
    f.salaries.configureSalary(context, 'configuration', configuration);
    const payload = { month: '2026-09', closedOn: '2026-10-01' };
    const september = f.salaries.closePeriod(context, 'september', payload);
    f.salaries.configureSalary(context, 'increase', {
      netAmount: '3500000',
      effectiveFrom: '2026-10-01',
    });
    f.salaries.closePeriod(context, 'october', {
      month: '2026-10',
      closedOn: '2026-11-01',
    });
    assert.deepEqual(
      f.salaries.closePeriod(context, 'september', payload),
      september,
    );
    const status = f.salaries.getReceivables(context, { asOf: '2026-11-15' });
    assert.deepEqual(
      status.periods.map((item) => item.pending.minor),
      [300000000n, 350000000n],
    );
    assert.equal(status.closedEarned.minor, 650000000n);
    assert.equal(status.openingReceivable.minor, 0n);
    assert.equal(status.received.minor, 0n);
    assert.equal(
      f.salaries.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.throws(
      () => f.salaries.closePeriod(context, 'duplicate-month', payload),
      { code: 'SALARY_PERIOD_EXISTS' },
    );
    assert.throws(
      () =>
        f.salaries.importPendingPeriod(context, 'duplicate-opening', {
          month: '2026-09',
          amount: '1',
          asOf: '2026-11-01',
        }),
      { code: 'SALARY_PERIOD_EXISTS' },
    );
  } finally {
    f.store.close();
  }
});

test('salary: version conflicts and missing configuration do not leave an intention', () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.salaries.closePeriod(context, 'missing', {
          month: '2026-09',
          closedOn: '2026-10-01',
        }),
      { code: 'SALARY_NOT_CONFIGURED' },
    );
    f.salaries.configureSalary(context, 'configuration', configuration);
    f.salaries.closePeriod(context, 'closed', {
      month: '2026-10',
      closedOn: '2026-11-01',
    });
    assert.throws(
      () => f.salaries.configureSalary(context, 'same-date', configuration),
      { code: 'SALARY_VERSION_EXISTS' },
    );
    assert.throws(
      () =>
        f.salaries.configureSalary(context, 'backdated', {
          ...configuration,
          effectiveFrom: '2026-10-01',
        }),
      { code: 'SALARY_VERSION_CONFLICT' },
    );
    assert.equal(f.salaries.findIntent(context, 'missing'), undefined);
    assert.equal(f.salaries.findIntent(context, 'backdated'), undefined);
  } finally {
    f.store.close();
  }
});

test('salary: default due date is inclusive day 5 and overdue starts day 6 of following month', () => {
  const f = setup();
  try {
    f.salaries.configureSalary(context, 'configuration', configuration);
    f.salaries.closePeriod(context, 'september', {
      month: '2026-09',
      closedOn: '2026-09-30',
    });
    assert.equal(
      f.salaries.getReceivables(context, { asOf: '2026-09-29' }).pending.minor,
      0n,
    );
    const day5 = f.salaries.getReceivables(context, { asOf: '2026-10-05' });
    assert.equal(day5.pending.minor, 300000000n);
    assert.equal(day5.overdue.minor, 0n);
    assert.equal(day5.periods[0]!.status, 'pending');
    const day6 = f.salaries.getReceivables(context, { asOf: '2026-10-06' });
    assert.equal(day6.overdue.minor, 300000000n);
    assert.equal(day6.periods[0]!.status, 'overdue');
  } finally {
    f.store.close();
  }
});

test('salary: due day 31 clamps February including leap years and rolls into next year', () => {
  for (const [month, dueOn, following] of [
    ['2028-01', '2028-02-29', '2028-03-01'],
    ['2027-01', '2027-02-28', '2027-03-01'],
    ['2026-12', '2027-01-31', '2027-02-01'],
  ]) {
    const f = setup();
    try {
      f.salaries.importPendingPeriod(context, 'opening', {
        month: month!,
        amount: '100',
        asOf: dueOn!,
        dueDay: 31,
      });
      assert.equal(
        f.salaries.getReceivables(context, { asOf: dueOn! }).overdue.minor,
        0n,
      );
      assert.equal(
        f.salaries.getReceivables(context, { asOf: following! }).overdue.minor,
        10000n,
      );
    } finally {
      f.store.close();
    }
  }
});

test('salary: opening availability and received dates control as-of projections, not audit clock', () => {
  const f = setup();
  try {
    opening(f.salaries);
    assert.equal(
      f.salaries.getReceivables(context, { asOf: '2026-10-31' }).pending.minor,
      0n,
    );
    const alternateClock = new SalaryService(
      f.store,
      f.policy,
      () => '2030-01-01T00:00:00.000Z',
    );
    const receipt = alternateClock.receivePayment(context, 'receipt', payment);
    assert.equal(receipt.recordedAt, '2030-01-01T00:00:00.000Z');
    assert.equal(
      alternateClock.getReceivables(context, { asOf: '2026-11-14' }).pending
        .minor,
      600000000n,
    );
    assert.equal(
      alternateClock.getReceivables(context, { asOf: '2026-11-15' }).pending
        .minor,
      520000000n,
    );
    assert.equal(
      alternateClock.monthlyCashInflow(context, { month: '2030-01' }).total
        .minor,
      0n,
    );
    assert.equal(
      alternateClock.monthlyCashInflow(context, { month: '2026-11' }).total
        .minor,
      80000000n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: backdated receipt requires review and newly imported old periods cannot silently rewrite FIFO', () => {
  const f = setup();
  try {
    f.salaries.importPendingPeriod(context, 'october', {
      month: '2026-10',
      amount: '3000000',
      asOf: '2026-11-01',
    });
    f.salaries.receivePayment(context, 'received', payment);
    const older = f.salaries.receivePayment(context, 'backdated', {
      ...payment,
      receivedOn: '2026-11-14',
    });
    assert.equal(older.status, 'review_required');
    assert.equal(older.reviewReason, 'PAYMENT_DATE_REQUIRES_REVIEW');
    assert.deepEqual(f.salaries.getPayment(context, older.id).allocations, []);
    assert.throws(
      () =>
        f.salaries.importPendingPeriod(context, 'september', {
          month: '2026-09',
          amount: '3000000',
          asOf: '2026-11-01',
        }),
      { code: 'SALARY_PERIOD_REQUIRES_REVIEW' },
    );
    assert.equal(
      f.salaries.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
      220000000n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: a receipt cannot consume obligations before their explicit availability', () => {
  const f = setup();
  try {
    opening(f.salaries);
    const receipt = f.salaries.receivePayment(context, 'early', {
      ...payment,
      receivedOn: '2026-10-31',
    });
    assert.equal(receipt.status, 'review_required');
    assert.deepEqual(
      f.salaries.getPayment(context, receipt.id).allocations,
      [],
    );
    assert.equal(
      f.salaries.monthlyCashInflow(context, { month: '2026-10' }).total.minor,
      0n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: exact COP centavos and amounts beyond signed 64 bits survive allocations and reopen', () => {
  const f = setup();
  const amount = '9223372036854775808.17';
  f.salaries.configureSalary(context, 'configuration', {
    ...configuration,
    netAmount: amount,
  });
  f.salaries.closePeriod(context, 'period', {
    month: '2026-09',
    closedOn: '2026-10-01',
  });
  const receipt = f.salaries.receivePayment(context, 'large', {
    ...payment,
    amount: '9223372036854775808.16',
  });
  const detail = encoded(f.salaries.getPayment(context, receipt.id));
  f.store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new SalaryService(reopened, f.policy, clock);
    assert.deepEqual(encoded(api.getPayment(context, receipt.id)), detail);
    assert.equal(
      api.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
      1n,
    );
    assert.equal(
      api.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      922337203685477580816n,
    );
  } finally {
    reopened.close();
  }
});

test('salary: invalid money, currencies, dates, midmonth salary versions and due days are rejected', () => {
  const f = setup();
  try {
    for (const amount of ['-1', '0', '1.001', '3.000.000', '1e6', 'NaN']) {
      assert.throws(() =>
        f.salaries.configureSalary(context, `amount-${amount}`, {
          ...configuration,
          netAmount: amount,
        }),
      );
      assert.throws(() =>
        f.salaries.receivePayment(context, `payment-${amount}`, {
          ...payment,
          amount,
        }),
      );
    }
    for (const currency of ['USD', 'EUR'])
      assert.throws(
        () =>
          f.salaries.configureSalary(context, `currency-${currency}`, {
            ...configuration,
            currency,
          }),
        { code: 'UNSUPPORTED_CURRENCY' },
      );
    for (const effectiveFrom of [
      '2026-09-02',
      '2026-02-30',
      '2026-13-01',
      '2026-09-01T00:00:00Z',
    ])
      assert.throws(() =>
        f.salaries.configureSalary(context, 'bad-date', {
          ...configuration,
          effectiveFrom,
        }),
      );
    for (const dueDay of [0, 32, 2.5])
      assert.throws(() =>
        f.salaries.configureSalary(context, 'bad-day', {
          ...configuration,
          dueDay,
        }),
      );
    f.salaries.configureSalary(context, 'configuration', configuration);
    assert.throws(() =>
      f.salaries.closePeriod(context, 'early', {
        month: '2026-09',
        closedOn: '2026-09-29',
      }),
    );
    assert.throws(() =>
      f.salaries.importPendingPeriod(context, 'early-opening', {
        month: '2026-09',
        amount: '100',
        asOf: '2026-09-29',
      }),
    );
    assert.throws(() =>
      f.salaries.getReceivables(context, { asOf: '2026-02-30' }),
    );
    assert.throws(() =>
      f.salaries.monthlyCashInflow(context, { month: '2026-13' }),
    );
  } finally {
    f.store.close();
  }
});

test('salary: subjects and instances can reuse keys but cannot read another scope payment or intention', () => {
  const f = setup();
  try {
    opening(f.salaries);
    const receipt = f.salaries.receivePayment(context, 'receipt', payment);
    for (const other of [otherSubjectContext, otherInstanceContext]) {
      assert.equal(f.salaries.findIntent(other, 'receipt'), undefined);
      assert.throws(() => f.salaries.getPayment(other, receipt.id));
      assert.equal(
        f.salaries.getReceivables(other, { asOf: '2026-11-15' }).pending.minor,
        0n,
      );
      assert.equal(
        f.salaries.monthlyCashInflow(other, { month: '2026-11' }).total.minor,
        0n,
      );
      f.salaries.importPendingPeriod(other, 'opening-2026-09', {
        month: '2026-09',
        amount: '1000',
        asOf: '2026-11-01',
      });
      assert.equal(
        f.salaries.receivePayment(other, 'receipt', {
          ...payment,
          amount: '100',
        }).status,
        'confirmed',
      );
    }
    assert.equal(
      f.salaries.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
      520000000n,
    );
  } finally {
    f.store.close();
  }
});

test('salary: revoked permissions are checked before idempotent replay and reads', () => {
  const f = setup();
  try {
    f.salaries.configureSalary(context, 'configuration', configuration);
    opening(f.salaries);
    const receipt = f.salaries.receivePayment(context, 'receipt', payment);
    f.actions.clear();
    assert.throws(
      () => f.salaries.configureSalary(context, 'configuration', configuration),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() => opening(f.salaries), { code: 'FORBIDDEN' });
    assert.throws(
      () =>
        f.salaries.closePeriod(context, 'closed', {
          month: '2026-11',
          closedOn: '2026-12-01',
        }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () => f.salaries.receivePayment(context, 'receipt', payment),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() => f.salaries.getPayment(context, receipt.id), {
      code: 'FORBIDDEN',
    });
    assert.throws(
      () => f.salaries.getReceivables(context, { asOf: '2026-11-15' }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () => f.salaries.monthlyCashInflow(context, { month: '2026-11' }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() => f.salaries.findIntent(context, 'receipt'), {
      code: 'FORBIDDEN',
    });
  } finally {
    f.store.close();
  }
});

test('salary: trusted actor binding rejects forged actor and payload scope fields', () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.salaries.configureSalary(
          { ...context, actorRef: 'unbound-actor' },
          'forged',
          configuration,
        ),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() =>
      f.salaries.receivePayment(context, 'payload-scope', {
        ...payment,
        // @ts-expect-error Runtime rejection of untrusted payload identity.
        subjectRef: otherSubjectContext.subjectRef,
      }),
    );
    opening(f.salaries);
    f.salaries.receivePayment(context, 'receipt', payment);
    const replay = f.salaries.receivePayment(
      otherActorContext,
      'receipt',
      payment,
    );
    assert.equal(replay.actorRef, context.actorRef);
    assert.deepEqual(replay, f.salaries.findIntent(context, 'receipt'));
  } finally {
    f.store.close();
  }
});

test('salary: global idempotency namespace conflicts across operations without exposing foreign results', () => {
  const f = setup();
  try {
    const expenses = new ExpenseService(f.store, f.policy);
    expenses.createCategory(context, 'category-key', {
      name: 'Synthetic salary fixture',
    });
    assert.equal(f.salaries.findIntent(context, 'category-key'), undefined);
    assert.throws(
      () => f.salaries.configureSalary(context, 'category-key', configuration),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    f.salaries.configureSalary(context, 'salary-key', configuration);
    assert.equal(expenses.findIntent(context, 'salary-key'), undefined);
    assert.throws(
      () =>
        expenses.createCategory(context, 'salary-key', {
          name: 'Different synthetic fixture',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        f.salaries.importPendingPeriod(context, 'salary-key', {
          month: '2026-09',
          amount: '100',
          asOf: '2026-11-01',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.store.close();
  }
});

for (const hook of [
  'afterSalaryVersionInsert',
  'afterSalaryPeriodInsert',
  'afterSalaryPaymentInsert',
  'afterSalaryAllocationInsert',
] as const) {
  test(`salary: ${hook} failure rolls back financial facts and intention, same-key retry succeeds`, () => {
    const f = setup();
    if (
      hook === 'afterSalaryPaymentInsert' ||
      hook === 'afterSalaryAllocationInsert'
    )
      opening(f.salaries);
    f.store.close();
    const failed = new SqliteExpenseStore(f.path, {
      [hook]: () => {
        throw new Error('Synthetic salary failure');
      },
    });
    const invoke = (api: SalaryService) =>
      hook === 'afterSalaryVersionInsert'
        ? api.configureSalary(context, 'operation', configuration)
        : hook === 'afterSalaryPeriodInsert'
          ? api.importPendingPeriod(context, 'operation', {
              month: '2026-09',
              amount: '3000000',
              asOf: '2026-11-01',
            })
          : api.receivePayment(context, 'operation', {
              ...payment,
              amount: '3500000',
            });
    try {
      const api = new SalaryService(failed, f.policy, clock);
      assert.throws(() => invoke(api), { code: 'STORAGE_IO' });
      assert.equal(api.findIntent(context, 'operation'), undefined);
      assert.equal(
        api.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
        0n,
      );
      assert.equal(
        api.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
        hook.includes('Payment') || hook.includes('Allocation')
          ? 600000000n
          : 0n,
      );
    } finally {
      failed.close();
    }
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = new SalaryService(reopened, f.policy, clock);
      const result = invoke(api);
      assert.equal(api.findIntent(context, 'operation')?.id, result.id);
      if (hook.includes('Payment') || hook.includes('Allocation')) {
        assert.equal(api.getPayment(context, result.id).allocations.length, 2);
        assert.equal(
          api.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
          250000000n,
        );
      }
    } finally {
      reopened.close();
    }
  });
}

test('salary: lost response after commit replays original receipt after reopening without duplicate allocations', () => {
  const f = setup();
  opening(f.salaries);
  f.store.close();
  const uncertain = new SqliteExpenseStore(f.path, {
    afterSalaryCommit: () => {
      throw new Error('Synthetic lost response');
    },
  });
  try {
    assert.throws(
      () =>
        new SalaryService(uncertain, f.policy, clock).receivePayment(
          context,
          'receipt',
          payment,
        ),
      { code: 'STORAGE_IO' },
    );
  } finally {
    uncertain.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new SalaryService(reopened, f.policy, clock);
    const receipt = api.receivePayment(context, 'receipt', payment);
    assert.deepEqual(api.findIntent(context, 'receipt'), receipt);
    assert.equal(api.getPayment(context, receipt.id).allocations.length, 1);
    assert.equal(
      api.monthlyCashInflow(context, { month: '2026-11' }).payments.length,
      1,
    );
    assert.equal(
      api.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
      520000000n,
    );
  } finally {
    reopened.close();
  }
});

test('salary: isolated backup restoration preserves versions, opening, allocations, review and original replays', () => {
  const f = setup();
  f.salaries.configureSalary(context, 'configuration', configuration);
  opening(f.salaries);
  const receipt = f.salaries.receivePayment(context, 'receipt', {
    ...payment,
    amount: '3500000',
  });
  const review = f.salaries.receivePayment(context, 'excess', {
    ...payment,
    amount: '9000000',
  });
  const original = encoded(
    f.salaries.getReceivables(context, { asOf: '2026-11-15' }),
  );
  const detail = encoded(f.salaries.getPayment(context, receipt.id));
  const backup = pathFor(),
    restored = pathFor();
  f.store.backupTo(backup);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restored);
  for (const path of [f.path, restored]) {
    const store = new SqliteExpenseStore(path);
    try {
      const api = new SalaryService(store, f.policy, clock);
      assert.deepEqual(
        encoded(api.getReceivables(context, { asOf: '2026-11-15' })),
        original,
      );
      assert.deepEqual(encoded(api.getPayment(context, receipt.id)), detail);
      assert.deepEqual(
        encoded(
          api.receivePayment(context, 'receipt', {
            ...payment,
            amount: '3500000',
          }),
        ),
        encoded(receipt),
      );
      assert.equal(
        api.receivePayment(context, 'excess', { ...payment, amount: '9000000' })
          .id,
        review.id,
      );
      assert.equal(
        api.monthlyCashInflow(context, { month: '2026-11' }).payments.length,
        1,
      );
      assert.equal(
        api.configureSalary(context, 'configuration', configuration).netAmount
          .minor,
        300000000n,
      );
    } finally {
      store.close();
    }
  }
});

test('salary: concurrent processes replay the same receipt identity exactly once', async () => {
  const f = setup();
  opening(f.salaries);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'same', amount: '800000' },
    { key: 'same', amount: '800000' },
  ]);
  assert.ok(replies.every((reply) => reply.type === 'result'));
  assert.equal(replies[0]!.result!.id, replies[1]!.result!.id);
  const store = new SqliteExpenseStore(f.path);
  try {
    const api = new SalaryService(store, f.policy, clock);
    assert.equal(
      api.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      80000000n,
    );
    assert.equal(
      api.getPayment(context, replies[0]!.result!.id).allocations.length,
      1,
    );
  } finally {
    store.close();
  }
});

test('salary: concurrent same-key conflicting payloads commit one receipt and return one conflict', async () => {
  const f = setup();
  opening(f.salaries);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'same', amount: '800000' },
    { key: 'same', amount: '900000' },
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
      new SalaryService(store, f.policy, clock).monthlyCashInflow(context, {
        month: '2026-11',
      }).payments.length,
      1,
    );
  } finally {
    store.close();
  }
});

test('salary: competing processes cannot overallocate a shared remaining balance', async () => {
  const f = setup();
  opening(f.salaries);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'first', amount: '4000000' },
    { key: 'second', amount: '4000000' },
  ]);
  assert.deepEqual(replies.map((reply) => reply.result?.status).sort(), [
    'confirmed',
    'review_required',
  ]);
  const store = new SqliteExpenseStore(f.path);
  try {
    const api = new SalaryService(store, f.policy, clock);
    assert.equal(
      api.getReceivables(context, { asOf: '2026-11-15' }).pending.minor,
      200000000n,
    );
    assert.equal(
      api.monthlyCashInflow(context, { month: '2026-11' }).total.minor,
      400000000n,
    );
    assert.equal(
      api.monthlyCashInflow(context, { month: '2026-11' }).payments.length,
      1,
    );
  } finally {
    store.close();
  }
});

test('salary: concurrent explicit closures cannot duplicate a monthly obligation', async () => {
  const f = setup();
  f.salaries.configureSalary(context, 'configuration', configuration);
  f.store.close();
  const replies = await race(f.path, [
    { key: 'first-close', amount: '0', mode: 'close' },
    { key: 'second-close', amount: '0', mode: 'close' },
  ]);
  assert.equal(replies.filter((reply) => reply.type === 'result').length, 1);
  assert.deepEqual(
    replies
      .filter((reply) => reply.type === 'error')
      .map((reply) => reply.code),
    ['SALARY_PERIOD_EXISTS'],
  );
  const store = new SqliteExpenseStore(f.path);
  try {
    assert.equal(
      new SalaryService(store, f.policy, clock).getReceivables(context, {
        asOf: '2026-11-15',
      }).pending.minor,
      300000000n,
    );
  } finally {
    store.close();
  }
});
