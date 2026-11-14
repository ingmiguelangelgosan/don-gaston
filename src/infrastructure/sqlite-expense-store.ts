import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExpenseStore,
  IntentResult,
  Scope,
} from '../application/expense-store.ts';
import { DomainError } from '../domain/errors.ts';
import { calendarDate, categoryName, identifier } from '../domain/expenses.ts';
import type { Category, Expense } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import { migration001 } from './migrations/001-expenses.ts';
import { StorageError, storageError } from './sqlite-errors.ts';

export const SQLITE_LIMITS = Object.freeze({
  maxMinorDigits: 4096,
  maxResultBytes: 32768,
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxQueryRows: 10000,
});
const APPLICATION_ID = 0x44474153;
const checksum = createHash('sha256').update(migration001.sql).digest('hex');
const schemaQuery =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";
function expectedSchema(): string {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(migration001.sql);
    return JSON.stringify(database.prepare(schemaQuery).all());
  } finally {
    database.close();
  }
}
const schema = expectedSchema();
const joined = `SELECT f.*, i.fingerprint, i.result_json FROM facts f
  JOIN intents i ON i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref
    AND i.intent_key=f.intent_key AND i.fact_id=f.id`;

interface Options {
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
  /** Synthetic fault injection only. No production callbacks inside a transaction. */
  readonly afterFactInsert?: () => void;
}
type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function hash(result: IntentResult): string {
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
function serialize(result: IntentResult): string {
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
function rehydrate(row: Row): IntentResult {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.intent_key));
    const id = identifier(text(row.id));
    const actorRef = identifier(text(row.actor_ref));
    let result: IntentResult;
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
export class SqliteExpenseStore implements ExpenseStore {
  readonly #db: DatabaseSync;
  readonly #options: Options;
  #closed = false;
  #writing = false;

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
    this.#db.exec('BEGIN IMMEDIATE');
    try {
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
      } else if (version !== 1) throw new StorageError('STORAGE_SCHEMA');
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #verify(): void {
    if (
      this.#db.prepare('PRAGMA application_id').get()?.application_id !==
        APPLICATION_ID ||
      this.#db.prepare('PRAGMA user_version').get()?.user_version !== 1
    )
      throw new StorageError('STORAGE_SCHEMA');
    if (JSON.stringify(this.#db.prepare(schemaQuery).all()) !== schema)
      throw new StorageError('STORAGE_SCHEMA');
    const migrations = this.#db
      .prepare('SELECT version,checksum FROM schema_migrations')
      .all();
    if (
      migrations.length !== 1 ||
      migrations[0]?.version !== 1 ||
      migrations[0]?.checksum !== checksum
    )
      throw new StorageError('STORAGE_SCHEMA');
    if (
      this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      this.#db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new StorageError('STORAGE_CORRUPT');
    for (const row of this.#db.prepare(joined).iterate()) rehydrate(row);
  }

  #run<T>(operation: () => T): T {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED');
    try {
      return operation();
    } catch (error) {
      throw storageError(error);
    }
  }

  #commit<T extends IntentResult>(
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
        const previous = this.#db
          .prepare(
            `${joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.intent_key=?`,
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        if (previous) {
          const original = rehydrate(previous);
          if (
            previous.fingerprint !== fingerprint ||
            original.kind !== result.kind
          )
            throw new DomainError('IDEMPOTENCY_CONFLICT');
          this.#db.exec('COMMIT');
          return original as T;
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
    return this.#run(() => {
      const row = this.#db
        .prepare(
          `${joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.intent_key=?`,
        )
        .get(scope.instanceRef, scope.subjectRef, key);
      return row ? rehydrate(row) : undefined;
    });
  }
  getCategory(scope: Scope, id: string): Category | undefined {
    return this.#run(() => {
      const row = this.#db
        .prepare(
          `${joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.id=? AND f.kind='category'`,
        )
        .get(scope.instanceRef, scope.subjectRef, id);
      return row ? (rehydrate(row) as Category) : undefined;
    });
  }
  listExpenses(scope: Scope): readonly Expense[] {
    return this.#run(() => {
      const rows = this.#db
        .prepare(
          `${joined} WHERE f.instance_ref=? AND f.subject_ref=? AND f.kind='expense' ORDER BY f.id LIMIT ?`,
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
