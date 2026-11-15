import type { ExpenseStore, Scope } from './expense-store.ts';
import type {
  DebtMonthlyCashOutflow,
  DebtPaymentDraft,
  DebtPaymentResult,
  DebtStatus,
  FinancedDebt,
} from '../domain/financed-debts.ts';

export interface FinancedDebtStore extends ExpenseStore {
  registerDebt(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: Omit<FinancedDebt, 'id'>,
  ): FinancedDebt;
  /** Persist either a confirmed cash fact or an immutable review result with no
   * financial effect, together with the original idempotent response. */
  confirmPayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: DebtPaymentDraft,
  ): DebtPaymentResult;
  getDebt(scope: Scope, debtId: string): DebtStatus;
  monthlyCashOutflow(scope: Scope, month: string): DebtMonthlyCashOutflow;
}
