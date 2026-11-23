import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core/internal';
// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { RuntimeContext } from '@aotui/core';
import { createAppId, createDesktopId } from '../../spi/core/id-factory.js';
import type { AppStatePersistence } from '@aotui/core';
it('injects a matching persistence port only when supplied', async () => {
    const options = { appName: 'test_app', appId: createAppId('a'), desktopId: createDesktopId('d'),
        instanceId: 'i', projectionLimits: DEFAULT_PROJECTION_LIMITS };
    for (const managed of [false, true]) {
        let captured: RuntimeContext | undefined;
        const port = { protocol: 'state-session-v2', instanceId: 'i' } as AppStatePersistence;
        const kernel = new AppKernel({
            ...options, ...(managed ? { persistence: port } : {}),
            factory: { async initialize(context) { captured = context; return { close() {} }; } },
        });
        await kernel.onOpen();
        expect(captured?.persistence).toBe(managed ? port : undefined);
        await kernel.onClose();
    }

    const mismatched = { protocol: 'state-session-v2', instanceId: 'other' } as AppStatePersistence;
    expect(() => new AppKernel({
        ...options, persistence: mismatched, factory: { initialize() { throw new Error('Unexpected entry'); } },
    })).toThrow('Invalid App execution identity');
});
