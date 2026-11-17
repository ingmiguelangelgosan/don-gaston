import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExpenseService } from '../src/application/expense-service.ts';
import { SqliteExpenseStore } from '../src/infrastructure/sqlite-expense-store.ts';
import { DemoAdapter } from '../src/interfaces/jarvis-demo-adapter.ts';
import { DemoRequestJournal } from '../src/interfaces/jarvis-demo-journal.ts';
import {
  parseRequest,
  requestKey,
} from '../src/interfaces/jarvis-demo-contract.ts';
import type {
  Request,
  Result,
} from '../src/interfaces/jarvis-demo-contract.ts';
import { demoCertificates } from './fixtures/jarvis-demo-certificates.ts';
import { startDemoHttps } from './fixtures/jarvis-demo-https.ts';
import type { DemoHttpsOptions } from './fixtures/jarvis-demo-https.ts';
import { demoExecute, rawDemoRequest } from './fixtures/jarvis-demo-client.ts';

const root = join(process.cwd(), '.cache', 'jarvis-synthetic-tests');
mkdirSync(root, { recursive: true });
const certificates = demoCertificates(root);
const untrustedCertificates = demoCertificates(root);
const now = () => Date.parse('2026-11-16T12:00:00.000Z');
const context = {
  actorRef: 'synthetic-delegate',
  instanceRef: 'synthetic-instance',
  subjectRef: 'synthetic-subject',
};
const policy = { allows: () => true };

async function setup(options: DemoHttpsOptions = {}) {
  const directory = mkdtempSync(join(root, 'ledger-')),
    financePath = join(directory, 'finance.sqlite'),
    journalPath = join(directory, 'requests.sqlite');
  let store = new SqliteExpenseStore(financePath),
    journal = new DemoRequestJournal(journalPath, { create: true });
  const token = randomBytes(32).toString('base64url'),
    readToken = randomBytes(32).toString('base64url'),
    foreignToken = randomBytes(32).toString('base64url');
  const bindings = [
    {
      token,
      instanceId: context.instanceRef,
      agentId: 'don-gaston.synthetic',
      subjectRef: context.subjectRef,
      actorRef: context.actorRef,
      actions: ['expense:record', 'expense:read'] as const,
    },
    {
      token: readToken,
      instanceId: context.instanceRef,
      agentId: 'don-gaston.synthetic',
      subjectRef: context.subjectRef,
      actorRef: 'synthetic-reader',
      actions: ['expense:read'] as const,
    },
    {
      token: foreignToken,
      instanceId: context.instanceRef,
      agentId: 'don-gaston.synthetic',
      subjectRef: 'other-subject',
      actorRef: 'synthetic-other',
      actions: ['expense:record', 'expense:read'] as const,
    },
  ];
  const expenses = new ExpenseService(store, policy);
  const category = expenses.createCategory(context, 'synthetic-category', {
    name: 'Gasolina ficticia',
  });
  let adapter = new DemoAdapter({ store, journal, bindings, now });
  const server = await startDemoHttps(
    certificates,
    (body, auth) => adapter.handle(body, auth),
    options,
  );
  const client = { port: server.port, ca: certificates.ca, token };
  const record = (id = 'expense-001'): Request =>
    parseRequest({
      protocol_version: '1.0',
      kind: 'execute',
      instance_id: context.instanceRef,
      agent_id: 'don-gaston.synthetic',
      subject_ref: context.subjectRef,
      correlation_id: `flow-${id}`,
      request_id: `request-${id}`,
      idempotency_key: id,
      capability: { name: 'finance.expense.record', version: '1.0' },
      deadline_at: '2026-11-16T12:00:20.000Z',
      cost_policy: 'no-paid-services',
      input: {
        amount: '45000',
        currency: 'COP',
        categoryId: category.id,
        occurredOn: '2026-11-16',
      },
    });
  const lookup = (write_intent_id = 'expense-001'): Request =>
    parseRequest({
      ...record(`lookup-${write_intent_id}`),
      capability: { name: 'finance.expense.lookup', version: '1.0' },
      input: { write_intent_id },
    });
  return {
    directory,
    financePath,
    journalPath,
    category,
    token,
    readToken,
    foreignToken,
    client,
    record,
    lookup,
    get store() {
      return store;
    },
    get journal() {
      return journal;
    },
    get adapter() {
      return adapter;
    },
    restart(
      storeOptions: ConstructorParameters<typeof SqliteExpenseStore>[1] = {},
    ) {
      store.close();
      journal.close();
      store = new SqliteExpenseStore(financePath, storeOptions);
      journal = new DemoRequestJournal(journalPath);
      adapter = new DemoAdapter({ store, journal, bindings, now });
    },
    async close() {
      await server.close();
      store.close();
      journal.close();
    },
  };
}
function expenseOf(result: Result) {
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed' || !('expense' in result.output))
    throw new Error('Missing synthetic expense');
  return result.output.expense;
}
function failure(result: Result, code: string) {
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed')
    throw new Error('Expected synthetic rejection');
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, false);
}

test('Jarvis synthetic HTTPS: 45000 COP is recorded once, looked up and recovered after restarting both stores', async () => {
  const f = await setup();
  try {
    const request = f.record(),
      first = await demoExecute(f.client, request),
      expense = expenseOf(first);
    assert.deepEqual(expense, {
      id: expense.id,
      amount: { minor: '4500000', currency: 'COP' },
      categoryId: f.category.id,
      occurredOn: '2026-11-16',
    });
    assert.deepEqual(await demoExecute(f.client, request), first);
    assert.deepEqual(
      expenseOf(await demoExecute(f.client, f.lookup())),
      expense,
    );
    f.restart();
    assert.deepEqual(await demoExecute(f.client, request), first);
    assert.deepEqual(
      expenseOf(await demoExecute(f.client, f.lookup())),
      expense,
    );
    assert.equal(f.store.listExpenses(context).length, 1);
    assert.equal(
      new ExpenseService(f.store, policy).monthlyTotals(context, {
        month: '2026-11',
      }).total.minor,
      4500000n,
    );
    assert.equal(f.store.listExpenses(context)[0]!.actorRef, context.actorRef);
    assert.ok(!JSON.stringify(first).includes(context.actorRef));
    assert.ok(!JSON.stringify(first).includes(requestKey(request)));
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: lost response after commit is recovered through lookup without resending a new write', async () => {
  let drop = true;
  const f = await setup({
    afterHandle: (reply) => {
      if (drop && reply.status === 200) {
        drop = false;
        return 'drop';
      }
      return undefined;
    },
  });
  try {
    await assert.rejects(demoExecute(f.client, f.record()));
    assert.equal(f.store.listExpenses(context).length, 1);
    const id = f.store.listExpenses(context)[0]!.id;
    f.restart();
    assert.equal(expenseOf(await demoExecute(f.client, f.lookup())).id, id);
    assert.equal(expenseOf(await demoExecute(f.client, f.record())).id, id);
    assert.equal(f.store.listExpenses(context).length, 1);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: changed financial content, request ID and correlation ID conflict durably', async () => {
  const f = await setup();
  try {
    const request = f.record();
    await demoExecute(f.client, request);
    f.restart();
    for (const modified of [
      { ...request, request_id: 'changed-request' },
      { ...request, correlation_id: 'changed-correlation' },
      { ...request, input: { ...request.input, amount: '45001' } },
    ])
      failure(
        await demoExecute(f.client, parseRequest(modified)),
        'IDEMPOTENCY_CONFLICT',
      );
    assert.equal(f.store.listExpenses(context).length, 1);
    assert.equal(
      expenseOf(
        await demoExecute(f.client, {
          ...request,
          deadline_at: '2026-11-16T12:00:25.000Z',
        }),
      ).amount.minor,
      '4500000',
    );
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: credential binding denies foreign scope and enforces read-only and revoked permissions', async () => {
  const f = await setup();
  try {
    const request = f.record();
    for (const options of [
      { ...f.client, token: 'synthetic-invalid' },
      { port: f.client.port, ca: f.client.ca },
    ]) {
      const rejected = await rawDemoRequest(options, JSON.stringify(request));
      assert.equal(rejected.status, 401);
    }
    failure(
      await demoExecute({ ...f.client, token: f.readToken }, request),
      'FORBIDDEN',
    );
    for (const modified of [
      { ...request, subject_ref: 'other-subject' },
      { ...request, instance_id: 'other-instance' },
      { ...request, agent_id: 'other-agent' },
    ])
      failure(await demoExecute(f.client, modified), 'FORBIDDEN');
    assert.equal(f.store.listExpenses(context).length, 0);
    const first = await demoExecute(f.client, request);
    assert.deepEqual(
      expenseOf(
        await demoExecute({ ...f.client, token: f.readToken }, f.lookup()),
      ),
      expenseOf(first),
    );
    const foreignLookup = { ...f.lookup(), subject_ref: 'other-subject' };
    const foreign = await demoExecute(
      { ...f.client, token: f.foreignToken },
      foreignLookup,
    );
    assert.equal(foreign.status, 'completed');
    if (foreign.status === 'completed')
      assert.deepEqual(foreign.output, { found: false });
    failure(
      await demoExecute(
        { ...f.client, token: f.foreignToken },
        { ...request, subject_ref: 'other-subject' },
      ),
      'VALIDATION_FAILED',
    );
    f.adapter.revoke(f.token);
    const revoked = await rawDemoRequest(f.client, JSON.stringify(request));
    assert.ok(revoked.status === 401 || revoked.status === 403);
    assert.equal(f.store.listExpenses(context).length, 1);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: lookup never returns a category or an unrelated financial intention', async () => {
  const f = await setup();
  try {
    const request = f.record('category-only');
    new ExpenseService(f.store, policy).createCategory(
      context,
      requestKey(request),
      { name: 'Synthetic wrong-kind' },
    );
    const result = await demoExecute(f.client, f.lookup('category-only'));
    assert.equal(result.status, 'completed');
    if (result.status === 'completed')
      assert.deepEqual(result.output, { found: false });
    const directLocal = await demoExecute(
      f.client,
      f.lookup('synthetic-category'),
    );
    assert.equal(directLocal.status, 'completed');
    if (directLocal.status === 'completed')
      assert.deepEqual(directLocal.output, { found: false });
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: financial rollback leaves a stable reservation and the same request can finish after restart', async () => {
  const f = await setup();
  try {
    const request = f.record();
    f.restart({
      afterFactInsert: () => {
        throw new Error('Synthetic financial failure');
      },
    });
    const failed = await rawDemoRequest(f.client, JSON.stringify(request));
    assert.ok(failed.status >= 500);
    assert.equal(f.store.listExpenses(context).length, 0);
    f.restart();
    failure(
      await demoExecute(f.client, {
        ...request,
        request_id: 'changed-after-failure',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(
      expenseOf(await demoExecute(f.client, request)).amount.minor,
      '4500000',
    );
    assert.equal(f.store.listExpenses(context).length, 1);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: an unavailable journal fails before creating a financial fact', async () => {
  const f = await setup();
  try {
    f.journal.close();
    const result = await rawDemoRequest(f.client, JSON.stringify(f.record()));
    assert.ok(result.status >= 500);
    assert.equal(f.store.listExpenses(context).length, 0);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic adapter: an elapsed deadline after durable reservation prevents a financial write', async () => {
  const f = await setup();
  try {
    let ticks = 0;
    const request = f.record();
    const adapter = new DemoAdapter({
      store: f.store,
      journal: f.journal,
      bindings: [
        {
          token: f.token,
          instanceId: context.instanceRef,
          agentId: request.agent_id,
          subjectRef: context.subjectRef,
          actorRef: context.actorRef,
          actions: ['expense:record'],
        },
      ],
      now: () => (ticks++ === 0 ? now() : now() + 21000),
    });
    const reply = adapter.handle(
      Buffer.from(JSON.stringify(request)),
      `Bearer ${f.token}`,
    );
    assert.equal(reply.status, 504);
    assert.equal(f.journal.has(requestKey(request)), true);
    assert.equal(f.store.listExpenses(context).length, 0);
    assert.equal(
      expenseOf(await demoExecute(f.client, request)).amount.minor,
      '4500000',
    );
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: replacing missing metadata cannot change IDs of a committed financial intent', async () => {
  const f = await setup();
  const replacement = new DemoRequestJournal(
    join(f.directory, 'incorrect-new-metadata.sqlite'),
    { create: true },
  );
  try {
    const request = f.record();
    await demoExecute(f.client, request);
    const binding = {
      token: f.token,
      instanceId: context.instanceRef,
      agentId: request.agent_id,
      subjectRef: context.subjectRef,
      actorRef: context.actorRef,
      actions: ['expense:record', 'expense:read'] as const,
    };
    const adapter = new DemoAdapter({
      store: f.store,
      journal: replacement,
      bindings: [binding],
      now,
    });
    const server = await startDemoHttps(certificates, (body, auth) =>
      adapter.handle(body, auth),
    );
    try {
      failure(
        await demoExecute(
          { ...f.client, port: server.port },
          { ...request, request_id: 'changed-with-new-journal' },
        ),
        'INTERNAL_ERROR',
      );
      failure(
        await demoExecute({ ...f.client, port: server.port }, f.lookup()),
        'INTERNAL_ERROR',
      );
      assert.equal(f.store.listExpenses(context).length, 1);
      assert.equal(replacement.has(requestKey(request)), false);
    } finally {
      await server.close();
    }
  } finally {
    replacement.close();
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: another OS process reopens the pair and recovers the identical effect', async () => {
  const f = await setup();
  const request = f.record();
  const first = await demoExecute(f.client, request);
  await f.close();
  const fixturePath = join(f.directory, 'synthetic-recovery-input.json');
  const binding = {
    token: f.token,
    instanceId: context.instanceRef,
    agentId: request.agent_id,
    subjectRef: context.subjectRef,
    actorRef: context.actorRef,
    actions: ['expense:record', 'expense:read'],
  };
  writeFileSync(
    fixturePath,
    JSON.stringify({
      financePath: f.financePath,
      journalPath: f.journalPath,
      binding,
      certificates,
      request,
      now: now(),
    }),
    { mode: 0o600 },
  );
  const result = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/jarvis-demo-recovery-process.ts', import.meta.url),
      ),
      fixturePath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.deepEqual(JSON.parse(result) as unknown, first);
  const recovered = new SqliteExpenseStore(f.financePath);
  try {
    assert.equal(recovered.listExpenses(context).length, 1);
  } finally {
    recovered.close();
  }
});

test('Jarvis synthetic HTTPS: invalid envelope, identity injection, dates, money, and expired deadlines have no effect', async () => {
  const f = await setup();
  try {
    const request = f.record();
    for (const [changed, status] of [
      [{ ...request, protocol_version: '1.0-draft' }, 400],
      [
        {
          ...request,
          capability: { name: 'finance.debt.pay', version: '1.0' },
        },
        404,
      ],
      [{ ...request, actorRef: 'injected' }, 422],
      [
        {
          ...request,
          input: { ...request.input, subject_ref: 'other-subject' },
        },
        422,
      ],
      [{ ...request, input: { ...request.input, amount: 45000 } }, 422],
      [{ ...request, input: { ...request.input, currency: 'USD' } }, 422],
      [
        { ...request, input: { ...request.input, occurredOn: '2026-02-30' } },
        422,
      ],
      [{ ...request, deadline_at: '2026-11-16T11:59:59.000Z' }, 504],
    ] as const)
      assert.equal(
        (await rawDemoRequest(f.client, JSON.stringify(changed))).status,
        status,
      );
    assert.equal(f.store.listExpenses(context).length, 0);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: duplicate JSON fields, malformed UTF-8, oversized body and forbidden transport are rejected', async () => {
  const f = await setup();
  try {
    const body = JSON.stringify(f.record());
    for (const invalid of [
      body.replace('"amount":"45000"', '"amount":"45000","amount":"1"'),
      Buffer.from([0xc3, 0x28]),
    ])
      assert.equal((await rawDemoRequest(f.client, invalid)).status, 422);
    assert.equal(
      (await rawDemoRequest(f.client, ' '.repeat(65537))).status,
      413,
    );
    assert.equal(
      (
        await rawDemoRequest(
          { ...f.client, headers: { 'Content-Encoding': 'gzip' } },
          body,
        )
      ).status,
      415,
    );
    assert.equal(
      (
        await rawDemoRequest(
          { ...f.client, headers: { 'Content-Type': 'text/plain' } },
          body,
        )
      ).status,
      415,
    );
    assert.equal(
      (await rawDemoRequest({ ...f.client, path: '/other' }, body)).status,
      404,
    );
    assert.equal(
      (await rawDemoRequest({ ...f.client, method: 'GET' }, body)).status,
      404,
    );
    assert.equal(f.store.listExpenses(context).length, 0);
  } finally {
    await f.close();
  }
});

test('Jarvis synthetic HTTPS: TLS rejects wrong CA and hostname before financial effects', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      demoExecute({ ...f.client, ca: untrustedCertificates.ca }, f.record()),
    );
    await assert.rejects(
      demoExecute(
        { ...f.client, servername: 'not-the-agent.test' },
        f.record(),
      ),
    );
    assert.equal(f.store.listExpenses(context).length, 0);
    assert.equal(
      expenseOf(await demoExecute(f.client, f.record())).amount.minor,
      '4500000',
    );
  } finally {
    await f.close();
  }
});

for (const mode of [
  'correlation',
  'redirect',
  'compression',
  'duplicate',
  'oversized',
  'status',
] as const) {
  test(`Jarvis synthetic consumer: rejects ${mode} response without automatically retrying the committed write`, async () => {
    let calls = 0;
    const f = await setup({
      transformReply: (reply) => {
        calls++;
        const body = reply.body as Record<string, unknown>;
        if (mode === 'correlation')
          return {
            status: reply.status,
            body: JSON.stringify({ ...body, correlation_id: 'foreign' }),
          };
        if (mode === 'redirect')
          return {
            status: 302,
            body: JSON.stringify(body),
            headers: { Location: 'https://other.invalid' },
          };
        if (mode === 'compression')
          return {
            status: reply.status,
            body: JSON.stringify(body),
            headers: { 'Content-Encoding': 'gzip' },
          };
        if (mode === 'duplicate')
          return {
            status: reply.status,
            body: JSON.stringify(body).replace(
              '"status":"completed"',
              '"status":"completed","status":"completed"',
            ),
          };
        if (mode === 'oversized')
          return { status: reply.status, body: ' '.repeat(65537) };
        return { status: 202, body: JSON.stringify(body) };
      },
    });
    try {
      await assert.rejects(demoExecute(f.client, f.record()));
      assert.equal(calls, 1);
      assert.equal(f.store.listExpenses(context).length, 1);
    } finally {
      await f.close();
    }
  });
}
