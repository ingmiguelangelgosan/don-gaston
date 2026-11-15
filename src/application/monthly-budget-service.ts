import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { calendarMonth, exactFields, identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import type { MonthlyBudget } from '../domain/monthly-budgets.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { MonthlyBudgetStore } from './monthly-budget-store.ts';

export interface MonthlyBudgetInput {
  readonly categoryId: string;
  readonly month: string;
  readonly amount: string;
  readonly currency?: string;
}

export function budgetFingerprint(
  draft: Pick<MonthlyBudget, 'categoryId' | 'month' | 'amount'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'budget:set:v1',
        draft.categoryId,
        draft.month,
        draft.amount.minor.toString(),
        draft.amount.currency,
      ]),
    )
    .digest('hex');
}

export class MonthlyBudgetService {
  readonly #store: MonthlyBudgetStore;
  readonly #policy: AccessPolicy;

  constructor(store: MonthlyBudgetStore, policy: AccessPolicy) {
    this.#store = store;
    this.#policy = policy;
  }

  #authorize(context: AccessContext, action: Action): AccessContext {
    if (!context || typeof context !== 'object')
      throw new DomainError('FORBIDDEN');
    const bound = Object.freeze({
      actorRef: identifier(context.actorRef),
      subjectRef: identifier(context.subjectRef),
      instanceRef: identifier(context.instanceRef),
    });
    if (this.#policy.allows(bound, action) !== true)
      throw new DomainError('FORBIDDEN');
    return bound;
  }

  setBudget(context: AccessContext, key: string, input: MonthlyBudgetInput) {
    const bound = this.#authorize(context, 'budget:write');
    identifier(key);
    exactFields(input, ['categoryId', 'month', 'amount', 'currency']);
    const draft: Omit<MonthlyBudget, 'id'> = {
      kind: 'budget',
      categoryId: identifier(input.categoryId),
      month: calendarMonth(input.month),
      amount: Money.fromDecimal(input.amount, input.currency),
      actorRef: bound.actorRef,
    };
    return this.#store.setBudget(bound, key, budgetFingerprint(draft), draft);
  }

  getBudgetStatus(
    context: AccessContext,
    query: { readonly categoryId: string; readonly month: string },
  ) {
    const bound = this.#authorize(context, 'budget:read');
    exactFields(query, ['categoryId', 'month']);
    return this.#store.getBudgetStatus(
      bound,
      identifier(query.categoryId),
      calendarMonth(query.month),
    );
  }

  findIntent(context: AccessContext, key: string): MonthlyBudget | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'budget:read'),
      identifier(key),
    );
    // Shared keys do not confer permission to inspect other financial actions.
    return result?.kind === 'budget' ? result : undefined;
  }
}
