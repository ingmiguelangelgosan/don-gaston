import { randomUUID } from 'node:crypto';
import type {
  ExpenseStore,
  IntentResult,
  Scope,
} from '../application/expense-store.ts';
import type { Category, Expense } from '../domain/expenses.ts';
import { DomainError } from '../domain/errors.ts';

interface Entry {
  readonly scopeKey: string;
  readonly fingerprint: string;
  readonly result: IntentResult;
}
function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.instanceRef, scope.subjectRef]);
}
function intentKey(scope: Scope, key: string): string {
  return JSON.stringify([scope.instanceRef, scope.subjectRef, key]);
}

/** Synthetic test adapter. Atomic only within this synchronous in-process Map. */
export class InMemoryExpenseStore implements ExpenseStore {
  readonly #entries = new Map<string, Entry>();

  #commit<T extends IntentResult>(
    scope: Scope,
    key: string,
    fingerprint: string,
    kind: T['kind'],
    create: () => T,
  ): T {
    const index = intentKey(scope, key);
    const existing = this.#entries.get(index);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.result.kind !== kind)
        throw new DomainError('IDEMPOTENCY_CONFLICT');
      return existing.result as T;
    }
    const result = create();
    Object.freeze(result);
    // Single commit stores fact and replay result together; no awaits or I/O.
    this.#entries.set(
      index,
      Object.freeze({ scopeKey: scopeKey(scope), fingerprint, result }),
    );
    return result;
  }

  createCategory(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Category, 'id'>,
  ): Category {
    return this.#commit<Category>(scope, key, fingerprint, 'category', () => ({
      ...draft,
      id: randomUUID(),
    }));
  }

  recordExpense(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Expense, 'id'>,
  ): Expense {
    return this.#commit<Expense>(scope, key, fingerprint, 'expense', () => {
      if (!this.getCategory(scope, draft.categoryId))
        throw new DomainError('CATEGORY_NOT_FOUND');
      return { ...draft, id: randomUUID() };
    });
  }

  findIntent(scope: Scope, key: string): IntentResult | undefined {
    return this.#entries.get(intentKey(scope, key))?.result;
  }

  getCategory(scope: Scope, id: string): Category | undefined {
    for (const entry of this.#entries.values()) {
      if (
        entry.scopeKey === scopeKey(scope) &&
        entry.result.kind === 'category' &&
        entry.result.id === id
      )
        return entry.result;
    }
    return undefined;
  }

  listExpenses(scope: Scope): readonly Expense[] {
    const expenses: Expense[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.scopeKey === scopeKey(scope) && entry.result.kind === 'expense')
        expenses.push(entry.result);
    }
    return Object.freeze(expenses);
  }
}
