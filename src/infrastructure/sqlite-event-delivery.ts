import type { DatabaseSync } from 'node:sqlite';
import type { Scope } from '../application/expense-store.ts';
import type { PendingEventQuery } from '../application/event-delivery-store.ts';
import { DomainError } from '../domain/errors.ts';
import { calendarMonth, identifier } from '../domain/expenses.ts';
import { correctionTime } from '../domain/expense-corrections.ts';
import { eventPageLimit } from '../domain/event-delivery.ts';
import type {
  DeliveryEvent,
  EventAcknowledgement,
  PendingEventPage,
} from '../domain/event-delivery.ts';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
} from './event-delivery-cursor.ts';
import type { EventPosition } from './event-delivery-cursor.ts';
import { StorageError } from './sqlite-errors.ts';

type Row = Record<string, unknown>;
export interface DeliveryFaults {
  readonly afterAcknowledgementInsert?: () => void;
  readonly afterAcknowledgementCommit?: () => void;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function position(row: Row): EventPosition {
  const sequence = text(row.sequence);
  if (
    !/^[1-9][0-9]{0,18}$/.test(sequence) ||
    BigInt(sequence) > 9223372036854775807n
  )
    throw new StorageError('STORAGE_CORRUPT');
  return { sequence, id: identifier(text(row.event_id)) };
}
function event(row: Row): DeliveryEvent {
  try {
    if (row.threshold !== 80 && row.threshold !== 100) throw new Error();
    return Object.freeze({
      version: 1,
      type: 'budget.threshold-reached',
      id: identifier(text(row.event_id)),
      categoryId: identifier(text(row.category_id)),
      month: calendarMonth(text(row.month)),
      threshold: row.threshold,
    });
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}
function acknowledgement(row: Row): EventAcknowledgement {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.actor_ref));
    return Object.freeze({
      version: 1,
      eventId: identifier(text(row.event_id)),
      status: 'processed',
      processedAt: correctionTime(text(row.processed_at)),
    });
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}

/** Internal component sharing the parent adapter's DB, limits and lifecycle.
 * Parent supplies read snapshots; acknowledgement owns its single write transaction. */
export class SqliteEventDelivery {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #key(): Buffer {
    const key = this.#db
      .prepare('SELECT cursor_key FROM event_delivery_config WHERE singleton=1')
      .get()?.cursor_key;
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))
      throw new StorageError('STORAGE_CORRUPT');
    return Buffer.from(key, 'hex');
  }

  verify(): void {
    this.#key();
    // FK checks cover forward references; check the reverse so an alert cannot
    // silently disappear from the pending feed if its index was removed offline.
    if (
      this.#db
        .prepare(
          `SELECT 1 FROM budget_alerts a WHERE NOT EXISTS (
      SELECT 1 FROM event_delivery_index d WHERE d.instance_ref=a.instance_ref AND d.subject_ref=a.subject_ref
        AND d.event_id=a.id) LIMIT 1`,
        )
        .get()
    )
      throw new StorageError('STORAGE_CORRUPT');
    for (const row of this.#db
      .prepare(
        'SELECT CAST(sequence AS TEXT) AS sequence, instance_ref,subject_ref,event_id FROM event_delivery_index',
      )
      .iterate()) {
      try {
        identifier(text(row.instance_ref));
        identifier(text(row.subject_ref));
        position(row);
      } catch {
        throw new StorageError('STORAGE_CORRUPT');
      }
    }
    for (const row of this.#db
      .prepare('SELECT * FROM event_acknowledgements')
      .iterate())
      acknowledgement(row);
  }

  listPending(scope: Scope, query: PendingEventQuery): PendingEventPage {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    const limit = eventPageLimit(query.limit);
    const key = this.#key();
    let after = 0n;
    let upper: EventPosition | undefined;
    if (query.cursor !== undefined) {
      const cursor = decodeDeliveryCursor(key, scope, query.cursor);
      for (const anchor of [cursor.after, cursor.upper]) {
        if (
          !this.#db
            .prepare(
              `SELECT 1 FROM event_delivery_index WHERE instance_ref=? AND subject_ref=? AND sequence=? AND event_id=?`,
            )
            .get(
              scope.instanceRef,
              scope.subjectRef,
              BigInt(anchor.sequence),
              anchor.id,
            )
        )
          throw new DomainError('INVALID_CURSOR');
      }
      after = BigInt(cursor.after.sequence);
      upper = cursor.upper;
    } else {
      const row = this.#db
        .prepare(
          `SELECT CAST(sequence AS TEXT) AS sequence,event_id FROM event_delivery_index
        WHERE instance_ref=? AND subject_ref=? ORDER BY event_delivery_index.sequence DESC LIMIT 1`,
        )
        .get(scope.instanceRef, scope.subjectRef);
      if (row) upper = position(row);
    }
    if (!upper)
      return Object.freeze({
        version: 1,
        events: Object.freeze([]),
        nextCursor: null,
      });
    const rows = this.#db
      .prepare(
        `SELECT CAST(d.sequence AS TEXT) AS sequence,d.event_id,a.category_id,a.month,a.threshold
      FROM event_delivery_index d JOIN budget_alerts a ON a.instance_ref=d.instance_ref AND a.subject_ref=d.subject_ref AND a.id=d.event_id
      WHERE d.instance_ref=? AND d.subject_ref=? AND d.sequence>? AND d.sequence<=?
        AND NOT EXISTS(SELECT 1 FROM event_acknowledgements r WHERE r.instance_ref=d.instance_ref AND r.subject_ref=d.subject_ref AND r.event_id=d.event_id)
      ORDER BY d.sequence LIMIT ?`,
      )
      .all(
        scope.instanceRef,
        scope.subjectRef,
        after,
        BigInt(upper.sequence),
        limit + 1,
      );
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? encodeDeliveryCursor(key, scope, { after: position(last), upper })
        : null;
    return Object.freeze({
      version: 1,
      events: Object.freeze(pageRows.map(event)),
      nextCursor,
    });
  }

  acknowledge(
    scope: Scope,
    eventId: string,
    actorRef: string,
    processedAt: string,
    faults: DeliveryFaults,
  ): EventAcknowledgement {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(eventId);
    identifier(actorRef);
    correctionTime(processedAt);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db
        .prepare(
          'SELECT * FROM event_acknowledgements WHERE instance_ref=? AND subject_ref=? AND event_id=?',
        )
        .get(scope.instanceRef, scope.subjectRef, eventId);
      if (prior) {
        const result = acknowledgement(prior);
        this.#db.exec('COMMIT');
        return result;
      }
      if (
        !this.#db
          .prepare(
            'SELECT 1 FROM event_delivery_index WHERE instance_ref=? AND subject_ref=? AND event_id=?',
          )
          .get(scope.instanceRef, scope.subjectRef, eventId)
      )
        throw new DomainError('EVENT_NOT_FOUND');
      this.#db
        .prepare(
          'INSERT INTO event_acknowledgements(instance_ref,subject_ref,event_id,actor_ref,processed_at) VALUES(?,?,?,?,?)',
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          eventId,
          actorRef,
          processedAt,
        );
      faults.afterAcknowledgementInsert?.();
      const result = acknowledgement({
        instance_ref: scope.instanceRef,
        subject_ref: scope.subjectRef,
        event_id: eventId,
        actor_ref: actorRef,
        processed_at: processedAt,
      });
      this.#db.exec('COMMIT');
      // Synthetic lost-reply injection: a throw here must NOT undo the committed receipt.
      faults.afterAcknowledgementCommit?.();
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
