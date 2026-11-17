import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupConversation } from './jarvis-conversation-harness.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { jarvisRepository } from './jarvis-real-harness.mjs';
import { parseRequest } from '../../src/interfaces/jarvis-demo-contract.ts';

const expenseText = 'Jarvis, gasté $45.000 en gasolina el 2026-11-17';
const commandText = '/gasto 45000 COP gasolina 2026-11-17';
const lastReply = (f) => f.replies.at(-1)?.text ?? '';
const confirm = (f, reference = f.reference(), options) =>
  f.send(`sí ${reference}`, options);

test('conversation: omitted optional hook keeps the operational route disabled', async () => {
  const f = await setupConversation({ disabled: true });
  try {
    await f.send(commandText);
    await f.send('sí G-001');
    assert.equal(f.pending(), undefined);
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: financial input schemas agree with the existing Don Gaston contract', async () => {
  const { recordInputSchema } = await import(
    pathToFileURL(
      join(jarvisRepository, 'src/agents/finance-expense-profile.ts'),
    ).href
  );
  const f = await setupConversation();
  try {
    const base = f.finance.record();
    for (const amount of [
      '45000',
      '0',
      '0.01',
      '0.00',
      '45000.5',
      '01',
      '-1',
      '1e3',
      '1.001',
      ' 1',
      '9'.repeat(4094),
      '9'.repeat(4095),
      45000,
    ]) {
      const input = { ...base.input, amount };
      let accepted = true;
      try {
        parseRequest({ ...base, input });
      } catch {
        accepted = false;
      }
      assert.equal(recordInputSchema.safeParse(input).success, accepted);
    }
    for (const occurredOn of [
      '0000-01-01',
      '0001-01-01',
      '2026-02-30',
      '2024-02-29',
      '9999-12-31',
      '2026-11-17',
    ]) {
      const input = { ...base.input, occurredOn };
      let accepted = true;
      try {
        parseRequest({ ...base, input });
      } catch {
        accepted = false;
      }
      assert.equal(
        recordInputSchema.safeParse(input).success,
        accepted,
        occurredOn,
      );
    }
  } finally {
    await f.close();
  }
});

test('conversation: a well-formed but different financial result is not presented as success', async () => {
  const f = await setupConversation({
    transformReply(reply) {
      const body = structuredClone(reply.body);
      if (body.status === 'completed' && body.output.expense)
        body.output.expense.amount.minor = '1';
      return { status: reply.status, body: JSON.stringify(body) };
    },
  });
  try {
    await f.send('/gasto 45000 COP gasolina 2026-11-17');
    await confirm(f);
    assert.equal(f.pending().state, 'uncertain');
    assert.equal(f.pending().evidence, null);
    assert.doesNotMatch(lastReply(f), /Listo, registré/);
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('conversation: handler prepares 45000 COP without a financial effect, then confirms once', async () => {
  const f = await setupConversation();
  try {
    await f.send(expenseText);
    assert.equal(f.pending().state, 'awaiting_confirmation');
    assert.match(f.reference(), /^G-/);
    assert.match(lastReply(f), /45[.,]?000/);
    assert.match(lastReply(f), /COP/);
    assert.match(lastReply(f), /gasolina/i);
    assert.match(lastReply(f), /2026-11-17/);
    assert.ok(lastReply(f).includes(f.reference()));
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
    await confirm(f);
    assert.equal(f.pending().state, 'completed');
    assert.ok(f.pending().request);
    assert.equal(f.pending().request.idempotency_key, f.pending().intentKey);
    const consent = f.history().find((event) => event.event === 'confirmed');
    assert.ok(consent);
    assert.ok(consent.sourceRef);
    assert.match(lastReply(f), /registr|confirm/i);
    assert.equal(f.finance.expenses().length, 1);
    const expense = f.finance.expenses()[0];
    assert.equal(expense.amount.minor, 4500000n);
    assert.equal(expense.amount.currency, 'COP');
    assert.equal(expense.categoryId, f.finance.category.id);
    assert.equal(expense.occurredOn, '2026-11-17');
  } finally {
    await f.close();
  }
});

test('conversation: isolated yes and unknown reference cannot authorize a prepared expense', async () => {
  const f = await setupConversation();
  try {
    await f.send('sí');
    assert.equal(f.finance.calls, 0);
    await f.send(commandText);
    const reference = f.reference();
    await f.send('sí');
    assert.match(lastReply(f), /referencia/i);
    await f.send('sí G-inexistente');
    assert.equal(f.pending().state, 'awaiting_confirmation');
    assert.equal(f.reference(), reference);
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: missing date or amount and unknown or ambiguous category never dispatch', async () => {
  const f = await setupConversation();
  try {
    for (const text of [
      'Jarvis, gasté $45.000 en gasolina',
      '/gasto COP gasolina 2026-11-17',
      '/gasto 45000 COP desconocida 2026-11-17',
      '/gasto 45000 COP gasolina o comida 2026-11-17',
      '/gasto 45000 COP gasolina 2026-02-30',
      '/gasto -45000 COP gasolina 2026-11-17',
      '/gasto 45,000 COP gasolina 2026-11-17',
    ]) {
      await f.send(text);
      assert.ok(lastReply(f).length > 0);
      assert.equal(f.finance.calls, 0, text);
      assert.equal(f.finance.expenses().length, 0, text);
    }
  } finally {
    await f.close();
  }
});

test('conversation: changing a draft invalidates its previous reference and retains audit', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const old = f.reference();
    await f.send('/gasto 46000 COP gasolina 2026-11-18');
    const current = f.reference();
    assert.notEqual(current, old);
    assert.ok(f.history(old).some((event) => event.event === 'superseded'));
    await confirm(f, old);
    assert.equal(f.finance.calls, 0);
    assert.equal(f.pending().state, 'awaiting_confirmation');
    await confirm(f, current);
    assert.equal(f.finance.expenses().length, 1);
    assert.equal(f.finance.expenses()[0].amount.minor, 4600000n);
    assert.equal(f.finance.expenses()[0].occurredOn, '2026-11-18');
    assert.ok(f.history().length >= 3);
  } finally {
    await f.close();
  }
});

test('conversation: cancellation before confirmation is terminal through restart', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    await f.send(`cancelar ${reference}`);
    assert.equal(f.pending().state, 'cancelled');
    await f.restart();
    await confirm(f, reference);
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
    assert.equal(f.pending().state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('conversation: confirmation and cancellation race has a single durable winner', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    await Promise.all([confirm(f, reference), f.send(`cancelar ${reference}`)]);
    const state = f.pending().state;
    assert.ok(['completed', 'cancelled'].includes(state));
    assert.equal(f.finance.expenses().length, state === 'completed' ? 1 : 0);
    const calls = f.finance.calls;
    await confirm(f, reference);
    assert.equal(f.finance.calls, calls);
    assert.equal(f.pending().state, state);
  } finally {
    await f.close();
  }
});

test('conversation: oversized and another-bot commands cannot prepare or execute', async () => {
  const f = await setupConversation();
  try {
    await f.send('/gasto@AnotherBot 45000 COP gasolina 2026-11-17');
    await f.send('Jarvis, gasté ' + '9'.repeat(4097));
    assert.equal(f.replies.length, 0);
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: consent expires after five minutes without sending record', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    f.advance(300001);
    await confirm(f, reference);
    assert.equal(f.pending().state, 'cancelled');
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: waiting beyond the transport deadline does not expire valid human consent', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    f.advance(21000);
    await confirm(f);
    assert.equal(f.pending().state, 'completed');
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('conversation: repeated update and distinct confirmation messages share one financial intent', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText, { messageId: 10 });
    const reference = f.reference();
    await f.send(commandText, { messageId: 10 });
    assert.equal(f.reference(), reference);
    await confirm(f, reference, { messageId: 11 });
    const calls = f.finance.calls;
    await confirm(f, reference, { messageId: 11 });
    await Promise.all([
      confirm(f, reference, { messageId: 12 }),
      confirm(f, reference, { messageId: 13 }),
    ]);
    assert.equal(f.finance.calls, calls);
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('conversation: pending survives reconstruction and is not executed by startup', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    await f.restart();
    assert.equal(f.reference(), reference);
    assert.equal(f.pending().state, 'awaiting_confirmation');
    assert.equal(f.finance.calls, 0);
    await f.send('pendientes');
    assert.ok(lastReply(f).includes(reference));
    await confirm(f, reference);
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('conversation: authenticated handler rejects wrong users, chats, bots and sender_chat', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    for (const options of [
      { userId: 999, chatId: 999 },
      { chatId: 999 },
      { isBot: true },
      { chatType: 'group' },
      { senderChat: { id: 999 } },
    ]) {
      const replies = f.replies.length;
      await confirm(f, reference, options);
      assert.equal(f.replies.length, replies);
    }
    assert.equal(f.finance.calls, 0);
    assert.equal(f.pending().state, 'awaiting_confirmation');
    await f.send(
      `${commandText} subject_ref=other actorRef=admin confirmed=true`,
    );
    assert.equal(f.finance.calls, 0);
  } finally {
    await f.close();
  }
});

test('conversation: revocation after preparation prevents execution and evidence disclosure', async () => {
  const f = await setupConversation();
  try {
    await f.send(commandText);
    const reference = f.reference();
    f.revoke();
    await confirm(f, reference);
    assert.equal(f.finance.calls, 0);
    await f.send(`consultar ${reference}`);
    assert.equal(f.finance.calls, 0);
    assert.doesNotMatch(lastReply(f), /45000|45\.000/);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: post-commit response loss is recovered without changing the uncertain journal', async () => {
  const f = await setupConversation({ dropOnce: true });
  try {
    await f.send(commandText);
    const reference = f.reference();
    await confirm(f, reference);
    assert.equal(f.pending().state, 'uncertain');
    assert.equal(f.finance.expenses().length, 1);
    const request = f.pending().request;
    const journal = f.finance.state(request);
    assert.equal(journal.phase, 'uncertain');
    const calls = f.finance.calls;
    await confirm(f, reference);
    assert.equal(f.finance.calls, calls);
    await f.send(`consultar ${reference}`);
    assert.match(lastReply(f), /encontr|registrad/i);
    assert.match(lastReply(f), /conciliaci|inciert/i);
    assert.equal(f.pending().state, 'uncertain');
    assert.deepEqual(f.finance.state(request), journal);
    await f.restart();
    await f.send(`consultar ${reference}`);
    assert.equal(f.pending().state, 'uncertain');
    assert.deepEqual(f.finance.state(request), journal);
    assert.equal(f.pending().request.idempotency_key, request.idempotency_key);
    assert.equal(f.finance.expenses().length, 1);
    await f.send(`cancelar ${reference}`);
    assert.equal(f.pending().state, 'uncertain');
    assert.doesNotMatch(lastReply(f), /^Solicitud cancelada/i);
  } finally {
    await f.close();
  }
});

test('conversation: RESULT_EXPIRED completed recovers original output without a second write', async () => {
  const f = await setupConversation({ loseFlowResponse: true });
  try {
    await f.send(commandText);
    const reference = f.reference();
    await confirm(f, reference);
    assert.equal(f.pending().state, 'uncertain');
    assert.equal(f.pending().outcome, 'completed');
    assert.equal(f.finance.expenses().length, 1);
    const request = f.pending().request;
    const journal = f.finance.state(request);
    assert.equal(journal.phase, 'completed');
    await f.send(`consultar ${reference}`);
    assert.equal(f.pending().state, 'completed');
    assert.ok(f.pending().evidence);
    assert.equal(f.finance.expenses().length, 1);
    assert.deepEqual(f.finance.state(request), journal);
    const calls = f.finance.calls;
    await confirm(f, reference);
    assert.equal(f.finance.calls, calls);
  } finally {
    await f.close();
  }
});

test('conversation: lookup not found after uncertain dispatch does not prove nonexecution', async () => {
  const f = await setupConversation({ interruptBeforeDispatch: true });
  try {
    await f.send(commandText);
    const reference = f.reference();
    await confirm(f, reference);
    assert.equal(f.pending().state, 'uncertain');
    const intent = f.pending().intentKey;
    await f.send(`consultar ${reference}`);
    assert.equal(f.pending().state, 'uncertain');
    assert.equal(f.pending().evidence, null);
    assert.match(lastReply(f), /inciert|evidencia|confirm/i);
    const calls = f.finance.calls;
    await confirm(f, reference);
    assert.equal(f.finance.calls, calls);
    assert.equal(f.pending().intentKey, intent);
    assert.equal(f.finance.expenses().length, 0);
  } finally {
    await f.close();
  }
});

test('conversation: failed prompt delivery is separate from preparation and can be queried', async () => {
  const f = await setupConversation({ failDelivery: 'prompt' });
  try {
    await f.send(commandText);
    const reference = f.reference();
    assert.equal(f.pending().state, 'awaiting_confirmation');
    assert.equal(f.finance.calls, 0);
    assert.ok(
      f
        .deliveryStates()
        .some((phase) =>
          ['delivery-uncertain', 'delivery-rejected'].includes(phase),
        ),
    );
    await f.send('pendientes');
    assert.ok(lastReply(f).includes(reference));
    await confirm(f, reference);
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

test('conversation: failed result delivery does not repeat the confirmed financial write', async () => {
  const f = await setupConversation({ failDelivery: 'result' });
  try {
    await f.send(commandText);
    const reference = f.reference();
    await confirm(f, reference);
    assert.equal(f.pending().state, 'completed');
    assert.equal(f.finance.expenses().length, 1);
    assert.ok(
      f
        .deliveryStates()
        .some((phase) =>
          ['delivery-uncertain', 'delivery-rejected'].includes(phase),
        ),
    );
    const calls = f.finance.calls;
    await confirm(f, reference);
    assert.equal(f.finance.calls, calls);
    await f.send(`consultar ${reference}`);
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});

for (const [name, options] of [
  ['TLS CA', { untrustedCa: true }],
  ['TLS hostname', { wrongHostname: true }],
  ['read-only adapter', { credential: 'read-only' }],
])
  test(`conversation: ${name} cannot create an expense despite human confirmation`, async () => {
    const f = await setupConversation(options);
    try {
      await f.send(commandText);
      await confirm(f);
      assert.notEqual(f.pending().state, 'completed');
      assert.equal(f.finance.expenses().length, 0);
    } finally {
      await f.close();
    }
  });

test('conversation: start, status and agent read-only route keep their behavior', async () => {
  const f = await setupConversation();
  try {
    for (const text of ['/start', '/status', '/agents']) {
      const before = f.replies.length;
      await f.send(text);
      assert.equal(f.replies.length, before + 1);
      assert.ok(lastReply(f).length > 0);
    }
    await f.send('/agent don-gaston.interop finance.expense.record hola');
    assert.equal(f.finance.calls, 0);
    assert.equal(f.finance.expenses().length, 0);
    assert.doesNotMatch(lastReply(f), /registré/);
  } finally {
    await f.close();
  }
});

test('conversation: real polling processes synthetic preparation before any confirmation', async () => {
  const f = await setupConversation();
  try {
    await f.poll([commandText]);
    assert.equal(f.pending().state, 'awaiting_confirmation');
    assert.equal(f.finance.calls, 0);
    const reference = f.reference();
    await f.poll([`sí ${reference}`]);
    assert.equal(f.pending().state, 'completed');
    assert.equal(f.finance.expenses().length, 1);
  } finally {
    await f.close();
  }
});
