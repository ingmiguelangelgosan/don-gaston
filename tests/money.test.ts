import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../src/domain/errors.ts';
import { Money } from '../src/domain/money.ts';

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof DomainError && error.code === code;
}

test('COP: 45.000 pesos se representa exactamente con 4.500.000 centavos', () => {
  for (const amount of ['45000', '45000.0', '45000.00']) {
    const money = Money.fromDecimal(amount);
    assert.equal(money.minor, 4_500_000n);
    assert.equal(money.currency, 'COP');
  }
  assert.equal(Money.fromDecimal('0.01').minor, 1n);
  assert.equal(Money.fromDecimal('0').minor, 0n);
});

test('sumas exactas de centavos y cantidades superiores al entero seguro de number', () => {
  assert.equal(
    Money.fromDecimal('0.10').add(Money.fromDecimal('0.20')).minor,
    30n,
  );
  const large = Money.fromDecimal('90071992547409.93');
  assert.equal(large.minor, 9_007_199_254_740_993n);
  assert.equal(large.add(Money.fromMinor(1n)).minor, 9_007_199_254_740_994n);
  assert.equal(large.minor, 9_007_199_254_740_993n);
});

test('rechaza formatos ambiguos, redondeo implícito y dinero binario', () => {
  const invalid = [
    '',
    ' ',
    ' 45000',
    '45000 ',
    '45000\n',
    '0.01\r\n',
    '$45.000',
    '45.000',
    '45,000',
    '1e3',
    '+1',
    '-1',
    '-0',
    '01',
    '.50',
    '1.',
    '0.001',
    '1.000',
    'NaN',
    'Infinity',
    45000,
    null,
    undefined,
  ];
  for (const amount of invalid) {
    assert.throws(
      () => Money.fromDecimal(amount as string),
      hasCode('INVALID_MONEY'),
    );
  }
  assert.throws(() => Money.fromMinor(-1n), hasCode('INVALID_MONEY'));
  assert.throws(
    () => Money.fromMinor(1 as unknown as bigint),
    hasCode('INVALID_MONEY'),
  );
});

test('solo COP está implementada; monedas no soportadas no se convierten', () => {
  for (const currency of ['USD', 'JPY', 'XYZ', 'cop', '']) {
    assert.throws(
      () => Money.fromDecimal('1.00', currency),
      hasCode('UNSUPPORTED_CURRENCY'),
    );
    assert.throws(
      () => Money.fromMinor(100n, currency),
      hasCode('UNSUPPORTED_CURRENCY'),
    );
  }
});

test('Money es inmutable y serializa unidades menores como texto sin pérdida', () => {
  const money = Money.fromMinor(9_007_199_254_740_993n);
  assert.equal(Reflect.set(money, 'minor', 0n), false);
  assert.equal(Reflect.set(money, 'currency', 'USD'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(money)), {
    minor: '9007199254740993',
    currency: 'COP',
  });
});
