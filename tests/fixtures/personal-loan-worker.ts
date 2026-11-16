import { PersonalLoanService } from '../../src/application/personal-loan-service.ts';
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
    const api = new PersonalLoanService(
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
          operation === 'disburse'
            ? api.recordDisbursement(
                context,
                key,
                input as Parameters<
                  PersonalLoanService['recordDisbursement']
                >[2],
              )
            : api.recordRepayment(
                context,
                key,
                input as Parameters<PersonalLoanService['recordRepayment']>[2],
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
