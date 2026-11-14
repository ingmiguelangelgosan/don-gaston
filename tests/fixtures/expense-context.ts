import type {
  AccessContext,
  AccessPolicy,
  Action,
} from '../../src/application/expense-store.ts';

export const primaryContext: AccessContext = Object.freeze({
  actorRef: 'fixture-actor-1',
  subjectRef: 'fixture-subject-1',
  instanceRef: 'fixture-instance-1',
});

export const otherSubjectContext: AccessContext = Object.freeze({
  ...primaryContext,
  subjectRef: 'fixture-subject-2',
});

export const otherInstanceContext: AccessContext = Object.freeze({
  ...primaryContext,
  instanceRef: 'fixture-instance-2',
});

export const otherActorContext: AccessContext = Object.freeze({
  ...primaryContext,
  actorRef: 'fixture-actor-2',
});

// Política local ficticia: no autentica usuarios ni representa un contrato Jarvis.
export function fixturePolicy(): {
  policy: AccessPolicy;
  actions: Set<Action>;
} {
  const actions = new Set<Action>([
    'category:create',
    'expense:record',
    'expense:read',
  ]);
  const contexts = [
    primaryContext,
    otherSubjectContext,
    otherInstanceContext,
    otherActorContext,
  ];
  return {
    actions,
    policy: {
      allows(context, action) {
        return (
          actions.has(action) &&
          contexts.some(
            (allowed) =>
              allowed.actorRef === context.actorRef &&
              allowed.subjectRef === context.subjectRef &&
              allowed.instanceRef === context.instanceRef,
          )
        );
      },
    },
  };
}
