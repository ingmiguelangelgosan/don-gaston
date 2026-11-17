import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  jsonSnapshot,
  parseRequest,
  parseWireJson,
  requestKey,
  requestFingerprint,
  responseEnvelope,
  validateResult,
  statusFor,
  MAX_WIRE_BYTES,
} from '../src/interfaces/jarvis-demo-contract.ts';
import type { Request } from '../src/interfaces/jarvis-demo-contract.ts';
import { Money } from '../src/domain/money.ts';

function fixture(): Request {
  return {
    protocol_version: '1.0',
    kind: 'execute',
    instance_id: 'synthetic-instance',
    agent_id: 'don-gaston',
    subject_ref: 'synthetic-owner',
    correlation_id: 'flow-1',
    request_id: 'request-1',
    idempotency_key: 'effect-1',
    capability: { name: 'finance.expense.record', version: '1.0' },
    deadline_at: '2026-11-16T12:00:00.000Z',
    cost_policy: 'no-paid-services',
    input: {
      amount: '45000',
      currency: 'COP',
      categoryId: 'gasolina',
      occurredOn: '2026-11-16',
    },
  };
}
const expense = {
  id: 'expense-1',
  amount: { minor: '4500000', currency: 'COP' },
  categoryId: 'gasolina',
  occurredOn: '2026-11-16',
};

test('demo contract: request strict schema preserves exact financial strings and returns immutable detached data', () => {
  const input = fixture(),
    parsed = parseRequest(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.input, input.input);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.input));
  assert.ok(Object.isFrozen(parsed.capability));
  assert.equal((parsed.input as { amount: string }).amount, '45000');
  const enormous = '9223372036854775808.01';
  assert.equal(
    (
      parseRequest({ ...input, input: { ...input.input, amount: enormous } })
        .input as { amount: string }
    ).amount,
    enormous,
  );
  assert.throws(
    () =>
      parseRequest({
        ...input,
        input: { ...input.input, actorRef: 'editable' },
      }),
    { code: 'VALIDATION_FAILED' },
  );
  assert.throws(() => parseRequest({ ...input, actorRef: 'editable' }), {
    code: 'VALIDATION_FAILED',
  });
  assert.throws(
    () =>
      parseRequest({
        ...input,
        input: { ...input.input, currency: undefined },
      }),
    { code: 'VALIDATION_FAILED' },
  );
});
test('demo contract: version, capability and IDs fail closed without coercion or hidden defaults', () => {
  const input = fixture();
  assert.throws(
    () => parseRequest({ ...input, protocol_version: '1.0-draft' }),
    { code: 'UNSUPPORTED_PROTOCOL' },
  );
  assert.throws(
    () =>
      parseRequest({
        ...input,
        capability: { name: 'finance.expense.record', version: '2.0' },
      }),
    { code: 'UNKNOWN_CAPABILITY' },
  );
  assert.throws(
    () =>
      parseRequest({
        ...input,
        capability: { name: 'finance.all', version: '1.0' },
      }),
    { code: 'UNKNOWN_CAPABILITY' },
  );
  for (const override of [
    { kind: 'read' },
    { cost_policy: 'paid' },
    { instance_id: 'x:y' },
    { idempotency_key: 'x'.repeat(129) },
    { capability: 'finance.expense.record' },
    { deadline_at: '2026-02-30T00:00:00Z' },
    { deadline_at: '2026-11-16T24:00:00Z' },
    { deadline_at: '2026-11-16T12:00:00+00:00' },
  ])
    assert.throws(() => parseRequest({ ...input, ...override }), {
      code: 'VALIDATION_FAILED',
    });
  assert.equal(
    parseRequest({ ...input, deadline_at: '2026-11-16T12:00:00Z' }).deadline_at,
    '2026-11-16T12:00:00Z',
  );
});
test('demo contract: amount, category and civil date are explicit and bounded', () => {
  const input = fixture();
  for (const override of [
    { amount: 45000 },
    { amount: '0' },
    { amount: '-1' },
    { amount: '45.000' },
    { amount: '01' },
    { amount: '1e3' },
    { amount: '1'.repeat(4097) },
    { currency: 'USD' },
    { categoryId: 'category:local' },
    { occurredOn: '2026-02-29' },
    { occurredOn: '0000-01-01' },
  ])
    assert.throws(
      () => parseRequest({ ...input, input: { ...input.input, ...override } }),
      { code: 'VALIDATION_FAILED' },
    );
  assert.equal(
    (
      parseRequest({
        ...input,
        input: { ...input.input, occurredOn: '2028-02-29' },
      }).input as { occurredOn: string }
    ).occurredOn,
    '2028-02-29',
  );
});
test('demo contract: key translation is versioned deterministic full-scope and lookup resolves record key', () => {
  const input = parseRequest(fixture());
  const expected =
    'jg1-' +
    createHash('sha256')
      .update(
        JSON.stringify([
          'synthetic-instance',
          'synthetic-owner',
          'don-gaston',
          'finance.expense.record',
          '1.0',
          'effect-1',
        ]),
      )
      .digest('hex');
  assert.equal(requestKey(input), expected);
  const lookup = parseRequest({
    ...input,
    request_id: 'read-1',
    idempotency_key: 'read-effect',
    capability: { name: 'finance.expense.lookup', version: '1.0' },
    input: { write_intent_id: 'effect-1' },
  });
  assert.equal(requestKey(lookup, 'effect-1'), expected);
  assert.notEqual(requestKey(lookup), expected);
  for (const overrides of [
    { instance_id: 'other' },
    { subject_ref: 'other' },
    { agent_id: 'other' },
    { idempotency_key: 'other' },
  ])
    assert.notEqual(requestKey({ ...input, ...overrides }), expected);
  assert.throws(
    () =>
      parseRequest({
        ...lookup,
        input: { write_intent_id: 'effect-1', subject_ref: 'other' },
      }),
    { code: 'VALIDATION_FAILED' },
  );
});
test('demo contract: fingerprint includes financial payload, stable request and correlation but excludes deadline only', () => {
  const input = parseRequest(fixture()),
    fingerprint = requestFingerprint(input);
  assert.equal(
    requestFingerprint({ ...input, deadline_at: '2026-12-01T00:00:00Z' }),
    fingerprint,
  );
  assert.equal(
    requestFingerprint(
      parseRequest(JSON.parse(JSON.stringify(input)) as unknown),
    ),
    fingerprint,
  );
  for (const request of [
    { ...input, request_id: 'changed' },
    { ...input, correlation_id: 'changed' },
    { ...input, input: { ...input.input, amount: '45000.00' } },
  ])
    assert.notEqual(requestFingerprint(request as Request), fingerprint);
});
test('demo contract: plain JSON boundary rejects accessors, instances, cycles, forbidden keys and limits', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'amount', {
    enumerable: true,
    get() {
      invoked = true;
      return '1';
    },
  });
  assert.throws(() => jsonSnapshot(getter), { code: 'VALIDATION_FAILED' });
  assert.equal(invoked, false);
  for (const value of [
    Money.fromDecimal('1'),
    undefined,
    NaN,
    Infinity,
    1n,
    {
      toJSON() {
        return {};
      },
    },
    Object.assign(Object.create({}), { x: 1 }),
    { [Symbol('x')]: 1 },
  ])
    assert.throws(() => jsonSnapshot(value), { code: 'VALIDATION_FAILED' });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => jsonSnapshot(cyclic), { code: 'VALIDATION_FAILED' });
  let nested: unknown = null;
  for (let i = 0; i < 34; i++) nested = { nested };
  assert.throws(() => jsonSnapshot(nested), { code: 'VALIDATION_FAILED' });
  assert.throws(() => jsonSnapshot(Array(8192).fill(null)), {
    code: 'VALIDATION_FAILED',
  });
  assert.throws(() => jsonSnapshot({ value: 'x'.repeat(MAX_WIRE_BYTES) }), {
    code: 'VALIDATION_FAILED',
  });
  assert.throws(() => jsonSnapshot(JSON.parse('{"__proto__":{}}') as unknown), {
    code: 'VALIDATION_FAILED',
  });
});
test('demo contract: JSON parser rejects duplicates including escaped nested keys and malformed grammar', () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"outer":{"a":1,"a":2}}',
    '[{"a":1,"a":2}]',
    '{"a":1,}',
    '[1,]',
    '{"a":"unterminated}',
    '[Infinity]',
    '{"a":NaN}',
    '{"a":1} true',
    'true false',
    '{"constructor":1}',
    ''.padEnd(MAX_WIRE_BYTES + 1, ' '),
  ])
    assert.throws(() => parseWireJson(text), { code: 'VALIDATION_FAILED' });
  assert.deepEqual(
    parseWireJson('{"escaped":"a\\\"b","nested":[{"x":1},{"x":2}],"x":null}'),
    { escaped: 'a"b', nested: [{ x: 1 }, { x: 2 }], x: null },
  );
  assert.deepEqual(
    parseRequest(parseWireJson(JSON.stringify(fixture()))),
    fixture(),
  );
});
test('demo contract: responses must correlate and expose only the approved expense projection', () => {
  const request = parseRequest(fixture());
  const result = {
    ...responseEnvelope(request),
    kind: 'execution-result',
    status: 'completed',
    output: { expense },
  };
  assert.deepEqual(validateResult(result, request), result);
  for (const changed of [
    { ...result, subject_ref: 'other' },
    { ...result, request_id: 'other' },
    { ...result, status: 'pending', operation_id: 'op' },
    { ...result, output: { expense: { ...expense, actorRef: 'private' } } },
    {
      ...result,
      output: {
        expense: { ...expense, amount: { minor: '04500000', currency: 'COP' } },
      },
    },
    {
      ...result,
      output: { expense: { ...expense, amount: Money.fromDecimal('45000') } },
    },
  ])
    assert.throws(() => validateResult(changed, request), {
      code: 'VALIDATION_FAILED',
    });
  const lookup = parseRequest({
    ...fixture(),
    capability: { name: 'finance.expense.lookup', version: '1.0' },
    input: { write_intent_id: 'effect-1' },
  });
  for (const output of [{ found: false }, { found: true, expense }])
    assert.deepEqual(validateResult({ ...result, output }, lookup), {
      ...result,
      output,
    });
  assert.throws(
    () =>
      validateResult({ ...result, output: { found: false, expense } }, lookup),
    { code: 'VALIDATION_FAILED' },
  );
  assert.throws(
    () => validateResult({ ...result, output: { found: true } }, lookup),
    { code: 'VALIDATION_FAILED' },
  );
});
test('demo contract: failed envelope validates known codes, retry metadata and exact output exclusion', () => {
  const request = parseRequest(fixture()),
    result = {
      ...responseEnvelope(request),
      kind: 'execution-result',
      status: 'failed',
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'IDEMPOTENCY_CONFLICT',
        retryable: false,
      },
    };
  assert.deepEqual(validateResult(result, request), result);
  assert.equal(statusFor('IDEMPOTENCY_CONFLICT'), 409);
  assert.equal(statusFor('UNAVAILABLE'), 503);
  for (const changed of [
    { ...result, output: {} },
    { ...result, error: { ...result.error, code: 'STORAGE_CORRUPT' } },
    { ...result, error: { ...result.error, retry_after_ms: 0 } },
    { ...result, error: { ...result.error, message: 'x'.repeat(513) } },
  ])
    assert.throws(() => validateResult(changed, request), {
      code: 'VALIDATION_FAILED',
    });
});
