import type {
  ExpenseCorrection,
  ExpenseHistory,
} from '../domain/expense-corrections.ts';
import type { Expense } from '../domain/expenses.ts';
import type { ExpenseStore, Scope } from './expense-store.ts';

export interface CorrectionDraft {
  readonly originalExpenseId: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly actorRef: string;
  readonly replacement: Omit<Expense, 'id'> | null;
}
/** Correction, optional replacement and intention must commit atomically. */
export interface ExpenseCorrectionStore extends ExpenseStore {
  correctExpense(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: CorrectionDraft,
  ): ExpenseCorrection;
  getExpenseHistory(scope: Scope, expenseId: string): ExpenseHistory;
}
