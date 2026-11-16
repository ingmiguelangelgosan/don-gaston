import { DomainError } from './errors.ts';
import { correctionTime } from './expense-corrections.ts';
import { calendarDate, calendarMonth, identifier } from './expenses.ts';
import { Money } from './money.ts';

export interface SalaryVersion {
  readonly kind: 'salary-version';
  readonly id: string;
  readonly netAmount: Money;
  readonly effectiveFrom: string;
  readonly dueDay: number;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export type SalaryVersionDraft = Omit<SalaryVersion, 'id'>;

/** Opening amounts are remaining receivables, not invented historical earnings. */
export interface SalaryPeriod {
  readonly kind: 'salary-period';
  readonly id: string;
  readonly month: string;
  readonly amount: Money;
  readonly source: 'opening' | 'closed';
  readonly salaryVersionId: string | null;
  readonly availableOn: string;
  readonly dueOn: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export interface OpeningDraft {
  readonly month: string;
  readonly amount: Money;
  readonly asOf: string;
  readonly dueDay: number;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export interface CloseDraft {
  readonly month: string;
  readonly closedOn: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export interface SalaryPaymentDraft {
  readonly amount: Money;
  readonly receivedOn: string;
  readonly reference: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export type SalaryPaymentReviewReason =
  'EXCEEDS_PENDING_BALANCE' | 'PAYMENT_DATE_REQUIRES_REVIEW';
/** The confirmed receipt is the single cash fact; review results have no effect. */
export interface SalaryReceipt extends SalaryPaymentDraft {
  readonly kind: 'salary-payment';
  readonly id: string;
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason: SalaryPaymentReviewReason | null;
}
export interface SalaryAllocation {
  readonly paymentId: string;
  readonly periodId: string;
  readonly amount: Money;
}
export interface SalaryPeriodAllocation {
  readonly periodId: string;
  readonly month: string;
  readonly amount: Money;
}
export interface SalaryPaymentDecision {
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason: SalaryPaymentReviewReason | null;
  readonly allocations: readonly SalaryPeriodAllocation[];
}
export interface SalaryPaymentDetail {
  readonly payment: SalaryReceipt;
  readonly allocations: readonly SalaryPeriodAllocation[];
}
export interface SalaryPeriodBalance {
  readonly period: SalaryPeriod;
  readonly received: Money;
  readonly pending: Money;
  readonly status: 'paid' | 'pending' | 'overdue';
}
export interface SalaryReceivables {
  readonly asOf: string;
  readonly closedEarned: Money;
  readonly openingReceivable: Money;
  readonly received: Money;
  readonly pending: Money;
  readonly overdue: Money;
  readonly periods: readonly SalaryPeriodBalance[];
}
export interface SalaryMonthlyCashInflow {
  readonly month: string;
  readonly currency: 'COP';
  readonly total: Money;
  readonly payments: readonly SalaryReceipt[];
}

export interface SalaryState {
  readonly versions: readonly SalaryVersion[];
  readonly periods: readonly SalaryPeriod[];
  readonly payments: readonly SalaryReceipt[];
  readonly allocations: readonly SalaryAllocation[];
}
export type SalaryCommand =
  | { readonly operation: 'configure'; readonly draft: SalaryVersionDraft }
  | { readonly operation: 'opening'; readonly draft: OpeningDraft }
  | { readonly operation: 'close'; readonly draft: CloseDraft }
  | { readonly operation: 'receive'; readonly draft: SalaryPaymentDraft };
export interface SalaryCommandDecision {
  readonly result: SalaryVersion | SalaryPeriod | SalaryReceipt;
  readonly allocations: readonly SalaryPeriodAllocation[];
}

/** Evaluate a scoped snapshot under the persistence transaction's write lock. */
export function decideSalaryCommand(
  state: SalaryState,
  command: SalaryCommand,
  id: string,
): SalaryCommandDecision {
  identifier(id);
  const noAllocations: readonly SalaryPeriodAllocation[] = Object.freeze([]);
  switch (command.operation) {
    case 'configure': {
      const draft = validateSalaryVersionDraft(command.draft);
      if (
        state.versions.some(
          (version) => version.effectiveFrom === draft.effectiveFrom,
        )
      )
        throw new DomainError('SALARY_VERSION_EXISTS');
      if (
        state.periods.some(
          (period) =>
            period.source === 'closed' &&
            period.month >= draft.effectiveFrom.slice(0, 7),
        )
      )
        throw new DomainError('SALARY_VERSION_CONFLICT');
      return Object.freeze({
        result: Object.freeze({ ...draft, id }),
        allocations: noAllocations,
      });
    }
    case 'opening':
    case 'close': {
      const draft =
        command.operation === 'opening'
          ? validateOpeningDraft(command.draft)
          : validateCloseDraft(command.draft);
      if (state.periods.some((period) => period.month === draft.month))
        throw new DomainError('SALARY_PERIOD_EXISTS');
      const allocatedIds = new Set(
        state.allocations.map((allocation) => allocation.periodId),
      );
      if (
        state.periods.some(
          (period) =>
            allocatedIds.has(period.id) && period.month >= draft.month,
        )
      )
        throw new DomainError('SALARY_PERIOD_REQUIRES_REVIEW');
      let result: SalaryPeriod;
      if ('asOf' in draft) {
        result = Object.freeze({
          kind: 'salary-period',
          id,
          month: draft.month,
          amount: draft.amount,
          source: 'opening',
          salaryVersionId: null,
          availableOn: draft.asOf,
          dueOn: salaryDueOn(draft.month, draft.dueDay),
          actorRef: draft.actorRef,
          recordedAt: draft.recordedAt,
        });
      } else {
        const version = state.versions
          .filter((candidate) => candidate.effectiveFrom <= `${draft.month}-01`)
          .sort((a, b) =>
            a.effectiveFrom > b.effectiveFrom
              ? -1
              : a.effectiveFrom < b.effectiveFrom
                ? 1
                : 0,
          )[0];
        if (version === undefined)
          throw new DomainError('SALARY_NOT_CONFIGURED');
        result = Object.freeze({
          kind: 'salary-period',
          id,
          month: draft.month,
          amount: version.netAmount,
          source: 'closed',
          salaryVersionId: version.id,
          availableOn: monthEnd(draft.month),
          dueOn: salaryDueOn(draft.month, version.dueDay),
          actorRef: draft.actorRef,
          recordedAt: draft.recordedAt,
        });
      }
      return Object.freeze({ result, allocations: noAllocations });
    }
    case 'receive': {
      const draft = validateSalaryPaymentDraft(command.draft);
      const balances = buildSalaryReceivables(
        state.periods,
        state.payments,
        state.allocations,
        draft.receivedOn,
      );
      const lastConfirmedDate = state.payments
        .filter((payment) => payment.status === 'confirmed')
        .reduce<string | undefined>(
          (latest, payment) =>
            latest === undefined || payment.receivedOn > latest
              ? payment.receivedOn
              : latest,
          undefined,
        );
      const decision = allocateSalaryPayment(
        balances.periods,
        draft,
        lastConfirmedDate,
      );
      const result: SalaryReceipt = Object.freeze({
        kind: 'salary-payment',
        id,
        ...draft,
        status: decision.status,
        reviewReason: decision.reviewReason,
      });
      return Object.freeze({ result, allocations: decision.allocations });
    }
  }
}

function positiveMoney(value: Money): Money {
  if (!(value instanceof Money) || value.minor <= 0n)
    throw new DomainError('INVALID_SALARY_AMOUNT');
  return Money.fromMinor(value.minor, value.currency);
}
function dueDay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 31)
    throw new DomainError('INVALID_SALARY_DUE_DAY');
  return value;
}
export function monthEnd(month: string): string {
  calendarMonth(month);
  // These numbers are calendar components only; all money stays bigint.
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${month}-${days[index - 1]}`;
}
export function salaryDueOn(month: string, day: number): string {
  calendarMonth(month);
  dueDay(day);
  if (month === '9999-12') throw new DomainError('INVALID_SALARY_PERIOD');
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const next =
    index === 12
      ? `${String(year + 1).padStart(4, '0')}-01`
      : `${month.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
  const clamped = Math.min(day, Number(monthEnd(next).slice(8, 10)));
  return `${next}-${String(clamped).padStart(2, '0')}`;
}
export function validateSalaryVersionDraft(
  draft: SalaryVersionDraft,
): SalaryVersionDraft {
  if (draft.kind !== 'salary-version')
    throw new DomainError('INVALID_SALARY_VERSION');
  const effectiveFrom = calendarDate(draft.effectiveFrom);
  if (!effectiveFrom.endsWith('-01'))
    throw new DomainError('INVALID_SALARY_EFFECTIVE_DATE');
  salaryDueOn(effectiveFrom.slice(0, 7), draft.dueDay);
  return Object.freeze({
    kind: 'salary-version',
    netAmount: positiveMoney(draft.netAmount),
    effectiveFrom,
    dueDay: dueDay(draft.dueDay),
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}
export function validateOpeningDraft(draft: OpeningDraft): OpeningDraft {
  const month = calendarMonth(draft.month);
  const asOf = calendarDate(draft.asOf);
  if (asOf < monthEnd(month)) throw new DomainError('INVALID_SALARY_PERIOD');
  salaryDueOn(month, draft.dueDay);
  return Object.freeze({
    month,
    amount: positiveMoney(draft.amount),
    asOf,
    dueDay: dueDay(draft.dueDay),
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}
export function validateCloseDraft(draft: CloseDraft): CloseDraft {
  const month = calendarMonth(draft.month);
  const closedOn = calendarDate(draft.closedOn);
  if (closedOn < monthEnd(month))
    throw new DomainError('INVALID_SALARY_PERIOD');
  salaryDueOn(month, 5);
  return Object.freeze({
    month,
    closedOn,
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}
export function validateSalaryPaymentDraft(
  draft: SalaryPaymentDraft,
): SalaryPaymentDraft {
  if (typeof draft.reference !== 'string')
    throw new DomainError('INVALID_SALARY_REFERENCE');
  const reference = draft.reference.trim();
  if (
    !reference ||
    reference.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(reference)
  )
    throw new DomainError('INVALID_SALARY_REFERENCE');
  return Object.freeze({
    amount: positiveMoney(draft.amount),
    receivedOn: calendarDate(draft.receivedOn),
    reference,
    actorRef: identifier(draft.actorRef),
    recordedAt: correctionTime(draft.recordedAt),
  });
}

/** Call while holding the same transaction that persists receipt and allocations. */
export function allocateSalaryPayment(
  balances: readonly {
    readonly period: SalaryPeriod;
    readonly pending: Money;
  }[],
  draft: SalaryPaymentDraft,
  lastConfirmedDate?: string,
): SalaryPaymentDecision {
  const payment = validateSalaryPaymentDraft(draft);
  if (
    lastConfirmedDate !== undefined &&
    payment.receivedOn < calendarDate(lastConfirmedDate)
  )
    return Object.freeze({
      status: 'review_required',
      reviewReason: 'PAYMENT_DATE_REQUIRES_REVIEW',
      allocations: Object.freeze([]),
    });
  const eligible = balances
    .filter(
      ({ period, pending }) =>
        period.availableOn <= payment.receivedOn && pending.minor > 0n,
    )
    .sort((a, b) =>
      a.period.month < b.period.month
        ? -1
        : a.period.month > b.period.month
          ? 1
          : a.period.id.localeCompare(b.period.id),
    );
  const total = eligible.reduce((sum, entry) => sum + entry.pending.minor, 0n);
  if (payment.amount.minor > total)
    return Object.freeze({
      status: 'review_required',
      reviewReason: 'EXCEEDS_PENDING_BALANCE',
      allocations: Object.freeze([]),
    });
  let remainder = payment.amount.minor;
  const allocations: SalaryPeriodAllocation[] = [];
  for (const { period, pending } of eligible) {
    if (remainder === 0n) break;
    const minor = remainder < pending.minor ? remainder : pending.minor;
    allocations.push(
      Object.freeze({
        periodId: period.id,
        month: period.month,
        amount: Money.fromMinor(minor),
      }),
    );
    remainder -= minor;
  }
  return Object.freeze({
    status: 'confirmed',
    reviewReason: null,
    allocations: Object.freeze(allocations),
  });
}

/** A date-specific projection; inputs must already be isolated to one scope. */
export function buildSalaryReceivables(
  periods: readonly SalaryPeriod[],
  receipts: readonly SalaryReceipt[],
  allocations: readonly SalaryAllocation[],
  asOf: string,
): SalaryReceivables {
  calendarDate(asOf);
  const eligiblePayments = new Set(
    receipts
      .filter(
        (payment) =>
          payment.status === 'confirmed' && payment.receivedOn <= asOf,
      )
      .map((payment) => payment.id),
  );
  const receivedByPeriod = new Map<string, bigint>();
  for (const allocation of allocations) {
    if (eligiblePayments.has(allocation.paymentId)) {
      receivedByPeriod.set(
        allocation.periodId,
        (receivedByPeriod.get(allocation.periodId) ?? 0n) +
          allocation.amount.minor,
      );
    }
  }
  let closedEarned = 0n;
  let openingReceivable = 0n;
  let received = 0n;
  let pending = 0n;
  let overdue = 0n;
  const projected = periods
    .filter((period) => period.availableOn <= asOf)
    .sort((a, b) =>
      a.month < b.month ? -1 : a.month > b.month ? 1 : a.id.localeCompare(b.id),
    )
    .map((period): SalaryPeriodBalance => {
      const paid = receivedByPeriod.get(period.id) ?? 0n;
      if (paid > period.amount.minor)
        throw new DomainError('SALARY_INVARIANT_VIOLATION');
      const remaining = period.amount.minor - paid;
      const status =
        remaining === 0n ? 'paid' : asOf > period.dueOn ? 'overdue' : 'pending';
      if (period.source === 'closed') closedEarned += period.amount.minor;
      else openingReceivable += period.amount.minor;
      received += paid;
      pending += remaining;
      if (status === 'overdue') overdue += remaining;
      return Object.freeze({
        period,
        received: Money.fromMinor(paid),
        pending: Money.fromMinor(remaining),
        status,
      });
    });
  return Object.freeze({
    asOf,
    closedEarned: Money.fromMinor(closedEarned),
    openingReceivable: Money.fromMinor(openingReceivable),
    received: Money.fromMinor(received),
    pending: Money.fromMinor(pending),
    overdue: Money.fromMinor(overdue),
    periods: Object.freeze(projected),
  });
}
