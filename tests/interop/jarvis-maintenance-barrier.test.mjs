import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { DemoRequestJournal } from '../../src/interfaces/jarvis-demo-journal.ts';
import { setupConversation } from './jarvis-conversation-harness.mjs';
import { jarvisRepository, setup } from './jarvis-real-harness.mjs';

const { MaintenanceBarrier } = await import(
  new URL('tests/maintenance-barrier.ts', pathToFileURL(jarvisRepository + '/'))
);
const { SqliteStateStore } = await import(
  new URL(
    'src/infrastructure/sqlite-state-store.ts',
    pathToFileURL(jarvisRepository + '/'),
  )
);
const { SqliteConfirmationStore } = await import(
  new URL(
    'src/infrastructure/sqlite-confirmation-store.ts',
    pathToFileURL(jarvisRepository + '/'),
  )
);

const expense = '/gasto 45000 COP gasolina 2026-11-17';
const closed = { code: 'ADMISSION_CLOSED' };

test('C1 rejects new expenses, confirmation, polling, gateway and direct adapter work when closed', async (t) => {
  const f = await setupConversation({ maintenance: true });
  t.after(() => f.close());
  await f.send(expense);
  const reference = f.reference();
  const pending = f.pending();
  const history = f.history();
  const deliveries = f.attempts.length;
  const { maintenance } = f.finance;
  const claim = maintenance.claim();
  assert.deepEqual(
    maintenance.status(claim).writers.map(({ role }) => role),
    ['conversation', 'interop-runtime'],
  );
  assert.equal(maintenance.status(claim).quiescent, false);

  await assert.rejects(f.send(expense), closed);
  await assert.rejects(f.send(`sí ${reference}`), closed);
  await assert.rejects(f.poll([`sí ${reference}`]), closed);
  const direct = f.finance.record();
  await assert.rejects(f.finance.execute(direct), closed);
  await assert.rejects(f.finance.execute(f.finance.lookup()), closed);
  assert.throws(() => f.finance.receiveDirect(direct), closed);
  assert.throws(() => f.finance.restartGateway(), closed);
  assert.deepEqual(f.pending(), pending);
  assert.deepEqual(f.history(), history);
  assert.equal(f.finance.state(direct), undefined);
  assert.equal(f.finance.reservation(direct), false);
  assert.equal(f.finance.calls, 0);
  assert.deepEqual(f.finance.expenses(), []);
  assert.equal(f.attempts.length, deliveries);

  await assert.rejects(f.restart(), closed);
  assert.equal(maintenance.status(claim).quiescent, true);
  await assert.rejects(f.finance.execute(direct), { code: 'WRITER_INACTIVE' });
});

test('C1 closes between a durable gateway reservation and its asynchronous dispatch', async (t) => {
  const f = await setupConversation({ maintenance: true });
  t.after(() => f.close());
  const { maintenance } = f.finance;
  const request = f.finance.record();
  const running = f.finance.execute(request);
  const result = assert.rejects(running, { code: 'UNAVAILABLE' });
  assert.equal(f.finance.state(request).phase, 'reserved');
  const claim = maintenance.claim();
  assert.deepEqual(
    maintenance.status(claim).operations.map(({ stage }) => stage),
    ['gateway'],
  );
  await result;
  assert.equal(f.finance.calls, 0);
  assert.equal(f.finance.reservation(request), false);
  assert.deepEqual(f.finance.expenses(), []);
  assert.deepEqual(maintenance.status(claim).operations, []);
});

test(
  'C1 denies HTTPS initiation when another process claims after dispatch admission',
  { timeout: 10000 },
  async (t) => {
    const paused = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const f = await setupConversation({
      maintenance: true,
      async beforeHttpsResolve() {
        paused.resolve();
        await resume.promise;
      },
    });
    t.after(() => f.close());
    const { maintenance } = f.finance;
    const coordinator = fork(
      new URL(
        'tests/fixtures/maintenance-coordinator.ts',
        pathToFileURL(jarvisRepository + '/'),
      ),
      [maintenance.path, maintenance.epoch],
      { execArgv: [] },
    );
    const exited = once(coordinator, 'exit');
    t.after(async () => {
      coordinator.kill();
      await exited;
    });
    const receive = () =>
      Promise.race([
        once(coordinator, 'message').then(([message]) => message),
        exited.then(() => assert.fail('Coordinator exited before replying')),
      ]);
    assert.deepEqual(await receive(), { ready: true });

    const request = f.finance.record();
    const running = f.finance.execute(request);
    const denied = assert.rejects(running, { code: 'UNAVAILABLE' });
    try {
      await Promise.race([paused.promise, running]);
      const reply = receive();
      coordinator.send('claim');
      const { claim } = await reply;
      assert.ok(claim);
      const pending = maintenance.status(claim);
      assert.deepEqual(pending.operations.map(({ stage }) => stage).sort(), [
        'dispatch',
        'gateway',
      ]);
      assert.equal(pending.quiescent, false);
      assert.equal(f.finance.sendStartChecks, 0);
      resume.resolve();
      await denied;
      assert.equal(f.finance.sendStartChecks, 1);
      assert.equal(f.finance.sendStarts, 0);
      assert.equal(f.finance.receivedRequests, 0);
      assert.equal(f.finance.reservation(request), false);
      assert.equal(f.finance.expenses().length, 0);
      // The Gateway retains its conservative durable outcome even when the
      // transport can prove that the request was never started.
      assert.equal(f.finance.state(request).phase, 'uncertain');
      assert.equal(f.replies.length, 0);
      assert.deepEqual(maintenance.status(claim).operations, []);
      await f.close();
      assert.equal(maintenance.status(claim).quiescent, true);
    } finally {
      resume.resolve();
      await denied;
    }
  },
);

test('C1 lets previously admitted local work finish once and fences delivery and polling progress', async (t) => {
  let claim;
  const f = await setupConversation({
    maintenance: true,
    beforeAdapterHandle() {
      assert.equal(f.finance.sendStarts, 1);
      assert.equal(f.finance.receivedRequests, 1);
      claim = f.finance.maintenance.claim();
      const admission = f.finance.maintenance.status(claim);
      assert.deepEqual(admission.operations.map(({ stage }) => stage).sort(), [
        'adapter',
        'dispatch',
        'gateway',
        'poll',
      ]);
      assert.equal(admission.quiescent, false);
      assert.deepEqual(f.finance.expenses(), []);
    },
  });
  t.after(() => f.close());
  await f.send(expense);
  const reference = f.reference();
  const { intentKey } = f.pending();
  const deliveries = f.attempts.length;
  const delivered = f.replies.length;

  await assert.rejects(f.poll([`sí ${reference}`, expense]), closed);
  assert.ok(claim);
  const { maintenance } = f.finance;
  assert.equal(f.pending().state, 'completed');
  assert.equal(f.pending().request.idempotency_key, intentKey);
  assert.equal(
    f.history().filter(({ event }) => event === 'confirmed').length,
    1,
  );
  assert.equal(f.finance.reservation(f.pending().request), true);
  assert.equal(f.finance.calls, 1);
  assert.equal(f.finance.sendStartChecks, 1);
  assert.equal(f.finance.sendStarts, 1);
  assert.equal(f.finance.receivedRequests, 1);
  assert.equal(f.finance.state(f.pending().request).phase, 'completed');
  assert.equal(f.attempts.length, deliveries);
  assert.equal(f.replies.length, delivered);
  assert.deepEqual(f.deliveryStates(), ['delivered', 'delivery-uncertain']);
  assert.equal(f.reference(), reference);
  await assert.rejects(f.send(`sí ${reference}`), closed);
  await assert.rejects(f.finance.execute(f.pending().request), closed);
  assert.deepEqual(maintenance.status(claim).operations, []);
  assert.equal(maintenance.status(claim).quiescent, false);
  const [recorded] = f.finance.expenses();
  assert.equal(recorded.amount.minor, 4500000n);
  assert.equal(recorded.amount.currency, 'COP');
  assert.equal(f.finance.expenses().length, 1);

  await f.close();
  const drained = maintenance.status(claim);
  assert.equal(drained.quiescent, true);
  assert.deepEqual(
    drained.stoppedWriters.map(({ role }) => role),
    ['conversation', 'interop-runtime'],
  );
  const store = new SqliteExpenseStore(f.finance.paths.finance, {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      store.listExpenses({
        instanceRef: f.finance.actor.instance_id,
        subjectRef: f.finance.actor.subject_ref,
      }),
      [recorded],
    );
  } finally {
    store.close();
  }
});

test('C1 denies live fixture routes when the barrier disappears or becomes unreadable', async (t) => {
  const f = await setupConversation({ maintenance: true });
  const { maintenance } = f.finance;
  const request = f.finance.record();
  const unavailable = { code: 'STATE_UNAVAILABLE' };
  let moved = false;
  t.after(async () => {
    if (moved) await assert.rejects(f.close(), unavailable);
    else await f.close();
  });
  renameSync(maintenance.path, `${maintenance.path}.preserved`);
  moved = true;
  await assert.rejects(f.send(expense), unavailable);
  await assert.rejects(f.finance.execute(request), unavailable);
  assert.throws(() => f.finance.receiveDirect(request), unavailable);

  writeFileSync(maintenance.path, 'damaged synthetic state');
  await assert.rejects(f.poll([expense]), unavailable);
  await assert.rejects(f.finance.execute(request), unavailable);
  assert.throws(() => f.finance.receiveDirect(request), unavailable);
  assert.equal(f.finance.calls, 0);
  assert.deepEqual(f.finance.expenses(), []);
  assert.equal(f.attempts.length, 0);
});

test(
  'C1 queues the stop behind a restart with an HTTPS listener opening',
  { timeout: 10000 },
  async (t) => {
    const opening = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const stores = [SqliteStateStore, DemoRequestJournal, SqliteExpenseStore];
    const closes = new Map(stores.map((store) => [store, 0]));
    for (const store of stores) {
      const close = store.prototype.close;
      t.mock.method(store.prototype, 'close', function () {
        close.call(this);
        closes.set(store, closes.get(store) + 1);
      });
    }
    let starts = 0;
    const f = await setup({
      maintenance: true,
      async afterHttpsListen(port) {
        if (++starts === 2) {
          opening.resolve(port);
          await resume.promise;
        }
      },
    });
    t.after(() => resume.resolve());
    t.after(() => f.close());

    const restarting = f.restart();
    const port = await Promise.race([
      opening.promise,
      restarting.then(() => assert.fail('Restart did not pause')),
    ]);
    const claim = f.maintenance.claim();
    const { writers } = f.maintenance.status(claim);
    assert.equal(writers.length, 1);
    const [writer] = writers;
    let stopped = false;
    const stopping = f.close().then(() => {
      stopped = true;
    });
    const socket = connect(port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      await setImmediate();
      assert.equal(stopped, false);
      assert.deepEqual(f.maintenance.status(claim).writers, [writer]);
      assert.deepEqual([...closes.values()], [1, 1, 1]);
    } finally {
      socket.destroy();
      resume.resolve();
      await Promise.all([restarting, stopping]);
    }

    const status = f.maintenance.status(claim);
    assert.equal(status.quiescent, true);
    assert.ok(status.stoppedWriters.some(({ id }) => id === writer.id));
    assert.deepEqual([...closes.values()], [2, 2, 2]);
    const probe = connect(port, '127.0.0.1');
    try {
      await assert.rejects(once(probe, 'connect'), { code: 'ECONNREFUSED' });
    } finally {
      probe.destroy();
    }
    await assert.rejects(f.restart(), /fixture is stopping/);
  },
);

test(
  'C1 serializes conversation restart with a concurrent stop',
  { timeout: 10000 },
  async (t) => {
    const opening = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const close = SqliteConfirmationStore.prototype.close;
    const closes = t.mock.method(
      SqliteConfirmationStore.prototype,
      'close',
      close,
    );
    let starts = 0;
    const f = await setupConversation({
      maintenance: true,
      async afterHttpsListen() {
        if (++starts === 2) {
          opening.resolve();
          await resume.promise;
        }
      },
    });
    t.after(() => resume.resolve());
    t.after(() => f.close());
    const restarting = f.restart();
    await Promise.race([
      opening.promise,
      restarting.then(() => assert.fail('Restart did not pause')),
    ]);
    const stopping = f.close();
    resume.resolve();
    await Promise.all([restarting, stopping]);
    assert.equal(closes.mock.callCount(), 2);
    const { maintenance } = f.finance;
    const status = maintenance.status(maintenance.claim());
    assert.equal(status.quiescent, true);
    assert.deepEqual(
      status.stoppedWriters.map(({ role }) => role),
      ['conversation', 'conversation', 'interop-runtime', 'interop-runtime'],
    );
  },
);

test('C1 keeps the writer pending when fixture cleanup fails', async (t) => {
  const f = await setup({ maintenance: true });
  const claim = f.maintenance.claim();
  const close = DemoRequestJournal.prototype.close;
  t.mock.method(DemoRequestJournal.prototype, 'close', function () {
    close.call(this);
    throw new Error('Synthetic journal cleanup failure');
  });
  await assert.rejects(f.close(), /Synthetic component cleanup failed/);
  const status = f.maintenance.status(claim);
  assert.equal(status.quiescent, false);
  assert.equal(status.writers.length, 1);
  assert.deepEqual(status.stoppedWriters, []);
  await assert.rejects(f.restart(), /fixture is stopping/);
});

test(
  'C1 preserves the interrupted writer and a committed expense without replay',
  { timeout: 15000 },
  async () => {
    const child = fork(
      new URL('../fixtures/jarvis-maintenance-writer.mjs', import.meta.url),
      {
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    const exited = once(child, 'exit');
    try {
      const [
        { path, epoch, paths, actor, sendStarts, receivedRequests, phase },
      ] = await Promise.race([
        once(child, 'message'),
        exited.then(() => assert.fail('Writer exited before its commit')),
      ]);
      assert.equal(sendStarts, 1);
      assert.equal(receivedRequests, 1);
      assert.equal(phase, 'started');
      const maintenance = new MaintenanceBarrier(path, epoch);
      const claim = maintenance.claim();
      assert.deepEqual(
        maintenance
          .status(claim)
          .operations.map(({ stage }) => stage)
          .sort(),
        ['dispatch', 'gateway'],
      );
      assert.equal(child.kill('SIGKILL'), true);
      await exited;

      const reopened = new MaintenanceBarrier(path, epoch);
      assert.throws(() => reopened.openWriter('interop-runtime'), closed);
      const status = reopened.status(claim);
      assert.equal(status.quiescent, false);
      assert.equal(status.writers.length, 1);
      assert.equal(status.stoppedWriters.length, 0);
      assert.equal(status.operations.length, 2);

      const store = new SqliteExpenseStore(paths.finance, { readOnly: true });
      const journal = new DatabaseSync(paths.adapter, { readOnly: true });
      try {
        assert.equal(
          store.listExpenses({
            instanceRef: actor.instance_id,
            subjectRef: actor.subject_ref,
          }).length,
          1,
        );
        assert.equal(
          journal.prepare('SELECT count(*) AS total FROM demo_requests').get()
            .total,
          1,
        );
      } finally {
        journal.close();
        store.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    }
  },
);
