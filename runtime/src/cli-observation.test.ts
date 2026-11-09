import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { Linter, type Rule, type SourceCode } from 'eslint';
import { describe, expect, it, vi } from 'vitest';
import { createScopedInteraction, createSnapshotCore, createViewOwnedTools, refKey } from './core/index.js';
import type { ScopeClient, ScopePolicy } from './core/index.js';

const cli = transformSync(readFileSync(new URL('./cli.ts', import.meta.url), 'utf8'), { loader: 'ts', target: 'es2022' }).code;
const example = readFileSync(new URL('../../demo-apps/aotui-ide/examples/local-scoped-ide.mjs', import.meta.url), 'utf8');
// Extract the actual operations without depending on the removed TypeScript JS compiler API.
function extract(source: string, selector: string, read: (node: Rule.Node, code: SourceCode) => string = (node, code) => code.getText(node)): string {
    const matches: string[] = [];
    const diagnostics = new Linter().verify(source, [{
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        plugins: { fixture: { rules: { extract: { create(context) {
            return { [selector](node: Rule.Node) { matches.push(read(node, context.sourceCode)); } };
        } } } } }, rules: { 'fixture/extract': 'error' },
    }]);
    if (diagnostics.length || matches.length !== 1) throw new Error('Expected one existing CLI/example operation: ' + selector);
    return matches[0];
}
const printCode = extract(cli, 'FunctionDeclaration[id.name="printCurrentViews"]');
const projectCode = extract(example, 'Property[method=true][key.name="project"]', (node, code) => {
    if (node.type !== 'Property' || node.value.type !== 'FunctionExpression') throw new Error('Expected project method');
    return `function(${node.value.params.map(parameter => code.getText(parameter)).join(',')}) ${code.getText(node.value.body)}`;
});
const exampleProject = new Function(`return ${projectCode}`)() as ScopePolicy['project'];
const viewsCase = extract(example, 'SwitchCase[test.value="views"]');
function exampleViews(client: ScopeClient, emit: (value: unknown) => void): () => Promise<unknown> {
    return new Function('client', 'emit', `return async function() { let value; switch ('views') { ${viewsCase} } emit(value); return value; }`)(client, emit);
}

function fixture(project?: ScopePolicy['project']) {
    const core = createSnapshotCore({ now: () => 0 });
    core.lifecycle.startApp('app', 'run');
    const tools = createViewOwnedTools('app', 'run');
    const views = ['first', 'second'].map(id => tools.mount(id, 'Detail'));
    tools.registerTypeTool({ viewType: 'Detail', name: 'edit', description: 'Edit', 
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }),
    });
    tools.registerTypeTool({ viewType: 'Detail', name: 'inspect', description: 'Inspect', 
        inputSchema: { type: 'object', properties: { record: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } } }, required: ['record'], additionalProperties: false },
    }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }) });
    const published = core.committer.accept({ schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: views.map(view => ({ id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: view.viewId,
            kind: 'state', content: { format: 'markdown-v1', value: 'Current content' } })),
        refs: Object.fromEntries(views.map(view => [refKey(view.viewId, view.viewInstanceId, 'data'), {
            id: 'data', ownerViewId: view.viewId, ownerViewInstanceId: view.viewInstanceId, refType: 'unknown', target: { kind: 'snapshot-value', payload: { value: 1 } },
        }])), tools: Object.fromEntries(tools.listTools().map(tool => [tool.id, tool])) });
    expect(published.status).toBe('published');
    const authority = createScopedInteraction(core.store, { namespace: 'print', now: () => 0 });
    const opened = authority.createScope({ appId: 'app', instanceId: 'run', policy: {
        project: project ?? (({ source }) => ({ views: source.views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
            refs: [], toolBindings: [], content: [] })), authorize: () => true, canReadReceipt: () => true,
    }, execution: { resolve: () => null } });
    if (opened.status !== 'opened') throw new Error(opened.issue.code);
    const client = opened.client;
    function released() {
        expect(authority.inspect().observations).toMatchObject({ observations: 0, reservations: 0, sources: 0, totalBytes: 0 });
        expect(core.store.inspect().activeLeases).toBe(0);
    }
    async function close() {
        authority.close(); await authority.whenClosed(); released();
        expect(authority.inspect().combinedBytes).toBe(0); tools.dispose(); core.lifecycle.dispose();
    }
    return { authority, client, released, close };
}

describe('temporary CLI observations', () => {
    it('releases every printed observation beyond the default per-Scope limit', async () => {
        const f = fixture(), output = { log: vi.fn(), error: vi.fn() };
        const print = new Function('clients', 'console', `${printCode}; return printCurrentViews;`)(new Map([['app', f.client]]), output);
        try {
            for (let index = 0; index < 20; index++) { await print(); f.released(); }
            expect(output.error).not.toHaveBeenCalled(); expect(output.log).toHaveBeenCalledTimes(140);
        } finally { await f.close(); }
    });
    it('releases the observation when printing throws', async () => {
        const f = fixture();
        const print = new Function('clients', 'console', `${printCode}; return printCurrentViews;`)(new Map([['app', f.client]]), {
            log() { throw new Error('PRINT_FAILED'); }, error: vi.fn(),
        });
        try { await expect(print()).rejects.toThrow('PRINT_FAILED'); f.released(); }
        finally { await f.close(); }
    });
});

describe('local IDE example observations', () => {
    it('projects V3 type Tools once and all Ref owners using the current grant contract', async () => {
        const f = fixture(exampleProject);
        try {
            const result = await f.client.observe({ all: true });
            expect(result.status).toBe('observed');
            if (result.status !== 'observed') return;
            expect(result.observation).toMatchObject({ views: [{ content: { value: 'Current content' } }, { content: { value: 'Current content' } }] });
            expect(result.observation.tools).toHaveLength(2); expect(result.observation.bindings).toHaveLength(2);
            expect(result.observation.refs).toHaveLength(2);
            f.client.releaseObservation(result.observation.observationId); f.released();
        } finally { await f.close(); }
    });
    it('releases twenty views commands while retaining an explicit invocation observation', async () => {
        const f = fixture(exampleProject), emit = vi.fn(), views = exampleViews(f.client, emit);
        try {
            const retained = await f.client.observe({ all: true });
            expect(retained.status).toBe('observed');
            if (retained.status !== 'observed') return;
            for (let index = 0; index < 20; index++) {
                expect(await views()).toEqual([{ viewId: 'first', viewType: 'Detail', viewName: 'first' }, { viewId: 'second', viewType: 'Detail', viewName: 'second' }]);
                expect(f.authority.inspect().observations.observations).toBe(1);
            }
            expect(emit).toHaveBeenCalledTimes(20);
            f.client.releaseObservation(retained.observation.observationId); f.released();
        } finally { await f.close(); }
    });
    it('releases a views observation even when output throws', async () => {
        const f = fixture(exampleProject), views = exampleViews(f.client, () => { throw new Error('OUTPUT_FAILED'); });
        try { await expect(views()).rejects.toThrow('OUTPUT_FAILED'); f.released(); }
        finally { await f.close(); }
    });
});
