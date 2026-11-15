import { DomainError } from './errors.ts';

/** Minimal v1 projection of an existing, immutable budget alert. */
export interface DeliveryEvent {
  readonly version: 1;
  readonly type: 'budget.threshold-reached';
  readonly id: string;
  readonly categoryId: string;
  readonly month: string;
  readonly threshold: 80 | 100;
}

export interface PendingEventPage {
  readonly version: 1;
  readonly events: readonly DeliveryEvent[];
  /** End of this traversal, not confirmation that all events were processed. */
  readonly nextCursor: string | null;
}

/** Records the consumer's explicit processing confirmation, not network delivery. */
export interface EventAcknowledgement {
  readonly version: 1;
  readonly eventId: string;
  readonly status: 'processed';
  readonly processedAt: string;
}

export const EVENT_DELIVERY_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 100,
  maxCursorLength: 2048,
});

export function eventPageLimit(value: unknown): number {
  if (value === undefined) return EVENT_DELIVERY_LIMITS.defaultPageSize;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > EVENT_DELIVERY_LIMITS.maxPageSize
  )
    throw new DomainError('INVALID_INPUT');
  return value;
}

/** Format/authenticity and bound scope are additionally checked by storage. */
export function eventCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > EVENT_DELIVERY_LIMITS.maxCursorLength ||
    /\s/u.test(value)
  )
    throw new DomainError('INVALID_CURSOR');
  return value;
}
