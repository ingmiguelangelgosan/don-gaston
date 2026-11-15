import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExpenseCorrectionsService } from '../src/application/expense-corrections-service.ts';
import { ExpenseService } from '../src/application/expense-service.ts';
import type { AccessPolicy, Action } from '../src/application/expense-store.ts';
import { DomainError } from '../src/domain/errors.ts';
import { StorageError } from '../src/infrastructure/sqlite-errors.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import {
  primaryContext as context,
  otherSubjectContext,
  otherInstanceContext,
} from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'correction-tests');
mkdirSync(root, { recursive: true });
const runDirectory = mkdtempSync(join(root, 'corrections-'));
let sequence = 0;
const databasePath = () => join(runDirectory, `fixture-${++sequence}.sqlite`);
const recordedAt = '2026-11-14T12:00:00.000Z';
const clock = () => recordedAt;

function policyFixture() {
  const actions = new Set<Action>([
    'category:create',
    'expense:record',
    'expense:read',
    'expense:correct',
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
function setup() {
  const path = databasePath();
  const store = new SqliteExpenseStore(path);
  const { actions, policy } = policyFixture();
  const expenses = new ExpenseService(store, policy);
  const corrections = new ExpenseCorrectionsService(store, policy, clock);
  const category = expenses.createCategory(context, 'fixture-category', {
    name: 'Gasolina',
  });
  const input = {
    amount: '45000.00',
    currency: 'COP',
    categoryId: category.id,
    occurredOn: '2026-11-08',
  };
  const expense = expenses.recordExpense(context, 'fixture-expense', input);
  return {
    path,
    store,
    actions,
    policy,
    expenses,
    corrections,
    category,
    input,
    expense,
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
  result?: {
    id: string;
    replacement: null | { id: string; amount: { minor: string } };
  };
}
async function race(
  path: string,
  expenseId: string,
  categoryId: string,
  jobs: readonly { mode: 'void' | 'replace'; key: string; amount: string }[],
) {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/correction-worker.ts', import.meta.url),
      [path, job.mode, job.key, expenseId, categoryId, job.amount],
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
      const error = new Error('Correction fixture worker timed out');
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
          `Correction worker exited without result (${code})`,
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

test('anular conserva original, motivo y auditoría; excluye solo el gasto anulado de totales', () => {
  const { store, expenses, corrections, expense, input } = setup();
  try {
    expenses.recordExpense(context, 'fixture-retained', {
      ...input,
      amount: '0.01',
    });
    assert.deepEqual(corrections.getExpenseHistory(context, expense.id), {
      expense,
      status: 'active',
      correctedBy: null,
      replaces: null,
    });
    const correction = corrections.voidExpense(context, 'fixture-void', {
      expenseId: expense.id,
      reason: 'Registro duplicado sintético',
    });
    assert.equal(correction.kind, 'correction');
    assert.equal(correction.originalExpenseId, expense.id);
    assert.equal(correction.actorRef, context.actorRef);
    assert.equal(correction.reason, 'Registro duplicado sintético');
    assert.equal(correction.recordedAt, recordedAt);
    assert.equal(correction.replacement, null);
    assert.deepEqual(corrections.getExpenseHistory(context, expense.id), {
      expense,
      status: 'voided',
      correctedBy: correction,
      replaces: null,
    });
    assert.deepEqual(expenses.findIntent(context, 'fixture-expense'), expense);
    assert.deepEqual(
      expenses.recordExpense(context, 'fixture-expense', input),
      expense,
    );
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      1n,
    );
    assert.equal(Reflect.set(correction, 'reason', 'Alterado'), false);
  } finally {
    store.close();
  }
});

test('reemplazo corrige monto, categoría y fecha histórica sin sumar original y sustituto', () => {
  const { store, expenses, corrections, expense } = setup();
  try {
    const other = expenses.createCategory(context, 'fixture-other-category', {
      name: 'Alimentación',
    });
    const replacement = {
      amount: '18446744073709551616.01',
      currency: 'COP',
      categoryId: other.id,
      occurredOn: '2024-02-29',
    };
    const correction = corrections.replaceExpense(context, 'fixture-replace', {
      expenseId: expense.id,
      reason: 'Corregir datos sintéticos',
      replacement,
    });
    assert.ok(correction.replacement);
    assert.notEqual(correction.replacement.id, expense.id);
    assert.equal(
      correction.replacement.amount.minor,
      1_844_674_407_370_955_161_601n,
    );
    assert.equal(correction.replacement.categoryId, other.id);
    assert.equal(correction.replacement.occurredOn, '2024-02-29');
    assert.deepEqual(corrections.getExpenseHistory(context, expense.id), {
      expense,
      status: 'replaced',
      correctedBy: correction,
      replaces: null,
    });
    assert.deepEqual(
      corrections.getExpenseHistory(context, correction.replacement.id),
      {
        expense: correction.replacement,
        status: 'active',
        correctedBy: null,
        replaces: correction,
      },
    );
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.equal(
      expenses.monthlyTotals(context, {
        month: '2024-02',
        categoryId: other.id,
      }).total.minor,
      1_844_674_407_370_955_161_601n,
    );
    assert.deepEqual(expenses.findIntent(context, 'fixture-expense'), expense);
  } finally {
    store.close();
  }
});

test('reintento conserva corrección e instante original aunque cambie el reloj', () => {
  const { store, corrections, policy, expense, input } = setup();
  try {
    const payload = {
      expenseId: expense.id,
      reason: 'Motivo sintético',
      replacement: input,
    };
    const original = corrections.replaceExpense(
      context,
      'fixture-correction',
      payload,
    );
    const later = new ExpenseCorrectionsService(
      store,
      policy,
      () => '2026-12-01T00:00:00.000Z',
    );
    assert.deepEqual(
      later.replaceExpense(context, 'fixture-correction', {
        ...payload,
        replacement: { ...input, amount: '45000' },
      }),
      original,
    );
    assert.deepEqual(later.findIntent(context, 'fixture-correction'), original);
    assert.deepEqual(later.findIntent(context, 'fixture-expense'), expense);
  } finally {
    store.close();
  }
});

test('misma intención con cambios o distinta operación genera conflicto; nueva clave sobre corregido falla', () => {
  const { store, corrections, expenses, expense, input } = setup();
  try {
    const another = expenses.recordExpense(
      context,
      'fixture-another-expense',
      input,
    );
    const payload = {
      expenseId: expense.id,
      reason: 'Motivo sintético',
      replacement: input,
    };
    corrections.replaceExpense(context, 'fixture-correction', payload);
    for (const changed of [
      { ...payload, reason: 'Otro motivo' },
      { ...payload, expenseId: another.id },
      { ...payload, replacement: { ...input, amount: '1' } },
      { ...payload, replacement: { ...input, occurredOn: '2026-10-01' } },
    ])
      assert.throws(
        () =>
          corrections.replaceExpense(context, 'fixture-correction', changed),
        hasCode('IDEMPOTENCY_CONFLICT'),
      );
    assert.throws(
      () =>
        corrections.voidExpense(context, 'fixture-correction', {
          expenseId: expense.id,
          reason: payload.reason,
        }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () =>
        corrections.voidExpense(context, 'fixture-expense', {
          expenseId: expense.id,
          reason: payload.reason,
        }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () => expenses.recordExpense(context, 'fixture-correction', input),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.throws(
      () =>
        corrections.voidExpense(context, 'fixture-new-key', {
          expenseId: expense.id,
          reason: payload.reason,
        }),
      hasCode('EXPENSE_ALREADY_CORRECTED'),
    );
    assert.equal(corrections.findIntent(context, 'fixture-new-key'), undefined);
  } finally {
    store.close();
  }
});

test('corregir un reemplazo conserva la cadena histórica y proyecta solo la hoja activa', () => {
  const { store, corrections, expenses, expense, input } = setup();
  try {
    const first = corrections.replaceExpense(context, 'fixture-correction-1', {
      expenseId: expense.id,
      reason: 'Primer ajuste',
      replacement: { ...input, amount: '10' },
    });
    assert.ok(first.replacement);
    const second = corrections.replaceExpense(context, 'fixture-correction-2', {
      expenseId: first.replacement.id,
      reason: 'Segundo ajuste',
      replacement: { ...input, amount: '20' },
    });
    assert.ok(second.replacement);
    assert.deepEqual(
      corrections.getExpenseHistory(context, first.replacement.id),
      {
        expense: first.replacement,
        status: 'replaced',
        correctedBy: second,
        replaces: first,
      },
    );
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      2000n,
    );
    corrections.voidExpense(context, 'fixture-correction-3', {
      expenseId: second.replacement.id,
      reason: 'Anular último ajuste',
    });
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-branch', {
          expenseId: expense.id,
          reason: 'Rama inválida',
          replacement: input,
        }),
      hasCode('EXPENSE_ALREADY_CORRECTED'),
    );
  } finally {
    store.close();
  }
});

test('validación de motivo, instante y reemplazo no consume intención ni modifica originales', () => {
  const { store, corrections, policy, expenses, expense, input } = setup();
  try {
    for (const reason of [
      '',
      '   ',
      'motivo\u0000',
      'motivo\ncontrol',
      'x'.repeat(501),
    ]) {
      assert.throws(
        () =>
          corrections.voidExpense(context, 'fixture-invalid', {
            expenseId: expense.id,
            reason,
          }),
        hasCode('INVALID_CORRECTION'),
      );
    }
    for (const timestamp of [
      '',
      '2026-02-30T00:00:00.000Z',
      '2026-11-14',
      '2026-11-14T12:00:00.000Z\n',
    ]) {
      const invalidClock = new ExpenseCorrectionsService(
        store,
        policy,
        () => timestamp,
      );
      assert.throws(
        () =>
          invalidClock.voidExpense(context, 'fixture-invalid', {
            expenseId: expense.id,
            reason: 'Motivo',
          }),
        hasCode('INVALID_CORRECTION'),
      );
    }
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-invalid', {
          expenseId: expense.id,
          reason: 'Motivo',
          replacement: { ...input, amount: '0' },
        }),
      hasCode('INVALID_MONEY'),
    );
    // The replacement is a complete explicit statement, including currency.
    const missingCurrency = {
      amount: input.amount,
      categoryId: input.categoryId,
      occurredOn: input.occurredOn,
    };
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-invalid', {
          expenseId: expense.id,
          reason: 'Motivo',
          replacement: missingCurrency as typeof input,
        }),
      hasCode('INVALID_INPUT'),
    );
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-invalid', {
          expenseId: expense.id,
          reason: 'Motivo',
          replacement: { ...input, amount: '1'.repeat(4097) },
        }),
      hasCode('STORAGE_LIMIT'),
    );
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-invalid', {
          expenseId: expense.id,
          reason: 'Motivo',
          replacement: { ...input, categoryId: 'fixture-missing-category' },
        }),
      hasCode('CATEGORY_NOT_FOUND'),
    );
    assert.equal(corrections.findIntent(context, 'fixture-invalid'), undefined);
    assert.equal(
      corrections.getExpenseHistory(context, expense.id).status,
      'active',
    );
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
    corrections.voidExpense(context, 'fixture-invalid', {
      expenseId: expense.id,
      reason: 'Motivo válido',
    });
  } finally {
    store.close();
  }
});

test('sujeto e instancia ajenos no leen ni corrigen el gasto; no revela existencia', () => {
  const { store, corrections, expense, input } = setup();
  try {
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.throws(
        () => corrections.getExpenseHistory(foreign, expense.id),
        hasCode('EXPENSE_NOT_FOUND'),
      );
      assert.throws(
        () =>
          corrections.voidExpense(foreign, 'fixture-foreign', {
            expenseId: expense.id,
            reason: 'Motivo',
          }),
        hasCode('EXPENSE_NOT_FOUND'),
      );
      assert.throws(
        () =>
          corrections.replaceExpense(foreign, 'fixture-foreign', {
            expenseId: expense.id,
            reason: 'Motivo',
            replacement: input,
          }),
        hasCode('EXPENSE_NOT_FOUND'),
      );
      assert.equal(
        corrections.findIntent(foreign, 'fixture-foreign'),
        undefined,
      );
    }
    assert.throws(
      () => corrections.getExpenseHistory(context, 'fixture-missing-expense'),
      hasCode('EXPENSE_NOT_FOUND'),
    );
    assert.throws(
      () =>
        corrections.voidExpense(context, 'fixture-missing', {
          expenseId: 'fixture-missing-expense',
          reason: 'Motivo',
        }),
      hasCode('EXPENSE_NOT_FOUND'),
    );
    assert.equal(
      corrections.getExpenseHistory(context, expense.id).status,
      'active',
    );
  } finally {
    store.close();
  }
});

test('permisos de corrección y lectura se revalidan antes de replay; identidad editable se rechaza', () => {
  const { store, corrections, actions, expense, input } = setup();
  try {
    for (const extra of [
      { actorRef: 'fixture-forged' },
      { subjectRef: otherSubjectContext.subjectRef },
      { instanceRef: otherInstanceContext.instanceRef },
      { recordedAt },
      { confirmed: true },
    ]) {
      assert.throws(
        () =>
          corrections.voidExpense(context, 'fixture-forged', {
            expenseId: expense.id,
            reason: 'Motivo',
            ...extra,
          }),
        hasCode('INVALID_INPUT'),
      );
      assert.throws(
        () =>
          corrections.replaceExpense(context, 'fixture-forged', {
            expenseId: expense.id,
            reason: 'Motivo',
            replacement: { ...input, ...extra },
          }),
        hasCode('INVALID_INPUT'),
      );
    }
    const payload = { expenseId: expense.id, reason: 'Motivo' };
    corrections.voidExpense(context, 'fixture-void', payload);
    actions.delete('expense:correct');
    assert.throws(
      () => corrections.voidExpense(context, 'fixture-void', payload),
      hasCode('FORBIDDEN'),
    );
    assert.throws(
      () =>
        corrections.replaceExpense(context, 'fixture-replace', {
          ...payload,
          replacement: input,
        }),
      hasCode('FORBIDDEN'),
    );
    assert.ok(corrections.findIntent(context, 'fixture-void'));
    actions.delete('expense:read');
    assert.throws(
      () => corrections.getExpenseHistory(context, expense.id),
      hasCode('FORBIDDEN'),
    );
    assert.throws(
      () => corrections.findIntent(context, 'fixture-void'),
      hasCode('FORBIDDEN'),
    );
  } finally {
    store.close();
  }
});

test('rollback después de corrección o reemplazo deja hecho original vigente y permite misma clave', () => {
  for (const hook of ['afterCorrectionInsert', 'afterFactInsert'] as const) {
    const { path, store, expense, input, policy } = setup();
    store.close();
    const failing = new SqliteExpenseStore(path, {
      [hook]: () => {
        throw new Error('fixture-failure');
      },
    });
    try {
      const corrections = new ExpenseCorrectionsService(failing, policy, clock);
      assert.throws(
        () =>
          corrections.replaceExpense(context, 'fixture-atomic', {
            expenseId: expense.id,
            reason: 'Motivo',
            replacement: { ...input, amount: '1' },
          }),
        hasCode('STORAGE_IO'),
      );
    } finally {
      failing.close();
    }
    const reopened = new SqliteExpenseStore(path);
    try {
      const corrections = new ExpenseCorrectionsService(
        reopened,
        policy,
        clock,
      );
      const expenses = new ExpenseService(reopened, policy);
      assert.equal(
        corrections.findIntent(context, 'fixture-atomic'),
        undefined,
      );
      assert.equal(
        corrections.getExpenseHistory(context, expense.id).status,
        'active',
      );
      assert.equal(
        expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
        4_500_000n,
      );
      corrections.replaceExpense(context, 'fixture-atomic', {
        expenseId: expense.id,
        reason: 'Motivo',
        replacement: { ...input, amount: '1' },
      });
      assert.equal(
        expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
        100n,
      );
    } finally {
      reopened.close();
    }
  }
});

test('reapertura conserva historial, replay de anulación/reemplazo y totales vigentes', () => {
  const { path, store, expense, input, corrections, policy } = setup();
  const replacement = corrections.replaceExpense(context, 'fixture-replace', {
    expenseId: expense.id,
    reason: 'Ajuste',
    replacement: { ...input, amount: '20' },
  });
  assert.ok(replacement.replacement);
  const last = corrections.voidExpense(context, 'fixture-void', {
    expenseId: replacement.replacement.id,
    reason: 'Anulado',
  });
  store.close();
  const reopened = new SqliteExpenseStore(path);
  try {
    const recovered = new ExpenseCorrectionsService(reopened, policy, clock);
    assert.deepEqual(
      recovered.findIntent(context, 'fixture-replace'),
      replacement,
    );
    assert.deepEqual(recovered.findIntent(context, 'fixture-void'), last);
    assert.deepEqual(
      recovered.voidExpense(context, 'fixture-void', {
        expenseId: replacement.replacement.id,
        reason: 'Anulado',
      }),
      last,
    );
    assert.deepEqual(
      recovered.getExpenseHistory(context, replacement.replacement.id),
      {
        expense: replacement.replacement,
        status: 'voided',
        correctedBy: last,
        replaces: replacement,
      },
    );
    assert.equal(
      new ExpenseService(reopened, policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
      0n,
    );
  } finally {
    reopened.close();
  }
});

test('procesos concurrentes con misma intención devuelven corrección y reemplazo únicos', async () => {
  const { path, store, expense, category, policy } = setup();
  store.close();
  const replies = await race(path, expense.id, category.id, [
    { mode: 'replace', key: 'fixture-race', amount: '10' },
    { mode: 'replace', key: 'fixture-race', amount: '10.00' },
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.type),
    ['result', 'result'],
  );
  assert.deepEqual(replies[0]?.result, replies[1]?.result);
  const reopened = new SqliteExpenseStore(path);
  try {
    assert.equal(
      new ExpenseService(reopened, policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
      1000n,
    );
  } finally {
    reopened.close();
  }
});

test('procesos concurrentes con payload o intención distintos dejan una sola corrección', async () => {
  for (const sameKey of [true, false]) {
    const { path, store, expense, category, policy } = setup();
    store.close();
    const replies = await race(path, expense.id, category.id, [
      { mode: 'void', key: 'fixture-race', amount: '0' },
      {
        mode: 'replace',
        key: sameKey ? 'fixture-race' : 'fixture-race-other',
        amount: '10',
      },
    ]);
    const successes = replies.filter((reply) => reply.type === 'result');
    const failures = replies.filter((reply) => reply.type === 'error');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(
      failures[0]?.code,
      sameKey ? 'IDEMPOTENCY_CONFLICT' : 'EXPENSE_ALREADY_CORRECTED',
    );
    const reopened = new SqliteExpenseStore(path);
    try {
      const expected = successes[0]?.result?.replacement?.amount.minor ?? '0';
      assert.equal(
        new ExpenseService(reopened, policy)
          .monthlyTotals(context, { month: '2026-11' })
          .total.minor.toString(),
        expected,
      );
    } finally {
      reopened.close();
    }
  }
});

test('backup restaurado conserva vínculos, originales e idempotencia de corrección', (t) => {
  const { store, expense, input, corrections, policy } = setup();
  const backup = databasePath();
  const restoredPath = databasePath();
  try {
    const first = corrections.replaceExpense(context, 'fixture-replace', {
      expenseId: expense.id,
      reason: 'Ajuste',
      replacement: { ...input, amount: '12.34' },
    });
    assert.ok(first.replacement);
    store.backupTo(backup);
    SqliteExpenseStore.restoreBackup(backup, restoredPath);
    const restored = new SqliteExpenseStore(restoredPath);
    try {
      const recovered = new ExpenseCorrectionsService(restored, policy, clock);
      assert.deepEqual(recovered.getExpenseHistory(context, expense.id), {
        expense,
        status: 'replaced',
        correctedBy: first,
        replaces: null,
      });
      assert.deepEqual(
        recovered.getExpenseHistory(context, first.replacement.id),
        {
          expense: first.replacement,
          status: 'active',
          correctedBy: null,
          replaces: first,
        },
      );
      assert.deepEqual(
        recovered.replaceExpense(context, 'fixture-replace', {
          expenseId: expense.id,
          reason: 'Ajuste',
          replacement: { ...input, amount: '12.34' },
        }),
        first,
      );
      assert.equal(
        new ExpenseService(restored, policy).monthlyTotals(context, {
          month: '2026-11',
        }).total.minor,
        1234n,
      );
    } finally {
      restored.close();
    }
    t.diagnostic(`Synthetic correction fixtures retained: ${runDirectory}`);
  } finally {
    store.close();
  }
});

test('corregir categoría dentro del mismo mes mueve el total sin duplicarlo', () => {
  const { store, expenses, corrections, expense, category, input } = setup();
  try {
    const other = expenses.createCategory(context, 'fixture-other-category', {
      name: 'Alimentación',
    });
    corrections.replaceExpense(context, 'fixture-reclassify', {
      expenseId: expense.id,
      reason: 'Categoría equivocada',
      replacement: { ...input, categoryId: other.id },
    });
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
    assert.equal(
      expenses.monthlyTotals(context, {
        month: '2026-11',
        categoryId: category.id,
      }).total.minor,
      0n,
    );
    assert.equal(
      expenses.monthlyTotals(context, {
        month: '2026-11',
        categoryId: other.id,
      }).total.minor,
      4_500_000n,
    );
  } finally {
    store.close();
  }
});

test('original SQL y correcciones son inmutables; lectura sola no permite corregir', () => {
  const { path, store, corrections, expense, input, policy } = setup();
  const inspect = new DatabaseSync(path);
  try {
    const before = inspect
      .prepare('SELECT * FROM facts WHERE id=?')
      .get(expense.id);
    corrections.replaceExpense(context, 'fixture-replace', {
      expenseId: expense.id,
      reason: 'Ajuste',
      replacement: { ...input, amount: '1' },
    });
    assert.deepEqual(
      inspect.prepare('SELECT * FROM facts WHERE id=?').get(expense.id),
      before,
    );
    assert.throws(() =>
      inspect.exec("UPDATE corrections SET reason='Cambio silencioso'"),
    );
    assert.throws(() => inspect.exec('DELETE FROM corrections'));
    assert.equal(
      inspect.prepare('SELECT count(*) AS count FROM corrections').get()?.count,
      1,
    );
  } finally {
    inspect.close();
    store.close();
  }
  const readOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    const reader = new ExpenseCorrectionsService(readOnly, policy, clock);
    assert.equal(
      reader.getExpenseHistory(context, expense.id).status,
      'replaced',
    );
    assert.throws(
      () =>
        reader.voidExpense(context, 'fixture-read-only', {
          expenseId: expense.id,
          reason: 'Motivo',
        }),
      hasCode('STORAGE_READ_ONLY'),
    );
  } finally {
    readOnly.close();
  }
});

test('auditoría alterada se detecta al reabrir sin regenerar intención ni resultado', () => {
  const { path, store, corrections, expense } = setup();
  corrections.voidExpense(context, 'fixture-void', {
    expenseId: expense.id,
    reason: 'Motivo original',
  });
  store.close();
  const fixture = new DatabaseSync(path);
  try {
    const trigger = fixture
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='corrections_no_update'",
      )
      .get()?.sql;
    assert.equal(typeof trigger, 'string');
    fixture.exec('DROP TRIGGER corrections_no_update');
    fixture
      .prepare('UPDATE corrections SET reason=?')
      .run('Motivo cambiado sin rastro');
    fixture.exec(trigger as string);
  } finally {
    fixture.close();
  }
  assert.throws(() => new SqliteExpenseStore(path), hasCode('STORAGE_CORRUPT'));
});

test('una anulación no puede ocultar un gasto SQL, independientemente del orden de inserción', () => {
  const { path, store, corrections, expense, category, expenses, input } =
    setup();
  corrections.voidExpense(context, 'fixture-void', {
    expenseId: expense.id,
    reason: 'Motivo',
  });
  const second = expenses.recordExpense(context, 'fixture-second', input);
  store.close();
  const fixture = new DatabaseSync(path);
  const insertFact = (key: string) =>
    fixture
      .prepare(
        `INSERT INTO facts
    (instance_ref,subject_ref,id,intent_key,kind,actor_ref,category_id,category_kind,amount_minor,currency,occurred_on)
    VALUES(?,?,?,?,'expense',?,?,'category','100','COP','2026-11-08')`,
      )
      .run(
        context.instanceRef,
        context.subjectRef,
        'fixture-hidden-fact',
        key,
        context.actorRef,
        category.id,
      );
  try {
    // Intention first: the stored void has no associated expense.
    assert.throws(() => insertFact('fixture-void'), /fact_intent_mismatch/);
    // Fact first: a void intention cannot subsequently take its key.
    fixture.exec('BEGIN');
    insertFact('fixture-new-void');
    fixture
      .prepare(
        `INSERT INTO corrections
      (instance_ref,subject_ref,id,intent_key,original_expense_id,reason,recorded_at,actor_ref)
      VALUES(?,?,?,'fixture-new-void',?,'Motivo',?,?)`,
      )
      .run(
        context.instanceRef,
        context.subjectRef,
        'fixture-raw-correction',
        second.id,
        recordedAt,
        context.actorRef,
      );
    assert.throws(
      () =>
        fixture
          .prepare(
            `INSERT INTO intents
      (instance_ref,subject_ref,intent_key,correction_id,fingerprint,result_json)
      VALUES(?,?,'fixture-new-void','fixture-raw-correction',?,'{}')`,
          )
          .run(context.instanceRef, context.subjectRef, 'a'.repeat(64)),
      /fact_intent_mismatch/,
    );
    fixture.exec('ROLLBACK');
    assert.equal(
      fixture.prepare('SELECT count(*) AS n FROM corrections').get()?.n,
      1,
    );
    assert.equal(
      fixture
        .prepare("SELECT 1 FROM facts WHERE id='fixture-hidden-fact'")
        .get(),
      undefined,
    );
  } finally {
    if (fixture.isTransaction) fixture.exec('ROLLBACK');
    fixture.close();
  }
  const reopened = new SqliteExpenseStore(path);
  try {
    assert.equal(
      new ExpenseService(reopened, policyFixture().policy).monthlyTotals(
        context,
        { month: '2026-11' },
      ).total.minor,
      4_500_000n,
    );
  } finally {
    reopened.close();
  }
});

test('migración v1 a v2 conserva hechos, huellas, claves y resultados originales', () => {
  const path = databasePath();
  const v1 = new DatabaseSync(path);
  const hash = (fields: readonly string[]) =>
    createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const category = {
    kind: 'category',
    id: 'fixture-v1-category',
    name: 'Gasolina',
    actorRef: context.actorRef,
  };
  const expense = {
    kind: 'expense',
    id: 'fixture-v1-expense',
    categoryId: category.id,
    amount: { minor: '4500000', currency: 'COP' },
    occurredOn: '2026-11-08',
    actorRef: context.actorRef,
  };
  let beforeFacts: unknown;
  let beforeIntents: unknown;
  try {
    v1.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    v1.exec(migration001.sql);
    v1.prepare(
      'INSERT INTO schema_migrations(version,checksum) VALUES(1,?)',
    ).run(createHash('sha256').update(migration001.sql).digest('hex'));
    v1.exec('PRAGMA application_id=1145520467; PRAGMA user_version=1');
    v1.prepare(
      'INSERT INTO facts(instance_ref,subject_ref,id,intent_key,kind,actor_ref,name) VALUES(?,?,?,?,?,?,?)',
    ).run(
      context.instanceRef,
      context.subjectRef,
      category.id,
      'fixture-v1-category-key',
      category.kind,
      category.actorRef,
      category.name,
    );
    v1.prepare(
      'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)',
    ).run(
      context.instanceRef,
      context.subjectRef,
      'fixture-v1-category-key',
      category.id,
      hash(['category:v1', category.name]),
      JSON.stringify(category),
    );
    v1.prepare(
      'INSERT INTO facts(instance_ref,subject_ref,id,intent_key,kind,actor_ref,category_id,category_kind,amount_minor,currency,occurred_on) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      context.instanceRef,
      context.subjectRef,
      expense.id,
      'fixture-v1-expense-key',
      expense.kind,
      expense.actorRef,
      category.id,
      'category',
      expense.amount.minor,
      expense.amount.currency,
      expense.occurredOn,
    );
    v1.prepare(
      'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)',
    ).run(
      context.instanceRef,
      context.subjectRef,
      'fixture-v1-expense-key',
      expense.id,
      hash([
        'expense:v1',
        expense.amount.minor,
        'COP',
        category.id,
        expense.occurredOn,
      ]),
      JSON.stringify(expense),
    );
    v1.exec('COMMIT');
    beforeFacts = v1.prepare('SELECT * FROM facts ORDER BY id').all();
    beforeIntents = v1
      .prepare(
        'SELECT instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json FROM intents ORDER BY intent_key',
      )
      .all();
  } finally {
    v1.close();
  }
  const { policy } = policyFixture();
  const legacyReadOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    assert.equal(
      new ExpenseService(legacyReadOnly, policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
      4_500_000n,
    );
  } finally {
    legacyReadOnly.close();
  }
  assert.throws(
    () =>
      new SqliteExpenseStore(path, {
        afterMigration: () => {
          throw new Error('fixture-migration-failure');
        },
      }),
    hasCode('STORAGE_IO'),
  );
  const rolledBack = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      rolledBack.prepare('PRAGMA user_version').get()?.user_version,
      1,
    );
    assert.deepEqual(
      rolledBack.prepare('SELECT * FROM facts ORDER BY id').all(),
      beforeFacts,
    );
    assert.deepEqual(
      rolledBack
        .prepare(
          'SELECT instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json FROM intents ORDER BY intent_key',
        )
        .all(),
      beforeIntents,
    );
    assert.equal(
      rolledBack
        .prepare("SELECT name FROM sqlite_schema WHERE name='corrections'")
        .get(),
      undefined,
    );
    assert.equal(
      rolledBack
        .prepare('SELECT count(*) AS count FROM schema_migrations')
        .get()?.count,
      1,
    );
  } finally {
    rolledBack.close();
  }
  const migrated = new SqliteExpenseStore(path);
  try {
    const expenses = new ExpenseService(migrated, policy);
    const corrections = new ExpenseCorrectionsService(migrated, policy, clock);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(expenses.findIntent(context, 'fixture-v1-expense-key')),
      ),
      expense,
    );
    assert.deepEqual(
      expenses.findIntent(context, 'fixture-v1-category-key'),
      category,
    );
    assert.equal(
      corrections.getExpenseHistory(context, expense.id).status,
      'active',
    );
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        inspect.prepare('PRAGMA user_version').get()?.user_version,
        3,
      );
      assert.deepEqual(
        inspect.prepare('SELECT * FROM facts ORDER BY id').all(),
        beforeFacts,
      );
      assert.deepEqual(
        inspect
          .prepare(
            'SELECT instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json FROM intents ORDER BY intent_key',
          )
          .all(),
        beforeIntents,
      );
    } finally {
      inspect.close();
    }
    corrections.voidExpense(context, 'fixture-v2-void', {
      expenseId: expense.id,
      reason: 'Corrección tras migración',
    });
    assert.equal(
      expenses.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          expenses.recordExpense(context, 'fixture-v1-expense-key', {
            amount: '45000.00',
            currency: 'COP',
            categoryId: category.id,
            occurredOn: expense.occurredOn,
          }),
        ),
      ),
      expense,
    );
  } finally {
    migrated.close();
  }
});
