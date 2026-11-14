import { DomainError } from './errors.ts';
import type { Money } from './money.ts';

export interface Category {
  readonly kind: 'category';
  readonly id: string;
  readonly name: string;
  readonly actorRef: string;
}

/** One completed, simple consumption fact. Not an obligation or debt payment. */
export interface Expense {
  readonly kind: 'expense';
  readonly id: string;
  readonly categoryId: string;
  readonly amount: Money;
  readonly occurredOn: string;
  readonly actorRef: string;
}

export function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new DomainError('INVALID_IDENTIFIER');
  return value;
}

export function categoryName(value: string): string {
  if (typeof value !== 'string') throw new DomainError('INVALID_CATEGORY');
  const name = value.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name))
    throw new DomainError('INVALID_CATEGORY');
  return name;
}

export function calendarMonth(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)
  )
    throw new DomainError('INVALID_MONTH');
  return value;
}

export function calendarDate(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(value)
  )
    throw new DomainError('INVALID_DATE');
  // Numbers here represent calendar components, never money. No system timezone.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (days[month - 1] ?? 0)) throw new DomainError('INVALID_DATE');
  return value;
}

/** Reject unexpected financial fields instead of silently discarding them. */
export function exactFields(value: object, allowed: readonly string[]): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new DomainError('INVALID_INPUT');
}
