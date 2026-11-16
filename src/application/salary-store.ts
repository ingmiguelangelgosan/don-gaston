import type { ExpenseStore, Scope } from './expense-store.ts';
import type {
  CloseDraft,
  OpeningDraft,
  SalaryMonthlyCashInflow,
  SalaryPaymentDetail,
  SalaryPaymentDraft,
  SalaryPeriod,
  SalaryReceipt,
  SalaryReceivables,
  SalaryVersion,
  SalaryVersionDraft,
} from '../domain/salary-receivables.ts';

/** All writes atomically persist their immutable result and scoped intent.
 * Receipt confirmation also persists all FIFO allocations in that transaction.
 * A review result has no allocation and no cash effect. */
export interface SalaryStore extends ExpenseStore {
  configureSalary(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: SalaryVersionDraft,
  ): SalaryVersion;
  importPendingPeriod(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: OpeningDraft,
  ): SalaryPeriod;
  closePeriod(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: CloseDraft,
  ): SalaryPeriod;
  receivePayment(
    scope: Scope,
    key: string,
    fingerprint: string,
    draft: SalaryPaymentDraft,
  ): SalaryReceipt;
  getReceivables(scope: Scope, asOf: string): SalaryReceivables;
  getPayment(scope: Scope, id: string): SalaryPaymentDetail;
  monthlyCashInflow(scope: Scope, month: string): SalaryMonthlyCashInflow;
}
