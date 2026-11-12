import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Desktop } from './desktop.js';
import { createCloseHandle, freezeClose, newCloseState, snapshotClose } from './close-handle.js';

describe('Desktop', () => {
    let desktop: Desktop;

    beforeEach(() => {
        desktop = new Desktop();
    });

    afterEach(() => {
        desktop.dispose();
    });

    it('initializes with a unique ID', () => {
        expect(desktop.id).toBeDefined();
        expect(desktop.id).toContain('dt_');
    });

    it('does not expose the retired snapshot-fragment or dispatcher entry points', () => {
        expect(desktop).toHaveProperty('getAppInteraction');
        for (const name of ['getSnapshotFragments', 'dismountView', 'hideView', 'showView', 'mountViewByLink', 'experimentalCreateAppScope']) {
            expect(desktop).not.toHaveProperty(name);
        }
    });

    it('reinitializeApps delegates to AppManager and emits one coherent refresh signal', async () => {
        const appManager = {
            beginClose: vi.fn(() => {
                const state = newCloseState('app-manager');state.state = 'settled';
                const report = () => freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const });
                return createCloseHandle(report, Promise.resolve(report()));
            }),
            cleanupAsync: vi.fn(async () => undefined),
            reinitializeAll: vi.fn().mockResolvedValue({
                reinitializedAppIds: ['app_0'],
                skippedAppIds: ['app_1'],
                failedAppIds: [],
            }),
            getInstalledApps: vi.fn().mockReturnValue([]),
            getAppStates: vi.fn().mockReturnValue([]),
            getDynamicAppIds: vi.fn().mockReturnValue([]),
            broadcastLLMOutput: vi.fn(),
        };
        const delegatedDesktop = new Desktop('dt_phase1' as any, {
            appManager: appManager as any,
        });
        const emitSignalSpy = vi.spyOn((delegatedDesktop as any).signalBus, 'emitSignal');

        const result = await delegatedDesktop.reinitializeApps({
            reason: 'context_compaction',
        });

        expect(appManager.reinitializeAll).toHaveBeenCalledWith({
            reason: 'context_compaction',
        });
        expect(result).toEqual({
            desktopId: 'dt_phase1',
            reinitializedAppIds: ['app_0'],
            skippedAppIds: ['app_1'],
            failedAppIds: [],
        });
        expect(emitSignalSpy).toHaveBeenCalledWith('dt_phase1', 'manual_refresh');

        await delegatedDesktop.dispose();
        emitSignalSpy.mockRestore();
    });
});
