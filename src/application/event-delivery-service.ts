import { DomainError } from '../domain/errors.ts';
import { correctionTime } from '../domain/expense-corrections.ts';
import { exactFields, identifier } from '../domain/expenses.ts';
import { eventCursor, eventPageLimit } from '../domain/event-delivery.ts';
import type { AccessContext, AccessPolicy, Action } from './expense-store.ts';
import type { EventDeliveryStore } from './event-delivery-store.ts';

export class EventDeliveryService {
  readonly #store: EventDeliveryStore;
  readonly #policy: AccessPolicy;
  readonly #clock: () => string;

  constructor(
    store: EventDeliveryStore,
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

  listPending(
    context: AccessContext,
    query: { readonly limit?: number; readonly cursor?: string } = {},
  ) {
    const bound = this.#authorize(context, 'event:read');
    exactFields(query, ['limit', 'cursor']);
    const limit = eventPageLimit(query.limit);
    const cursor =
      query.cursor === undefined ? undefined : eventCursor(query.cursor);
    return this.#store.listPending(
      bound,
      cursor === undefined ? { limit } : { limit, cursor },
    );
  }

  acknowledge(context: AccessContext, input: { readonly eventId: string }) {
    const bound = this.#authorize(context, 'event:ack');
    exactFields(input, ['eventId']);
    return this.#store.acknowledge(
      bound,
      identifier(input.eventId),
      bound.actorRef,
      correctionTime(this.#clock()),
    );
  }
}
