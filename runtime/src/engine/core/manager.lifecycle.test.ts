import { describe, expect, it, vi } from 'vitest';
import { DesktopManager } from './manager.js';
import { createCloseOperation, freezeClose, newCloseState, snapshotClose } from './close-operation.js';
import type { DesktopCloseReport } from '../../spi/runtime/close.interface.js';

describe('DesktopManager admission and captured identity', () => {
    it('registers before its returned Promise settles and rejects duplicates through closing', async () => {
        const manager = new DesktopManager(), creating = manager.create('one');expect(manager.has('one')).toBe(true);
        await expect(manager.create('one')).rejects.toMatchObject({ code: 'DESKTOP_ALREADY_EXISTS' });await creating;
        const old = manager.get('one')!, operation = manager.beginDesktopShutdown('one');
        expect(manager.beginDesktopShutdown('one')).toBe(operation);await expect(manager.create('one')).rejects.toMatchObject({ code: 'DESKTOP_ALREADY_EXISTS' });
        await operation.completion;await Promise.resolve();await manager.create('one');expect(manager.get('one')).not.toBe(old);
        await manager.shutdown();
    });
    it('shutdown starts every Desktop independently and closes Manager and pool admission in the same turn', async () => {
        const manager = new DesktopManager();await manager.create('held');await manager.create('other');
        const held = manager.get('held')!, other = manager.get('other')!;
        let release!: () => void;const original = held.beginClose!.bind(held);
        const state = newCloseState('desktop');state.resourcesReleased = false;state.desktops = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };
        const report = (): DesktopCloseReport => freezeClose({ ...snapshotClose(state), scope: 'desktop', intent: 'close', desktopId: 'held', found: true });
        const completion = new Promise<DesktopCloseReport>(resolve => { release = () => { state.state = 'settled';state.resourcesReleased = true;state.desktops = { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 0 };resolve(report()); }; });
        const operation = createCloseOperation(report, completion);vi.spyOn(held, 'beginClose').mockReturnValue(operation);const otherClose = vi.spyOn(other, 'beginClose');
        const shutdown = manager.beginShutdown();expect(manager.beginShutdown()).toBe(shutdown);expect(otherClose).toHaveBeenCalledOnce();
        expect(manager.getWorkerPoolReport().state).not.toBe('open');await expect(manager.create('late')).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });
        expect(shutdown.inspect().state).toBe('closing');
        release();const result = await shutdown.completion;expect(result).toMatchObject({ ok: true, pool: { ownership: 'owned', report: { state: 'closed', total: 0 } }, desktops: { accepted: 2, settled: 2, pending: 0 } });
        // The barrier is a controlled report, not a real Worker: close its actual empty object too.
        await original().completion;
    });
    it('retains a Desktop whose resources were not verified as released', async () => {
        const manager = new DesktopManager();await manager.create('unknown');const desktop = manager.get('unknown')!;
        const original = desktop.beginClose!.bind(desktop), state = newCloseState('desktop');state.state = 'settled';state.resourcesReleased = false;
        state.desktops = { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 1 };
        const report: DesktopCloseReport = freezeClose({ ...snapshotClose(state), scope: 'desktop', intent: 'close', desktopId: 'unknown', found: true });
        vi.spyOn(desktop, 'beginClose').mockReturnValue(createCloseOperation(() => report, Promise.resolve(report)));
        await manager.destroy('unknown');expect(manager.get('unknown')).toBe(desktop);
        const final = await manager.beginShutdown().completion;expect(final.resourcesReleased).toBe(false);expect(manager.has('unknown')).toBe(true);
        await original().completion;
    });
    it('a late close cannot remove a replacement Desktop (captured object seam)', async () => {
        const manager = new DesktopManager();await manager.create('same');const old = manager.get('same')!;
        let release!: () => void;const state = newCloseState('desktop');state.desktops = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };
        const report = (): DesktopCloseReport => freezeClose({ ...snapshotClose(state), scope: 'desktop', intent: 'close', desktopId: 'same', found: true });
        const completion = new Promise<DesktopCloseReport>(resolve => { release = () => { state.state = 'settled';state.resourcesReleased = true;resolve(report()); }; });
        const original = old.beginClose!.bind(old);vi.spyOn(old, 'beginClose').mockReturnValue(createCloseOperation(report, completion));const destroying = manager.destroy('same');
        // Force the impossible-under-public-API replacement to exercise the identity guard.
        (manager as any).desktops.delete('same');await manager.create('same');const next = manager.get('same');
        release();await destroying;expect(manager.get('same')).toBe(next);await original().completion;await manager.shutdown();
    });
    it('missing ID has no historical resources or Desktop count', async () => {
        const manager = new DesktopManager(), report = await manager.beginDesktopShutdown('missing').completion;
        expect(report).toMatchObject({ found: false, ok: true, desktops: { accepted: 0, settled: 0 }, apps: { accepted: 0 } });await manager.shutdown();
    });
});
