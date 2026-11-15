import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { calendarDate, exactFields, identifier } from '../domain/expenses.ts';
import {
  correctionReason,
  correctionTime,
} from '../domain/expense-corrections.ts';
import { Money } from '../domain/money.ts';
import type { ExpenseInput } from './expense-service.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type {
  CorrectionDraft,
  ExpenseCorrectionStore,
} from './expense-correction-store.ts';

export function correctionFingerprint(
  draft: Pick<CorrectionDraft, 'originalExpenseId' | 'reason' | 'replacement'>,
): string {
  const replacement = draft.replacement;
  const fields = [
    replacement ? 'expense:replace:v1' : 'expense:void:v1',
    draft.originalExpenseId,
    draft.reason,
  ];
  if (replacement)
    fields.push(
      replacement.amount.minor.toString(),
      replacement.amount.currency,
      replacement.categoryId,
      replacement.occurredOn,
    );
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export class ExpenseCorrectionsService {
  readonly #store: ExpenseCorrectionStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: ExpenseCorrectionStore,
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
  voidExpense(
    context: AccessContext,
    key: string,
    input: { readonly expenseId: string; readonly reason: string },
  ) {
    const bound = this.#authorize(context, 'expense:correct');
    identifier(key);
    exactFields(input, ['expenseId', 'reason']);
    const draft: CorrectionDraft = {
      originalExpenseId: identifier(input.expenseId),
      reason: correctionReason(input.reason),
      actorRef: bound.actorRef,
      recordedAt: correctionTime(this.#clock()),
      replacement: null,
    };
    return this.#store.correctExpense(
      bound,
      key,
      correctionFingerprint(draft),
      draft,
    );
  }
  replaceExpense(
    context: AccessContext,
    key: string,
    input: {
      readonly expenseId: string;
      readonly reason: string;
      readonly replacement: ExpenseInput & { readonly currency: string };
    },
  ) {
    const bound = this.#authorize(context, 'expense:correct');
    identifier(key);
    exactFields(input, ['expenseId', 'reason', 'replacement']);
    exactFields(input.replacement, [
      'amount',
      'currency',
      'categoryId',
      'occurredOn',
    ]);
    if (typeof input.replacement.currency !== 'string')
      throw new DomainError('INVALID_INPUT');
    const amount = Money.fromDecimal(
      input.replacement.amount,
      input.replacement.currency,
    );
    if (amount.minor === 0n) throw new DomainError('INVALID_MONEY');
    const draft: CorrectionDraft = {
      originalExpenseId: identifier(input.expenseId),
      reason: correctionReason(input.reason),
      actorRef: bound.actorRef,
      recordedAt: correctionTime(this.#clock()),
      replacement: {
        kind: 'expense',
        amount,
        actorRef: bound.actorRef,
        categoryId: identifier(input.replacement.categoryId),
        occurredOn: calendarDate(input.replacement.occurredOn),
      },
    };
    return this.#store.correctExpense(
      bound,
      key,
      correctionFingerprint(draft),
      draft,
    );
  }
  findIntent(context: AccessContext, key: string) {
    const result = this.#store.findIntent(
      this.#authorize(context, 'expense:read'),
      identifier(key),
    );
    return result?.kind === 'budget' ? undefined : result;
  }
  getExpenseHistory(context: AccessContext, expenseId: string) {
    return this.#store.getExpenseHistory(
      this.#authorize(context, 'expense:read'),
      identifier(expenseId),
    );
  }
}
