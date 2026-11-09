import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2'
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js'
import { IMDrivenSource } from '../../src/im/im-driven-source.js'

afterEach(() => vi.restoreAllMocks())

describe('IMDrivenSource', () => {
  it('exposes stable source name', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })
    expect(source.name).toBe('IM')
    const tools = await source.getContext().then(context => context.tools)
    expect(tools).toHaveProperty('context_compact')
    expect((tools as any).context_compact.description).toContain('## Goal')
    expect((tools as any).context_compact.description).toContain('protocol continuity')
    expect((tools as any).context_compact.description).toContain('## Relevant files / systems')
  })

  it('returns empty messages by default', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })
    expect(await source.getContext().then(context => context.messages)).toEqual([])
  })

  it('loads history once from loader', async () => {
    const loadHistory = vi.fn().mockResolvedValue([
      { role: 'user', content: 'old', timestamp: 1_000 },
    ])

    const source = new IMDrivenSource({ sessionKey: 's1', loadHistory })
    const first = await source.getContext().then(context => context.messages)
    const second = await source.getContext().then(context => context.messages)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]).toMatchObject({
      role: 'user',
      content: 'old',
      timestamp: 1_000,
      region: 'session',
    })
    expect(loadHistory).toHaveBeenCalledTimes(1)
  })

  it('deduplicates persisted history against messages appended before first load', async () => {
    const loadHistory = vi.fn().mockResolvedValue([
      { role: 'user', content: 'hello', timestamp: 2_000 },
    ])
    const source = new IMDrivenSource({
      sessionKey: 's1',
      now: () => 2_000,
      loadHistory,
    })

    source.addMessage({ role: 'user', content: 'hello' })

    await expect(source.getContext().then(context => context.messages)).resolves.toEqual([
      { role: 'user', content: 'hello', timestamp: 2_000, region: 'session' },
    ])
  })

  it('adds message with generated timestamp', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1', now: () => 2_000 })

    const input: ModelMessage = { role: 'user', content: 'hello' }
    source.addMessage(input)

    expect(await source.getContext().then(context => context.messages)).toEqual([
      { role: 'user', content: 'hello', timestamp: 2_000, region: 'session' },
    ])
  })

  it('adds message with explicit timestamp override', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1', now: () => 2_000 })

    source.addMessage({ role: 'assistant', content: 'ok' }, 1_234)

    expect(await source.getContext().then(context => context.messages)).toEqual([
      { role: 'assistant', content: 'ok', timestamp: 1_234, region: 'session' },
    ])
  })

  it('executeTool returns undefined for unknown tools', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })
    await expect(source.getContext().then(context => context.executeTool!('unknown', {}, 'tc1'))).resolves.toBeUndefined()
  })

  it('context_compact requires a non-empty summary', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })

    await expect(source.getContext().then(context => context.executeTool!('context_compact', {}, 'tc1'))).resolves.toEqual({
      toolCallId: 'tc1',
      toolName: 'context_compact',
      result: expect.objectContaining({
        success: false,
        note: expect.stringContaining('non-empty summary'),
      }),
    })
  })

  it('context_compact rewrites IM history and persists replacement', async () => {
    const replaceHistory = vi.fn(async () => undefined)
    const source = new IMDrivenSource({
      sessionKey: 's1',
      replaceHistory,
      now: () => 9_999,
      loadHistory: async () => [
        { role: 'user', content: 'u1', timestamp: 1_000 },
        { role: 'assistant', content: 'a1', timestamp: 1_100 },
        { role: 'user', content: 'u2', timestamp: 1_200 },
        { role: 'assistant', content: 'a2', timestamp: 1_300 },
      ],
    })

    const result = await source.getContext().then(context => context.executeTool!('context_compact', {
      summary: 'Summarized prior IM work.',
      minMessages: 1,
      keepRecentMessages: 2,
    }, 'tc2'))

    expect(result).toEqual({
      toolCallId: 'tc2',
      toolName: 'context_compact',
      result: expect.objectContaining({
        success: true,
        summary: 'Summarized prior IM work.',
        compactedMessageCount: 2,
        cleanedToolResultCount: 0,
      }),
    })

    await expect(source.getContext().then(context => context.messages)).resolves.toEqual([
      {
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'tool-call',
            toolName: 'context_compact',
            input: expect.objectContaining({
              trigger: 'agent',
            }),
          }),
        ],
        timestamp: 1_198,
        region: 'session',
      },
      {
        role: 'tool',
        content: [
          expect.objectContaining({
            type: 'tool-result',
            toolName: 'context_compact',
            result: expect.objectContaining({
              success: true,
              trigger: 'agent',
              summary: 'Summarized prior IM work.',
              compactedMessageCount: 4,
              cleanedToolResultCount: 0,
            }),
          }),
        ],
        timestamp: 1_199,
        region: 'session',
      },
      { role: 'user', content: 'u2', timestamp: 1_200, region: 'session' },
      { role: 'assistant', content: 'a2', timestamp: 1_300, region: 'session' },
    ])

    expect(replaceHistory).toHaveBeenCalledWith('s1', [
      expect.objectContaining({
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'tool-call',
            toolName: 'context_compact',
          }),
        ],
        timestamp: 1_198,
        region: 'session',
      }),
      expect.objectContaining({
        role: 'tool',
        content: [
          expect.objectContaining({
            type: 'tool-result',
            toolName: 'context_compact',
          }),
        ],
        timestamp: 1_199,
        region: 'session',
      }),
      { role: 'user', content: 'u2', timestamp: 1_200 },
      { role: 'assistant', content: 'a2', timestamp: 1_300 },
    ])
  })

  it('context_compact skips when threshold is not met unless forced', async () => {
    const replaceHistory = vi.fn(async () => undefined)
    const source = new IMDrivenSource({
      sessionKey: 's1',
      replaceHistory,
      loadHistory: async () => [
        { role: 'user', content: 'only one', timestamp: 1_000 },
      ],
    })

    const result = await source.getContext().then(context => context.executeTool!('context_compact', {
      summary: 'Keep going.',
      minMessages: 2,
    }, 'tc3'))

    expect(result).toEqual({
      toolCallId: 'tc3',
      toolName: 'context_compact',
      result: expect.objectContaining({
        success: false,
        note: expect.stringContaining('did not meet minMessages threshold'),
      }),
    })
    expect(replaceHistory).not.toHaveBeenCalled()
  })

  it('keeps tool-call and tool-result together when preserving recent execution state', async () => {
    const source = new IMDrivenSource({
      sessionKey: 's1',
      // @ts-expect-error Historical IM fixtures intentionally use tool-result.result; preserve that stored payload.
      loadHistory: async () => [
        { role: 'user', content: 'before tool', timestamp: 1_000 },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'search_files', input: { query: 'foo' } },
          ],
          timestamp: 1_100,
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'call_1', toolName: 'search_files', result: { hits: 2 } },
          ],
          timestamp: 1_200,
        },
        { role: 'assistant', content: 'tool done', timestamp: 1_300 },
      ],
    })

    await source.getContext().then(context => context.executeTool!('context_compact', {
      summary: '## Goal\nContinue after file search.',
      minMessages: 1,
      keepRecentMessages: 2,
    }, 'tc4'))

    const messages = await source.getContext().then(context => context.messages)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool' }),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'search_files', input: { query: 'foo' } },
        ],
        timestamp: 1_100,
        region: 'session',
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'search_files', result: { hits: 2 } },
        ],
        timestamp: 1_200,
        region: 'session',
      },
      { role: 'assistant', content: 'tool done', timestamp: 1_300, region: 'session' },
    ])
  })

  it('returns only the latest active window after a historical compaction anchor', async () => {
    const source = new IMDrivenSource({
      sessionKey: 's1',
      // @ts-expect-error Historical IM fixtures intentionally use tool-result.result; preserve that stored payload.
      loadHistory: async () => [
        { role: 'user', content: 'old user', timestamp: 900 },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'compact_old', toolName: 'context_compact', input: { trigger: 'agent' } },
          ],
          timestamp: 998,
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'compact_old', toolName: 'context_compact', result: { success: true, summary: 'old summary' } },
          ],
          timestamp: 999,
        },
        { role: 'user', content: 'new user', timestamp: 1_000 },
      ],
    })

    await expect(source.getContext().then(context => context.messages)).resolves.toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'compact_old', toolName: 'context_compact', input: { trigger: 'agent' } },
        ],
        timestamp: 998,
        region: 'session',
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'compact_old', toolName: 'context_compact', result: { success: true, summary: 'old summary' } },
        ],
        timestamp: 999,
        region: 'session',
      },
      { role: 'user', content: 'new user', timestamp: 1_000, region: 'session' },
    ])
  })

  it('notifyUpdate triggers subscriptions and unsubscribe works', () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })
    const callback = vi.fn()

    const unsubscribe = source.onUpdate(callback)

    source.notifyUpdate()
    expect(callback).toHaveBeenCalledTimes(1)

    unsubscribe()
    source.notifyUpdate()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('persists appended messages through callback', () => {
    const persistMessage = vi.fn()
    const source = new IMDrivenSource({ sessionKey: 's1', now: () => 9_999, persistMessage })

    source.addMessage({ role: 'user', content: 'persist-me' })

    expect(persistMessage).toHaveBeenCalledWith('s1', {
      role: 'user',
      content: 'persist-me',
      timestamp: 9_999,
      region: 'session',
    })
  })

  it('exposes compaction tool name and skips threshold compaction when disabled', async () => {
    const source = new IMDrivenSource({ sessionKey: 's1' })

    expect(source.getCompactionToolName()).toBe('context_compact')
    await expect(source.maybeCompactByThreshold({
      enabled: false,
      maxContextTokens: 100,
    })).resolves.toEqual({
      compacted: false,
      syntheticMessages: [],
      summary: '',
      compactedMessageCount: 0,
      cleanedToolResultCount: 0,
      currentTokens: 0,
      thresholdTokens: 100,
    })
  })

  it('runs hard fallback compaction and emits synthetic anchor messages', async () => {
    const replaceHistory = vi.fn(async () => undefined)
    const source = new IMDrivenSource({
      sessionKey: 's1',
      replaceHistory,
      loadHistory: async () => [
        { role: 'user', content: 'need help', timestamp: 1_000 },
        { role: 'assistant', content: 'working', timestamp: 1_100 },
        { role: 'user', content: 'more context', timestamp: 1_200 },
        { role: 'assistant', content: 'more work', timestamp: 1_300 },
      ],
    })

    const result = await source.runHardFallbackCompaction('threshold reached', {
      minMessages: 1,
      keepRecentMessages: 2,
    })

    expect(result).toEqual({
      compacted: true,
      syntheticMessages: [
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'tool' }),
      ],
      summary: expect.stringContaining('## Goal'),
      compactedMessageCount: 2,
      cleanedToolResultCount: 0,
    })
    expect(replaceHistory).toHaveBeenCalledTimes(1)
    await expect(source.getContext().then(context => context.messages)).resolves.toEqual([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool' }),
      { role: 'user', content: 'more context', timestamp: 1_200, region: 'session' },
      { role: 'assistant', content: 'more work', timestamp: 1_300, region: 'session' },
    ])
  })

  it('threshold compaction triggers when estimated tokens exceed the configured limit', async () => {
    const source = new IMDrivenSource({
      sessionKey: 's1',
      loadHistory: async () => [
        { role: 'user', content: 'x'.repeat(600), timestamp: 1_000 },
        { role: 'assistant', content: 'y'.repeat(600), timestamp: 1_100 },
        { role: 'user', content: 'z'.repeat(600), timestamp: 1_200 },
      ],
    })

    const result = await source.maybeCompactByThreshold({
      enabled: true,
      maxContextTokens: 50,
      minMessages: 1,
      keepRecentMessages: 1,
      modelHint: 'openai:gpt-4o',
    })

    expect(result.compacted).toBe(true)
    expect(result.currentTokens).toBeGreaterThan(50)
    expect(result.syntheticMessages).toHaveLength(2)
    await expect(source.getContext().then(context => context.messages)).resolves.toEqual([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool' }),
      { role: 'user', content: 'z'.repeat(600), timestamp: 1_200, region: 'session' },
    ])
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function observe<T>(promise: Promise<T>) {
  let settled = false
  const done = promise.then(
    value => { settled = true; return { status: 'fulfilled' as const, value } },
    reason => { settled = true; return { status: 'rejected' as const, reason } },
  )
  return { done, get settled() { return settled } }
}

describe('IMDrivenSource history initialization', () => {
  it('shares pending history and preserves messages appended while loading', async () => {
    const gate = deferred<MessageWithTimestamp[]>()
    const entered = deferred<void>()
    const history: MessageWithTimestamp[] = [
      { role: 'user', content: 'duplicate', timestamp: 2_000 },
      { role: 'assistant', content: 'restored', timestamp: 1_000 },
    ]
    const loadHistory = vi.fn(() => { entered.resolve(); return gate.promise })
    const persistMessage = vi.fn()
    const updates = vi.fn()
    const source = new IMDrivenSource({ sessionKey: 'pending', now: () => 3_000, loadHistory, persistMessage })
    const unsubscribe = source.onUpdate(updates)
    const reads = [observe(source.getContext().then(context => context.messages))]
    try {
      await entered.promise
      const duplicate = source.addMessage({ role: 'user', content: 'duplicate' }, 2_000)
      const appended = source.addMessage({ role: 'user', content: 'new while loading' })
      reads.push(observe(source.getContext().then(context => context.messages)))
      await nextTurn()

      expect(loadHistory).toHaveBeenCalledExactlyOnceWith('pending')
      expect(reads[0].settled).toBe(false)
      expect(reads[1].settled).toBe(false)
      expect(duplicate).toStrictEqual({ role: 'user', content: 'duplicate', timestamp: 2_000, region: 'session' })
      expect(appended).toStrictEqual({ role: 'user', content: 'new while loading', timestamp: 3_000, region: 'session' })
      expect(persistMessage.mock.calls).toStrictEqual([['pending', duplicate], ['pending', appended]])
      expect(updates).not.toHaveBeenCalled()

      gate.resolve(history)
      const expected = [
        { ...history[1], region: 'session' },
        { ...history[0], region: 'session' },
        appended,
      ]
      for (const result of await Promise.all(reads.map(read => read.done))) {
        expect(result).toStrictEqual({ status: 'fulfilled', value: expected })
      }
      await expect(source.getContext().then(context => context.messages)).resolves.toStrictEqual(expected)
      expect(loadHistory).toHaveBeenCalledTimes(1)
      expect(persistMessage).toHaveBeenCalledTimes(2)
      expect(updates).not.toHaveBeenCalled()
    } finally {
      gate.resolve(history)
      await Promise.all(reads.map(read => read.done))
      unsubscribe()
    }
  })

  it('degrades every failed capture, diagnoses the original error and shares the next explicit retry', async () => {
    const firstGate = deferred<MessageWithTimestamp[]>(), retryGate = deferred<MessageWithTimestamp[]>()
    const entered = deferred<void>(), failure = new Error('history unavailable')
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const history: MessageWithTimestamp[] = [{ role: 'user', content: 'recovered', timestamp: 1_000 }]
    let attempts = 0
    const loadHistory = vi.fn(() => { entered.resolve(); return ++attempts === 1 ? firstGate.promise : retryGate.promise })
    const source = new IMDrivenSource({ sessionKey: 'retry', loadHistory })
    const reads = [observe(source.getContext())]
    try {
      await entered.promise
      reads.push(observe(source.getContext()))
      firstGate.reject(failure)
      for (const result of await Promise.all(reads.map(read => read.done))) {
        expect(result).toStrictEqual({ status: 'fulfilled', value: { messages: [], tools: {} } })
      }
      expect(diagnostic).toHaveBeenCalledTimes(2)
      expect(diagnostic).toHaveBeenCalledWith('Failed to capture context from IM:', failure)
      await nextTurn()
      expect(loadHistory).toHaveBeenCalledTimes(1)
      const retries = [observe(source.getContext()), observe(source.getContext())]
      reads.push(...retries)
      await nextTurn()
      expect(loadHistory).toHaveBeenCalledTimes(2)
      expect(retries.map(read => read.settled)).toEqual([false, false])
      retryGate.resolve(history)
      const expected = [{ ...history[0], region: 'session' }]
      for (const result of await Promise.all(retries.map(read => read.done))) {
        expect(result.status).toBe('fulfilled')
        if (result.status === 'fulfilled') {
          expect(result.value.messages).toStrictEqual(expected)
          expect(result.value.tools).toHaveProperty('context_compact')
          expect(typeof result.value.executeTool).toBe('function')
        }
      }
      await expect(source.getContext().then(context => context.messages)).resolves.toStrictEqual(expected)
      expect(loadHistory).toHaveBeenCalledTimes(2)
    } finally {
      firstGate.resolve(history); retryGate.resolve(history)
      await Promise.all(reads.map(read => read.done))
    }
  })

  it('diagnoses a synchronous loader throw and retries only on the next capture', async () => {
    const failure = new Error('synchronous history failure')
    const history: MessageWithTimestamp[] = [{ role: 'user', content: 'after sync failure', timestamp: 1_000 }]
    let attempts = 0
    const loadHistory = vi.fn(() => {
      attempts += 1
      if (attempts === 1) throw failure
      return Promise.resolve(history)
    })
    const source = new IMDrivenSource({ sessionKey: 'sync', loadHistory })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(source.getContext()).resolves.toStrictEqual({ messages: [], tools: {} })
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Failed to capture context from IM:', failure)
    await nextTurn()
    expect(loadHistory).toHaveBeenCalledTimes(1)
    await expect(source.getContext().then(context => context.messages)).resolves.toStrictEqual([{ ...history[0], region: 'session' }])
    await source.getContext().then(context => context.messages)
    expect(loadHistory).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed history merge as initialized', async () => {
    const failure = new Error('history content unavailable')
    const broken: MessageWithTimestamp = {
      role: 'user', timestamp: 1_000,
      get content(): string { throw failure },
    }
    const history: MessageWithTimestamp[] = [{ role: 'user', content: 'usable history', timestamp: 1_000 }]
    let attempts = 0
    const loadHistory = vi.fn(() => Promise.resolve(++attempts === 1 ? [broken] : history))
    const source = new IMDrivenSource({ sessionKey: 'merge', loadHistory })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(source.getContext()).resolves.toStrictEqual({ messages: [], tools: {} })
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Failed to capture context from IM:', failure)
    expect(loadHistory).toHaveBeenCalledTimes(1)
    await expect(source.getContext().then(context => context.messages)).resolves.toStrictEqual([{ ...history[0], region: 'session' }])
    expect(loadHistory).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'empty'] as const)('retains successful initialization with %s history', async mode => {
    const loadHistory = vi.fn(async (): Promise<MessageWithTimestamp[]> => [])
    const source = new IMDrivenSource({
      sessionKey: mode,
      loadHistory: mode === 'empty' ? loadHistory : undefined,
    })
    await expect(Promise.all([source.getContext().then(context => context.messages), source.getContext().then(context => context.messages)])).resolves.toEqual([[], []])
    const record = source.addMessage({ role: 'user', content: 'later' }, 2_000)
    await expect(source.getContext().then(context => context.messages)).resolves.toStrictEqual([record])
    expect(loadHistory).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0)
  })

  it('captures tools with restored messages while disabled compaction still short-circuits', async () => {
    const loadHistory = vi.fn(async (): Promise<MessageWithTimestamp[]> => [])
    const source = new IMDrivenSource({ sessionKey: 'short-circuit', loadHistory })
    await expect(source.maybeCompactByThreshold({ enabled: false, maxContextTokens: 50 })).resolves.toStrictEqual({
      compacted: false, syntheticMessages: [], summary: '', compactedMessageCount: 0,
      cleanedToolResultCount: 0, currentTokens: 0, thresholdTokens: 50,
    })
    expect(loadHistory).not.toHaveBeenCalled()
    const context = await source.getContext()
    expect(context.tools).toHaveProperty('context_compact')
    await expect(context.executeTool!('unknown', {}, 'unknown-call')).resolves.toBeUndefined()
    expect(loadHistory).toHaveBeenCalledTimes(1)
  })

  it.each(['agent', 'hard-fallback', 'threshold'] as const)('%s compaction waits for an already pending load', async mode => {
    const gate = deferred<MessageWithTimestamp[]>()
    const entered = deferred<void>()
    const history: MessageWithTimestamp[] = [
      { role: 'user', content: 'u1', timestamp: 1_000 },
      { role: 'assistant', content: 'a1', timestamp: 1_100 },
      { role: 'user', content: 'u2', timestamp: 1_200 },
      { role: 'assistant', content: 'a2', timestamp: 1_300 },
    ]
    const loadHistory = vi.fn(() => { entered.resolve(); return gate.promise })
    const replaceHistory = vi.fn(async () => undefined)
    const updates = vi.fn()
    const source = new IMDrivenSource({ sessionKey: mode, loadHistory, replaceHistory })
    const unsubscribe = source.onUpdate(updates)
    const initial = observe(source.getContext().then(context => context.messages))
    let compaction: ReturnType<typeof observe<unknown>> | undefined
    try {
      await entered.promise
      compaction = observe<unknown>(mode === 'agent'
        ? source.getContext().then(context => context.executeTool!('context_compact', {
          summary: 'Summary after history restoration.', reason: 'waiting test', minMessages: 4, keepRecentMessages: 2,
        }, 'compact-call'))
        : mode === 'hard-fallback'
          ? source.runHardFallbackCompaction('waiting test', { minMessages: 4, keepRecentMessages: 2 })
          : source.maybeCompactByThreshold({ enabled: true, maxContextTokens: 1, minMessages: 4, keepRecentMessages: 2 }))
      await nextTurn()
      expect(compaction.settled).toBe(false)
      expect(replaceHistory).not.toHaveBeenCalled()
      expect(updates).not.toHaveBeenCalled()
      expect(loadHistory).toHaveBeenCalledTimes(1)

      gate.resolve(history)
      const result = await compaction.done
      expect(result).toMatchObject({
        status: 'fulfilled',
        value: mode === 'agent'
          ? { toolCallId: 'compact-call', toolName: 'context_compact', result: { success: true, compactedMessageCount: 2 } }
          : { compacted: true, compactedMessageCount: 2 },
      })
      const messages = await source.getContext().then(context => context.messages)
      expect(messages).toHaveLength(4)
      expect(messages.slice(-2)).toStrictEqual(history.slice(-2).map(message => ({ ...message, region: 'session' })))
      expect(replaceHistory).toHaveBeenCalledTimes(1)
      expect(replaceHistory.mock.calls[0]).toStrictEqual([mode, [
        messages[0], messages[1], history[2], history[3],
      ]])
      expect(updates).toHaveBeenCalledTimes(1)
      expect(loadHistory).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve(history)
      await initial.done
      await compaction?.done
      unsubscribe()
    }
  })

  it('waits for restored history before the real Driver calls its model boundary', async () => {
    const gate = deferred<MessageWithTimestamp[]>()
    const entered = deferred<void>()
    const history: MessageWithTimestamp[] = [{ role: 'user', content: 'restored request', timestamp: 1_000 }]
    const loadHistory = vi.fn(() => { entered.resolve(); return gate.promise })
    const source = new IMDrivenSource({ sessionKey: 'driver-history', loadHistory })
    const initial = observe(source.getContext().then(context => context.messages))
    const onAssistantMessage = vi.fn()
    const onRunError = vi.fn()
    const model = vi.spyOn(LLMClient.prototype, 'call').mockResolvedValue({
      text: 'complete', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      assistantMessage: { role: 'assistant', content: 'complete' },
    })
    let driver: AgentDriverV2 | undefined
    let work: Promise<void> | null = null
    try {
      await entered.promise
      source.addMessage({ role: 'user', content: 'new request while restoring' }, 2_000)
      driver = new AgentDriverV2({
        sources: [source], llm: { model: 'openai:controlled-im-history', apiKey: 'unused-no-network' },
        onAssistantMessage, onRunError,
      })
      const requested = driver.trigger()
      work = driver['runInFlight']
      expect(work).not.toBeNull()
      await requested
      await nextTurn()
      expect(model).not.toHaveBeenCalled()

      gate.resolve(history)
      await work
      expect(model).toHaveBeenCalledTimes(1)
      expect(model.mock.calls[0][0]).toStrictEqual([
        { role: 'user', content: 'restored request' },
        { role: 'user', content: 'new request while restoring' },
      ])
      expect(model.mock.calls[0][1]).toHaveProperty('context_compact')
      expect(onAssistantMessage).toHaveBeenCalledExactlyOnceWith({ role: 'assistant', content: 'complete' })
      expect(onRunError).not.toHaveBeenCalled()
      expect(loadHistory).toHaveBeenCalledTimes(1)
      expect(driver.getState()).toBe('idle')
    } finally {
      driver?.stop()
      gate.resolve(history)
      await initial.done
      await work
      driver?.dispose()
      model.mockRestore()
    }
  })
})
