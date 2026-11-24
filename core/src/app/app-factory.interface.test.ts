import { it, expect, vi } from 'vitest';
import { isTUIAppFactory, readAppFactory, type TUIAppFactory } from './app-factory.interface.js';

function createMockFactory(name: string): TUIAppFactory {
    return {
        persistenceSupport: 'state-session-v2',
        appLifecycleSupport: 'app-lifecycle-v2',
        toolAuthoringProtocol: 'view-type-tools-v7',
        app_name: name,
        initialize: vi.fn(async () => ({ close: vi.fn() })),
    };
}

it('accepts only the component-factory contract, not retired manifest/create or callable factories', () => {
    const factory = createMockFactory('test');
    expect(isTUIAppFactory(factory)).toBe(true);
    expect(isTUIAppFactory({ manifest: { app_name: 'test' }, create: () => ({}) })).toBe(false);
    expect(isTUIAppFactory(() => ({}))).toBe(false);
    expect(isTUIAppFactory({ ...factory, initialize: undefined })).toBe(false);
    expect(isTUIAppFactory({ ...factory, app_name: undefined })).toBe(false);
    expect(isTUIAppFactory({ ...factory, app_name: '' })).toBe(false);
    const readName = vi.fn(() => 'test');
    expect(isTUIAppFactory(Object.defineProperty({ ...factory }, 'app_name', { get: readName }))).toBe(false);
    expect(readName).not.toHaveBeenCalled();
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

it('requires an own data property with the supported tool authoring protocol', () => {
    const { toolAuthoringProtocol, ...factory } = createMockFactory('test');
    expect(isTUIAppFactory(factory)).toBe(false);
    expect(isTUIAppFactory({ ...factory, toolAuthoringProtocol: 'view-type-tools-v3' })).toBe(false);
    const readProtocol = vi.fn(() => toolAuthoringProtocol);
    const accessor = Object.defineProperty({ ...factory }, 'toolAuthoringProtocol', { get: readProtocol });
    expect(isTUIAppFactory(accessor)).toBe(false);
    expect(readProtocol).not.toHaveBeenCalled();
});

it('reads the persistence declaration once and preserves the storage-specific diagnostic', () => {
    const getOwnPropertyDescriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
    const factory = new Proxy(createMockFactory('test'), { getOwnPropertyDescriptor });
    expect(readAppFactory(factory)).toBe(factory);
    expect(getOwnPropertyDescriptor.mock.calls.filter(([, key]) => key === 'persistenceSupport')).toHaveLength(1);
    const read = vi.fn(() => 'state-session-v2');
    const accessor = Object.defineProperty({ ...factory }, 'persistenceSupport', { get: read });
    expect(readAppFactory(accessor)).toBe('PERSISTENCE_UNAVAILABLE');
    expect(read).not.toHaveBeenCalled();
});
