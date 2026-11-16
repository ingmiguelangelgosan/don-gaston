import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalLoanService } from '../src/application/personal-loan-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { SalaryService } from '../src/application/salary-service.ts';
import { RecurringBillService } from '../src/application/recurring-bill-service.ts';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { Money } from '../src/domain/money.ts';
import { decideLoanCommand } from '../src/domain/personal-loans.ts';
import type {
  LoanCounterparty,
  LoanMovement,
} from '../src/domain/personal-loans.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'personal-loan-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'synthetic-'));
let sequence = 0;
const pathFor = () => join(directory, `loan-${++sequence}.sqlite`);
const clock = () => '2026-11-16T12:00:00.000Z';
const encoded = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;
type Direction = 'receivable' | 'payable';
const input = (
  counterpartyId: string,
  amount: string,
  direction: Direction = 'receivable',
  occurredOn = '2026-11-16',
) => ({
  counterpartyId,
  amount,
  direction,
  occurredOn,
  reference: 'synthetic-capital',
});
function setup() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path);
  const actions = new Set<Action>([
    'loan:counterparty',
    'loan:disburse',
    'loan:repay',
    'loan:read',
    'category:create',
    'expense:record',
    'expense:read',
    'budget:write',
    'budget:read',
    'event:read',
    'salary:configure',
    'salary:close',
    'salary:receive',
    'salary:read',
    'bill:write',
    'bill:read',
    'debt:write',
    'debt:read',
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
  const loans = new PersonalLoanService(store, policy, clock);
  const party = loans.createCounterparty(context, 'party', {
    name: 'Synthetic Juan',
  });
  return { path, store, actions, policy, loans, party };
}
const query = (
  counterpartyId: string,
  direction: Direction = 'receivable',
  asOf = '2026-11-30',
) => ({ counterpartyId, direction, asOf });
const unitParty: LoanCounterparty = {
  kind: 'loan-counterparty',
  id: 'unit-party',
  name: 'Synthetic party',
  actorRef: context.actorRef,
  recordedAt: clock(),
};
function unitMovement(
  id: string,
  amount: string,
  occurredOn: string,
  movementType: 'disbursement' | 'repayment',
): LoanMovement {
  return {
    kind: 'loan-movement',
    id,
    counterpartyId: unitParty.id,
    direction: 'receivable',
    movementType,
    amount: Money.fromDecimal(amount),
    occurredOn,
    reference: 'synthetic-unit',
    status: 'confirmed',
    reviewReason: null,
    cashDirection: movementType === 'disbursement' ? 'outflow' : 'inflow',
    principalBalanceAfter: Money.fromMinor(0n),
    actorRef: context.actorRef,
    recordedAt: clock(),
  };
}

test('loans unit: all four capital effects preserve exact money without mutating the supplied ledger', () => {
  for (const direction of ['receivable', 'payable'] as const) {
    const state = {
      counterparties: [unitParty],
      movements: [] as LoanMovement[],
    };
    const disbursement = decideLoanCommand(
      state,
      {
        operation: 'disburse',
        draft: {
          ...input(unitParty.id, '9223372036854775808.17', direction),
          amount: Money.fromDecimal('9223372036854775808.17'),
          actorRef: context.actorRef,
          recordedAt: clock(),
        },
      },
      'disbursement',
    );
    assert.equal(disbursement.kind, 'loan-movement');
    if (disbursement.kind !== 'loan-movement') assert.fail('Expected movement');
    state.movements.push(disbursement);
    const before = encoded(state);
    const repayment = decideLoanCommand(
      state,
      {
        operation: 'repay',
        draft: {
          ...input(unitParty.id, '0.17', direction),
          amount: Money.fromDecimal('0.17'),
          actorRef: context.actorRef,
          recordedAt: clock(),
        },
      },
      'repayment',
    );
    assert.equal(repayment.kind, 'loan-movement');
    if (repayment.kind !== 'loan-movement') assert.fail('Expected movement');
    assert.equal(
      disbursement.cashDirection,
      direction === 'receivable' ? 'outflow' : 'inflow',
    );
    assert.equal(
      repayment.cashDirection,
      direction === 'receivable' ? 'inflow' : 'outflow',
    );
    assert.equal(repayment.principalBalanceAfter.minor, 922337203685477580800n);
    assert.deepEqual(encoded(state), before);
    assert.equal(Object.isFrozen(repayment), true);
  }
});

test('loans unit: backdated repayment validates every later chronological prefix, not just final balance', () => {
  const movements = [
    unitMovement('first', '100', '2026-11-01', 'disbursement'),
    unitMovement('paid', '100', '2026-11-10', 'repayment'),
    unitMovement('later', '100', '2026-11-20', 'disbursement'),
  ];
  const result = decideLoanCommand(
    { counterparties: [unitParty], movements },
    {
      operation: 'repay',
      draft: {
        ...input(unitParty.id, '50', 'receivable', '2026-11-05'),
        amount: Money.fromDecimal('50'),
        actorRef: context.actorRef,
        recordedAt: clock(),
      },
    },
    'retroactive',
  );
  assert.equal(result.kind, 'loan-movement');
  if (result.kind !== 'loan-movement') assert.fail('Expected movement');
  assert.equal(result.status, 'review_required');
  assert.equal(result.reviewReason, 'PAYMENT_DATE_REQUIRES_REVIEW');
  assert.equal(result.cashDirection, null);
  assert.equal(result.principalBalanceAfter.minor, 10000n);
});

test('loans: synthetic borrowing 80000 and repayment 30000 retain payable 50000 and two cash facts', () => {
  const f = setup();
  try {
    const mother = f.loans.createCounterparty(context, 'mother', {
      name: 'Synthetic mama',
    });
    const borrowed = f.loans.recordDisbursement(
      context,
      'borrow',
      input(mother.id, '80000', 'payable', '2026-11-01'),
    );
    const repaid = f.loans.recordRepayment(
      context,
      'repay',
      input(mother.id, '30000', 'payable', '2026-11-05'),
    );
    const position = f.loans.getPosition(context, query(mother.id, 'payable'));
    assert.equal(position.balance.minor, 5000000n);
    assert.equal(position.disbursed.minor, 8000000n);
    assert.equal(position.repaid.minor, 3000000n);
    assert.deepEqual(
      position.movements.map((m) => m.id),
      [borrowed.id, repaid.id],
    );
    const cash = f.loans.monthlyCashFlow(context, { month: '2026-11' });
    assert.equal(cash.inflow.minor, 8000000n);
    assert.equal(cash.outflow.minor, 3000000n);
    assert.equal(cash.movements.length, 2);
  } finally {
    f.store.close();
  }
});

test('loans: synthetic lending 200000, return 70000 and new disbursement 50000 retain receivable 180000', () => {
  const f = setup();
  try {
    const first = f.loans.recordDisbursement(
      context,
      'first',
      input(f.party.id, '200000', 'receivable', '2026-11-01'),
    );
    const returned = f.loans.recordRepayment(
      context,
      'returned',
      input(f.party.id, '70000', 'receivable', '2026-11-02'),
    );
    const extra = f.loans.recordDisbursement(
      context,
      'extra',
      input(f.party.id, '50000', 'receivable', '2026-11-03'),
    );
    const position = f.loans.getPosition(context, query(f.party.id));
    assert.equal(position.balance.minor, 18000000n);
    assert.deepEqual(
      position.movements.map((m) => m.id),
      [first.id, returned.id, extra.id],
    );
    assert.equal(
      position.movements.every(
        (m) =>
          m.actorRef === context.actorRef &&
          m.reference === 'synthetic-capital',
      ),
      true,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      25000000n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      7000000n,
    );
    assert.deepEqual(
      f.loans.recordDisbursement(
        context,
        'extra',
        input(f.party.id, '50000', 'receivable', '2026-11-03'),
      ),
      extra,
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).movements.length,
      3,
    );
  } finally {
    f.store.close();
  }
});

test('loans: opposite positions for one counterparty remain independent and are never netted', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(context, 'lend', input(f.party.id, '200000'));
    f.loans.recordDisbursement(
      context,
      'borrow',
      input(f.party.id, '80000', 'payable'),
    );
    f.loans.recordRepayment(
      context,
      'return',
      input(f.party.id, '30000', 'payable'),
    );
    const positions = f.loans.listPositions(context, { asOf: '2026-11-30' });
    assert.equal(positions.totalReceivable.minor, 20000000n);
    assert.equal(positions.totalPayable.minor, 5000000n);
    assert.equal(positions.positions[0]!.receivable.minor, 20000000n);
    assert.equal(positions.positions[0]!.payable.minor, 5000000n);
    const excess = f.loans.recordRepayment(
      context,
      'excess-payable',
      input(f.party.id, '60000', 'payable'),
    );
    assert.equal(excess.status, 'review_required');
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      20000000n,
    );
  } finally {
    f.store.close();
  }
});

test('loans: equal counterparty names have different stable IDs and no shared balances', () => {
  const f = setup();
  try {
    const another = f.loans.createCounterparty(context, 'same-name', {
      name: f.party.name,
    });
    assert.notEqual(another.id, f.party.id);
    f.loans.recordDisbursement(context, 'first', input(f.party.id, '200'));
    f.loans.recordDisbursement(
      context,
      'second',
      input(another.id, '80', 'payable'),
    );
    assert.equal(
      f.loans.getPosition(context, query(another.id)).balance.minor,
      0n,
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id, 'payable')).balance.minor,
      0n,
    );
    assert.equal(
      f.loans.listPositions(context, { asOf: '2026-11-30' }).positions.length,
      2,
    );
    assert.deepEqual(
      f.loans.createCounterparty(context, 'same-name', { name: f.party.name }),
      another,
    );
  } finally {
    f.store.close();
  }
});

test('loans: partial returns and exact settlement leave zero without erasing movement history', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(context, 'lend', input(f.party.id, '100.03'));
    f.loans.recordRepayment(context, 'partial', input(f.party.id, '30.01'));
    const settled = f.loans.recordRepayment(
      context,
      'settle',
      input(f.party.id, '70.02'),
    );
    assert.equal(settled.status, 'confirmed');
    assert.equal(settled.principalBalanceAfter.minor, 0n);
    const position = f.loans.getPosition(context, query(f.party.id));
    assert.equal(position.balance.minor, 0n);
    assert.equal(position.movements.length, 3);
    assert.equal(position.repaid.minor, 10003n);
    const extra = f.loans.recordRepayment(
      context,
      'extra',
      input(f.party.id, '0.01'),
    );
    assert.equal(extra.status, 'review_required');
    assert.equal(extra.cashDirection, null);
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      3,
    );
  } finally {
    f.store.close();
  }
});

test('loans: excess repayment is durable review with no partial cash effect and does not reactivate after lending again', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(context, 'lend', input(f.party.id, '100'));
    const excessive = input(f.party.id, '101');
    const review = f.loans.recordRepayment(context, 'review', excessive);
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_PENDING_BALANCE');
    assert.equal(review.cashDirection, null);
    assert.equal(review.principalBalanceAfter.minor, 10000n);
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      10000n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      0n,
    );
    f.loans.recordDisbursement(context, 'new-lend', input(f.party.id, '100'));
    assert.deepEqual(
      f.loans.recordRepayment(context, 'review', excessive),
      review,
    );
    assert.equal(
      f.loans.recordRepayment(context, 'new-reviewed-intention', excessive)
        .status,
      'confirmed',
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      9900n,
    );
  } finally {
    f.store.close();
  }
});

test('loans: repayment without any disbursement never fabricates debt or cash', () => {
  const f = setup();
  try {
    const review = f.loans.recordRepayment(
      context,
      'no-principal',
      input(f.party.id, '10', 'payable'),
    );
    assert.equal(review.status, 'review_required');
    assert.equal(review.reviewReason, 'EXCEEDS_PENDING_BALANCE');
    assert.equal(
      f.loans.getPosition(context, query(f.party.id, 'payable')).balance.minor,
      0n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      0,
    );
  } finally {
    f.store.close();
  }
});

test('loans: retroactive repayments cannot borrow capacity from a later disbursement or break a later prefix', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(
      context,
      'first',
      input(f.party.id, '100', 'receivable', '2026-11-01'),
    );
    f.loans.recordRepayment(
      context,
      'settled',
      input(f.party.id, '100', 'receivable', '2026-11-10'),
    );
    f.loans.recordDisbursement(
      context,
      'later',
      input(f.party.id, '100', 'receivable', '2026-11-20'),
    );
    for (const [key, date] of [
      ['before', '2026-10-31'],
      ['middle', '2026-11-05'],
    ]) {
      const review = f.loans.recordRepayment(
        context,
        key!,
        input(f.party.id, '50', 'receivable', date!),
      );
      assert.equal(review.status, 'review_required');
      assert.equal(review.reviewReason, 'PAYMENT_DATE_REQUIRES_REVIEW');
    }
    f.loans.recordDisbursement(
      context,
      'early-funding',
      input(f.party.id, '100', 'receivable', '2026-10-01'),
    );
    const old = f.loans.findIntent(context, 'middle');
    assert.equal(old?.kind, 'loan-movement');
    assert.deepEqual(
      f.loans.recordRepayment(
        context,
        'middle',
        input(f.party.id, '50', 'receivable', '2026-11-05'),
      ),
      old,
    );
    assert.equal(
      f.loans.recordRepayment(
        context,
        'accepted-retroactive',
        input(f.party.id, '50', 'receivable', '2026-11-05'),
      ).status,
      'confirmed',
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      15000n,
    );
  } finally {
    f.store.close();
  }
});

test('loans: financial dates govern positions and monthly cash independently from audit clock', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(
      context,
      'october',
      input(f.party.id, '200', 'receivable', '2026-10-31'),
    );
    f.loans.recordRepayment(
      context,
      'november',
      input(f.party.id, '70', 'receivable', '2026-11-01'),
    );
    f.loans.recordDisbursement(
      context,
      'december',
      input(f.party.id, '50', 'receivable', '2026-12-01'),
    );
    assert.equal(
      f.loans.getPosition(
        context,
        query(f.party.id, 'receivable', '2026-10-30'),
      ).balance.minor,
      0n,
    );
    assert.equal(
      f.loans.getPosition(
        context,
        query(f.party.id, 'receivable', '2026-10-31'),
      ).balance.minor,
      20000n,
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      13000n,
    );
    assert.equal(
      f.loans.getPosition(
        context,
        query(f.party.id, 'receivable', '2026-12-01'),
      ).balance.minor,
      18000n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      0n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      7000n,
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-12' }).outflow.minor,
      5000n,
    );
  } finally {
    f.store.close();
  }
});

test('loans: greater-than-64-bit principal and centavo repayments survive reopening exactly', () => {
  const f = setup();
  const principal = '9223372036854775808.17';
  f.loans.recordDisbursement(
    context,
    'large',
    input(f.party.id, principal, 'payable'),
  );
  const payment = f.loans.recordRepayment(
    context,
    'partial',
    input(f.party.id, '0.16', 'payable'),
  );
  f.store.close();
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new PersonalLoanService(reopened, f.policy, clock);
    assert.deepEqual(api.findIntent(context, 'partial'), payment);
    assert.equal(
      api.getPosition(context, query(f.party.id, 'payable')).balance.minor,
      922337203685477580801n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).inflow.minor,
      922337203685477580817n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).outflow.minor,
      16n,
    );
  } finally {
    reopened.close();
  }
});

test('loans: capital leaves existing earned salary, salary receipts, consumption and budget events unchanged', () => {
  const f = setup();
  try {
    const expenses = new ExpenseService(f.store, f.policy),
      budgets = new MonthlyBudgetService(f.store, f.policy),
      events = new EventDeliveryService(f.store, f.policy, clock),
      salary = new SalaryService(f.store, f.policy, clock);
    const category = expenses.createCategory(context, 'food', {
      name: 'Synthetic food',
    });
    budgets.setBudget(context, 'budget', {
      categoryId: category.id,
      month: '2026-11',
      amount: '100',
    });
    expenses.recordExpense(context, 'consumption', {
      categoryId: category.id,
      amount: '80',
      occurredOn: '2026-11-01',
    });
    salary.configureSalary(context, 'salary', {
      netAmount: '3000000',
      effectiveFrom: '2026-10-01',
    });
    salary.closePeriod(context, 'salary-close', {
      month: '2026-10',
      closedOn: '2026-11-01',
    });
    salary.receivePayment(context, 'salary-received', {
      amount: '800000',
      receivedOn: '2026-11-01',
      reference: 'synthetic employer',
    });
    const snapshot = () =>
      encoded({
        expenses: expenses.monthlyTotals(context, { month: '2026-11' }),
        budget: budgets.getBudgetStatus(context, {
          categoryId: category.id,
          month: '2026-11',
        }),
        events: events.listPending(context),
        salary: salary.getReceivables(context, { asOf: '2026-11-30' }),
        salaryCash: salary.monthlyCashInflow(context, { month: '2026-11' }),
      });
    const before = snapshot();
    f.loans.recordDisbursement(
      context,
      'borrow',
      input(f.party.id, '80000', 'payable'),
    );
    f.loans.recordRepayment(
      context,
      'return',
      input(f.party.id, '30000', 'payable'),
    );
    f.loans.recordDisbursement(context, 'lend', input(f.party.id, '200000'));
    f.loans.recordRepayment(context, 'receive', input(f.party.id, '70000'));
    assert.deepEqual(snapshot(), before);
    assert.equal(
      salary.getReceivables(context, { asOf: '2026-11-30' }).closedEarned.minor,
      300000000n,
    );
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      8000n,
    );
    assert.equal(events.listPending(context).events.length, 1);
    const cash = f.loans.monthlyCashFlow(context, { month: '2026-11' });
    assert.equal(cash.inflow.minor, 15000000n);
    assert.equal(cash.outflow.minor, 23000000n);
    assert.equal(cash.movements.length, 4);
  } finally {
    f.store.close();
  }
});

test('loans: all mutation replays preserve original identities and conflicting payloads do not mutate history', () => {
  const f = setup();
  try {
    assert.deepEqual(
      f.loans.createCounterparty(context, 'party', { name: 'Synthetic Juan' }),
      f.party,
    );
    assert.throws(
      () =>
        f.loans.createCounterparty(context, 'party', {
          name: 'Changed synthetic',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const draft = input(f.party.id, '100');
    const disbursement = f.loans.recordDisbursement(context, 'disburse', draft);
    assert.deepEqual(
      f.loans.recordDisbursement(otherActorContext, 'disburse', draft),
      disbursement,
    );
    assert.equal(disbursement.actorRef, context.actorRef);
    assert.throws(
      () =>
        f.loans.recordDisbursement(context, 'disburse', {
          ...draft,
          amount: '101',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(() => f.loans.recordRepayment(context, 'disburse', draft), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const repay = input(f.party.id, '30'),
      payment = f.loans.recordRepayment(context, 'repay', repay);
    assert.deepEqual(f.loans.recordRepayment(context, 'repay', repay), payment);
    assert.throws(
      () =>
        f.loans.recordRepayment(context, 'repay', {
          ...repay,
          reference: 'changed',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).movements.length,
      2,
    );
  } finally {
    f.store.close();
  }
});

test('loans: intent namespace is shared with expenses, salary, financed debt and recurring concepts', () => {
  const f = setup();
  try {
    const expenses = new ExpenseService(f.store, f.policy),
      salary = new SalaryService(f.store, f.policy, clock),
      bills = new RecurringBillService(f.store, f.policy, clock),
      debts = new FinancedDebtService(f.store, f.policy, clock);
    const category = expenses.createCategory(context, 'expense-key', {
      name: 'Synthetic expenses',
    });
    salary.configureSalary(context, 'salary-key', {
      netAmount: '3000000',
      effectiveFrom: '2026-11-01',
    });
    bills.createConcept(context, 'bill-key', {
      description: 'Synthetic internet',
      categoryId: category.id,
    });
    debts.registerDebt(context, 'debt-key', {
      description: 'Synthetic phone',
      financedAmount: '100',
      installmentCount: 1,
      installmentAmount: '100',
      referenceOn: '2026-11-01',
      referenceBalance: '100',
      historicalPaidInstallments: 0,
    });
    for (const key of ['expense-key', 'salary-key', 'bill-key', 'debt-key']) {
      assert.equal(f.loans.findIntent(context, key), undefined);
      assert.throws(
        () =>
          f.loans.createCounterparty(context, key, {
            name: 'Synthetic conflict',
          }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    }
    assert.equal(expenses.findIntent(context, 'party'), undefined);
    assert.throws(
      () =>
        expenses.createCategory(context, 'party', {
          name: 'Synthetic conflict',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        salary.configureSalary(context, 'party', {
          netAmount: '1',
          effectiveFrom: '2026-12-01',
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(
      () =>
        bills.createConcept(context, 'party', {
          description: 'Synthetic conflict',
          categoryId: category.id,
        }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.store.close();
  }
});

test('loans: subject and instance isolation prevents foreign counterparties and allows independent keys', () => {
  const f = setup();
  try {
    f.loans.recordDisbursement(context, 'same', input(f.party.id, '100'));
    for (const other of [otherSubjectContext, otherInstanceContext]) {
      assert.equal(f.loans.findIntent(other, 'same'), undefined);
      assert.throws(() => f.loans.getPosition(other, query(f.party.id)));
      assert.throws(() =>
        f.loans.recordDisbursement(other, 'foreign', input(f.party.id, '1')),
      );
      assert.equal(f.loans.findIntent(other, 'foreign'), undefined);
      const party = f.loans.createCounterparty(other, 'party', {
        name: 'Synthetic other',
      });
      assert.notEqual(party.id, f.party.id);
      f.loans.recordDisbursement(
        other,
        'same',
        input(party.id, '5', 'payable'),
      );
      assert.equal(
        f.loans.listPositions(other, { asOf: '2026-11-30' }).totalPayable.minor,
        500n,
      );
      assert.equal(
        f.loans.monthlyCashFlow(other, { month: '2026-11' }).inflow.minor,
        500n,
      );
    }
    assert.equal(
      f.loans.getPosition(context, query(f.party.id)).balance.minor,
      10000n,
    );
  } finally {
    f.store.close();
  }
});

test('loans: operation permissions and read authorization are rechecked before every replay', () => {
  const f = setup();
  try {
    const draft = input(f.party.id, '100');
    f.loans.recordDisbursement(context, 'fund', draft);
    const repay = input(f.party.id, '10');
    f.loans.recordRepayment(context, 'repaid', repay);
    f.actions.delete('loan:counterparty');
    assert.throws(
      () =>
        f.loans.createCounterparty(context, 'party', { name: f.party.name }),
      { code: 'FORBIDDEN' },
    );
    f.actions.delete('loan:disburse');
    assert.throws(() => f.loans.recordDisbursement(context, 'fund', draft), {
      code: 'FORBIDDEN',
    });
    f.actions.delete('loan:repay');
    assert.throws(() => f.loans.recordRepayment(context, 'repaid', repay), {
      code: 'FORBIDDEN',
    });
    f.actions.delete('loan:read');
    assert.throws(() => f.loans.getPosition(context, query(f.party.id)), {
      code: 'FORBIDDEN',
    });
    assert.throws(
      () => f.loans.listPositions(context, { asOf: '2026-11-30' }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () => f.loans.monthlyCashFlow(context, { month: '2026-11' }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(() => f.loans.findIntent(context, 'fund'), {
      code: 'FORBIDDEN',
    });
  } finally {
    f.store.close();
  }
});

test('loans: money, names, direction, dates and untrusted identity payloads are validated explicitly', () => {
  const f = setup();
  try {
    for (const [index, amount] of [
      '0',
      '-1',
      '1.001',
      '1e3',
      '2,000',
      'NaN',
    ].entries())
      assert.throws(() =>
        f.loans.recordDisbursement(
          context,
          `invalid-${index}`,
          input(f.party.id, amount),
        ),
      );
    for (const name of ['', '  ', 'bad\nname', 'x'.repeat(201)])
      assert.throws(() =>
        f.loans.createCounterparty(context, 'invalid-name', { name }),
      );
    assert.throws(
      () =>
        f.loans.recordDisbursement(context, 'currency', {
          ...input(f.party.id, '1'),
          currency: 'USD',
        }),
      { code: 'UNSUPPORTED_CURRENCY' },
    );
    assert.throws(() =>
      f.loans.recordDisbursement(
        context,
        'date',
        input(f.party.id, '1', 'receivable', '2026-02-30'),
      ),
    );
    assert.throws(() =>
      f.loans.recordDisbursement(context, 'direction', {
        ...input(f.party.id, '1'),
        // @ts-expect-error Invalid runtime direction must not be inferred.
        direction: 'both',
      }),
    );
    assert.throws(() =>
      f.loans.recordDisbursement(context, 'scope', {
        ...input(f.party.id, '1'),
        // @ts-expect-error Subject identity belongs to trusted context only.
        subjectRef: otherSubjectContext.subjectRef,
      }),
    );
    assert.throws(() =>
      f.loans.recordRepayment(context, 'actor', {
        ...input(f.party.id, '1'),
        // @ts-expect-error Actor must not come from the financial payload.
        actorRef: otherActorContext.actorRef,
      }),
    );
    assert.throws(
      () =>
        f.loans.recordDisbursement(
          { ...context, actorRef: 'untrusted' },
          'forged',
          input(f.party.id, '1'),
        ),
      { code: 'FORBIDDEN' },
    );
    assert.equal(
      f.loans.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      0,
    );
  } finally {
    f.store.close();
  }
});

for (const hook of [
  'afterLoanCounterpartyInsert',
  'afterLoanMovementInsert',
] as const) {
  test(`loans: ${hook} failure rolls back all records and intention before same-key retry`, () => {
    const f = setup();
    f.store.close();
    const failing = new SqliteExpenseStore(f.path, {
      [hook]: () => {
        throw new Error('Synthetic loan failure');
      },
    });
    const invoke = (api: PersonalLoanService) =>
      hook === 'afterLoanCounterpartyInsert'
        ? api.createCounterparty(context, 'operation', {
            name: 'Synthetic new',
          })
        : api.recordDisbursement(
            context,
            'operation',
            input(f.party.id, '100'),
          );
    try {
      const api = new PersonalLoanService(failing, f.policy, clock);
      assert.throws(() => invoke(api), { code: 'STORAGE_IO' });
      assert.equal(api.findIntent(context, 'operation'), undefined);
      assert.equal(
        api.listPositions(context, { asOf: '2026-11-30' }).positions.length,
        1,
      );
      assert.equal(
        api.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
        0,
      );
    } finally {
      failing.close();
    }
    const restored = new SqliteExpenseStore(f.path);
    try {
      const api = new PersonalLoanService(restored, f.policy, clock),
        result = invoke(api);
      assert.deepEqual(invoke(api), result);
      assert.equal(api.findIntent(context, 'operation')?.id, result.id);
    } finally {
      restored.close();
    }
  });
}

test('loans: lost response after committed repayment reopens and replays without duplicate capital or cash', () => {
  const f = setup();
  f.loans.recordDisbursement(context, 'fund', input(f.party.id, '100'));
  f.store.close();
  const failing = new SqliteExpenseStore(f.path, {
    afterLoanCommit: () => {
      throw new Error('Synthetic response loss');
    },
  });
  const draft = input(f.party.id, '30');
  try {
    assert.throws(
      () =>
        new PersonalLoanService(failing, f.policy, clock).recordRepayment(
          context,
          'paid',
          draft,
        ),
      { code: 'STORAGE_IO' },
    );
  } finally {
    failing.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new PersonalLoanService(reopened, f.policy, clock),
      original = api.findIntent(context, 'paid');
    assert.ok(original);
    assert.deepEqual(api.recordRepayment(context, 'paid', draft), original);
    assert.equal(
      api.getPosition(context, query(f.party.id)).balance.minor,
      7000n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      2,
    );
  } finally {
    reopened.close();
  }
});

test('loans: isolated restored snapshot preserves both directions, audit movements and original review decisions', () => {
  const f = setup();
  f.loans.recordDisbursement(context, 'lend', input(f.party.id, '200000'));
  const draft = input(f.party.id, '70000'),
    paid = f.loans.recordRepayment(context, 'paid', draft);
  f.loans.recordDisbursement(
    context,
    'borrow',
    input(f.party.id, '80000', 'payable'),
  );
  const excessive = input(f.party.id, '90000', 'payable'),
    review = f.loans.recordRepayment(context, 'review', excessive);
  const before = encoded(
    f.loans.listPositions(context, { asOf: '2026-11-30' }),
  );
  const backup = pathFor(),
    destination = pathFor();
  f.store.backupTo(backup);
  f.loans.recordDisbursement(context, 'after-snapshot', input(f.party.id, '1'));
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, destination);
  const restored = new SqliteExpenseStore(destination);
  try {
    const api = new PersonalLoanService(restored, f.policy, clock);
    assert.deepEqual(
      encoded(api.listPositions(context, { asOf: '2026-11-30' })),
      before,
    );
    assert.deepEqual(api.recordRepayment(context, 'paid', draft), paid);
    assert.deepEqual(api.recordRepayment(context, 'review', excessive), review);
    assert.equal(api.findIntent(context, 'after-snapshot'), undefined);
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      3,
    );
    assert.equal(
      api.getPosition(context, query(f.party.id, 'payable')).movements.length,
      2,
    );
  } finally {
    restored.close();
  }
});

interface Reply {
  type: 'ready' | 'result' | 'error';
  result?: { id: string; kind: string; status: string };
  code?: string;
}
async function race(
  path: string,
  jobs: readonly {
    key: string;
    operation: 'disburse' | 'repay';
    input: object;
  }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/personal-loan-worker.ts', import.meta.url),
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
      const error = new Error('Synthetic loan worker timed out');
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
        const error = new Error(`Loan worker exited without result (${code})`);
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

for (const scenario of ['replay', 'conflict', 'overpayment'] as const) {
  test(`loans: concurrent processes ${scenario} preserve one atomic principal history`, async () => {
    const f = setup();
    f.loans.recordDisbursement(context, 'lend', input(f.party.id, '100'));
    f.store.close();
    const first = input(f.party.id, '70');
    const jobs = [
      { key: 'repay', operation: 'repay' as const, input: first },
      {
        key: scenario === 'overpayment' ? 'repay-two' : 'repay',
        operation: 'repay' as const,
        input:
          scenario === 'conflict'
            ? { ...first, reference: 'different-synthetic' }
            : first,
      },
    ];
    const replies = await race(f.path, jobs);
    if (scenario === 'replay') {
      assert.equal(replies[0]?.type, 'result');
      assert.equal(replies[1]?.type, 'result');
      assert.equal(replies[0]?.result?.id, replies[1]?.result?.id);
    } else if (scenario === 'conflict') {
      assert.equal(
        replies.filter((reply) => reply.type === 'result').length,
        1,
      );
      assert.equal(
        replies.find((reply) => reply.type === 'error')?.code,
        'IDEMPOTENCY_CONFLICT',
      );
    } else {
      assert.equal(
        replies.filter((reply) => reply.result?.status === 'confirmed').length,
        1,
      );
      assert.equal(
        replies.filter((reply) => reply.result?.status === 'review_required')
          .length,
        1,
      );
    }
    const reopened = new SqliteExpenseStore(f.path);
    try {
      const api = new PersonalLoanService(reopened, f.policy, clock);
      assert.equal(
        api.getPosition(context, query(f.party.id)).balance.minor,
        3000n,
      );
      assert.equal(
        api.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
        2,
      );
    } finally {
      reopened.close();
    }
  });
}
test('loans: distinct concurrent disbursements both remain in the aggregate', async () => {
  const f = setup();
  f.store.close();
  const replies = await race(f.path, [
    { key: 'first', operation: 'disburse', input: input(f.party.id, '200000') },
    { key: 'second', operation: 'disburse', input: input(f.party.id, '50000') },
  ]);
  assert.equal(
    replies.every((reply) => reply.type === 'result'),
    true,
  );
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const api = new PersonalLoanService(reopened, f.policy, clock);
    assert.equal(
      api.getPosition(context, query(f.party.id)).balance.minor,
      25000000n,
    );
    assert.equal(
      api.monthlyCashFlow(context, { month: '2026-11' }).movements.length,
      2,
    );
  } finally {
    reopened.close();
  }
});
