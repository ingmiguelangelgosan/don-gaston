import { DomainError } from './errors.ts';
import { correctionTime } from './expense-corrections.ts';
import { calendarDate, calendarMonth, identifier } from './expenses.ts';
import { Money } from './money.ts';

interface LoanAudit {
  readonly actorRef: string;
  readonly recordedAt: string;
}
export type LoanDirection = 'receivable' | 'payable';
export interface LoanCounterparty extends LoanAudit {
  readonly kind: 'loan-counterparty';
  readonly id: string;
  readonly name: string;
}
export type LoanCounterpartyDraft = Omit<LoanCounterparty, 'kind' | 'id'>;
export interface LoanMovementDraft extends LoanAudit {
  readonly counterpartyId: string;
  readonly direction: LoanDirection;
  readonly amount: Money;
  readonly occurredOn: string;
  readonly reference: string;
}
export interface LoanMovement extends LoanMovementDraft {
  readonly kind: 'loan-movement';
  readonly id: string;
  readonly movementType: 'disbursement' | 'repayment';
  readonly status: 'confirmed' | 'review_required';
  readonly reviewReason:
    'EXCEEDS_PENDING_BALANCE' | 'PAYMENT_DATE_REQUIRES_REVIEW' | null;
  readonly cashDirection: 'inflow' | 'outflow' | null;
  /** Recorded principal after this decision, not a bank-verified balance. */
  readonly principalBalanceAfter: Money;
}
export type LoanResult = LoanCounterparty | LoanMovement;
export type LoanCommand =
  | {
      readonly operation: 'counterparty';
      readonly draft: LoanCounterpartyDraft;
    }
  | { readonly operation: 'disburse'; readonly draft: LoanMovementDraft }
  | { readonly operation: 'repay'; readonly draft: LoanMovementDraft };
/** Movements must be in durable registration order, within one authorized scope. */
export interface LoanState {
  readonly counterparties: readonly LoanCounterparty[];
  readonly movements: readonly LoanMovement[];
}
export interface LoanPositionQuery {
  readonly counterpartyId: string;
  readonly direction: LoanDirection;
  readonly asOf: string;
}
export interface LoanPosition {
  readonly counterparty: LoanCounterparty;
  readonly direction: LoanDirection;
  readonly asOf: string;
  readonly disbursed: Money;
  readonly repaid: Money;
  readonly balance: Money;
  readonly movements: readonly LoanMovement[];
}
export interface LoanPositions {
  readonly asOf: string;
  readonly positions: readonly {
    readonly counterparty: LoanCounterparty;
    readonly receivable: Money;
    readonly payable: Money;
  }[];
  readonly totalReceivable: Money;
  readonly totalPayable: Money;
}
export interface LoanCashFlow {
  readonly month: string;
  readonly currency: 'COP';
  readonly inflow: Money;
  readonly outflow: Money;
  readonly movements: readonly LoanMovement[];
}
export function loanDirection(value: LoanDirection): LoanDirection {
  if (value !== 'receivable' && value !== 'payable')
    throw new DomainError('INVALID_LOAN_DIRECTION');
  return value;
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
function audit(value: LoanAudit): LoanAudit {
  return {
    actorRef: identifier(value.actorRef),
    recordedAt: correctionTime(value.recordedAt),
  };
}
export function validateLoanCommand(command: LoanCommand): LoanCommand {
  switch (command.operation) {
    case 'counterparty':
      return Object.freeze({
        operation: 'counterparty',
        draft: Object.freeze({
          name: boundedText(
            command.draft.name,
            200,
            'INVALID_LOAN_COUNTERPARTY',
          ),
          ...audit(command.draft),
        }),
      });
    case 'disburse':
    case 'repay': {
      const value = command.draft;
      if (!(value.amount instanceof Money) || value.amount.minor <= 0n)
        throw new DomainError('INVALID_LOAN_AMOUNT');
      return Object.freeze({
        operation: command.operation,
        draft: Object.freeze({
          counterpartyId: identifier(value.counterpartyId),
          direction: loanDirection(value.direction),
          amount: Money.fromMinor(value.amount.minor, value.amount.currency),
          occurredOn: calendarDate(value.occurredOn),
          reference: boundedText(
            value.reference,
            128,
            'INVALID_LOAN_REFERENCE',
          ),
          ...audit(value),
        }),
      });
    }
    default:
      throw new DomainError('INVALID_LOAN_OPERATION');
  }
}
function samePosition(
  movement: LoanMovement,
  counterpartyId: string,
  direction: LoanDirection,
): boolean {
  return (
    movement.counterpartyId === counterpartyId &&
    movement.direction === direction
  );
}
function signedPrincipal(
  movement: Pick<LoanMovement, 'amount' | 'movementType'>,
): bigint {
  return movement.movementType === 'disbursement'
    ? movement.amount.minor
    : -movement.amount.minor;
}
/** Check every civil-date prefix, using durable registration order to break ties.
 * A backdated repayment must not consume capital needed by a later repayment. */
function validChronology(
  movements: readonly Pick<
    LoanMovement,
    'amount' | 'movementType' | 'occurredOn'
  >[],
): boolean {
  const chronological = movements
    .map((movement, sequence) => ({ movement, sequence }))
    .sort((a, b) =>
      a.movement.occurredOn < b.movement.occurredOn
        ? -1
        : a.movement.occurredOn > b.movement.occurredOn
          ? 1
          : a.sequence - b.sequence,
    );
  let balance = 0n;
  for (const { movement } of chronological) {
    balance += signedPrincipal(movement);
    if (balance < 0n) return false;
  }
  return true;
}
/** Evaluate while persistence holds the same write transaction used to commit. */
export function decideLoanCommand(
  state: LoanState,
  raw: LoanCommand,
  id: string,
): LoanResult {
  identifier(id);
  const command = validateLoanCommand(raw);
  if (command.operation === 'counterparty')
    return Object.freeze({ kind: 'loan-counterparty', id, ...command.draft });
  const draft = command.draft;
  if (!state.counterparties.some((party) => party.id === draft.counterpartyId))
    throw new DomainError('LOAN_COUNTERPARTY_NOT_FOUND');
  const confirmed = state.movements.filter(
    (movement) =>
      samePosition(movement, draft.counterpartyId, draft.direction) &&
      movement.status === 'confirmed',
  );
  if (!validChronology(confirmed))
    throw new DomainError('LOAN_INVARIANT_VIOLATION');
  const before = confirmed.reduce(
    (sum, movement) => sum + signedPrincipal(movement),
    0n,
  );
  const movementType =
    command.operation === 'disburse' ? 'disbursement' : 'repayment';
  let reviewReason: LoanMovement['reviewReason'] = null;
  if (movementType === 'repayment') {
    if (draft.amount.minor > before) reviewReason = 'EXCEEDS_PENDING_BALANCE';
    else if (!validChronology([...confirmed, { ...draft, movementType }]))
      reviewReason = 'PAYMENT_DATE_REQUIRES_REVIEW';
  }
  const status = reviewReason === null ? 'confirmed' : 'review_required';
  const cashDirection =
    reviewReason !== null
      ? null
      : (movementType === 'disbursement') === (draft.direction === 'payable')
        ? 'inflow'
        : 'outflow';
  return Object.freeze({
    kind: 'loan-movement',
    id,
    ...draft,
    movementType,
    status,
    reviewReason,
    cashDirection,
    principalBalanceAfter: Money.fromMinor(
      reviewReason === null
        ? before + signedPrincipal({ amount: draft.amount, movementType })
        : before,
    ),
  });
}
/** Date-specific projection of known immutable records, not historical knowledge. */
export function buildLoanPosition(
  state: LoanState,
  query: LoanPositionQuery,
): LoanPosition {
  identifier(query.counterpartyId);
  loanDirection(query.direction);
  calendarDate(query.asOf);
  const counterparty = state.counterparties.find(
    (party) => party.id === query.counterpartyId,
  );
  if (!counterparty) throw new DomainError('LOAN_COUNTERPARTY_NOT_FOUND');
  const movements = state.movements.filter(
    (movement) =>
      samePosition(movement, query.counterpartyId, query.direction) &&
      movement.occurredOn <= query.asOf,
  );
  let disbursed = 0n,
    repaid = 0n;
  for (const movement of movements)
    if (movement.status === 'confirmed') {
      if (movement.movementType === 'disbursement')
        disbursed += movement.amount.minor;
      else repaid += movement.amount.minor;
    }
  if (repaid > disbursed) throw new DomainError('LOAN_INVARIANT_VIOLATION');
  return Object.freeze({
    counterparty,
    direction: query.direction,
    asOf: query.asOf,
    disbursed: Money.fromMinor(disbursed),
    repaid: Money.fromMinor(repaid),
    balance: Money.fromMinor(disbursed - repaid),
    movements: Object.freeze(movements),
  });
}
export function buildLoanPositions(
  state: LoanState,
  query: { readonly asOf: string },
): LoanPositions {
  calendarDate(query.asOf);
  let totalReceivable = 0n,
    totalPayable = 0n;
  const positions = [...state.counterparties]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((counterparty) => {
      const receivable = buildLoanPosition(state, {
        counterpartyId: counterparty.id,
        direction: 'receivable',
        asOf: query.asOf,
      }).balance;
      const payable = buildLoanPosition(state, {
        counterpartyId: counterparty.id,
        direction: 'payable',
        asOf: query.asOf,
      }).balance;
      totalReceivable += receivable.minor;
      totalPayable += payable.minor;
      return Object.freeze({ counterparty, receivable, payable });
    });
  return Object.freeze({
    asOf: query.asOf,
    positions: Object.freeze(positions),
    totalReceivable: Money.fromMinor(totalReceivable),
    totalPayable: Money.fromMinor(totalPayable),
  });
}
export function buildLoanCashFlow(
  state: LoanState,
  month: string,
): LoanCashFlow {
  calendarMonth(month);
  const movements = state.movements.filter(
    (movement) =>
      movement.status === 'confirmed' &&
      movement.occurredOn.startsWith(month + '-'),
  );
  let inflow = 0n,
    outflow = 0n;
  for (const movement of movements) {
    if (movement.cashDirection === 'inflow') inflow += movement.amount.minor;
    else if (movement.cashDirection === 'outflow')
      outflow += movement.amount.minor;
    else throw new DomainError('LOAN_INVARIANT_VIOLATION');
  }
  return Object.freeze({
    month,
    currency: 'COP',
    inflow: Money.fromMinor(inflow),
    outflow: Money.fromMinor(outflow),
    movements: Object.freeze(movements),
  });
}
