import { RecurringBillService } from '../../src/application/recurring-bill-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext as context } from './expense-context.ts';

const [path, key, operation, json] = process.argv.slice(2);
if (!path || !key || !operation || !json || !process.send) {
  process.exitCode = 2;
} else {
  let store: SqliteExpenseStore | undefined;
  const send = (value: object) => process.send?.(value);
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
    const api = new RecurringBillService(
      store,
      {
        allows: (bound) =>
          bound.actorRef === context.actorRef &&
          bound.subjectRef === context.subjectRef &&
          bound.instanceRef === context.instanceRef,
      },
      () => '2026-11-16T12:00:00.000Z',
    );
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        process.exitCode = 2;
        finish();
        return;
      }
      try {
        const input: unknown = JSON.parse(json);
        const result =
          operation === 'pay'
            ? api.confirmPayment(
                context,
                key,
                input as Parameters<RecurringBillService['confirmPayment']>[2],
              )
            : operation === 'adjust'
              ? api.adjustObligation(
                  context,
                  key,
                  input as Parameters<
                    RecurringBillService['adjustObligation']
                  >[2],
                )
              : api.generateObligation(
                  context,
                  key,
                  input as Parameters<
                    RecurringBillService['generateObligation']
                  >[2],
                );
        send({
          type: 'result',
          result: JSON.parse(JSON.stringify(result)) as unknown,
        });
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
