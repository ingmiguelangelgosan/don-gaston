import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntentResult, Scope } from '../application/expense-store.ts';
import { billFingerprint } from '../application/recurring-bill-service.ts';
import { DomainError } from '../domain/errors.ts';
import { calendarMonth, identifier } from '../domain/expenses.ts';
import type { Expense } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  validateBillCommand,
  decideBillCommand,
  buildBillStatus,
  buildBillList,
} from '../domain/recurring-bills.ts';
import type {
  BillCommand,
  BillState,
  BillConcept,
  BillObligation,
  BillAdjustment,
  BillPayment,
  BillResult,
} from '../domain/recurring-bills.ts';
import { StorageError } from './sqlite-errors.ts';

type Row = Record<string, unknown>;
export interface BillFaults {
  readonly afterBillConceptInsert?: () => void;
  readonly afterBillObligationInsert?: () => void;
  readonly afterBillAdjustmentInsert?: () => void;
  readonly afterBillPaymentInsert?: () => void;
  readonly afterBillExpenseInsert?: () => void;
  readonly afterBillCommit?: () => void;
}
interface Ledger extends BillState {
  concepts: BillConcept[];
  obligations: BillObligation[];
  adjustments: BillAdjustment[];
  payments: BillPayment[];
  results: Map<string, BillResult>;
}
const maxRows = 10000;
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function money(value: unknown): Money {
  if (!value || typeof value !== 'object') throw new Error();
  const raw = value as { minor: unknown; currency: unknown };
  const minor = text(raw.minor);
  if (minor.length > 4096 || !/^[1-9][0-9]*$/.test(minor)) throw new Error();
  return Money.fromMinor(BigInt(minor), text(raw.currency));
}
function decodeCommand(operation: unknown, json: unknown): BillCommand {
  const draft = JSON.parse(text(json)) as Record<string, unknown>;
  for (const field of ['amount', 'fixedAmount'])
    if (draft[field] !== undefined && draft[field] !== null)
      draft[field] = money(draft[field]);
  const command = validateBillCommand({ operation, draft } as BillCommand);
  if (JSON.stringify(command.draft) !== json) throw new Error();
  return command;
}
function shape(result: BillResult): {
  table: string;
  column: string;
  fields: Record<string, string | number | null>;
} {
  switch (result.kind) {
    case 'bill-concept':
      return {
        table: 'bill_concepts',
        column: 'concept_id',
        fields: {
          category_id: result.categoryId,
          fixed_minor: result.fixedAmount?.minor.toString() ?? null,
          due_day: result.dueDay,
          due_month_offset: result.dueMonthOffset,
        },
      };
    case 'bill-obligation':
      return {
        table: 'bill_obligations',
        column: 'obligation_id',
        fields: {
          concept_id: result.conceptId,
          month: result.month,
          generated_on: result.generatedOn,
          due_on: result.dueOn,
          amount_minor: result.amount?.minor.toString() ?? null,
          amount_status: result.amountStatus,
          source_payment_id: result.sourcePaymentId,
        },
      };
    case 'bill-adjustment':
      return {
        table: 'bill_adjustments',
        column: 'adjustment_id',
        fields: {
          obligation_id: result.obligationId,
          previous_revision_id: result.previousRevisionId,
          amount_minor: result.amount.minor.toString(),
          amount_status: result.amountStatus,
        },
      };
    case 'bill-payment':
      return {
        table: 'bill_payments',
        column: 'payment_id',
        fields: {
          obligation_id: result.obligationId,
          revision_id: result.revisionId,
          paid_on: result.paidOn,
        },
      };
  }
}
function add(ledger: Ledger, result: BillResult, key: string): void {
  ledger.results.set(key, result);
  switch (result.kind) {
    case 'bill-concept':
      ledger.concepts.push(result);
      break;
    case 'bill-obligation':
      ledger.obligations.push(result);
      break;
    case 'bill-adjustment':
      ledger.adjustments.push(result);
      break;
    case 'bill-payment':
      ledger.payments.push(result);
      break;
  }
}
/** Same identity and exact values, not a second financial movement. */
export function billExpense(payment: BillPayment): Expense {
  return Object.freeze({
    kind: 'expense',
    id: payment.id,
    categoryId: payment.categoryId,
    amount: payment.amount,
    occurredOn: payment.paidOn,
    actorRef: payment.actorRef,
  });
}
function bounded(rows: Row[]): Row[] {
  if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
  return rows;
}
export class SqliteRecurringBills {
  readonly #db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#db = database;
  }
  #verifyExpense(
    scope: Scope,
    payment: BillPayment,
    expenseKey: unknown,
  ): void {
    const key = identifier(text(expenseKey));
    const expense = billExpense(payment);
    const row = this.#db
      .prepare(
        `SELECT f.*,i.fingerprint,i.result_json FROM facts f JOIN intents i ON i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref AND i.fact_id=f.id AND i.intent_key=f.intent_key
      WHERE f.instance_ref=? AND f.subject_ref=? AND f.id=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, payment.id);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          'expense:v1',
          expense.amount.minor.toString(),
          'COP',
          expense.categoryId,
          expense.occurredOn,
        ]),
      )
      .digest('hex');
    if (
      !row ||
      payment.expenseId !== expense.id ||
      row.kind !== 'expense' ||
      row.intent_key !== key ||
      row.category_id !== expense.categoryId ||
      row.actor_ref !== expense.actorRef ||
      row.amount_minor !== expense.amount.minor.toString() ||
      row.currency !== 'COP' ||
      row.occurred_on !== expense.occurredOn ||
      row.fingerprint !== fingerprint ||
      row.result_json !== JSON.stringify(expense)
    )
      throw new Error();
    if (
      this.#db
        .prepare(
          'SELECT 1 FROM corrections WHERE instance_ref=? AND subject_ref=? AND original_expense_id=?',
        )
        .get(scope.instanceRef, scope.subjectRef, payment.id)
    )
      throw new Error();
  }
  #ledger(scope: Scope): Ledger {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    const rows = bounded(
      this.#db
        .prepare(
          'SELECT * FROM bill_intents WHERE instance_ref=? AND subject_ref=? ORDER BY sequence LIMIT ?',
        )
        .all(scope.instanceRef, scope.subjectRef, maxRows + 1),
    );
    const ledger: Ledger = {
      concepts: [],
      obligations: [],
      adjustments: [],
      payments: [],
      results: new Map(),
    };
    try {
      for (const row of rows) {
        const key = identifier(text(row.intent_key)),
          id = identifier(text(row.result_id));
        const command = decodeCommand(row.operation, row.draft_json);
        if (billFingerprint(command) !== row.fingerprint) throw new Error();
        const result = decideBillCommand(ledger, command, id);
        if (JSON.stringify(result) !== row.result_json) throw new Error();
        const record = shape(result);
        for (const column of [
          'concept_id',
          'obligation_id',
          'adjustment_id',
          'payment_id',
        ])
          if (row[column] !== (column === record.column ? id : null))
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
        if (
          result.kind === 'bill-concept' &&
          !this.#db
            .prepare(
              "SELECT 1 FROM facts WHERE instance_ref=? AND subject_ref=? AND id=? AND kind='category'",
            )
            .get(scope.instanceRef, scope.subjectRef, result.categoryId)
        )
          throw new Error();
        if (result.kind === 'bill-payment')
          this.#verifyExpense(scope, result, saved.expense_intent_key);
        add(ledger, result, key);
      }
      for (const [table, count] of [
        ['bill_concepts', ledger.concepts.length],
        ['bill_obligations', ledger.obligations.length],
        ['bill_adjustments', ledger.adjustments.length],
        ['bill_payments', ledger.payments.length],
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
      if (
        this.#db
          .prepare(
            `SELECT 1 FROM bill_intents b WHERE b.instance_ref=? AND b.subject_ref=? AND (
        EXISTS(SELECT 1 FROM intents i WHERE i.instance_ref=b.instance_ref AND i.subject_ref=b.subject_ref AND i.intent_key=b.intent_key) OR
        EXISTS(SELECT 1 FROM debt_intents i WHERE i.instance_ref=b.instance_ref AND i.subject_ref=b.subject_ref AND i.intent_key=b.intent_key) OR
        EXISTS(SELECT 1 FROM salary_intents i WHERE i.instance_ref=b.instance_ref AND i.subject_ref=b.subject_ref AND i.intent_key=b.intent_key)) LIMIT 1`,
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
          'SELECT DISTINCT instance_ref,subject_ref FROM bill_intents LIMIT ?',
        )
        .all(maxRows + 1),
    );
    for (const scope of scopes)
      this.#ledger({
        instanceRef: text(scope.instance_ref),
        subjectRef: text(scope.subject_ref),
      });
  }
  findIntent(scope: Scope, key: string): BillResult | undefined {
    return this.#ledger(scope).results.get(key);
  }
  executeBill(
    scope: Scope,
    key: string,
    fingerprint: string,
    input: BillCommand,
    lookup: (scope: Scope, key: string) => IntentResult | undefined,
    writeExpense: (scope: Scope, expense: Expense, key: string) => void,
    faults: BillFaults,
  ): BillResult {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const command = validateBillCommand(input),
      draftJson = JSON.stringify(command.draft);
    if (
      Buffer.byteLength(draftJson) > 32768 ||
      Object.values(command.draft).some(
        (value) =>
          value instanceof Money && value.minor.toString().length > 4096,
      )
    )
      throw new StorageError('STORAGE_LIMIT');
    if (billFingerprint(command) !== fingerprint)
      throw new DomainError('INVALID_INTENT');
    if (this.#db.isTransaction) throw new StorageError('STORAGE_BUSY');
    this.#db.exec('BEGIN IMMEDIATE');
    let result: BillResult;
    try {
      const previous = lookup(scope, key);
      if (previous) {
        const prior = this.#db
          .prepare(
            'SELECT fingerprint FROM bill_intents WHERE instance_ref=? AND subject_ref=? AND intent_key=?',
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        if (
          !prior ||
          prior.fingerprint !== fingerprint ||
          (previous.kind !== 'bill-concept' &&
            previous.kind !== 'bill-obligation' &&
            previous.kind !== 'bill-adjustment' &&
            previous.kind !== 'bill-payment')
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return previous;
      }
      const ledger = this.#ledger(scope);
      if (ledger.results.size >= maxRows)
        throw new StorageError('STORAGE_LIMIT');
      result = decideBillCommand(ledger, command, randomUUID());
      if (
        result.kind === 'bill-concept' &&
        !this.#db
          .prepare(
            "SELECT 1 FROM facts WHERE instance_ref=? AND subject_ref=? AND id=? AND kind='category'",
          )
          .get(scope.instanceRef, scope.subjectRef, result.categoryId)
      )
        throw new DomainError('CATEGORY_NOT_FOUND');
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json) > 32768)
        throw new StorageError('STORAGE_LIMIT');
      const record = shape(result);
      const expenseKey =
        result.kind === 'bill-payment' ? `bill-expense:${randomUUID()}` : null;
      const fields = {
        ...record.fields,
        ...(expenseKey ? { expense_intent_key: expenseKey } : {}),
      };
      this.#db
        .prepare(
          `INSERT INTO ${record.table}(instance_ref,subject_ref,id,intent_key,${Object.keys(fields).join(',')}) VALUES(?,?,?,?${',?'.repeat(Object.keys(fields).length)})`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          ...Object.values(fields),
        );
      switch (result.kind) {
        case 'bill-concept':
          faults.afterBillConceptInsert?.();
          break;
        case 'bill-obligation':
          faults.afterBillObligationInsert?.();
          break;
        case 'bill-adjustment':
          faults.afterBillAdjustmentInsert?.();
          break;
        case 'bill-payment':
          faults.afterBillPaymentInsert?.();
          break;
      }
      this.#db
        .prepare(
          `INSERT INTO bill_intents(instance_ref,subject_ref,intent_key,operation,result_id,${record.column},fingerprint,draft_json,result_json) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          key,
          command.operation,
          result.id,
          result.id,
          fingerprint,
          draftJson,
          json,
        );
      if (result.kind === 'bill-payment' && expenseKey)
        writeExpense(scope, billExpense(result), expenseKey);
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    faults.afterBillCommit?.();
    return result;
  }
  getObligation(scope: Scope, id: string, asOf: string) {
    return buildBillStatus(this.#ledger(scope), id, asOf);
  }
  listObligations(
    scope: Scope,
    query: { readonly asOf: string; readonly conceptId?: string },
  ) {
    return buildBillList(this.#ledger(scope), query);
  }
  monthlyBillCashOutflow(scope: Scope, month: string) {
    calendarMonth(month);
    const payments = this.#ledger(scope).payments.filter((payment) =>
      payment.paidOn.startsWith(month + '-'),
    );
    return Object.freeze({
      month,
      currency: 'COP' as const,
      total: Money.fromMinor(
        payments.reduce((total, payment) => total + payment.amount.minor, 0n),
      ),
      payments: Object.freeze(payments),
    });
  }
}
