import { DomainError } from './errors.ts';
import { correctionTime } from './expense-corrections.ts';
import { calendarDate, calendarMonth, identifier } from './expenses.ts';
import { Money } from './money.ts';
import type { LoanCounterparty } from './personal-loans.ts';

interface SubscriptionAudit {
  readonly actorRef: string;
  readonly recordedAt: string;
}
interface Participants {
  readonly includesHolder: boolean;
  readonly counterpartyIds: readonly string[];
}
export interface Subscription extends SubscriptionAudit, Participants {
  readonly kind: 'subscription';
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly mode: 'personal' | 'shared';
  readonly monthlyAmount: Money;
  readonly effectiveMonth: string;
}
export interface SubscriptionParticipants
  extends SubscriptionAudit, Participants {
  readonly kind: 'subscription-participants';
  readonly id: string;
  readonly subscriptionId: string;
  readonly effectiveMonth: string;
}
export interface SubscriptionObligation
  extends SubscriptionAudit, Participants {
  readonly kind: 'subscription-obligation';
  readonly id: string;
  readonly subscriptionId: string;
  readonly versionId: string;
  readonly categoryId: string;
  readonly month: string;
  readonly generatedOn: string;
  readonly amount: Money;
}
export interface SubscriptionShare {
  readonly counterpartyId: string;
  readonly amount: Money;
}
export interface SubscriptionPayment extends SubscriptionAudit {
  readonly kind: 'subscription-payment';
  readonly id: string;
  readonly obligationId: string;
  readonly subscriptionId: string;
  readonly categoryId: string;
  readonly month: string;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason:
    'NON_DIVISIBLE_AMOUNT' | 'PAYMENT_DATE_REQUIRES_REVIEW' | null;
  readonly ownAmount: Money;
  /** A consumption projection of this payment, never a second cash fact. */
  readonly expenseId: string | null;
  readonly shares: readonly SubscriptionShare[];
}
export interface SubscriptionAllocation {
  readonly paymentId: string;
  readonly obligationId: string;
  readonly amount: Money;
}
export interface SubscriptionReimbursement extends SubscriptionAudit {
  readonly kind: 'subscription-reimbursement';
  readonly id: string;
  readonly counterpartyId: string;
  readonly amount: Money;
  readonly receivedOn: string;
  readonly reference: string;
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason:
    'EXCEEDS_PENDING_BALANCE' | 'PAYMENT_DATE_REQUIRES_REVIEW' | null;
  readonly allocations: readonly SubscriptionAllocation[];
}
export type SubscriptionResult =
  | Subscription
  | SubscriptionParticipants
  | SubscriptionObligation
  | SubscriptionPayment
  | SubscriptionReimbursement;
export type SubscriptionCreateDraft = Omit<Subscription, 'kind' | 'id'>;
export type SubscriptionChangeDraft = Omit<
  SubscriptionParticipants,
  'kind' | 'id'
>;
export interface SubscriptionGenerateDraft extends SubscriptionAudit {
  readonly subscriptionId: string;
  readonly month: string;
  readonly generatedOn: string;
}
export interface SubscriptionPayDraft extends SubscriptionAudit {
  readonly obligationId: string;
  readonly amount: Money;
  readonly paidOn: string;
  readonly reference: string;
}
export interface SubscriptionReimburseDraft extends SubscriptionAudit {
  readonly counterpartyId: string;
  readonly amount: Money;
  readonly receivedOn: string;
  readonly reference: string;
}
export type SubscriptionCommand =
  | { readonly operation: 'create'; readonly draft: SubscriptionCreateDraft }
  | { readonly operation: 'change'; readonly draft: SubscriptionChangeDraft }
  | {
      readonly operation: 'generate';
      readonly draft: SubscriptionGenerateDraft;
    }
  | { readonly operation: 'pay'; readonly draft: SubscriptionPayDraft }
  | {
      readonly operation: 'reimburse';
      readonly draft: SubscriptionReimburseDraft;
    };
/** All arrays are in durable registration order, within one authorized scope. */
export interface SubscriptionState {
  readonly counterparties: readonly LoanCounterparty[];
  readonly subscriptions: readonly Subscription[];
  readonly changes: readonly SubscriptionParticipants[];
  readonly obligations: readonly SubscriptionObligation[];
  readonly payments: readonly SubscriptionPayment[];
  readonly reimbursements: readonly SubscriptionReimbursement[];
}
export interface SubscriptionStatus {
  readonly obligation: SubscriptionObligation;
  readonly status: 'pending' | 'paid';
  readonly payment: SubscriptionPayment | null;
}
export interface SubscriptionListQuery {
  readonly asOf: string;
  readonly subscriptionId?: string;
}
export interface SubscriptionList {
  readonly asOf: string;
  readonly obligations: readonly SubscriptionStatus[];
  readonly pending: Money;
  readonly paid: Money;
}
export interface SubscriptionReceivablesQuery {
  readonly counterpartyId: string;
  readonly asOf: string;
}
export interface SubscriptionReceivablePeriod {
  readonly paymentId: string;
  readonly obligationId: string;
  readonly subscriptionId: string;
  readonly month: string;
  readonly amount: Money;
  readonly reimbursed: Money;
  readonly pending: Money;
}
export interface SubscriptionReceivables {
  readonly counterparty: LoanCounterparty;
  readonly asOf: string;
  readonly totalCharged: Money;
  readonly totalReimbursed: Money;
  readonly pending: Money;
  readonly periods: readonly SubscriptionReceivablePeriod[];
  readonly reimbursements: readonly SubscriptionReimbursement[];
}
export interface SubscriptionCashFlow {
  readonly month: string;
  readonly currency: 'COP';
  readonly inflow: Money;
  readonly outflow: Money;
  readonly personalConsumption: Money;
  readonly payments: readonly SubscriptionPayment[];
  readonly reimbursements: readonly SubscriptionReimbursement[];
}
function positive(value: Money): Money {
  if (!(value instanceof Money) || value.minor <= 0n)
    throw new DomainError('INVALID_SUBSCRIPTION_AMOUNT');
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
function audit(value: SubscriptionAudit): SubscriptionAudit {
  return {
    actorRef: identifier(value.actorRef),
    recordedAt: correctionTime(value.recordedAt),
  };
}
function participants(value: Participants): Participants {
  if (
    typeof value.includesHolder !== 'boolean' ||
    !Array.isArray(value.counterpartyIds) ||
    value.counterpartyIds.length > 100
  )
    throw new DomainError('INVALID_SUBSCRIPTION_PARTICIPANTS');
  const ids = value.counterpartyIds.map((id: string) => identifier(id)).sort();
  if (
    new Set(ids).size !== ids.length ||
    ids.length + (value.includesHolder ? 1 : 0) === 0
  )
    throw new DomainError('INVALID_SUBSCRIPTION_PARTICIPANTS');
  return {
    includesHolder: value.includesHolder,
    counterpartyIds: Object.freeze(ids),
  };
}
export function validateSubscriptionCommand(
  command: SubscriptionCommand,
): SubscriptionCommand {
  switch (command.operation) {
    case 'create': {
      const value = command.draft,
        group = participants(value);
      if (value.mode !== 'personal' && value.mode !== 'shared')
        throw new DomainError('INVALID_SUBSCRIPTION_MODE');
      if (
        (value.mode === 'personal' &&
          (!group.includesHolder || group.counterpartyIds.length !== 0)) ||
        (value.mode === 'shared' && group.counterpartyIds.length === 0)
      )
        throw new DomainError('INVALID_SUBSCRIPTION_PARTICIPANTS');
      return Object.freeze({
        operation: 'create',
        draft: Object.freeze({
          name: boundedText(value.name, 200, 'INVALID_SUBSCRIPTION_NAME'),
          categoryId: identifier(value.categoryId),
          mode: value.mode,
          monthlyAmount: positive(value.monthlyAmount),
          effectiveMonth: calendarMonth(value.effectiveMonth),
          ...group,
          ...audit(value),
        }),
      });
    }
    case 'change': {
      const value = command.draft;
      return Object.freeze({
        operation: 'change',
        draft: Object.freeze({
          subscriptionId: identifier(value.subscriptionId),
          effectiveMonth: calendarMonth(value.effectiveMonth),
          ...participants(value),
          ...audit(value),
        }),
      });
    }
    case 'generate': {
      const value = command.draft;
      return Object.freeze({
        operation: 'generate',
        draft: Object.freeze({
          subscriptionId: identifier(value.subscriptionId),
          month: calendarMonth(value.month),
          generatedOn: calendarDate(value.generatedOn),
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
          amount: positive(value.amount),
          paidOn: calendarDate(value.paidOn),
          reference: boundedText(
            value.reference,
            128,
            'INVALID_SUBSCRIPTION_REFERENCE',
          ),
          ...audit(value),
        }),
      });
    }
    case 'reimburse': {
      const value = command.draft;
      return Object.freeze({
        operation: 'reimburse',
        draft: Object.freeze({
          counterpartyId: identifier(value.counterpartyId),
          amount: positive(value.amount),
          receivedOn: calendarDate(value.receivedOn),
          reference: boundedText(
            value.reference,
            128,
            'INVALID_SUBSCRIPTION_REFERENCE',
          ),
          ...audit(value),
        }),
      });
    }
    default:
      throw new DomainError('INVALID_SUBSCRIPTION_OPERATION');
  }
}
function requireParties(
  state: SubscriptionState,
  ids: readonly string[],
): void {
  for (const id of ids)
    if (!state.counterparties.some((party) => party.id === id))
      throw new DomainError('SUBSCRIPTION_COUNTERPARTY_NOT_FOUND');
}
function orderPayments(a: SubscriptionPayment, b: SubscriptionPayment): number {
  for (const field of ['month', 'subscriptionId', 'obligationId'] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}
function allocate(
  state: SubscriptionState,
  partyId: string,
  date: string,
  amount: bigint,
): readonly SubscriptionAllocation[] | null {
  const payments = state.payments
    .filter(
      (payment) =>
        payment.status === 'confirmed' &&
        payment.paidOn <= date &&
        payment.shares.some((share) => share.counterpartyId === partyId),
    )
    .sort(orderPayments);
  const used = new Map<string, bigint>();
  for (const reimbursement of state.reimbursements)
    if (
      reimbursement.status === 'confirmed' &&
      reimbursement.counterpartyId === partyId
    ) {
      for (const allocation of reimbursement.allocations)
        used.set(
          allocation.paymentId,
          (used.get(allocation.paymentId) ?? 0n) + allocation.amount.minor,
        );
    }
  const allocations: SubscriptionAllocation[] = [];
  let remaining = amount;
  for (const payment of payments) {
    const share = payment.shares.find(
      (value) => value.counterpartyId === partyId,
    )!;
    const pending = share.amount.minor - (used.get(payment.id) ?? 0n);
    if (pending < 0n) throw new DomainError('SUBSCRIPTION_INVARIANT_VIOLATION');
    const assigned = pending < remaining ? pending : remaining;
    if (assigned > 0n)
      allocations.push(
        Object.freeze({
          paymentId: payment.id,
          obligationId: payment.obligationId,
          amount: Money.fromMinor(assigned),
        }),
      );
    remaining -= assigned;
    if (remaining === 0n) return Object.freeze(allocations);
  }
  return null;
}
/** Adding a dated receivable must never silently rewrite an earlier FIFO result. */
function preservesAllocations(
  state: SubscriptionState,
  payment: SubscriptionPayment,
): boolean {
  const affected = new Set(payment.shares.map((share) => share.counterpartyId));
  const previous: SubscriptionReimbursement[] = [];
  for (const reimbursement of state.reimbursements) {
    if (
      reimbursement.status === 'confirmed' &&
      affected.has(reimbursement.counterpartyId)
    ) {
      const allocations = allocate(
        {
          ...state,
          payments: [...state.payments, payment],
          reimbursements: previous,
        },
        reimbursement.counterpartyId,
        reimbursement.receivedOn,
        reimbursement.amount.minor,
      );
      if (
        JSON.stringify(allocations) !==
        JSON.stringify(reimbursement.allocations)
      )
        return false;
    }
    previous.push(reimbursement);
  }
  return true;
}
export function decideSubscriptionCommand(
  state: SubscriptionState,
  raw: SubscriptionCommand,
  id: string,
): SubscriptionResult {
  identifier(id);
  const command = validateSubscriptionCommand(raw);
  switch (command.operation) {
    case 'create':
      requireParties(state, command.draft.counterpartyIds);
      return Object.freeze({ kind: 'subscription', id, ...command.draft });
    case 'change': {
      const value = command.draft;
      const subscription = state.subscriptions.find(
        (item) => item.id === value.subscriptionId,
      );
      if (!subscription) throw new DomainError('SUBSCRIPTION_NOT_FOUND');
      if (subscription.mode !== 'shared' || value.counterpartyIds.length === 0)
        throw new DomainError('INVALID_SUBSCRIPTION_PARTICIPANTS');
      requireParties(state, value.counterpartyIds);
      if (
        value.effectiveMonth <= subscription.effectiveMonth ||
        state.changes.some(
          (change) =>
            change.subscriptionId === subscription.id &&
            change.effectiveMonth >= value.effectiveMonth,
        ) ||
        state.obligations.some(
          (obligation) =>
            obligation.subscriptionId === subscription.id &&
            obligation.month >= value.effectiveMonth,
        )
      )
        throw new DomainError('SUBSCRIPTION_PERIOD_REQUIRES_REVIEW');
      return Object.freeze({ kind: 'subscription-participants', id, ...value });
    }
    case 'generate': {
      const value = command.draft;
      const subscription = state.subscriptions.find(
        (item) => item.id === value.subscriptionId,
      );
      if (!subscription) throw new DomainError('SUBSCRIPTION_NOT_FOUND');
      if (
        value.month < subscription.effectiveMonth ||
        value.generatedOn < value.month + '-01'
      )
        throw new DomainError('INVALID_SUBSCRIPTION_PERIOD');
      if (
        state.obligations.some(
          (obligation) =>
            obligation.subscriptionId === subscription.id &&
            obligation.month === value.month,
        )
      )
        throw new DomainError('SUBSCRIPTION_PERIOD_EXISTS');
      const version =
        state.changes
          .filter(
            (change) =>
              change.subscriptionId === subscription.id &&
              change.effectiveMonth <= value.month,
          )
          .at(-1) ?? subscription;
      return Object.freeze({
        kind: 'subscription-obligation',
        id,
        subscriptionId: subscription.id,
        versionId: version.id,
        categoryId: subscription.categoryId,
        month: value.month,
        generatedOn: value.generatedOn,
        amount: subscription.monthlyAmount,
        includesHolder: version.includesHolder,
        counterpartyIds: version.counterpartyIds,
        ...audit(value),
      });
    }
    case 'pay': {
      const value = command.draft;
      const obligation = state.obligations.find(
        (item) => item.id === value.obligationId,
      );
      if (!obligation)
        throw new DomainError('SUBSCRIPTION_OBLIGATION_NOT_FOUND');
      if (
        state.payments.some(
          (payment) =>
            payment.obligationId === obligation.id &&
            payment.status === 'confirmed',
        )
      )
        throw new DomainError('SUBSCRIPTION_ALREADY_PAID');
      if (value.amount.minor !== obligation.amount.minor)
        throw new DomainError('SUBSCRIPTION_AMOUNT_MISMATCH');
      if (value.paidOn < obligation.generatedOn)
        throw new DomainError('INVALID_SUBSCRIPTION_PAYMENT_DATE');
      const count = BigInt(
        obligation.counterpartyIds.length + (obligation.includesHolder ? 1 : 0),
      );
      let reviewReason: SubscriptionPayment['reviewReason'] =
        value.amount.minor % count === 0n ? null : 'NON_DIVISIBLE_AMOUNT';
      const share = reviewReason === null ? value.amount.minor / count : 0n;
      const candidate: SubscriptionPayment = Object.freeze({
        kind: 'subscription-payment',
        id,
        ...value,
        subscriptionId: obligation.subscriptionId,
        categoryId: obligation.categoryId,
        month: obligation.month,
        status: 'confirmed',
        reviewReason: null,
        ownAmount: Money.fromMinor(obligation.includesHolder ? share : 0n),
        expenseId: obligation.includesHolder && share > 0n ? id : null,
        shares: Object.freeze(
          obligation.counterpartyIds.map((counterpartyId) =>
            Object.freeze({ counterpartyId, amount: Money.fromMinor(share) }),
          ),
        ),
      });
      if (reviewReason === null && !preservesAllocations(state, candidate))
        reviewReason = 'PAYMENT_DATE_REQUIRES_REVIEW';
      if (reviewReason !== null)
        return Object.freeze({
          ...candidate,
          status: 'review_required',
          reviewReason,
          ownAmount: Money.fromMinor(0n),
          expenseId: null,
          shares: Object.freeze([]),
        });
      return candidate;
    }
    case 'reimburse': {
      const value = command.draft;
      requireParties(state, [value.counterpartyId]);
      let reviewReason: SubscriptionReimbursement['reviewReason'] = null;
      if (
        state.reimbursements.some(
          (reimbursement) =>
            reimbursement.counterpartyId === value.counterpartyId &&
            reimbursement.status === 'confirmed' &&
            reimbursement.receivedOn > value.receivedOn,
        )
      )
        reviewReason = 'PAYMENT_DATE_REQUIRES_REVIEW';
      const allocations =
        reviewReason === null
          ? allocate(
              state,
              value.counterpartyId,
              value.receivedOn,
              value.amount.minor,
            )
          : null;
      if (reviewReason === null && allocations === null)
        reviewReason = 'EXCEEDS_PENDING_BALANCE';
      return Object.freeze({
        kind: 'subscription-reimbursement',
        id,
        ...value,
        status: reviewReason === null ? 'confirmed' : 'review_required',
        reviewReason,
        allocations: allocations ?? Object.freeze([]),
      });
    }
  }
}
export function buildSubscriptionStatus(
  state: SubscriptionState,
  obligationId: string,
  asOf: string,
): SubscriptionStatus {
  identifier(obligationId);
  calendarDate(asOf);
  const obligation = state.obligations.find(
    (item) => item.id === obligationId && item.generatedOn <= asOf,
  );
  if (!obligation) throw new DomainError('SUBSCRIPTION_OBLIGATION_NOT_FOUND');
  const payment =
    state.payments.find(
      (item) =>
        item.obligationId === obligationId &&
        item.status === 'confirmed' &&
        item.paidOn <= asOf,
    ) ?? null;
  return Object.freeze({
    obligation,
    status: payment ? 'paid' : 'pending',
    payment,
  });
}
export function buildSubscriptionList(
  state: SubscriptionState,
  query: SubscriptionListQuery,
): SubscriptionList {
  calendarDate(query.asOf);
  if (query.subscriptionId !== undefined) {
    identifier(query.subscriptionId);
    if (!state.subscriptions.some((item) => item.id === query.subscriptionId))
      throw new DomainError('SUBSCRIPTION_NOT_FOUND');
  }
  const obligations = state.obligations
    .filter(
      (item) =>
        item.generatedOn <= query.asOf &&
        (query.subscriptionId === undefined ||
          item.subscriptionId === query.subscriptionId),
    )
    .sort((a, b) =>
      a.month < b.month ? -1 : a.month > b.month ? 1 : a.id < b.id ? -1 : 1,
    )
    .map((item) => buildSubscriptionStatus(state, item.id, query.asOf));
  return Object.freeze({
    asOf: query.asOf,
    obligations: Object.freeze(obligations),
    pending: Money.fromMinor(
      obligations
        .filter((item) => item.status === 'pending')
        .reduce((sum, item) => sum + item.obligation.amount.minor, 0n),
    ),
    paid: Money.fromMinor(
      obligations
        .filter((item) => item.status === 'paid')
        .reduce((sum, item) => sum + item.obligation.amount.minor, 0n),
    ),
  });
}
export function buildSubscriptionReceivables(
  state: SubscriptionState,
  query: SubscriptionReceivablesQuery,
): SubscriptionReceivables {
  identifier(query.counterpartyId);
  calendarDate(query.asOf);
  const counterparty = state.counterparties.find(
    (item) => item.id === query.counterpartyId,
  );
  if (!counterparty)
    throw new DomainError('SUBSCRIPTION_COUNTERPARTY_NOT_FOUND');
  const reimbursements = state.reimbursements.filter(
    (item) =>
      item.counterpartyId === query.counterpartyId &&
      item.receivedOn <= query.asOf,
  );
  const periods = state.payments
    .filter(
      (item) =>
        item.status === 'confirmed' &&
        item.paidOn <= query.asOf &&
        item.shares.some(
          (share) => share.counterpartyId === query.counterpartyId,
        ),
    )
    .sort(orderPayments)
    .map((payment) => {
      const amount = payment.shares.find(
        (item) => item.counterpartyId === query.counterpartyId,
      )!.amount;
      const reimbursed = reimbursements
        .filter((item) => item.status === 'confirmed')
        .flatMap((item) => item.allocations)
        .filter((item) => item.paymentId === payment.id)
        .reduce((sum, item) => sum + item.amount.minor, 0n);
      if (reimbursed > amount.minor)
        throw new DomainError('SUBSCRIPTION_INVARIANT_VIOLATION');
      return Object.freeze({
        paymentId: payment.id,
        obligationId: payment.obligationId,
        subscriptionId: payment.subscriptionId,
        month: payment.month,
        amount,
        reimbursed: Money.fromMinor(reimbursed),
        pending: Money.fromMinor(amount.minor - reimbursed),
      });
    });
  return Object.freeze({
    counterparty,
    asOf: query.asOf,
    totalCharged: Money.fromMinor(
      periods.reduce((sum, item) => sum + item.amount.minor, 0n),
    ),
    totalReimbursed: Money.fromMinor(
      periods.reduce((sum, item) => sum + item.reimbursed.minor, 0n),
    ),
    pending: Money.fromMinor(
      periods.reduce((sum, item) => sum + item.pending.minor, 0n),
    ),
    periods: Object.freeze(periods),
    reimbursements: Object.freeze(reimbursements),
  });
}
export function buildSubscriptionCashFlow(
  state: SubscriptionState,
  month: string,
): SubscriptionCashFlow {
  calendarMonth(month);
  const payments = state.payments.filter(
    (item) =>
      item.status === 'confirmed' && item.paidOn.startsWith(month + '-'),
  );
  const reimbursements = state.reimbursements.filter(
    (item) =>
      item.status === 'confirmed' && item.receivedOn.startsWith(month + '-'),
  );
  return Object.freeze({
    month,
    currency: 'COP',
    inflow: Money.fromMinor(
      reimbursements.reduce((sum, item) => sum + item.amount.minor, 0n),
    ),
    outflow: Money.fromMinor(
      payments.reduce((sum, item) => sum + item.amount.minor, 0n),
    ),
    personalConsumption: Money.fromMinor(
      payments.reduce((sum, item) => sum + item.ownAmount.minor, 0n),
    ),
    payments: Object.freeze(payments),
    reimbursements: Object.freeze(reimbursements),
  });
}
