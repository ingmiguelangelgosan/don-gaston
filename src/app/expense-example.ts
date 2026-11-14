import { ExpenseService } from '../application/expense-service.ts';
import { InMemoryExpenseStore } from '../infrastructure/in-memory-expense-store.ts';

// Synthetic composition only. This allowlist is not production authentication.
const context = Object.freeze({
  actorRef: 'fixture-actor',
  subjectRef: 'fixture-subject',
  instanceRef: 'fixture-instance',
});
const service = new ExpenseService(new InMemoryExpenseStore(), {
  allows: (candidate, action) =>
    candidate.actorRef === context.actorRef &&
    candidate.subjectRef === context.subjectRef &&
    candidate.instanceRef === context.instanceRef &&
    ['category:create', 'expense:record', 'expense:read'].includes(action),
});
const category = service.createCategory(context, 'fixture-category-1', {
  name: 'Gasolina',
});
const input = {
  amount: '45000.00',
  currency: 'COP',
  categoryId: category.id,
  occurredOn: '2026-11-08',
};
const expense = service.recordExpense(context, 'fixture-expense-1', input);
const replay = service.recordExpense(context, 'fixture-expense-1', input);
console.log(
  JSON.stringify(
    {
      mode: 'synthetic-in-memory',
      sameFactOnRetry: expense.id === replay.id,
      recoveredFactId: service.findIntent(context, 'fixture-expense-1')?.id,
      totals: service.monthlyTotals(context, {
        month: '2026-11',
        categoryId: category.id,
      }),
    },
    null,
    2,
  ),
);
