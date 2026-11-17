import { readFileSync, existsSync } from 'node:fs';
import { DemoAdapter } from '../../src/interfaces/jarvis-demo-adapter.ts';
import { DemoRequestJournal } from '../../src/interfaces/jarvis-demo-journal.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { startDemoHttps } from './jarvis-demo-https.ts';
import { demoExecute } from './jarvis-demo-client.ts';
import type { DemoCertificates } from './jarvis-demo-certificates.ts';
import type { DemoBinding } from '../../src/interfaces/jarvis-demo-adapter.ts';
import type { Request } from '../../src/interfaces/jarvis-demo-contract.ts';

// Test-only input is a fixture path, not a credential argument or environment source.
const file = process.argv[2];
if (!file) throw new Error('MISSING_SYNTHETIC_FIXTURE');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
  financePath: string;
  journalPath: string;
  binding: DemoBinding;
  certificates: DemoCertificates;
  request: Request;
  now: number;
};
if (!existsSync(fixture.financePath) || !existsSync(fixture.journalPath))
  throw new Error('MISSING_SYNTHETIC_STORE');
const journal = new DemoRequestJournal(fixture.journalPath);
const store = new SqliteExpenseStore(fixture.financePath);
const adapter = new DemoAdapter({
  store,
  journal,
  bindings: [fixture.binding],
  now: () => fixture.now,
});
const server = await startDemoHttps(fixture.certificates, (body, auth) =>
  adapter.handle(body, auth),
);
try {
  const result = await demoExecute(
    {
      port: server.port,
      ca: fixture.certificates.ca,
      token: fixture.binding.token,
    },
    fixture.request,
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  await server.close();
  store.close();
  journal.close();
}
