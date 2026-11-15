import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { DomainError } from '../src/domain/errors.ts';
import { Money } from '../src/domain/money.ts';
import { budgetThreshold } from '../src/domain/monthly-budgets.ts';
import { StorageError } from '../src/infrastructure/sqlite-errors.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'budget-tests');
mkdirSync(root, { recursive: true });
const runDirectory = mkdtempSync(join(root, 'budgets-'));
let sequence = 0;
const databasePath = () => join(runDirectory, `fixture-${++sequence}.sqlite`);

function policyFixture() {
  const actions = new Set<Action>([
    'category:create',
    'expense:record',
    'expense:read',
    'expense:correct',
    'budget:write',
    'budget:read',
  ]);
  const contexts = [context, otherSubjectContext, otherInstanceContext];
  const policy: AccessPolicy = {
    allows(candidate, action) {
      return (
        actions.has(action) &&
        contexts.some(
          (allowed) =>
            candidate.actorRef === allowed.actorRef &&
            candidate.subjectRef === allowed.subjectRef &&
            candidate.instanceRef === allowed.instanceRef,
        )
      );
    },
  };
  return { actions, policy };
}
function services(store: SqliteExpenseStore, policy: AccessPolicy) {
  return {
    expenses: new ExpenseService(store, policy),
    corrections: new ExpenseCorrectionsService(
      store,
      policy,
      () => '2026-11-14T12:00:00.000Z',
    ),
    budgets: new MonthlyBudgetService(store, policy),
  };
}
function setup() {
  const path = databasePath();
  const store = new SqliteExpenseStore(path);
  const { actions, policy } = policyFixture();
  const api = services(store, policy);
  const category = api.expenses.createCategory(context, 'category', {
    name: 'Gasolina sintética',
  });
  const input = { categoryId: category.id, month: '2026-11', amount: '100.00' };
  const spend = (
    key: string,
    amount: string,
    occurredOn = '2026-11-08',
    categoryId = category.id,
  ) =>
    api.expenses.recordExpense(context, key, {
      amount,
      categoryId,
      occurredOn,
    });
  const status = (month = '2026-11', categoryId = category.id) =>
    api.budgets.getBudgetStatus(context, { month, categoryId });
  return {
    path,
    store,
    actions,
    policy,
    ...api,
    category,
    input,
    spend,
    status,
  };
}
function hasCode(code: string) {
  return (error: unknown) =>
    (error instanceof DomainError || error instanceof StorageError) &&
    error.code === code;
}
interface WorkerReply {
  type: 'ready' | 'result' | 'error';
  code?: string;
  id?: string;
}
async function race(
  path: string,
  categoryId: string,
  jobs: readonly { mode: 'set' | 'spend'; key: string; amount: string }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/budget-worker.ts', import.meta.url),
      [path, job.mode, job.key, categoryId, job.amount],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveDone!: (reply: WorkerReply) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<WorkerReply>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    let reply: WorkerReply | undefined;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('Budget fixture worker timed out');
      rejectReady(error);
      rejectDone(error);
    }, 15000);
    child.on('message', (message: WorkerReply) => {
      if (message.type === 'ready') resolveReady();
      else {
        reply = message;
        resolveReady();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReady(error);
      rejectDone(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (reply) {
        resolveReady();
        resolveDone(reply);
      } else {
        const error = new Error(
          `Budget worker exited without result (${code})`,
        );
        rejectReady(error);
        rejectDone(error);
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

test('monthly budget domain: exact integer thresholds at boundaries and beyond 64 bits', () => {
  const limit = Money.fromMinor(10n ** 30n);
  const eighty = (limit.minor * 80n) / 100n;
  assert.equal(budgetThreshold(limit, Money.fromMinor(eighty - 1n)), null);
  assert.equal(budgetThreshold(limit, Money.fromMinor(eighty)), 80);
  assert.equal(budgetThreshold(limit, Money.fromMinor(limit.minor - 1n)), 80);
  assert.equal(budgetThreshold(limit, limit), 100);
  assert.equal(budgetThreshold(limit, Money.fromMinor(limit.minor + 1n)), 100);
  assert.equal(budgetThreshold(Money.fromMinor(0n), Money.fromMinor(0n)), null);
  assert.equal(budgetThreshold(Money.fromMinor(0n), Money.fromMinor(1n)), 100);
});

test('monthly budget: absent budget, zero budget and positive limits are distinct', () => {
  const f = setup();
  try {
    assert.equal(f.status().budget, null);
    assert.equal(f.status().percentage, null);
    assert.deepEqual(f.status().alerts, []);
    const budget = f.budgets.setBudget(context, 'zero', {
      ...f.input,
      amount: '0',
    });
    assert.equal(f.status().budget?.id, budget.id);
    assert.equal(f.status().budget?.amount.minor, 0n);
    assert.equal(f.status().percentage, null);
    assert.deepEqual(f.status().alerts, []);
    f.spend('positive', '0.01');
    assert.equal(f.status().consumed.minor, 1n);
    assert.deepEqual(
      f.status().alerts.map((alert) => alert.threshold),
      [100],
    );
    assert.equal(f.status().percentage, null);
  } finally {
    f.store.close();
  }
});

test('monthly budget: independent categories and explicit months without carryforward', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'november', f.input);
    const second = f.expenses.createCategory(context, 'food', {
      name: 'Alimentación sintética',
    });
    f.spend('gas', '25');
    f.spend('food-spend', '60', '2026-11-08', second.id);
    f.spend('december-spend', '20', '2026-12-01');
    assert.equal(f.status().consumed.minor, 2500n);
    assert.equal(f.status('2026-11', second.id).budget, null);
    assert.equal(f.status('2026-11', second.id).consumed.minor, 6000n);
    assert.equal(f.status('2026-12').budget, null);
    assert.equal(f.status('2026-12').consumed.minor, 2000n);
    f.budgets.setBudget(context, 'december', {
      ...f.input,
      month: '2026-12',
      amount: '30',
    });
    assert.equal(f.status('2026-12').budget?.amount.minor, 3000n);
    assert.equal(f.status().budget?.amount.minor, 10000n);
    assert.deepEqual(f.status('2026-12').alerts, []);
  } finally {
    f.store.close();
  }
});

test('monthly budget: exact 80 and 100 percent emit one durable event each', () => {
  const f = setup();
  try {
    const budget = f.budgets.setBudget(context, 'limit', f.input);
    f.spend('below', '79.99');
    assert.deepEqual(f.status().alerts, []);
    f.spend('eighty', '0.01');
    const first = f.status();
    assert.equal(
      first.percentage?.numerator,
      first.percentage!.denominator * 80n,
    );
    assert.deepEqual(
      first.alerts.map((alert) => alert.threshold),
      [80],
    );
    assert.equal(first.alerts[0]?.consumed.minor, 8000n);
    assert.equal(first.alerts[0]?.budgetId, budget.id);
    assert.equal(first.alerts[0]?.triggerIntentKey, 'eighty');
    f.spend('hundred', '20');
    const at100 = f.status();
    assert.equal(
      at100.percentage?.numerator,
      at100.percentage!.denominator * 100n,
    );
    assert.deepEqual(
      at100.alerts.map((alert) => alert.threshold).sort(),
      [80, 100].sort(),
    );
    f.spend('later', '50');
    f.spend('later', '50');
    assert.deepEqual(f.status().alerts, at100.alerts);
    assert.equal(f.status().consumed.minor, 15000n);
  } finally {
    f.store.close();
  }
});

test('monthly budget: direct jump to 100 emits only 100 and suppresses later 80 rebound', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'limit', f.input);
    const original = f.spend('jump', '120');
    const events = f.status().alerts;
    assert.deepEqual(
      events.map((alert) => alert.threshold),
      [100],
    );
    f.corrections.replaceExpense(context, 'lower', {
      expenseId: original.id,
      reason: 'Importe sintético corregido',
      replacement: {
        amount: '40',
        currency: 'COP',
        categoryId: f.category.id,
        occurredOn: '2026-11-08',
      },
    });
    assert.equal(f.status().consumed.minor, 4000n);
    f.spend('rebound', '40');
    assert.deepEqual(f.status().alerts, events);
    assert.equal(f.status().consumed.minor, 8000n);
  } finally {
    f.store.close();
  }
});

test('monthly budget: repeating equivalent set preserves original result and conflicts across operations', () => {
  const f = setup();
  try {
    const original = f.budgets.setBudget(context, 'limit', f.input);
    assert.deepEqual(
      f.budgets.setBudget(context, 'limit', {
        ...f.input,
        amount: '100',
        currency: 'COP',
      }),
      original,
    );
    f.budgets.setBudget(context, 'revision', { ...f.input, amount: '150' });
    assert.deepEqual(f.budgets.setBudget(context, 'limit', f.input), original);
    assert.equal(f.status().budget?.amount.minor, 15000n);
    assert.deepEqual(f.budgets.findIntent(context, 'limit'), original);
    assert.throws(
      () =>
        f.budgets.setBudget(context, 'limit', { ...f.input, amount: '101' }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () => f.spend('limit', '100'),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () => f.expenses.createCategory(context, 'limit', { name: 'Otra' }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () => f.budgets.setBudget(context, 'category', f.input),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: late budget and revisions evaluate current consumption without spending', () => {
  const f = setup();
  try {
    f.spend('historical', '80');
    assert.deepEqual(f.status().alerts, []);
    const original = f.budgets.setBudget(context, 'limit', f.input);
    assert.deepEqual(
      f.status().alerts.map((alert) => alert.threshold),
      [80],
    );
    f.budgets.setBudget(context, 'lower', { ...f.input, amount: '80' });
    assert.deepEqual(
      f
        .status()
        .alerts.map((alert) => alert.threshold)
        .sort(),
      [80, 100].sort(),
    );
    const alerts = f.status().alerts;
    f.budgets.setBudget(context, 'higher', { ...f.input, amount: '200' });
    f.budgets.setBudget(context, 'lower-again', f.input);
    assert.deepEqual(f.status().alerts, alerts);
    assert.equal(f.status().consumed.minor, 8000n);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      8000n,
    );
    assert.deepEqual(f.budgets.findIntent(context, 'limit'), original);
  } finally {
    f.store.close();
  }
});

test('monthly budget: corrections move consumption across category and date with historical events retained', () => {
  const f = setup();
  try {
    const second = f.expenses.createCategory(context, 'second', {
      name: 'Otra sintética',
    });
    f.budgets.setBudget(context, 'november', f.input);
    f.budgets.setBudget(context, 'october-other', {
      ...f.input,
      month: '2026-10',
      categoryId: second.id,
    });
    const original = f.spend('original', '80');
    const novemberEvents = f.status().alerts;
    const correction = f.corrections.replaceExpense(context, 'correction', {
      expenseId: original.id,
      reason: 'Categoría y fecha corregidas',
      replacement: {
        amount: '100',
        currency: 'COP',
        categoryId: second.id,
        occurredOn: '2026-10-31',
      },
    });
    assert.equal(f.status().consumed.minor, 0n);
    assert.deepEqual(f.status().alerts, novemberEvents);
    assert.equal(f.status('2026-10', second.id).consumed.minor, 10000n);
    assert.deepEqual(
      f.status('2026-10', second.id).alerts.map((alert) => alert.threshold),
      [100],
    );
    f.corrections.voidExpense(context, 'void-replacement', {
      expenseId: correction.replacement!.id,
      reason: 'Anulación sintética',
    });
    assert.equal(f.status('2026-10', second.id).consumed.minor, 0n);
    assert.equal(f.status('2026-10', second.id).alerts.length, 1);
    f.spend('original', '80');
    assert.equal(f.status().consumed.minor, 0n);
  } finally {
    f.store.close();
  }
});

test('monthly budget: same-period replacement counts only replacement and replays do not repeat alerts', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'limit', f.input);
    const original = f.spend('original', '50');
    const input = {
      expenseId: original.id,
      reason: 'Importe corregido',
      replacement: {
        amount: '80',
        currency: 'COP',
        categoryId: f.category.id,
        occurredOn: '2026-11-08',
      },
    };
    const correction = f.corrections.replaceExpense(
      context,
      'correction',
      input,
    );
    const events = f.status().alerts;
    assert.equal(f.status().consumed.minor, 8000n);
    assert.deepEqual(
      events.map((alert) => alert.threshold),
      [80],
    );
    assert.deepEqual(
      f.corrections.replaceExpense(context, 'correction', input),
      correction,
    );
    assert.deepEqual(f.status().alerts, events);
    assert.equal(
      f.expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      8000n,
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: budgets and consumption above 64 bits preserve exact threshold comparisons', () => {
  const f = setup();
  try {
    const limit = 100000000000000000000000000000n;
    f.budgets.setBudget(context, 'huge', {
      ...f.input,
      amount: limit.toString(),
    });
    const eighty = (limit * 80n) / 100n;
    f.spend('just-below', `${eighty - 1n}.99`);
    assert.deepEqual(f.status().alerts, []);
    f.spend('exact-eighty', '0.01');
    const status = f.status();
    assert.equal(status.budget?.amount.minor, limit * 100n);
    assert.equal(status.consumed.minor, eighty * 100n);
    assert.equal(
      status.percentage?.numerator,
      status.percentage!.denominator * 80n,
    );
    assert.deepEqual(
      status.alerts.map((alert) => alert.threshold),
      [80],
    );
    f.spend('exact-hundred', (limit - eighty).toString());
    assert.equal(f.status().consumed.minor, limit * 100n);
    assert.deepEqual(
      f
        .status()
        .alerts.map((alert) => alert.threshold)
        .sort(),
      [80, 100].sort(),
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: repeating fraction remains exact rather than rounded for decisions', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'three', { ...f.input, amount: '3' });
    f.spend('one', '1');
    const ratio = f.status().percentage!;
    assert.equal(ratio.numerator * 3n, ratio.denominator * 100n);
    assert.deepEqual(f.status().alerts, []);
  } finally {
    f.store.close();
  }
});

test('monthly budget: validation failures do not consume the intention', () => {
  const f = setup();
  try {
    for (const input of [
      { ...f.input, month: '2026-13' },
      { ...f.input, month: '2026-1' },
      { ...f.input, amount: '-1' },
      { ...f.input, amount: '1.001' },
      { ...f.input, currency: 'USD' },
      { ...f.input, subjectRef: 'editable' },
    ]) {
      assert.throws(() => f.budgets.setBudget(context, 'validation', input));
      assert.equal(f.budgets.findIntent(context, 'validation'), undefined);
    }
    assert.throws(
      () =>
        f.budgets.setBudget(context, 'validation', {
          ...f.input,
          categoryId: 'missing',
        }),
      hasCode('CATEGORY_NOT_FOUND'),
    );
    assert.throws(
      () =>
        f.budgets.setBudget(context, 'validation', {
          ...f.input,
          amount: '1' + '0'.repeat(4096),
        }),
      hasCode('STORAGE_LIMIT'),
    );
    assert.equal(f.budgets.findIntent(context, 'validation'), undefined);
    assert.equal(
      f.budgets.setBudget(context, 'validation', f.input).amount.minor,
      10000n,
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: permissions are checked before replay and reads', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'limit', f.input);
    f.actions.delete('budget:write');
    assert.throws(
      () => f.budgets.setBudget(context, 'limit', f.input),
      hasCode('FORBIDDEN'),
    );
    f.actions.delete('budget:read');
    assert.throws(() => f.status(), hasCode('FORBIDDEN'));
    assert.throws(
      () => f.budgets.findIntent(context, 'limit'),
      hasCode('FORBIDDEN'),
    );
    assert.throws(
      () =>
        f.budgets.setBudget(
          { ...context, actorRef: 'intruder' },
          'other',
          f.input,
        ),
      hasCode('FORBIDDEN'),
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: shared intention namespace does not bypass read permissions by domain', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'limit', f.input);
    const expense = f.spend('expense', '20');
    f.corrections.voidExpense(context, 'void', {
      expenseId: expense.id,
      reason: 'Anulación sintética',
    });
    f.actions.delete('expense:read');
    assert.equal(f.budgets.findIntent(context, 'expense'), undefined);
    assert.equal(f.budgets.findIntent(context, 'void'), undefined);
    assert.equal(f.budgets.findIntent(context, 'category'), undefined);
    f.actions.add('expense:read');
    f.actions.delete('budget:read');
    assert.equal(f.expenses.findIntent(context, 'limit'), undefined);
    assert.equal(f.corrections.findIntent(context, 'limit'), undefined);
    assert.throws(
      () => f.spend('limit', '20'),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    f.store.close();
  }
});

test('monthly budget: 80 percent survives correction rebounds and each month has fresh thresholds', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'november', f.input);
    f.budgets.setBudget(context, 'december', { ...f.input, month: '2026-12' });
    const original = f.spend('eighty', '80');
    const events = f.status().alerts;
    f.corrections.voidExpense(context, 'void', {
      expenseId: original.id,
      reason: 'Anulación sintética',
    });
    f.spend('rebound', '80');
    assert.deepEqual(f.status().alerts, events);
    f.spend('hundred', '20');
    assert.deepEqual(
      f
        .status()
        .alerts.map((alert) => alert.threshold)
        .sort(),
      [80, 100].sort(),
    );
    f.spend('december-eighty', '80', '2026-12-01');
    assert.deepEqual(
      f.status('2026-12').alerts.map((alert) => alert.threshold),
      [80],
    );
    assert.notEqual(f.status('2026-12').alerts[0]?.id, events[0]?.id);
  } finally {
    f.store.close();
  }
});

test('monthly budget: instance and subject boundaries protect categories, budgets and alerts', () => {
  const f = setup();
  try {
    f.budgets.setBudget(context, 'shared-key', f.input);
    f.spend('eighty', '80');
    for (const other of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(
        () => f.budgets.getBudgetStatus(other, f.input),
        hasCode('INVALID_INPUT'),
      );
      assert.throws(
        () =>
          f.budgets.getBudgetStatus(other, {
            month: f.input.month,
            categoryId: f.category.id,
          }),
        hasCode('CATEGORY_NOT_FOUND'),
      );
      assert.throws(
        () => f.budgets.setBudget(other, 'shared-key', f.input),
        hasCode('CATEGORY_NOT_FOUND'),
      );
      assert.equal(f.budgets.findIntent(other, 'shared-key'), undefined);
      const category = f.expenses.createCategory(other, 'category', {
        name: 'Otra categoría',
      });
      f.budgets.setBudget(other, 'shared-key', {
        ...f.input,
        categoryId: category.id,
      });
      const status = f.budgets.getBudgetStatus(other, {
        month: f.input.month,
        categoryId: category.id,
      });
      assert.equal(status.consumed.minor, 0n);
      assert.deepEqual(status.alerts, []);
    }
    assert.equal(f.status().alerts.length, 1);
  } finally {
    f.store.close();
  }
});

test('monthly budget: failure after budget insertion rolls back the revision and intention', () => {
  const f = setup();
  f.budgets.setBudget(context, 'first', f.input);
  f.store.close();
  let fail = true;
  const store = new SqliteExpenseStore(f.path, {
    afterBudgetInsert: () => {
      if (fail) throw new Error('synthetic');
    },
  });
  const { budgets } = services(store, f.policy);
  try {
    const input = { ...f.input, amount: '80' };
    assert.throws(
      () => budgets.setBudget(context, 'revision', input),
      hasCode('STORAGE_IO'),
    );
    assert.equal(budgets.findIntent(context, 'revision'), undefined);
    assert.equal(
      budgets.getBudgetStatus(context, {
        month: f.input.month,
        categoryId: f.category.id,
      }).budget?.amount.minor,
      10000n,
    );
    fail = false;
    budgets.setBudget(context, 'revision', input);
    assert.equal(
      budgets.getBudgetStatus(context, {
        month: f.input.month,
        categoryId: f.category.id,
      }).budget?.amount.minor,
      8000n,
    );
  } finally {
    store.close();
  }
});

test('monthly budget: alert failure rolls back a newly established budget on existing consumption', () => {
  const f = setup();
  f.spend('original', '80');
  f.store.close();
  let fail = true;
  const store = new SqliteExpenseStore(f.path, {
    afterAlertInsert: () => {
      if (fail) throw new Error('synthetic');
    },
  });
  const { budgets, expenses } = services(store, f.policy);
  const query = { month: f.input.month, categoryId: f.category.id };
  try {
    assert.throws(
      () => budgets.setBudget(context, 'limit', f.input),
      hasCode('STORAGE_IO'),
    );
    assert.equal(budgets.findIntent(context, 'limit'), undefined);
    assert.equal(budgets.getBudgetStatus(context, query).budget, null);
    assert.equal(budgets.getBudgetStatus(context, query).consumed.minor, 8000n);
    assert.deepEqual(budgets.getBudgetStatus(context, query).alerts, []);
    assert.equal(expenses.findIntent(context, 'original')?.kind, 'expense');
    fail = false;
    budgets.setBudget(context, 'limit', f.input);
    assert.deepEqual(
      budgets
        .getBudgetStatus(context, query)
        .alerts.map((alert) => alert.threshold),
      [80],
    );
  } finally {
    store.close();
  }
});

test('monthly budget: alert failure rolls back expense and allows the same key retry', () => {
  const f = setup();
  f.budgets.setBudget(context, 'limit', f.input);
  f.store.close();
  let fail = true;
  const store = new SqliteExpenseStore(f.path, {
    afterAlertInsert: () => {
      if (fail) throw new Error('synthetic');
    },
  });
  const { budgets, expenses } = services(store, f.policy);
  const query = { month: f.input.month, categoryId: f.category.id };
  const input = {
    categoryId: f.category.id,
    amount: '80',
    occurredOn: '2026-11-08',
  };
  try {
    assert.throws(
      () => expenses.recordExpense(context, 'expense', input),
      hasCode('STORAGE_IO'),
    );
    assert.equal(expenses.findIntent(context, 'expense'), undefined);
    assert.equal(budgets.getBudgetStatus(context, query).consumed.minor, 0n);
    assert.deepEqual(budgets.getBudgetStatus(context, query).alerts, []);
    fail = false;
    expenses.recordExpense(context, 'expense', input);
    assert.deepEqual(
      budgets
        .getBudgetStatus(context, query)
        .alerts.map((alert) => alert.threshold),
      [80],
    );
  } finally {
    store.close();
  }
});

test('monthly budget: alert failure rolls back correction and replacement as a unit', () => {
  const f = setup();
  f.budgets.setBudget(context, 'limit', f.input);
  const original = f.spend('original', '40');
  f.store.close();
  let fail = true;
  const store = new SqliteExpenseStore(f.path, {
    afterAlertInsert: () => {
      if (fail) throw new Error('synthetic');
    },
  });
  const { budgets, corrections } = services(store, f.policy);
  const query = { month: f.input.month, categoryId: f.category.id };
  const input = {
    expenseId: original.id,
    reason: 'Corrección sintética',
    replacement: {
      amount: '100',
      categoryId: f.category.id,
      occurredOn: '2026-11-08',
      currency: 'COP',
    },
  };
  try {
    assert.throws(
      () => corrections.replaceExpense(context, 'correction', input),
      hasCode('STORAGE_IO'),
    );
    assert.equal(corrections.findIntent(context, 'correction'), undefined);
    assert.equal(
      corrections.getExpenseHistory(context, original.id).status,
      'active',
    );
    assert.equal(budgets.getBudgetStatus(context, query).consumed.minor, 4000n);
    assert.deepEqual(budgets.getBudgetStatus(context, query).alerts, []);
    fail = false;
    corrections.replaceExpense(context, 'correction', input);
    assert.equal(
      budgets.getBudgetStatus(context, query).consumed.minor,
      10000n,
    );
    assert.deepEqual(
      budgets
        .getBudgetStatus(context, query)
        .alerts.map((alert) => alert.threshold),
      [100],
    );
  } finally {
    store.close();
  }
});

test('monthly budget: reopening and restored copies preserve budgets, alerts and correction links', () => {
  const f = setup();
  const budget = f.budgets.setBudget(context, 'limit', f.input);
  const original = f.spend('original', '80');
  const correction = f.corrections.replaceExpense(context, 'correction', {
    expenseId: original.id,
    reason: 'Corrección sintética',
    replacement: {
      amount: '100',
      currency: 'COP',
      categoryId: f.category.id,
      occurredOn: '2026-11-08',
    },
  });
  const expected = f.status();
  const backup = databasePath();
  const restored = databasePath();
  f.store.backupTo(backup);
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restored);
  for (const path of [f.path, restored]) {
    const store = new SqliteExpenseStore(path);
    const { budgets, corrections, expenses } = services(store, f.policy);
    try {
      assert.deepEqual(
        budgets.getBudgetStatus(context, {
          month: f.input.month,
          categoryId: f.category.id,
        }),
        expected,
      );
      assert.deepEqual(budgets.setBudget(context, 'limit', f.input), budget);
      assert.deepEqual(
        corrections.findIntent(context, 'correction'),
        correction,
      );
      assert.equal(
        corrections.getExpenseHistory(context, correction.replacement!.id)
          .replaces?.id,
        correction.id,
      );
      expenses.recordExpense(context, 'after-restore', {
        amount: '20',
        categoryId: f.category.id,
        occurredOn: '2026-11-20',
      });
      assert.deepEqual(
        budgets.getBudgetStatus(context, {
          month: f.input.month,
          categoryId: f.category.id,
        }).alerts,
        expected.alerts,
      );
    } finally {
      store.close();
    }
  }
});

test('monthly budget: two processes retry the same budget intention with one durable identity', async () => {
  const f = setup();
  f.store.close();
  const replies = await race(f.path, f.category.id, [
    { mode: 'set', key: 'limit', amount: '100' },
    { mode: 'set', key: 'limit', amount: '100.00' },
  ]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.equal(replies[0]?.id, replies[1]?.id);
  const store = new SqliteExpenseStore(f.path);
  try {
    const { budgets } = services(store, f.policy);
    assert.equal(
      budgets.getBudgetStatus(context, {
        month: f.input.month,
        categoryId: f.category.id,
      }).budget?.id,
      replies[0]?.id,
    );
  } finally {
    store.close();
  }
});

test('monthly budget: conflicting process retries select one result without partial revisions', async () => {
  const f = setup();
  f.store.close();
  const replies = await race(f.path, f.category.id, [
    { mode: 'set', key: 'limit', amount: '100' },
    { mode: 'set', key: 'limit', amount: '200' },
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
    ['IDEMPOTENCY_CONFLICT'],
  );
  const store = new SqliteExpenseStore(f.path);
  try {
    const { budgets } = services(store, f.policy);
    assert.equal(
      budgets.getBudgetStatus(context, {
        month: f.input.month,
        categoryId: f.category.id,
      }).budget?.id,
      replies.find((reply) => reply.type === 'result')?.id,
    );
  } finally {
    store.close();
  }
});

test('monthly budget: concurrent processes cross each threshold once and recover after process exit', async () => {
  const f = setup();
  f.budgets.setBudget(context, 'limit', f.input);
  f.spend('initial', '60');
  f.store.close();
  const jobs = [
    { mode: 'spend' as const, key: 'one', amount: '20' },
    { mode: 'spend' as const, key: 'two', amount: '20' },
  ];
  const replies = await race(f.path, f.category.id, jobs);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  const retried = await race(f.path, f.category.id, jobs);
  assert.deepEqual(retried, replies);
  const store = new SqliteExpenseStore(f.path);
  try {
    const { budgets } = services(store, f.policy);
    const status = budgets.getBudgetStatus(context, {
      month: f.input.month,
      categoryId: f.category.id,
    });
    assert.equal(status.consumed.minor, 10000n);
    assert.deepEqual(
      status.alerts.map((alert) => alert.threshold).sort(),
      [80, 100].sort(),
    );
    assert.equal(new Set(status.alerts.map((alert) => alert.id)).size, 2);
  } finally {
    store.close();
  }
});
