import type { ExpenseStore, Scope } from './expense-store.ts';
import type {
  SubscriptionCommand,
  SubscriptionResult,
  SubscriptionStatus,
  SubscriptionListQuery,
  SubscriptionList,
  SubscriptionReceivablesQuery,
  SubscriptionReceivables,
  SubscriptionCashFlow,
} from '../domain/subscriptions.ts';

/** The total cash payment, consumption component, shares and original intention
 * commit together. Reimbursements never share principal with the loans module. */
export interface SubscriptionStore extends ExpenseStore {
  executeSubscription(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: SubscriptionCommand,
  ): SubscriptionResult;
  getSubscriptionObligation(
    scope: Scope,
    obligationId: string,
    asOf: string,
  ): SubscriptionStatus;
  listSubscriptionObligations(
    scope: Scope,
    query: SubscriptionListQuery,
  ): SubscriptionList;
  getSubscriptionReceivables(
    scope: Scope,
    query: SubscriptionReceivablesQuery,
  ): SubscriptionReceivables;
  monthlySubscriptionCashFlow(
    scope: Scope,
    month: string,
  ): SubscriptionCashFlow;
}
