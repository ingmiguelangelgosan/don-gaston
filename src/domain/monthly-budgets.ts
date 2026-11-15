import type { Money } from './money.ts';

/** A monthly consumption limit, never a financial expense or cash movement. */
export interface MonthlyBudget {
  readonly kind: 'budget';
  readonly id: string;
  readonly categoryId: string;
  readonly month: string;
  readonly amount: Money;
  readonly actorRef: string;
}

/** Immutable internal event; delivery through a channel is outside this domain. */
export interface BudgetAlert {
  readonly id: string;
  readonly categoryId: string;
  readonly month: string;
  readonly threshold: 80 | 100;
  readonly budgetId: string;
  readonly consumed: Money;
  readonly triggerIntentKey: string;
}

export interface BudgetStatus {
  readonly month: string;
  readonly categoryId: string;
  /** null means unbudgeted; an explicit zero budget remains a budget. */
  readonly budget: MonthlyBudget | null;
  readonly consumed: Money;
  /** Exact percentage as a rational number; null if absent or denominator zero. */
  readonly percentage: {
    readonly numerator: bigint;
    readonly denominator: bigint;
  } | null;
  readonly alerts: readonly BudgetAlert[];
}

/** Highest currently reached threshold; durable deduplication belongs to storage. */
export function budgetThreshold(
  amount: Money,
  consumed: Money,
): 80 | 100 | null {
  if (consumed.minor === 0n) return null;
  if (consumed.minor >= amount.minor) return 100;
  if (consumed.minor * 100n >= amount.minor * 80n) return 80;
  return null;
}
