import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { createSession, defineAction } from '../src/kernel.js';
import { openTaskView, TaskRepository } from '../src/task-app.js';
import type {
  ActionResult,
  Invocation,
  JsonValue,
  Observation,
  Session,
  SessionOptions,
} from '../src/contracts.js';

const taskIds = ['a', 'b', 'c', 'd'] as const;
const initialTasks = taskIds.map(id => ({ id, title: `Task ${id}` }));
const sessions = new Set<Session>();

function fixture(options: SessionOptions = {}) {
  const session = createSession(options);
  sessions.add(session);
  return { session, repository: new TaskRepository(initialTasks) };
}

function invocationFor(
  observation: Observation,
  viewId: string,
  taskId: string,
  invocationId: string,
  input: JsonValue = {},
): Invocation {
  const view = observation.views.find(candidate => candidate.id === viewId);
  const item = view?.items.find(candidate => candidate.target.id === taskId);
  const action = item?.actions[0];
  if (!action) throw new Error(`No published action for ${viewId}/${taskId}.`);
  return {
    observationId: observation.id,
    actionBindingId: action.bindingId,
    invocationId,
    input,
  };
}

function expectCompleted(repository: TaskRepository, ids: readonly string[]) {
  expect(repository.list().filter(task => task.done).map(task => task.id).sort())
    .toEqual([...ids].sort());
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Test business work cooperates with cancellation, so cleanup cannot strand it. */
function waitForGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('The business operation observed cancellation.'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

afterEach(async () => {
  const active = [...sessions];
  sessions.clear();
  await Promise.all(active.map(session => session.close()));
});

describe('observed object identity and conditional business writes', () => {
  it('keeps an old binding pointed at its original task after a list reorder', async () => {
    const { session, repository } = fixture();
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();
    const request = invocationFor(observation, 'inbox', 'b', 'complete-original-b');

    repository.reorder(['d', 'a', 'c', 'b']);

    const result = await session.execute(request);
    expect(result.status).toBe('succeeded');
    expectCompleted(repository, ['b']);
    expect(repository.writes).toBe(1);
  });

  it('rejects a changed target, while another task from the same observation remains actionable', async () => {
    const { session, repository } = fixture();
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();

    repository.rename('a', 'Changed by another operator');

    const stale = await session.execute(invocationFor(observation, 'inbox', 'a', 'stale-a'));
    expect(stale).toMatchObject({ status: 'rejected', code: 'STALE_RESOURCE' });
    expect(repository.get('a')?.title).toBe('Changed by another operator');
    expectCompleted(repository, []);
    expect(repository.writes).toBe(0);

    const unaffected = await session.execute(invocationFor(observation, 'inbox', 'b', 'unaffected-b'));
    expect(unaffected.status).toBe('succeeded');
    expectCompleted(repository, ['b']);
    expect(repository.writes).toBe(1);
  });

  it('does not silently bind a deleted task to a remaining list row', async () => {
    const { session, repository } = fixture();
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();
    repository.remove('a');

    const result = await session.execute(invocationFor(observation, 'inbox', 'a', 'deleted-a'));

    expect(result).toMatchObject({ status: 'rejected', code: 'NOT_FOUND' });
    expect(repository.get('a')).toBeUndefined();
    expectCompleted(repository, []);
    expect(repository.writes).toBe(0);
  });

  it('rejects an old reference after deletion and recreation of the same ID and data', async () => {
    const { session, repository } = fixture();
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();
    const original = repository.get('a')!;
    repository.remove('a');
    repository.put('a', original.title);
    expect(repository.get('a')?.revision).not.toBe(original.revision);

    const result = await session.execute(invocationFor(observation, 'inbox', 'a', 'recreated-a'));

    expect(result).toMatchObject({ status: 'rejected', code: 'STALE_RESOURCE' });
    expectCompleted(repository, []);
    expect(repository.writes).toBe(0);
  });

  it('preserves target identity through generated reorder and unrelated-edit sequences', async () => {
    const reorder = fc.shuffledSubarray([...taskIds], {
      minLength: taskIds.length,
      maxLength: taskIds.length,
    }).map(order => ({ kind: 'reorder' as const, order }));
    const unrelatedEdit = fc.record({
      kind: fc.constant('rename' as const),
      slot: fc.integer({ min: 0, max: taskIds.length - 2 }),
      title: fc.string({ maxLength: 24 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...taskIds),
        fc.array(fc.oneof(reorder, unrelatedEdit), { maxLength: 30 }),
        async (targetId, operations) => {
          const repository = new TaskRepository(initialTasks);
          const session = createSession({ now: () => 1000, ttlMs: 1000 });
          try {
            openTaskView(session, repository, 'inbox');
            const request = invocationFor(session.observe(), 'inbox', targetId, 'property-write');
            const unrelatedIds = taskIds.filter(id => id !== targetId);

            for (const operation of operations) {
              if (operation.kind === 'reorder') repository.reorder(operation.order);
              else repository.rename(unrelatedIds[operation.slot]!, operation.title);
            }

            const result = await session.execute(request);
            expect(result.status).toBe('succeeded');
            expectCompleted(repository, [targetId]);
            expect(repository.writes).toBe(1);
          } finally {
            await session.close();
          }
          expect(repository.listenerCount).toBe(0);
        },
      ),
      // fast-check reports its shrink path with this seed for reproducing failures.
      { seed: 20261019, numRuns: 250, verbose: true },
    );
  });
});

describe('view ownership and business result semantics', () => {
  it('revokes only the closed instance and never resurrects its old bindings on reopen', async () => {
    const { session, repository } = fixture();
    const closeLeft = openTaskView(session, repository, 'left');
    openTaskView(session, repository, 'right');
    const original = session.observe();
    expect(repository.listenerCount).toBe(2);

    await closeLeft();
    expect(repository.listenerCount).toBe(1);
    const oldLeft = await session.execute(invocationFor(original, 'left', 'a', 'closed-left'));
    expect(oldLeft).toMatchObject({ status: 'rejected', code: 'BINDING_REVOKED' });

    const right = await session.execute(invocationFor(original, 'right', 'b', 'still-open-right'));
    expect(right.status).toBe('succeeded');
    expectCompleted(repository, ['b']);

    openTaskView(session, repository, 'left');
    expect(repository.listenerCount).toBe(2);
    // A new invocation ID ensures the earlier cached rejection cannot mask resurrection.
    const resurrected = await session.execute(invocationFor(original, 'left', 'a', 'old-left-after-reopen'));
    expect(resurrected).toMatchObject({ status: 'rejected', code: 'BINDING_REVOKED' });

    const reopened = await session.execute(invocationFor(session.observe(), 'left', 'a', 'new-left'));
    expect(reopened.status).toBe('succeeded');
    expectCompleted(repository, ['a', 'b']);
    expect(repository.writes).toBe(2);
  });

  it('preserves an explicit business rejection without wrapping it in success', async () => {
    const { session, repository } = fixture();
    const rejection: ActionResult = {
      status: 'rejected',
      code: 'BUSINESS_DENIED',
      message: 'The task owner must approve this operation.',
    };
    const action = defineAction({
      name: 'requires_approval',
      description: 'Exercise a real business rejection.',
      input: z.strictObject({}),
      execute: () => rejection,
    });
    openTaskView(session, repository, 'inbox', action);

    const result = await session.execute(invocationFor(session.observe(), 'inbox', 'a', 'business-denied'));

    expect(result).toEqual(rejection);
    expectCompleted(repository, []);
    expect(repository.writes).toBe(0);
  });
});

describe('invocation identity', () => {
  it('coalesces concurrent identical calls, rejects conflicting input, and returns the recorded result on retry', async () => {
    const { session, repository } = fixture();
    const started = deferred();
    const release = deferred();
    let handlerEntries = 0;
    const action = defineAction({
      name: 'complete_with_note',
      description: 'Complete a task after externally controlled business work.',
      input: z.strictObject({ note: z.string() }),
      execute: async context => {
        handlerEntries++;
        started.resolve();
        await waitForGate(release.promise, context.signal);
        return repository.complete(context);
      },
    });
    openTaskView(session, repository, 'inbox', action);
    const request = invocationFor(session.observe(), 'inbox', 'a', 'one-intent', { note: 'original' });
    const first = session.execute(request);
    await started.promise;
    const duplicate = session.execute({ ...request, input: { note: 'original' } });

    const conflict = await session.execute({ ...request, input: { note: 'different' } });
    expect(conflict).toMatchObject({ status: 'rejected', code: 'ID_CONFLICT' });
    expect(handlerEntries).toBe(1);
    expect(repository.writes).toBe(0);

    release.resolve();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult.status).toBe('succeeded');
    expect(duplicateResult).toEqual(firstResult);
    expect(await session.execute({ ...request })).toEqual(firstResult);
    expect(handlerEntries).toBe(1);
    expectCompleted(repository, ['a']);
    expect(repository.writes).toBe(1);
  });
});

describe('observation lifetime and validation races', () => {
  it('rejects an expired observation before producing a business effect', async () => {
    let now = 1000;
    const { session, repository } = fixture({ now: () => now, ttlMs: 10 });
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();
    now = observation.expiresAt + 1;

    const result = await session.execute(invocationFor(observation, 'inbox', 'a', 'expired'));

    expect(result).toMatchObject({ status: 'rejected', code: 'OBSERVATION_EXPIRED' });
    expectCompleted(repository, []);
    expect(repository.writes).toBe(0);
  });

  it('rejects evicted observations and retains a usable newer observation', async () => {
    const { session, repository } = fixture({ maxObservations: 1 });
    openTaskView(session, repository, 'inbox');
    const old = session.observe();
    repository.rename('d', 'A newer projection');
    const current = session.observe();
    expect(current.id).not.toBe(old.id);
    expect(session.inspect().observations).toBe(1);

    const evicted = await session.execute(invocationFor(old, 'inbox', 'a', 'evicted'));
    expect(evicted).toMatchObject({ status: 'rejected', code: 'OBSERVATION_NOT_FOUND' });
    expect(repository.writes).toBe(0);
    const usable = await session.execute(invocationFor(current, 'inbox', 'a', 'current'));
    expect(usable.status).toBe('succeeded');
    expectCompleted(repository, ['a']);
  });

  it('rechecks view ownership after asynchronous input validation', async () => {
    const { session, repository } = fixture();
    const validating = deferred();
    const validate = deferred();
    let handlerEntries = 0;
    const action = defineAction({
      name: 'slow_validation',
      description: 'Pause at a real asynchronous input validator.',
      input: z.strictObject({}).refine(async () => {
        validating.resolve();
        await validate.promise;
        return true;
      }),
      execute: context => {
        handlerEntries++;
        return repository.complete(context);
      },
    });
    const closeView = openTaskView(session, repository, 'inbox', action);
    const pending = session.execute(invocationFor(session.observe(), 'inbox', 'a', 'close-during-validation'));
    await validating.promise;
    await closeView();
    validate.resolve();

    expect(await pending).toMatchObject({ status: 'rejected', code: 'BINDING_REVOKED' });
    expect(handlerEntries).toBe(0);
    expect(repository.writes).toBe(0);
    expect(repository.listenerCount).toBe(0);
  });

  it('rechecks TTL after asynchronous input validation', async () => {
    let now = 1000;
    const { session, repository } = fixture({ now: () => now, ttlMs: 10 });
    const validating = deferred();
    const validate = deferred();
    let handlerEntries = 0;
    const action = defineAction({
      name: 'expiring_validation',
      description: 'Pause validation until the observation has expired.',
      input: z.strictObject({}).refine(async () => {
        validating.resolve();
        await validate.promise;
        return true;
      }),
      execute: context => {
        handlerEntries++;
        return repository.complete(context);
      },
    });
    openTaskView(session, repository, 'inbox', action);
    const observation = session.observe();
    const pending = session.execute(invocationFor(observation, 'inbox', 'a', 'expire-during-validation'));
    await validating.promise;
    now = observation.expiresAt + 1;
    validate.resolve();

    expect(await pending).toMatchObject({ status: 'rejected', code: 'OBSERVATION_EXPIRED' });
    expect(handlerEntries).toBe(0);
    expect(repository.writes).toBe(0);
  });
});

describe('cooperative cancellation and scoped release', () => {
  it('returns unknown after cancelling an entered handler and releases its work', async () => {
    const { session, repository } = fixture();
    const started = deferred();
    const neverReleased = deferred();
    let activeHandlers = 0;
    let finalizedHandlers = 0;
    const action = defineAction({
      name: 'long_operation',
      description: 'Cooperatively wait for cancellation.',
      input: z.strictObject({}),
      execute: async context => {
        activeHandlers++;
        started.resolve();
        try {
          await waitForGate(neverReleased.promise, context.signal);
          return repository.complete(context);
        } finally {
          activeHandlers--;
          finalizedHandlers++;
        }
      },
    });
    openTaskView(session, repository, 'inbox', action);
    const controller = new AbortController();
    const pending = session.execute(
      invocationFor(session.observe(), 'inbox', 'a', 'cancel-running'),
      { signal: controller.signal },
    );
    await started.promise;
    expect(activeHandlers).toBe(1);
    controller.abort();

    expect(await pending).toMatchObject({ status: 'unknown', code: 'ABORTED' });
    expect(activeHandlers).toBe(0);
    expect(finalizedHandlers).toBe(1);
    expect(session.inspect().activeCalls).toBe(0);
    expect(repository.writes).toBe(0);

    await session.close();
    expect(repository.listenerCount).toBe(0);
    expect(session.inspect()).toMatchObject({ activeCalls: 0, views: 0 });
  });

  it('session.close cancels in-flight work, releases subscriptions, and prevents new calls', async () => {
    const { session, repository } = fixture();
    const started = deferred();
    const neverReleased = deferred();
    let finalized = false;
    const action = defineAction({
      name: 'session_owned_operation',
      description: 'The session owns this cooperative operation.',
      input: z.strictObject({}),
      execute: async context => {
        started.resolve();
        try {
          await waitForGate(neverReleased.promise, context.signal);
          return repository.complete(context);
        } finally {
          finalized = true;
        }
      },
    });
    openTaskView(session, repository, 'left', action);
    openTaskView(session, repository, 'right', action);
    const observation = session.observe();
    const pending = session.execute(invocationFor(observation, 'left', 'a', 'close-running'));
    await started.promise;
    expect(repository.listenerCount).toBe(2);

    await session.close();

    expect(await pending).toMatchObject({ status: 'unknown', code: 'ABORTED' });
    expect(finalized).toBe(true);
    expect(repository.listenerCount).toBe(0);
    expect(session.inspect()).toMatchObject({ activeCalls: 0, views: 0 });
    expect(repository.writes).toBe(0);
    expect(await session.execute(invocationFor(observation, 'right', 'b', 'after-session-close')))
      .toMatchObject({ status: 'rejected', code: 'SESSION_CLOSED' });
  });
});

describe('Standard Schema input boundary', () => {
  it('exports input JSON Schema while passing the validated transformed value to business code', async () => {
    const { session, repository } = fixture();
    let handlerEntries = 0;
    const action = defineAction({
      name: 'parse_quantity',
      description: 'Accept a textual quantity and provide a number to business code.',
      input: z.strictObject({ quantity: z.string().regex(/^\d+$/).transform(value => Number(value)) }),
      execute: (_context, input) => {
        handlerEntries++;
        return { status: 'succeeded', value: { doubled: input.quantity * 2, parsedType: typeof input.quantity } };
      },
    });
    expect(action.inputSchema).toMatchObject({
      type: 'object',
      properties: { quantity: { type: 'string' } },
    });
    openTaskView(session, repository, 'inbox', action);
    const observation = session.observe();
    const valid = await session.execute(invocationFor(observation, 'inbox', 'a', 'text-quantity', { quantity: '21' }));
    expect(valid).toEqual({ status: 'succeeded', value: { doubled: 42, parsedType: 'number' } });

    const invalid = await session.execute(invocationFor(observation, 'inbox', 'a', 'numeric-input', { quantity: 21 }));
    expect(invalid).toMatchObject({ status: 'rejected', code: 'INVALID_INPUT' });
    expect(handlerEntries).toBe(1);
  });

  it('fails registration when the declared input cannot be represented in JSON Schema', () => {
    expect(() => defineAction({
      name: 'unrepresentable_input',
      description: 'BigInt is deliberately not a JSON input value.',
      input: z.strictObject({ value: z.bigint() }),
      execute: () => ({ status: 'succeeded', value: null }),
    })).toThrow();
  });
});

describe('bounded receipts and asynchronous application cleanup', () => {
  it('refuses new invocation IDs at capacity while retaining the completed receipt for retries', async () => {
    const { session, repository } = fixture({ maxInvocations: 1 });
    openTaskView(session, repository, 'inbox');
    const observation = session.observe();
    const original = invocationFor(observation, 'inbox', 'a', 'retained-receipt');
    const completed = await session.execute(original);
    expect(completed.status).toBe('succeeded');

    const overflow = await session.execute(invocationFor(observation, 'inbox', 'b', 'new-id-at-capacity'));
    expect(overflow).toMatchObject({ status: 'rejected', code: 'INVOCATION_CAPACITY' });
    expect(await session.execute({ ...original })).toEqual(completed);
    expect(session.inspect().invocations).toBe(1);
    expectCompleted(repository, ['a']);
    expect(repository.writes).toBe(1);
  });

  it('can finish runtime cancellation before an arbitrary awaited application cleanup has completed', async () => {
    const { session, repository } = fixture();
    const started = deferred();
    const neverReleased = deferred();
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    const applicationFinished = deferred();
    const action = defineAction({
      name: 'operation_with_async_cleanup',
      description: 'Application cleanup can outlive the cancelled runtime call.',
      input: z.strictObject({}),
      execute: async context => {
        started.resolve();
        try {
          await waitForGate(neverReleased.promise, context.signal);
          return repository.complete(context);
        } finally {
          cleanupStarted.resolve();
          await cleanupGate.promise;
          applicationFinished.resolve();
        }
      },
    });
    openTaskView(session, repository, 'inbox', action);
    const controller = new AbortController();
    const pending = session.execute(
      invocationFor(session.observe(), 'inbox', 'a', 'cancel-with-async-cleanup'),
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();

    try {
      expect(await pending).toMatchObject({ status: 'unknown', code: 'ABORTED' });
      expect(session.inspect().activeCalls).toBe(0);
      await cleanupStarted.promise;
      // The gate is still closed: runtime release does not forcibly finish a JS Promise.
      // In particular, activeCalls === 0 is not evidence that application cleanup is done.
    } finally {
      cleanupGate.resolve();
      await applicationFinished.promise;
    }
    expect(repository.writes).toBe(0);
    await session.close();
    expect(repository.listenerCount).toBe(0);
  });
});
