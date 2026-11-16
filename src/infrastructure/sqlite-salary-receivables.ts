import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntentResult, Scope } from '../application/expense-store.ts';
import {
  salaryVersionFingerprint,
  openingPeriodFingerprint,
  closePeriodFingerprint,
  salaryPaymentFingerprint,
} from '../application/salary-service.ts';
import { DomainError } from '../domain/errors.ts';
import { calendarDate, calendarMonth, identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  validateSalaryVersionDraft,
  validateOpeningDraft,
  validateCloseDraft,
  validateSalaryPaymentDraft,
  decideSalaryCommand,
  buildSalaryReceivables,
} from '../domain/salary-receivables.ts';
import type {
  SalaryCommand,
  SalaryState,
  SalaryVersionDraft,
  OpeningDraft,
  CloseDraft,
  SalaryPaymentDraft,
  SalaryVersion,
  SalaryPeriod,
  SalaryReceipt,
  SalaryAllocation,
  SalaryPeriodAllocation,
  SalaryPaymentDetail,
} from '../domain/salary-receivables.ts';
import { StorageError } from './sqlite-errors.ts';

type Result = SalaryVersion | SalaryPeriod | SalaryReceipt;
type Row = Record<string, unknown>;
type Lookup = (scope: Scope, key: string) => IntentResult | undefined;
export interface SalaryFaults {
  readonly afterSalaryVersionInsert?: () => void;
  readonly afterSalaryPeriodInsert?: () => void;
  readonly afterSalaryPaymentInsert?: () => void;
  readonly afterSalaryAllocationInsert?: () => void;
  readonly afterSalaryCommit?: () => void;
}
interface Ledger extends SalaryState {
  versions: SalaryVersion[];
  periods: SalaryPeriod[];
  payments: SalaryReceipt[];
  allocations: SalaryAllocation[];
  results: Map<string, Result>;
}
const maxRows = 10000;
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function decodeMoney(value: unknown): Money {
  if (!value || typeof value !== 'object') throw new Error();
  const money = value as { minor: unknown; currency: unknown };
  const minor = text(money.minor);
  if (minor.length > 4096 || !/^[1-9][0-9]*$/.test(minor)) throw new Error();
  return Money.fromMinor(BigInt(minor), text(money.currency));
}
function decodeCommand(operation: unknown, json: unknown): SalaryCommand {
  const raw = JSON.parse(text(json)) as Record<string, unknown>;
  let command: SalaryCommand;
  switch (operation) {
    case 'configure':
      command = {
        operation,
        draft: validateSalaryVersionDraft({
          ...raw,
          netAmount: decodeMoney(raw.netAmount),
        } as unknown as SalaryVersionDraft),
      };
      break;
    case 'opening':
      command = {
        operation,
        draft: validateOpeningDraft({
          ...raw,
          amount: decodeMoney(raw.amount),
        } as unknown as OpeningDraft),
      };
      break;
    case 'close':
      command = {
        operation,
        draft: validateCloseDraft(raw as unknown as CloseDraft),
      };
      break;
    case 'receive':
      command = {
        operation,
        draft: validateSalaryPaymentDraft({
          ...raw,
          amount: decodeMoney(raw.amount),
        } as unknown as SalaryPaymentDraft),
      };
      break;
    default:
      throw new Error();
  }
  if (JSON.stringify(command.draft) !== json) throw new Error();
  return command;
}
function fingerprint(command: SalaryCommand): string {
  switch (command.operation) {
    case 'configure':
      return salaryVersionFingerprint(command.draft);
    case 'opening':
      return openingPeriodFingerprint(command.draft);
    case 'close':
      return closePeriodFingerprint(command.draft);
    case 'receive':
      return salaryPaymentFingerprint(command.draft);
  }
}
function record(result: Result): {
  table: string;
  fields: Record<string, string | number | null>;
} {
  switch (result.kind) {
    case 'salary-version':
      return {
        table: 'salary_versions',
        fields: {
          amount_minor: result.netAmount.minor.toString(),
          effective_from: result.effectiveFrom,
          due_day: result.dueDay,
        },
      };
    case 'salary-period':
      return {
        table: 'salary_periods',
        fields: {
          amount_minor: result.amount.minor.toString(),
          month: result.month,
          source: result.source,
          version_id: result.salaryVersionId,
          available_on: result.availableOn,
          due_on: result.dueOn,
        },
      };
    case 'salary-payment':
      return {
        table: 'salary_payments',
        fields: {
          amount_minor: result.amount.minor.toString(),
          received_on: result.receivedOn,
          status: result.status,
        },
      };
  }
}
function add(
  ledger: Ledger,
  result: Result,
  allocations: readonly SalaryPeriodAllocation[],
  key: string,
): void {
  ledger.results.set(key, result);
  if (result.kind === 'salary-version') ledger.versions.push(result);
  else if (result.kind === 'salary-period') ledger.periods.push(result);
  else {
    ledger.payments.push(result);
    ledger.allocations.push(
      ...allocations.map((allocation) =>
        Object.freeze({
          paymentId: result.id,
          periodId: allocation.periodId,
          amount: allocation.amount,
        }),
      ),
    );
  }
}
function bounded(rows: Row[]): Row[] {
  if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
  return rows;
}
export class SqliteSalaryReceivables {
  readonly #db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#db = database;
  }
  #ledger(scope: Scope): Ledger {
    const rows = bounded(
      this.#db
        .prepare(
          'SELECT * FROM salary_intents WHERE instance_ref=? AND subject_ref=? ORDER BY sequence LIMIT ?',
        )
        .all(scope.instanceRef, scope.subjectRef, maxRows + 1),
    );
    const allocations = bounded(
      this.#db
        .prepare(
          'SELECT * FROM salary_allocations WHERE instance_ref=? AND subject_ref=? ORDER BY payment_id,ordinal LIMIT ?',
        )
        .all(scope.instanceRef, scope.subjectRef, maxRows + 1),
    );
    const ledger: Ledger = {
      versions: [],
      periods: [],
      payments: [],
      allocations: [],
      results: new Map(),
    };
    try {
      identifier(scope.instanceRef);
      identifier(scope.subjectRef);
      const byPayment = new Map<string, Row[]>();
      for (const allocation of allocations) {
        const id = text(allocation.payment_id);
        const group = byPayment.get(id) ?? [];
        group.push(allocation);
        byPayment.set(id, group);
      }
      for (const row of rows) {
        const key = identifier(text(row.intent_key));
        const command = decodeCommand(row.operation, row.draft_json);
        if (fingerprint(command) !== row.fingerprint) throw new Error();
        const id = identifier(
          text(row.version_id ?? row.period_id ?? row.payment_id),
        );
        const decision = decideSalaryCommand(ledger, command, id);
        const result = Object.freeze(decision.result);
        if (JSON.stringify(result) !== row.result_json) throw new Error();
        if (
          row.version_id !==
            (result.kind === 'salary-version' ? result.id : null) ||
          row.period_id !==
            (result.kind === 'salary-period' ? result.id : null) ||
          row.payment_id !==
            (result.kind === 'salary-payment' ? result.id : null)
        )
          throw new Error();
        const shape = record(result);
        const fact = this.#db
          .prepare(
            `SELECT * FROM ${shape.table} WHERE instance_ref=? AND subject_ref=? AND id=?`,
          )
          .get(scope.instanceRef, scope.subjectRef, id);
        if (
          !fact ||
          fact.intent_key !== key ||
          Object.entries(shape.fields).some(
            ([name, value]) => fact[name] !== value,
          )
        )
          throw new Error();
        const saved = byPayment.get(id) ?? [];
        if (
          saved.length !== decision.allocations.length ||
          saved.some((allocation, index) => {
            const expected = decision.allocations[index];
            return (
              !expected ||
              allocation.ordinal !== index ||
              allocation.period_id !== expected.periodId ||
              allocation.amount_minor !== expected.amount.minor.toString()
            );
          })
        )
          throw new Error();
        byPayment.delete(id);
        add(ledger, result, decision.allocations, key);
      }
      if (byPayment.size !== 0) throw new Error();
      for (const [table, count] of [
        ['salary_versions', ledger.versions.length],
        ['salary_periods', ledger.periods.length],
        ['salary_payments', ledger.payments.length],
      ] as const) {
        const stored = this.#db
          .prepare(
            `SELECT count(*) AS total FROM ${table} WHERE instance_ref=? AND subject_ref=?`,
          )
          .get(scope.instanceRef, scope.subjectRef)?.total;
        if (stored !== count) throw new Error();
      }
      if (
        this.#db
          .prepare(
            `SELECT 1 FROM salary_intents s WHERE s.instance_ref=? AND s.subject_ref=? AND (
        EXISTS(SELECT 1 FROM intents i WHERE i.instance_ref=s.instance_ref AND i.subject_ref=s.subject_ref AND i.intent_key=s.intent_key) OR
        EXISTS(SELECT 1 FROM debt_intents i WHERE i.instance_ref=s.instance_ref AND i.subject_ref=s.subject_ref AND i.intent_key=s.intent_key)) LIMIT 1`,
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
    const scopes = bounded(
      this.#db
        .prepare(
          'SELECT DISTINCT instance_ref,subject_ref FROM salary_intents LIMIT ?',
        )
        .all(maxRows + 1),
    );
    for (const scope of scopes)
      this.#ledger({
        instanceRef: text(scope.instance_ref),
        subjectRef: text(scope.subject_ref),
      });
  }
  findIntent(scope: Scope, key: string): Result | undefined {
    return this.#ledger(scope).results.get(key);
  }
  #write(
    scope: Scope,
    key: string,
    hash: string,
    command: SalaryCommand,
    lookup: Lookup,
    faults: SalaryFaults,
  ): Result {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const draftJson = JSON.stringify(command.draft);
    if (
      Buffer.byteLength(draftJson) > 32768 ||
      ('amount' in command.draft &&
        command.draft.amount.minor.toString().length > 4096) ||
      ('netAmount' in command.draft &&
        command.draft.netAmount.minor.toString().length > 4096)
    )
      throw new StorageError('STORAGE_LIMIT');
    if (fingerprint(command) !== hash) throw new DomainError('INVALID_INTENT');
    if (this.#db.isTransaction) throw new StorageError('STORAGE_BUSY');
    this.#db.exec('BEGIN IMMEDIATE');
    let result: Result;
    try {
      const prior = lookup(scope, key);
      if (prior) {
        const saved = this.#db
          .prepare(
            'SELECT fingerprint FROM salary_intents WHERE instance_ref=? AND subject_ref=? AND intent_key=?',
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        if (
          !saved ||
          saved.fingerprint !== hash ||
          (prior.kind !== 'salary-version' &&
            prior.kind !== 'salary-period' &&
            prior.kind !== 'salary-payment')
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return prior;
      }
      const ledger = this.#ledger(scope);
      if (ledger.results.size >= maxRows)
        throw new StorageError('STORAGE_LIMIT');
      const decision = decideSalaryCommand(ledger, command, randomUUID());
      result = Object.freeze(decision.result);
      const resultJson = JSON.stringify(result);
      if (
        Buffer.byteLength(resultJson) > 32768 ||
        ledger.allocations.length + decision.allocations.length > maxRows
      )
        throw new StorageError('STORAGE_LIMIT');
      const shape = record(result);
      this.#db
        .prepare(
          `INSERT INTO ${shape.table}(instance_ref,subject_ref,id,intent_key,${Object.keys(shape.fields).join(',')}) VALUES(?,?,?,?${',?'.repeat(Object.keys(shape.fields).length)})`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          ...Object.values(shape.fields),
        );
      if (result.kind === 'salary-version') faults.afterSalaryVersionInsert?.();
      else if (result.kind === 'salary-period')
        faults.afterSalaryPeriodInsert?.();
      else faults.afterSalaryPaymentInsert?.();
      decision.allocations.forEach((allocation, index) => {
        this.#db
          .prepare(
            'INSERT INTO salary_allocations(instance_ref,subject_ref,payment_id,period_id,ordinal,amount_minor) VALUES(?,?,?,?,?,?)',
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            result.id,
            allocation.periodId,
            index,
            allocation.amount.minor.toString(),
          );
        faults.afterSalaryAllocationInsert?.();
      });
      this.#db
        .prepare(
          'INSERT INTO salary_intents(instance_ref,subject_ref,intent_key,operation,version_id,period_id,payment_id,fingerprint,draft_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          key,
          command.operation,
          result.kind === 'salary-version' ? result.id : null,
          result.kind === 'salary-period' ? result.id : null,
          result.kind === 'salary-payment' ? result.id : null,
          hash,
          draftJson,
          resultJson,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    faults.afterSalaryCommit?.();
    return result;
  }
  configureSalary(
    scope: Scope,
    key: string,
    hash: string,
    draft: SalaryVersionDraft,
    lookup: Lookup,
    faults: SalaryFaults,
  ): SalaryVersion {
    return this.#write(
      scope,
      key,
      hash,
      { operation: 'configure', draft: validateSalaryVersionDraft(draft) },
      lookup,
      faults,
    ) as SalaryVersion;
  }
  importPendingPeriod(
    scope: Scope,
    key: string,
    hash: string,
    draft: OpeningDraft,
    lookup: Lookup,
    faults: SalaryFaults,
  ): SalaryPeriod {
    return this.#write(
      scope,
      key,
      hash,
      { operation: 'opening', draft: validateOpeningDraft(draft) },
      lookup,
      faults,
    ) as SalaryPeriod;
  }
  closePeriod(
    scope: Scope,
    key: string,
    hash: string,
    draft: CloseDraft,
    lookup: Lookup,
    faults: SalaryFaults,
  ): SalaryPeriod {
    return this.#write(
      scope,
      key,
      hash,
      { operation: 'close', draft: validateCloseDraft(draft) },
      lookup,
      faults,
    ) as SalaryPeriod;
  }
  receivePayment(
    scope: Scope,
    key: string,
    hash: string,
    draft: SalaryPaymentDraft,
    lookup: Lookup,
    faults: SalaryFaults,
  ): SalaryReceipt {
    return this.#write(
      scope,
      key,
      hash,
      { operation: 'receive', draft: validateSalaryPaymentDraft(draft) },
      lookup,
      faults,
    ) as SalaryReceipt;
  }
  getReceivables(scope: Scope, asOf: string) {
    calendarDate(asOf);
    const ledger = this.#ledger(scope);
    return buildSalaryReceivables(
      ledger.periods,
      ledger.payments,
      ledger.allocations,
      asOf,
    );
  }
  getPayment(scope: Scope, id: string): SalaryPaymentDetail {
    identifier(id);
    const ledger = this.#ledger(scope);
    const payment = ledger.payments.find((item) => item.id === id);
    if (!payment) throw new DomainError('SALARY_PAYMENT_NOT_FOUND');
    const allocations = ledger.allocations
      .filter((item) => item.paymentId === id)
      .map((item) =>
        Object.freeze({
          periodId: item.periodId,
          month: ledger.periods.find((period) => period.id === item.periodId)!
            .month,
          amount: item.amount,
        }),
      );
    return Object.freeze({ payment, allocations: Object.freeze(allocations) });
  }
  monthlyCashInflow(scope: Scope, month: string) {
    calendarMonth(month);
    const payments = this.#ledger(scope).payments.filter(
      (item) =>
        item.status === 'confirmed' && item.receivedOn.startsWith(month + '-'),
    );
    return Object.freeze({
      month,
      currency: 'COP' as const,
      total: Money.fromMinor(
        payments.reduce((total, item) => total + item.amount.minor, 0n),
      ),
      payments: Object.freeze(payments),
    });
  }
}
