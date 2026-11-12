import { describe, expect, it, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';

function managedFactory(marker: 'missing' | 'old' | 'v2' | 'v3' | 'accessor') {
    const initialize = vi.fn(async () => ({ close() {} }));
    const factory: any = {
        displayName: 'legacy', kernelConfig: { appName: 'legacy' },
        persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', initialize,
    };
    if (marker === 'old') factory.toolAuthoringProtocol = 'view-local-tools-v2';
    if (marker === 'v3') factory.toolAuthoringProtocol = 'view-type-tools-v3';
    if (marker === 'v2') factory.toolAuthoringProtocol = 'view-type-tools-v2';
    if (marker === 'accessor') {
        let reads = 0;
        Object.defineProperty(factory, 'toolAuthoringProtocol', { enumerable: true, get() { reads++; return 'view-type-tools-v1'; } });
        return { factory, initialize, reads: () => reads };
    }
    return { factory, initialize, reads: () => 0 };
}

async function open(kernel: AppKernel) {
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any });
}

describe('AppKernel TUIAppFactory authoring protocol', () => {
    it.each(['missing', 'old', 'v2', 'v3', 'accessor'] as const)('rejects %s authoring marker before initialization', async marker => {
        const fixture = managedFactory(marker);
        const kernel = new AppKernel({ name: 'legacy', appName: 'legacy', factory: fixture.factory });
        kernel.setId('app' as any);
        await expect(open(kernel)).rejects.toThrow('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
        expect(fixture.initialize).not.toHaveBeenCalled();
        expect(fixture.reads()).toBe(0);
        await kernel.onClose();
    });

    it('does not require an SDK authoring marker from a plain TypeScript App factory', async () => {
        const initialize = vi.fn(async () => ({ close() {} }));
        const kernel = new AppKernel({ name: 'plain', appName: 'plain', factory: { initialize } as any });
        kernel.setId('app' as any);
        await open(kernel);
        expect(initialize).toHaveBeenCalledOnce();
        await kernel.onClose();
    });
});
