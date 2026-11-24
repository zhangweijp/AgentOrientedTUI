import { afterEach, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';

const update = { appId: 'app', instanceId: 'run', reason: 'view_updated' } as const;

afterEach(() => vi.restoreAllMocks());

it('isolates Desktop signals, deduplicates subscriptions and binds unsubscribe to the original owner', async () => {
    const first = new Desktop('same'), neighbor = new Desktop('same:neighbor');
    const listen = vi.fn(), other = vi.fn(), output = first.output;
    expect(first.output).toBe(output);
    output.subscribe(listen);
    output.subscribe(listen);
    neighbor.output.subscribe(other);

    const before = Date.now();
    first.emitSignal(update);
    expect(listen).toHaveBeenCalledExactlyOnceWith({ ...update, desktopId: 'same', timestamp: expect.any(Number) });
    const signal = listen.mock.calls[0]![0];
    expect(signal.timestamp).toBeGreaterThanOrEqual(before);
    expect(signal.timestamp).toBeLessThanOrEqual(Date.now());
    expect(other).not.toHaveBeenCalled();

    await first.beginClose().completion;
    expect(() => output.subscribe(listen)).toThrowError(expect.objectContaining({ code: 'DESKTOP_DISPOSED' }));
    const successor = new Desktop('same');
    successor.output.subscribe(listen);
    output.unsubscribe(listen);
    first.emitSignal(update);
    successor.emitSignal(update);
    neighbor.emitSignal(update);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledExactlyOnceWith({ ...update, desktopId: 'same:neighbor', timestamp: expect.any(Number) });

    await Promise.all([successor.beginClose().completion, neighbor.beginClose().completion]);
});

it('isolates a failing subscriber and stops delivering to listeners after unsubscribe', async () => {
    const desktop = new Desktop('listeners');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn(() => { throw Error('fixture'); }), listen = vi.fn();
    desktop.output.subscribe(failed);
    desktop.output.subscribe(listen);
    desktop.emitSignal(update);
    desktop.output.unsubscribe(failed);
    desktop.output.unsubscribe(listen);
    desktop.emitSignal(update);

    expect(log).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
    await desktop.beginClose().completion;
});

it('stops delivery when a listener closes its Desktop in the same dispatch', async () => {
    const desktop = new Desktop('reentrant'), following = vi.fn();
    const close = vi.fn(() => { desktop.beginClose(); });
    desktop.output.subscribe(close);
    desktop.output.subscribe(following);
    desktop.emitSignal(update);
    expect(desktop.isClosing).toBe(true);
    await desktop.beginClose().completion;
    desktop.emitSignal(update);

    expect(close).toHaveBeenCalledOnce();
    expect(following).not.toHaveBeenCalled();
});
