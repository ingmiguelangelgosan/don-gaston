import type { Scope } from './expense-store.ts';
import type { FinancedDebtStore } from './financed-debt-store.ts';
import type {
  DebtPaymentCorrection,
  DebtPaymentCorrectionDraft,
  DebtPaymentHistory,
} from '../domain/debt-payment-corrections.ts';

export interface DebtPaymentCorrectionStore extends FinancedDebtStore {
  /** Atomically evaluate current invariants, preserve the correction decision and
   * intent, and apply withdrawal/replacement only if the decision is applied. */
  correctPayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: DebtPaymentCorrectionDraft,
  ): DebtPaymentCorrection;
  /** Historical record and incoming/outgoing applied links in one snapshot. */
  getPaymentHistory(scope: Scope, paymentId: string): DebtPaymentHistory;
}
