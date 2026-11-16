import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { FinancedDebtService } from '../src/application/financed-debt-service.ts';
import { DebtPaymentCorrectionsService } from '../src/application/debt-payment-corrections-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { migration001 } from '../src/infrastructure/migrations/001-expenses.ts';
import { migration002 } from '../src/infrastructure/migrations/002-expense-corrections.ts';
import { migration003 } from '../src/infrastructure/migrations/003-monthly-budgets.ts';
import { migration004 } from '../src/infrastructure/migrations/004-event-delivery.ts';
import { migration005 } from '../src/infrastructure/migrations/005-financed-debts.ts';
import { primaryContext as context } from './fixtures/expense-context.ts';

const root = join(process.cwd(), '.cache', 'debt-correction-migration-tests');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'corrections-'));
let sequence = 0;
const pathFor = () => join(directory, `fixture-${++sequence}.sqlite`);
const policy = { allows: () => true };
const clock = () => '2026-11-15T12:00:00.000Z';
const opening = {
  description: 'Synthetic iPhone',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-11-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
  historicalPaidAmount: '2000000',
};
const replacement = {
  installmentNumber: 9,
  amount: '200000',
  currency: 'COP',
  paidOn: '2026-11-15',
  reference: 'synthetic corrected payment',
};
function setup() {
  const path = pathFor(),
    store = new SqliteExpenseStore(path);
  const debts = new FinancedDebtService(store, policy, clock),
    corrections = new DebtPaymentCorrectionsService(store, policy, clock);
  const debt = debts.registerDebt(context, 'opening', opening);
  const payment = debts.confirmPayment(context, 'payment', {
    debtId: debt.id,
    installmentNumber: 9,
    amount: '250000',
    paidOn: '2026-11-15',
    reference: 'synthetic',
  });
  return { path, store, debts, corrections, debt, payment };
}
const oldTables = [
  'facts',
  'intents',
  'corrections',
  'budgets',
  'budget_alerts',
  'event_delivery_config',
  'event_delivery_index',
  'event_acknowledgements',
  'financed_debts',
  'debt_payment_results',
  'debt_intents',
] as const;
function snapshot(db: DatabaseSync) {
  return oldTables.map((table) => ({
    table,
    rows: db
      .prepare(
        `SELECT ${table === 'debt_intents' ? 'instance_ref,subject_ref,intent_key,debt_id,payment_id,fingerprint,result_json' : '*'} FROM ${table} ORDER BY rowid`,
      )
      .all(),
  }));
}

test('debt correction migration: v5 payment identities, decisions and intent bytes preserved through rollback and v6', () => {
  const f = setup();
  const review = f.debts.confirmPayment(context, 'review', {
    debtId: f.debt.id,
    installmentNumber: 9,
    amount: '1',
    paidOn: '2026-11-15',
    reference: 'synthetic review',
  });
  f.store.close();
  const seed = new DatabaseSync(f.path, { readOnly: true });
  const original = snapshot(seed);
  seed.close();
  const path = pathFor(),
    v5 = new DatabaseSync(path);
  v5.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  for (const migration of [
    migration001,
    migration002,
    migration003,
    migration004,
    migration005,
  ]) {
    v5.exec(migration.sql);
    v5.prepare(
      'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
    ).run(
      migration.version,
      createHash('sha256').update(migration.sql).digest('hex'),
    );
  }
  for (const { table, rows } of original)
    for (const row of rows) {
      const columns = Object.keys(row);
      v5.prepare(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      ).run(...(Object.values(row) as SQLInputValue[]));
    }
  v5.exec(
    'PRAGMA application_id=1145520467; PRAGMA user_version=5; COMMIT; PRAGMA foreign_keys=ON',
  );
  assert.deepEqual(v5.prepare('PRAGMA foreign_key_check').all(), []);
  v5.close();
  const readonly = new SqliteExpenseStore(path, { readOnly: true });
  try {
    assert.deepEqual(
      new FinancedDebtService(readonly, policy).findIntent(context, 'payment'),
      f.payment,
    );
    assert.throws(
      () =>
        new DebtPaymentCorrectionsService(readonly, policy).getPaymentHistory(
          context,
          f.payment.id,
        ),
      { code: 'STORAGE_SCHEMA' },
    );
  } finally {
    readonly.close();
  }
  assert.throws(
    () =>
      new SqliteExpenseStore(path, {
        afterMigration: () => {
          throw new Error('synthetic migration failure');
        },
      }),
    { code: 'STORAGE_IO' },
  );
  const rollback = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      rollback.prepare('PRAGMA user_version').get()?.user_version,
      5,
    );
    assert.deepEqual(snapshot(rollback), original);
    assert.equal(
      rollback
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='debt_payment_corrections'",
        )
        .get(),
      undefined,
    );
  } finally {
    rollback.close();
  }
  const store = new SqliteExpenseStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7);
      assert.deepEqual(snapshot(db), original);
    } finally {
      db.close();
    }
    const api = new DebtPaymentCorrectionsService(store, policy, clock),
      debts = new FinancedDebtService(store, policy, clock);
    const result = api.replacePayment(context, 'correct', {
      paymentId: f.payment.id,
      reason: 'Synthetic amount correction',
      replacement,
    });
    assert.equal(result.status, 'applied');
    assert.equal(
      debts.getDebt(context, f.debt.id).estimatedBalance.minor,
      380000000n,
    );
    assert.deepEqual(debts.findIntent(context, 'payment'), f.payment);
    assert.deepEqual(debts.findIntent(context, 'review'), review);
  } finally {
    store.close();
  }
  const reopened = new SqliteExpenseStore(path);
  try {
    assert.equal(
      new FinancedDebtService(reopened, policy).monthlyCashOutflow(context, {
        month: '2026-11',
      }).total.minor,
      20000000n,
    );
  } finally {
    reopened.close();
  }
});

test('debt correction integrity: records immutable, scoped references and replacement linkage enforced', () => {
  const f = setup();
  f.corrections.voidPayment(context, 'void', {
    paymentId: f.payment.id,
    reason: 'Synthetic mistake',
  });
  f.store.close();
  const db = new DatabaseSync(f.path);
  try {
    for (const table of [
      'debt_payment_corrections',
      'debt_payment_actions',
      'debt_payment_results',
      'debt_intents',
    ])
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
    assert.throws(() =>
      db.exec("UPDATE debt_payment_corrections SET reason='changed'"),
    );
    const row = db.prepare('SELECT * FROM debt_payment_results LIMIT 1').get();
    assert.ok(row);
    for (const key of ['void', 'unbound']) {
      const clone = {
        ...row,
        sequence: null,
        id: 'hidden-payment',
        intent_key: key,
      };
      const columns = Object.keys(clone);
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO debt_payment_results(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...(Object.values(clone) as SQLInputValue[])),
      );
    }
    assert.throws(() =>
      db
        .prepare(
          'INSERT INTO debt_payment_actions(instance_ref,subject_ref,debt_id,payment_id) VALUES(?,?,?,?)',
        )
        .run(context.instanceRef, 'foreign', f.debt.id, f.payment.id),
    );
  } finally {
    db.close();
  }
  const reopened = new SqliteExpenseStore(f.path);
  reopened.close();
});

test('debt correction integrity: removed action and rewritten derived decision are rejected', () => {
  for (const corruption of ['missing-action', 'wrong-balance']) {
    const f = setup();
    f.corrections.replacePayment(context, 'correct', {
      paymentId: f.payment.id,
      reason: 'Synthetic error',
      replacement,
    });
    f.store.close();
    const db = new DatabaseSync(f.path);
    try {
      if (corruption === 'missing-action') {
        const trigger = db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='debt_payment_actions_no_delete'",
          )
          .get()?.sql;
        assert.equal(typeof trigger, 'string');
        db.exec('DROP TRIGGER debt_payment_actions_no_delete');
        db.exec(
          'DELETE FROM debt_payment_actions WHERE correction_id IS NOT NULL',
        );
        db.exec(trigger as string);
      } else {
        const first = db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='debt_payment_corrections_no_update'",
          )
          .get()?.sql;
        const second = db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='debt_intents_no_update'",
          )
          .get()?.sql;
        assert.equal(typeof first, 'string');
        assert.equal(typeof second, 'string');
        db.exec(
          'DROP TRIGGER debt_payment_corrections_no_update; DROP TRIGGER debt_intents_no_update',
        );
        db.exec(
          "UPDATE debt_payment_corrections SET estimated_balance_after='390000000'",
        );
        const json = db
          .prepare(
            "SELECT result_json FROM debt_intents WHERE intent_key='correct'",
          )
          .get()?.result_json;
        assert.equal(typeof json, 'string');
        const result = JSON.parse(json as string) as {
          estimatedBalanceAfter: { minor: string };
        };
        result.estimatedBalanceAfter.minor = '390000000';
        db.prepare(
          "UPDATE debt_intents SET result_json=? WHERE intent_key='correct'",
        ).run(JSON.stringify(result));
        db.exec(first as string);
        db.exec(second as string);
      }
    } finally {
      db.close();
    }
    assert.throws(() => new SqliteExpenseStore(f.path), {
      code: 'STORAGE_CORRUPT',
    });
  }
});
