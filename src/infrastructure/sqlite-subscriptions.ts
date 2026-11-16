import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntentResult, Scope } from '../application/expense-store.ts';
import { subscriptionFingerprint } from '../application/subscription-service.ts';
import { DomainError } from '../domain/errors.ts';
import { identifier } from '../domain/expenses.ts';
import type { Expense } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  validateSubscriptionCommand,
  decideSubscriptionCommand,
  buildSubscriptionStatus,
  buildSubscriptionList,
  buildSubscriptionReceivables,
  buildSubscriptionCashFlow,
} from '../domain/subscriptions.ts';
import type {
  SubscriptionCommand,
  SubscriptionResult,
  SubscriptionState,
  SubscriptionPayment,
  SubscriptionListQuery,
  SubscriptionReceivablesQuery,
} from '../domain/subscriptions.ts';
import { SqlitePersonalLoans } from './sqlite-personal-loans.ts';
import { StorageError } from './sqlite-errors.ts';

export interface SubscriptionFaults {
  readonly afterSubscriptionRecordInsert?: () => void;
  readonly afterSubscriptionExpenseInsert?: () => void;
  readonly afterSubscriptionAllocationInsert?: () => void;
  readonly afterSubscriptionCommit?: () => void;
}
type Ledger = {
  -readonly [K in keyof SubscriptionState]: Array<SubscriptionState[K][number]>;
} & { results: Map<string, SubscriptionResult> };
const maximum = 10000;
const oldIntents = [
  'intents',
  'debt_intents',
  'salary_intents',
  'bill_intents',
  'loan_intents',
];
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function bounded<T>(rows: T[]): T[] {
  if (rows.length > maximum) throw new StorageError('STORAGE_LIMIT');
  return rows;
}
function decode(operation: unknown, json: unknown): SubscriptionCommand {
  const draft = JSON.parse(text(json)) as Record<string, unknown>;
  for (const field of ['amount', 'monthlyAmount'])
    if (draft[field] !== undefined) {
      const raw = draft[field] as { minor: unknown; currency: unknown },
        minor = text(raw?.minor);
      if (minor.length > 4096 || !/^[1-9][0-9]*$/.test(minor))
        throw new Error();
      draft[field] = Money.fromMinor(BigInt(minor), text(raw.currency));
    }
  const result = validateSubscriptionCommand({
    operation,
    draft,
  } as SubscriptionCommand);
  if (JSON.stringify(result.draft) !== json) throw new Error();
  return result;
}
function fields(result: SubscriptionResult): Record<string, string | null> {
  return {
    kind: result.kind,
    subscription_id: 'subscriptionId' in result ? result.subscriptionId : null,
    obligation_id: 'obligationId' in result ? result.obligationId : null,
    counterparty_id: 'counterpartyId' in result ? result.counterpartyId : null,
    category_id: 'categoryId' in result ? result.categoryId : null,
    version_id:
      result.kind === 'subscription-obligation' ? result.versionId : null,
    month:
      'month' in result
        ? result.month
        : 'effectiveMonth' in result
          ? result.effectiveMonth
          : null,
    occurred_on:
      'paidOn' in result
        ? result.paidOn
        : 'receivedOn' in result
          ? result.receivedOn
          : 'generatedOn' in result
            ? result.generatedOn
            : null,
    status: 'status' in result ? result.status : null,
    amount_minor: ('amount' in result
      ? result.amount
      : 'monthlyAmount' in result
        ? result.monthlyAmount
        : Money.fromMinor(0n)
    ).minor.toString(),
    own_minor:
      result.kind === 'subscription-payment'
        ? result.ownAmount.minor.toString()
        : '0',
    expense_id:
      result.kind === 'subscription-payment' ? result.expenseId : null,
  };
}
function add(ledger: Ledger, result: SubscriptionResult, key: string): void {
  ledger.results.set(key, result);
  switch (result.kind) {
    case 'subscription':
      ledger.subscriptions.push(result);
      break;
    case 'subscription-participants':
      ledger.changes.push(result);
      break;
    case 'subscription-obligation':
      ledger.obligations.push(result);
      break;
    case 'subscription-payment':
      ledger.payments.push(result);
      break;
    case 'subscription-reimbursement':
      ledger.reimbursements.push(result);
      break;
  }
}
export function subscriptionExpense(payment: SubscriptionPayment): Expense {
  if (
    payment.status !== 'confirmed' ||
    payment.ownAmount.minor <= 0n ||
    payment.expenseId !== payment.id
  )
    throw new DomainError('INVALID_SUBSCRIPTION_EXPENSE');
  return Object.freeze({
    kind: 'expense',
    id: payment.id,
    categoryId: payment.categoryId,
    amount: payment.ownAmount,
    occurredOn: payment.paidOn,
    actorRef: payment.actorRef,
  });
}
function links(
  result: SubscriptionResult,
): { table: string; fields: Record<string, string> }[] {
  if ('counterpartyIds' in result)
    return result.counterpartyIds.map((counterparty_id) => ({
      table: 'subscription_participants',
      fields: { record_id: result.id, counterparty_id },
    }));
  if (result.kind === 'subscription-payment')
    return result.shares.map((share) => ({
      table: 'subscription_shares',
      fields: {
        payment_id: result.id,
        counterparty_id: share.counterpartyId,
        amount_minor: share.amount.minor.toString(),
      },
    }));
  return result.allocations.map((allocation) => ({
    table: 'subscription_allocations',
    fields: {
      reimbursement_id: result.id,
      payment_id: allocation.paymentId,
      counterparty_id: result.counterpartyId,
      amount_minor: allocation.amount.minor.toString(),
    },
  }));
}
export class SqliteSubscriptions {
  readonly #db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#db = database;
  }
  #verifyExpense(
    scope: Scope,
    payment: SubscriptionPayment,
    key: unknown,
  ): void {
    const expense = subscriptionExpense(payment);
    const row = this.#db
      .prepare(
        `SELECT f.*,i.fingerprint,i.result_json FROM facts f JOIN intents i ON i.instance_ref=f.instance_ref AND i.subject_ref=f.subject_ref AND i.fact_id=f.id AND i.intent_key=f.intent_key WHERE f.instance_ref=? AND f.subject_ref=? AND f.id=?`,
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
      row.kind !== 'expense' ||
      row.intent_key !== identifier(text(key)) ||
      row.actor_ref !== expense.actorRef ||
      row.category_id !== expense.categoryId ||
      row.amount_minor !== expense.amount.minor.toString() ||
      row.currency !== 'COP' ||
      row.occurred_on !== expense.occurredOn ||
      row.fingerprint !== fingerprint ||
      row.result_json !== JSON.stringify(expense) ||
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
          'SELECT * FROM subscription_intents WHERE instance_ref=? AND subject_ref=? ORDER BY sequence LIMIT ?',
        )
        .all(scope.instanceRef, scope.subjectRef, maximum + 1),
    );
    const ledger: Ledger = {
      counterparties: new SqlitePersonalLoans(this.#db)
        .listLoanPositions(scope, { asOf: '9999-12-31' })
        .positions.map((p) => p.counterparty),
      subscriptions: [],
      changes: [],
      obligations: [],
      payments: [],
      reimbursements: [],
      results: new Map(),
    };
    const counts = {
      subscription_participants: 0,
      subscription_shares: 0,
      subscription_allocations: 0,
    };
    try {
      for (const row of rows) {
        const command = decode(row.operation, row.draft_json),
          key = identifier(text(row.intent_key)),
          id = identifier(text(row.record_id));
        if (subscriptionFingerprint(command) !== row.fingerprint)
          throw new Error();
        const result = decideSubscriptionCommand(ledger, command, id);
        if (JSON.stringify(result) !== row.result_json) throw new Error();
        const saved = this.#db
          .prepare(
            'SELECT * FROM subscription_records WHERE instance_ref=? AND subject_ref=? AND id=?',
          )
          .get(scope.instanceRef, scope.subjectRef, id);
        if (
          !saved ||
          saved.intent_key !== key ||
          Object.entries(fields(result)).some(
            ([name, value]) => saved[name] !== value,
          )
        )
          throw new Error();
        if (
          'categoryId' in result &&
          !this.#db
            .prepare(
              "SELECT 1 FROM facts WHERE instance_ref=? AND subject_ref=? AND id=? AND kind='category'",
            )
            .get(scope.instanceRef, scope.subjectRef, result.categoryId)
        )
          throw new Error();
        if (result.kind === 'subscription-payment' && result.expenseId)
          this.#verifyExpense(scope, result, saved.expense_intent_key);
        else if (saved.expense_intent_key !== null) throw new Error();
        for (const link of links(result)) {
          const actual = this.#db
            .prepare(
              `SELECT * FROM ${link.table} WHERE instance_ref=? AND subject_ref=? AND ${Object.keys(
                link.fields,
              )
                .map((name) => `${name}=?`)
                .join(' AND ')}`,
            )
            .get(
              scope.instanceRef,
              scope.subjectRef,
              ...Object.values(link.fields),
            );
          if (!actual) throw new Error();
          counts[link.table as keyof typeof counts]++;
        }
        add(ledger, result, key);
      }
      for (const [table, count] of Object.entries({
        subscription_records: rows.length,
        ...counts,
      })) {
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
            `SELECT 1 FROM subscription_intents s WHERE s.instance_ref=? AND s.subject_ref=? AND (${oldIntents.map((table) => `EXISTS(SELECT 1 FROM ${table} i WHERE i.instance_ref=s.instance_ref AND i.subject_ref=s.subject_ref AND i.intent_key=s.intent_key)`).join(' OR ')}) LIMIT 1`,
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
          'SELECT DISTINCT instance_ref,subject_ref FROM subscription_records UNION SELECT DISTINCT instance_ref,subject_ref FROM subscription_intents LIMIT ?',
        )
        .all(maximum + 1),
    ))
      this.#ledger({
        instanceRef: text(row.instance_ref),
        subjectRef: text(row.subject_ref),
      });
  }
  findIntent(scope: Scope, key: string) {
    return this.#ledger(scope).results.get(key);
  }
  executeSubscription(
    scope: Scope,
    key: string,
    fingerprint: string,
    input: SubscriptionCommand,
    lookup: (scope: Scope, key: string) => IntentResult | undefined,
    recordExpense: (scope: Scope, expense: Expense, key: string) => void,
    faults: SubscriptionFaults,
  ): SubscriptionResult {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const command = validateSubscriptionCommand(input),
      draftJson = JSON.stringify(command.draft);
    if (
      Buffer.byteLength(draftJson) > 32768 ||
      Object.values(command.draft).some(
        (v) => v instanceof Money && v.minor.toString().length > 4096,
      )
    )
      throw new StorageError('STORAGE_LIMIT');
    if (subscriptionFingerprint(command) !== fingerprint)
      throw new DomainError('INVALID_INTENT');
    if (this.#db.isTransaction) throw new StorageError('STORAGE_BUSY');
    this.#db.exec('BEGIN IMMEDIATE');
    let result: SubscriptionResult;
    try {
      const previous = lookup(scope, key);
      if (previous) {
        const saved = this.#db
          .prepare(
            'SELECT fingerprint FROM subscription_intents WHERE instance_ref=? AND subject_ref=? AND intent_key=?',
          )
          .get(scope.instanceRef, scope.subjectRef, key);
        if (
          !saved ||
          saved.fingerprint !== fingerprint ||
          ![
            'subscription',
            'subscription-participants',
            'subscription-obligation',
            'subscription-payment',
            'subscription-reimbursement',
          ].includes(previous.kind)
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return previous as SubscriptionResult;
      }
      const ledger = this.#ledger(scope);
      if (ledger.results.size >= maximum)
        throw new StorageError('STORAGE_LIMIT');
      if (
        command.operation === 'create' &&
        !this.#db
          .prepare(
            "SELECT 1 FROM facts WHERE instance_ref=? AND subject_ref=? AND id=? AND kind='category'",
          )
          .get(scope.instanceRef, scope.subjectRef, command.draft.categoryId)
      )
        throw new DomainError('CATEGORY_NOT_FOUND');
      result = decideSubscriptionCommand(ledger, command, randomUUID());
      const resultJson = JSON.stringify(result);
      if (Buffer.byteLength(resultJson) > 32768)
        throw new StorageError('STORAGE_LIMIT');
      const expenseKey =
        result.kind === 'subscription-payment' && result.expenseId
          ? `subscription-expense:${randomUUID()}`
          : null;
      if (expenseKey && result.kind === 'subscription-payment')
        recordExpense(scope, subscriptionExpense(result), expenseKey);
      const record = { ...fields(result), expense_intent_key: expenseKey };
      this.#db
        .prepare(
          `INSERT INTO subscription_records(instance_ref,subject_ref,id,intent_key,${Object.keys(record).join(',')}) VALUES(?,?,?,?${',?'.repeat(Object.keys(record).length)})`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          ...Object.values(record),
        );
      faults.afterSubscriptionRecordInsert?.();
      for (const link of links(result)) {
        if (
          (this.#db
            .prepare(
              `SELECT count(*) AS total FROM ${link.table} WHERE instance_ref=? AND subject_ref=?`,
            )
            .get(scope.instanceRef, scope.subjectRef)?.total as number) >=
          maximum
        )
          throw new StorageError('STORAGE_LIMIT');
        this.#db
          .prepare(
            `INSERT INTO ${link.table}(instance_ref,subject_ref,${Object.keys(link.fields).join(',')}) VALUES(?,?${',?'.repeat(Object.keys(link.fields).length)})`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            ...Object.values(link.fields),
          );
        if (link.table === 'subscription_allocations')
          faults.afterSubscriptionAllocationInsert?.();
      }
      this.#db
        .prepare(
          'INSERT INTO subscription_intents(instance_ref,subject_ref,intent_key,record_id,operation,fingerprint,draft_json,result_json) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          key,
          result.id,
          command.operation,
          fingerprint,
          draftJson,
          resultJson,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    faults.afterSubscriptionCommit?.();
    return result;
  }
  getSubscriptionObligation(scope: Scope, id: string, asOf: string) {
    return buildSubscriptionStatus(this.#ledger(scope), id, asOf);
  }
  listSubscriptionObligations(scope: Scope, query: SubscriptionListQuery) {
    return buildSubscriptionList(this.#ledger(scope), query);
  }
  getSubscriptionReceivables(
    scope: Scope,
    query: SubscriptionReceivablesQuery,
  ) {
    return buildSubscriptionReceivables(this.#ledger(scope), query);
  }
  monthlySubscriptionCashFlow(scope: Scope, month: string) {
    return buildSubscriptionCashFlow(this.#ledger(scope), month);
  }
}
