import { createHash } from 'node:crypto';
import { calendarDate } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';

export const MAX_WIRE_BYTES = 65_536;
export type WireCode =
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'UNKNOWN_CAPABILITY'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR';
const statuses: Readonly<Record<WireCode, number>> = Object.freeze({
  UNSUPPORTED_PROTOCOL: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UNKNOWN_CAPABILITY: 404,
  VALIDATION_FAILED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});
export function statusFor(code: WireCode): number {
  return statuses[code];
}
export class WireError extends Error {
  readonly code: WireCode;
  readonly status: number;
  constructor(code: WireCode) {
    super(code);
    this.name = 'WireError';
    this.code = code;
    this.status = statusFor(code);
  }
}
export interface Envelope {
  readonly protocol_version: '1.0';
  readonly instance_id: string;
  readonly agent_id: string;
  readonly subject_ref: string;
  readonly correlation_id: string;
  readonly request_id: string;
}
export interface RecordInput {
  readonly amount: string;
  readonly currency: 'COP';
  readonly categoryId: string;
  readonly occurredOn: string;
}
export interface LookupInput {
  readonly write_intent_id: string;
}
export type CapabilityName =
  'finance.expense.record' | 'finance.expense.lookup';
export interface Request extends Envelope {
  readonly kind: 'execute';
  readonly idempotency_key: string;
  readonly capability: {
    readonly name: CapabilityName;
    readonly version: '1.0';
  };
  readonly deadline_at: string;
  readonly cost_policy: 'no-paid-services';
  readonly input: RecordInput | LookupInput;
}
export interface ExpenseOutput {
  readonly id: string;
  readonly amount: { readonly minor: string; readonly currency: 'COP' };
  readonly categoryId: string;
  readonly occurredOn: string;
}
export interface RecordOutput {
  readonly expense: ExpenseOutput;
}
export type LookupOutput =
  | { readonly found: false }
  | { readonly found: true; readonly expense: ExpenseOutput };
export type Result =
  | (Envelope & {
      readonly kind: 'execution-result';
      readonly status: 'completed';
      readonly output: RecordOutput | LookupOutput;
    })
  | (Envelope & {
      readonly kind: 'execution-result';
      readonly status: 'failed';
      readonly error: {
        readonly code: WireCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly retry_after_ms?: number;
      };
    });
type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
type ObjectValue = Record<string, Json>;
function fail(): never {
  throw new WireError('VALIDATION_FAILED');
}
/** Detach untrusted data without invoking getters or toJSON. Monetary instances must
 * be explicitly converted to their public plain JSON projection before this boundary. */
export function jsonSnapshot(value: unknown): Json {
  let nodes = 0,
    textBytes = 0;
  const count = (value: string) => {
    textBytes += Buffer.byteLength(value);
    if (textBytes > MAX_WIRE_BYTES) fail();
  };
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > 8192 || depth > 32) fail();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      count(item);
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item))
      return Object.is(item, -0) ? 0 : item;
    if (typeof item !== 'object' || item === null) fail();
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Array.isArray(item)) {
      if (
        prototype !== Array.prototype ||
        item.length > 8192 ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        fail();
      const result: Json[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          fail();
        result.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== 'string')) fail();
    const pairs: [string, Json][] = [];
    for (const key of (keys as string[]).sort()) {
      if (['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key))
        fail();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        fail();
      count(key);
      pairs.push([key, visit(descriptor.value, depth + 1)]);
    }
    return Object.freeze(Object.fromEntries(pairs));
  };
  try {
    const result = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_WIRE_BYTES) fail();
    return result;
  } catch {
    return fail();
  }
}
function object(value: Json | undefined): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  return value as ObjectValue;
}
function exact(value: ObjectValue, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    fail();
}
export function wireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    fail();
  return value;
}
function civil(value: Json | undefined): string {
  if (typeof value !== 'string') fail();
  try {
    return calendarDate(value);
  } catch {
    return fail();
  }
}
function deadline(value: Json | undefined): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/.test(
      value,
    )
  )
    fail();
  civil(value.slice(0, 10));
  if (!Number.isFinite(Date.parse(value))) fail();
  return value;
}
const envelopeFields = [
  'protocol_version',
  'instance_id',
  'agent_id',
  'subject_ref',
  'correlation_id',
  'request_id',
] as const;
/** Correlation only; this does not authenticate or authorize the claimed scope. */
export function parseEnvelope(value: unknown): Envelope {
  const record = object(jsonSnapshot(value));
  if (record.protocol_version !== '1.0')
    throw new WireError('UNSUPPORTED_PROTOCOL');
  return Object.freeze({
    protocol_version: '1.0',
    instance_id: wireIdentifier(record.instance_id),
    agent_id: wireIdentifier(record.agent_id),
    subject_ref: wireIdentifier(record.subject_ref),
    correlation_id: wireIdentifier(record.correlation_id),
    request_id: wireIdentifier(record.request_id),
  });
}
export function responseEnvelope(request: Envelope): Envelope {
  return Object.freeze({
    protocol_version: '1.0',
    instance_id: request.instance_id,
    agent_id: request.agent_id,
    subject_ref: request.subject_ref,
    correlation_id: request.correlation_id,
    request_id: request.request_id,
  });
}
export function parseRequest(value: unknown): Request {
  const record = object(jsonSnapshot(value)),
    envelope = parseEnvelope(record);
  exact(record, [
    ...envelopeFields,
    'kind',
    'idempotency_key',
    'capability',
    'deadline_at',
    'cost_policy',
    'input',
  ]);
  if (record.kind !== 'execute' || record.cost_policy !== 'no-paid-services')
    fail();
  const capability = object(record.capability);
  exact(capability, ['name', 'version']);
  wireIdentifier(capability.name);
  wireIdentifier(capability.version);
  if (
    !['finance.expense.record', 'finance.expense.lookup'].includes(
      String(capability.name),
    ) ||
    capability.version !== '1.0'
  )
    throw new WireError('UNKNOWN_CAPABILITY');
  const input = object(record.input);
  if (capability.name === 'finance.expense.record') {
    exact(input, ['amount', 'currency', 'categoryId', 'occurredOn']);
    if (
      input.currency !== 'COP' ||
      typeof input.amount !== 'string' ||
      input.amount.length > 4097
    )
      fail();
    try {
      const amount = Money.fromDecimal(input.amount, 'COP');
      if (amount.minor <= 0n || amount.minor.toString().length > 4096) fail();
    } catch {
      fail();
    }
    wireIdentifier(input.categoryId);
    civil(input.occurredOn);
  } else {
    exact(input, ['write_intent_id']);
    wireIdentifier(input.write_intent_id);
  }
  return Object.freeze({
    ...envelope,
    kind: 'execute',
    idempotency_key: wireIdentifier(record.idempotency_key),
    capability: Object.freeze({
      name: capability.name as CapabilityName,
      version: '1.0',
    }),
    deadline_at: deadline(record.deadline_at),
    cost_policy: 'no-paid-services',
    input: input as unknown as RecordInput | LookupInput,
  });
}
function expense(value: Json | undefined): void {
  const result = object(value);
  exact(result, ['id', 'amount', 'categoryId', 'occurredOn']);
  wireIdentifier(result.id);
  wireIdentifier(result.categoryId);
  civil(result.occurredOn);
  const amount = object(result.amount);
  exact(amount, ['minor', 'currency']);
  if (
    amount.currency !== 'COP' ||
    typeof amount.minor !== 'string' ||
    amount.minor.length > 4096 ||
    !/^[1-9][0-9]*$/.test(amount.minor)
  )
    fail();
}
export function validateResult(value: unknown, request: Request): Result {
  const result = object(jsonSnapshot(value)),
    envelope = parseEnvelope(result);
  if (
    envelopeFields.some((field) => envelope[field] !== request[field]) ||
    result.kind !== 'execution-result'
  )
    fail();
  if (result.status === 'completed') {
    exact(result, [...envelopeFields, 'kind', 'status', 'output']);
    const output = object(result.output);
    if (request.capability.name === 'finance.expense.record') {
      exact(output, ['expense']);
      expense(output.expense);
    } else if (output.found === false) exact(output, ['found']);
    else if (output.found === true) {
      exact(output, ['found', 'expense']);
      expense(output.expense);
    } else fail();
  } else if (result.status === 'failed') {
    exact(result, [...envelopeFields, 'kind', 'status', 'error']);
    const error = object(result.error);
    exact(error, [
      'code',
      'message',
      'retryable',
      ...(error.retry_after_ms === undefined ? [] : ['retry_after_ms']),
    ]);
    if (
      typeof error.code !== 'string' ||
      !Object.hasOwn(statuses, error.code) ||
      typeof error.message !== 'string' ||
      error.message.length < 1 ||
      error.message.length > 512 ||
      typeof error.retryable !== 'boolean'
    )
      fail();
    if (
      error.retry_after_ms !== undefined &&
      (typeof error.retry_after_ms !== 'number' ||
        !Number.isInteger(error.retry_after_ms) ||
        error.retry_after_ms < 1 ||
        error.retry_after_ms > 86_400_000)
    )
      fail();
  } else fail();
  return result as unknown as Result;
}
export function requestKey(request: Request, writeIntentId?: string): string {
  const capability =
    writeIntentId === undefined
      ? request.capability
      : { name: 'finance.expense.record', version: '1.0' };
  const key =
    writeIntentId === undefined
      ? request.idempotency_key
      : wireIdentifier(writeIntentId);
  return `jg1-${createHash('sha256')
    .update(
      JSON.stringify([
        request.instance_id,
        request.subject_ref,
        request.agent_id,
        capability.name,
        capability.version,
        key,
      ]),
    )
    .digest('hex')}`;
}
export function requestFingerprint(request: Request): string {
  const { deadline_at, ...stable } = request;
  void deadline_at;
  return createHash('sha256')
    .update(JSON.stringify(jsonSnapshot(stable)))
    .digest('hex');
}
/** A bounded grammar walk rejects duplicate decoded keys before JSON.parse loses
 * that evidence. JSON.parse remains authoritative for JSON syntax and primitives. */
export function parseWireJson(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_WIRE_BYTES)
    fail();
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++;
  };
  const string = (): string => {
    if (text[at] !== '"') fail();
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '\\') {
        at++;
        continue;
      }
      if (character === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (++nodes > 8192 || depth > 32) fail();
    whitespace();
    const start = text[at];
    if (start === '{') {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (text[at++] !== ':') fail();
        value(depth + 1);
        whitespace();
        const delimiter = text[at++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail();
      }
    }
    if (start === '[') {
      at++;
      whitespace();
      if (text[at] === ']') {
        at++;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = text[at++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail();
      }
    }
    if (start === '"') {
      string();
      return;
    }
    const initial = at;
    while (at < text.length && !/[\x20\t\r\n,\]}]/.test(text[at]!)) at++;
    if (initial === at) fail();
  };
  try {
    value(0);
    whitespace();
    if (at !== text.length) fail();
    return jsonSnapshot(JSON.parse(text) as unknown);
  } catch {
    return fail();
  }
}
