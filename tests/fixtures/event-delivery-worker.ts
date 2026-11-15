import { EventDeliveryService } from '../../src/application/event-delivery-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { primaryContext } from './expense-context.ts';

const [path, mode, eventId] = process.argv.slice(2);
if (!path || !mode || !process.send) {
  process.exitCode = 2;
} else {
  let store: SqliteExpenseStore | undefined;
  const finish = () => {
    store?.close();
    if (process.connected) process.disconnect();
  };
  const report = (error: unknown) =>
    process.send?.({
      type: 'error',
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : 'UNEXPECTED',
    });
  try {
    store = new SqliteExpenseStore(path, { busyTimeoutMs: 5000 });
    const service = new EventDeliveryService(
      store,
      {
        allows(candidate) {
          return (
            candidate.actorRef === primaryContext.actorRef &&
            candidate.instanceRef === primaryContext.instanceRef &&
            candidate.subjectRef === primaryContext.subjectRef
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
          mode === 'ack'
            ? service.acknowledge(primaryContext, { eventId: eventId ?? '' })
            : service.listPending(primaryContext, {});
        process.send?.({ type: 'result', result });
      } catch (error) {
        report(error);
      } finally {
        finish();
      }
    });
    process.send({ type: 'ready' });
  } catch (error) {
    report(error);
    finish();
    process.exitCode = 1;
  }
}
