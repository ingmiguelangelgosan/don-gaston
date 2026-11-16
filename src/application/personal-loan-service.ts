import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import {
  calendarDate,
  calendarMonth,
  exactFields,
  identifier,
} from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  loanDirection,
  validateLoanCommand,
} from '../domain/personal-loans.ts';
import type {
  LoanCommand,
  LoanCounterparty,
  LoanDirection,
  LoanMovement,
  LoanPositionQuery,
  LoanResult,
} from '../domain/personal-loans.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { PersonalLoanStore } from './personal-loan-store.ts';

export interface LoanCounterpartyInput {
  readonly name: string;
}
export interface LoanMovementInput {
  readonly counterpartyId: string;
  readonly direction: LoanDirection;
  readonly amount: string;
  readonly currency?: string;
  readonly occurredOn: string;
  readonly reference: string;
}
export function loanFingerprint(command: LoanCommand): string {
  const fields =
    command.operation === 'counterparty'
      ? [command.draft.name]
      : [
          command.draft.counterpartyId,
          command.draft.direction,
          command.draft.amount,
          command.draft.occurredOn,
          command.draft.reference,
        ];
  return createHash('sha256')
    .update(JSON.stringify([`loan:${command.operation}:v1`, ...fields]))
    .digest('hex');
}
export class PersonalLoanService {
  readonly #store: PersonalLoanStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: PersonalLoanStore,
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
    command: LoanCommand,
  ): LoanResult {
    identifier(key);
    const checked = validateLoanCommand(command);
    return this.#store.executeLoan(
      scope,
      key,
      loanFingerprint(checked),
      checked,
    );
  }
  createCounterparty(
    context: AccessContext,
    key: string,
    input: LoanCounterpartyInput,
  ): LoanCounterparty {
    const scope = this.#authorize(context, 'loan:counterparty');
    exactFields(input, ['name']);
    return this.#execute(scope, key, {
      operation: 'counterparty',
      draft: {
        name: input.name,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as LoanCounterparty;
  }
  #movement(
    scope: AccessContext,
    key: string,
    input: LoanMovementInput,
    operation: 'disburse' | 'repay',
  ): LoanMovement {
    exactFields(input, [
      'counterpartyId',
      'direction',
      'amount',
      'currency',
      'occurredOn',
      'reference',
    ]);
    return this.#execute(scope, key, {
      operation,
      draft: {
        counterpartyId: input.counterpartyId,
        direction: input.direction,
        amount: Money.fromDecimal(input.amount, input.currency),
        occurredOn: input.occurredOn,
        reference: input.reference,
        actorRef: scope.actorRef,
        recordedAt: this.#clock(),
      },
    }) as LoanMovement;
  }
  recordDisbursement(
    context: AccessContext,
    key: string,
    input: LoanMovementInput,
  ): LoanMovement {
    return this.#movement(
      this.#authorize(context, 'loan:disburse'),
      key,
      input,
      'disburse',
    );
  }
  recordRepayment(
    context: AccessContext,
    key: string,
    input: LoanMovementInput,
  ): LoanMovement {
    return this.#movement(
      this.#authorize(context, 'loan:repay'),
      key,
      input,
      'repay',
    );
  }
  getPosition(context: AccessContext, query: LoanPositionQuery) {
    const scope = this.#authorize(context, 'loan:read');
    exactFields(query, ['counterpartyId', 'direction', 'asOf']);
    return this.#store.getLoanPosition(scope, {
      counterpartyId: identifier(query.counterpartyId),
      direction: loanDirection(query.direction),
      asOf: calendarDate(query.asOf),
    });
  }
  listPositions(context: AccessContext, query: { readonly asOf: string }) {
    const scope = this.#authorize(context, 'loan:read');
    exactFields(query, ['asOf']);
    return this.#store.listLoanPositions(scope, {
      asOf: calendarDate(query.asOf),
    });
  }
  monthlyCashFlow(context: AccessContext, query: { readonly month: string }) {
    const scope = this.#authorize(context, 'loan:read');
    exactFields(query, ['month']);
    return this.#store.monthlyLoanCashFlow(scope, calendarMonth(query.month));
  }
  findIntent(context: AccessContext, key: string): LoanResult | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'loan:read'),
      identifier(key),
    );
    return result?.kind === 'loan-counterparty' ||
      result?.kind === 'loan-movement'
      ? result
      : undefined;
  }
}
