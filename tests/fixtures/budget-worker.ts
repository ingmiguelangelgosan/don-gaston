import { ExpenseService } from '../../src/application/expense-service.ts';
import { MonthlyBudgetService } from '../../src/application/monthly-budget-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext } from './expense-context.ts';

const [path, mode, key, categoryId, amount] = process.argv.slice(2);
if (!path || !mode || !key || !categoryId || !amount || !process.send) {
  process.exitCode = 2;
} else {
  let store: SqliteExpenseStore | undefined;
  const send = (message: object) => process.send?.(message);
  const finish = () => {
    store?.close();
    if (process.connected) process.disconnect();
  };
  const report = (error: unknown) =>
    send({
      type: 'error',
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'UNEXPECTED',
    });
  try {
    store = new SqliteExpenseStore(path, { busyTimeoutMs: 5000 });
    const policy = {
      allows(candidate: typeof primaryContext) {
        return (
          candidate.actorRef === primaryContext.actorRef &&
          candidate.instanceRef === primaryContext.instanceRef &&
          candidate.subjectRef === primaryContext.subjectRef
        );
      },
    };
    const expenses = new ExpenseService(store, policy);
    const budgets = new MonthlyBudgetService(store, policy);
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        finish();
        process.exitCode = 2;
        return;
      }
      try {
        const result =
          mode === 'set'
            ? budgets.setBudget(primaryContext, key, {
                categoryId,
                month: '2026-11',
                amount,
              })
            : expenses.recordExpense(primaryContext, key, {
                categoryId,
                occurredOn: '2026-11-08',
                amount,
              });
        send({ type: 'result', id: result.id });
      } catch (error) {
        report(error);
      } finally {
        finish();
      }
    });
    send({ type: 'ready' });
  } catch (error) {
    report(error);
    finish();
    process.exitCode = 1;
  }
}
