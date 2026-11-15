import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Scope } from '../application/expense-store.ts';
import { DomainError } from '../domain/errors.ts';
import { identifier } from '../domain/expenses.ts';

export interface EventPosition {
  readonly sequence: string;
  readonly id: string;
}
export interface DeliveryCursor {
  readonly after: EventPosition;
  readonly upper: EventPosition;
}
const aad = Buffer.from('don-gaston:event-delivery:cursor:v1');
const maximumSequence = 9223372036854775807n;

function position(value: unknown): EventPosition {
  if (!value || typeof value !== 'object') throw new Error();
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 2 ||
    typeof item.sequence !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(item.sequence) ||
    BigInt(item.sequence) > maximumSequence
  )
    throw new Error();
  return { sequence: item.sequence, id: identifier(item.id as string) };
}

/** Authenticated encryption hides scope and sequence as well as preventing edits.
 * The persisted local key is metadata, never authorization or an external token. */
export function encodeDeliveryCursor(
  key: Buffer,
  scope: Scope,
  value: DeliveryCursor,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      instanceRef: scope.instanceRef,
      subjectRef: scope.subjectRef,
      ...value,
    }),
  );
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return (
    'dg1.' +
    Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')
  );
}

export function decodeDeliveryCursor(
  key: Buffer,
  scope: Scope,
  cursor: string,
): DeliveryCursor {
  try {
    if (
      typeof cursor !== 'string' ||
      cursor.length > 2048 ||
      !/^dg1\.[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw new Error();
    const packed = Buffer.from(cursor.slice(4), 'base64url');
    if (packed.length <= 28 || packed.toString('base64url') !== cursor.slice(4))
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      packed.subarray(0, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(packed.subarray(12, 28));
    const body: unknown = JSON.parse(
      Buffer.concat([
        decipher.update(packed.subarray(28)),
        decipher.final(),
      ]).toString('utf8'),
    );
    if (!body || typeof body !== 'object') throw new Error();
    const decoded = body as Record<string, unknown>;
    if (
      Object.keys(decoded).length !== 5 ||
      decoded.version !== 1 ||
      decoded.instanceRef !== scope.instanceRef ||
      decoded.subjectRef !== scope.subjectRef
    )
      throw new Error();
    const after = position(decoded.after),
      upper = position(decoded.upper);
    if (BigInt(after.sequence) >= BigInt(upper.sequence)) throw new Error();
    return { after, upper };
  } catch {
    throw new DomainError('INVALID_CURSOR');
  }
}
