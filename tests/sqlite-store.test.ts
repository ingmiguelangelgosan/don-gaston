import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExpenseService } from '../src/application/expense-service.ts';
import { DomainError } from '../src/domain/errors.ts';
import { Money } from '../src/domain/money.ts';
import {
  SqliteExpenseStore,
  SQLITE_LIMITS,
} from '../src/infrastructure/sqlite-expense-store.ts';
import { StorageError } from '../src/infrastructure/sqlite-errors.ts';
import {
  fixturePolicy,
  otherSubjectContext,
  otherInstanceContext,
  primaryContext as context,
} from './fixtures/expense-context.ts';

const fixturesRoot = join(process.cwd(), '.cache', 'sqlite-tests');
mkdirSync(fixturesRoot, { recursive: true });
const runDirectory = mkdtempSync(join(fixturesRoot, 'store-'));
let sequence = 0;
function databasePath() {
  return join(runDirectory, `fixture-${++sequence}.sqlite`);
}
function hasCode(code: string) {
  return (error: unknown) =>
    (error instanceof StorageError || error instanceof DomainError) &&
    error.code === code;
}
function setup(path = databasePath()) {
  const store = new SqliteExpenseStore(path);
  const { policy, actions } = fixturePolicy();
  const service = new ExpenseService(store, policy);
  const category = service.createCategory(context, 'fixture-category-key', {
    name: 'Gasolina',
  });
  const input = {
    amount: '45000.00',
    currency: 'COP',
    categoryId: category.id,
    occurredOn: '2026-11-08',
  };
  return { path, store, service, category, input, actions };
}

interface WorkerReply {
  type: 'ready' | 'result' | 'error';
  code?: string;
  result?: { id: string; amount: { minor: string; currency: string } };
}
async function runWorkers(
  path: string,
  categoryId: string,
  jobs: readonly { mode: 'write' | 'read'; key: string; amount: string }[],
): Promise<WorkerReply[]> {
  const workers = jobs.map((job) => {
    const child = fork(
      new URL('./fixtures/sqlite-worker.ts', import.meta.url),
      [path, job.mode, job.key, categoryId, job.amount],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let reply: WorkerReply | undefined;
    let resolveDone!: (reply: WorkerReply) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<WorkerReply>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('SQLite fixture worker timed out');
      rejectReady(error);
      rejectDone(error);
    }, 15_000);
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
          `SQLite fixture worker exited without result (${code})`,
        );
        rejectReady(error);
        rejectDone(error);
      }
    });
    return { child, ready, done };
  });
  // Register done handlers immediately so startup failure cannot be unhandled.
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

test('SQLite conserva categorías, hechos, totales y replay al cerrar y reabrir', () => {
  const { path, store, service, category, input } = setup();
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const reopened = new SqliteExpenseStore(path);
  try {
    const recovered = new ExpenseService(reopened, fixturePolicy().policy);
    assert.deepEqual(
      recovered.findIntent(context, 'fixture-category-key'),
      category,
    );
    assert.deepEqual(
      recovered.findIntent(context, 'fixture-expense-key'),
      original,
    );
    assert.deepEqual(
      recovered.recordExpense(context, 'fixture-expense-key', {
        ...input,
        amount: '45000',
      }),
      original,
    );
    assert.equal(
      recovered.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
    assert.throws(
      () =>
        recovered.recordExpense(context, 'fixture-expense-key', {
          ...input,
          amount: '1',
        }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    reopened.close();
  }
});

test('SQLite preserva cantidades mayores de 64 bits y suma exacta en bigint', () => {
  const { store, service, input, path } = setup();
  service.recordExpense(context, 'fixture-large', {
    ...input,
    amount: '18446744073709551616.01',
  });
  service.recordExpense(context, 'fixture-cent', { ...input, amount: '0.02' });
  store.close();
  const reopened = new SqliteExpenseStore(path);
  try {
    const recovered = new ExpenseService(reopened, fixturePolicy().policy);
    const expense = recovered.findIntent(context, 'fixture-large');
    assert.equal(expense?.kind, 'expense');
    if (expense?.kind !== 'expense') assert.fail('Missing expense');
    assert.equal(expense.amount.minor, 1_844_674_407_370_955_161_601n);
    assert.equal(
      recovered.monthlyTotals(context, { month: '2026-11' }).total.minor,
      1_844_674_407_370_955_161_603n,
    );
  } finally {
    reopened.close();
  }
});

test('fallo entre hecho e intención revierte ambos y permite reintentar la misma clave', () => {
  const { path, store, input } = setup();
  store.close();
  const failing = new SqliteExpenseStore(path, {
    afterFactInsert: () => {
      throw new Error('fixture-injected-failure');
    },
  });
  const failingService = new ExpenseService(failing, fixturePolicy().policy);
  assert.throws(() =>
    failingService.recordExpense(context, 'fixture-expense-key', input),
  );
  failing.close();
  const reopened = new SqliteExpenseStore(path);
  try {
    const recovered = new ExpenseService(reopened, fixturePolicy().policy);
    assert.equal(
      recovered.findIntent(context, 'fixture-expense-key'),
      undefined,
    );
    assert.equal(
      recovered.monthlyTotals(context, { month: '2026-11' }).total.minor,
      0n,
    );
    recovered.recordExpense(context, 'fixture-expense-key', input);
    assert.equal(
      recovered.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
  } finally {
    reopened.close();
  }
});

test('dos procesos reales reintentan igual intención y recuperan un único ID durable', async () => {
  const { path, store, category } = setup();
  store.close();
  const replies = await runWorkers(path, category.id, [
    { mode: 'write', key: 'fixture-concurrent', amount: '45000' },
    { mode: 'write', key: 'fixture-concurrent', amount: '45000.00' },
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.type),
    ['result', 'result'],
  );
  assert.equal(new Set(replies.map((reply) => reply.result?.id)).size, 1);
  const [read] = await runWorkers(path, category.id, [
    { mode: 'read', key: 'fixture-concurrent', amount: '0' },
  ]);
  assert.deepEqual(read?.result, replies[0]?.result);
  const reopened = new SqliteExpenseStore(path);
  try {
    assert.equal(
      new ExpenseService(reopened, fixturePolicy().policy).monthlyTotals(
        context,
        { month: '2026-11' },
      ).total.minor,
      4_500_000n,
    );
  } finally {
    reopened.close();
  }
});

test('dos procesos con la misma intención y payload distinto: un commit y un conflicto', async () => {
  const { path, store, category } = setup();
  store.close();
  const replies = await runWorkers(path, category.id, [
    { mode: 'write', key: 'fixture-concurrent-conflict', amount: '1.00' },
    { mode: 'write', key: 'fixture-concurrent-conflict', amount: '2.00' },
  ]);
  const success = replies.filter((reply) => reply.type === 'result');
  const errors = replies.filter((reply) => reply.type === 'error');
  assert.equal(success.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'IDEMPOTENCY_CONFLICT');
  const reopened = new SqliteExpenseStore(path);
  try {
    assert.equal(
      new ExpenseService(reopened, fixturePolicy().policy)
        .monthlyTotals(context, { month: '2026-11' })
        .total.minor.toString(),
      success[0]?.result?.amount.minor,
    );
  } finally {
    reopened.close();
  }
});

test('bloqueo SQLite produce STORAGE_BUSY; liberar permite reintentar sin nueva clave', () => {
  const { path, store, input } = setup();
  store.close();
  const bounded = new SqliteExpenseStore(path, { busyTimeoutMs: 20 });
  const service = new ExpenseService(bounded, fixturePolicy().policy);
  const lock = new DatabaseSync(path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => service.recordExpense(context, 'fixture-locked', input),
      hasCode('STORAGE_BUSY'),
    );
    lock.exec('ROLLBACK');
    assert.equal(service.findIntent(context, 'fixture-locked'), undefined);
    service.recordExpense(context, 'fixture-locked', input);
    assert.equal(
      service.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
  } finally {
    lock.close();
    bounded.close();
  }
});

test('SQLite aísla sujeto/instancia y revalida permisos tras revocación', () => {
  const { store, service, input, actions } = setup();
  try {
    service.recordExpense(context, 'fixture-expense-key', input);
    for (const foreign of [otherSubjectContext, otherInstanceContext]) {
      assert.equal(
        service.findIntent(foreign, 'fixture-expense-key'),
        undefined,
      );
      assert.equal(
        service.monthlyTotals(foreign, { month: '2026-11' }).total.minor,
        0n,
      );
      assert.throws(
        () => service.recordExpense(foreign, 'fixture-foreign', input),
        hasCode('CATEGORY_NOT_FOUND'),
      );
      const category = service.createCategory(foreign, 'fixture-category-key', {
        name: 'Gasolina',
      });
      service.recordExpense(foreign, 'fixture-expense-key', {
        ...input,
        categoryId: category.id,
        amount: '1',
      });
      assert.equal(
        service.monthlyTotals(foreign, { month: '2026-11' }).total.minor,
        100n,
      );
    }
    actions.delete('expense:record');
    assert.throws(
      () => service.recordExpense(context, 'fixture-expense-key', input),
      hasCode('FORBIDDEN'),
    );
    actions.delete('expense:read');
    assert.throws(
      () => service.findIntent(context, 'fixture-expense-key'),
      hasCode('FORBIDDEN'),
    );
  } finally {
    store.close();
  }
});

test('solo lectura consulta y rechaza escrituras; cerrado rechaza nuevas operaciones', () => {
  const { store, service, path, input } = setup();
  const expense = service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  assert.throws(
    () => service.findIntent(context, 'fixture-expense-key'),
    hasCode('STORAGE_CLOSED'),
  );
  const readOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    const reader = new ExpenseService(readOnly, fixturePolicy().policy);
    assert.deepEqual(
      reader.findIntent(context, 'fixture-expense-key'),
      expense,
    );
    assert.equal(
      reader.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
    assert.throws(
      () => reader.recordExpense(context, 'fixture-new', input),
      hasCode('STORAGE_READ_ONLY'),
    );
    assert.throws(
      () =>
        reader.createCategory(context, 'fixture-new-category', {
          name: 'Otra',
        }),
      hasCode('STORAGE_READ_ONLY'),
    );
  } finally {
    readOnly.close();
  }
});

test('límite de importe falla explícitamente sin perder precisión ni consumir clave', () => {
  const { store, service, input } = setup();
  try {
    assert.throws(
      () =>
        service.recordExpense(context, 'fixture-over-limit', {
          ...input,
          amount: '1'.repeat(4097),
        }),
      hasCode('STORAGE_LIMIT'),
    );
    assert.equal(service.findIntent(context, 'fixture-over-limit'), undefined);
    service.recordExpense(context, 'fixture-over-limit', input);
    assert.equal(
      service.monthlyTotals(context, { month: '2026-11' }).total.minor,
      4_500_000n,
    );
    assert.throws(
      () =>
        store.createCategory(
          context,
          'fixture-long-fingerprint',
          'a'.repeat(32769),
          { kind: 'category', name: 'Gasolina', actorRef: context.actorRef },
        ),
      hasCode('STORAGE_LIMIT'),
    );
    assert.equal(
      service.findIntent(context, 'fixture-long-fingerprint'),
      undefined,
    );
  } finally {
    store.close();
  }
});

test('archivo corrupto falla cerrado sin reemplazar su contenido', () => {
  const path = databasePath();
  const corrupt = Buffer.from('fixture-not-a-sqlite-database');
  writeFileSync(path, corrupt);
  assert.throws(() => new SqliteExpenseStore(path), hasCode('STORAGE_CORRUPT'));
  assert.deepEqual(readFileSync(path), corrupt);
});

test('backup y restauración separados conservan IDs, totales e idempotencia; mide RPO/RTO sintéticos', (t) => {
  const { path, store, service, category, input } = setup();
  const backup = databasePath();
  const restoredPath = databasePath();
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  try {
    store.backupTo(backup);
    const snapshotCompleted = performance.now();
    // Un hecho posterior al snapshot mide pérdida observable con precisión de eventos.
    service.recordExpense(context, 'fixture-after-backup', {
      ...input,
      amount: '1',
    });
    const lostEventCommitted = performance.now();
    const restoreStarted = performance.now();
    SqliteExpenseStore.restoreBackup(backup, restoredPath);
    const restored = new SqliteExpenseStore(restoredPath);
    try {
      const recovered = new ExpenseService(restored, fixturePolicy().policy);
      assert.deepEqual(
        recovered.findIntent(context, 'fixture-expense-key'),
        original,
      );
      assert.deepEqual(
        recovered.findIntent(context, 'fixture-category-key'),
        category,
      );
      assert.deepEqual(
        recovered.recordExpense(context, 'fixture-expense-key', input),
        original,
      );
      assert.equal(
        recovered.findIntent(context, 'fixture-after-backup'),
        undefined,
      );
      assert.equal(
        recovered.monthlyTotals(context, { month: '2026-11' }).total.minor,
        4_500_000n,
      );
      assert.equal(
        service.monthlyTotals(context, { month: '2026-11' }).total.minor,
        4_500_100n,
      );
      t.diagnostic(
        `Synthetic RPO: 1 committed event, ${(lostEventCommitted - snapshotCompleted).toFixed(3)} ms after snapshot; RTO including reopen/verification: ${(performance.now() - restoreStarted).toFixed(3)} ms. Fixtures retained: ${runDirectory}`,
      );
    } finally {
      restored.close();
    }
    assert.throws(
      () => store.backupTo(backup),
      hasCode('STORAGE_DESTINATION_EXISTS'),
    );
    assert.throws(
      () => SqliteExpenseStore.restoreBackup(backup, restoredPath),
      hasCode('STORAGE_DESTINATION_EXISTS'),
    );
    assert.throws(
      () => store.backupTo(path),
      hasCode('STORAGE_DESTINATION_EXISTS'),
    );
    assert.throws(
      () => SqliteExpenseStore.restoreBackup(backup, backup),
      hasCode('STORAGE_DESTINATION_EXISTS'),
    );
  } finally {
    store.close();
  }
});

test('JSON corrupto persistido se detecta al abrir; no se sirve un resultado parcial', () => {
  const { path, store, service, input } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const fixture = new DatabaseSync(path);
  try {
    const trigger = fixture
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'intents_no_update'",
      )
      .get();
    assert.ok(trigger);
    assert.equal(typeof trigger.sql, 'string');
    fixture.exec(
      'DROP TRIGGER intents_no_update; PRAGMA ignore_check_constraints = ON',
    );
    fixture
      .prepare('UPDATE intents SET result_json = ? WHERE intent_key = ?')
      .run('{fixture-invalid-json', 'fixture-expense-key');
    fixture.exec(trigger.sql as string);
  } finally {
    fixture.close();
  }
  assert.throws(() => new SqliteExpenseStore(path), hasCode('STORAGE_CORRUPT'));
});

test('constraints SQL impiden actualizar/borrar historia, duplicar intención y dejar hechos huérfanos', () => {
  const { path, store, service, input } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const connection = new DatabaseSync(path);
  try {
    connection.exec('PRAGMA foreign_keys = ON');
    for (const sql of [
      "UPDATE facts SET actor_ref = 'fixture-changed'",
      'DELETE FROM facts',
      "UPDATE intents SET fingerprint = 'fixture-changed'",
      'DELETE FROM intents',
      'INSERT INTO intents SELECT * FROM intents',
    ])
      assert.throws(() => connection.exec(sql));
    assert.equal(
      connection.prepare('SELECT count(*) AS count FROM facts').get()?.count,
      2,
    );
    assert.equal(
      connection.prepare('SELECT count(*) AS count FROM intents').get()?.count,
      2,
    );
    connection.exec('BEGIN');
    connection.exec(
      "INSERT INTO facts (instance_ref,subject_ref,id,intent_key,kind,actor_ref,name) SELECT instance_ref,subject_ref,'fixture-orphan-id','fixture-orphan-key',kind,actor_ref,name FROM facts WHERE kind = 'category'",
    );
    assert.throws(() => connection.exec('COMMIT'));
    connection.exec('ROLLBACK');
    assert.equal(
      connection.prepare('SELECT count(*) AS count FROM facts').get()?.count,
      2,
    );
  } finally {
    connection.close();
  }
});

test('límite de archivo se aplica antes de abrir una base de tamaño excesivo', () => {
  const path = databasePath();
  writeFileSync(path, '');
  truncateSync(path, SQLITE_LIMITS.maxDatabaseBytes + 1);
  assert.throws(() => new SqliteExpenseStore(path), hasCode('STORAGE_LIMIT'));
});

test('límite de unidades menores conserva exactamente el máximo y rechaza el siguiente', () => {
  const { store, service, input } = setup();
  try {
    const minor = BigInt('9'.repeat(SQLITE_LIMITS.maxMinorDigits));
    const result = service.recordExpense(context, 'fixture-max-minor', {
      ...input,
      amount: `${'9'.repeat(SQLITE_LIMITS.maxMinorDigits - 2)}.99`,
    });
    assert.equal(result.amount.minor, minor);
    service.recordExpense(context, 'fixture-second-max-minor', {
      ...input,
      amount: `${'9'.repeat(SQLITE_LIMITS.maxMinorDigits - 2)}.99`,
    });
    const total = service.monthlyTotals(context, { month: '2026-11' }).total
      .minor;
    assert.equal(total, minor * 2n);
    assert.equal(total.toString().length, SQLITE_LIMITS.maxMinorDigits + 1);
    assert.throws(
      () =>
        service.recordExpense(context, 'fixture-over-minor', {
          ...input,
          amount: `1${'0'.repeat(SQLITE_LIMITS.maxMinorDigits - 2)}`,
        }),
      hasCode('STORAGE_LIMIT'),
    );
    assert.equal(store.findIntent(context, 'fixture-over-minor'), undefined);
  } finally {
    store.close();
  }
});

test('suma excede signed int64 aunque cada gasto individual cabe en ese rango', () => {
  const { store, service, input } = setup();
  try {
    service.recordExpense(context, 'fixture-int64-max', {
      ...input,
      amount: '92233720368547758.07',
    });
    service.recordExpense(context, 'fixture-int64-overflow', {
      ...input,
      amount: '0.01',
    });
    assert.equal(
      service.monthlyTotals(context, { month: '2026-11' }).total.minor,
      9_223_372_036_854_775_808n,
    );
  } finally {
    store.close();
  }
});

test('base en modo solo lectura permite snapshot a un destino nuevo', () => {
  const { store, service, path, input } = setup();
  const original = service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const backup = databasePath();
  const readOnly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    readOnly.backupTo(backup);
  } finally {
    readOnly.close();
  }
  const restored = new SqliteExpenseStore(backup, { readOnly: true });
  try {
    assert.deepEqual(
      new ExpenseService(restored, fixturePolicy().policy).findIntent(
        context,
        'fixture-expense-key',
      ),
      original,
    );
  } finally {
    restored.close();
  }
});

test('versión desconocida, checksum alterado y trigger sustituido se rechazan sin reparar silenciosamente', () => {
  const changes = [
    'PRAGMA user_version = 999',
    "UPDATE schema_migrations SET checksum = 'fixture-wrong-checksum'",
    'DROP TRIGGER facts_no_update; CREATE TRIGGER facts_no_update BEFORE UPDATE ON facts BEGIN SELECT 1; END',
    'CREATE TABLE sqlitex_extra (id INTEGER)',
  ];
  for (const change of changes) {
    const { store, path } = setup();
    store.close();
    const fixture = new DatabaseSync(path);
    try {
      fixture.exec(change);
    } finally {
      fixture.close();
    }
    const before = readFileSync(path);
    assert.throws(
      () => new SqliteExpenseStore(path),
      hasCode('STORAGE_SCHEMA'),
    );
    assert.deepEqual(readFileSync(path), before);
  }
});

test('importe persistido corrupto se rechaza al abrir incluso conservando el esquema', () => {
  const { path, store, service, input } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const fixture = new DatabaseSync(path);
  try {
    const trigger = fixture
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'facts_no_update'",
      )
      .get();
    assert.ok(trigger);
    assert.equal(typeof trigger.sql, 'string');
    fixture.exec(
      'DROP TRIGGER facts_no_update; PRAGMA ignore_check_constraints = ON',
    );
    fixture
      .prepare("UPDATE facts SET amount_minor = ? WHERE kind = 'expense'")
      .run('-1');
    fixture.exec(trigger.sql as string);
  } finally {
    fixture.close();
  }
  assert.throws(() => new SqliteExpenseStore(path), hasCode('STORAGE_CORRUPT'));
});

test('resultado restaurado sigue siendo Money inmutable y no una estructura JSON mutable', () => {
  const { path, store, service, input } = setup();
  service.recordExpense(context, 'fixture-expense-key', input);
  store.close();
  const reopened = new SqliteExpenseStore(path);
  try {
    const result = new ExpenseService(
      reopened,
      fixturePolicy().policy,
    ).findIntent(context, 'fixture-expense-key');
    assert.equal(result?.kind, 'expense');
    if (result?.kind !== 'expense') assert.fail('Missing expense');
    assert.ok(result.amount instanceof Money);
    assert.equal(Reflect.set(result, 'occurredOn', '2026-10-01'), false);
    assert.equal(Reflect.set(result.amount, 'minor', 0n), false);
  } finally {
    reopened.close();
  }
});
