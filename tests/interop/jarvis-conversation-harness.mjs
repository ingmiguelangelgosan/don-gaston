import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fixtureLifecycle,
  jarvisRepository,
  setup,
} from './jarvis-real-harness.mjs';
const source = (name) =>
  import(pathToFileURL(join(jarvisRepository, name)).href);
const { createTelegramHandler } = await source(
  'src/channels/telegram/handler.ts',
);
const { runTelegramPolling } = await source('src/channels/telegram/polling.ts');
const { TelegramApiError } = await source('src/channels/telegram/api.ts');
const { createExpenseConversation } = await source(
  'src/channels/telegram/expense-conversation.ts',
);
const { ExpenseConfirmationService } = await source(
  'src/app/expense-confirmation.ts',
);
const { SqliteConfirmationStore } = await source(
  'src/infrastructure/sqlite-confirmation-store.ts',
);
const { AgentReadService } = await source('src/app/agent-read.ts');
const { createTelegramAgentCommands } = await source(
  'src/channels/telegram/agent-commands.ts',
);

export async function setupConversation(options = {}) {
  let createJournal;
  const finance = await setup(
    { ...options, financeProfile: true },
    (factory) => {
      createJournal = factory;
    },
  );
  const path = join(finance.directory, 'conversation.sqlite');
  const actionKey = randomBytes(32).toString('base64url');
  const hash = (value) =>
    createHmac('sha256', Buffer.from(actionKey, 'base64url'))
      .update(JSON.stringify(value))
      .digest('hex');
  const scope = {
    ...finance.actor,
    conversation_ref: hash([
      'conversation',
      finance.actor.instance_id,
      finance.actor.subject_ref,
      777,
      42,
    ]),
  };
  const replies = [],
    attempts = [],
    actionIds = [];
  let consentNow = Date.now(),
    messageId = 0,
    reference,
    revoked = false,
    failedDelivery = false,
    faultUsed = false;
  let store, service, hooks, handle, conversationWriter;
  const run = (stage, work) =>
    conversationWriter ? conversationWriter.run(stage, work) : work();
  const journalAdmission = (work) =>
    conversationWriter
      ? conversationWriter.runSync('channel-journal', work)
      : work();
  const api = {
    async getMe() {
      return { id: 777, username: 'JarvisTestBot' };
    },
    async sendMessage(chatId, text) {
      return run('delivery', () => {
        attempts.push({ chatId, text });
        const ref = /Referencia (G-[a-f0-9]{12})/.exec(text)?.[1];
        if (ref) reference = ref;
        if (
          !failedDelivery &&
          ((options.failDelivery === 'prompt' &&
            text.startsWith('¿Confirmas')) ||
            (options.failDelivery === 'result' && text.startsWith('Listo,')))
        ) {
          failedDelivery = true;
          throw new TelegramApiError('transient');
        }
        replies.push({ chatId, text });
      });
    },
  };
  const execution = {
    async execute(actor, request, signal) {
      if (request.capability.name === 'finance.expense.record' && !faultUsed) {
        if (options.interruptBeforeDispatch) {
          faultUsed = true;
          throw Object.assign(new Error('Synthetic interrupted dispatch'), {
            outcome: 'uncertain',
          });
        }
        if (options.loseFlowResponse) {
          faultUsed = true;
          await finance.execution.execute(actor, request, signal);
          finance.restartGateway();
        }
      }
      return finance.execution.execute(actor, request, signal);
    },
  };
  function compose(create) {
    conversationWriter = finance.maintenance?.openWriter('conversation');
    store = new SqliteConfirmationStore({
      path,
      create,
      installation: hash(['installation', scope]),
    });
    service = new ExpenseConfirmationService({
      store,
      execution,
      registry: finance.registry,
      agentId: 'don-gaston.interop',
      now: () => consentNow,
      executionNow: Date.now,
    });
    const conversation = createExpenseConversation({
      instanceId: finance.actor.instance_id,
      actionKey,
      subjectFor: (userId) =>
        !revoked && userId === 42 ? finance.actor.subject_ref : undefined,
      categories: [
        {
          subjectRef: finance.actor.subject_ref,
          alias: 'gasolina',
          categoryId: finance.category.id,
          label: 'Gasolina',
        },
      ],
      service,
    });
    const journal = createJournal(actionKey);
    const trackedJournal = {
      ...journal,
      reserve(message) {
        return journalAdmission(() => {
          const id = journal.reserve(message);
          if (id) actionIds.push(id);
          return id;
        });
      },
      advance(botId, offset) {
        journalAdmission(() => journal.advance(botId, offset));
      },
      offset(botId) {
        return journalAdmission(() => journal.offset(botId));
      },
    };
    const reads = new AgentReadService(finance.registry, finance.execution);
    const agentCommands = createTelegramAgentCommands({
      instanceId: finance.actor.instance_id,
      actionKey,
      bindings: [
        { telegram_user_id: 42, subject_ref: finance.actor.subject_ref },
      ],
      reads,
    });
    let transportClock = 0;
    hooks = {
      ...(options.disabled ? {} : { expenseConversation: conversation }),
      agentCommands,
      agentJournal: trackedJournal,
      now: () => transportClock,
      wait: async (ms) => {
        transportClock += ms;
      },
    };
    handle = createTelegramHandler([42, 43], 'JarvisTestBot', api, hooks, 777);
  }
  function stopConversation() {
    const close = () => {
      store?.close();
      store = undefined;
    };
    return conversationWriter ? conversationWriter.stop(close) : close();
  }
  async function startConversation(create) {
    try {
      compose(create);
    } catch (error) {
      try {
        await stopConversation();
      } finally {
        await finance.close();
      }
      throw error;
    }
  }
  await startConversation(true);
  function update(text, overrides = {}) {
    const id = overrides.messageId ?? ++messageId;
    messageId = Math.max(messageId, id);
    return {
      update_id: id,
      message: {
        message_id: id,
        text,
        from: { id: overrides.userId ?? 42, is_bot: overrides.isBot ?? false },
        chat: {
          id: overrides.chatId ?? overrides.userId ?? 42,
          type: overrides.chatType ?? 'private',
        },
        ...(overrides.senderChat === undefined
          ? {}
          : { sender_chat: overrides.senderChat }),
      },
    };
  }
  return {
    finance,
    replies,
    attempts,
    async send(text, overrides = {}) {
      return run('command', async () => {
        await handle(update(text, overrides), new AbortController().signal);
        return replies.at(-1)?.text;
      });
    },
    async poll(messages) {
      return run('poll', async () => {
        const controller = new AbortController();
        let delivered = false;
        const updates = messages.map((text) => update(text));
        await runTelegramPolling(
          {
            ...api,
            async getUpdates() {
              conversationWriter?.assertOpen();
              if (!delivered) {
                delivered = true;
                return updates;
              }
              controller.abort();
              return [];
            },
          },
          [42, 43],
          controller.signal,
          hooks,
        );
      });
    },
    reference: () => reference,
    pending: () => (reference ? store.get(scope, reference) : undefined),
    history: (ref = reference) => (ref ? store.history(scope, ref) : []),
    deliveryStates: () => actionIds.map((id) => finance.actionPhase(id)),
    advance(ms) {
      consentNow += ms;
    },
    revoke() {
      revoked = true;
    },
    ...fixtureLifecycle(
      async () => {
        await stopConversation();
        await finance.restart();
        await startConversation(false);
      },
      async () => {
        const stopping = stopConversation();
        try {
          await stopping;
        } finally {
          await finance.close();
        }
      },
    ),
  };
}
