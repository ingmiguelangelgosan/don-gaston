import type { Category, Expense } from '../domain/expenses.ts';
import type { ExpenseCorrection } from '../domain/expense-corrections.ts';
import type { MonthlyBudget } from '../domain/monthly-budgets.ts';

/** Supplied by a trusted boundary, never taken from the financial payload. */
export interface AccessContext {
  readonly actorRef: string;
  readonly subjectRef: string;
  readonly instanceRef: string;
}
export type Action =
  | 'category:create'
  | 'expense:record'
  | 'expense:read'
  | 'expense:correct'
  | 'budget:write'
  | 'budget:read';
export interface AccessPolicy {
  allows(context: AccessContext, action: Action): boolean;
}
export interface Scope {
  readonly subjectRef: string;
  readonly instanceRef: string;
}
export type IntentResult =
  Category | Expense | ExpenseCorrection | MonthlyBudget;

/**
 * Implementations must atomically commit intent fingerprint + immutable fact.
 * Scope/key is unique across mutation types. Replays return the original result;
 * different fingerprints conflict. Category existence is checked in that commit.
 * A future durable implementation requires ADR-001 and transactional tests.
 */
export interface ExpenseStore {
  createCategory(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Category, 'id'>,
  ): Category;
  recordExpense(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<Expense, 'id'>,
  ): Expense;
  findIntent(scope: Scope, key: string): IntentResult | undefined;
  getCategory(scope: Scope, id: string): Category | undefined;
  /** Current expenses only. Historical originals are retained by correction-capable stores. */
  listExpenses(scope: Scope): readonly Expense[];
}
