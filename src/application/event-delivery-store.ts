import type {
  EventAcknowledgement,
  PendingEventPage,
} from '../domain/event-delivery.ts';
import type { Scope } from './expense-store.ts';

export interface PendingEventQuery {
  readonly limit: number;
  readonly cursor?: string;
}

export interface EventDeliveryStore {
  /** Reading never acknowledges or reserves an event. The cursor fixes the upper
   * sequence for this traversal; pending status is evaluated at each page read.
   */
  listPending(scope: Scope, query: PendingEventQuery): PendingEventPage;
  /** Event identity is the stable idempotency key within its scope. The first
   * committed receipt is returned on every retry, including its original time.
   */
  acknowledge(
    scope: Scope,
    eventId: string,
    actorRef: string,
    processedAt: string,
  ): EventAcknowledgement;
}
