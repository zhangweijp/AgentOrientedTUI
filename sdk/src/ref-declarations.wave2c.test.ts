import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { act } from '@testing-library/preact';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const declaration = { type: 'reference', required: true, refSource: 'snapshot-value-v1', refType: 'File' };
const options = (change: Record<string, unknown> = {}) => ({
    description: 'Inspect', params: { file: declaration }, isMutating: false, ...change,
}) as any;
const snapshotInvocation = {
    safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2',
    additionalProperties: false,
    createSafeSnapshotValueParametersInvoker: () => async () => ({
        phase: 'entered-returned' as const, result: { success: true },
    }),
};
const ordinaryInvocation = {
    safeOrdinaryParametersInvocationMode: 'ordinary-v2',
    additionalProperties: false,
    createSafeOrdinaryParametersInvoker: () => async () => ({
        phase: 'entered-returned' as const, result: { success: true },
    }),
};

function setup(content: () => any, support: 'actual' | 'missing' | 'unknown' = 'actual') {
    const component = () => h(View, { id: 'fd_A', type: 'FileDetail' }, h(content, {}));
    const factory = createTUIApp({ app_name: 'wave2c_sdk', component });
    const initialize = factory.initializeComponent;
    const register = vi.fn();
    let port: any;
    factory.initializeComponent = async (container, context) => {
        port = context.viewTools;
        const simulatedPort: any = { ...port, registerTool: (...args: any[]) => {
            register(...args); return port.registerTool(...args);
        } };
        if (support === 'missing') delete simulatedPort.refDeclarationSupport;
        if (support === 'unknown') simulatedPort.refDeclarationSupport = 'future';
        // This models the OLD PORT contract, not an old Worker binary.
        return initialize(container, { ...context, viewTools: simulatedPort });
    };
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('wave2c_sdk' as any); kernel.setAppExecutionInstanceId('wave2c-sdk-run');
    const container = document.createElement('div'); document.body.appendChild(container);
    return {
        kernel, register,
        open: () => kernel.onOpen({ appId: 'wave2c_sdk' as any, desktopId: 'test' as any,
            markDirty() {}, onRender() {} }, container),
        async close() { await kernel.onClose(); container.remove(); },
        get port() { return port; },
    };
}

afterEach(() => vi.unstubAllEnvs());

describe('Wave 2C: real Preact, SDK and AppKernel declaration registration', () => {
    it('preserves the one declaration-only support marker, Schema metadata and lifecycle cleanup', async () => {
        function Content() {
            useViewTypeTool('inspect', options(), async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await env.open();
            expect(env.port.refDeclarationSupport).toBe('snapshot-value-v1');
            expect(env.register).toHaveBeenCalledTimes(1);
            expect(env.kernel.getViewOwnedToolDefinitions()[0].inputSchema).toMatchObject({ properties: { file: {
                type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target', refType: 'File' },
            } } });
            expect(env.kernel.getViewOwnedToolDefinitions()).toHaveLength(1);
        } finally { await env.close(); }
        expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
    });

    it.each(['missing', 'unknown'] as const)('refuses a port with %s declaration support before registration', async support => {
        function Content() {
            useViewTypeTool('inspect', options(), async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content, support);
        try {
            await expect(env.open()).rejects.toThrow('REF_CONTRACT_UNSUPPORTED');
            expect(env.register).not.toHaveBeenCalled();
            expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { await env.close(); }
    });

    it.each(['actual', 'missing', 'unknown'] as const)('rejects unannotated references when declaration support is %s', async support => {
        function Content() {
            useViewTypeTool('inspect', options({ params: { file: { type: 'reference', refType: 'File' } } }),
                async args => ({ success: true, data: { args } }));
            return h('p', {}, 'A');
        }
        const env = setup(Content, support);
        try {
            await expect(env.open()).rejects.toThrow('REF_CONTRACT_UNSUPPORTED');
            expect(env.register).not.toHaveBeenCalled();
            expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { await env.close(); }
    });

    it.each([true, undefined])('rejects mutating/default-mutating new declarations: %s', async isMutating => {
        function Content() {
            useViewTypeTool('inspect', options({ isMutating }), async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await expect(env.open()).rejects.toThrow('REF_DECLARATION_INVALID');
            expect(env.register).not.toHaveBeenCalled();
            expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { await env.close(); }
    });

    it('the direct View-local port validates new declarations without relying on the SDK Hook', async () => {
        const env = setup(() => h('p', {}, 'A')); const handler = vi.fn(async () => ({ success: true }));
        let mount: string | undefined;
        try {
            await env.open(); mount = env.port.mount('direct', 'Detail');
            expect(() => env.port.registerTool(mount, 'bad', { description: 'Bad', params: {
                file: { ...declaration, refSource: 'future' },
            }, isMutating: false, handler }, snapshotInvocation)).toThrow('PARAMETER_DECLARATION_UNSUPPORTED');
            expect(() => env.port.registerTool(mount, 'bad', { description: 'Bad', params: {
                file: declaration,
            }, handler }, snapshotInvocation)).toThrow('Invalid Ref V2 registration metadata');
            expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
            const release = env.port.registerTool(mount, 'inspect', {
                description: 'Inspect', params: { file: declaration }, isMutating: false, handler,
            }, snapshotInvocation);
            const current = env.kernel.getViewOwnedToolDefinitions()[0];
            expect(current.inputSchema).toMatchObject({ properties: { file: {
                type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target', refType: 'File' },
            } } });
            expect(current.isMutating).toBe(false);
            expect(handler).not.toHaveBeenCalled();
            release(); expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { if (mount) env.port.unmount(mount); await env.close(); }
    });

    it('Runtime validates Ref declarations in production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        function Content() {
            useViewTypeTool('inspect', options({ params: { file: { ...declaration, constraints: {} } } }),
                async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await expect(env.open()).rejects.toThrow('PARAMETER_DECLARATION_INVALID');
            expect(env.register).not.toHaveBeenCalled();
            expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { await env.close(); }
    });

    it('equivalent declaration key order does not re-register the Tool', async () => {
        let update!: (value: boolean) => void;
        function Content() {
            const [reversed, set] = useState(false); update = set;
            const file = reversed
                ? { refType: 'File', refSource: 'snapshot-value-v1', required: true, type: 'reference' }
                : { type: 'reference', required: true, refSource: 'snapshot-value-v1', refType: 'File' };
            useViewTypeTool('inspect', options({ params: { file } }), async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await env.open(); const before = env.kernel.getViewOwnedToolDefinitions()[0];
            act(() => update(true));
            expect(env.kernel.getViewOwnedToolDefinitions()[0]).toEqual(before);
            expect(env.register).toHaveBeenCalledTimes(1);
        } finally { await env.close(); }
    });

    it('a getter in an opt-in field is rejected without execution', async () => {
        const getter = vi.fn(() => 'File'); const field = { ...declaration };
        Object.defineProperty(field, 'refType', { get: getter, enumerable: true });
        function Content() {
            useViewTypeTool('inspect', options({ params: { file: field } }), async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await expect(env.open()).rejects.toThrow();
            expect(getter).not.toHaveBeenCalled();
            expect(env.register).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('rejects an outer options.params getter before reading declaration data', async () => {
        const getter = vi.fn(() => ({ file: declaration })); const opts = options();
        Object.defineProperty(opts, 'params', { get: getter, enumerable: true });
        function Content() {
            useViewTypeTool('inspect', opts, async () => ({ success: true }));
            return h('p', {}, 'A');
        }
        const env = setup(Content);
        try {
            await expect(env.open()).rejects.toThrow('Accessors/hidden properties');
            expect(getter).not.toHaveBeenCalled(); expect(env.register).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('the direct port rejects a definition.params getter before reading declaration data', async () => {
        const getter = vi.fn(() => ({ file: declaration }));
        const definition = { description: 'Inspect', isMutating: false, handler: async () => ({ success: true }) };
        Object.defineProperty(definition, 'params', { get: getter, enumerable: true });
        const env = setup(() => h('p', {}, 'A')); let mount: string | undefined;
        try {
            await env.open(); mount = env.port.mount('direct', 'Detail');
            expect(() => env.port.registerTool(mount, 'inspect', definition, ordinaryInvocation)).toThrow('Accessors/hidden properties');
            expect(getter).not.toHaveBeenCalled(); expect(env.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally { if (mount) env.port.unmount(mount); await env.close(); }
    });
});
