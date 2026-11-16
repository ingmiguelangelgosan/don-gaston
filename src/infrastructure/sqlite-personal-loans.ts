import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntentResult, Scope } from '../application/expense-store.ts';
import { loanFingerprint } from '../application/personal-loan-service.ts';
import { DomainError } from '../domain/errors.ts';
import { identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  validateLoanCommand,
  decideLoanCommand,
  buildLoanPosition,
  buildLoanPositions,
  buildLoanCashFlow,
} from '../domain/personal-loans.ts';
import type {
  LoanCommand,
  LoanState,
  LoanCounterparty,
  LoanMovement,
  LoanResult,
  LoanPositionQuery,
} from '../domain/personal-loans.ts';
import { StorageError } from './sqlite-errors.ts';

type Row = Record<string, unknown>;
export interface LoanFaults {
  readonly afterLoanCounterpartyInsert?: () => void;
  readonly afterLoanMovementInsert?: () => void;
  readonly afterLoanCommit?: () => void;
}
interface Ledger extends LoanState {
  counterparties: LoanCounterparty[];
  movements: LoanMovement[];
  results: Map<string, LoanResult>;
}
const maxRows = 10000;
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function decodeCommand(operation: unknown, json: unknown): LoanCommand {
  const draft = JSON.parse(text(json)) as Record<string, unknown>;
  if (operation !== 'counterparty') {
    const raw = draft.amount as { minor: unknown; currency: unknown };
    const minor = text(raw?.minor);
    if (minor.length > 4096 || !/^[1-9][0-9]*$/.test(minor)) throw new Error();
    draft.amount = Money.fromMinor(BigInt(minor), text(raw.currency));
  }
  const command = validateLoanCommand({ operation, draft } as LoanCommand);
  if (JSON.stringify(command.draft) !== json) throw new Error();
  return command;
}
function shape(result: LoanResult): {
  table: string;
  column: string;
  fields: Record<string, string | null>;
} {
  if (result.kind === 'loan-counterparty')
    return {
      table: 'loan_counterparties',
      column: 'counterparty_id',
      fields: { name: result.name },
    };
  return {
    table: 'loan_movements',
    column: 'movement_id',
    fields: {
      counterparty_id: result.counterpartyId,
      direction: result.direction,
      movement_type: result.movementType,
      amount_minor: result.amount.minor.toString(),
      currency: result.amount.currency,
      occurred_on: result.occurredOn,
      status: result.status,
      review_reason: result.reviewReason,
      cash_direction: result.cashDirection,
    },
  };
}
function bounded(rows: Row[]): Row[] {
  if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
  return rows;
}
export class SqlitePersonalLoans {
  readonly #db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#db = database;
  }
  #ledger(scope: Scope): Ledger {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    const rows = bounded(
      this.#db
        .prepare(
          'SELECT * FROM loan_intents WHERE instance_ref=? AND subject_ref=? ORDER BY sequence LIMIT ?',
        )
        .all(scope.instanceRef, scope.subjectRef, maxRows + 1),
    );
    const ledger: Ledger = {
      counterparties: [],
      movements: [],
      results: new Map(),
    };
    try {
      for (const row of rows) {
        const key = identifier(text(row.intent_key)),
          id = identifier(text(row.counterparty_id ?? row.movement_id));
        const command = decodeCommand(row.operation, row.draft_json);
        if (loanFingerprint(command) !== row.fingerprint) throw new Error();
        const result = decideLoanCommand(ledger, command, id);
        if (JSON.stringify(result) !== row.result_json) throw new Error();
        const record = shape(result);
        if (
          row.counterparty_id !==
            (result.kind === 'loan-counterparty' ? id : null) ||
          row.movement_id !== (result.kind === 'loan-movement' ? id : null)
        )
          throw new Error();
        const saved = this.#db
          .prepare(
            `SELECT * FROM ${record.table} WHERE instance_ref=? AND subject_ref=? AND id=?`,
          )
          .get(scope.instanceRef, scope.subjectRef, id);
        if (
          !saved ||
          saved.intent_key !== key ||
          Object.entries(record.fields).some(
            ([field, value]) => saved[field] !== value,
          )
        )
          throw new Error();
        ledger.results.set(key, result);
        if (result.kind === 'loan-counterparty')
          ledger.counterparties.push(result);
        else ledger.movements.push(result);
      }
      for (const [table, count] of [
        ['loan_counterparties', ledger.counterparties.length],
        ['loan_movements', ledger.movements.length],
      ] as const) {
        if (
          this.#db
            .prepare(
              `SELECT count(*) AS total FROM ${table} WHERE instance_ref=? AND subject_ref=?`,
            )
            .get(scope.instanceRef, scope.subjectRef)?.total !== count
        )
          throw new Error();
      }
      const overlaps = [
        'intents',
        'debt_intents',
        'salary_intents',
        'bill_intents',
      ]
        .map(
          (table) =>
            `EXISTS(SELECT 1 FROM ${table} i WHERE i.instance_ref=l.instance_ref AND i.subject_ref=l.subject_ref AND i.intent_key=l.intent_key)`,
        )
        .join(' OR ');
      if (
        this.#db
          .prepare(
            `SELECT 1 FROM loan_intents l WHERE l.instance_ref=? AND l.subject_ref=? AND (${overlaps}) LIMIT 1`,
          )
          .get(scope.instanceRef, scope.subjectRef)
      )
        throw new Error();
      return ledger;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('STORAGE_CORRUPT');
    }
  }
  verify(): void {
    for (const row of bounded(
      this.#db
        .prepare(
          'SELECT DISTINCT instance_ref,subject_ref FROM loan_intents LIMIT ?',
        )
        .all(maxRows + 1),
    ))
      this.#ledger({
        instanceRef: text(row.instance_ref),
        subjectRef: text(row.subject_ref),
      });
  }
  findIntent(scope: Scope, key: string): LoanResult | undefined {
    return this.#ledger(scope).results.get(key);
  }
  executeLoan(
    scope: Scope,
    key: string,
    fingerprint: string,
    input: LoanCommand,
    lookup: (scope: Scope, key: string) => IntentResult | undefined,
    faults: LoanFaults,
  ): LoanResult {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const command = validateLoanCommand(input),
      draftJson = JSON.stringify(command.draft);
    if (
      Buffer.byteLength(draftJson) > 32768 ||
      Object.values(command.draft).some(
        (value) =>
          value instanceof Money && value.minor.toString().length > 4096,
      )
    )
      throw new StorageError('STORAGE_LIMIT');
    if (loanFingerprint(command) !== fingerprint)
      throw new DomainError('INVALID_INTENT');
    if (this.#db.isTransaction) throw new StorageError('STORAGE_BUSY');
    this.#db.exec('BEGIN IMMEDIATE');
    let result: LoanResult;
    try {
      const previous = lookup(scope, key);
      if (previous) {
        const saved = this.#db
          .prepare(
            'SELECT fingerprint FROM loan_intents WHERE instance_ref=? AND subject_ref=? AND intent_key=?',
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        if (
          !saved ||
          saved.fingerprint !== fingerprint ||
          (previous.kind !== 'loan-counterparty' &&
            previous.kind !== 'loan-movement')
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return previous;
      }
      const ledger = this.#ledger(scope);
      if (ledger.results.size >= maxRows)
        throw new StorageError('STORAGE_LIMIT');
      result = decideLoanCommand(ledger, command, randomUUID());
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json) > 32768)
        throw new StorageError('STORAGE_LIMIT');
      const record = shape(result);
      this.#db
        .prepare(
          `INSERT INTO ${record.table}(instance_ref,subject_ref,id,intent_key,${Object.keys(record.fields).join(',')}) VALUES(?,?,?,?${',?'.repeat(Object.keys(record.fields).length)})`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          ...Object.values(record.fields),
        );
      if (result.kind === 'loan-counterparty')
        faults.afterLoanCounterpartyInsert?.();
      else faults.afterLoanMovementInsert?.();
      this.#db
        .prepare(
          `INSERT INTO loan_intents(instance_ref,subject_ref,intent_key,operation,${record.column},fingerprint,draft_json,result_json) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          key,
          command.operation,
          result.id,
          fingerprint,
          draftJson,
          json,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    faults.afterLoanCommit?.();
    return result;
  }
  getLoanPosition(scope: Scope, query: LoanPositionQuery) {
    return buildLoanPosition(this.#ledger(scope), query);
  }
  listLoanPositions(scope: Scope, query: { readonly asOf: string }) {
    return buildLoanPositions(this.#ledger(scope), query);
  }
  monthlyLoanCashFlow(scope: Scope, month: string) {
    return buildLoanCashFlow(this.#ledger(scope), month);
  }
}
