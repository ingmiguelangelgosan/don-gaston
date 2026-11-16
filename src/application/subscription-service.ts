import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import {
  calendarDate,
  calendarMonth,
  exactFields,
  identifier,
} from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import { validateSubscriptionCommand } from '../domain/subscriptions.ts';
import type {
  Subscription,
  SubscriptionParticipants,
  SubscriptionObligation,
  SubscriptionPayment,
  SubscriptionReimbursement,
  SubscriptionCommand,
  SubscriptionResult,
  SubscriptionListQuery,
  SubscriptionReceivablesQuery,
} from '../domain/subscriptions.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { SubscriptionStore } from './subscription-store.ts';

export interface SubscriptionCreateInput {
  readonly name: string;
  readonly categoryId: string;
  readonly mode: 'personal' | 'shared';
  readonly monthlyAmount: string;
  readonly currency?: string;
  readonly effectiveMonth: string;
  readonly includesHolder: boolean;
  readonly counterpartyIds: readonly string[];
}
export interface SubscriptionChangeInput {
  readonly subscriptionId: string;
  readonly effectiveMonth: string;
  readonly includesHolder: boolean;
  readonly counterpartyIds: readonly string[];
}
export interface SubscriptionGenerateInput {
  readonly subscriptionId: string;
  readonly month: string;
  readonly generatedOn: string;
}
export interface SubscriptionPayInput {
  readonly obligationId: string;
  readonly amount: string;
  readonly currency?: string;
  readonly paidOn: string;
  readonly reference: string;
}
export interface SubscriptionReimburseInput {
  readonly counterpartyId: string;
  readonly amount: string;
  readonly currency?: string;
  readonly receivedOn: string;
  readonly reference: string;
}
export function subscriptionFingerprint(command: SubscriptionCommand): string {
  const { actorRef, recordedAt, ...financial } = command.draft;
  // Actor and audit timestamp do not change the financial intention on retry.
  void actorRef;
  void recordedAt;
  return createHash('sha256')
    .update(JSON.stringify([`subscription:${command.operation}:v1`, financial]))
    .digest('hex');
}
export class SubscriptionService {
  readonly #store: SubscriptionStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: SubscriptionStore,
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
    context: AccessContext,
    key: string,
    command: SubscriptionCommand,
  ): SubscriptionResult {
    identifier(key);
    const checked = validateSubscriptionCommand(command);
    return this.#store.executeSubscription(
      context,
      key,
      subscriptionFingerprint(checked),
      checked,
    );
  }
  createSubscription(
    context: AccessContext,
    key: string,
    input: SubscriptionCreateInput,
  ): Subscription {
    const scope = this.#authorize(context, 'subscription:write');
    exactFields(input, [
      'name',
      'categoryId',
      'mode',
      'monthlyAmount',
      'currency',
      'effectiveMonth',
      'includesHolder',
      'counterpartyIds',
    ]);
    return this.#execute(scope, key, {
      operation: 'create',
      draft: {
        name: input.name,
        categoryId: input.categoryId,
        mode: input.mode,
        monthlyAmount: Money.fromDecimal(input.monthlyAmount, input.currency),
        effectiveMonth: input.effectiveMonth,
        includesHolder: input.includesHolder,
        counterpartyIds: input.counterpartyIds,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as Subscription;
  }
  changeParticipants(
    context: AccessContext,
    key: string,
    input: SubscriptionChangeInput,
  ): SubscriptionParticipants {
    const scope = this.#authorize(context, 'subscription:write');
    exactFields(input, [
      'subscriptionId',
      'effectiveMonth',
      'includesHolder',
      'counterpartyIds',
    ]);
    return this.#execute(scope, key, {
      operation: 'change',
      draft: {
        subscriptionId: input.subscriptionId,
        effectiveMonth: input.effectiveMonth,
        includesHolder: input.includesHolder,
        counterpartyIds: input.counterpartyIds,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as SubscriptionParticipants;
  }
  generateObligation(
    context: AccessContext,
    key: string,
    input: SubscriptionGenerateInput,
  ): SubscriptionObligation {
    const scope = this.#authorize(context, 'subscription:write');
    exactFields(input, ['subscriptionId', 'month', 'generatedOn']);
    return this.#execute(scope, key, {
      operation: 'generate',
      draft: {
        subscriptionId: input.subscriptionId,
        month: input.month,
        generatedOn: input.generatedOn,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as SubscriptionObligation;
  }
  confirmPayment(
    context: AccessContext,
    key: string,
    input: SubscriptionPayInput,
  ): SubscriptionPayment {
    const scope = this.#authorize(context, 'subscription:pay');
    exactFields(input, [
      'obligationId',
      'amount',
      'currency',
      'paidOn',
      'reference',
    ]);
    return this.#execute(scope, key, {
      operation: 'pay',
      draft: {
        obligationId: input.obligationId,
        amount: Money.fromDecimal(input.amount, input.currency),
        paidOn: input.paidOn,
        reference: input.reference,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as SubscriptionPayment;
  }
  receiveReimbursement(
    context: AccessContext,
    key: string,
    input: SubscriptionReimburseInput,
  ): SubscriptionReimbursement {
    const scope = this.#authorize(context, 'subscription:receive');
    exactFields(input, [
      'counterpartyId',
      'amount',
      'currency',
      'receivedOn',
      'reference',
    ]);
    return this.#execute(scope, key, {
      operation: 'reimburse',
      draft: {
        counterpartyId: input.counterpartyId,
        amount: Money.fromDecimal(input.amount, input.currency),
        receivedOn: input.receivedOn,
        reference: input.reference,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as SubscriptionReimbursement;
  }
  getObligation(
    context: AccessContext,
    query: { readonly obligationId: string; readonly asOf: string },
  ) {
    const scope = this.#authorize(context, 'subscription:read');
    exactFields(query, ['obligationId', 'asOf']);
    return this.#store.getSubscriptionObligation(
      scope,
      identifier(query.obligationId),
      calendarDate(query.asOf),
    );
  }
  listObligations(context: AccessContext, query: SubscriptionListQuery) {
    const scope = this.#authorize(context, 'subscription:read');
    exactFields(query, ['asOf', 'subscriptionId']);
    return this.#store.listSubscriptionObligations(scope, {
      asOf: calendarDate(query.asOf),
      ...(query.subscriptionId === undefined
        ? {}
        : { subscriptionId: identifier(query.subscriptionId) }),
    });
  }
  getReceivables(context: AccessContext, query: SubscriptionReceivablesQuery) {
    const scope = this.#authorize(context, 'subscription:read');
    exactFields(query, ['counterpartyId', 'asOf']);
    return this.#store.getSubscriptionReceivables(scope, {
      counterpartyId: identifier(query.counterpartyId),
      asOf: calendarDate(query.asOf),
    });
  }
  monthlyCashFlow(context: AccessContext, query: { readonly month: string }) {
    const scope = this.#authorize(context, 'subscription:read');
    exactFields(query, ['month']);
    return this.#store.monthlySubscriptionCashFlow(
      scope,
      calendarMonth(query.month),
    );
  }
  findIntent(
    context: AccessContext,
    key: string,
  ): SubscriptionResult | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'subscription:read'),
      identifier(key),
    );
    return result?.kind === 'subscription' ||
      result?.kind === 'subscription-participants' ||
      result?.kind === 'subscription-obligation' ||
      result?.kind === 'subscription-payment' ||
      result?.kind === 'subscription-reimbursement'
      ? result
      : undefined;
  }
}
