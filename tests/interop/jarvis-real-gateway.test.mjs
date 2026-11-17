import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpsEndpointPolicy, setup } from './jarvis-real-harness.mjs';

function expenseOf(result) {
  assert.equal(result.status, 'completed');
  assert.ok(result.output.expense);
  return result.output.expense;
}

function failed(result, code) {
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, false);
}

function correlated(result, request) {
  for (const key of [
    'protocol_version',
    'instance_id',
    'subject_ref',
    'agent_id',
    'request_id',
    'correlation_id',
  ])
    assert.equal(result[key], request[key], key);
  assert.equal(result.kind, 'execution-result');
}

test('real Gateway: 45000 COP, correlated schemas, one expense, replay and lookup', async () => {
  const f = await setup();
  try {
    const request = f.record();
    const result = await f.execute(request);
    correlated(result, request);
    const expense = expenseOf(result);
    assert.deepEqual(expense, {
      id: expense.id,
      amount: { minor: '4500000', currency: 'COP' },
      categoryId: f.category.id,
      occurredOn: request.input.occurredOn,
    });
    assert.equal(f.calls, 1);
    assert.deepEqual(await f.execute(request), result);
    assert.equal(f.calls, 1);
    const lookup = f.lookup();
    const recovered = await f.execute(lookup);
    correlated(recovered, lookup);
    assert.equal(recovered.output.found, true);
    assert.deepEqual(expenseOf(recovered), expense);
    assert.equal(f.expenses().length, 1);
    assert.equal(f.reservation(request), true);
    assert.equal(f.state(request).phase, 'completed');
    assert.equal(new Set(Object.values(f.paths)).size, 3);
    for (const capability of ['record', 'lookup'])
      for (const direction of ['input', 'output'])
        assert.ok(
          f.schemaChecks.some(
            (id) => id.includes(capability) && id.includes(direction),
          ),
          `${capability} ${direction} schema was validated`,
        );
  } finally {
    await f.close();
  }
});

test('real Gateway: concurrent same intent resolves once with one HTTPS write', async () => {
  const f = await setup();
  try {
    const request = f.record();
    const results = await Promise.all([
      f.execute(request),
      f.execute(request),
      f.execute(request),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('real Gateway: renewed deadline preserves the original write intent and result', async () => {
  const f = await setup();
  try {
    const request = f.record();
    const result = await f.execute(request);
    const renewed = {
      ...request,
      deadline_at: new Date(
        Date.parse(request.deadline_at) + 1000,
      ).toISOString(),
    };
    assert.deepEqual(await f.execute(renewed), result);
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 1);
    assert.equal(f.reservation(renewed), true);
  } finally {
    await f.close();
  }
});

test('real Gateway: correlated financial validation failure records no expense', async () => {
  const f = await setup();
  try {
    const request = f.record();
    request.input.categoryId = '00000000-0000-4000-8000-000000000000';
    const result = await f.execute(request);
    correlated(result, request);
    failed(result, 'VALIDATION_FAILED');
    assert.equal(f.state(request).phase, 'failed');
    assert.equal(f.reservation(request), true);
    assert.equal(f.expenses().length, 0);
    assert.deepEqual((await f.execute(f.lookup())).output, { found: false });
  } finally {
    await f.close();
  }
});

test('real Gateway: completed metadata survives restart; fresh lookup recovers original output', async () => {
  const f = await setup();
  try {
    const request = f.record();
    const expense = expenseOf(await f.execute(request));
    const before = f.state(request);
    assert.equal(before.phase, 'completed');
    assert.equal(Object.hasOwn(before, 'output'), false);
    await f.restart();
    assert.deepEqual(f.state(request), before);
    const calls = f.calls;
    await assert.rejects(f.execute(request), {
      code: 'RESULT_EXPIRED',
      outcome: 'completed',
    });
    assert.equal(f.calls, calls);
    assert.deepEqual(
      expenseOf(await f.execute(f.lookup('expense-001', 'read-after-restart'))),
      expense,
    );
    assert.equal(f.expenses().length, 1);
    assert.equal(f.reservation(request), true);
  } finally {
    await f.close();
  }
});

test('real Gateway: lost post-commit response stays uncertain across lookup and restart', async () => {
  const f = await setup({ dropOnce: true });
  try {
    const request = f.record();
    await assert.rejects(f.execute(request), { outcome: 'uncertain' });
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 1);
    assert.equal(f.reservation(request), true);
    const originalId = f.expenses()[0].id;
    const uncertain = f.state(request);
    assert.equal(uncertain.phase, 'uncertain');
    assert.equal(uncertain.outcome, 'uncertain');
    const recovered = expenseOf(await f.execute(f.lookup()));
    assert.equal(recovered.id, originalId);
    assert.deepEqual(f.state(request), uncertain);
    const callsBeforeRetry = f.calls;
    await assert.rejects(f.execute(request), { outcome: 'uncertain' });
    assert.equal(f.calls, callsBeforeRetry);
    await f.restart();
    assert.deepEqual(f.state(request), uncertain);
    const callsAfterRestart = f.calls;
    await assert.rejects(f.execute(request), { outcome: 'uncertain' });
    assert.equal(f.calls, callsAfterRestart);
    assert.deepEqual(
      expenseOf(await f.execute(f.lookup('expense-001', 'recover-restarted'))),
      recovered,
    );
    assert.deepEqual(f.state(request), uncertain);
    assert.equal(f.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('real Gateway: altered content, request and correlation conflict before and after restart', async () => {
  const f = await setup();
  try {
    const request = f.record();
    await f.execute(request);
    const variants = [
      { ...request, input: { ...request.input, amount: '45001' } },
      { ...request, request_id: 'different-request' },
      { ...request, correlation_id: 'different-correlation' },
    ];
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      const calls = f.calls;
      for (const variant of variants)
        await assert.rejects(f.execute(variant), {
          code: 'IDEMPOTENCY_CONFLICT',
        });
      assert.equal(f.calls, calls);
    }
    assert.equal(f.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('real Gateway: trusted actor and registry deny another subject or instance before HTTPS', async () => {
  const f = await setup();
  try {
    const request = f.record();
    const original = expenseOf(await f.execute(request));
    for (const variant of [
      { ...request, subject_ref: 'synthetic-other-subject' },
      { ...request, instance_id: 'synthetic-other-instance' },
      { ...f.lookup(), subject_ref: 'synthetic-other-subject' },
      { ...f.lookup(), instance_id: 'synthetic-other-instance' },
    ])
      await assert.rejects(f.execute(variant), { code: 'FORBIDDEN' });
    await assert.rejects(
      f.execute(
        { ...request, subject_ref: 'synthetic-other-subject' },
        { ...f.actor, subject_ref: 'synthetic-other-subject' },
      ),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      f.execute(request, { ...f.actor, permissions: ['*'] }),
      { code: 'FORBIDDEN' },
    );
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 1);
    assert.equal(f.expenses()[0].id, original.id);
  } finally {
    await f.close();
  }
});

test('real Gateway: read-only registry refuses writes and permits scoped not-found lookup', async () => {
  const f = await setup({ registryReadOnly: true });
  try {
    await assert.rejects(f.execute(f.record()), { code: 'FORBIDDEN' });
    assert.equal(f.calls, 0);
    const result = await f.execute(f.lookup());
    assert.deepEqual(result.output, { found: false });
    assert.equal(f.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('real Gateway: adapter read-only credential denies writes independently of registry', async () => {
  const f = await setup({ credential: 'read-only' });
  try {
    failed(await f.execute(f.record()), 'FORBIDDEN');
    assert.deepEqual((await f.execute(f.lookup())).output, { found: false });
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(f.record()), false);
  } finally {
    await f.close();
  }
});

test('real Gateway: foreign credential cannot read or write the authorized subject', async () => {
  const f = await setup({ credential: 'foreign' });
  try {
    failed(await f.execute(f.record()), 'FORBIDDEN');
    failed(await f.execute(f.lookup()), 'FORBIDDEN');
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(f.record()), false);
  } finally {
    await f.close();
  }
});

test('real Gateway: invalid credential produces no financial effect', async () => {
  const f = await setup({ credential: 'invalid' });
  try {
    await assert.rejects(f.execute(f.record()), {
      code: 'INVALID_RESPONSE',
      outcome: 'uncertain',
    });
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(f.record()), false);
  } finally {
    await f.close();
  }
});

test('real Gateway: strict envelope, financial schema and payload limits reject before HTTPS', async () => {
  const f = await setup();
  try {
    const request = f.record();
    for (const variant of [
      { ...request, unexpected: true },
      { ...request, input: { ...request.input, actorRef: 'forged-actor' } },
      { ...request, input: { ...request.input, amount: 45000 } },
      { ...request, input: { ...request.input, currency: 'USD' } },
      { ...request, input: { ...request.input, occurredOn: '2026-02-30' } },
      { ...request, input: { ...request.input, amount: '9'.repeat(65537) } },
    ])
      await assert.rejects(f.execute(variant), { code: 'VALIDATION_FAILED' });
    await assert.rejects(f.execute({ ...request, protocol_version: '2.0' }), {
      code: 'UNSUPPORTED_PROTOCOL',
    });
    await assert.rejects(
      f.execute({
        ...request,
        capability: { ...request.capability, version: '2.0' },
      }),
      { code: 'UNKNOWN_CAPABILITY' },
    );
    assert.equal(f.calls, 0);
    assert.equal(f.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('real Gateway: expired deadline cannot reserve an expense or send HTTPS', async () => {
  const f = await setup();
  try {
    const request = { ...f.record(), deadline_at: '2026-01-01T00:00:00.000Z' };
    await assert.rejects(f.execute(request), { code: 'TIMEOUT' });
    assert.equal(f.calls, 0);
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(request), false);
  } finally {
    await f.close();
  }
});

test('real Gateway: verified TLS refuses an untrusted CA without reaching the adapter', async () => {
  const f = await setup({ untrustedCa: true });
  try {
    await assert.rejects(f.execute(f.record()));
    assert.equal(f.calls, 0);
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(f.record()), false);
  } finally {
    await f.close();
  }
});

test('real network policy: production loopback restriction remains enforced', async () => {
  const origin = 'https://don-gaston.test:443';
  const policy = new HttpsEndpointPolicy([{ origin }], async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(policy.resolve(origin, new AbortController().signal), {
    code: 'FORBIDDEN',
  });
});

test('real Gateway: verified TLS refuses a mismatched hostname before the adapter', async () => {
  const f = await setup({ wrongHostname: true });
  try {
    await assert.rejects(f.execute(f.record()));
    assert.equal(f.calls, 0);
    assert.equal(f.expenses().length, 0);
    assert.equal(f.reservation(f.record()), false);
  } finally {
    await f.close();
  }
});

test('real Gateway: mismatched response correlation is uncertain and recoverable by fresh lookup', async () => {
  let tamper = true;
  const f = await setup({
    transformReply(reply) {
      const body = structuredClone(reply.body);
      if (tamper) {
        tamper = false;
        body.correlation_id = 'wrong-correlation';
      }
      return { status: reply.status, body: JSON.stringify(body) };
    },
  });
  try {
    const request = f.record();
    await assert.rejects(f.execute(request), {
      code: 'INVALID_RESPONSE',
      outcome: 'uncertain',
    });
    assert.equal(f.expenses().length, 1);
    assert.equal(f.state(request).phase, 'uncertain');
    assert.equal(expenseOf(await f.execute(f.lookup())).id, f.expenses()[0].id);
    assert.equal(f.state(request).phase, 'uncertain');
  } finally {
    await f.close();
  }
});

test('real Gateway: response output schema rejects monetary numbers after commit', async () => {
  const f = await setup({
    transformReply(reply) {
      const body = structuredClone(reply.body);
      if (body.status === 'completed' && body.output.expense)
        body.output.expense.amount.minor = 4500000;
      return { status: reply.status, body: JSON.stringify(body) };
    },
  });
  try {
    const request = f.record();
    await assert.rejects(f.execute(request), {
      code: 'INVALID_RESPONSE',
      outcome: 'uncertain',
    });
    assert.equal(f.expenses().length, 1);
    assert.equal(f.state(request).phase, 'uncertain');
  } finally {
    await f.close();
  }
});

test('real Gateway: oversized response is rejected without duplicating committed expense', async () => {
  const f = await setup({
    transformReply(reply) {
      return {
        status: reply.status,
        body: JSON.stringify({ padding: 'x'.repeat(65537) }),
      };
    },
  });
  try {
    const request = f.record();
    await assert.rejects(f.execute(request), {
      code: 'INVALID_RESPONSE',
      outcome: 'uncertain',
    });
    assert.equal(f.calls, 1);
    assert.equal(f.expenses().length, 1);
    assert.equal(f.state(request).phase, 'uncertain');
    await assert.rejects(f.execute(request), { outcome: 'uncertain' });
    assert.equal(f.calls, 1);
  } finally {
    await f.close();
  }
});
