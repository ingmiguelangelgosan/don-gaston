import { DomainError } from './errors.ts';
import type { Expense } from './expenses.ts';

export interface ExpenseCorrection {
  readonly kind: 'correction';
  readonly id: string;
  readonly originalExpenseId: string;
  readonly replacement: Expense | null;
  readonly reason: string;
  readonly recordedAt: string;
  readonly actorRef: string;
}
export interface ExpenseHistory {
  readonly expense: Expense;
  readonly status: 'active' | 'voided' | 'replaced';
  readonly correctedBy: ExpenseCorrection | null;
  readonly replaces: ExpenseCorrection | null;
}
export function correctionReason(value: string): string {
  if (typeof value !== 'string') throw new DomainError('INVALID_CORRECTION');
  const result = value.trim();
  if (!result || result.length > 500 || /[\u0000-\u001f\u007f]/u.test(result))
    throw new DomainError('INVALID_CORRECTION');
  return result;
}
export function correctionTime(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new DomainError('INVALID_CORRECTION');
  return value;
}
