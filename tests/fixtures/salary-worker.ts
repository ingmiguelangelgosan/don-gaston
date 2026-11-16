import { SalaryService } from '../../src/application/salary-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext as context } from './expense-context.ts';

const [path, key, amount, mode = 'payment'] = process.argv.slice(2);
if (!path || !key || !amount || !process.send) {
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
    const service = new SalaryService(
      store,
      {
        allows: (candidate) =>
          candidate.actorRef === context.actorRef &&
          candidate.instanceRef === context.instanceRef &&
          candidate.subjectRef === context.subjectRef,
      },
      () => '2026-11-15T12:00:00.000Z',
    );
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        finish();
        process.exitCode = 2;
        return;
      }
      try {
        const result =
          mode === 'close'
            ? service.closePeriod(context, key, {
                month: '2026-10',
                closedOn: '2026-11-01',
              })
            : service.receivePayment(context, key, {
                amount,
                receivedOn: '2026-11-15',
                reference: 'synthetic-process-payment',
              });
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
