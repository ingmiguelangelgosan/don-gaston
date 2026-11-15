import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventDeliveryService } from '../src/application/event-delivery-service.ts';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import { MonthlyBudgetService } from '../src/application/monthly-budget-service.ts';
import type {
  AccessContext,
  AccessPolicy,
  Action,
} from '../src/application/expense-store.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
  otherActorContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'event-delivery-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'delivery-'));
let sequence = 0;
const databasePath = () => join(directory, `fixture-${++sequence}.sqlite`);
const clock = () => '2026-11-14T12:00:00.000Z';

function setup() {
  const path = databasePath();
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
  const expenses = new ExpenseService(store, policy);
  const budgets = new MonthlyBudgetService(store, policy);
  const delivery = new EventDeliveryService(store, policy, clock);
  let categorySequence = 0;
  const addEvents = (scope: AccessContext = context) => {
    const number = ++categorySequence;
    const category = expenses.createCategory(scope, `category-${number}`, {
      name: `Synthetic category ${number}`,
    });
    budgets.setBudget(scope, `budget-${number}`, {
      categoryId: category.id,
      month: '2026-11',
      amount: '100',
    });
    const firstExpense = expenses.recordExpense(scope, `expense-80-${number}`, {
      categoryId: category.id,
      amount: '80',
      occurredOn: '2026-11-01',
    });
    expenses.recordExpense(scope, `expense-100-${number}`, {
      categoryId: category.id,
      amount: '20',
      occurredOn: '2026-11-02',
    });
    const alerts = budgets.getBudgetStatus(scope, {
      categoryId: category.id,
      month: '2026-11',
    }).alerts;
    return { category, alerts, firstExpense };
  };
  return {
    path,
    store,
    actions,
    policy,
    expenses,
    budgets,
    delivery,
    addEvents,
  };
}
function ids(page: ReturnType<EventDeliveryService['listPending']>) {
  return page.events.map((event) => event.id);
}

interface WorkerReply {
  type: 'ready' | 'result' | 'error';
  code?: string;
  result?: unknown;
}
async function race(
  path: string,
  jobs: readonly { mode: 'ack' | 'list'; eventId?: string }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/event-delivery-worker.ts', import.meta.url),
      [path, job.mode, job.eventId ?? 'unused'],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let doneResolve!: (reply: WorkerReply) => void;
    let doneReject!: (error: Error) => void;
    const done = new Promise<WorkerReply>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    let reply: WorkerReply | undefined;
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('Synthetic delivery worker timed out');
      readyReject(error);
      doneReject(error);
    }, 15000);
    child.on('message', (message: WorkerReply) => {
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
          `Delivery worker exited without result (${code})`,
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

test('event delivery: empty feed and minimized versioned payload reuse immutable alert IDs', () => {
  const f = setup();
  try {
    assert.deepEqual(f.delivery.listPending(context, {}), {
      version: 1,
      events: [],
      nextCursor: null,
    });
    const { alerts, category } = f.addEvents();
    const page = f.delivery.listPending(context, {});
    assert.equal(page.version, 1);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      ids(page),
      alerts.map((alert) => alert.id),
    );
    assert.deepEqual(
      page.events.map((event) => ({ ...event })),
      alerts.map((alert) => ({
        version: 1,
        type: 'budget.threshold-reached',
        id: alert.id,
        categoryId: category.id,
        month: '2026-11',
        threshold: alert.threshold,
      })),
    );
    assert.ok(!JSON.stringify(page).includes('consumed'));
    assert.ok(!JSON.stringify(page).includes('Synthetic category'));
    assert.deepEqual(f.delivery.listPending(context, {}).events, page.events);
  } finally {
    f.store.close();
  }
});

test('event delivery: keyset pagination traverses 52 pending events without losses or duplicates', () => {
  const f = setup();
  try {
    const expected: string[] = [];
    for (let i = 0; i < 26; i++)
      expected.push(...f.addEvents().alerts.map((alert) => alert.id));
    assert.equal(f.delivery.listPending(context, {}).events.length, 50);
    assert.equal(
      f.delivery.listPending(context, { limit: 100 }).events.length,
      52,
    );
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = f.delivery.listPending(context, {
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      actual.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, expected.length);
    assert.deepEqual(
      ids(f.delivery.listPending(context, { limit: 100 })),
      expected,
    );
  } finally {
    f.store.close();
  }
});

test('event delivery: page boundaries do not produce an unnecessary trailing cursor', () => {
  const f = setup();
  try {
    f.addEvents();
    f.addEvents();
    const first = f.delivery.listPending(context, { limit: 2 });
    assert.ok(first.nextCursor);
    const last = f.delivery.listPending(context, {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.equal(last.events.length, 2);
    assert.equal(last.nextCursor, null);
    assert.deepEqual(
      f.delivery.listPending(context, { limit: 2, cursor: first.nextCursor })
        .events,
      last.events,
    );
  } finally {
    f.store.close();
  }
});

test('event delivery: new events stay outside an existing cursor snapshot and appear on the next pass', () => {
  const f = setup();
  try {
    const firstAlerts = f.addEvents().alerts;
    const first = f.delivery.listPending(context, { limit: 1 });
    assert.ok(first.nextCursor);
    const appended = f.addEvents().alerts;
    const rest = f.delivery.listPending(context, {
      limit: 100,
      cursor: first.nextCursor,
    });
    assert.deepEqual(ids(rest), [firstAlerts[1]!.id]);
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(
      ids(f.delivery.listPending(context, {})),
      [...firstAlerts, ...appended].map((alert) => alert.id),
    );
  } finally {
    f.store.close();
  }
});

test('event delivery: acknowledgements between pages do not shift or lose remaining pending events', () => {
  const f = setup();
  try {
    const alerts = [
      ...f.addEvents().alerts,
      ...f.addEvents().alerts,
      ...f.addEvents().alerts,
    ];
    const first = f.delivery.listPending(context, { limit: 2 });
    assert.ok(first.nextCursor);
    for (const index of [0, 1, 3])
      f.delivery.acknowledge(context, { eventId: alerts[index]!.id });
    const rest = f.delivery.listPending(context, {
      limit: 100,
      cursor: first.nextCursor,
    });
    assert.deepEqual(ids(rest), [alerts[2]!.id, alerts[4]!.id, alerts[5]!.id]);
    assert.equal(rest.nextCursor, null);
  } finally {
    f.store.close();
  }
});

test('event delivery: cursor exhausted by acknowledgements returns empty and an interrupted pass can restart', () => {
  const f = setup();
  try {
    const alerts = f.addEvents().alerts;
    const first = f.delivery.listPending(context, { limit: 1 });
    assert.ok(first.nextCursor);
    f.delivery.acknowledge(context, { eventId: alerts[1]!.id });
    assert.deepEqual(
      f.delivery.listPending(context, { cursor: first.nextCursor }),
      { version: 1, events: [], nextCursor: null },
    );
    assert.deepEqual(ids(f.delivery.listPending(context, {})), [alerts[0]!.id]);
  } finally {
    f.store.close();
  }
});

test('event delivery: limits, malformed inputs and opaque cursor tampering are rejected', () => {
  const f = setup();
  try {
    f.addEvents();
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      assert.throws(() => f.delivery.listPending(context, { limit }), {
        code: 'INVALID_INPUT',
      });
    }
    for (const cursor of [
      '',
      'not-a-cursor',
      'x'.repeat(2049),
      'v99.invalid',
    ]) {
      assert.throws(() => f.delivery.listPending(context, { cursor }), {
        code: 'INVALID_CURSOR',
      });
    }
    const cursor = f.delivery.listPending(context, { limit: 1 }).nextCursor!;
    assert.ok(cursor && !cursor.includes(context.subjectRef));
    const index = Math.floor(cursor.length / 2);
    const altered =
      cursor.slice(0, index) +
      (cursor[index] === 'a' ? 'b' : 'a') +
      cursor.slice(index + 1);
    assert.throws(() => f.delivery.listPending(context, { cursor: altered }), {
      code: 'INVALID_CURSOR',
    });
    const injected = { limit: 1, subjectRef: otherSubjectContext.subjectRef };
    assert.throws(() => f.delivery.listPending(context, injected), {
      code: 'INVALID_INPUT',
    });
  } finally {
    f.store.close();
  }
});

test('event delivery: cursors and event recognition cannot cross instance or subject boundaries', () => {
  const f = setup();
  try {
    const primary = f.addEvents().alerts;
    const secondSubject = f.addEvents(otherSubjectContext).alerts;
    const secondInstance = f.addEvents(otherInstanceContext).alerts;
    assert.deepEqual(
      ids(f.delivery.listPending(context, {})),
      primary.map((alert) => alert.id),
    );
    assert.deepEqual(
      ids(f.delivery.listPending(otherSubjectContext, {})),
      secondSubject.map((alert) => alert.id),
    );
    assert.deepEqual(
      ids(f.delivery.listPending(otherInstanceContext, {})),
      secondInstance.map((alert) => alert.id),
    );
    const cursor = f.delivery.listPending(context, { limit: 1 }).nextCursor!;
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(() => f.delivery.listPending(foreign, { cursor }), {
        code: 'INVALID_CURSOR',
      });
      assert.throws(
        () => f.delivery.acknowledge(foreign, { eventId: primary[0]!.id }),
        { code: 'EVENT_NOT_FOUND' },
      );
    }
    assert.throws(
      () => f.delivery.acknowledge(context, { eventId: 'missing-event' }),
      { code: 'EVENT_NOT_FOUND' },
    );
    assert.equal(f.delivery.listPending(context, {}).events.length, 2);
  } finally {
    f.store.close();
  }
});

test('event delivery: a cursor from an independent database is rejected', () => {
  const first = setup();
  const second = setup();
  try {
    first.addEvents();
    second.addEvents();
    const cursor = first.delivery.listPending(context, {
      limit: 1,
    }).nextCursor!;
    assert.throws(() => second.delivery.listPending(context, { cursor }), {
      code: 'INVALID_CURSOR',
    });
    assert.equal(second.delivery.listPending(context, {}).events.length, 2);
  } finally {
    first.store.close();
    second.store.close();
  }
});

test('event delivery: permissions are revalidated before reads, acknowledgement and replay', () => {
  const f = setup();
  try {
    const eventId = f.addEvents().alerts[0]!.id;
    f.delivery.acknowledge(context, { eventId });
    f.actions.delete('event:read');
    assert.throws(() => f.delivery.listPending(context, {}), {
      code: 'FORBIDDEN',
    });
    f.actions.delete('event:ack');
    assert.throws(() => f.delivery.acknowledge(context, { eventId }), {
      code: 'FORBIDDEN',
    });
    f.actions.add('event:read');
    f.actions.add('event:ack');
    assert.throws(
      () =>
        f.delivery.listPending({ ...context, actorRef: 'foreign-actor' }, {}),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        f.delivery.acknowledge(context, { eventId, actorRef: 'editable' } as {
          eventId: string;
        }),
      { code: 'INVALID_INPUT' },
    );
  } finally {
    f.store.close();
  }
});

test('event delivery: repeated acknowledgement preserves the original receipt across actors and restart', () => {
  const f = setup();
  const eventId = f.addEvents().alerts[0]!.id;
  const receipt = f.delivery.acknowledge(context, { eventId });
  assert.deepEqual(receipt, {
    version: 1,
    eventId,
    status: 'processed',
    processedAt: clock(),
  });
  assert.deepEqual(
    f.delivery.acknowledge(otherActorContext, { eventId }),
    receipt,
  );
  f.store.close();
  const store = new SqliteExpenseStore(f.path);
  try {
    const delivery = new EventDeliveryService(
      store,
      f.policy,
      () => '2026-12-01T00:00:00.000Z',
    );
    assert.deepEqual(delivery.acknowledge(context, { eventId }), receipt);
    assert.ok(!ids(delivery.listPending(context, {})).includes(eventId));
  } finally {
    store.close();
  }
});

test('event delivery: read interruption preserves pending events and durable cursors across reopen', () => {
  const f = setup();
  const expected = [...f.addEvents().alerts, ...f.addEvents().alerts].map(
    (alert) => alert.id,
  );
  const first = f.delivery.listPending(context, { limit: 1 });
  assert.ok(first.nextCursor);
  f.store.close();
  const store = new SqliteExpenseStore(f.path);
  try {
    const delivery = new EventDeliveryService(store, f.policy, clock);
    assert.deepEqual(ids(delivery.listPending(context, {})), expected);
    assert.deepEqual(
      ids(delivery.listPending(context, { cursor: first.nextCursor })),
      expected.slice(1),
    );
  } finally {
    store.close();
  }
});

test('event delivery: readonly access paginates without acknowledging or creating delivery state', () => {
  const f = setup();
  const alerts = f.addEvents().alerts;
  f.store.close();
  const store = new SqliteExpenseStore(f.path, { readOnly: true });
  try {
    const delivery = new EventDeliveryService(store, f.policy, clock);
    const page = delivery.listPending(context, { limit: 1 });
    assert.ok(page.nextCursor);
    assert.deepEqual(ids(page), [alerts[0]!.id]);
    assert.deepEqual(
      ids(delivery.listPending(context, { cursor: page.nextCursor })),
      [alerts[1]!.id],
    );
    assert.throws(
      () => delivery.acknowledge(context, { eventId: alerts[0]!.id }),
      { code: 'STORAGE_READ_ONLY' },
    );
    assert.deepEqual(
      ids(delivery.listPending(context, {})),
      alerts.map((alert) => alert.id),
    );
  } finally {
    store.close();
  }
});

test('event delivery: failure before acknowledgement commit rolls back and permits the same event retry', () => {
  const f = setup();
  const eventId = f.addEvents().alerts[0]!.id;
  f.store.close();
  const failing = new SqliteExpenseStore(f.path, {
    afterAcknowledgementInsert: () => {
      throw new Error('synthetic precommit fault');
    },
  });
  try {
    const delivery = new EventDeliveryService(failing, f.policy, clock);
    assert.throws(() => delivery.acknowledge(context, { eventId }), {
      code: 'STORAGE_IO',
    });
    assert.ok(ids(delivery.listPending(context, {})).includes(eventId));
  } finally {
    failing.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const delivery = new EventDeliveryService(reopened, f.policy, clock);
    assert.ok(ids(delivery.listPending(context, {})).includes(eventId));
    assert.equal(delivery.acknowledge(context, { eventId }).eventId, eventId);
    assert.ok(!ids(delivery.listPending(context, {})).includes(eventId));
  } finally {
    reopened.close();
  }
});

test('event delivery: failure after acknowledgement commit preserves processing despite lost response', () => {
  const f = setup();
  const eventId = f.addEvents().alerts[0]!.id;
  f.store.close();
  const failing = new SqliteExpenseStore(f.path, {
    afterAcknowledgementCommit: () => {
      throw new Error('synthetic lost reply');
    },
  });
  try {
    const delivery = new EventDeliveryService(failing, f.policy, clock);
    assert.throws(() => delivery.acknowledge(context, { eventId }), {
      code: 'STORAGE_IO',
    });
    assert.ok(!ids(delivery.listPending(context, {})).includes(eventId));
  } finally {
    failing.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  try {
    const delivery = new EventDeliveryService(
      reopened,
      f.policy,
      () => '2026-12-01T00:00:00.000Z',
    );
    assert.deepEqual(delivery.acknowledge(context, { eventId }), {
      version: 1,
      eventId,
      status: 'processed',
      processedAt: clock(),
    });
    assert.ok(!ids(delivery.listPending(context, {})).includes(eventId));
  } finally {
    reopened.close();
  }
});

test('event delivery: acknowledgement and correction never rewrite historical budget alerts or totals', () => {
  const f = setup();
  try {
    const { category, alerts, firstExpense } = f.addEvents();
    const query = { categoryId: category.id, month: '2026-11' };
    f.delivery.acknowledge(context, { eventId: alerts[0]!.id });
    assert.deepEqual(f.budgets.getBudgetStatus(context, query).alerts, alerts);
    assert.equal(f.expenses.monthlyTotals(context, query).total.minor, 10000n);
    new ExpenseCorrectionsService(f.store, f.policy, clock).voidExpense(
      context,
      'void-fixture',
      { expenseId: firstExpense.id, reason: 'Synthetic correction' },
    );
    assert.deepEqual(f.budgets.getBudgetStatus(context, query).alerts, alerts);
    assert.equal(f.expenses.monthlyTotals(context, query).total.minor, 2000n);
    assert.deepEqual(ids(f.delivery.listPending(context, {})), [alerts[1]!.id]);
  } finally {
    f.store.close();
  }
});

test('event delivery: backup restored separately preserves receipts, pending events and traversal cursor', () => {
  const f = setup();
  const alerts = [...f.addEvents().alerts, ...f.addEvents().alerts];
  const receipt = f.delivery.acknowledge(context, { eventId: alerts[0]!.id });
  const page = f.delivery.listPending(context, { limit: 1 });
  assert.ok(page.nextCursor);
  const backup = databasePath();
  const restored = databasePath();
  f.store.backupTo(backup);
  f.delivery.acknowledge(context, { eventId: alerts[1]!.id });
  f.store.close();
  SqliteExpenseStore.restoreBackup(backup, restored);
  const store = new SqliteExpenseStore(restored);
  try {
    const delivery = new EventDeliveryService(store, f.policy, clock);
    assert.deepEqual(
      delivery.acknowledge(context, { eventId: alerts[0]!.id }),
      receipt,
    );
    assert.deepEqual(
      ids(delivery.listPending(context, {})),
      alerts.slice(1).map((alert) => alert.id),
    );
    assert.deepEqual(
      ids(delivery.listPending(context, { cursor: page.nextCursor })),
      alerts.slice(2).map((alert) => alert.id),
    );
  } finally {
    store.close();
  }
});

test('event delivery: two processes may read the same events without reservations or premature processing', async () => {
  const f = setup();
  const expected = f.delivery.listPending(context, {});
  f.addEvents();
  const events = f.delivery.listPending(context, {}).events;
  assert.equal(expected.events.length, 0);
  f.store.close();
  const replies = await race(f.path, [{ mode: 'list' }, { mode: 'list' }]);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.deepEqual(replies[0]?.result, replies[1]?.result);
  const store = new SqliteExpenseStore(f.path);
  try {
    assert.deepEqual(
      new EventDeliveryService(store, f.policy).listPending(context, {}).events,
      events,
    );
  } finally {
    store.close();
  }
});

test('event delivery: concurrent process acknowledgement produces one durable receipt and recovers after exit', async () => {
  const f = setup();
  const alerts = f.addEvents().alerts;
  f.store.close();
  const jobs = [
    { mode: 'ack' as const, eventId: alerts[0]!.id },
    { mode: 'ack' as const, eventId: alerts[0]!.id },
  ];
  const replies = await race(f.path, jobs);
  assert.ok(
    replies.every((reply) => reply.type === 'result'),
    JSON.stringify(replies),
  );
  assert.deepEqual(replies[0]?.result, replies[1]?.result);
  const repeated = await race(f.path, jobs);
  assert.deepEqual(repeated, replies);
  const store = new SqliteExpenseStore(f.path);
  try {
    const delivery = new EventDeliveryService(store, f.policy, clock);
    assert.deepEqual(ids(delivery.listPending(context, {})), [alerts[1]!.id]);
    assert.deepEqual(
      delivery.acknowledge(context, { eventId: alerts[0]!.id }),
      replies[0]?.result,
    );
  } finally {
    store.close();
  }
});
