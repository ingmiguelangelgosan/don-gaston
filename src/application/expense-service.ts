import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import {
  calendarDate,
  calendarMonth,
  categoryName,
  exactFields,
  identifier,
} from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import type {
  AccessContext,
  AccessPolicy,
  Action,
  ExpenseStore,
} from './expense-store.ts';

export interface ExpenseInput {
  readonly amount: string;
  readonly currency?: string;
  readonly categoryId: string;
  readonly occurredOn: string;
}
export interface MonthlyTotals {
  readonly month: string;
  readonly currency: 'COP';
  readonly total: Money;
  readonly byCategory: readonly {
    readonly categoryId: string;
    readonly total: Money;
  }[];
}

function fingerprint(fields: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export class ExpenseService {
  readonly #store: ExpenseStore;
  readonly #policy: AccessPolicy;

  constructor(store: ExpenseStore, policy: AccessPolicy) {
    this.#store = store;
    this.#policy = policy;
  }

  #authorize(context: AccessContext, action: Action): AccessContext {
    if (!context || typeof context !== 'object')
      throw new DomainError('FORBIDDEN');
    // Snapshot prevents caller/policy mutations changing the authorized target.
    const bound = Object.freeze({
      actorRef: identifier(context.actorRef),
      subjectRef: identifier(context.subjectRef),
      instanceRef: identifier(context.instanceRef),
    });
    if (this.#policy.allows(bound, action) !== true)
      throw new DomainError('FORBIDDEN');
    return bound;
  }

  createCategory(
    context: AccessContext,
    key: string,
    input: { readonly name: string },
  ) {
    const scope = this.#authorize(context, 'category:create');
    identifier(key);
    exactFields(input, ['name']);
    const name = categoryName(input.name);
    return this.#store.createCategory(
      scope,
      key,
      fingerprint(['category:v1', name]),
      {
        kind: 'category',
        name,
        actorRef: scope.actorRef,
      },
    );
  }

  recordExpense(context: AccessContext, key: string, input: ExpenseInput) {
    const scope = this.#authorize(context, 'expense:record');
    identifier(key);
    exactFields(input, ['amount', 'currency', 'categoryId', 'occurredOn']);
    const amount = Money.fromDecimal(input.amount, input.currency);
    if (amount.minor === 0n) throw new DomainError('INVALID_MONEY');
    const categoryId = identifier(input.categoryId);
    const occurredOn = calendarDate(input.occurredOn);
    return this.#store.recordExpense(
      scope,
      key,
      fingerprint([
        'expense:v1',
        amount.minor.toString(),
        amount.currency,
        categoryId,
        occurredOn,
      ]),
      {
        kind: 'expense',
        amount,
        categoryId,
        occurredOn,
        actorRef: scope.actorRef,
      },
    );
  }

  findIntent(context: AccessContext, key: string) {
    const scope = this.#authorize(context, 'expense:read');
    return this.#store.findIntent(scope, identifier(key));
  }

  monthlyTotals(
    context: AccessContext,
    query: { readonly month: string; readonly categoryId?: string },
  ): MonthlyTotals {
    const scope = this.#authorize(context, 'expense:read');
    exactFields(query, ['month', 'categoryId']);
    const month = calendarMonth(query.month);
    const categoryId =
      query.categoryId === undefined ? undefined : identifier(query.categoryId);
    if (categoryId !== undefined && !this.#store.getCategory(scope, categoryId))
      throw new DomainError('CATEGORY_NOT_FOUND');
    let total = Money.fromMinor(0n);
    const totals = new Map<string, Money>();
    for (const expense of this.#store.listExpenses(scope)) {
      if (
        expense.occurredOn.slice(0, 7) !== month ||
        (categoryId !== undefined && expense.categoryId !== categoryId)
      )
        continue;
      total = total.add(expense.amount);
      totals.set(
        expense.categoryId,
        (totals.get(expense.categoryId) ?? Money.fromMinor(0n)).add(
          expense.amount,
        ),
      );
    }
    const byCategory = [...totals]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, amount]) => Object.freeze({ categoryId: id, total: amount }));
    return Object.freeze({
      month,
      currency: 'COP',
      total,
      byCategory: Object.freeze(byCategory),
    });
  }
}
