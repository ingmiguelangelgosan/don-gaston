import { createHash, timingSafeEqual } from 'node:crypto';
import { ExpenseService } from '../application/expense-service.ts';
import type {
  AccessContext,
  ExpenseStore,
} from '../application/expense-store.ts';
import type { Expense } from '../domain/expenses.ts';
import { DomainError } from '../domain/errors.ts';
import { StorageError } from '../infrastructure/sqlite-errors.ts';
import { DemoRequestJournal } from './jarvis-demo-journal.ts';
import {
  WireError,
  parseWireJson,
  parseRequest,
  parseEnvelope,
  responseEnvelope,
  requestKey,
  requestFingerprint,
  statusFor,
} from './jarvis-demo-contract.ts';
import type { Request, WireCode } from './jarvis-demo-contract.ts';

export interface DemoBinding {
  readonly token: string;
  readonly instanceId: string;
  readonly agentId: string;
  readonly subjectRef: string;
  readonly actorRef: string;
  readonly actions: readonly ('expense:record' | 'expense:read')[];
}
interface Bound {
  readonly digest: Buffer;
  readonly context: AccessContext;
  readonly agentId: string;
  readonly actions: readonly ('expense:record' | 'expense:read')[];
  active: boolean;
}
export interface DemoReply {
  readonly status: number;
  readonly body: unknown;
}
const wireIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
function expenseOutput(expense: Expense) {
  return {
    id: expense.id,
    amount: expense.amount.toJSON(),
    categoryId: expense.categoryId,
    occurredOn: expense.occurredOn,
  };
}
function codeFor(error: unknown): WireCode {
  if (error instanceof WireError) return error.code;
  if (error instanceof DomainError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') return 'IDEMPOTENCY_CONFLICT';
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    return 'VALIDATION_FAILED';
  }
  if (error instanceof StorageError) {
    if (error.code === 'STORAGE_LIMIT') return 'VALIDATION_FAILED';
    if (error.code === 'STORAGE_BUSY') return 'UNAVAILABLE';
  }
  return 'INTERNAL_ERROR';
}
/** Contract adapter only. No listener, environment credentials or network policy.
 * The HTTPS host and consumer live exclusively in synthetic test fixtures.
 */
export class DemoAdapter {
  readonly #store: ExpenseStore;
  readonly #journal: DemoRequestJournal;
  readonly #bindings: readonly Bound[];
  readonly #now: () => number;
  constructor(options: {
    readonly store: ExpenseStore;
    readonly journal: DemoRequestJournal;
    readonly bindings: readonly DemoBinding[];
    readonly now?: () => number;
  }) {
    this.#store = options.store;
    this.#journal = options.journal;
    this.#now = options.now ?? Date.now;
    if (
      !Array.isArray(options.bindings) ||
      options.bindings.length === 0 ||
      options.bindings.length > 100
    )
      throw new Error('INVALID_DEMO_BINDING');
    const seen = new Set<string>();
    this.#bindings = Object.freeze(
      options.bindings.map((binding) => {
        if (
          typeof binding.token !== 'string' ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(binding.token) ||
          [
            binding.instanceId,
            binding.agentId,
            binding.subjectRef,
            binding.actorRef,
          ].some((id) => typeof id !== 'string' || !wireIdentifier.test(id)) ||
          !Array.isArray(binding.actions) ||
          binding.actions.length === 0 ||
          binding.actions.some(
            (a: unknown) => a !== 'expense:record' && a !== 'expense:read',
          ) ||
          new Set(binding.actions).size !== binding.actions.length
        )
          throw new Error('INVALID_DEMO_BINDING');
        const hashed = digest(binding.token),
          key = hashed.toString('hex');
        if (seen.has(key)) throw new Error('INVALID_DEMO_BINDING');
        seen.add(key);
        return {
          digest: hashed,
          context: Object.freeze({
            instanceRef: binding.instanceId,
            subjectRef: binding.subjectRef,
            actorRef: binding.actorRef,
          }),
          agentId: binding.agentId,
          actions: Object.freeze([...binding.actions]),
          active: true,
        };
      }),
    );
  }
  revoke(token: string): void {
    const hash = digest(token);
    for (const bound of this.#bindings)
      if (timingSafeEqual(bound.digest, hash)) bound.active = false;
  }
  #authenticate(authorization: string | undefined): Bound {
    if (
      typeof authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)
    )
      throw new WireError('UNAUTHORIZED');
    const hash = digest(authorization.slice(7));
    let match: Bound | undefined;
    for (const bound of this.#bindings)
      if (timingSafeEqual(bound.digest, hash)) match = bound;
    if (!match || !match.active) throw new WireError('UNAUTHORIZED');
    return match;
  }
  handle(body: Uint8Array, authorization: string | undefined): DemoReply {
    let envelope: ReturnType<typeof parseEnvelope> | undefined;
    try {
      const bound = this.#authenticate(authorization);
      if (!(body instanceof Uint8Array) || body.byteLength > 65536)
        throw new WireError('VALIDATION_FAILED');
      let parsed: unknown;
      try {
        parsed = parseWireJson(
          new TextDecoder('utf-8', { fatal: true }).decode(body),
        );
      } catch (error) {
        if (error instanceof WireError) throw error;
        throw new WireError('VALIDATION_FAILED');
      }
      // Validate correlation separately so valid envelopes receive typed domain errors.
      envelope = parseEnvelope(parsed);
      if (
        envelope.instance_id !== bound.context.instanceRef ||
        envelope.subject_ref !== bound.context.subjectRef ||
        envelope.agent_id !== bound.agentId
      )
        throw new WireError('FORBIDDEN');
      const request = parseRequest(parsed);
      const action =
        request.capability.name === 'finance.expense.record'
          ? 'expense:record'
          : 'expense:read';
      if (!bound.actions.includes(action)) throw new WireError('FORBIDDEN');
      const now = this.#now(),
        deadline = Date.parse(request.deadline_at);
      if (!Number.isFinite(now) || deadline <= now)
        throw new WireError('TIMEOUT');
      if (deadline - now > 30000) throw new WireError('VALIDATION_FAILED');
      const service = new ExpenseService(this.#store, {
        allows: (context, requested) =>
          bound.active &&
          context.instanceRef === bound.context.instanceRef &&
          context.subjectRef === bound.context.subjectRef &&
          context.actorRef === bound.context.actorRef &&
          bound.actions.some((a) => a === requested),
      });
      const output = this.#execute(request, bound.context, service);
      return {
        status: 200,
        body: {
          ...responseEnvelope(request),
          kind: 'execution-result',
          status: 'completed',
          output,
        },
      };
    } catch (error) {
      const code = codeFor(error);
      // retryable=false never claims absence of financial effects on 500/timeout.
      const failure = { code, message: code, retryable: false };
      return {
        status: statusFor(code),
        body: envelope
          ? {
              ...responseEnvelope(envelope),
              kind: 'execution-result',
              status: 'failed',
              error: failure,
            }
          : { error: failure },
      };
    }
  }
  #execute(
    request: Request,
    context: AccessContext,
    service: ExpenseService,
  ): unknown {
    if (request.capability.name === 'finance.expense.record') {
      const key = requestKey(request);
      const prior = this.#store.findIntent(context, key);
      this.#journal.reserve(
        key,
        requestFingerprint(request),
        prior !== undefined,
      );
      // A journal lock may have consumed the deadline. A reservation alone is not a financial effect.
      if (this.#now() >= Date.parse(request.deadline_at))
        throw new WireError('TIMEOUT');
      const expense = service.recordExpense(
        context,
        key,
        request.input as {
          amount: string;
          currency: string;
          categoryId: string;
          occurredOn: string;
        },
      );
      return { expense: expenseOutput(expense) };
    }
    const key = requestKey(
      request,
      (request.input as { write_intent_id: string }).write_intent_id,
    );
    const found = service.findIntent(context, key);
    const reserved = this.#journal.has(key);
    if (found?.kind === 'expense' && !reserved)
      throw new StorageError('STORAGE_CORRUPT');
    return found?.kind === 'expense'
      ? { found: true, expense: expenseOutput(found) }
      : { found: false };
  }
}
