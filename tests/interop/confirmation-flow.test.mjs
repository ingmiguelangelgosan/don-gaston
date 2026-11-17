import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './jarvis-real-harness.mjs';
import { ConfirmationFlow } from './confirmation-flow.mjs';

async function fixture(options = {}, intercept) {
  const f = await setup(options);
  const path = join(f.directory, 'flow.sqlite');
  const execute = (request, actor) =>
    intercept ? intercept(f, request, actor) : f.execute(request, actor);
  let flow = new ConfirmationFlow({
    path,
    create: true,
    execute,
    actor: f.actor,
  });
  const request = f.record();
  const prepared = flow.prepare(f.actor, request);
  const command = {
    id: prepared.id,
    confirmationToken: prepared.confirmationToken,
  };
  return {
    f,
    path,
    request,
    prepared,
    command,
    get flow() {
      return flow;
    },
    reopen() {
      flow.close();
      flow = new ConfirmationFlow({ path, execute, actor: f.actor });
    },
    async close() {
      flow.close();
      await f.close();
    },
  };
}

test('confirmation: preparation is immutable, scoped and has no financial effect', async () => {
  const c = await fixture();
  try {
    assert.equal(c.prepared.state, 'awaiting_confirmation');
    assert.match(c.prepared.message, /45000 COP/);
    assert.throws(() => {
      c.prepared.request.input.amount = '1';
    }, TypeError);
    c.request.input.amount = '2';
    assert.equal(
      c.flow.inspect(c.f.actor, c.command.id).request.input.amount,
      '45000',
    );
    assert.equal(c.f.calls, 0);
    assert.equal(c.f.expenses().length, 0);
    assert.equal(c.f.reservation(c.f.record()), false);
    assert.deepEqual(c.flow.prepare(c.f.actor, c.prepared.request), c.prepared);
    assert.throws(() => c.flow.prepare(c.f.actor, c.request), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  } finally {
    await c.close();
  }
});

test('confirmation: explicit confirmation and concurrent duplicates record exactly one expense', async () => {
  const c = await fixture();
  try {
    const results = await Promise.all([
      c.flow.confirm(c.f.actor, c.command),
      c.flow.confirm(c.f.actor, c.command),
    ]);
    assert.equal(results[0].state, 'completed');
    assert.equal(results[1].state, 'executing');
    const done = await c.flow.confirm(c.f.actor, c.command);
    assert.equal(done.state, 'completed');
    assert.deepEqual(done.evidence.amount, {
      minor: '4500000',
      currency: 'COP',
    });
    assert.equal(done.evidence.categoryId, c.f.category.id);
    assert.equal(done.evidence.occurredOn, c.request.input.occurredOn);
    assert.equal(c.f.calls, 1);
    assert.equal(c.f.expenses().length, 1);
    assert.throws(() => c.flow.cancel(c.f.actor, c.command), {
      code: 'CANNOT_CANCEL_EXECUTED',
    });
    c.reopen();
    await c.f.restart();
    assert.equal(
      (await c.flow.confirm(c.f.actor, c.command)).evidence.id,
      done.evidence.id,
    );
    assert.equal(c.f.calls, 1);
  } finally {
    await c.close();
  }
});

test('confirmation: cancellation is terminal and survives reconstruction', async () => {
  const c = await fixture();
  try {
    assert.equal(c.flow.cancel(c.f.actor, c.command).state, 'cancelled');
    c.reopen();
    await c.f.restart();
    assert.equal(
      (await c.flow.confirm(c.f.actor, c.command)).state,
      'cancelled',
    );
    assert.equal(c.flow.cancel(c.f.actor, c.command).state, 'cancelled');
    assert.equal(c.f.calls, 0);
    assert.equal(c.f.expenses().length, 0);
  } finally {
    await c.close();
  }
});

test('confirmation: foreign actor and altered confirmation cannot execute or disclose pending data', async () => {
  const c = await fixture();
  try {
    const foreign = { ...c.f.actor, subject_ref: 'other-subject' };
    await assert.rejects(c.flow.confirm(foreign, c.command), {
      code: 'FORBIDDEN',
    });
    assert.throws(() => c.flow.cancel(foreign, c.command), {
      code: 'FORBIDDEN',
    });
    assert.throws(() => c.flow.inspect(foreign, c.command.id), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(c.flow.recover(foreign, { id: c.command.id }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      c.flow.confirm(c.f.actor, { ...c.command, confirmationToken: 'changed' }),
      { code: 'CONFIRMATION_MISMATCH' },
    );
    for (const extra of [
      { amount: '1' },
      { categoryId: 'changed' },
      { confirmed: true },
    ])
      await assert.rejects(
        c.flow.confirm(c.f.actor, { ...c.command, ...extra }),
        { code: 'INVALID_COMMAND' },
      );
    assert.equal(c.f.calls, 0);
  } finally {
    await c.close();
  }
});

test('confirmation: pending survives restart and requires the same explicit confirmation', async () => {
  const c = await fixture();
  try {
    c.reopen();
    await c.f.restart();
    assert.deepEqual(c.flow.inspect(c.f.actor, c.command.id), c.prepared);
    assert.equal(c.f.calls, 0);
    assert.equal(
      (await c.flow.confirm(c.f.actor, c.command)).state,
      'completed',
    );
    assert.equal(c.f.expenses().length, 1);
  } finally {
    await c.close();
  }
});

test('confirmation: response lost after commit, lookup and restart preserve Jarvis uncertain', async () => {
  const c = await fixture({ dropOnce: true });
  try {
    assert.equal(
      (await c.flow.confirm(c.f.actor, c.command)).state,
      'uncertain',
    );
    const journal = c.f.state(c.request);
    assert.equal(journal.phase, 'uncertain');
    const recovered = await c.flow.recover(c.f.actor, { id: c.command.id });
    assert.equal(recovered.state, 'uncertain');
    assert.match(
      recovered.message,
      /Gasto encontrado.*pendiente de conciliación/,
    );
    assert.equal(recovered.evidence.id, c.f.expenses()[0].id);
    assert.deepEqual(c.f.state(c.request), journal);
    c.reopen();
    await c.f.restart();
    const calls = c.f.calls;
    assert.equal(
      (await c.flow.confirm(c.f.actor, c.command)).state,
      'uncertain',
    );
    assert.equal(c.f.calls, calls);
    assert.throws(() => c.flow.cancel(c.f.actor, c.command), {
      code: 'CANNOT_CANCEL_EXECUTED',
    });
    await c.flow.recover(c.f.actor, { id: c.command.id });
    assert.deepEqual(c.f.state(c.request), journal);
    assert.equal(c.f.expenses().length, 1);
    assert.equal(
      c.flow.inspect(c.f.actor, c.command.id).request.idempotency_key,
      c.request.idempotency_key,
    );
  } finally {
    await c.close();
  }
});

test('confirmation: uncertainty before dispatch plus not-found lookup never authorizes another write', async () => {
  const c = await fixture({}, (f, r, a) => {
    if (r.capability.name === 'finance.expense.record')
      throw new Error('Synthetic interrupted dispatch');
    return f.execute(r, a);
  });
  try {
    await c.flow.confirm(c.f.actor, c.command);
    const result = await c.flow.recover(c.f.actor, { id: c.command.id });
    assert.equal(result.state, 'uncertain');
    assert.equal(result.evidence, null);
    assert.match(result.message, /sigue incierta/);
    const calls = c.f.calls;
    await c.flow.confirm(c.f.actor, c.command);
    assert.equal(c.f.calls, calls);
    assert.equal(c.f.expenses().length, 0);
  } finally {
    await c.close();
  }
});

test('confirmation: executing survives another connection opening; recovery is read-only', async () => {
  let release;
  const c = await fixture({}, async (f, r, a) => {
    if (r.capability.name === 'finance.expense.record')
      await new Promise((resolve) => {
        release = resolve;
      });
    return f.execute(r, a);
  });
  let second;
  try {
    const pending = c.flow.confirm(c.f.actor, c.command);
    second = new ConfirmationFlow({
      path: c.path,
      execute: (r, a) => c.f.execute(r, a),
      actor: c.f.actor,
    });
    assert.equal(second.inspect(c.f.actor, c.command.id).state, 'executing');
    assert.equal(
      (await second.confirm(c.f.actor, c.command)).state,
      'executing',
    );
    assert.throws(() => second.cancel(c.f.actor, c.command), {
      code: 'CANNOT_CANCEL_EXECUTED',
    });
    assert.equal(
      (await second.recover(c.f.actor, { id: c.command.id })).state,
      'uncertain',
    );
    release();
    await pending;
    const result = await second.recover(c.f.actor, { id: c.command.id });
    assert.equal(result.state, 'uncertain');
    assert.ok(result.evidence);
    assert.equal(c.f.expenses().length, 1);
  } finally {
    second?.close();
    await c.close();
  }
});

test('confirmation: real RESULT_EXPIRED completed is recovered by lookup without repeating record', async () => {
  const c = await fixture({}, async (f, r, a) => {
    if (r.capability.name === 'finance.expense.record') {
      await f.execute(r, a); // Real commit, then reconstructed Gateway has metadata without output.
      await f.restart();
    }
    return f.execute(r, a);
  });
  try {
    const first = await c.flow.confirm(c.f.actor, c.command);
    assert.equal(first.state, 'uncertain');
    assert.equal(first.gatewayOutcome, 'completed');
    const journal = c.f.state(c.request);
    c.reopen();
    const recovered = await c.flow.recover(c.f.actor, { id: c.command.id });
    assert.equal(recovered.state, 'completed');
    assert.ok(recovered.evidence);
    assert.equal(c.f.expenses().length, 1);
    assert.equal(c.f.calls, 2);
    assert.deepEqual(c.f.state(c.request), journal);
  } finally {
    await c.close();
  }
});

for (const [name, options] of [
  ['registry', { registryReadOnly: true }],
  ['adapter', { credential: 'read-only' }],
])
  test(`confirmation: ${name} permission rejects a confirmed request definitively`, async () => {
    const c = await fixture(options);
    try {
      assert.equal(
        (await c.flow.confirm(c.f.actor, c.command)).state,
        'failed',
      );
      assert.equal(c.f.expenses().length, 0);
      const calls = c.f.calls;
      await c.flow.confirm(c.f.actor, c.command);
      assert.equal(c.f.calls, calls);
    } finally {
      await c.close();
    }
  });

test('confirmation: expired exact request is not silently refreshed', async () => {
  const c = await fixture();
  try {
    const expired = c.flow.prepare(c.f.actor, {
      ...c.f.record('expired'),
      deadline_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(
      (
        await c.flow.confirm(c.f.actor, {
          id: expired.id,
          confirmationToken: expired.confirmationToken,
        })
      ).state,
      'failed',
    );
    assert.equal(c.f.calls, 0);
  } finally {
    await c.close();
  }
});

test('confirmation: invalid TLS cannot create an expense or be called completed', async () => {
  const c = await fixture({ untrustedCa: true });
  try {
    const result = await c.flow.confirm(c.f.actor, c.command);
    assert.ok(['failed', 'uncertain'].includes(result.state));
    assert.equal(result.evidence, null);
    assert.equal(c.f.calls, 0);
    assert.equal(c.f.expenses().length, 0);
  } finally {
    await c.close();
  }
});

test('confirmation: reopen requires existing file and matching actor', async () => {
  const c = await fixture();
  try {
    assert.throws(
      () =>
        new ConfirmationFlow({
          path: join(c.f.directory, 'absent.sqlite'),
          actor: c.f.actor,
          execute: c.f.execute,
        }),
      { code: 'MISSING_FLOW_STORE' },
    );
    assert.throws(
      () =>
        new ConfirmationFlow({
          path: c.path,
          actor: { ...c.f.actor, subject_ref: 'foreign' },
          execute: c.f.execute,
        }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        new ConfirmationFlow({
          path: c.path,
          create: true,
          actor: c.f.actor,
          execute: c.f.execute,
        }),
      { code: 'EEXIST' },
    );
  } finally {
    await c.close();
  }
});
