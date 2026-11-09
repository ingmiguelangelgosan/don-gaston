import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscription } from './fixtures/shared-subscription.ts';
test('ejemplo exacto: caja y consumo son proyecciones del mismo hecho', () => {
  const { factId, currency, paidMinor, participants } = subscription;
  assert.equal(currency, 'COP');
  assert.equal(paidMinor % participants, 0n);
  const personalConsumptionMinor = paidMinor / participants;
  const receivableMinor = paidMinor - personalConsumptionMinor;
  const cash = { factId, outflowMinor: paidMinor };
  const consumption = { factId, amountMinor: personalConsumptionMinor };
  assert.equal(cash.factId, consumption.factId);
  assert.equal(consumption.amountMinor, 30_000_000_000_000_001n);
  assert.equal(receivableMinor, 60_000_000_000_000_002n);
  assert.equal(cash.outflowMinor, consumption.amountMinor + receivableMinor);
  // No sumar caja + consumo: son vistas distintas de un único pago.
});
