import { it, expect, vi } from 'vitest';
import { isTUIAppFactory, type TUIAppFactory } from './app-factory.interface.js';

function createMockFactory(name: string): TUIAppFactory {
    return {
        persistenceSupport: 'state-session-v2',
        appLifecycleSupport: 'app-lifecycle-v2',
        toolAuthoringProtocol: 'view-type-tools-v7',
        kernelConfig: {
            appName: name,
            description: `${name} App`,
        },
        initialize: vi.fn(async () => ({ close: vi.fn() })),
    };
}

it('accepts only the component-factory contract, not retired manifest/create or callable factories', () => {
    const factory = createMockFactory('test');
    expect(isTUIAppFactory(factory)).toBe(true);
    expect(isTUIAppFactory({ manifest: { app_name: 'test' }, create: () => ({}) })).toBe(false);
    expect(isTUIAppFactory(() => ({}))).toBe(false);
    expect(isTUIAppFactory({ ...factory, initialize: undefined })).toBe(false);
    expect(isTUIAppFactory({ ...factory, kernelConfig: {} })).toBe(false);
    expect(isTUIAppFactory({ ...factory, kernelConfig: { appName: '' } })).toBe(false);
    const { persistenceSupport: _persistence, ...withoutPersistence } = factory;
    const { appLifecycleSupport: _lifecycle, ...withoutLifecycle } = factory;
    expect(isTUIAppFactory(withoutPersistence)).toBe(true);
    expect(isTUIAppFactory({ ...factory, persistenceSupport: undefined })).toBe(false);
    expect(isTUIAppFactory(withoutLifecycle)).toBe(false);
    expect(isTUIAppFactory({ ...factory, persistenceSupport: 'legacy' })).toBe(false);
    expect(isTUIAppFactory({ ...factory, appLifecycleSupport: 'legacy' })).toBe(false);
    const accessorMarker = { ...factory };
    Object.defineProperty(accessorMarker, 'appLifecycleSupport', { get: () => 'app-lifecycle-v2' });
    expect(isTUIAppFactory(accessorMarker)).toBe(false);
});
