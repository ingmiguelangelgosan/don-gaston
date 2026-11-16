import type { ExpenseStore, Scope } from './expense-store.ts';
import type {
  BillCommand,
  BillResult,
  BillStatus,
  BillList,
  BillListQuery,
  BillMonthlyCashOutflow,
} from '../domain/recurring-bills.ts';

/** All commands atomically commit their immutable result and intention. A payment
 * also commits its unique consumption fact and budget events in that transaction. */
export interface RecurringBillStore extends ExpenseStore {
  executeBill(
    scope: Scope,
    key: string,
    fingerprint: string,
    command: BillCommand,
  ): BillResult;
  getObligation(scope: Scope, id: string, asOf: string): BillStatus;
  listObligations(scope: Scope, query: BillListQuery): BillList;
  monthlyBillCashOutflow(scope: Scope, month: string): BillMonthlyCashOutflow;
}
