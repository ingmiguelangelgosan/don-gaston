import { closeSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageError, storageError } from '../infrastructure/sqlite-errors.ts';
import { DomainError } from '../domain/errors.ts';

const applicationId = 0x44474a31;
const schema = `
CREATE TABLE demo_requests (
  intent_key TEXT PRIMARY KEY CHECK(length(intent_key)=68 AND substr(intent_key,1,4)='jg1-' AND substr(intent_key,5) NOT GLOB '*[^0-9a-f]*'),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER demo_requests_no_update BEFORE UPDATE ON demo_requests BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER demo_requests_no_delete BEFORE DELETE ON demo_requests BEGIN SELECT RAISE(ABORT,'append_only'); END;`;
const schemaQuery =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";
function expectedSchema(): string {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    return JSON.stringify(db.prepare(schemaQuery).all());
  } finally {
    db.close();
  }
}
const expected = expectedSchema();
/** Synthetic adapter metadata, not a financial ledger or Jarvis state database.
 * Reserve before touching finance. Reopen MUST use create:false (the default).
 * No cross-database atomicity is promised: reservations can outlive failed writes.
 */
export class DemoRequestJournal {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(
    path: string,
    options: {
      readonly create?: boolean;
      readonly busyTimeoutMs?: number;
    } = {},
  ) {
    let db: DatabaseSync | undefined;
    try {
      if (!isAbsolute(path) || path.includes('\0'))
        throw new StorageError('STORAGE_PATH');
      const timeout = options.busyTimeoutMs ?? 1000;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 5000)
        throw new StorageError('STORAGE_CONFIGURATION');
      if (options.create === true) closeSync(openSync(path, 'wx', 0o600));
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8 * 1024 * 1024
      )
        throw new StorageError('STORAGE_CORRUPT');
      db = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        allowExtension: false,
      });
      db.enableDefensive(true);
      db.exec(
        `PRAGMA busy_timeout=${timeout}; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=2048;`,
      );
      this.#db = db;
      if (options.create === true) {
        db.exec('BEGIN IMMEDIATE');
        db.exec(schema);
        db.exec(
          `PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT;`,
        );
      }
      this.#verify();
    } catch (error) {
      if (db?.isTransaction) db.exec('ROLLBACK');
      db?.close();
      throw storageError(error);
    }
  }
  #verify(): void {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED');
    if (
      this.#db.prepare('PRAGMA application_id').get()?.application_id !==
        applicationId ||
      this.#db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      JSON.stringify(this.#db.prepare(schemaQuery).all()) !== expected
    )
      throw new StorageError('STORAGE_SCHEMA');
    if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new StorageError('STORAGE_CORRUPT');
  }
  #run<T>(operation: () => T): T {
    try {
      this.#verify();
      return operation();
    } catch (error) {
      throw storageError(error);
    }
  }
  has(key: string): boolean {
    return this.#run(() =>
      Boolean(
        this.#db
          .prepare('SELECT 1 FROM demo_requests WHERE intent_key=?')
          .get(key),
      ),
    );
  }
  reserve(
    key: string,
    fingerprint: string,
    financialResultExists = false,
  ): void {
    this.#run(() => {
      if (
        !/^jg1-[0-9a-f]{64}$/.test(key) ||
        !/^[0-9a-f]{64}$/.test(fingerprint)
      )
        throw new DomainError('INVALID_INTENT');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const prior = this.#db
          .prepare('SELECT fingerprint FROM demo_requests WHERE intent_key=?')
          .get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new DomainError('IDEMPOTENCY_CONFLICT');
        } else {
          if (financialResultExists) throw new StorageError('STORAGE_CORRUPT');
          if (
            Number(
              this.#db
                .prepare('SELECT count(*) AS total FROM demo_requests')
                .get()?.total,
            ) >= 10000
          )
            throw new StorageError('STORAGE_LIMIT');
          this.#db
            .prepare(
              'INSERT INTO demo_requests(intent_key,fingerprint) VALUES(?,?)',
            )
            .run(key, fingerprint);
        }
        this.#db.exec('COMMIT');
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
