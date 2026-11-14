import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExpenseService } from '../src/application/expense-service.ts';
import { DomainError } from '../src/domain/errors.ts';
import { InMemoryExpenseStore } from '../src/infrastructure/in-memory-expense-store.ts';
import {
  fixturePolicy,
  otherActorContext,
  otherInstanceContext,
  otherSubjectContext,
  primaryContext as context,
} from './fixtures/expense-context.ts';

function setup() {
  const { policy, actions } = fixturePolicy();
  const service = new ExpenseService(new InMemoryExpenseStore(), policy);
  const category = service.createCategory(context, 'fixture-category-key', {
    name: 'Gasolina',
  });
  const input = {
    amount: '45000.00',
    currency: 'COP',
    categoryId: category.id,
    occurredOn: '2026-11-08',
  };
  return { service, category, input, actions };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof DomainError && error.code === code;
}

test('registra gasto de gasolina y consulta consumo mensual sin doble conteo', () => {
  const { service, category, input } = setup();
  const expense = service.recordExpense(context, 'fixture-expense-key', input);
  assert.equal(expense.kind, 'expense');
  assert.equal(expense.categoryId, category.id);
  assert.equal(expense.amount.minor, 4_500_000n);
  assert.equal(expense.occurredOn, '2026-11-08');
  assert.equal(expense.actorRef, context.actorRef);
  const report = service.monthlyTotals(context, { month: '2026-11' });
  assert.equal(report.month, '2026-11');
  assert.equal(report.currency, 'COP');
  assert.equal(report.total.minor, 4_500_000n);
  assert.deepEqual(
    report.byCategory.map((row) => [row.categoryId, row.total.minor]),
    [[category.id, 4_500_000n]],
  );
});

test('categorías y gastos devuelven resultado estable al reintentar su intención', () => {
  const { service, category, input } = setup();
  assert.deepEqual(
    service.createCategory(context, 'fixture-category-key', {
      name: ' Gasolina ',
    }),
    category,
  );
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  assert.deepEqual(
    service.recordExpense(context, 'fixture-expense-key', {
      ...input,
      amount: '45000',
    }),
    original,
  );
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('misma clave con distinto payload u operación produce conflicto sin mutar', () => {
  const { service, category, input } = setup();
  const secondCategory = service.createCategory(context, 'fixture-category-2', {
    name: 'Alimentación',
  });
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  for (const changed of [
    { ...input, amount: '45000.01' },
    { ...input, occurredOn: '2026-11-09' },
    { ...input, categoryId: secondCategory.id },
  ]) {
    assert.throws(
      () => service.recordExpense(context, 'fixture-expense-key', changed),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
  }
  assert.throws(
    () =>
      service.createCategory(context, 'fixture-expense-key', {
        name: 'Gasolina',
      }),
    hasCode('IDEMPOTENCY_CONFLICT'),
  );
  assert.throws(
    () => service.recordExpense(context, 'fixture-category-key', input),
    hasCode('IDEMPOTENCY_CONFLICT'),
  );
  assert.throws(
    () =>
      service.createCategory(context, 'fixture-category-key', { name: 'Otra' }),
    hasCode('IDEMPOTENCY_CONFLICT'),
  );
  assert.deepEqual(
    service.findIntent(context, 'fixture-expense-key'),
    original,
  );
  assert.deepEqual(
    service.findIntent(context, 'fixture-category-key'),
    category,
  );
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('respuesta perdida simulada: consulta misma intención y recupera el único resultado', () => {
  const { service, input } = setup();
  assert.equal(service.findIntent(context, 'fixture-expense-key'), undefined);
  // Se descarta deliberadamente la respuesta; el proceso y su memoria siguen vivos.
  service.recordExpense(context, 'fixture-expense-key', input);
  const recovered = service.findIntent(context, 'fixture-expense-key');
  assert.ok(recovered);
  assert.deepEqual(
    service.recordExpense(context, 'fixture-expense-key', input),
    recovered,
  );
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('reintentos agendados en un proceso conservan una única identidad en memoria', async () => {
  const { service, input } = setup();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() =>
        service.recordExpense(context, 'fixture-expense-key', input),
      ),
    ),
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('dos intenciones distintas pueden representar gastos iguales sin deduplicación heurística', () => {
  const { service, input } = setup();
  const first = service.recordExpense(context, 'fixture-expense-1', input);
  const second = service.recordExpense(context, 'fixture-expense-2', input);
  assert.notEqual(first.id, second.id);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    9_000_000n,
  );
});

test('totales exactos por mes y categoría; filtros vacíos no inventan movimientos', () => {
  const { service, category, input } = setup();
  const food = service.createCategory(context, 'fixture-food-key', {
    name: 'Alimentación',
  });
  const unused = service.createCategory(context, 'fixture-unused-key', {
    name: 'Sin gastos',
  });
  service.recordExpense(context, 'fixture-expense-1', input);
  service.recordExpense(context, 'fixture-expense-2', {
    ...input,
    amount: '0.10',
  });
  service.recordExpense(context, 'fixture-expense-3', {
    ...input,
    amount: '0.20',
    categoryId: food.id,
  });
  service.recordExpense(context, 'fixture-expense-4', {
    ...input,
    amount: '999',
    occurredOn: '2026-10-31',
  });
  service.recordExpense(context, 'fixture-expense-5', {
    ...input,
    amount: '999',
    occurredOn: '2026-12-01',
  });
  const all = service.monthlyTotals(context, { month: '2026-11' });
  assert.equal(all.total.minor, 4_500_030n);
  assert.deepEqual(
    new Map(all.byCategory.map((row) => [row.categoryId, row.total.minor])),
    new Map([
      [category.id, 4_500_010n],
      [food.id, 20n],
    ]),
  );
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11', categoryId: food.id })
      .total.minor,
    20n,
  );
  for (const query of [
    { month: '2025-11' },
    { month: '2026-11', categoryId: unused.id },
  ]) {
    const empty = service.monthlyTotals(context, query);
    assert.equal(empty.total.minor, 0n);
    assert.deepEqual(empty.byCategory, []);
  }
  assert.throws(
    () =>
      service.monthlyTotals(context, {
        month: '2026-11',
        categoryId: 'fixture-missing',
      }),
    hasCode('CATEGORY_NOT_FOUND'),
  );
});

test('agrega gastos superiores al entero seguro sin conversión a number', () => {
  const { service, input } = setup();
  service.recordExpense(context, 'fixture-large', {
    ...input,
    amount: '90071992547409.93',
  });
  service.recordExpense(context, 'fixture-cent', { ...input, amount: '0.01' });
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    9_007_199_254_740_994n,
  );
});

test('fecha civil valida bisiestos y límites mensuales sin depender del reloj', () => {
  const { service, input } = setup();
  service.recordExpense(context, 'fixture-leap', {
    ...input,
    occurredOn: '2024-02-29',
  });
  service.recordExpense(context, 'fixture-next-month', {
    ...input,
    occurredOn: '2024-03-01',
  });
  assert.equal(
    service.monthlyTotals(context, { month: '2024-02' }).total.minor,
    4_500_000n,
  );
  for (const occurredOn of [
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-11-00',
    '2026-11-08T12:00:00Z',
    '08/11/2026',
  ]) {
    assert.throws(
      () =>
        service.recordExpense(context, 'fixture-invalid-date', {
          ...input,
          occurredOn,
        }),
      hasCode('INVALID_DATE'),
    );
  }
  for (const month of ['2026-00', '2026-13', '2026-1', '2026-11-08']) {
    assert.throws(
      () => service.monthlyTotals(context, { month }),
      hasCode('INVALID_MONTH'),
    );
  }
  assert.equal(service.findIntent(context, 'fixture-invalid-date'), undefined);
});

test('entradas inválidas fallan sin consumir intención ni alterar totales', () => {
  const { service, input } = setup();
  for (const amount of ['0', '-1', '1.001', '45.000']) {
    assert.throws(
      () =>
        service.recordExpense(context, 'fixture-reusable', {
          ...input,
          amount,
        }),
      hasCode('INVALID_MONEY'),
    );
  }
  assert.throws(
    () =>
      service.recordExpense(context, 'fixture-reusable', {
        ...input,
        currency: 'USD',
      }),
    hasCode('UNSUPPORTED_CURRENCY'),
  );
  assert.throws(
    () =>
      service.recordExpense(context, 'fixture-reusable', {
        ...input,
        categoryId: 'fixture-missing',
      }),
    hasCode('CATEGORY_NOT_FOUND'),
  );
  assert.throws(
    () =>
      service.createCategory(context, 'fixture-empty-category', {
        name: '   ',
      }),
    hasCode('INVALID_CATEGORY'),
  );
  assert.throws(
    () => service.recordExpense(context, '', input),
    hasCode('INVALID_IDENTIFIER'),
  );
  assert.equal(service.findIntent(context, 'fixture-reusable'), undefined);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    0n,
  );
  service.recordExpense(context, 'fixture-reusable', input);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('instancia y sujeto aíslan categorías, intenciones y totales en el simulador', () => {
  const { service, input } = setup();
  const primary = service.recordExpense(context, 'fixture-shared-key', input);
  for (const foreign of [otherSubjectContext, otherInstanceContext]) {
    assert.equal(service.findIntent(foreign, 'fixture-shared-key'), undefined);
    assert.equal(
      service.monthlyTotals(foreign, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.throws(
      () => service.recordExpense(foreign, 'fixture-foreign-expense', input),
      hasCode('CATEGORY_NOT_FOUND'),
    );
    assert.throws(
      () =>
        service.monthlyTotals(foreign, {
          month: '2026-11',
          categoryId: input.categoryId,
        }),
      hasCode('CATEGORY_NOT_FOUND'),
    );
    const ownCategory = service.createCategory(
      foreign,
      'fixture-category-key',
      { name: 'Gasolina' },
    );
    const own = service.recordExpense(foreign, 'fixture-shared-key', {
      ...input,
      categoryId: ownCategory.id,
      amount: '1.00',
    });
    assert.notEqual(own.id, primary.id);
    assert.equal(
      service.monthlyTotals(foreign, { month: '2026-11' }).total.minor,
      100n,
    );
  }
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
});

test('revalida permiso de acción antes del reintento y de cada lectura', () => {
  const { service, input, actions } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  actions.delete('expense:record');
  assert.throws(
    () => service.recordExpense(context, 'fixture-expense-key', input),
    hasCode('FORBIDDEN'),
  );
  assert.throws(
    () => service.recordExpense(context, 'fixture-another', input),
    hasCode('FORBIDDEN'),
  );
  assert.ok(service.findIntent(context, 'fixture-expense-key'));
  actions.delete('expense:read');
  assert.throws(
    () => service.findIntent(context, 'fixture-expense-key'),
    hasCode('FORBIDDEN'),
  );
  assert.throws(
    () => service.monthlyTotals(context, { month: '2026-11' }),
    hasCode('FORBIDDEN'),
  );
  actions.delete('category:create');
  assert.throws(
    () =>
      service.createCategory(context, 'fixture-category-key', {
        name: 'Gasolina',
      }),
    hasCode('FORBIDDEN'),
  );
});

test('actor ajeno es rechazado; reintento por otro actor autorizado conserva auditoría original', () => {
  const { service, input } = setup();
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  const stranger = { ...context, actorRef: 'fixture-unauthorized-actor' };
  assert.throws(
    () => service.recordExpense(stranger, 'fixture-expense-key', input),
    hasCode('FORBIDDEN'),
  );
  assert.throws(
    () => service.findIntent(stranger, 'fixture-expense-key'),
    hasCode('FORBIDDEN'),
  );
  assert.deepEqual(
    service.recordExpense(otherActorContext, 'fixture-expense-key', input),
    original,
  );
  assert.equal(original.actorRef, context.actorRef);
});

test('resultados expuestos no permiten reescribir el historial en memoria', () => {
  const { service, category, input } = setup();
  const expense = service.recordExpense(context, 'fixture-expense-key', input);
  assert.equal(Reflect.set(category, 'name', 'Alterada'), false);
  assert.equal(Reflect.set(expense, 'occurredOn', '2026-10-01'), false);
  assert.equal(Reflect.set(expense.amount, 'minor', 0n), false);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    4_500_000n,
  );
  assert.equal(
    service.monthlyTotals(context, { month: '2026-10' }).total.minor,
    0n,
  );
});

test('un adaptador de memoria nuevo no pretende recuperar datos de una instancia anterior', () => {
  const { service, input } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  const fresh = new ExpenseService(
    new InMemoryExpenseStore(),
    fixturePolicy().policy,
  );
  assert.equal(fresh.findIntent(context, 'fixture-expense-key'), undefined);
  assert.equal(
    fresh.monthlyTotals(context, { month: '2026-11' }).total.minor,
    0n,
  );
});

test('payload financiero no admite identidad editable ni confirmación autodeclarada', () => {
  const { service, input } = setup();
  for (const extra of [
    { subjectRef: otherSubjectContext.subjectRef },
    { actorRef: otherActorContext.actorRef },
    { instanceRef: otherInstanceContext.instanceRef },
    { confirmed: true },
  ]) {
    const tampered = { ...input, ...extra };
    assert.throws(
      () => service.recordExpense(context, 'fixture-tampered', tampered),
      hasCode('INVALID_INPUT'),
    );
  }
  const categoryInput = {
    name: 'Gasolina',
    subjectRef: otherSubjectContext.subjectRef,
  };
  assert.throws(
    () =>
      service.createCategory(
        context,
        'fixture-tampered-category',
        categoryInput,
      ),
    hasCode('INVALID_INPUT'),
  );
  const query = {
    month: '2026-11',
    subjectRef: otherSubjectContext.subjectRef,
  };
  assert.throws(
    () => service.monthlyTotals(context, query),
    hasCode('INVALID_INPUT'),
  );
  assert.equal(service.findIntent(context, 'fixture-tampered'), undefined);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    0n,
  );
});

test('salto de línea final no crea importes, claves o fechas alternativas', () => {
  const { service, input } = setup();
  assert.throws(
    () => service.recordExpense(context, 'fixture-expense-key\n', input),
    hasCode('INVALID_IDENTIFIER'),
  );
  assert.throws(
    () =>
      service.recordExpense(context, 'fixture-invalid', {
        ...input,
        amount: '45000\n',
      }),
    hasCode('INVALID_MONEY'),
  );
  assert.throws(
    () =>
      service.recordExpense(context, 'fixture-invalid', {
        ...input,
        occurredOn: '2026-11-08\n',
      }),
    hasCode('INVALID_DATE'),
  );
  assert.throws(
    () => service.monthlyTotals(context, { month: '2026-11\n' }),
    hasCode('INVALID_MONTH'),
  );
  assert.equal(service.findIntent(context, 'fixture-invalid'), undefined);
  assert.equal(
    service.monthlyTotals(context, { month: '2026-11' }).total.minor,
    0n,
  );
});
