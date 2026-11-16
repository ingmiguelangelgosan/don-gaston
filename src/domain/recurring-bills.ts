import { DomainError } from './errors.ts';
import { correctionReason, correctionTime } from './expense-corrections.ts';
import { calendarDate, calendarMonth, identifier } from './expenses.ts';
import { Money } from './money.ts';

interface BillAudit {
  readonly actorRef: string;
  readonly recordedAt: string;
}
export type BillAmountStatus = 'unknown' | 'estimated' | 'confirmed';
export interface BillConcept extends BillAudit {
  readonly kind: 'bill-concept';
  readonly id: string;
  readonly description: string;
  readonly categoryId: string;
  readonly currency: 'COP';
  readonly fixedAmount: Money | null;
  readonly dueDay: number | null;
  readonly dueMonthOffset: 0 | 1 | null;
}
export interface BillObligation extends BillAudit {
  readonly kind: 'bill-obligation';
  readonly id: string;
  readonly conceptId: string;
  readonly categoryId: string;
  readonly currency: 'COP';
  readonly month: string;
  readonly generatedOn: string;
  readonly amount: Money | null;
  readonly amountStatus: BillAmountStatus;
  readonly amountSource: 'explicit' | 'fixed' | 'last-paid' | 'unknown';
  readonly sourcePaymentId: string | null;
  readonly dueOn: string | null;
}
export interface BillAdjustment extends BillAudit {
  readonly kind: 'bill-adjustment';
  readonly id: string;
  readonly obligationId: string;
  readonly previousRevisionId: string;
  readonly amount: Money;
  readonly amountStatus: 'estimated' | 'confirmed';
  readonly reason: string;
}
/** The payment ID is the expense ID: two projections of the same cash/consumption fact. */
export interface BillPayment extends BillAudit {
  readonly kind: 'bill-payment';
  readonly id: string;
  readonly expenseId: string;
  readonly obligationId: string;
  readonly revisionId: string;
  readonly conceptId: string;
  readonly categoryId: string;
  readonly month: string;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
}
export type BillResult =
  BillConcept | BillObligation | BillAdjustment | BillPayment;
export type BillConceptDraft = Omit<BillConcept, 'kind' | 'id'>;
export interface BillGenerateDraft extends BillAudit {
  readonly conceptId: string;
  readonly month: string;
  readonly generatedOn: string;
  readonly amount: Money | null;
  readonly amountStatus: 'estimated' | 'confirmed' | null;
  readonly dueOn: string | null;
  readonly overrideDueOn: boolean;
}
export interface BillAdjustmentDraft extends BillAudit {
  readonly obligationId: string;
  readonly expectedRevisionId: string;
  readonly amount: Money;
  readonly amountStatus: 'estimated' | 'confirmed';
  readonly reason: string;
}
export interface BillPaymentDraft extends BillAudit {
  readonly obligationId: string;
  readonly expectedRevisionId: string;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
}
export type BillCommand =
  | { readonly operation: 'concept'; readonly draft: BillConceptDraft }
  | { readonly operation: 'generate'; readonly draft: BillGenerateDraft }
  | { readonly operation: 'adjust'; readonly draft: BillAdjustmentDraft }
  | { readonly operation: 'pay'; readonly draft: BillPaymentDraft };
export interface BillState {
  readonly concepts: readonly BillConcept[];
  readonly obligations: readonly BillObligation[];
  readonly adjustments: readonly BillAdjustment[];
  readonly payments: readonly BillPayment[];
}
export interface BillStatus {
  readonly obligation: BillObligation;
  readonly revisions: readonly BillAdjustment[];
  readonly currentRevisionId: string;
  readonly amount: Money | null;
  readonly amountStatus: BillAmountStatus;
  readonly status: 'paid' | 'pending' | 'overdue';
  readonly payment: BillPayment | null;
}
export interface BillListQuery {
  readonly asOf: string;
  readonly conceptId?: string;
}
export interface BillList {
  readonly asOf: string;
  readonly obligations: readonly BillStatus[];
  readonly confirmedPending: Money;
  readonly estimatedPending: Money;
  readonly unknownPendingCount: number;
  readonly confirmedOverdue: Money;
  readonly estimatedOverdue: Money;
  readonly unknownOverdueCount: number;
}
export interface BillMonthlyCashOutflow {
  readonly month: string;
  readonly currency: 'COP';
  readonly total: Money;
  readonly payments: readonly BillPayment[];
}
function positive(value: Money): Money {
  if (!(value instanceof Money) || value.minor <= 0n)
    throw new DomainError('INVALID_BILL_AMOUNT');
  return Money.fromMinor(value.minor, value.currency);
}
function boundedText(value: string, maximum: number, code: string): string {
  if (typeof value !== 'string') throw new DomainError(code);
  const result = value.trim();
  if (
    !result ||
    result.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(result)
  )
    throw new DomainError(code);
  return result;
}
function audit(value: BillAudit): BillAudit {
  return {
    actorRef: identifier(value.actorRef),
    recordedAt: correctionTime(value.recordedAt),
  };
}
function knownStatus(
  value: 'estimated' | 'confirmed',
): 'estimated' | 'confirmed' {
  if (value !== 'estimated' && value !== 'confirmed')
    throw new DomainError('INVALID_BILL_AMOUNT_STATUS');
  return value;
}
export function validateBillCommand(command: BillCommand): BillCommand {
  switch (command.operation) {
    case 'concept': {
      const value = command.draft;
      if (value.currency !== 'COP')
        throw new DomainError('UNSUPPORTED_CURRENCY');
      if (
        (value.dueDay === null) !== (value.dueMonthOffset === null) ||
        (value.dueDay !== null &&
          (!Number.isSafeInteger(value.dueDay) ||
            value.dueDay < 1 ||
            value.dueDay > 31)) ||
        (value.dueMonthOffset !== null &&
          value.dueMonthOffset !== 0 &&
          value.dueMonthOffset !== 1)
      )
        throw new DomainError('INVALID_BILL_DUE_RULE');
      return Object.freeze({
        operation: 'concept',
        draft: Object.freeze({
          description: boundedText(
            value.description,
            200,
            'INVALID_BILL_DESCRIPTION',
          ),
          categoryId: identifier(value.categoryId),
          currency: 'COP',
          fixedAmount:
            value.fixedAmount === null ? null : positive(value.fixedAmount),
          dueDay: value.dueDay,
          dueMonthOffset: value.dueMonthOffset,
          ...audit(value),
        }),
      });
    }
    case 'generate': {
      const value = command.draft;
      if ((value.amount === null) !== (value.amountStatus === null))
        throw new DomainError('INVALID_BILL_AMOUNT_STATUS');
      if (
        typeof value.overrideDueOn !== 'boolean' ||
        (!value.overrideDueOn && value.dueOn !== null)
      )
        throw new DomainError('INVALID_BILL_DUE_DATE');
      return Object.freeze({
        operation: 'generate',
        draft: Object.freeze({
          conceptId: identifier(value.conceptId),
          month: calendarMonth(value.month),
          generatedOn: calendarDate(value.generatedOn),
          amount: value.amount === null ? null : positive(value.amount),
          amountStatus:
            value.amountStatus === null
              ? null
              : knownStatus(value.amountStatus),
          dueOn: value.dueOn === null ? null : calendarDate(value.dueOn),
          overrideDueOn: value.overrideDueOn,
          ...audit(value),
        }),
      });
    }
    case 'adjust': {
      const value = command.draft;
      return Object.freeze({
        operation: 'adjust',
        draft: Object.freeze({
          obligationId: identifier(value.obligationId),
          expectedRevisionId: identifier(value.expectedRevisionId),
          amount: positive(value.amount),
          amountStatus: knownStatus(value.amountStatus),
          reason: correctionReason(value.reason),
          ...audit(value),
        }),
      });
    }
    case 'pay': {
      const value = command.draft;
      return Object.freeze({
        operation: 'pay',
        draft: Object.freeze({
          obligationId: identifier(value.obligationId),
          expectedRevisionId: identifier(value.expectedRevisionId),
          amount: positive(value.amount),
          paidOn: calendarDate(value.paidOn),
          reference: boundedText(
            value.reference,
            128,
            'INVALID_BILL_REFERENCE',
          ),
          ...audit(value),
        }),
      });
    }
    default:
      throw new DomainError('INVALID_BILL_OPERATION');
  }
}
function monthEndDay(month: string): number {
  const year = Number(month.slice(0, 4)),
    index = Number(month.slice(5, 7));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    index - 1
  ]!;
}
export function billDueOn(
  month: string,
  day: number | null,
  offset: 0 | 1 | null,
): string | null {
  calendarMonth(month);
  if (day === null && offset === null) return null;
  if (
    day === null ||
    !Number.isSafeInteger(day) ||
    day < 1 ||
    day > 31 ||
    (offset !== 0 && offset !== 1)
  )
    throw new DomainError('INVALID_BILL_DUE_RULE');
  let target = month;
  if (offset === 1) {
    if (month === '9999-12') throw new DomainError('INVALID_BILL_DUE_DATE');
    const year = Number(month.slice(0, 4)),
      index = Number(month.slice(5, 7));
    target =
      index === 12
        ? `${String(year + 1).padStart(4, '0')}-01`
        : `${month.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
  }
  return `${target}-${String(Math.min(day, monthEndDay(target))).padStart(2, '0')}`;
}
function current(state: BillState, obligationId: string) {
  const obligation = state.obligations.find((item) => item.id === obligationId);
  if (!obligation) throw new DomainError('BILL_OBLIGATION_NOT_FOUND');
  const revisions = state.adjustments.filter(
    (item) => item.obligationId === obligationId,
  );
  const latest = revisions.at(-1);
  return {
    obligation,
    revisions,
    currentRevisionId: latest?.id ?? obligation.id,
    amount: latest?.amount ?? obligation.amount,
    amountStatus: latest?.amountStatus ?? obligation.amountStatus,
    payment:
      state.payments.find((item) => item.obligationId === obligationId) ?? null,
  };
}
/** Requires a scoped snapshot held under the same lock as the resulting commit. */
export function decideBillCommand(
  state: BillState,
  raw: BillCommand,
  id: string,
): BillResult {
  identifier(id);
  const command = validateBillCommand(raw);
  switch (command.operation) {
    case 'concept':
      return Object.freeze({ kind: 'bill-concept', id, ...command.draft });
    case 'generate': {
      const draft = command.draft;
      const concept = state.concepts.find(
        (item) => item.id === draft.conceptId,
      );
      if (!concept) throw new DomainError('BILL_CONCEPT_NOT_FOUND');
      if (
        state.obligations.some(
          (item) => item.conceptId === concept.id && item.month === draft.month,
        )
      )
        throw new DomainError('BILL_OBLIGATION_EXISTS');
      let amount = draft.amount;
      let amountStatus: BillAmountStatus = draft.amountStatus ?? 'unknown';
      let amountSource: BillObligation['amountSource'] =
        draft.amount === null ? 'unknown' : 'explicit';
      let sourcePaymentId: string | null = null;
      if (amount === null && concept.fixedAmount !== null) {
        amount = concept.fixedAmount;
        amountStatus = 'estimated';
        amountSource = 'fixed';
      } else if (amount === null) {
        // Input order is durable registration order; on equal civil dates the last registered wins.
        const latest = state.payments
          .filter(
            (payment) =>
              payment.conceptId === concept.id &&
              payment.paidOn <= draft.generatedOn,
          )
          .reduce<BillPayment | undefined>(
            (previous, payment) =>
              !previous || payment.paidOn >= previous.paidOn
                ? payment
                : previous,
            undefined,
          );
        if (latest) {
          amount = latest.amount;
          amountStatus = 'estimated';
          amountSource = 'last-paid';
          sourcePaymentId = latest.id;
        }
      }
      return Object.freeze({
        kind: 'bill-obligation',
        id,
        conceptId: concept.id,
        categoryId: concept.categoryId,
        currency: concept.currency,
        month: draft.month,
        generatedOn: draft.generatedOn,
        amount,
        amountStatus,
        amountSource,
        sourcePaymentId,
        dueOn: draft.overrideDueOn
          ? draft.dueOn
          : billDueOn(draft.month, concept.dueDay, concept.dueMonthOffset),
        actorRef: draft.actorRef,
        recordedAt: draft.recordedAt,
      });
    }
    case 'adjust': {
      const draft = command.draft,
        status = current(state, draft.obligationId);
      if (status.payment) throw new DomainError('BILL_ALREADY_PAID');
      if (status.currentRevisionId !== draft.expectedRevisionId)
        throw new DomainError('BILL_REVISION_CONFLICT');
      return Object.freeze({
        kind: 'bill-adjustment',
        id,
        obligationId: draft.obligationId,
        previousRevisionId: draft.expectedRevisionId,
        amount: draft.amount,
        amountStatus: draft.amountStatus,
        reason: draft.reason,
        actorRef: draft.actorRef,
        recordedAt: draft.recordedAt,
      });
    }
    case 'pay': {
      const draft = command.draft,
        status = current(state, draft.obligationId);
      if (status.payment) throw new DomainError('BILL_ALREADY_PAID');
      if (status.currentRevisionId !== draft.expectedRevisionId)
        throw new DomainError('BILL_REVISION_CONFLICT');
      if (status.amountStatus !== 'confirmed' || status.amount === null)
        throw new DomainError('BILL_AMOUNT_NOT_CONFIRMED');
      if (status.amount.minor !== draft.amount.minor)
        throw new DomainError('BILL_FULL_PAYMENT_REQUIRED');
      if (draft.paidOn < status.obligation.generatedOn)
        throw new DomainError('BILL_PAYMENT_BEFORE_GENERATION');
      return Object.freeze({
        kind: 'bill-payment',
        id,
        expenseId: id,
        obligationId: draft.obligationId,
        revisionId: draft.expectedRevisionId,
        conceptId: status.obligation.conceptId,
        categoryId: status.obligation.categoryId,
        month: status.obligation.month,
        amount: draft.amount,
        paidOn: draft.paidOn,
        reference: draft.reference,
        actorRef: draft.actorRef,
        recordedAt: draft.recordedAt,
      });
    }
  }
}
/** Financial-date projection of currently known records, not audit-time reconstruction. */
export function buildBillStatus(
  state: BillState,
  id: string,
  asOf: string,
): BillStatus {
  identifier(id);
  calendarDate(asOf);
  const result = current(state, id);
  if (result.obligation.generatedOn > asOf)
    throw new DomainError('BILL_NOT_AVAILABLE_AT_DATE');
  const payment =
    result.payment && result.payment.paidOn <= asOf ? result.payment : null;
  const status = payment
    ? 'paid'
    : result.obligation.dueOn !== null && asOf > result.obligation.dueOn
      ? 'overdue'
      : 'pending';
  return Object.freeze({
    ...result,
    revisions: Object.freeze(result.revisions),
    payment,
    status,
  });
}
export function buildBillList(
  state: BillState,
  query: BillListQuery,
): BillList {
  calendarDate(query.asOf);
  if (query.conceptId !== undefined) {
    identifier(query.conceptId);
    if (!state.concepts.some((item) => item.id === query.conceptId))
      throw new DomainError('BILL_CONCEPT_NOT_FOUND');
  }
  const obligations = state.obligations
    .filter(
      (item) =>
        item.generatedOn <= query.asOf &&
        (query.conceptId === undefined || item.conceptId === query.conceptId),
    )
    .sort((a, b) =>
      a.month < b.month
        ? -1
        : a.month > b.month
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    )
    .map((item) => buildBillStatus(state, item.id, query.asOf));
  let confirmedPending = 0n,
    estimatedPending = 0n,
    unknownPendingCount = 0;
  let confirmedOverdue = 0n,
    estimatedOverdue = 0n,
    unknownOverdueCount = 0;
  for (const item of obligations) {
    if (item.status === 'paid') continue;
    if (item.amountStatus === 'unknown') {
      unknownPendingCount++;
      if (item.status === 'overdue') unknownOverdueCount++;
    } else if (item.amountStatus === 'confirmed') {
      confirmedPending += item.amount!.minor;
      if (item.status === 'overdue') confirmedOverdue += item.amount!.minor;
    } else {
      estimatedPending += item.amount!.minor;
      if (item.status === 'overdue') estimatedOverdue += item.amount!.minor;
    }
  }
  return Object.freeze({
    asOf: query.asOf,
    obligations: Object.freeze(obligations),
    confirmedPending: Money.fromMinor(confirmedPending),
    estimatedPending: Money.fromMinor(estimatedPending),
    unknownPendingCount,
    confirmedOverdue: Money.fromMinor(confirmedOverdue),
    estimatedOverdue: Money.fromMinor(estimatedOverdue),
    unknownOverdueCount,
  });
}
