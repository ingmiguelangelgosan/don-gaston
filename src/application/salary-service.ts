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
  validateCloseDraft,
  validateOpeningDraft,
  validateSalaryPaymentDraft,
  validateSalaryVersionDraft,
} from '../domain/salary-receivables.ts';
import type {
  CloseDraft,
  OpeningDraft,
  SalaryPaymentDraft,
  SalaryPeriod,
  SalaryReceipt,
  SalaryVersion,
  SalaryVersionDraft,
} from '../domain/salary-receivables.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { SalaryStore } from './salary-store.ts';

export interface SalaryVersionInput {
  readonly netAmount: string;
  readonly effectiveFrom: string;
  readonly dueDay?: number;
  readonly currency?: string;
}
export interface OpeningPeriodInput {
  readonly month: string;
  readonly amount: string;
  readonly asOf: string;
  readonly dueDay?: number;
  readonly currency?: string;
}
export interface ClosePeriodInput {
  readonly month: string;
  readonly closedOn: string;
}
export interface SalaryPaymentInput {
  readonly amount: string;
  readonly receivedOn: string;
  readonly reference: string;
  readonly currency?: string;
}
function fingerprint(fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export function salaryVersionFingerprint(draft: SalaryVersionDraft): string {
  return fingerprint([
    'salary:configure:v1',
    draft.netAmount.minor.toString(),
    draft.netAmount.currency,
    draft.effectiveFrom,
    draft.dueDay,
  ]);
}
export function openingPeriodFingerprint(draft: OpeningDraft): string {
  return fingerprint([
    'salary:import-period:v1',
    draft.month,
    draft.amount.minor.toString(),
    draft.amount.currency,
    draft.asOf,
    draft.dueDay,
  ]);
}
export function closePeriodFingerprint(draft: CloseDraft): string {
  return fingerprint(['salary:close:v1', draft.month, draft.closedOn]);
}
export function salaryPaymentFingerprint(draft: SalaryPaymentDraft): string {
  return fingerprint([
    'salary:receive:v1',
    draft.amount.minor.toString(),
    draft.amount.currency,
    draft.receivedOn,
    draft.reference,
  ]);
}

export class SalaryService {
  readonly #store: SalaryStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;
  constructor(
    store: SalaryStore,
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
  configureSalary(
    context: AccessContext,
    key: string,
    input: SalaryVersionInput,
  ): SalaryVersion {
    const scope = this.#authorize(context, 'salary:configure');
    identifier(key);
    exactFields(input, ['netAmount', 'effectiveFrom', 'dueDay', 'currency']);
    const draft = validateSalaryVersionDraft({
      kind: 'salary-version',
      netAmount: Money.fromDecimal(input.netAmount, input.currency),
      effectiveFrom: input.effectiveFrom,
      dueDay: input.dueDay === undefined ? 5 : input.dueDay,
      actorRef: scope.actorRef,
      recordedAt: this.#clock(),
    });
    return this.#store.configureSalary(
      scope,
      key,
      salaryVersionFingerprint(draft),
      draft,
    );
  }
  importPendingPeriod(
    context: AccessContext,
    key: string,
    input: OpeningPeriodInput,
  ): SalaryPeriod {
    const scope = this.#authorize(context, 'salary:close');
    identifier(key);
    exactFields(input, ['month', 'amount', 'asOf', 'dueDay', 'currency']);
    const draft = validateOpeningDraft({
      month: input.month,
      amount: Money.fromDecimal(input.amount, input.currency),
      asOf: input.asOf,
      dueDay: input.dueDay === undefined ? 5 : input.dueDay,
      actorRef: scope.actorRef,
      recordedAt: this.#clock(),
    });
    return this.#store.importPendingPeriod(
      scope,
      key,
      openingPeriodFingerprint(draft),
      draft,
    );
  }
  closePeriod(
    context: AccessContext,
    key: string,
    input: ClosePeriodInput,
  ): SalaryPeriod {
    const scope = this.#authorize(context, 'salary:close');
    identifier(key);
    exactFields(input, ['month', 'closedOn']);
    const draft = validateCloseDraft({
      month: input.month,
      closedOn: input.closedOn,
      actorRef: scope.actorRef,
      recordedAt: this.#clock(),
    });
    return this.#store.closePeriod(
      scope,
      key,
      closePeriodFingerprint(draft),
      draft,
    );
  }
  receivePayment(
    context: AccessContext,
    key: string,
    input: SalaryPaymentInput,
  ): SalaryReceipt {
    const scope = this.#authorize(context, 'salary:receive');
    identifier(key);
    exactFields(input, ['amount', 'receivedOn', 'reference', 'currency']);
    const draft = validateSalaryPaymentDraft({
      amount: Money.fromDecimal(input.amount, input.currency),
      receivedOn: input.receivedOn,
      reference: input.reference,
      actorRef: scope.actorRef,
      recordedAt: this.#clock(),
    });
    return this.#store.receivePayment(
      scope,
      key,
      salaryPaymentFingerprint(draft),
      draft,
    );
  }
  getReceivables(context: AccessContext, query: { readonly asOf: string }) {
    const scope = this.#authorize(context, 'salary:read');
    exactFields(query, ['asOf']);
    return this.#store.getReceivables(scope, calendarDate(query.asOf));
  }
  getPayment(context: AccessContext, id: string) {
    return this.#store.getPayment(
      this.#authorize(context, 'salary:read'),
      identifier(id),
    );
  }
  monthlyCashInflow(context: AccessContext, query: { readonly month: string }) {
    const scope = this.#authorize(context, 'salary:read');
    exactFields(query, ['month']);
    return this.#store.monthlyCashInflow(scope, calendarMonth(query.month));
  }
  findIntent(
    context: AccessContext,
    key: string,
  ): SalaryVersion | SalaryPeriod | SalaryReceipt | undefined {
    const result = this.#store.findIntent(
      this.#authorize(context, 'salary:read'),
      identifier(key),
    );
    return result?.kind === 'salary-version' ||
      result?.kind === 'salary-period' ||
      result?.kind === 'salary-payment'
      ? result
      : undefined;
  }
}
