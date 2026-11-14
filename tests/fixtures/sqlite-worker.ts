import { ExpenseService } from '../../src/application/expense-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { fixturePolicy, primaryContext } from './expense-context.ts';

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
  try {
    store = new SqliteExpenseStore(path, { busyTimeoutMs: 5000 });
    const service = new ExpenseService(store, fixturePolicy().policy);
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        finish();
        process.exitCode = 2;
        return;
      }
      try {
        const result =
          mode === 'read'
            ? service.findIntent(primaryContext, key)
            : service.recordExpense(primaryContext, key, {
                amount,
                currency: 'COP',
                categoryId,
                occurredOn: '2026-11-08',
              });
        send({ type: 'result', result });
      } catch (error) {
        send({
          type: 'error',
          code:
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : 'UNEXPECTED',
        });
      } finally {
        finish();
      }
    });
    send({ type: 'ready' });
  } catch (error) {
    send({
      type: 'error',
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'UNEXPECTED',
    });
    finish();
    process.exitCode = 1;
  }
}
