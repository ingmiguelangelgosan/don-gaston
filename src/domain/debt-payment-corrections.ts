import { DomainError } from './errors.ts';
import { correctionReason, correctionTime } from './expense-corrections.ts';
import { identifier } from './expenses.ts';
import {
  buildDebtStatus,
  decidePayment,
  validatePaymentDraft,
} from './financed-debts.ts';
import type {
  DebtPaymentDecision,
  DebtPaymentResult,
  DebtPaymentReviewReason,
  FinancedDebt,
} from './financed-debts.ts';
import type { Money } from './money.ts';

export interface DebtPaymentReplacement {
  readonly installmentNumber: number;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
}

export interface DebtPaymentCorrectionDraft {
  readonly originalPaymentId: string;
  readonly reason: string;
  readonly actorRef: string;
  readonly recordedAt: string;
  readonly replacement: DebtPaymentReplacement | null;
}

export interface DebtPaymentCorrection {
  readonly kind: 'debt-payment-correction';
  readonly id: string;
  readonly debtId: string;
  readonly originalPaymentId: string;
  /** Requested replacement retained even when the correction needs review. */
  readonly proposedReplacement: DebtPaymentReplacement | null;
  /** A new effective cash fact exists only for an applied replacement. */
  readonly replacement: DebtPaymentResult | null;
  readonly status: 'applied' | 'review_required';
  readonly reviewReason: DebtPaymentReviewReason | null;
  readonly estimatedBalanceAfter: Money;
  readonly reason: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}

export interface DebtPaymentHistory {
  readonly payment: DebtPaymentResult;
  readonly status: 'active' | 'voided' | 'replaced' | 'review_required';
  /** Only an applied correction withdraws this payment from the current view. */
  readonly correctedBy: DebtPaymentCorrection | null;
  readonly replaces: DebtPaymentCorrection | null;
}

export interface DebtPaymentCorrectionDecision {
  readonly status: 'applied' | 'review_required';
  readonly reviewReason: DebtPaymentReviewReason | null;
  readonly estimatedBalanceAfter: Money;
  readonly replacementDecision: DebtPaymentDecision | null;
}

export function validateCorrectionDraft(
  draft: DebtPaymentCorrectionDraft,
): DebtPaymentCorrectionDraft {
  const originalPaymentId = identifier(draft.originalPaymentId);
  const reason = correctionReason(draft.reason);
  const actorRef = identifier(draft.actorRef);
  const recordedAt = correctionTime(draft.recordedAt);
  let replacement: DebtPaymentReplacement | null = null;
  if (draft.replacement !== null) {
    // Validate context-free payment fields here. The real debt and reference date
    // are checked when deciding against the original payment inside its transaction.
    const candidate = validatePaymentDraft({
      debtId: originalPaymentId,
      ...draft.replacement,
      actorRef,
      recordedAt,
    });
    replacement = Object.freeze({
      installmentNumber: candidate.installmentNumber,
      amount: candidate.amount,
      paidOn: candidate.paidOn,
      reference: candidate.reference,
    });
  }
  return Object.freeze({
    originalPaymentId,
    reason,
    actorRef,
    recordedAt,
    replacement,
  });
}

/** Correct a mistaken record, never model an actual bank refund. All current
 * payments, including later confirmations, constrain the replacement. Historical
 * review outcomes are not reconsidered or promoted to confirmed payments. */
export function decidePaymentCorrection(
  debt: FinancedDebt,
  effectivePayments: readonly DebtPaymentResult[],
  original: DebtPaymentResult,
  input: DebtPaymentCorrectionDraft,
): DebtPaymentCorrectionDecision {
  const draft = validateCorrectionDraft(input);
  if (original.id !== draft.originalPaymentId || original.debtId !== debt.id)
    throw new DomainError('INVALID_PAYMENT');
  if (original.status !== 'confirmed')
    throw new DomainError('PAYMENT_NOT_CONFIRMED');
  const matches = effectivePayments.filter(
    (payment) => payment.id === original.id,
  );
  if (matches.length === 0) throw new DomainError('PAYMENT_ALREADY_CORRECTED');
  if (matches.length !== 1 || matches[0]?.status !== 'confirmed')
    throw new DomainError('INVALID_PAYMENT');
  const current = buildDebtStatus(debt, effectivePayments);
  const remaining = effectivePayments.filter(
    (payment) => payment.id !== original.id,
  );
  const withoutOriginal = buildDebtStatus(debt, remaining);
  if (!draft.replacement)
    return Object.freeze({
      status: 'applied',
      reviewReason: null,
      estimatedBalanceAfter: withoutOriginal.estimatedBalance,
      replacementDecision: null,
    });
  const candidate = decidePayment(debt, withoutOriginal, {
    debtId: debt.id,
    ...draft.replacement,
    actorRef: draft.actorRef,
    recordedAt: draft.recordedAt,
  });
  if (candidate.status === 'review_required')
    return Object.freeze({
      status: 'review_required',
      reviewReason: candidate.reviewReason,
      estimatedBalanceAfter: current.estimatedBalance,
      replacementDecision: null,
    });
  return Object.freeze({
    status: 'applied',
    reviewReason: null,
    estimatedBalanceAfter: candidate.estimatedBalanceAfter,
    replacementDecision: candidate,
  });
}
