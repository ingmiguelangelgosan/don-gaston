import type { BudgetStatus, MonthlyBudget } from '../domain/monthly-budgets.ts';
import type { ExpenseStore, Scope } from './expense-store.ts';

export interface MonthlyBudgetStore extends ExpenseStore {
  /** Append a revision, intent and any resulting alert in one transaction.
   * Category/month consumption uses only current expenses. Existing alert events
   * are never removed by revisions or corrections. A 100% event suppresses a
   * later 80% event for that same scope/category/month.
   */
  setBudget(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<MonthlyBudget, 'id'>,
  ): MonthlyBudget;
  /** Budget, current consumption and alerts must come from one read snapshot. */
  getBudgetStatus(
    scope: Scope,
    categoryId: string,
    month: string,
  ): BudgetStatus;
}
