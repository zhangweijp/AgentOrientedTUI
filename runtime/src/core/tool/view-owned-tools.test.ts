import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools, ViewToolContractError } from './view-owned-tools.js';

const spec = () => ({
    name: 'lsp_hover',
    description: 'Look up a symbol in the selected file',
    inputSchema: { type: 'object', properties: { line: { type: 'number' } } },
    isMutating: false,
} as const);

function files() {
    const core = createViewOwnedTools('system_ide', 'app-instance-1');
    const app = core.mount('fd_0', 'FileDetail');
    const pkg = core.mount('fd_1', 'FileDetail');
    return { core, app, pkg };
}
function mustBeError(code: string): RegExp {
    return new RegExp('^' + code + ': ');
}
function oneTool(core: ReturnType<typeof createViewOwnedTools>) {
    const offerings = core.listTools();
    expect(offerings).toHaveLength(1);
    return offerings[0];
}

describe('M4-preflight: Runtime-issued ViewInstanceId', () => {
    it('keeps developer viewId readable but issues a unique internal View identity at each mount', () => {
        const { core, app, pkg } = files();
        expect(app).toMatchObject({ viewId: 'fd_0', viewType: 'FileDetail' });
        expect(app.viewInstanceId).not.toBe(pkg.viewInstanceId);
        expect(Object.isFrozen(app)).toBe(true);
        core.unmount(app.viewInstanceId);
        const reopened = core.mount('fd_0', 'FileDetail');
        expect(reopened.viewId).toBe(app.viewId);
        expect(reopened.viewInstanceId).not.toBe(app.viewInstanceId);
        expect(() => core.mount('fd_0', 'FileDetail')).toThrowError(mustBeError('VIEW_DUPLICATE'));
        core.unmount(app.viewInstanceId); // stale unmount cannot close the new instance
        expect(() => core.mount('fd_0', 'FileDetail')).toThrowError(mustBeError('VIEW_DUPLICATE'));
        core.unmount(reopened.viewInstanceId);
        expect(core.mount('fd_0', 'FileDetail').viewInstanceId).not.toBe(reopened.viewInstanceId);
    });
});


describe('M4-preflight: View-owned Tools and Runtime aggregation', () => {
    it('each FileDetail declares its own Handler, Agent sees one grouped Tool', async () => {
        const { core, app, pkg } = files();
        const first = vi.fn(async () => ({ success: true, data: { file: 'App.tsx' } }));
        const second = vi.fn(async () => ({ success: true, data: { file: 'package.json' } }));
        core.registerTool(app.viewInstanceId, spec(), first);
        core.registerTool(pkg.viewInstanceId, spec(), second);
        const offering = oneTool(core);
        expect(offering).toMatchObject({
            appId: 'system_ide', appInstanceId: 'app-instance-1',
            viewType: 'FileDetail', name: 'lsp_hover', isMutating: false,
        });
        expect(offering.targets.map(target => target.viewId)).toEqual(['fd_0', 'fd_1']);
        expect(offering.id).toBe(JSON.stringify(['system_ide', 'FileDetail', 'lsp_hover']));
        const sourceA = offering.targets[0];
        const sourceB = offering.targets[1];
        expect(await core.invoke(offering, sourceA, { line: 10 })).toEqual({
            success: true, data: { file: 'App.tsx' },
        });
        expect(await core.invoke(offering, sourceB, { line: 10 })).toEqual({
            success: true, data: { file: 'package.json' },
        });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('unregistering A cannot delete B, and old A observation cannot silently retarget B', async () => {
        const { core, app, pkg } = files();
        const a = vi.fn(async () => ({ success: true, data: { file: 'App.tsx' } }));
        const b = vi.fn(async () => ({ success: true, data: { file: 'package.json' } }));
        const unregisterA = core.registerTool(app.viewInstanceId, spec(), a);
        core.registerTool(pkg.viewInstanceId, spec(), b);
        const source = oneTool(core);
        const observedA = source.targets[0];
        const observedB = source.targets[1];
        unregisterA();
        unregisterA();
        expect(core.listTools()[0].targets.map(x => x.viewId)).toEqual(['fd_1']);
        expect((await core.invoke(source, observedA, {})).error?.code).toBe('TOOL_UNAVAILABLE');
        expect((await core.invoke(source, observedB, {})).success).toBe(true);
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('same viewId after close/reopen cannot revive an old Handler or old observed Tool', async () => {
        const { core, app } = files();
        const oldHandler = vi.fn(async () => ({ success: true, data: { file: 'old App.tsx' } }));
        core.registerTool(app.viewInstanceId, spec(), oldHandler);
        const source = oneTool(core);
        const oldTarget = source.targets.find(target => target.viewId === 'fd_0')!;
        core.unmount(app.viewInstanceId);
        const replacement = core.mount('fd_0', 'FileDetail');
        const freshHandler = vi.fn(async () => ({ success: true, data: { file: 'new App.tsx' } }));
        core.registerTool(replacement.viewInstanceId, spec(), freshHandler);
        const failed = await core.invoke(source, oldTarget, { line: 4 });
        expect(failed).toMatchObject({
            success: false, error: { code: 'VIEW_INSTANCE_REVOKED' },
        });
        expect(oldHandler).not.toHaveBeenCalled();
        expect(freshHandler).not.toHaveBeenCalled();
        const fresh = oneTool(core);
        expect(fresh.targets.some(t => t.viewInstanceId === replacement.viewInstanceId)).toBe(true);
        expect(await core.invoke(fresh, fresh.targets.find(t => t.viewId === 'fd_0')!, { line: 4 }))
            .toMatchObject({ success: true, data: { file: 'new App.tsx' } });
    });

    it('reusing a View Instance ID after another App execution is not possible', async () => {
        const firstRun = createViewOwnedTools('system_ide', 'run_1');
        const secondRun = createViewOwnedTools('system_ide', 'run_2');
        const firstView = firstRun.mount('fd_0', 'FileDetail');
        const secondView = secondRun.mount('fd_0', 'FileDetail');
        expect(firstView.viewInstanceId).not.toBe(secondView.viewInstanceId);
        firstRun.registerTool(firstView.viewInstanceId, spec(), async () => ({ success: true }));
        secondRun.registerTool(secondView.viewInstanceId, spec(), async () => ({ success: true }));
        const observation = firstRun.listTools()[0];
        const result = await secondRun.invoke(observation, observation.targets[0], {});
        expect(result).toMatchObject({ success: false, error: { code: 'APP_INSTANCE_MISMATCH' } });
    });

    it('each FileDetail controls only its own enabled state', async () => {
        const { core, app, pkg } = files();
        const handlerA = vi.fn(async () => ({ success: true }));
        const handlerB = vi.fn(async () => ({ success: true }));
        core.registerTool(app.viewInstanceId, spec(), handlerA, true);
        core.registerTool(pkg.viewInstanceId, spec(), handlerB, false);
        const seenA = oneTool(core);
        expect(seenA.targets.map(t => t.viewId)).toEqual(['fd_0']);
        core.setEnabled(app.viewInstanceId, 'lsp_hover', false);
        expect(core.listTools()).toEqual([]);
        core.setEnabled(pkg.viewInstanceId, 'lsp_hover', true);
        const seenB = oneTool(core);
        expect(seenB.targets.map(t => t.viewId)).toEqual(['fd_1']);
        expect((await core.invoke(seenA, seenA.targets[0], {})).error?.code).toBe('TOOL_UNAVAILABLE');
        core.setEnabled(app.viewInstanceId, 'lsp_hover', true);
        const current = oneTool(core);
        const activeA = current.targets.find(t => t.viewId === 'fd_0')!;
        expect(activeA.bindingVersion).not.toBe(seenA.targets[0].bindingVersion);
        expect((await core.invoke(seenA, seenA.targets[0], {})).error?.code).toBe('TOOL_SOURCE_STALE');
        expect((await core.invoke(current, activeA, {})).success).toBe(true);
    });

    it('identical public schemas with different property order aggregate; mismatched schema rejects atomically', () => {
        const { core, app, pkg } = files();
        const originalSpec = spec();
        core.registerTool(app.viewInstanceId, originalSpec, async () => ({ success: true }));
        core.registerTool(pkg.viewInstanceId, {
            name: 'lsp_hover', description: originalSpec.description,
            inputSchema: {
                properties: { line: { type: 'number' } },
                type: 'object',
            },
            isMutating: false,
        }, async () => ({ success: true }));
        expect(oneTool(core).targets).toHaveLength(2);
        const extra = core.mount('fd_2', 'FileDetail');
        expect(() => core.registerTool(extra.viewInstanceId, {
            ...originalSpec, description: 'Different semantics',
        }, async () => ({ success: true }))).toThrowError(mustBeError('TOOL_SCHEMA_CONFLICT'));
        expect(() => core.registerTool(extra.viewInstanceId, {
            ...originalSpec,
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        }, async () => ({ success: true }))).toThrowError(mustBeError('TOOL_SCHEMA_CONFLICT'));
        expect(oneTool(core).targets).toHaveLength(2);
    });

    it('different ViewTypes may expose same Tool name without interfering', () => {
        const { core, app } = files();
        const workspace = core.mount('workspace', 'Workspace');
        core.registerTool(app.viewInstanceId, spec(), async () => ({ success: true }));
        core.registerTool(workspace.viewInstanceId, {
            name: 'lsp_hover', description: 'Workspace inspection',
            inputSchema: { type: 'object' }, isMutating: false,
        }, async () => ({ success: true }));
        const tools = core.listTools();
        expect(tools).toHaveLength(2);
        expect(tools.map(x => x.viewType)).toEqual(['FileDetail', 'Workspace']);
    });

    it('rejects duplicate registration by same View without replacing its original Handler', async () => {
        const { core, app } = files();
        const old = vi.fn(async () => ({ success: true, data: { first: true } }));
        core.registerTool(app.viewInstanceId, spec(), old);
        expect(() => core.registerTool(app.viewInstanceId, spec(),
            async () => ({ success: false }))).toThrowError(mustBeError('TOOL_DUPLICATE'));
        const observation = oneTool(core);
        expect(await core.invoke(observation, observation.targets[0], {}))
            .toMatchObject({ success: true, data: { first: true } });
        expect(old).toHaveBeenCalledTimes(1);
    });

    it('old release closures cannot affect a new View mount with the same visible viewId', async () => {
        const { core, app } = files();
        const staleDispose = core.registerTool(app.viewInstanceId, spec(),
            async () => ({ success: true }));
        core.unmount(app.viewInstanceId);
        const replacement = core.mount('fd_0', 'FileDetail');
        core.registerTool(replacement.viewInstanceId, spec(),
            async () => ({ success: true, data: { newView: true } }));
        staleDispose();
        const now = oneTool(core);
        expect(now.targets.map(t => t.viewInstanceId)).toContain(replacement.viewInstanceId);
        expect(await core.invoke(now, now.targets[0], {}))
            .toMatchObject({ success: true, data: { newView: true } });
        expect(() => core.registerTool(app.viewInstanceId, spec(),
            async () => ({ success: true }))).toThrowError(mustBeError('VIEW_INSTANCE_REVOKED'));
        expect(() => core.setEnabled(app.viewInstanceId, 'lsp_hover', false))
            .toThrowError(mustBeError('VIEW_INSTANCE_REVOKED'));
    });
});

describe('M4-preflight: verified source target and real ToolResult', () => {
    it('preserves the exact business failure instead of wrapping it as success', async () => {
        const { core, app } = files();
        const businessError = { success: false, error: { code: 'LSP_ERROR', message: 'Server not ready' } };
        const handler = vi.fn(async () => businessError);
        core.registerTool(app.viewInstanceId, spec(), handler);
        const offered = oneTool(core);
        const actual = await core.invoke(offered, offered.targets[0], {});
        expect(actual).toBe(businessError);
        expect(actual.success).toBe(false);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('catches an exception without claiming success; refuses malformed Handler results', async () => {
        const { core, app } = files();
        const dispose = core.registerTool(app.viewInstanceId, spec(), async () => {
            throw new Error('LSP crashed');
        });
        let source = oneTool(core);
        const thrown = await core.invoke(source, source.targets[0], {});
        expect(thrown).toMatchObject({
            success: false, error: { code: 'TOOL_HANDLER_EXCEPTION', message: 'LSP crashed' },
        });
        dispose();
        core.registerTool(app.viewInstanceId, spec(), async () => ({} as any));
        source = oneTool(core);
        expect(await core.invoke(source, source.targets[0], {}))
            .toMatchObject({ success: false, error: { code: 'TOOL_RESULT_INVALID' } });
    });

    it('requires the observed Tool to include the exact target and correct Tool identity', async () => {
        const { core, app, pkg } = files();
        const called = vi.fn(async () => ({ success: true }));
        core.registerTool(app.viewInstanceId, spec(), called);
        const source = oneTool(core);
        const tamperedTarget = { ...source.targets[0], viewInstanceId: pkg.viewInstanceId };
        expect((await core.invoke(source, tamperedTarget, {})).error?.code).toBe('TOOL_SOURCE_CONFLICT');
        expect((await core.invoke({ ...source, id: 'wrong' }, source.targets[0], {})).error?.code)
            .toBe('TOOL_SOURCE_CONFLICT');
        expect((await core.invoke(source, source.targets[0], null as any)).error?.code)
            .toBe('TOOL_INVALID_ARGS');
        expect(called).not.toHaveBeenCalled();
    });

    it('previous observation cannot invoke a new registration in the same still-mounted View', async () => {
        const { core, app } = files();
        const release = core.registerTool(app.viewInstanceId, spec(),
            async () => ({ success: true, data: { old: true } }));
        const observed = oneTool(core);
        release();
        const newHandler = vi.fn(async () => ({ success: true, data: { new: true } }));
        core.registerTool(app.viewInstanceId, spec(), newHandler);
        expect((await core.invoke(observed, observed.targets[0], {})).error?.code)
            .toBe('TOOL_SOURCE_STALE');
        expect(newHandler).not.toHaveBeenCalled();
        const newView = oneTool(core);
        expect((await core.invoke(newView, newView.targets[0], {})).success).toBe(true);
    });

    it('does not leak a handler into public descriptions and detaches schemas from developer objects', () => {
        const { core, app } = files();
        const input = { type: 'object', properties: { line: { type: 'number' } } };
        core.registerTool(app.viewInstanceId, { ...spec(), inputSchema: input },
            async () => ({ success: true }));
        input.properties.line.type = 'boolean'; // developers retain mutable source
        const result = oneTool(core);
        expect(result.inputSchema).toMatchObject({ properties: { line: { type: 'number' } } });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.targets)).toBe(true);
        expect(Object.isFrozen(result.inputSchema)).toBe(true);
        expect(JSON.stringify(result)).not.toContain('handler');
        expect('handler' in result).toBe(false);
    });

    it('rejects invalid schema and non-JSON values before exposing anything', () => {
        const { core, app } = files();
        expect(() => core.registerTool(app.viewInstanceId, {
            ...spec(), inputSchema: { type: 'string' },
        }, async () => ({ success: true }))).toThrowError(mustBeError('TOOL_INVALID'));
        const circular: any = { type: 'object' };
        circular.self = circular;
        expect(() => core.registerTool(app.viewInstanceId, {
            ...spec(), inputSchema: circular,
        }, async () => ({ success: true }))).toThrow();
        expect(core.listTools()).toHaveLength(0);
    });

    it('in-flight execution may finish after unmount, but can never reroute to a new View', async () => {
        const { core, app } = files();
        let complete!: (result: { success: boolean }) => void;
        const slow = vi.fn(() => new Promise<{ success: boolean }>(resolve => { complete = resolve; }));
        core.registerTool(app.viewInstanceId, spec(), slow);
        const old = oneTool(core);
        const running = core.invoke(old, old.targets[0], {});
        core.unmount(app.viewInstanceId);
        const replacement = core.mount('fd_0', 'FileDetail');
        const newHandler = vi.fn(async () => ({ success: true }));
        core.registerTool(replacement.viewInstanceId, spec(), newHandler);
        complete({ success: true });
        expect((await running).success).toBe(true);
        expect(slow).toHaveBeenCalledTimes(1);
        expect(newHandler).not.toHaveBeenCalled();
        expect((await core.invoke(old, old.targets[0], {})).error?.code).toBe('VIEW_INSTANCE_REVOKED');
    });
});


describe('M4-preflight: defensive registration and bounded aggregation', () => {
    it('does not invoke getters in Tool metadata and rejects extra fields', () => {
        const { core, app } = files();
        let getterCalls = 0;
        const attacker = Object.defineProperty({ ...spec() }, 'description', {
            enumerable: true, get() { getterCalls++; return 'fake'; },
        });
        expect(() => core.registerTool(app.viewInstanceId, attacker,
            async () => ({ success: true }))).toThrowError(/Accessors\/hidden/);
        expect(getterCalls).toBe(0);
        expect(() => core.registerTool(app.viewInstanceId, {
            ...spec(), handler: 'should never be published',
        } as any, async () => ({ success: true }))).toThrowError(mustBeError('TOOL_INVALID'));
        expect(core.listTools()).toHaveLength(0);
    });

    it('aggregates many independently owned FileDetail tools into exactly one public definition', async () => {
        const core = createViewOwnedTools('system_ide', 'runtime-run-2');
        const count = 80;
        const invoked: number[] = [];
        for (let n = 0; n < count; n++) {
            const view = core.mount('fd_' + n, 'FileDetail');
            core.registerTool(view.viewInstanceId, spec(), async () => {
                invoked.push(n);
                return { success: true, data: { n } };
            });
        }
        const observed = oneTool(core);
        expect(observed.targets).toHaveLength(count);
        const target = observed.targets.find(t => t.viewId === 'fd_63')!;
        expect(await core.invoke(observed, target, {})).toMatchObject({
            success: true, data: { n: 63 },
        });
        expect(invoked).toEqual([63]);
        for (let n = 0; n < count; n += 2) {
            core.unmount(observed.targets.find(t => t.viewId === 'fd_' + n)!.viewInstanceId);
        }
        const remaining = oneTool(core);
        expect(remaining.targets).toHaveLength(count / 2);
        expect(remaining.targets.every(target => Number(target.viewId.slice(3)) % 2 === 1)).toBe(true);
        expect((await core.invoke(observed, observed.targets.find(t => t.viewId === 'fd_62')!, {})).error?.code).toBe('VIEW_INSTANCE_REVOKED');
        expect((await core.invoke(observed, observed.targets.find(t => t.viewId === 'fd_63')!, {})).success).toBe(true);
        expect(invoked).toEqual([63, 63]);
    });
});


describe('M4 Stage 6: Worker-side live binding preflight never invokes Handler', () => {
    it('validates exact mutating Tool without running its Handler', () => {
        const { core, app } = files();
        const mutating = { ...spec(), isMutating: true };
        const handler = vi.fn(async () => ({ success: true }));
        core.registerTool(app.viewInstanceId, mutating, handler);
        const source = oneTool(core);
        expect(core.validate(source, source.targets[0])).toMatchObject({ success: true });
        expect(handler).not.toHaveBeenCalled();
    });

    it('revokes a closed View or disabled Tool even when its original observation remains available', () => {
        const { core, app } = files();
        const handler = vi.fn(async () => ({ success: true }));
        core.registerTool(app.viewInstanceId, { ...spec(), isMutating: true }, handler);
        const observed = oneTool(core);
        core.setEnabled(app.viewInstanceId, observed.name, false);
        expect(core.validate(observed, observed.targets[0]))
            .toMatchObject({ success: false, error: { code: 'TOOL_UNAVAILABLE' } });
        core.unmount(app.viewInstanceId);
        expect(core.validate(observed, observed.targets[0]))
            .toMatchObject({ success: false, error: { code: 'VIEW_INSTANCE_REVOKED' } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects stale binding version and forged description without triggering side effects', () => {
        const { core, app } = files();
        const originalHandler = vi.fn(async () => ({ success: true }));
        const release = core.registerTool(app.viewInstanceId, { ...spec(), isMutating: true }, originalHandler);
        const observed = oneTool(core);
        expect(core.validate({
            ...observed, description: 'Injected meaning',
        }, observed.targets[0])).toMatchObject({
            success: false, error: { code: 'TOOL_SOURCE_STALE' },
        });
        release();
        const newHandler = vi.fn(async () => ({ success: true }));
        core.registerTool(app.viewInstanceId, { ...spec(), isMutating: true }, newHandler);
        expect(core.validate(observed, observed.targets[0])).toMatchObject({
            success: false, error: { code: 'TOOL_SOURCE_STALE' },
        });
        expect(originalHandler).not.toHaveBeenCalled();
        expect(newHandler).not.toHaveBeenCalled();
    });
});
