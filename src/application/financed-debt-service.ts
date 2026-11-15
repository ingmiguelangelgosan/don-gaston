import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { correctionTime } from '../domain/expense-corrections.ts';
import { calendarMonth, exactFields, identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  validateDebtDraft,
  validatePaymentDraft,
} from '../domain/financed-debts.ts';
import type {
  DebtPaymentDraft,
  DebtPaymentResult,
  FinancedDebt,
} from '../domain/financed-debts.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { FinancedDebtStore } from './financed-debt-store.ts';

export interface FinancedDebtInput {
  readonly description: string;
  readonly financedAmount: string;
  readonly installmentCount: number;
  readonly installmentAmount: string;
  readonly referenceOn: string;
  readonly referenceBalance: string;
  readonly historicalPaidInstallments: number;
  readonly historicalPaidAmount?: string;
  readonly annualEffectiveRate?: string;
  readonly terms?: string;
  readonly currency?: string;
}
export interface DebtPaymentInput {
  readonly debtId: string;
  readonly installmentNumber: number;
  readonly amount: string;
  readonly currency?: string;
  readonly paidOn: string;
  readonly reference: string;
}

export function debtFingerprint(draft: Omit<FinancedDebt, 'id'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'debt:register:v1',
        draft.description,
        draft.financedAmount.minor.toString(),
        draft.financedAmount.currency,
        draft.installmentCount,
        draft.installmentAmount.minor.toString(),
        draft.referenceOn,
        draft.referenceBalance.minor.toString(),
        draft.historicalPaidInstallments,
        draft.historicalPaidAmount?.minor.toString() ?? null,
        draft.annualEffectiveRate,
        draft.terms,
      ]),
    )
    .digest('hex');
}
export function paymentFingerprint(draft: DebtPaymentDraft): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'debt:confirm-payment:v1',
        draft.debtId,
        draft.installmentNumber,
        draft.amount.minor.toString(),
        draft.amount.currency,
        draft.paidOn,
        draft.reference,
      ]),
    )
    .digest('hex');
}

export class FinancedDebtService {
  readonly #store: FinancedDebtStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: FinancedDebtStore,
    policy: AccessPolicy,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.#store = store;
    this.#policy = policy;
    this.#clock = clock;
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
  registerDebt(
    context: AccessContext,
    key: string,
    input: FinancedDebtInput,
  ): FinancedDebt {
    const scope = this.#authorize(context, 'debt:write');
    identifier(key);
    exactFields(input, [
      'description',
      'financedAmount',
      'installmentCount',
      'installmentAmount',
      'referenceOn',
      'referenceBalance',
      'historicalPaidInstallments',
      'historicalPaidAmount',
      'annualEffectiveRate',
      'terms',
      'currency',
    ]);
    const draft = validateDebtDraft({
      kind: 'financed-debt',
      description: input.description,
      financedAmount: Money.fromDecimal(input.financedAmount, input.currency),
      installmentCount: input.installmentCount,
      installmentAmount: Money.fromDecimal(
        input.installmentAmount,
        input.currency,
      ),
      referenceOn: input.referenceOn,
      referenceBalance: Money.fromDecimal(
        input.referenceBalance,
        input.currency,
      ),
      historicalPaidInstallments: input.historicalPaidInstallments,
      historicalPaidAmount:
        input.historicalPaidAmount === undefined
          ? null
          : Money.fromDecimal(input.historicalPaidAmount, input.currency),
      annualEffectiveRate: input.annualEffectiveRate ?? null,
      terms: input.terms ?? null,
      actorRef: scope.actorRef,
      recordedAt: correctionTime(this.#clock()),
    });
    return this.#store.registerDebt(scope, key, debtFingerprint(draft), draft);
  }
  confirmPayment(
    context: AccessContext,
    key: string,
    input: DebtPaymentInput,
  ): DebtPaymentResult {
    const scope = this.#authorize(context, 'debt:pay');
    identifier(key);
    exactFields(input, [
      'debtId',
      'installmentNumber',
      'amount',
      'currency',
      'paidOn',
      'reference',
    ]);
    const draft = validatePaymentDraft({
      debtId: input.debtId,
      installmentNumber: input.installmentNumber,
      amount: Money.fromDecimal(input.amount, input.currency),
      paidOn: input.paidOn,
      reference: input.reference,
      actorRef: scope.actorRef,
      recordedAt: correctionTime(this.#clock()),
    });
    return this.#store.confirmPayment(
      scope,
      key,
      paymentFingerprint(draft),
      draft,
    );
  }
  getDebt(context: AccessContext, debtId: string) {
    return this.#store.getDebt(
      this.#authorize(context, 'debt:read'),
      identifier(debtId),
    );
  }
  monthlyCashOutflow(
    context: AccessContext,
    query: { readonly month: string },
  ) {
    const scope = this.#authorize(context, 'debt:read');
    exactFields(query, ['month']);
    return this.#store.monthlyCashOutflow(scope, calendarMonth(query.month));
  }
  findIntent(
    context: AccessContext,
    key: string,
  ): FinancedDebt | DebtPaymentResult | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'debt:read'),
      identifier(key),
    );
    return result?.kind === 'financed-debt' || result?.kind === 'debt-payment'
      ? result
      : undefined;
  }
}
