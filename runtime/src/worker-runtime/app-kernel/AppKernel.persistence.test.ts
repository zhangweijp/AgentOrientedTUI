// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { RuntimeContext } from '../../spi/app/app-instance.interface.js';
import { createAppId, createDesktopId } from '../../spi/index.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
it('B04: injects only a preassigned matching instance port; ordinary components need no port', async () => {
    for (const managed of [false, true]) {
        let captured: RuntimeContext | undefined;
        const kernel = new AppKernel({ appName: 'a', name: 'A', factory: { initialize: async (context: RuntimeContext) => { captured = context;return { close() {} }; } } });
        kernel.setId(createAppId('a'));kernel.setAppExecutionInstanceId('i');
        const port = { protocol: 'state-session-v1', instanceId: 'i' } as AppStatePersistence;
        if (managed) { kernel.setPersistence(port);expect(() => kernel.setPersistence(port)).toThrow(); }
        await kernel.onOpen({ appId: createAppId('a'), desktopId: createDesktopId('d') });
        expect(captured?.persistence).toBe(managed ? port : undefined);await kernel.onClose();
    }
});
