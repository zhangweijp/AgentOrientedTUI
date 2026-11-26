import { it, expect, vi } from 'vitest';
import { isTUIAppFactory, readAppFactory, VIEW_TYPE_TOOL_PROTOCOL, type TUIAppFactory } from './app-factory.interface.js';

function createMockFactory(name: string): TUIAppFactory {
    return {
        appLifecycleSupport: 'app-lifecycle-v2',
        toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
        app_name: name,
        initialize: vi.fn(async () => ({ close: vi.fn() })),
    };
}

it('accepts the App factory contract with its declared initialization', () => {
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
    const { appLifecycleSupport: _lifecycle, ...withoutLifecycle } = factory;
    expect(isTUIAppFactory(withoutLifecycle)).toBe(false);
    expect(isTUIAppFactory({ ...factory, appLifecycleSupport: 'legacy' })).toBe(false);
    const accessorMarker = { ...factory };
    Object.defineProperty(accessorMarker, 'appLifecycleSupport', { get: () => 'app-lifecycle-v2' });
    expect(isTUIAppFactory(accessorMarker)).toBe(false);
});

it('requires an own data property with the supported tool authoring protocol', () => {
    const { toolAuthoringProtocol, ...factory } = createMockFactory('test');
    expect(isTUIAppFactory(factory)).toBe(false);
    expect(isTUIAppFactory({ ...factory, toolAuthoringProtocol: 'view-type-tools-v7' })).toBe(false);
    const readProtocol = vi.fn(() => toolAuthoringProtocol);
    const accessor = Object.defineProperty({ ...factory }, 'toolAuthoringProtocol', { get: readProtocol });
    expect(isTUIAppFactory(accessor)).toBe(false);
    expect(readProtocol).not.toHaveBeenCalled();
    expect(readAppFactory(factory)).toBe('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
});
