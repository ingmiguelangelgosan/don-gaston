// Opt-in integration only: these imports never enter Don Gaston's build/startup.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExpenseService } from '../../src/application/expense-service.ts';
import { SqliteExpenseStore } from '../../src/infrastructure/sqlite-expense-store.ts';
import { DemoAdapter } from '../../src/interfaces/jarvis-demo-adapter.ts';
import { DemoRequestJournal } from '../../src/interfaces/jarvis-demo-journal.ts';
import {
  parseRequest,
  validateResult,
  responseEnvelope,
  requestKey,
} from '../../src/interfaces/jarvis-demo-contract.ts';
import { demoCertificates } from '../fixtures/jarvis-demo-certificates.ts';
import { startDemoHttps } from '../fixtures/jarvis-demo-https.ts';

export const jarvisRepository = resolve(
  process.env.JARVIS_INTEROP_REPO ?? 'D:/Documentos/sir-jarvis',
);
// Explicit source allowlist. No bootstrap, environment loader or operational state.
const source = (name) =>
  import(pathToFileURL(join(jarvisRepository, name)).href);
const { InMemoryAgentRegistry } = await source('src/agents/registry.ts');
const { CapabilitySchemaCatalog } = await source('src/agents/validation.ts');
const { DurableAgentGateway } = await source('src/agents/durable-gateway.ts');
const { HttpsAgentTransport } = await source('src/agents/https-transport.ts');
const { EnvironmentAgentCredentials } = await source(
  'src/agents/credentials.ts',
);
const { AgentExecutionService } = await source('src/app/agent-execution.ts');
const { SqliteStateStore } = await source(
  'src/infrastructure/sqlite-state-store.ts',
);
const { AgentGatewayError } = await source('src/agents/errors.ts');
const { executionKey } = await source('src/agents/json.ts');
export const { HttpsEndpointPolicy } = await source(
  'src/agents/network-policy.ts',
);

const root = resolve('.cache/jarvis-real-interop');
mkdirSync(root, { recursive: true });
const certificates = demoCertificates(root);
const foreignCertificates = demoCertificates(root);
const context = Object.freeze({
  instanceRef: 'interop-instance',
  subjectRef: 'interop-subject',
  actorRef: 'interop-delegate',
});
const agentId = 'don-gaston.interop';
const capabilityNames = ['finance.expense.record', 'finance.expense.lookup'];

export async function setup(options = {}) {
  const directory = mkdtempSync(join(root, 'case-'));
  const paths = {
    finance: join(directory, 'finance.sqlite'),
    adapter: join(directory, 'adapter.sqlite'),
    jarvis: join(directory, 'jarvis.sqlite'),
  };
  const token = randomBytes(32).toString('base64url');
  const readToken = randomBytes(32).toString('base64url');
  const foreignToken = randomBytes(32).toString('base64url');
  const invalidToken = randomBytes(32).toString('base64url');
  const fingerprintKey = randomBytes(32).toString('base64url');
  const bindings = [
    {
      token,
      instanceId: context.instanceRef,
      agentId,
      subjectRef: context.subjectRef,
      actorRef: context.actorRef,
      actions: ['expense:record', 'expense:read'],
    },
    {
      token: readToken,
      instanceId: context.instanceRef,
      agentId,
      subjectRef: context.subjectRef,
      actorRef: 'interop-reader',
      actions: ['expense:read'],
    },
    {
      token: foreignToken,
      instanceId: context.instanceRef,
      agentId,
      subjectRef: 'other-subject',
      actorRef: 'interop-other',
      actions: ['expense:record', 'expense:read'],
    },
  ];
  let store,
    journal,
    stateStore,
    adapter,
    server,
    gateway,
    transport,
    service,
    registry,
    schemas;
  let calls = 0,
    drop = options.dropOnce === true,
    category;
  const schemaChecks = [];
  const actor = Object.freeze({
    instance_id: context.instanceRef,
    subject_ref: context.subjectRef,
  });
  const record = (id = 'expense-001') => ({
    protocol_version: '1.0',
    kind: 'execute',
    instance_id: actor.instance_id,
    agent_id: agentId,
    subject_ref: actor.subject_ref,
    correlation_id: `flow-${id}`,
    request_id: `request-${id}`,
    idempotency_key: id,
    capability: { name: capabilityNames[0], version: '1.0' },
    deadline_at: new Date(Date.now() + 20000).toISOString(),
    cost_policy: 'no-paid-services',
    input: {
      amount: '45000',
      currency: 'COP',
      categoryId: category.id,
      occurredOn: '2026-11-17',
    },
  });
  const lookup = (writeId = 'expense-001', readId = 'lookup-001') => ({
    ...record(readId),
    capability: { name: capabilityNames[1], version: '1.0' },
    input: { write_intent_id: writeId },
  });
  async function closeComponents() {
    const errors = [];
    for (const component of [
      gateway,
      transport,
      server,
      stateStore,
      journal,
      store,
    ]) {
      try {
        await component?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    gateway = transport = server = stateStore = journal = store = undefined;
    if (errors.length)
      throw new AggregateError(errors, 'Synthetic component cleanup failed');
  }
  async function start(create) {
    try {
      if (!create && Object.values(paths).some((path) => !existsSync(path)))
        throw new Error('Missing synthetic recovery database');
      store = new SqliteExpenseStore(paths.finance);
      journal = new DemoRequestJournal(paths.adapter, { create });
      stateStore = new SqliteStateStore({ path: paths.jarvis, create });
      if (create)
        category = new ExpenseService(store, {
          allows: () => true,
        }).createCategory(context, 'interop-category', {
          name: 'Gasolina ficticia',
        });
      adapter = new DemoAdapter({ store, journal, bindings });
      server = await startDemoHttps(
        certificates,
        (body, auth) => {
          calls++;
          return adapter.handle(body, auth);
        },
        {
          afterHandle: (reply) => {
            if (drop && reply.body.status === 'completed') {
              drop = false;
              return 'drop';
            }
          },
          ...(options.transformReply
            ? { transformReply: options.transformReply }
            : {}),
        },
      );
      const hostname = options.wrongHostname
        ? 'wrong-don-gaston.test'
        : 'don-gaston.test';
      const origin = `https://${hostname}:${server.port}`;
      // Trusted schema definitions for the approved financial profile; validation
      // and dispatch are performed by Jarvis's real CapabilitySchemaCatalog.
      const definitions = capabilityNames.flatMap((name) =>
        ['input', 'output'].map((direction) => ({
          id: `${name}.${direction}.v1`,
          schema: {
            parse(value) {
              schemaChecks.push(`${name}.${direction}.v1`);
              const request =
                name === capabilityNames[0]
                  ? record('schema')
                  : lookup('schema', 'schema-lookup');
              if (direction === 'input')
                parseRequest({ ...request, input: value });
              else
                validateResult(
                  {
                    ...responseEnvelope(request),
                    kind: 'execution-result',
                    status: 'completed',
                    output: value,
                  },
                  request,
                );
              return value;
            },
          },
        })),
      );
      schemas = new CapabilitySchemaCatalog(
        options.financeProfile
          ? (await source('src/agents/finance-expense-profile.ts'))
              .financeExpenseSchemas
          : definitions,
      );
      const capabilities = capabilityNames.map((name, index) => ({
        name,
        version: '1.0',
        description: 'Synthetic interoperability fixture',
        effect: index === 0 ? 'write' : 'read',
        supports_idempotency: true,
        input_schema_id: `${name}.input.v1`,
        output_schema_id: `${name}.output.v1`,
      }));
      registry = new InMemoryAgentRegistry(
        [
          {
            instance_id: actor.instance_id,
            descriptor: {
              protocol_version: '1.0',
              agent_id: agentId,
              agent_version: '1.0',
              name: 'Don Gaston synthetic',
              capabilities,
            },
            enabled: true,
            availability: 'available',
            connection: {
              base_url: origin,
              request_credential_ref: 'synthetic-request',
              event_key_ref: 'synthetic-unused-event',
            },
            permissions: [
              {
                subject_ref: actor.subject_ref,
                capabilities: capabilities
                  .filter(
                    (item) =>
                      !options.registryReadOnly || item.effect === 'read',
                  )
                  .map(({ name, version }) => ({ name, version })),
              },
            ],
          },
        ],
        schemas,
        [origin],
      );
      const selectedToken =
        {
          invalid: invalidToken,
          'read-only': readToken,
          foreign: foreignToken,
        }[options.credential] ?? token;
      const credentials = new EnvironmentAgentCredentials(
        { 'synthetic-request': 'SYNTHETIC_INTEROP_TOKEN' },
        () => selectedToken,
      );
      const network = {
        async resolve(value, signal) {
          if (signal.aborted) throw new AgentGatewayError('CANCELLED');
          if (value !== origin) throw new AgentGatewayError('FORBIDDEN');
          return {
            origin,
            hostname,
            port: server.port,
            address: '127.0.0.1',
            family: 4,
          };
        },
      };
      transport = new HttpsAgentTransport(
        registry,
        schemas,
        network,
        credentials,
        {
          ca: options.untrustedCa ? foreignCertificates.ca : certificates.ca,
          timeoutMs: 1500,
        },
      );
      gateway = new DurableAgentGateway(
        registry,
        schemas,
        transport,
        stateStore,
        fingerprintKey,
        { resultCacheMs: 30000, attemptTimeoutMs: 2000, totalTimeoutMs: 4000 },
      );
      service = new AgentExecutionService(registry, gateway);
    } catch (error) {
      await closeComponents();
      throw error;
    }
  }
  await start(true);
  return {
    directory,
    paths,
    category,
    actor,
    record,
    lookup,
    schemaChecks,
    // Test composition ports; no operational loader or additional network surface.
    get registry() {
      return registry;
    },
    get execution() {
      return service;
    },
    get durableStore() {
      return stateStore;
    },
    get calls() {
      return calls;
    },
    execute(request, boundActor = actor) {
      return service.execute(boundActor, request, new AbortController().signal);
    },
    expenses() {
      return store.listExpenses(context);
    },
    state(request) {
      return stateStore.getExecution(
        createHash('sha256').update(executionKey(request)).digest('hex'),
      );
    },
    reservation(request) {
      return journal.has(requestKey(request));
    },
    restartGateway() {
      gateway.close();
      // Preserve the live transport/store: reconstruct only volatile execution state.
      gateway = new DurableAgentGateway(
        registry,
        schemas,
        transport,
        stateStore,
        fingerprintKey,
        { resultCacheMs: 30000, attemptTimeoutMs: 2000, totalTimeoutMs: 4000 },
      );
      service = new AgentExecutionService(registry, gateway);
    },
    async restart() {
      await closeComponents();
      await start(false);
    },
    close: closeComponents,
  };
}
