import { DomainError } from './errors.ts';
import { correctionTime } from './expense-corrections.ts';
import { calendarDate, identifier } from './expenses.ts';
import { Money } from './money.ts';

export const FINANCED_DEBT_LIMITS = Object.freeze({
  maxInstallments: 1200,
  maxDescriptionLength: 200,
  maxTermsLength: 1000,
  maxReferenceLength: 128,
  maxRateLength: 100,
});

/** Immutable opening information, reported by the authorized actor, not a bank feed. */
export interface FinancedDebt {
  readonly kind: 'financed-debt';
  readonly id: string;
  readonly description: string;
  readonly financedAmount: Money;
  readonly installmentCount: number;
  readonly installmentAmount: Money;
  readonly referenceOn: string;
  readonly referenceBalance: Money;
  readonly historicalPaidInstallments: number;
  readonly historicalPaidAmount: Money | null;
  /** Exact decimal percentage E.A.; stored only, never an amortization promise. */
  readonly annualEffectiveRate: string | null;
  readonly terms: string | null;
  readonly actorRef: string;
  readonly recordedAt: string;
}

export interface DebtPaymentDraft {
  readonly debtId: string;
  readonly installmentNumber: number;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export type DebtPaymentReviewReason =
  'EXCEEDS_ESTIMATED_BALANCE' | 'EXCEEDS_INSTALLMENT_REMAINDER';
export interface DebtPaymentDecision {
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason: DebtPaymentReviewReason | null;
  readonly estimatedBalanceAfter: Money;
}
/** Confirmed result is the cash fact itself. Review results have no cash effect. */
export interface DebtPaymentResult
  extends DebtPaymentDraft, DebtPaymentDecision {
  readonly kind: 'debt-payment';
  readonly id: string;
}
export interface DebtInstallmentStatus {
  readonly number: number;
  readonly status: 'historical' | 'pending' | 'partial' | 'paid';
  /** Historical opening totals do not invent per-installment allocations. */
  readonly paid: Money | null;
  readonly pending: Money | null;
}
export interface DebtStatus {
  readonly debt: FinancedDebt;
  readonly estimatedBalance: Money;
  readonly balanceKind: 'estimated';
  readonly principalBalance: null;
  readonly interestPaid: null;
  readonly requiresReview: boolean;
  readonly payments: readonly DebtPaymentResult[];
  /** Current confirmed facts only; payments retains the complete record history. */
  readonly effectivePayments: readonly DebtPaymentResult[];
  readonly installments: readonly DebtInstallmentStatus[];
  readonly confirmedPaymentsTotal: Money;
}
export interface DebtMonthlyCashOutflow {
  readonly month: string;
  readonly currency: 'COP';
  readonly total: Money;
  /** Only these confirmed debt payments, not overall cash flow or consumption. */
  readonly payments: readonly DebtPaymentResult[];
}

export function debtText(
  value: string,
  maximum: number,
  code = 'INVALID_DEBT',
): string {
  if (typeof value !== 'string') throw new DomainError(code);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  )
    throw new DomainError(code);
  return normalized;
}

export function annualEffectiveRate(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > FINANCED_DEBT_LIMITS.maxRateLength ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)
  )
    throw new DomainError('INVALID_RATE');
  const [whole = '', fraction = ''] = value.split('.');
  const significant = fraction.replace(/0+$/u, '');
  return significant ? `${whole}.${significant}` : whole;
}

function count(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new DomainError(code);
  return value;
}
function money(value: Money, positive: boolean, code: string): Money {
  if (!(value instanceof Money) || (positive && value.minor === 0n))
    throw new DomainError(code);
  return Money.fromMinor(value.minor, value.currency);
}

export function validateDebtDraft(
  draft: Omit<FinancedDebt, 'id'>,
): Omit<FinancedDebt, 'id'> {
  if (draft.kind !== 'financed-debt') throw new DomainError('INVALID_DEBT');
  const installmentCount = count(
    draft.installmentCount,
    1,
    FINANCED_DEBT_LIMITS.maxInstallments,
    'INVALID_DEBT',
  );
  return Object.freeze({
    kind: 'financed-debt',
    description: debtText(
      draft.description,
      FINANCED_DEBT_LIMITS.maxDescriptionLength,
    ),
    financedAmount: money(draft.financedAmount, true, 'INVALID_DEBT'),
    installmentCount,
    installmentAmount: money(draft.installmentAmount, true, 'INVALID_DEBT'),
    referenceOn: calendarDate(draft.referenceOn),
    referenceBalance: money(draft.referenceBalance, false, 'INVALID_DEBT'),
    historicalPaidInstallments: count(
      draft.historicalPaidInstallments,
      0,
      installmentCount,
      'INVALID_DEBT',
    ),
    historicalPaidAmount:
      draft.historicalPaidAmount === null
        ? null
        : money(draft.historicalPaidAmount, false, 'INVALID_DEBT'),
    annualEffectiveRate:
      draft.annualEffectiveRate === null
        ? null
        : annualEffectiveRate(draft.annualEffectiveRate),
    terms:
      draft.terms === null
        ? null
        : debtText(draft.terms, FINANCED_DEBT_LIMITS.maxTermsLength),
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}

export function validatePaymentDraft(
  draft: DebtPaymentDraft,
): DebtPaymentDraft {
  return Object.freeze({
    debtId: identifier(draft.debtId),
    installmentNumber: count(
      draft.installmentNumber,
      1,
      FINANCED_DEBT_LIMITS.maxInstallments,
      'INVALID_PAYMENT',
    ),
    amount: money(draft.amount, true, 'INVALID_PAYMENT'),
    paidOn: calendarDate(draft.paidOn),
    reference: debtText(
      draft.reference,
      FINANCED_DEBT_LIMITS.maxReferenceLength,
      'INVALID_PAYMENT',
    ),
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}

/** Nominal installment progress and estimated balance are separate projections. */
export function buildDebtStatus(
  debt: FinancedDebt,
  payments: readonly DebtPaymentResult[],
): DebtStatus {
  const paidByInstallment = new Map<number, bigint>();
  let total = 0n;
  for (const payment of payments) {
    if (payment.debtId !== debt.id) throw new DomainError('INVALID_PAYMENT');
    if (payment.status !== 'confirmed') continue;
    total += payment.amount.minor;
    paidByInstallment.set(
      payment.installmentNumber,
      (paidByInstallment.get(payment.installmentNumber) ?? 0n) +
        payment.amount.minor,
    );
  }
  if (total > debt.referenceBalance.minor)
    throw new DomainError('INVALID_DEBT');
  const estimatedBalance = Money.fromMinor(debt.referenceBalance.minor - total);
  const installments: DebtInstallmentStatus[] = [];
  for (let number = 1; number <= debt.installmentCount; number++) {
    if (number <= debt.historicalPaidInstallments) {
      installments.push(
        Object.freeze({
          number,
          status: 'historical',
          paid: null,
          pending: null,
        }),
      );
      continue;
    }
    const paid = paidByInstallment.get(number) ?? 0n;
    if (paid > debt.installmentAmount.minor)
      throw new DomainError('INVALID_PAYMENT');
    const pending = debt.installmentAmount.minor - paid;
    installments.push(
      Object.freeze({
        number,
        status: pending === 0n ? 'paid' : paid === 0n ? 'pending' : 'partial',
        paid: Money.fromMinor(paid),
        pending: Money.fromMinor(pending),
      }),
    );
  }
  const hasPendingInstallments = installments.some(
    (item) => item.status === 'pending' || item.status === 'partial',
  );
  const requiresReview =
    (estimatedBalance.minor === 0n && hasPendingInstallments) ||
    (estimatedBalance.minor > 0n && !hasPendingInstallments) ||
    (debt.historicalPaidInstallments === 0 &&
      (debt.historicalPaidAmount?.minor ?? 0n) > 0n);
  return Object.freeze({
    debt,
    estimatedBalance,
    balanceKind: 'estimated',
    principalBalance: null,
    interestPaid: null,
    requiresReview,
    payments: Object.freeze([...payments]),
    effectivePayments: Object.freeze(
      payments.filter((payment) => payment.status === 'confirmed'),
    ),
    installments: Object.freeze(installments),
    confirmedPaymentsTotal: Money.fromMinor(total),
  });
}

export function decidePayment(
  debt: FinancedDebt,
  status: DebtStatus,
  input: DebtPaymentDraft,
): DebtPaymentDecision {
  const draft = validatePaymentDraft(input);
  if (
    draft.debtId !== debt.id ||
    status.debt.id !== debt.id ||
    draft.paidOn < debt.referenceOn ||
    draft.installmentNumber <= debt.historicalPaidInstallments ||
    draft.installmentNumber > debt.installmentCount
  )
    throw new DomainError('INVALID_PAYMENT');
  const installment = status.installments[draft.installmentNumber - 1];
  if (!installment || installment.pending === null)
    throw new DomainError('INVALID_PAYMENT');
  const reviewReason =
    draft.amount.minor > status.estimatedBalance.minor
      ? 'EXCEEDS_ESTIMATED_BALANCE'
      : draft.amount.minor > installment.pending.minor
        ? 'EXCEEDS_INSTALLMENT_REMAINDER'
        : null;
  return Object.freeze({
    status: reviewReason ? 'review_required' : 'confirmed',
    reviewReason,
    estimatedBalanceAfter: reviewReason
      ? status.estimatedBalance
      : Money.fromMinor(status.estimatedBalance.minor - draft.amount.minor),
  });
}
