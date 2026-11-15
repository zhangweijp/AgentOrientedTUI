import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';
import { SignalBus } from './signal-bus.js';
import { DesktopLogger } from './desktop-logger.js';

describe('Desktop lifetime-bound channels', () => {
    it('caches output; duplicate listener is idempotent and old unsubscribe cannot touch a successor', async () => {
        const bus = new SignalBus(), first = new Desktop('same', { signalBus: bus }), listener = vi.fn(), output = first.output;
        expect(first.output).toBe(output);output.subscribe(listener);output.subscribe(listener);expect(bus.getListenerCount('same')).toBe(1);
        const handle = first.beginClose();expect(() => output.subscribe(listener)).toThrowError(expect.objectContaining({ code: 'DESKTOP_DISPOSED' }));await handle.completion;
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
    it('late log/emit diagnostics create no successor records', async () => {
        const bus = new SignalBus(), logger = new DesktopLogger(), old = new Desktop('x:y', { signalBus: bus, logger });
        await old.dispose();const next = new Desktop('x:y', { signalBus: bus, logger });const listen = vi.fn();next.output.subscribe(listen);
        const before = next.getSystemLogs();old.logSystem('late');old.emitSignal('manual_refresh');
        expect(next.getSystemLogs()).toEqual(before);expect(listen).not.toHaveBeenCalled();await next.dispose();
    });
});
