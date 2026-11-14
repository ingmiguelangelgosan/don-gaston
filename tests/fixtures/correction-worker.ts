import { ExpenseCorrectionsService } from '../../src/application/expense-corrections-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext } from './expense-context.ts';

const [path, mode, key, expenseId, categoryId, amount] = process.argv.slice(2);
if (
  !path ||
  !mode ||
  !key ||
  !expenseId ||
  !categoryId ||
  !amount ||
  !process.send
) {
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
    const service = new ExpenseCorrectionsService(
      store,
      {
        allows(context, action) {
          return (
            context.actorRef === primaryContext.actorRef &&
            context.subjectRef === primaryContext.subjectRef &&
            context.instanceRef === primaryContext.instanceRef &&
            (action === 'expense:correct' || action === 'expense:read')
          );
        },
      },
      () => '2026-11-14T12:00:00.000Z',
    );
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        finish();
        process.exitCode = 2;
        return;
      }
      try {
        const result =
          mode === 'void'
            ? service.voidExpense(primaryContext, key, {
                expenseId,
                reason: 'Corrección sintética',
              })
            : service.replaceExpense(primaryContext, key, {
                expenseId,
                reason: 'Corrección sintética',
                replacement: {
                  amount,
                  currency: 'COP',
                  categoryId,
                  occurredOn: '2026-11-08',
                },
              });
        send({ type: 'result', result });
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
