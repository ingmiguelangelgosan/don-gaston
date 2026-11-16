import { migration010 } from './migrations/010-subscriptions.ts';
import { SqliteSubscriptions } from './sqlite-subscriptions.ts';
import type { SubscriptionFaults } from './sqlite-subscriptions.ts';
import type { SubscriptionStore } from '../application/subscription-store.ts';
import type {
  SubscriptionCommand,
  SubscriptionListQuery,
  SubscriptionReceivablesQuery,
} from '../domain/subscriptions.ts';
import { migration009 } from './migrations/009-personal-loans.ts';
import { SqlitePersonalLoans } from './sqlite-personal-loans.ts';
import type { LoanFaults } from './sqlite-personal-loans.ts';
import type { PersonalLoanStore } from '../application/personal-loan-store.ts';
import type {
  LoanCommand,
  LoanPositionQuery,
} from '../domain/personal-loans.ts';
import { migration008 } from './migrations/008-recurring-bills.ts';
import { SqliteRecurringBills } from './sqlite-recurring-bills.ts';
import type { BillFaults } from './sqlite-recurring-bills.ts';
import type { RecurringBillStore } from '../application/recurring-bill-store.ts';
import type { BillCommand, BillListQuery } from '../domain/recurring-bills.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExpenseStore,
  IntentResult,
  Scope,
} from '../application/expense-store.ts';
import { DomainError } from '../domain/errors.ts';
import {
  calendarDate,
  calendarMonth,
  categoryName,
  identifier,
} from '../domain/expenses.ts';
import type { Category, Expense } from '../domain/expenses.ts';
import type {
  ExpenseCorrection,
  ExpenseHistory,
} from '../domain/expense-corrections.ts';
import {
  correctionReason,
  correctionTime,
} from '../domain/expense-corrections.ts';
import type {
  CorrectionDraft,
  ExpenseCorrectionStore,
} from '../application/expense-correction-store.ts';
import { correctionFingerprint } from '../application/expense-corrections-service.ts';
import { Money } from '../domain/money.ts';
import { migration001 } from './migrations/001-expenses.ts';
import { migration002 } from './migrations/002-expense-corrections.ts';
import { migration003 } from './migrations/003-monthly-budgets.ts';
import { migration004 } from './migrations/004-event-delivery.ts';
import { migration005 } from './migrations/005-financed-debts.ts';
import { migration007 } from './migrations/007-salary-receivables.ts';
import { SqliteSalaryReceivables } from './sqlite-salary-receivables.ts';
import type { SalaryFaults } from './sqlite-salary-receivables.ts';
import type { SalaryStore } from '../application/salary-store.ts';
import type {
  SalaryVersionDraft,
  OpeningDraft,
  CloseDraft,
  SalaryPaymentDraft,
} from '../domain/salary-receivables.ts';
import { migration006 } from './migrations/006-debt-payment-corrections.ts';
import type { DebtPaymentCorrectionStore } from '../application/debt-payment-correction-store.ts';
import type { DebtPaymentCorrectionDraft } from '../domain/debt-payment-corrections.ts';
import { SqliteFinancedDebts } from './sqlite-financed-debts.ts';
import type { FinancedDebtStore } from '../application/financed-debt-store.ts';
import type {
  FinancedDebt,
  DebtPaymentDraft,
  DebtPaymentResult,
  DebtStatus,
} from '../domain/financed-debts.ts';
import { SqliteEventDelivery } from './sqlite-event-delivery.ts';
import type {
  EventDeliveryStore,
  PendingEventQuery,
} from '../application/event-delivery-store.ts';
import type {
  EventAcknowledgement,
  PendingEventPage,
} from '../domain/event-delivery.ts';
import type { MonthlyBudgetStore } from '../application/monthly-budget-store.ts';
import { budgetFingerprint } from '../application/monthly-budget-service.ts';
import { budgetThreshold } from '../domain/monthly-budgets.ts';
import type {
  MonthlyBudget,
  BudgetAlert,
  BudgetStatus,
} from '../domain/monthly-budgets.ts';
import { StorageError, storageError } from './sqlite-errors.ts';

export const SQLITE_LIMITS = Object.freeze({
  maxMinorDigits: 4096,
  maxResultBytes: 32768,
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxQueryRows: 10000,
});
const APPLICATION_ID = 0x44474153;
const checksum = createHash('sha256').update(migration001.sql).digest('hex');
const checksum002 = createHash('sha256').update(migration002.sql).digest('hex');
const checksum003 = createHash('sha256').update(migration003.sql).digest('hex');
const checksum004 = createHash('sha256').update(migration004.sql).digest('hex');
const checksum005 = createHash('sha256').update(migration005.sql).digest('hex');
const checksum006 = createHash('sha256').update(migration006.sql).digest('hex');
const checksum007 = createHash('sha256').update(migration007.sql).digest('hex');
const checksum008 = createHash('sha256').update(migration008.sql).digest('hex');
const checksum010 = createHash('sha256').update(migration010.sql).digest('hex');
const checksum009 = createHash('sha256').update(migration009.sql).digest('hex');
const schemaQuery =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";
function expectedSchema(version: number): string {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys=OFF');
    database.exec(migration001.sql);
    if (version >= 2) database.exec(migration002.sql);
    if (version >= 3) database.exec(migration003.sql);
    if (version >= 4) database.exec(migration004.sql);
    if (version >= 5) database.exec(migration005.sql);
    if (version >= 6) database.exec(migration006.sql);
    if (version >= 7) database.exec(migration007.sql);
    if (version >= 8) database.exec(migration008.sql);
    if (version >= 9) database.exec(migration009.sql);
    if (version >= 10) database.exec(migration010.sql);
    return JSON.stringify(database.prepare(schemaQuery).all());
  } finally {
    database.close();
  }
}
const schemas = [
  undefined,
  expectedSchema(1),
  expectedSchema(2),
  expectedSchema(3),
  expectedSchema(4),
  expectedSchema(5),
  expectedSchema(6),
  expectedSchema(7),
  expectedSchema(8),
  expectedSchema(9),
  expectedSchema(10),
];
const joined = `SELECT f.*, i.fingerprint, i.result_json FROM facts f
  JOIN intents i ON i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref
    AND i.intent_key=f.intent_key AND i.fact_id=f.id`;
const joined002 = `SELECT f.*, COALESCE(c.replacement_fingerprint,i.fingerprint) AS fingerprint,
  COALESCE(c.replacement_json,i.result_json) AS result_json FROM facts f
  JOIN intents i ON i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref
    AND i.intent_key=f.intent_key AND i.fact_id=f.id
  LEFT JOIN corrections c ON c.instance_ref=i.instance_ref AND c.subject_ref=i.subject_ref AND c.id=i.correction_id`;
const correctionsJoined = `SELECT c.*, i.fingerprint, i.result_json, i.fact_id AS intent_fact_id
  FROM corrections c JOIN intents i ON i.instance_ref=c.instance_ref AND i.subject_ref=c.subject_ref
    AND i.intent_key=c.intent_key AND i.correction_id=c.id`;
const budgetsJoined = `SELECT b.*, i.fingerprint, i.result_json FROM budgets b
  JOIN intents i ON i.instance_ref=b.instance_ref AND i.subject_ref=b.subject_ref
  AND i.intent_key=b.intent_key AND i.budget_id=b.id`;

interface Options
  extends SalaryFaults, BillFaults, LoanFaults, SubscriptionFaults {
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
  /** Synthetic fault injection only. No production callbacks inside a transaction. */
  readonly afterFactInsert?: () => void;
  readonly afterCorrectionInsert?: () => void;
  readonly afterMigration?: () => void;
  readonly afterBudgetInsert?: () => void;
  readonly afterAlertInsert?: () => void;
  readonly afterAcknowledgementInsert?: () => void;
  readonly afterAcknowledgementCommit?: () => void;
  readonly afterDebtInsert?: () => void;
  readonly afterDebtPaymentInsert?: () => void;
  readonly afterDebtCommit?: () => void;
  readonly afterDebtCorrectionInsert?: () => void;
}
type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function hash(result: Category | Expense): string {
  const fields =
    result.kind === 'category'
      ? ['category:v1', result.name]
      : [
          'expense:v1',
          result.amount.minor.toString(),
          result.amount.currency,
          result.categoryId,
          result.occurredOn,
        ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function serialize(result: Category | Expense): string {
  // Fixed order is also checked at rehydration; this is a versioned internal format.
  return result.kind === 'category'
    ? JSON.stringify({
        kind: result.kind,
        id: result.id,
        name: result.name,
        actorRef: result.actorRef,
      })
    : JSON.stringify({
        kind: result.kind,
        id: result.id,
        categoryId: result.categoryId,
        amount: result.amount.toJSON(),
        occurredOn: result.occurredOn,
        actorRef: result.actorRef,
      });
}
function rehydrate(row: Row): Category | Expense {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.intent_key));
    const id = identifier(text(row.id));
    const actorRef = identifier(text(row.actor_ref));
    let result: Category | Expense;
    if (row.kind === 'category') {
      const name = categoryName(text(row.name));
      if (name !== row.name) throw new StorageError('STORAGE_CORRUPT');
      result = Object.freeze({ kind: 'category', id, name, actorRef });
    } else if (row.kind === 'expense') {
      const minor = text(row.amount_minor);
      if (
        minor.length > SQLITE_LIMITS.maxMinorDigits ||
        !/^[1-9][0-9]*$/.test(minor) ||
        minor.trim() !== minor
      )
        throw new StorageError('STORAGE_CORRUPT');
      const amount = Money.fromMinor(BigInt(minor), text(row.currency));
      result = Object.freeze({
        kind: 'expense',
        id,
        actorRef,
        amount,
        categoryId: identifier(text(row.category_id)),
        occurredOn: calendarDate(text(row.occurred_on)),
      });
    } else throw new StorageError('STORAGE_CORRUPT');
    if (
      hash(result) !== row.fingerprint ||
      serialize(result) !== row.result_json
    )
      throw new StorageError('STORAGE_CORRUPT');
    return result;
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}
function serializeCorrection(result: ExpenseCorrection): string {
  return JSON.stringify({
    kind: result.kind,
    id: result.id,
    originalExpenseId: result.originalExpenseId,
    replacement: result.replacement
      ? (JSON.parse(serialize(result.replacement)) as unknown)
      : null,
    reason: result.reason,
    recordedAt: result.recordedAt,
    actorRef: result.actorRef,
  });
}
function serializeBudget(result: MonthlyBudget): string {
  return JSON.stringify({
    kind: result.kind,
    id: result.id,
    categoryId: result.categoryId,
    month: result.month,
    amount: result.amount.toJSON(),
    actorRef: result.actorRef,
  });
}
function rehydrateBudget(row: Row): MonthlyBudget {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.intent_key));
    const minor = text(row.amount_minor);
    if (
      !/^(0|[1-9][0-9]*)$/.test(minor) ||
      minor.length > SQLITE_LIMITS.maxMinorDigits
    )
      throw new StorageError('STORAGE_CORRUPT');
    const result: MonthlyBudget = Object.freeze({
      kind: 'budget',
      id: identifier(text(row.id)),
      categoryId: identifier(text(row.category_id)),
      month: calendarMonth(text(row.month)),
      amount: Money.fromMinor(BigInt(minor), text(row.currency)),
      actorRef: identifier(text(row.actor_ref)),
    });
    if (
      serializeBudget(result) !== row.result_json ||
      budgetFingerprint(result) !== row.fingerprint
    )
      throw new StorageError('STORAGE_CORRUPT');
    return result;
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}
function localPath(path: string): string {
  // Composition is trusted and local. Reject SQLite URI/in-memory and network paths.
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    path === ':memory:' ||
    /^file:/i.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
    throw new StorageError('STORAGE_IO');
  const absolute = resolve(path);
  if (!isAbsolute(absolute)) throw new StorageError('STORAGE_IO');
  if (
    existsSync(absolute) &&
    (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile())
  )
    throw new StorageError('STORAGE_IO');
  return absolute;
}
function reserve(path: string): void {
  // No overwrite, including existing empty files. Mode is effective on POSIX;
  // Windows access control remains a deployment responsibility.
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
}

/** Local synthetic adapter. No identity authentication or external connection. */
export class SqliteExpenseStore
  implements
    ExpenseStore,
    ExpenseCorrectionStore,
    MonthlyBudgetStore,
    EventDeliveryStore,
    FinancedDebtStore,
    DebtPaymentCorrectionStore,
    SalaryStore,
    RecurringBillStore,
    PersonalLoanStore,
    SubscriptionStore
{
  readonly #db: DatabaseSync;
  readonly #options: Options;
  #closed = false;
  #writing = false;
  #version = 1;
  get #joined(): string {
    return this.#version === 1 ? joined : joined002;
  }

  constructor(path: string, options: Options = {}) {
    const timeout = options.busyTimeoutMs ?? 1000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 5000)
      throw new StorageError('STORAGE_LIMIT');
    this.#options = Object.freeze({ ...options });
    let database: DatabaseSync | undefined;
    try {
      const absolute = localPath(path);
      if (!existsSync(absolute) && !options.readOnly) {
        try {
          reserve(absolute);
        } catch (error) {
          // Another process may have created the same new DB concurrently.
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        }
      }
      if (statSync(absolute).size > SQLITE_LIMITS.maxDatabaseBytes)
        throw new StorageError('STORAGE_LIMIT');
      database = new DatabaseSync(absolute, {
        readOnly: options.readOnly ?? false,
        timeout,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        defensive: true,
      });
      this.#db = database;
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');
      if (!options.readOnly) this.#migrate();
      this.#version = Number(
        database.prepare('PRAGMA user_version').get()?.user_version,
      );
      this.#verify();
      if (!options.readOnly) {
        const pageSize = Number(
          database.prepare('PRAGMA page_size').get()?.page_size,
        );
        database.exec(
          `PRAGMA max_page_count=${Math.floor(SQLITE_LIMITS.maxDatabaseBytes / pageSize)}`,
        );
        const mode = database
          .prepare('PRAGMA journal_mode=DELETE')
          .get()?.journal_mode;
        if (mode !== 'delete') throw new StorageError('STORAGE_SCHEMA');
      }
      if (
        database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
        database.prepare('PRAGMA synchronous').get()?.synchronous !== 2
      )
        throw new StorageError('STORAGE_SCHEMA');
    } catch (error) {
      database?.close();
      throw storageError(error);
    }
  }

  #migrate(): void {
    this.#db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db
        .prepare('PRAGMA user_version')
        .get()?.user_version;
      if (version === 0) {
        const existing = this.#db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
          )
          .all();
        const appId = this.#db
          .prepare('PRAGMA application_id')
          .get()?.application_id;
        if (existing.length || (appId !== 0 && appId !== APPLICATION_ID))
          throw new StorageError('STORAGE_SCHEMA');
        this.#db.exec(migration001.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(1, checksum);
        this.#db.exec(
          `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`,
        );
      } else if (
        version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5 &&
        version !== 6 &&
        version !== 7 &&
        version !== 8 &&
        version !== 9 &&
        version !== 10
      )
        throw new StorageError('STORAGE_SCHEMA');
      this.#version = version === 0 ? 1 : Number(version);
      // Reject corrupted/foreign v1 before changing its schema or data.
      this.#verify();
      if (this.#version === 1) {
        this.#db.exec(migration002.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(2, checksum002);
        this.#db.exec('PRAGMA user_version=2');
        this.#version = 2;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 2) {
        this.#db.exec(migration003.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(3, checksum003);
        this.#db.exec('PRAGMA user_version=3');
        this.#version = 3;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 3) {
        this.#db.exec(migration004.sql);
        this.#db
          .prepare(
            'INSERT INTO event_delivery_config(singleton,cursor_key) VALUES(1,?)',
          )
          .run(randomBytes(32).toString('hex'));
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(4, checksum004);
        this.#db.exec('PRAGMA user_version=4');
        this.#version = 4;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 4) {
        this.#db.exec(migration005.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(5, checksum005);
        this.#db.exec('PRAGMA user_version=5');
        this.#version = 5;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 5) {
        this.#db.exec(migration006.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(6, checksum006);
        this.#db.exec('PRAGMA user_version=6');
        this.#version = 6;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 6) {
        this.#db.exec(migration007.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(7, checksum007);
        this.#db.exec('PRAGMA user_version=7');
        this.#version = 7;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 7) {
        this.#db.exec(migration008.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(8, checksum008);
        this.#db.exec('PRAGMA user_version=8');
        this.#version = 8;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 8) {
        this.#db.exec(migration009.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(9, checksum009);
        this.#db.exec('PRAGMA user_version=9');
        this.#version = 9;
        this.#options.afterMigration?.();
        this.#verify();
      }
      if (this.#version === 9) {
        this.#db.exec(migration010.sql);
        this.#db
          .prepare(
            'INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',
          )
          .run(10, checksum010);
        this.#db.exec('PRAGMA user_version=10');
        this.#version = 10;
        this.#options.afterMigration?.();
        this.#verify();
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#db.exec('PRAGMA foreign_keys=ON');
    }
  }

  #verify(): void {
    if (
      this.#db.prepare('PRAGMA application_id').get()?.application_id !==
        APPLICATION_ID ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(this.#version) ||
      this.#db.prepare('PRAGMA user_version').get()?.user_version !==
        this.#version
    )
      throw new StorageError('STORAGE_SCHEMA');
    if (
      JSON.stringify(this.#db.prepare(schemaQuery).all()) !==
      schemas[this.#version]
    )
      throw new StorageError('STORAGE_SCHEMA');
    const migrations = this.#db
      .prepare(
        'SELECT version,checksum FROM schema_migrations ORDER BY version',
      )
      .all();
    if (
      migrations.length !== this.#version ||
      migrations[0]?.version !== 1 ||
      migrations[0]?.checksum !== checksum ||
      (this.#version >= 2 &&
        (migrations[1]?.version !== 2 ||
          migrations[1]?.checksum !== checksum002)) ||
      (this.#version >= 3 &&
        (migrations[2]?.version !== 3 ||
          migrations[2]?.checksum !== checksum003)) ||
      (this.#version >= 4 &&
        (migrations[3]?.version !== 4 ||
          migrations[3]?.checksum !== checksum004)) ||
      (this.#version >= 5 &&
        (migrations[4]?.version !== 5 ||
          migrations[4]?.checksum !== checksum005)) ||
      (this.#version >= 6 &&
        (migrations[5]?.version !== 6 ||
          migrations[5]?.checksum !== checksum006)) ||
      (this.#version >= 7 &&
        (migrations[6]?.version !== 7 ||
          migrations[6]?.checksum !== checksum007)) ||
      (this.#version >= 8 &&
        (migrations[7]?.version !== 8 ||
          migrations[7]?.checksum !== checksum008)) ||
      (this.#version >= 9 &&
        (migrations[8]?.version !== 9 ||
          migrations[8]?.checksum !== checksum009)) ||
      (this.#version >= 10 &&
        (migrations[9]?.version !== 10 ||
          migrations[9]?.checksum !== checksum010))
    )
      throw new StorageError('STORAGE_SCHEMA');
    if (
      this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      this.#db.prepare('PRAGMA foreign_key_check').all().length ||
      this.#db
        .prepare(
          `SELECT 1 FROM facts f WHERE NOT EXISTS (
        SELECT 1 FROM intents i WHERE i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref
          AND i.intent_key=f.intent_key AND i.fact_id=f.id) LIMIT 1`,
        )
        .get()
    )
      throw new StorageError('STORAGE_CORRUPT');
    for (const row of this.#db.prepare(this.#joined).iterate()) rehydrate(row);
    if (this.#version >= 2)
      for (const row of this.#db.prepare(correctionsJoined).iterate())
        this.#rehydrateCorrection(row);
    if (this.#version >= 3) {
      for (const row of this.#db.prepare(budgetsJoined).iterate())
        rehydrateBudget(row);
      for (const row of this.#db
        .prepare('SELECT * FROM budget_alerts')
        .iterate())
        this.#rehydrateAlert(row);
    }
    if (this.#version >= 4) new SqliteEventDelivery(this.#db).verify();
    if (this.#version >= 5)
      new SqliteFinancedDebts(this.#db, this.#version).verify();
    if (this.#version >= 7) new SqliteSalaryReceivables(this.#db).verify();
    if (this.#version >= 8) new SqliteRecurringBills(this.#db).verify();
    if (this.#version >= 9) new SqlitePersonalLoans(this.#db).verify();
    if (this.#version >= 10) new SqliteSubscriptions(this.#db).verify();
  }

  #run<T>(operation: () => T): T {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED');
    try {
      return operation();
    } catch (error) {
      throw storageError(error);
    }
  }

  #readSnapshot<T>(operation: () => T): T {
    if (this.#db.isTransaction) return operation();
    this.#db.exec('BEGIN');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #commit<T extends Category | Expense>(
    scope: Scope,
    key: string,
    fingerprint: string,
    result: T,
  ): T {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      identifier(scope.instanceRef);
      identifier(scope.subjectRef);
      identifier(key);
      const json = serialize(result);
      if (
        Buffer.byteLength(json) > SQLITE_LIMITS.maxResultBytes ||
        fingerprint.length > SQLITE_LIMITS.maxResultBytes ||
        (result.kind === 'expense' &&
          result.amount.minor.toString().length > SQLITE_LIMITS.maxMinorDigits)
      )
        throw new StorageError('STORAGE_LIMIT');
      if (fingerprint !== hash(result))
        throw new StorageError('STORAGE_CORRUPT');
      // Validate and detach even internal callers' objects before writing.
      const validated = rehydrate({
        instance_ref: scope.instanceRef,
        subject_ref: scope.subjectRef,
        intent_key: key,
        id: result.id,
        kind: result.kind,
        actor_ref: result.actorRef,
        name: result.kind === 'category' ? result.name : null,
        amount_minor:
          result.kind === 'expense' ? result.amount.minor.toString() : null,
        currency: result.kind === 'expense' ? result.amount.currency : null,
        category_id: result.kind === 'expense' ? result.categoryId : null,
        occurred_on: result.kind === 'expense' ? result.occurredOn : null,
        fingerprint,
        result_json: json,
      }) as T;
      result = validated;
      this.#db.exec('BEGIN IMMEDIATE');
      this.#writing = true;
      try {
        const previous = this.findIntent(scope, key);
        if (previous) {
          if (
            (previous.kind !== 'category' && previous.kind !== 'expense') ||
            hash(previous) !== fingerprint ||
            previous.kind !== result.kind
          )
            throw new DomainError('IDEMPOTENCY_CONFLICT');
          this.#db.exec('COMMIT');
          return previous as T;
        }
        if (
          result.kind === 'expense' &&
          !this.getCategory(scope, result.categoryId)
        )
          throw new DomainError('CATEGORY_NOT_FOUND');
        this.#db
          .prepare(
            `INSERT INTO facts(instance_ref,subject_ref,id,intent_key,kind,actor_ref,name,
          category_id,category_kind,amount_minor,currency,occurred_on) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            result.id,
            key,
            result.kind,
            result.actorRef,
            result.kind === 'category' ? result.name : null,
            result.kind === 'expense' ? result.categoryId : null,
            result.kind === 'expense' ? 'category' : null,
            result.kind === 'expense' ? result.amount.minor.toString() : null,
            result.kind === 'expense' ? result.amount.currency : null,
            result.kind === 'expense' ? result.occurredOn : null,
          );
        this.#options.afterFactInsert?.();
        this.#db
          .prepare(
            `INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            key,
            result.id,
            fingerprint,
            json,
          );
        if (result.kind === 'expense')
          this.#evaluateBudget(
            scope,
            result.categoryId,
            result.occurredOn.slice(0, 7),
            key,
          );
        this.#db.exec('COMMIT');
        return Object.freeze(result);
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
        throw error;
      } finally {
        this.#writing = false;
      }
    });
  }

  createCategory(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Category, 'id'>,
  ): Category {
    return this.#commit(scope, key, fingerprint, {
      ...draft,
      id: randomUUID(),
    });
  }
  recordExpense(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Expense, 'id'>,
  ): Expense {
    return this.#commit(scope, key, fingerprint, {
      ...draft,
      id: randomUUID(),
    });
  }
  findIntent(scope: Scope, key: string): IntentResult | undefined {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version >= 10) {
          const subscription = new SqliteSubscriptions(this.#db).findIntent(
            scope,
            key,
          );
          if (subscription) return subscription;
        }
        if (this.#version >= 9) {
          const loan = new SqlitePersonalLoans(this.#db).findIntent(scope, key);
          if (loan) return loan;
        }
        if (this.#version >= 8) {
          const bill = new SqliteRecurringBills(this.#db).findIntent(
            scope,
            key,
          );
          if (bill) return bill;
        }
        if (this.#version >= 7) {
          const salary = new SqliteSalaryReceivables(this.#db).findIntent(
            scope,
            key,
          );
          if (salary) return salary;
        }
        if (this.#version >= 5) {
          const debt = new SqliteFinancedDebts(
            this.#db,
            this.#version,
          ).findIntent(scope, key);
          if (debt) return debt;
        }
        if (this.#version >= 3) {
          const budget = this.#db
            .prepare(
              `${budgetsJoined} WHERE b.instance_ref=? AND b.subject_ref=? AND b.intent_key=?`,
            )
            .get(scope.instanceRef, scope.subjectRef, key);
          if (budget) return rehydrateBudget(budget);
        }
        if (this.#version >= 2) {
          const correction = this.#db
            .prepare(
              `${correctionsJoined} WHERE c.instance_ref=? AND c.subject_ref=? AND c.intent_key=?`,
            )
            .get(scope.instanceRef, scope.subjectRef, key);
          if (correction) return this.#rehydrateCorrection(correction);
        }
        const row = this.#db
          .prepare(
            `${this.#joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.intent_key=?`,
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        return row ? rehydrate(row) : undefined;
      }),
    );
  }
  getCategory(scope: Scope, id: string): Category | undefined {
    return this.#run(() => {
      const row = this.#db
        .prepare(
          `${this.#joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.id=? AND f.kind='category'`,
        )
        .get(scope.instanceRef, scope.subjectRef, id);
      return row ? (rehydrate(row) as Category) : undefined;
    });
  }
  listExpenses(scope: Scope): readonly Expense[] {
    return this.#run(() => {
      const rows = this.#db
        .prepare(
          `${this.#joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.kind='expense'
          ${this.#version >= 2 ? 'AND NOT EXISTS (SELECT 1 FROM corrections x WHERE x.instance_ref=f.instance_ref AND x.subject_ref=f.subject_ref AND x.original_expense_id=f.id)' : ''}
          ORDER BY f.id LIMIT ?`,
        )
        .all(
          scope.instanceRef,
          scope.subjectRef,
          SQLITE_LIMITS.maxQueryRows + 1,
        );
      if (rows.length > SQLITE_LIMITS.maxQueryRows)
        throw new StorageError('STORAGE_LIMIT');
      return Object.freeze(rows.map((row) => rehydrate(row) as Expense));
    });
  }

  #getExpense(scope: Scope, id: string): Expense | undefined {
    const row = this.#db
      .prepare(
        `${this.#joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.id=? AND f.kind='expense'`,
      )
      .get(scope.instanceRef, scope.subjectRef, id);
    return row ? (rehydrate(row) as Expense) : undefined;
  }

  #rehydrateCorrection(row: Row): ExpenseCorrection {
    try {
      const scope = {
        instanceRef: identifier(text(row.instance_ref)),
        subjectRef: identifier(text(row.subject_ref)),
      };
      const reason = correctionReason(text(row.reason));
      const replacement =
        row.replacement_expense_id === null
          ? null
          : this.#getExpense(
              scope,
              identifier(text(row.replacement_expense_id)),
            );
      if (
        reason !== row.reason ||
        replacement === undefined ||
        row.intent_fact_id !== row.replacement_expense_id ||
        (replacement &&
          (replacement.actorRef !== row.actor_ref ||
            serialize(replacement) !== row.replacement_json ||
            hash(replacement) !== row.replacement_fingerprint))
      )
        throw new StorageError('STORAGE_CORRUPT');
      const result: ExpenseCorrection = Object.freeze({
        kind: 'correction',
        id: identifier(text(row.id)),
        originalExpenseId: identifier(text(row.original_expense_id)),
        replacement,
        reason,
        recordedAt: correctionTime(text(row.recorded_at)),
        actorRef: identifier(text(row.actor_ref)),
      });
      if (
        result.originalExpenseId === replacement?.id ||
        correctionFingerprint(result) !== row.fingerprint ||
        serializeCorrection(result) !== row.result_json
      )
        throw new StorageError('STORAGE_CORRUPT');
      return result;
    } catch {
      throw new StorageError('STORAGE_CORRUPT');
    }
  }

  correctExpense(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: CorrectionDraft,
  ): ExpenseCorrection {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 2) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      identifier(scope.instanceRef);
      identifier(scope.subjectRef);
      identifier(key);
      const originalExpenseId = identifier(draft.originalExpenseId);
      const actorRef = identifier(draft.actorRef);
      const reason = correctionReason(draft.reason);
      if (reason !== draft.reason) throw new StorageError('STORAGE_CORRUPT');
      const recordedAt = correctionTime(draft.recordedAt);
      let replacement: Expense | null = null;
      if (draft.replacement) {
        const candidate: Expense = { ...draft.replacement, id: randomUUID() };
        if (
          candidate.amount.minor.toString().length >
          SQLITE_LIMITS.maxMinorDigits
        )
          throw new StorageError('STORAGE_LIMIT');
        replacement = rehydrate({
          instance_ref: scope.instanceRef,
          subject_ref: scope.subjectRef,
          intent_key: key,
          id: candidate.id,
          actor_ref: candidate.actorRef,
          kind: candidate.kind,
          category_id: candidate.categoryId,
          amount_minor: candidate.amount.minor.toString(),
          currency: candidate.amount.currency,
          occurred_on: candidate.occurredOn,
          fingerprint: hash(candidate),
          result_json: serialize(candidate),
        }) as Expense;
        if (replacement.actorRef !== actorRef)
          throw new StorageError('STORAGE_CORRUPT');
      }
      const result: ExpenseCorrection = Object.freeze({
        kind: 'correction',
        id: randomUUID(),
        originalExpenseId,
        replacement,
        reason,
        recordedAt,
        actorRef,
      });
      const json = serializeCorrection(result);
      if (Buffer.byteLength(json) > SQLITE_LIMITS.maxResultBytes)
        throw new StorageError('STORAGE_LIMIT');
      if (fingerprint !== correctionFingerprint(result))
        throw new StorageError('STORAGE_CORRUPT');
      this.#db.exec('BEGIN IMMEDIATE');
      this.#writing = true;
      try {
        const prior = this.findIntent(scope, key);
        if (prior) {
          if (
            prior.kind !== 'correction' ||
            correctionFingerprint(prior) !== fingerprint
          )
            throw new DomainError('IDEMPOTENCY_CONFLICT');
          this.#db.exec('COMMIT');
          return prior;
        }
        const original = this.#getExpense(scope, originalExpenseId);
        if (!original) throw new DomainError('EXPENSE_NOT_FOUND');
        if (
          this.#version >= 8 &&
          this.#db
            .prepare(
              'SELECT 1 FROM bill_payments WHERE instance_ref=? AND subject_ref=? AND id=?',
            )
            .get(scope.instanceRef, scope.subjectRef, originalExpenseId)
        )
          throw new DomainError('BILL_PAYMENT_CORRECTION_REQUIRED');
        if (
          this.#version >= 10 &&
          this.#db
            .prepare(
              'SELECT 1 FROM subscription_records WHERE instance_ref=? AND subject_ref=? AND expense_id=?',
            )
            .get(scope.instanceRef, scope.subjectRef, originalExpenseId)
        )
          throw new DomainError('SUBSCRIPTION_PAYMENT_CORRECTION_REQUIRED');

        if (
          this.#db
            .prepare(
              'SELECT id FROM corrections WHERE instance_ref=? AND subject_ref=? AND original_expense_id=?',
            )
            .get(scope.instanceRef, scope.subjectRef, originalExpenseId)
        )
          throw new DomainError('EXPENSE_ALREADY_CORRECTED');
        if (replacement && !this.getCategory(scope, replacement.categoryId))
          throw new DomainError('CATEGORY_NOT_FOUND');
        this.#db
          .prepare(
            `INSERT INTO corrections(instance_ref,subject_ref,id,intent_key,original_expense_id,
          replacement_expense_id,replacement_kind,replacement_json,replacement_fingerprint,reason,recorded_at,actor_ref)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            result.id,
            key,
            originalExpenseId,
            replacement?.id ?? null,
            replacement ? 'expense' : null,
            replacement ? serialize(replacement) : null,
            replacement ? hash(replacement) : null,
            reason,
            recordedAt,
            actorRef,
          );
        this.#options.afterCorrectionInsert?.();
        if (replacement) {
          this.#db
            .prepare(
              `INSERT INTO facts(instance_ref,subject_ref,id,intent_key,kind,actor_ref,category_id,
            category_kind,amount_minor,currency,occurred_on) VALUES(?,?,?,?,'expense',?,?,'category',?,?,?)`,
            )
            .run(
              scope.instanceRef,
              scope.subjectRef,
              replacement.id,
              key,
              actorRef,
              replacement.categoryId,
              replacement.amount.minor.toString(),
              replacement.amount.currency,
              replacement.occurredOn,
            );
          this.#options.afterFactInsert?.();
        }
        this.#db
          .prepare(
            `INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,correction_id,fingerprint,result_json)
          VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            key,
            replacement?.id ?? null,
            result.id,
            fingerprint,
            json,
          );
        this.#evaluateBudget(
          scope,
          original.categoryId,
          original.occurredOn.slice(0, 7),
          key,
        );
        if (replacement)
          this.#evaluateBudget(
            scope,
            replacement.categoryId,
            replacement.occurredOn.slice(0, 7),
            key,
          );
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
        throw error;
      } finally {
        this.#writing = false;
      }
    });
  }

  getExpenseHistory(scope: Scope, expenseId: string): ExpenseHistory {
    return this.#run(() => {
      identifier(scope.instanceRef);
      identifier(scope.subjectRef);
      identifier(expenseId);
      // One read snapshot for the expense and its two audit links.
      this.#db.exec('BEGIN');
      try {
        const expense = this.#getExpense(scope, expenseId);
        if (!expense) throw new DomainError('EXPENSE_NOT_FOUND');
        const outgoing =
          this.#version >= 2
            ? this.#db
                .prepare(
                  `${correctionsJoined}
          WHERE c.instance_ref=? AND c.subject_ref=? AND c.original_expense_id=?`,
                )
                .get(scope.instanceRef, scope.subjectRef, expenseId)
            : undefined;
        const incoming =
          this.#version >= 2
            ? this.#db
                .prepare(
                  `${correctionsJoined}
          WHERE c.instance_ref=? AND c.subject_ref=? AND c.replacement_expense_id=?`,
                )
                .get(scope.instanceRef, scope.subjectRef, expenseId)
            : undefined;
        const correctedBy = outgoing
          ? this.#rehydrateCorrection(outgoing)
          : null;
        const replaces = incoming ? this.#rehydrateCorrection(incoming) : null;
        const status = correctedBy
          ? correctedBy.replacement
            ? 'replaced'
            : 'voided'
          : 'active';
        this.#db.exec('COMMIT');
        return Object.freeze({ expense, status, correctedBy, replaces });
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  #budget(
    scope: Scope,
    categoryId: string,
    month: string,
  ): MonthlyBudget | null {
    if (this.#version < 3) return null;
    const row = this.#db
      .prepare(
        `${budgetsJoined} WHERE b.instance_ref=? AND b.subject_ref=?
      AND b.category_id=? AND b.month=? ORDER BY b.sequence DESC LIMIT 1`,
      )
      .get(scope.instanceRef, scope.subjectRef, categoryId, month);
    return row ? rehydrateBudget(row) : null;
  }

  #consumed(scope: Scope, categoryId: string, month: string): Money {
    const rows = this.#db
      .prepare(
        `${this.#joined} WHERE f.instance_ref=? AND f.subject_ref=?
      AND f.kind='expense' AND f.category_id=? AND substr(f.occurred_on,1,7)=?
      ${this.#version >= 2 ? 'AND NOT EXISTS (SELECT 1 FROM corrections x WHERE x.instance_ref=f.instance_ref AND x.subject_ref=f.subject_ref AND x.original_expense_id=f.id)' : ''}
      LIMIT ?`,
      )
      .all(
        scope.instanceRef,
        scope.subjectRef,
        categoryId,
        month,
        SQLITE_LIMITS.maxQueryRows + 1,
      );
    if (rows.length > SQLITE_LIMITS.maxQueryRows)
      throw new StorageError('STORAGE_LIMIT');
    let total = 0n;
    for (const row of rows) total += (rehydrate(row) as Expense).amount.minor;
    return Money.fromMinor(total);
  }

  #rehydrateAlert(row: Row): BudgetAlert {
    try {
      const scope = {
        instanceRef: identifier(text(row.instance_ref)),
        subjectRef: identifier(text(row.subject_ref)),
      };
      const categoryId = identifier(text(row.category_id));
      const month = calendarMonth(text(row.month));
      const budgetId = identifier(text(row.budget_id));
      const minor = text(row.consumed_minor);
      if (
        !/^[1-9][0-9]*$/.test(minor) ||
        minor.length > 4101 ||
        (row.threshold !== 80 && row.threshold !== 100)
      )
        throw new StorageError('STORAGE_CORRUPT');
      const budgetRow = this.#db
        .prepare(
          `${budgetsJoined} WHERE b.instance_ref=? AND b.subject_ref=? AND b.id=?`,
        )
        .get(scope.instanceRef, scope.subjectRef, budgetId);
      if (!budgetRow) throw new StorageError('STORAGE_CORRUPT');
      const budget = rehydrateBudget(budgetRow);
      const consumed = Money.fromMinor(BigInt(minor));
      if (
        budget.categoryId !== categoryId ||
        budget.month !== month ||
        budgetThreshold(budget.amount, consumed) !== row.threshold
      )
        throw new StorageError('STORAGE_CORRUPT');
      return Object.freeze({
        id: identifier(text(row.id)),
        categoryId,
        month,
        threshold: row.threshold,
        budgetId,
        consumed,
        triggerIntentKey: identifier(text(row.trigger_intent_key)),
      });
    } catch {
      throw new StorageError('STORAGE_CORRUPT');
    }
  }

  #alerts(
    scope: Scope,
    categoryId: string,
    month: string,
  ): readonly BudgetAlert[] {
    if (this.#version < 3) return Object.freeze([]);
    const rows = this.#db
      .prepare(
        `SELECT * FROM budget_alerts WHERE instance_ref=? AND subject_ref=?
      AND category_id=? AND month=? ORDER BY threshold`,
      )
      .all(scope.instanceRef, scope.subjectRef, categoryId, month);
    return Object.freeze(rows.map((row) => this.#rehydrateAlert(row)));
  }

  #evaluateBudget(
    scope: Scope,
    categoryId: string,
    month: string,
    key: string,
  ): void {
    const budget = this.#budget(scope, categoryId, month);
    if (!budget) return;
    const consumed = this.#consumed(scope, categoryId, month);
    const threshold = budgetThreshold(budget.amount, consumed);
    if (threshold === null) return;
    const alerts = this.#alerts(scope, categoryId, month);
    if (
      alerts.some(
        (alert) => alert.threshold === 100 || alert.threshold === threshold,
      )
    )
      return;
    this.#db
      .prepare(
        `INSERT INTO budget_alerts(instance_ref,subject_ref,id,category_id,month,threshold,budget_id,consumed_minor,trigger_intent_key)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.instanceRef,
        scope.subjectRef,
        randomUUID(),
        categoryId,
        month,
        threshold,
        budget.id,
        consumed.minor.toString(),
        key,
      );
    this.#options.afterAlertInsert?.();
  }

  setBudget(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<MonthlyBudget, 'id'>,
  ): MonthlyBudget {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 3) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      identifier(scope.instanceRef);
      identifier(scope.subjectRef);
      identifier(key);
      const candidate: MonthlyBudget = { ...draft, id: randomUUID() };
      const json = serializeBudget(candidate);
      if (
        candidate.amount.minor.toString().length >
          SQLITE_LIMITS.maxMinorDigits ||
        Buffer.byteLength(json) > SQLITE_LIMITS.maxResultBytes
      )
        throw new StorageError('STORAGE_LIMIT');
      const result = rehydrateBudget({
        instance_ref: scope.instanceRef,
        subject_ref: scope.subjectRef,
        intent_key: key,
        id: candidate.id,
        category_id: candidate.categoryId,
        month: candidate.month,
        amount_minor: candidate.amount.minor.toString(),
        currency: candidate.amount.currency,
        actor_ref: candidate.actorRef,
        fingerprint,
        result_json: json,
      });
      this.#db.exec('BEGIN IMMEDIATE');
      this.#writing = true;
      try {
        const prior = this.findIntent(scope, key);
        if (prior) {
          if (
            prior.kind !== 'budget' ||
            budgetFingerprint(prior) !== fingerprint
          )
            throw new DomainError('IDEMPOTENCY_CONFLICT');
          this.#db.exec('COMMIT');
          return prior;
        }
        if (!this.getCategory(scope, result.categoryId))
          throw new DomainError('CATEGORY_NOT_FOUND');
        this.#db
          .prepare(
            `INSERT INTO budgets(instance_ref,subject_ref,id,intent_key,category_id,month,amount_minor,currency,actor_ref)
          VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            result.id,
            key,
            result.categoryId,
            result.month,
            result.amount.minor.toString(),
            result.amount.currency,
            result.actorRef,
          );
        this.#options.afterBudgetInsert?.();
        this.#db
          .prepare(
            `INSERT INTO intents(instance_ref,subject_ref,intent_key,budget_id,fingerprint,result_json)
          VALUES(?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            key,
            result.id,
            fingerprint,
            json,
          );
        this.#evaluateBudget(scope, result.categoryId, result.month, key);
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
        throw error;
      } finally {
        this.#writing = false;
      }
    });
  }

  getBudgetStatus(
    scope: Scope,
    categoryId: string,
    month: string,
  ): BudgetStatus {
    return this.#run(() =>
      this.#readSnapshot(() => {
        identifier(scope.instanceRef);
        identifier(scope.subjectRef);
        identifier(categoryId);
        calendarMonth(month);
        if (!this.getCategory(scope, categoryId))
          throw new DomainError('CATEGORY_NOT_FOUND');
        const budget = this.#budget(scope, categoryId, month);
        const consumed = this.#consumed(scope, categoryId, month);
        const percentage =
          budget && budget.amount.minor !== 0n
            ? Object.freeze({
                numerator: consumed.minor * 100n,
                denominator: budget.amount.minor,
              })
            : null;
        return Object.freeze({
          month,
          categoryId,
          budget,
          consumed,
          percentage,
          alerts: this.#alerts(scope, categoryId, month),
        });
      }),
    );
  }

  listPending(scope: Scope, query: PendingEventQuery): PendingEventPage {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 4) throw new StorageError('STORAGE_SCHEMA');
        return new SqliteEventDelivery(this.#db).listPending(scope, query);
      }),
    );
  }

  acknowledge(
    scope: Scope,
    eventId: string,
    actorRef: string,
    processedAt: string,
  ): EventAcknowledgement {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 4) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return new SqliteEventDelivery(this.#db).acknowledge(
          scope,
          eventId,
          actorRef,
          processedAt,
          this.#options,
        );
      } finally {
        this.#writing = false;
      }
    });
  }

  #debtWrite<T>(operation: (module: SqliteFinancedDebts) => T): T {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 5) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return operation(new SqliteFinancedDebts(this.#db, this.#version));
      } finally {
        this.#writing = false;
      }
    });
  }

  registerDebt(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<FinancedDebt, 'id'>,
  ): FinancedDebt {
    return this.#debtWrite((module) =>
      module.registerDebt(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }

  confirmPayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: DebtPaymentDraft,
  ): DebtPaymentResult {
    return this.#debtWrite((module) =>
      module.confirmPayment(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }

  getDebt(scope: Scope, debtId: string): DebtStatus {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 5) throw new StorageError('STORAGE_SCHEMA');
        return new SqliteFinancedDebts(this.#db, this.#version).getDebt(
          scope,
          debtId,
        );
      }),
    );
  }

  monthlyCashOutflow(scope: Scope, month: string) {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 5) throw new StorageError('STORAGE_SCHEMA');
        return new SqliteFinancedDebts(
          this.#db,
          this.#version,
        ).monthlyCashOutflow(scope, month);
      }),
    );
  }

  correctPayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: DebtPaymentCorrectionDraft,
  ) {
    return this.#debtWrite((module) => {
      if (this.#version < 6) throw new StorageError('STORAGE_SCHEMA');
      return module.correctPayment(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      );
    });
  }
  getPaymentHistory(scope: Scope, paymentId: string) {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 6) throw new StorageError('STORAGE_SCHEMA');
        return new SqliteFinancedDebts(
          this.#db,
          this.#version,
        ).getPaymentHistory(scope, paymentId);
      }),
    );
  }

  #salaryWrite<T>(operation: (module: SqliteSalaryReceivables) => T): T {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 7) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return operation(new SqliteSalaryReceivables(this.#db));
      } finally {
        this.#writing = false;
      }
    });
  }
  #salaryRead<T>(operation: (module: SqliteSalaryReceivables) => T): T {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 7) throw new StorageError('STORAGE_SCHEMA');
        return operation(new SqliteSalaryReceivables(this.#db));
      }),
    );
  }
  configureSalary(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: SalaryVersionDraft,
  ) {
    return this.#salaryWrite((module) =>
      module.configureSalary(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }
  importPendingPeriod(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: OpeningDraft,
  ) {
    return this.#salaryWrite((module) =>
      module.importPendingPeriod(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }
  closePeriod(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: CloseDraft,
  ) {
    return this.#salaryWrite((module) =>
      module.closePeriod(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }
  receivePayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: SalaryPaymentDraft,
  ) {
    return this.#salaryWrite((module) =>
      module.receivePayment(
        scope,
        key,
        fingerprint,
        draft,
        (bound, intent) => this.findIntent(bound, intent),
        this.#options,
      ),
    );
  }
  getReceivables(scope: Scope, asOf: string) {
    return this.#salaryRead((module) => module.getReceivables(scope, asOf));
  }
  getPayment(scope: Scope, id: string) {
    return this.#salaryRead((module) => module.getPayment(scope, id));
  }
  monthlyCashInflow(scope: Scope, month: string) {
    return this.#salaryRead((module) => module.monthlyCashInflow(scope, month));
  }

  #recordBillExpense(
    scope: Scope,
    expense: Expense,
    key: string,
    subscription = false,
  ): void {
    // Called inside the owning transaction. Expense is a consumption projection of the payment ID.
    this.#db
      .prepare(
        `INSERT INTO facts(instance_ref,subject_ref,id,intent_key,kind,actor_ref,category_id,category_kind,amount_minor,currency,occurred_on)
      VALUES(?,?,?,?,'expense',?,?,'category',?,'COP',?)`,
      )
      .run(
        scope.instanceRef,
        scope.subjectRef,
        expense.id,
        key,
        expense.actorRef,
        expense.categoryId,
        expense.amount.minor.toString(),
        expense.occurredOn,
      );
    if (subscription) this.#options.afterSubscriptionExpenseInsert?.();
    else this.#options.afterBillExpenseInsert?.();
    this.#db
      .prepare(
        'INSERT INTO intents(instance_ref,subject_ref,intent_key,fact_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        scope.instanceRef,
        scope.subjectRef,
        key,
        expense.id,
        hash(expense),
        serialize(expense),
      );
    this.#evaluateBudget(
      scope,
      expense.categoryId,
      expense.occurredOn.slice(0, 7),
      key,
    );
  }
  executeBill(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: BillCommand,
  ) {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 8) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return new SqliteRecurringBills(this.#db).executeBill(
          scope,
          key,
          fingerprint,
          command,
          (bound, intent) => this.findIntent(bound, intent),
          (bound, expense, intent) =>
            this.#recordBillExpense(bound, expense, intent),
          this.#options,
        );
      } finally {
        this.#writing = false;
      }
    });
  }
  #billRead<T>(operation: (module: SqliteRecurringBills) => T): T {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 8) throw new StorageError('STORAGE_SCHEMA');
        return operation(new SqliteRecurringBills(this.#db));
      }),
    );
  }
  getObligation(scope: Scope, id: string, asOf: string) {
    return this.#billRead((module) => module.getObligation(scope, id, asOf));
  }
  listObligations(scope: Scope, query: BillListQuery) {
    return this.#billRead((module) => module.listObligations(scope, query));
  }
  monthlyBillCashOutflow(scope: Scope, month: string) {
    return this.#billRead((module) =>
      module.monthlyBillCashOutflow(scope, month),
    );
  }

  executeLoan(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: LoanCommand,
  ) {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 9) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return new SqlitePersonalLoans(this.#db).executeLoan(
          scope,
          key,
          fingerprint,
          command,
          (bound, intent) => this.findIntent(bound, intent),
          this.#options,
        );
      } finally {
        this.#writing = false;
      }
    });
  }
  #loanRead<T>(operation: (module: SqlitePersonalLoans) => T): T {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 9) throw new StorageError('STORAGE_SCHEMA');
        return operation(new SqlitePersonalLoans(this.#db));
      }),
    );
  }
  getLoanPosition(scope: Scope, query: LoanPositionQuery) {
    return this.#loanRead((module) => module.getLoanPosition(scope, query));
  }
  listLoanPositions(scope: Scope, query: { readonly asOf: string }) {
    return this.#loanRead((module) => module.listLoanPositions(scope, query));
  }
  monthlyLoanCashFlow(scope: Scope, month: string) {
    return this.#loanRead((module) => module.monthlyLoanCashFlow(scope, month));
  }

  executeSubscription(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: SubscriptionCommand,
  ) {
    return this.#run(() => {
      if (this.#options.readOnly) throw new StorageError('STORAGE_READ_ONLY');
      if (this.#version < 10) throw new StorageError('STORAGE_SCHEMA');
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      this.#writing = true;
      try {
        return new SqliteSubscriptions(this.#db).executeSubscription(
          scope,
          key,
          fingerprint,
          command,
          (bound, intent) => this.findIntent(bound, intent),
          (bound, expense, intent) =>
            this.#recordBillExpense(bound, expense, intent, true),
          this.#options,
        );
      } finally {
        this.#writing = false;
      }
    });
  }
  #subscriptionRead<T>(operation: (module: SqliteSubscriptions) => T): T {
    return this.#run(() =>
      this.#readSnapshot(() => {
        if (this.#version < 10) throw new StorageError('STORAGE_SCHEMA');
        return operation(new SqliteSubscriptions(this.#db));
      }),
    );
  }
  getSubscriptionObligation(scope: Scope, id: string, asOf: string) {
    return this.#subscriptionRead((module) =>
      module.getSubscriptionObligation(scope, id, asOf),
    );
  }
  listSubscriptionObligations(scope: Scope, query: SubscriptionListQuery) {
    return this.#subscriptionRead((module) =>
      module.listSubscriptionObligations(scope, query),
    );
  }
  getSubscriptionReceivables(
    scope: Scope,
    query: SubscriptionReceivablesQuery,
  ) {
    return this.#subscriptionRead((module) =>
      module.getSubscriptionReceivables(scope, query),
    );
  }
  monthlySubscriptionCashFlow(scope: Scope, month: string) {
    return this.#subscriptionRead((module) =>
      module.monthlySubscriptionCashFlow(scope, month),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#run(() => {
      this.#db.close();
      this.#closed = true;
    });
  }
  backupTo(destination: string): void {
    this.#run(() => {
      if (this.#writing) throw new StorageError('STORAGE_BUSY');
      const target = localPath(destination);
      reserve(target);
      this.#db.prepare('VACUUM INTO ?').run(target);
      // Verify the snapshot itself before reporting success. Failed outputs are
      // retained for diagnosis, never overwritten or automatically deleted.
      const snapshot = new SqliteExpenseStore(target, { readOnly: true });
      snapshot.close();
    });
  }
  static restoreBackup(source: string, destination: string): void {
    const snapshot = new SqliteExpenseStore(source, { readOnly: true });
    try {
      snapshot.backupTo(destination);
    } finally {
      snapshot.close();
    }
  }
}
