import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import {
  calendarDate,
  calendarMonth,
  exactFields,
  identifier,
} from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import { validateBillCommand } from '../domain/recurring-bills.ts';
import type {
  BillCommand,
  BillConcept,
  BillObligation,
  BillAdjustment,
  BillPayment,
  BillResult,
  BillListQuery,
} from '../domain/recurring-bills.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { RecurringBillStore } from './recurring-bill-store.ts';

export interface BillConceptInput {
  readonly description: string;
  readonly categoryId: string;
  readonly currency?: string;
  readonly fixedAmount?: string;
  readonly dueDay?: number;
  readonly dueMonthOffset?: 0 | 1;
}
export interface BillGenerateInput {
  readonly conceptId: string;
  readonly month: string;
  readonly generatedOn: string;
  readonly amount?: string;
  readonly amountStatus?: 'estimated' | 'confirmed';
  readonly dueOn?: string | null;
  readonly currency?: string;
}
export interface BillAdjustmentInput {
  readonly obligationId: string;
  readonly expectedRevisionId: string;
  readonly amount: string;
  readonly amountStatus: 'estimated' | 'confirmed';
  readonly reason: string;
  readonly currency?: string;
}
export interface BillPaymentInput {
  readonly obligationId: string;
  readonly expectedRevisionId: string;
  readonly amount: string;
  readonly paidOn: string;
  readonly reference: string;
  readonly currency?: string;
}
export function billFingerprint(command: BillCommand): string {
  let fields: readonly unknown[];
  switch (command.operation) {
    case 'concept': {
      const d = command.draft;
      fields = [
        d.description,
        d.categoryId,
        d.currency,
        d.fixedAmount,
        d.dueDay,
        d.dueMonthOffset,
      ];
      break;
    }
    case 'generate': {
      const d = command.draft;
      fields = [
        d.conceptId,
        d.month,
        d.generatedOn,
        d.amount,
        d.amountStatus,
        d.dueOn,
        d.overrideDueOn,
      ];
      break;
    }
    case 'adjust': {
      const d = command.draft;
      fields = [
        d.obligationId,
        d.expectedRevisionId,
        d.amount,
        d.amountStatus,
        d.reason,
      ];
      break;
    }
    case 'pay': {
      const d = command.draft;
      fields = [
        d.obligationId,
        d.expectedRevisionId,
        d.amount,
        d.paidOn,
        d.reference,
      ];
      break;
    }
  }
  return createHash('sha256')
    .update(JSON.stringify([`bill:${command.operation}:v1`, ...fields]))
    .digest('hex');
}
function currency(value: string | undefined): 'COP' {
  if (value !== undefined && value !== 'COP')
    throw new DomainError('UNSUPPORTED_CURRENCY');
  return 'COP';
}
export class RecurringBillService {
  readonly #store: RecurringBillStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: RecurringBillStore,
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
  #execute(
    scope: AccessContext,
    key: string,
    command: BillCommand,
  ): BillResult {
    identifier(key);
    const checked = validateBillCommand(command);
    return this.#store.executeBill(
      scope,
      key,
      billFingerprint(checked),
      checked,
    );
  }
  createConcept(
    context: AccessContext,
    key: string,
    input: BillConceptInput,
  ): BillConcept {
    const bound = this.#authorize(context, 'bill:write');
    exactFields(input, [
      'description',
      'categoryId',
      'currency',
      'fixedAmount',
      'dueDay',
      'dueMonthOffset',
    ]);
    const coin = currency(input.currency);
    if (
      (input.dueDay === undefined) !== (input.dueMonthOffset === undefined) ||
      input.dueDay === null ||
      input.dueMonthOffset === null
    )
      throw new DomainError('INVALID_BILL_DUE_RULE');
    return this.#execute(bound, key, {
      operation: 'concept',
      draft: {
        description: input.description,
        categoryId: input.categoryId,
        currency: coin,
        fixedAmount:
          input.fixedAmount === undefined
            ? null
            : Money.fromDecimal(input.fixedAmount, coin),
        dueDay: input.dueDay === undefined ? null : input.dueDay,
        dueMonthOffset:
          input.dueMonthOffset === undefined ? null : input.dueMonthOffset,
        actorRef: bound.actorRef,
        recordedAt: this.#clock(),
      },
    }) as BillConcept;
  }
  generateObligation(
    context: AccessContext,
    key: string,
    input: BillGenerateInput,
  ): BillObligation {
    const bound = this.#authorize(context, 'bill:write');
    exactFields(input, [
      'conceptId',
      'month',
      'generatedOn',
      'amount',
      'amountStatus',
      'dueOn',
      'currency',
    ]);
    const coin = currency(input.currency);
    if (
      (input.amount === undefined) !== (input.amountStatus === undefined) ||
      input.amountStatus === null
    )
      throw new DomainError('INVALID_BILL_AMOUNT_STATUS');
    return this.#execute(bound, key, {
      operation: 'generate',
      draft: {
        conceptId: input.conceptId,
        month: input.month,
        generatedOn: input.generatedOn,
        amount:
          input.amount === undefined
            ? null
            : Money.fromDecimal(input.amount, coin),
        amountStatus:
          input.amountStatus === undefined ? null : input.amountStatus,
        dueOn: input.dueOn === undefined ? null : input.dueOn,
        overrideDueOn: input.dueOn !== undefined,
        actorRef: bound.actorRef,
        recordedAt: this.#clock(),
      },
    }) as BillObligation;
  }
  adjustObligation(
    context: AccessContext,
    key: string,
    input: BillAdjustmentInput,
  ): BillAdjustment {
    const bound = this.#authorize(context, 'bill:write');
    exactFields(input, [
      'obligationId',
      'expectedRevisionId',
      'amount',
      'amountStatus',
      'reason',
      'currency',
    ]);
    return this.#execute(bound, key, {
      operation: 'adjust',
      draft: {
        obligationId: input.obligationId,
        expectedRevisionId: input.expectedRevisionId,
        amount: Money.fromDecimal(input.amount, currency(input.currency)),
        amountStatus: input.amountStatus,
        reason: input.reason,
        actorRef: bound.actorRef,
        recordedAt: this.#clock(),
      },
    }) as BillAdjustment;
  }
  confirmPayment(
    context: AccessContext,
    key: string,
    input: BillPaymentInput,
  ): BillPayment {
    const bound = this.#authorize(context, 'bill:pay');
    exactFields(input, [
      'obligationId',
      'expectedRevisionId',
      'amount',
      'paidOn',
      'reference',
      'currency',
    ]);
    return this.#execute(bound, key, {
      operation: 'pay',
      draft: {
        obligationId: input.obligationId,
        expectedRevisionId: input.expectedRevisionId,
        amount: Money.fromDecimal(input.amount, currency(input.currency)),
        paidOn: input.paidOn,
        reference: input.reference,
        actorRef: bound.actorRef,
        recordedAt: this.#clock(),
      },
    }) as BillPayment;
  }
  getObligation(
    context: AccessContext,
    id: string,
    query: { readonly asOf: string },
  ) {
    const bound = this.#authorize(context, 'bill:read');
    exactFields(query, ['asOf']);
    return this.#store.getObligation(
      bound,
      identifier(id),
      calendarDate(query.asOf),
    );
  }
  listObligations(context: AccessContext, query: BillListQuery) {
    const bound = this.#authorize(context, 'bill:read');
    exactFields(query, ['asOf', 'conceptId']);
    const asOf = calendarDate(query.asOf);
    return this.#store.listObligations(
      bound,
      query.conceptId === undefined
        ? { asOf }
        : { asOf, conceptId: identifier(query.conceptId) },
    );
  }
  monthlyCashOutflow(
    context: AccessContext,
    query: { readonly month: string },
  ) {
    const bound = this.#authorize(context, 'bill:read');
    exactFields(query, ['month']);
    return this.#store.monthlyBillCashOutflow(
      bound,
      calendarMonth(query.month),
    );
  }
  findIntent(context: AccessContext, key: string): BillResult | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'bill:read'),
      identifier(key),
    );
    return result?.kind === 'bill-concept' ||
      result?.kind === 'bill-obligation' ||
      result?.kind === 'bill-adjustment' ||
      result?.kind === 'bill-payment'
      ? result
      : undefined;
  }
}
