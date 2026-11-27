import { afterEach, expect, it, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import { LLMClient } from '../../src/core/llm-client.js';
import type { AgentDriverV2Config, ContextDrivenSource, DrivenSourceContext, ToolResult } from '../../src/core/interfaces.js';

const retryDelay = 1370;
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function response(callId?: string, content = 'Done', reasoning?: string) {
    const chunk = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({
        id: 'response', model: 'controlled', created: 1, choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n';
    return new Response((reasoning ? chunk({ reasoning_content: reasoning }, null) : '') + chunk({ content }, null) + (callId ? chunk({ tool_calls: [{
        index: 0, id: callId, type: 'function', function: { name: 'apply', arguments: '{}' },
    }] }, null) : '') + chunk({}, callId ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
const failed = (status: number) => new Response(JSON.stringify({ error: { message: 'controlled failure', type: 'server_error' } }),
    { status, headers: { 'content-type': 'application/json', 'retry-after-ms': String(retryDelay) } });

function retryClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entered = deferred();
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
        const timer = schedule(fn, ms, ...args);
        if (ms === retryDelay) entered.resolve();
        return timer;
    }) as typeof setTimeout);
    return entered.promise;
}

const drivers: AgentDriverV2[] = [];
afterEach(async () => {
    for (const driver of drivers.splice(0)) { driver.stop(); driver.dispose(); }
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function fixture(transport: typeof fetch, options: Partial<AgentDriverV2Config> = {}, budget = false) {
    const events: string[] = [];
    const returned: ToolResult[] = [];
    let notify!: () => void;
    const getContext = vi.fn(async (): Promise<DrivenSourceContext> => {
        const capture = getContext.mock.calls.length;
        events.push('capture:' + capture);
        return {
            messages: [{ role: 'user', content: 'same input', timestamp: 1 }],
            tools: { apply: { inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }) } },
            adopt() { events.push('adopt:' + capture); },
            release() { events.push('release:' + capture); },
            async executeTool(toolName, _input, toolCallId) {
                events.push('execute:' + toolCallId);
                const result: ToolResult = { toolName, toolCallId, result: { done: true } };
                returned.push(result);
                return result;
            },
        };
    });
    const source: ContextDrivenSource = {
        name: 'lifecycle', getContext,
        onUpdate(callback) { notify = callback; return () => {}; },
    };
    const fetch = vi.fn(transport);
    vi.stubGlobal('fetch', fetch);
    const onAssistantMessage = vi.fn(), onToolResult = vi.fn(), onRunError = vi.fn(), onTextDelta = vi.fn(), onReasoningDelta = vi.fn();
    const driver = new AgentDriverV2({
        sources: [source], llm: { model: 'controlled', apiKey: 'test-no-network',
            provider: { id: 'controlled', baseURL: 'https://lifecycle.invalid/v1' },
            ...(budget ? { inputBudget: () => ({ contextWindow: 100000, maxOutputTokens: 1024 }) } : {}) },
        workLoop: { debounceMs: 0 }, onAssistantMessage, onToolResult, onRunError, onTextDelta, onReasoningDelta, ...options,
    });
    drivers.push(driver);
    return { driver, fetch, events, returned, getContext, update: () => notify(), onAssistantMessage, onToolResult,
        onRunError, onTextDelta, onReasoningDelta };
}

it.each([false, true])('C-T01 retries the real SDK transport with one adoption (budget=%s)', async budget => {
    const backoff = retryClock();
    let sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(503) : response('retry-call'), {}, budget);
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await backoff;
    expect(f.events).toEqual(['capture:1', 'adopt:1']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(retryDelay);
    await work;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[0]![1]?.body).toBe(f.fetch.mock.calls[1]![1]?.body);
    expect(f.events).toEqual(['capture:1', 'adopt:1', 'execute:retry-call', 'release:1']);
    expect(f.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(f.onToolResult).toHaveBeenCalledTimes(1);
    expect(f.onToolResult.mock.calls[0]![1][0]).toBe(f.returned[0]);
    expect(f.onRunError).not.toHaveBeenCalled();
});

it.each(['stop', 'dispose', 'close'] as const)('C-T02 cancels an actual scheduled transport retry with %s', async action => {
    const backoff = retryClock();
    let sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(503) : response('late-call'));
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await backoff;
    expect(f.events).toEqual(['capture:1','adopt:1']);
    if (action === 'stop') f.driver.stop();
    else if (action === 'dispose') f.driver.dispose();
    else await f.driver.closeToolTurn();
    await vi.advanceTimersByTimeAsync(retryDelay * 5);
    await work;
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1']);
    expect(f.onAssistantMessage).not.toHaveBeenCalled();
    expect(f.onTextDelta).not.toHaveBeenCalled();
    expect(f.onReasoningDelta).not.toHaveBeenCalled();
    expect(f.onToolResult).not.toHaveBeenCalled();
    expect(f.onRunError).not.toHaveBeenCalled();
});

it('C-T04 retains a busy explicit trigger through failure with the same input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] });
    const entered = deferred(), finish = deferred();
    let sends = 0;
    const f = fixture(async () => {
        if (++sends === 1) { entered.resolve(); await finish.promise; return failed(400); }
        return response();
    });
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await entered.promise;
    await f.driver.trigger();
    await f.driver.trigger();
    f.update(); f.update();
    await vi.advanceTimersByTimeAsync(0);
    finish.resolve();
    await work;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','release:2']);
    expect(f.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(f.onRunError).toHaveBeenCalledTimes(1);
});

it.each([false, true])('C-T02 stop/start gives a fresh request, not the scheduled retry (budget=%s)', async budget => {
    const backoff = retryClock();
    let sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(503) : response('new-call'), {}, budget);
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await backoff;
    const originalSignal = f.fetch.mock.calls[0]![1]?.signal;
    expect(originalSignal?.aborted).toBe(false);
    f.driver.stop();
    f.driver.start();
    await f.driver.trigger();
    expect(originalSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(retryDelay * 5);
    await work;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[1]![1]?.signal).not.toBe(originalSignal);
    expect(f.fetch.mock.calls[1]![1]?.signal?.aborted).toBe(false);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','execute:new-call','release:2']);
    expect(f.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(f.onTextDelta.mock.calls).toEqual([['Done']]);
    expect(f.onToolResult).toHaveBeenCalledTimes(1);
    expect(f.onRunError).not.toHaveBeenCalled();
});

it('C-T02 ignores a late complete response when the actual transport ignores abort', async () => {
    const sent = deferred(), finish = deferred();
    let sends = 0;
    const f = fixture(async () => {
        if (++sends === 1) { sent.resolve(); await finish.promise; return response('old-call', 'Old content', 'Old reasoning'); }
        return response('new-call');
    });
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await sent.promise;
    f.driver.stop();
    f.driver.start();
    await f.driver.trigger();
    expect(f.fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(f.onAssistantMessage).not.toHaveBeenCalled();
    finish.resolve();
    await work;
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','execute:new-call','release:2']);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(f.onTextDelta.mock.calls).toEqual([['Done']]);
    expect(f.onReasoningDelta).not.toHaveBeenCalled();
    expect(f.onToolResult).toHaveBeenCalledTimes(1);
    expect(f.onRunError).not.toHaveBeenCalled();
});

it('C-T02 retires old delayed wakes and dispose does not permit restart', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f = fixture(async () => response());
    f.update();
    f.driver.stop();
    f.update();
    f.driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getContext).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.driver.dispose();
    f.driver.start();
    await f.driver.trigger();
    f.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.getContext).toHaveBeenCalledTimes(1);
    expect(f.driver.getState()).toBe('idle');
    expect(f.driver.hasPendingUpdate()).toBe(false);
});

it.each(['capture','adopt'] as const)('C-T03 joins late %s and does not start later adoptions or sends', async phase => {
    const entered = deferred(), finish = deferred();
    const events: string[] = [];
    const contexts = ['first','second','third'].map(name => {
        const context: DrivenSourceContext = {
            messages:[{role:'user',content:name,timestamp:1}], tools:{},
            adopt: vi.fn(async () => {
                events.push('adopt:' + name);
                if (phase === 'adopt' && name === 'second') { entered.resolve(); await finish.promise; events.push('adopt-finished:second'); }
            }),
            release: vi.fn(() => { events.push('release:' + name); }),
        };
        return { name, context, onUpdate: () => () => {}, getContext: vi.fn(async () => {
            events.push('capture:' + name);
            if (phase === 'capture' && name === 'second') { entered.resolve(); await finish.promise; }
            return context;
        }) };
    });
    const f = fixture(async () => response(), {sources:contexts}, phase === 'adopt');
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await entered.promise;
    f.driver.stop();
    f.driver.start();
    expect(contexts.every(source => vi.mocked(source.context.release!).mock.calls.length === 0)).toBe(true);
    finish.resolve();
    await work;
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.onAssistantMessage).not.toHaveBeenCalled();
    expect(f.onRunError).not.toHaveBeenCalled();
    expect(events).toEqual(phase === 'capture'
        ? ['capture:first','capture:second','release:second','release:first']
        : ['capture:first','capture:second','capture:third','adopt:first','adopt:second','adopt-finished:second',
            'release:third','release:second','release:first']);
    expect(f.driver.getState()).toBe('idle');
});

it('C-T03 preserves the original asynchronous adoption error and releases partially adopted Sources', async () => {
    const issue = Object.assign(new Error('original adoption issue'), {code:'SEMANTIC_ADOPTION_FAILED'});
    const events: string[] = [];
    const sources = ['first','failed','last'].map(name => ({
        name, onUpdate: () => () => {}, getContext: vi.fn(async (): Promise<DrivenSourceContext> => ({
            messages: [{role:'user',content:name,timestamp:1}], tools:{},
            adopt: async () => { events.push('adopt:' + name); if (name === 'failed') throw issue; },
            release: () => { events.push('release:' + name); },
        })),
    }));
    const f = fixture(async () => response(), {sources});
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.onRunError).toHaveBeenCalledExactlyOnceWith(issue);
    expect(events).toEqual(['adopt:first','adopt:failed','release:last','release:failed','release:first']);
});

it('C-T04 ordinary same-input updates do not cause an automatic failed-request retry', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const sent = deferred(), finish = deferred();
    const f = fixture(async () => { sent.resolve(); await finish.promise; return failed(400); });
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await sent.promise;
    f.update(); f.update();
    await vi.advanceTimersByTimeAsync(0);
    finish.resolve();
    await work;
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','release:2']);
    expect(f.onRunError).toHaveBeenCalledTimes(1);
    expect(f.driver.hasPendingUpdate()).toBe(false);
});

it.each(['throw','reject'] as const)('C-T05 a reentrant error notification may %s without losing the next explicit intent', async mode => {
    let driver!: AgentDriverV2;
    const observerIssue = new Error('observer failure');
    const onRunError = vi.fn(() => {
        void driver.trigger();
        void driver.trigger();
        if (mode === 'throw') throw observerIssue;
        return Promise.reject(observerIssue);
    });
    let sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(400) : response(), {onRunError});
    driver = f.driver;
    await driver.trigger();
    await driver['runInFlight'];
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','release:2']);
    expect(f.onAssistantMessage).toHaveBeenCalledTimes(1);
    expect(driver.getState()).toBe('idle');
    expect(driver.hasPendingUpdate()).toBe(false);
});

it.each([false,true])('C-T05 joins a held throwing release and retains exactly one explicit wake (wake=%s)', async wake => {
    const releasing = deferred(), finish = deferred();
    let sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(400) : response());
    const capture = f.getContext.getMockImplementation()!;
    f.getContext.mockImplementationOnce(async () => {
        const context = await capture();
        return { ...context, release: async () => {
            f.events.push('release-enter:1');
            releasing.resolve();
            await finish.promise;
            await context.release?.();
            throw new Error('release failure');
        } };
    });
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await releasing.promise;
    if (wake) {
        await f.driver.trigger(); await f.driver.trigger();
        expect(f.driver.hasPendingUpdate()).toBe(true);
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['capture:1','adopt:1','release-enter:1']);
    finish.resolve();
    await work;
    expect(f.onRunError).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(wake ? 2 : 1);
    expect(f.events).toEqual(['capture:1','adopt:1','release-enter:1','release:1',
        ...(wake ? ['capture:2','adopt:2','release:2'] : [])]);
    expect(f.driver.hasPendingUpdate()).toBe(false);
    if (!wake) {
        await f.driver.trigger();
        await f.driver['runInFlight'];
        expect(f.fetch).toHaveBeenCalledTimes(2);
        expect(f.onRunError).toHaveBeenCalledTimes(1);
    }
});

it('C-T05 a state callback can synchronously trigger without starting a second owner', async () => {
    let driver!: AgentDriverV2;
    let thinking = 0, sends = 0;
    const f = fixture(async () => ++sends === 1 ? failed(400) : response(), {
        onStateChange: (_old, next) => {
            if (next === 'thinking' && ++thinking === 1) {
                void driver.trigger();
                throw new Error('state observer failed');
            }
        },
    });
    driver = f.driver;
    await driver.trigger();
    await driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','release:2']);
    expect(f.onRunError).toHaveBeenCalledTimes(1);
    expect(driver.getState()).toBe('idle');
});

it('C-T06 preserves a busy explicit retry and ordinary updates across pause/resume', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    let driver!: AgentDriverV2, sends = 0;
    const entered = deferred(), finish = deferred();
    const onRunError = vi.fn(() => driver.pause());
    const f = fixture(async () => {
        if (++sends === 1) { entered.resolve(); await finish.promise; return failed(400); }
        return response();
    }, {onRunError});
    driver = f.driver;
    await driver.trigger();
    const work = driver['runInFlight']!;
    await entered.promise;
    await driver.trigger();
    f.update(); f.update();
    await vi.advanceTimersByTimeAsync(0);
    finish.resolve();
    await work;
    expect(driver.isPaused()).toBe(true);
    expect(driver.hasPendingUpdate()).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1']);
    driver.resume();
    await driver['runInFlight'];
    driver.resume();
    await driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','release:2']);
    expect(driver.hasPendingUpdate()).toBe(false);
    expect(onRunError).toHaveBeenCalledTimes(1);
});

it('C-T08 a failed Tool save rejects the original close and a fresh explicit request never replays its call ID', async () => {
    let sends = 0;
    const saving = deferred(), finish = deferred();
    const issue = new Error('original save failed');
    const onToolResult = vi.fn(async (_message, _results) => {
        if (onToolResult.mock.calls.length === 1) { saving.resolve(); await finish.promise; throw issue; }
    });
    const f = fixture(async () => response(++sends === 1 ? 'original-call' : 'new-call'), {onToolResult});
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await saving.promise;
    expect(f.events).toEqual(['capture:1','adopt:1','execute:original-call']);
    let closed = false;
    const closing = f.driver.closeToolTurn().then(() => { closed = true; return undefined; }, error => { closed = true; return error; });
    f.driver.start();
    await f.driver.trigger();
    expect(closed).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    finish.resolve();
    expect(await closing).toBe(issue);
    await work;
    expect(f.events).toEqual(['capture:1','adopt:1','execute:original-call','release:1',
        'capture:2','adopt:2','execute:new-call','release:2']);
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult.mock.calls[0]![1][0]).toBe(f.returned[0]);
    expect(onToolResult.mock.calls[1]![1][0]).toBe(f.returned[1]);
    expect(f.onRunError).toHaveBeenCalledExactlyOnceWith(issue);
    expect(f.driver.hasPendingUpdate()).toBe(false);
});

it('C-T08 an entered throwing executor remains unknown and only a fresh explicit trigger sends new work', async () => {
    let sends = 0, entered = 0;
    const f = fixture(async () => response(++sends === 1 ? 'unknown-call' : 'new-call'));
    const capture = f.getContext.getMockImplementation()!;
    f.getContext.mockImplementationOnce(async () => ({
        ...await capture(), executeTool: async () => { entered++; throw new Error('effect occurred, reply lost'); },
    }));
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(entered).toBe(1);
    expect(f.onToolResult.mock.calls[0]![1][0]).toMatchObject({toolCallId:'unknown-call',outcomeStatus:'unknown',
        error:{code:'E_EXECUTION_ERROR'}});
    expect(f.driver.hasPendingUpdate()).toBe(false);
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(entered).toBe(1);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','execute:new-call','release:2']);
    expect(f.onToolResult.mock.calls[1]![1][0]).toBe(f.returned[0]);
});

it.each([false, true])('C-T02 checks the last fetch boundary even if the Provider discards its signal (budget=%s)', async budget => {
    const entered = deferred(), proceed = deferred(), exited = deferred();
    const createProvider = LLMClient.prototype['createProvider'];
    let attempted = 0;
    const seam = vi.spyOn(LLMClient.prototype as any, 'createProvider').mockImplementation(function (
        this: LLMClient, chatFetch?: typeof fetch, httpFetch?: typeof fetch,
    ) {
        // Keep the actual adapter and encoder. Delay only its entry, then deliberately
        // drop the SDK signal before invoking the real adapter's doStream.
        const provider = createProvider.call(this, chatFetch, httpFetch);
        const doStream = provider.doStream.bind(provider);
        vi.spyOn(provider, 'doStream').mockImplementation(async params => {
            entered.resolve();
            await proceed.promise;
            try {
                attempted++;
                return await doStream({ ...params, abortSignal: undefined });
            } finally { exited.resolve(); }
        });
        return provider;
    });
    const f = fixture(async () => response('forbidden-call'), {}, budget);
    await f.driver.trigger();
    const work = f.driver['runInFlight']!;
    await entered.promise;
    try {
        f.driver.stop();
        f.driver.start();
        proceed.resolve();
        await exited.promise;
        await work;
        expect(attempted).toBe(1);
        expect(seam).toHaveBeenCalledTimes(1);
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.events).toEqual(['capture:1', 'release:1']);
        expect(f.onAssistantMessage).not.toHaveBeenCalled();
        expect(f.onToolResult).not.toHaveBeenCalled();
        expect(f.onRunError).not.toHaveBeenCalled();
    } finally { proceed.resolve(); }
});

it('C-T02 preserves initial Source notification while canceling subsequent stale wakes', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const getContext = vi.fn(async (): Promise<DrivenSourceContext> => ({
        messages: [{role:'user', content:'initial context', timestamp:1}], tools:{},
    }));
    let notify!: () => void;
    const source: ContextDrivenSource = {
        name:'initial', getContext,
        onUpdate(callback) { notify = callback; callback(); return () => {}; },
    };
    const f = fixture(async () => response(), {sources:[source]});
    await vi.advanceTimersByTimeAsync(0);
    await f.driver['runInFlight'];
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    notify();
    f.driver.stop();
    f.driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('C-T05 returns the run owner when error notification throws without a queued intent', async () => {
    let sends = 0;
    const onRunError = vi.fn(() => { throw new Error('observer threw'); });
    const f = fixture(async () => ++sends === 1 ? failed(400) : response(), {onRunError});
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.events).toEqual(['capture:1','adopt:1','release:1']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(f.driver.getState()).toBe('idle');
    expect(f.driver.hasPendingUpdate()).toBe(false);
    await f.driver.trigger();
    await f.driver['runInFlight'];
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['capture:1','adopt:1','release:1','capture:2','adopt:2','release:2']);
    expect(onRunError).toHaveBeenCalledTimes(1);
});
