import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExpenseService } from '../application/expense-service.ts';
import { SqliteExpenseStore } from '../infrastructure/sqlite-expense-store.ts';

// Fixed synthetic fixture, deliberately unrelated to runtime .env or Jarvis.
const mode = process.argv[2];
if (mode !== 'write' && mode !== 'read') {
  console.error('Uso: sqlite-expense-example.ts write|read');
  process.exitCode = 1;
} else {
  let store: SqliteExpenseStore | undefined;
  try {
    const directory = resolve('.cache/sqlite-example');
    if (mode === 'write')
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    store = new SqliteExpenseStore(resolve(directory, 'synthetic.sqlite'), {
      readOnly: mode === 'read',
    });
    const context = Object.freeze({
      actorRef: 'fixture-actor',
      subjectRef: 'fixture-subject',
      instanceRef: 'fixture-instance',
    });
    const service = new ExpenseService(store, {
      allows: (candidate, action) =>
        candidate.actorRef === context.actorRef &&
        candidate.subjectRef === context.subjectRef &&
        candidate.instanceRef === context.instanceRef &&
        ['category:create', 'expense:record', 'expense:read'].includes(action),
    });
    if (mode === 'write') {
      const category = service.createCategory(context, 'fixture-category-1', {
        name: 'Gasolina',
      });
      service.recordExpense(context, 'fixture-expense-1', {
        amount: '45000.00',
        currency: 'COP',
        categoryId: category.id,
        occurredOn: '2026-11-08',
      });
    }
    const recovered = service.findIntent(context, 'fixture-expense-1');
    if (recovered?.kind !== 'expense') throw new Error('MISSING_FIXTURE');
    console.log(
      JSON.stringify(
        {
          mode,
          synthetic: true,
          fact: recovered,
          totals: service.monthlyTotals(context, { month: '2026-11' }),
        },
        null,
        2,
      ),
    );
  } catch {
    console.error('No se pudo completar el ejemplo SQLite sintético.');
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
