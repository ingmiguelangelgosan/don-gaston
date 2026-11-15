import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { exactFields, identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import { validateCorrectionDraft } from '../domain/debt-payment-corrections.ts';
import type {
  DebtPaymentCorrection,
  DebtPaymentCorrectionDraft,
} from '../domain/debt-payment-corrections.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { DebtPaymentCorrectionStore } from './debt-payment-correction-store.ts';

export interface DebtPaymentReplacementInput {
  readonly installmentNumber: number;
  readonly amount: string;
  readonly currency: string;
  readonly paidOn: string;
  readonly reference: string;
}

export function paymentCorrectionFingerprint(
  draft: Pick<
    DebtPaymentCorrectionDraft,
    'originalPaymentId' | 'reason' | 'replacement'
  >,
): string {
  const proposed = draft.replacement;
  const fields: (string | number)[] = [
    proposed ? 'debt:replace-payment:v1' : 'debt:void-payment:v1',
    draft.originalPaymentId,
    draft.reason,
  ];
  if (proposed)
    fields.push(
      proposed.installmentNumber,
      proposed.amount.minor.toString(),
      proposed.amount.currency,
      proposed.paidOn,
      proposed.reference,
    );
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export class DebtPaymentCorrectionsService {
  readonly #store: DebtPaymentCorrectionStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: DebtPaymentCorrectionStore,
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
  voidPayment(
    context: AccessContext,
    key: string,
    input: { readonly paymentId: string; readonly reason: string },
  ) {
    const bound = this.#authorize(context, 'debt:correct');
    identifier(key);
    exactFields(input, ['paymentId', 'reason']);
    const draft = validateCorrectionDraft({
      originalPaymentId: input.paymentId,
      reason: input.reason,
      actorRef: bound.actorRef,
      recordedAt: this.#clock(),
      replacement: null,
    });
    return this.#store.correctPayment(
      bound,
      key,
      paymentCorrectionFingerprint(draft),
      draft,
    );
  }
  replacePayment(
    context: AccessContext,
    key: string,
    input: {
      readonly paymentId: string;
      readonly reason: string;
      readonly replacement: DebtPaymentReplacementInput;
    },
  ) {
    const bound = this.#authorize(context, 'debt:correct');
    identifier(key);
    exactFields(input, ['paymentId', 'reason', 'replacement']);
    exactFields(input.replacement, [
      'installmentNumber',
      'amount',
      'currency',
      'paidOn',
      'reference',
    ]);
    if (typeof input.replacement.currency !== 'string')
      throw new DomainError('INVALID_INPUT');
    const draft = validateCorrectionDraft({
      originalPaymentId: input.paymentId,
      reason: input.reason,
      actorRef: bound.actorRef,
      recordedAt: this.#clock(),
      replacement: {
        installmentNumber: input.replacement.installmentNumber,
        amount: Money.fromDecimal(
          input.replacement.amount,
          input.replacement.currency,
        ),
        paidOn: input.replacement.paidOn,
        reference: input.replacement.reference,
      },
    });
    return this.#store.correctPayment(
      bound,
      key,
      paymentCorrectionFingerprint(draft),
      draft,
    );
  }
  getPaymentHistory(context: AccessContext, paymentId: string) {
    return this.#store.getPaymentHistory(
      this.#authorize(context, 'debt:read'),
      identifier(paymentId),
    );
  }
  findIntent(
    context: AccessContext,
    key: string,
  ): DebtPaymentCorrection | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'debt:read'),
      identifier(key),
    );
    return result?.kind === 'debt-payment-correction' ? result : undefined;
  }
}
