import { createAppInteraction, createSnapshotCore, projectCompleteViews } from '@aotui/core/host';
import { createViewOwnedTools } from '@aotui/core/producer';
import { buildViewMessageMarkup } from './adapters/view-message.js';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { Linter, type Rule, type SourceCode } from 'eslint';
import { describe, expect, it, vi } from 'vitest';
import { refKey } from '@aotui/core';
import type { AppInteraction, AppInteractionPolicy } from '@aotui/core';

const cli = transformSync(readFileSync(new URL('../../host/src/app-distribution/cli.ts', import.meta.url), 'utf8'), { loader: 'ts', target: 'es2022' }).code;
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
const viewsCase = extract(example, 'SwitchCase[test.value="views"]');
function exampleViews(client: AppInteraction, emit: (value: unknown) => void): () => Promise<unknown> {
    return new Function('client', 'emit', `return async function() { let value; switch ('views') { ${viewsCase} } emit(value); return value; }`)(client, emit);
}

function fixture(project?: AppInteractionPolicy['project']) {
    const core = createSnapshotCore({ appId: 'app', instanceId: 'run', now: () => 0 });
    const tools = createViewOwnedTools('app', 'run');
    tools.defineViewTypes([{ name: "Detail", multiplicity: 'multiple', tools: [{ name: 'edit', description: 'Edit', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, { name: 'inspect', description: 'Inspect', inputSchema: { type: 'object', properties: {
            record: { 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } },
        }, required: ['record'], additionalProperties: false } }] }]);
    const frame = tools.prepareFrame(['first', 'second'].map(id => ({
        idPrefix: id, type: 'Detail', owner: {}, bindings: ['edit', 'inspect'].map(name => ({ name, enabled: true, execute: () => ({ success: true }) })),
    })));
    frame.accept();
    const views = frame.instances;
    const published = core.committer.accept({ schemaVersion: 8, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: views.map(view => ({ toolBindings: view.toolBindings, id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: view.viewId,
            region: 'dynamic', content: { format: 'markdown-v1', value: 'Current content' } })),
        refs: Object.fromEntries(views.map(view => [refKey(view.viewId, view.viewInstanceId, 'data'), { valueSchema: { type: 'object' }, scope: 'protected',
            id: 'data', ownerViewId: view.viewId, ownerViewInstanceId: view.viewInstanceId, refType: 'unknown', target: { kind: 'snapshot-value', payload: { value: 1 } },
        }])), tools: Object.fromEntries(frame.tools.map(tool => [tool.id, tool])) });
    expect(published.status).toBe('published');
    const client = createAppInteraction(core.store, { namespace: 'print', now: () => 0, appId: 'app', instanceId: 'run',
        policy: { project: project ?? projectCompleteViews, authorize: () => true, canReadReceipt: () => true },
        execution: { resolve: () => null } });
    const authority = client;
    function released() {
        expect(authority.inspect().observations).toMatchObject({ observations: 0, reservations: 0, });
        expect(core.store.inspect().activeHolds).toBe(0);
    }
    async function close() {
        authority.close(); await authority.whenClosed(); released();
        expect(core.store.inspect().activeHolds).toBe(0); tools.dispose(); core.lifecycle.dispose();
    }
    return { authority, client, released, close };
}

function printer(client: AppInteraction, output: Pick<Console, 'log' | 'error'>) {
    const desktop = { listApps: () => [{ appId: 'app', appInstanceId: 'run', status: 'running' }],
        getRunningApp: () => ({ status: 'ready', app: client }) };
    return new Function('desktop', 'buildViewMessageMarkup', 'console', `${printCode}; return printCurrentViews;`)(
        desktop, buildViewMessageMarkup, output);
}

describe('read-only CLI preview', () => {
    it('prints repeated previews without allocating observations', async () => {
        const f = fixture(), output = { log: vi.fn(), error: vi.fn() };
        const print = printer(f.client, output);
        try {
            for (let index = 0; index < 20; index++) { await print(); f.released(); }
            expect(output.error).not.toHaveBeenCalled(); expect(output.log).toHaveBeenCalledTimes(60);
        } finally { await f.close(); }
    });
    it('releases the observation when printing throws', async () => {
        const f = fixture();
        const print = printer(f.client, {
            log() { throw new Error('PRINT_FAILED'); }, error: vi.fn(),
        });
        try { await expect(print()).rejects.toThrow('PRINT_FAILED'); f.released(); }
        finally { await f.close(); }
    });
});

describe('local IDE example observations', () => {
    it('projects shared Tools once and all Ref owners using the current grant contract', async () => {
        const f = fixture();
        try {
            const result = await f.client.observe();
            expect(result.status).toBe('observed');
            if (result.status !== 'observed') return;
            expect(result.observation).toMatchObject({ views: [{ content: { value: 'Current content' } }, { content: { value: 'Current content' } }] });
            expect(result.observation.tools).toHaveLength(2);
            expect(result.observation.refs).toHaveLength(2);
            f.client.releaseObservation(result.observation.observationId); f.released();
        } finally { await f.close(); }
    });
    it('releases twenty views commands while retaining an explicit invocation observation', async () => {
        const f = fixture(), emit = vi.fn(), views = exampleViews(f.client, emit);
        try {
            const retained = await f.client.observe();
            expect(retained.status).toBe('observed');
            if (retained.status !== 'observed') return;
            for (let index = 0; index < 20; index++) {
                expect(await views()).toEqual([{ viewId: 'first_1', viewType: 'Detail', viewName: 'first_1' }, { viewId: 'second_1', viewType: 'Detail', viewName: 'second_1' }]);
                expect(f.authority.inspect().observations.observations).toBe(1);
            }
            expect(emit).toHaveBeenCalledTimes(20);
            f.client.releaseObservation(retained.observation.observationId); f.released();
        } finally { await f.close(); }
    });
    it('releases a views observation even when output throws', async () => {
        const f = fixture(), views = exampleViews(f.client, () => { throw new Error('OUTPUT_FAILED'); });
        try { await expect(views()).rejects.toThrow('OUTPUT_FAILED'); f.released(); }
        finally { await f.close(); }
    });
});
