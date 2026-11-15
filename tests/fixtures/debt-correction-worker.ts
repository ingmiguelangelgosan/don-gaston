import { DebtPaymentCorrectionsService } from '../../src/application/debt-payment-corrections-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext as context } from './expense-context.ts';

const [path, key, paymentId, mode, amount] = process.argv.slice(2);
if (!path || !key || !paymentId || !mode || !amount || !process.send) {
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
    const policy = {
      allows: (candidate: typeof context) =>
        candidate.actorRef === context.actorRef &&
        candidate.subjectRef === context.subjectRef &&
        candidate.instanceRef === context.instanceRef,
    };
    const service = new DebtPaymentCorrectionsService(
      store,
      policy,
      () => '2026-11-15T12:00:00.000Z',
    );
    process.once('message', (message: unknown) => {
      if (message !== 'start') {
        finish();
        process.exitCode = 2;
        return;
      }
      try {
        const input = { paymentId, reason: 'Synthetic correction' };
        const result =
          mode === 'void'
            ? service.voidPayment(context, key, input)
            : service.replacePayment(context, key, {
                ...input,
                replacement: {
                  installmentNumber: 9,
                  amount,
                  currency: 'COP',
                  paidOn: '2026-11-15',
                  reference: 'synthetic-corrected',
                },
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
