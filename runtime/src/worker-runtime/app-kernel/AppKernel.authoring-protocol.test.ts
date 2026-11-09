import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';

function managedFactory(marker: 'missing' | 'old' | 'v2' | 'v3' | 'accessor') {
    const initializeComponent = vi.fn(async () => ({ unmount() {} }));
    const factory: any = {
        displayName: 'legacy', kernelConfig: { appName: 'legacy' },
        persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', initializeComponent,
    };
    if (marker === 'old') factory.toolAuthoringProtocol = 'view-local-tools-v2';
    if (marker === 'v3') factory.toolAuthoringProtocol = 'view-type-tools-v3';
    if (marker === 'v2') factory.toolAuthoringProtocol = 'view-type-tools-v2';
    if (marker === 'accessor') {
        let reads = 0;
        Object.defineProperty(factory, 'toolAuthoringProtocol', { enumerable: true, get() { reads++; return 'view-type-tools-v1'; } });
        return { factory, initializeComponent, reads: () => reads };
    }
    return { factory, initializeComponent, reads: () => 0 };
}

async function open(kernel: AppKernel) {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any }, document.querySelector('#app') as any);
}

describe('AppKernel TUIAppFactory authoring protocol', () => {
    it.each(['missing', 'old', 'v2', 'v3', 'accessor'] as const)('rejects %s authoring marker before initialization', async marker => {
        const fixture = managedFactory(marker);
        const kernel = new AppKernel({ name: 'legacy', appName: 'legacy', component: fixture.factory });
        kernel.setId('app' as any);
        await expect(open(kernel)).rejects.toThrow('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
        expect(fixture.initializeComponent).not.toHaveBeenCalled();
        expect(fixture.reads()).toBe(0);
        await kernel.onClose();
    });

    it('does not require an SDK authoring marker from a plain TypeScript ComponentFactory', async () => {
        const initializeComponent = vi.fn(async () => ({ unmount() {} }));
        const kernel = new AppKernel({ name: 'plain', appName: 'plain', component: { initializeComponent } as any });
        kernel.setId('app' as any);
        await open(kernel);
        expect(initializeComponent).toHaveBeenCalledOnce();
        await kernel.onClose();
    });
});
