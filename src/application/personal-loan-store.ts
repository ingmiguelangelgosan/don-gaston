import type { ExpenseStore, Scope } from './expense-store.ts';
import type {
  LoanCommand,
  LoanResult,
  LoanPositionQuery,
  LoanPosition,
  LoanPositions,
  LoanCashFlow,
} from '../domain/personal-loans.ts';

/** Scoped immutable principal ledger. Decisions and intentions share one commit;
 * a confirmed movement itself is the sole cash fact, with no ordinary expense. */
export interface PersonalLoanStore extends ExpenseStore {
  executeLoan(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: LoanCommand,
  ): LoanResult;
  getLoanPosition(scope: Scope, query: LoanPositionQuery): LoanPosition;
  listLoanPositions(
    scope: Scope,
    query: { readonly asOf: string },
  ): LoanPositions;
  monthlyLoanCashFlow(scope: Scope, month: string): LoanCashFlow;
}
