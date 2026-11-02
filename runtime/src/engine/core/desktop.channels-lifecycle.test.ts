import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';
import { SignalBus } from './signal-bus.js';
import { LLMOutputChannelService } from './llm-output-channel.js';
import { DesktopLogger } from './desktop-logger.js';

describe('Desktop lifetime-bound channels', () => {
    it('caches output; duplicate listener is idempotent and old unsubscribe cannot touch a successor', async () => {
        const bus = new SignalBus(), first = new Desktop('same', { signalBus: bus }), listener = vi.fn(), output = first.output;
        expect(first.output).toBe(output);output.subscribe(listener);output.subscribe(listener);expect(bus.getListenerCount('same')).toBe(1);
        const operation = first.beginClose();expect(() => output.subscribe(listener)).toThrowError(expect.objectContaining({ code: 'DESKTOP_DISPOSED' }));await operation.completion;
        const successor = new Desktop('same', { signalBus: bus });successor.output.subscribe(listener);output.unsubscribe(listener);
        successor.emitSignal('manual_refresh');expect(listener).toHaveBeenCalledOnce();expect(bus.getListenerCount('same')).toBe(1);await successor.dispose();
    });
    it('revokes a subscription created during a synchronous reentrant close', async () => {
        const bus = new SignalBus(), original = bus.subscribe.bind(bus);let desktop!: Desktop;let cancelCount = 0;
        vi.spyOn(bus, 'subscribe').mockImplementation((id, listener) => {
            const cancel = original(id, listener);listener({ desktopId: id, reason: 'manual_refresh', timestamp: 0 });
            return () => { cancelCount++;cancel(); };
        });
        desktop = new Desktop('reentrant', { signalBus: bus });desktop.output.subscribe(() => { desktop.beginClose(); });
        await desktop.beginClose().completion;expect(cancelCount).toBe(1);expect(bus.getListenerCount('reentrant')).toBe(0);
    });
    it('LLM facade scopes each ID and isolates shared service history, cleanup and successor subscriptions', async () => {
        const service = new LLMOutputChannelService(), a = new Desktop('a', { llmOutputChannelService: service }), b = new Desktop('b', { llmOutputChannelService: service });
        const old = a.getLLMOutputChannel();expect(a.getLLMOutputChannel()).toBe(old);
        expect(() => old.push('b', { content: 'wrong' })).toThrow('DESKTOP_SCOPE_MISMATCH');
        expect(() => old.subscribe('b', () => {})).toThrow('DESKTOP_SCOPE_MISMATCH');expect(() => old.cleanup('b')).toThrow('DESKTOP_SCOPE_MISMATCH');
        old.push('a', { content: 'first' });b.getLLMOutputChannel().push('b', { content: 'second' });
        old.getHistory('a').length = 0;expect(old.getHistory('a')).toHaveLength(1);
        const listener = vi.fn(), cancel = old.subscribe('a', listener);listener.mockClear();
        const closing = a.beginClose();expect(old.getHistory('a')).toEqual([]);
        for (const action of [() => old.push('a', { content: 'late' }), () => old.subscribe('a', listener), () => old.cleanup('a')]) expect(action).toThrowError(expect.objectContaining({ code: 'DESKTOP_DISPOSED' }));
        await closing.completion;expect(service.getHistory('a')).toEqual([]);expect(service.getHistory('b')).toHaveLength(1);
        const next = new Desktop('a', { llmOutputChannelService: service }), channel = next.getLLMOutputChannel();channel.subscribe('a', listener);cancel();
        channel.push('a', { content: 'new' });expect(listener).toHaveBeenCalledOnce();expect(old.getHistory('a')).toEqual([]);await Promise.all([b.dispose(), next.dispose()]);
    });
    it('cancels an LLM history replay subscription when its callback closes the Desktop', async () => {
        const service = new LLMOutputChannelService();service.push('replay', { content: 'history' });
        const desktop = new Desktop('replay', { llmOutputChannelService: service }), listener = vi.fn(() => { desktop.beginClose(); });
        const cancel = desktop.getLLMOutputChannel().subscribe('replay', listener);await desktop.beginClose().completion;cancel();
        service.push('replay', { content: 'external after close' });expect(listener).toHaveBeenCalledOnce();service.cleanup('replay');
    });
    it('late log/emit diagnostics create no successor records', async () => {
        const bus = new SignalBus(), logger = new DesktopLogger(), old = new Desktop('x:y', { signalBus: bus, logger });
        await old.dispose();const next = new Desktop('x:y', { signalBus: bus, logger });const listen = vi.fn();next.output.subscribe(listen);
        const before = next.getSystemLogs();old.logSystem('late');old.logAppOperation('z', 'late');old.emitSignal('manual_refresh');
        expect(next.getSystemLogs()).toEqual(before);expect(next.getAppOperationLogs('z')).toEqual([]);expect(listen).not.toHaveBeenCalled();await next.dispose();
    });
});
