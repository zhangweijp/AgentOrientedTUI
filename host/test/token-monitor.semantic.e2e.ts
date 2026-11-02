/** Real Token Monitor app + default Runtime/Node Worker; all usage is local and deterministic. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const childMarker = 'AOTUI_TOKEN_MONITOR_E2E_CHILD';
const preloadPathVariable = 'AOTUI_TOKEN_MONITOR_E2E_PRELOAD';
const modelCatalog = {
    'aotui-local-fixture': {
        models: { 'token-monitor-test-model': { limit: { context: 1000 } } },
    },
};

// Node Workers inherit startup CLI flags, not runtime edits to process.execArgv.
// Relaunch this test with a temporary fail-closed fetch preload so the real
// Worker can resolve the local model catalog without reaching the network.
if (process.env[childMarker] !== '1') {
    const preloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-token-monitor-preload-'));
    const preloadFile = path.join(preloadDir, 'models-dev-preload.mjs');
    const preloadUrl = pathToFileURL(preloadFile).href;
    await fs.writeFile(preloadFile, `
const catalog = ${JSON.stringify(modelCatalog)};
globalThis.__aotuiTokenMonitorFixtureLoaded = true;
globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://models.dev/api.json') throw new Error('TOKEN_MONITOR_E2E_NETWORK_BLOCKED');
    return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
    let childStatus = 1;
    try {
        const child = spawnSync(process.execPath, [
            ...process.execArgv,
            '--import', preloadUrl,
            fileURLToPath(import.meta.url),
        ], {
            env: {
                ...process.env,
                [childMarker]: '1',
                [preloadPathVariable]: preloadUrl,
            },
            stdio: 'inherit',
        });
        if (child.error) throw child.error;
        childStatus = child.status ?? 1;
    } finally {
        await fs.rm(preloadDir, { recursive: true, force: true });
    }
    process.exit(childStatus);
}

const preloadUrl = process.env[preloadPathVariable];
assert.ok(preloadUrl, 'The test child starts with its local model-catalog preload');
assert.ok(process.execArgv.some((arg, index) => arg === '--import' && process.execArgv[index + 1] === preloadUrl),
    'The fail-closed model-catalog preload is a Worker-inherited startup flag');
assert.equal((globalThis as any).__aotuiTokenMonitorFixtureLoaded, true,
    'The test process loaded the same local model-catalog fixture used by Workers');
const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-token-monitor-semantic-')));
const envNames = ['AOTUI_DATA_DIR', 'AOTUI_HOST_SEMANTIC_DEV', 'AOTUI_HOST_SEMANTIC_PROJECT', 'AOTUI_HOST_SEMANTIC_DATA'] as const;
const originalEnv = new Map(envNames.map(name => [name, process.env[name]]));
const activeContexts = new Set<any>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type LLMOutputDesktop = {
    readonly id: string;
    getInstalledApps(): readonly { appId: string; name?: string; status: string }[];
    closeApp(appId: string): Promise<void>;
    /** Same Desktop extension used by Host's SessionManager LLM-output bridge. */
    broadcastLLMOutput(payload: { content?: string; reasoning?: string }, type: 'complete', meta?: {
        model?: string;
        providerId?: string;
        modelId?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }): void;
};

function messageText(message: any): string {
    if (typeof message.content === 'string') return message.content;
    return Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        : String(message.content ?? '');
}
function contextText(context: any): string { return context.messages.map(messageText).join('\n'); }
function monitorViews(context: any): string[] {
    return context.messages.map(messageText).filter((text: string) => text.startsWith('<view id="monitor"'));
}
function release(context: any): void {
    context.release?.();
    activeContexts.delete(context);
}

async function eventuallyContext(source: any, check: (context: any) => boolean, label: string): Promise<any> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const context = await source.getContext();
        activeContexts.add(context);
        if (check(context)) return context;
        release(context);
        await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

let runtime: any;
let source: any;
let desktop: LLMOutputDesktop | undefined;
let shutdown: Promise<any> | undefined;

try {
    const dataDir = path.join(work, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    process.env.AOTUI_DATA_DIR = dataDir;
    delete process.env.AOTUI_HOST_SEMANTIC_DEV;
    delete process.env.AOTUI_HOST_SEMANTIC_PROJECT;
    delete process.env.AOTUI_HOST_SEMANTIC_DATA;

    // Token Monitor looks up a model limit when usage identifies a model. Load
    // this Worker-only fetch fixture before the default Runtime creates workers;
    // every other URL fails closed so the test cannot reach the network.
    const { createRuntime, AppRegistry } = await import('@aotui/runtime');
    const { SemanticAOTUIDrivenSource } = await import('@aotui/runtime/adapters');
    const { DesktopManager } = await import('../src/core/desktop-manager.js');
    runtime = createRuntime();
    const registry = new AppRegistry({ configPath: path.join(work, 'registry.json') });
    const manager = new DesktopManager({ kernel: runtime, appRegistry: registry });
    await manager.initialize({ appEntries: [
        { name: 'token_monitor', source: `local:${path.join(repo, 'demo-apps/token-monitor-app')}`, enabled: true, autoStart: true },
    ] });

    const info = await manager.createDesktop();
    desktop = manager.getDesktop(info.desktopId) as LLMOutputDesktop;
    assert.ok(desktop, 'Host installed the app on a real Runtime Desktop');
    assert.equal(info.thirdPartyAppCount, 1);
    const app = desktop.getInstalledApps().find(candidate => candidate.name === 'token_monitor');
    assert.ok(app, 'Token Monitor is installed');
    assert.equal(app.status, 'running');

    source = new SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: true });
    const initial = await eventuallyContext(source,
        context => contextText(context).includes('Token Monitor - Application Instruction'), 'Token Monitor root View');
    try {
        assert.equal(monitorViews(initial).length, 0, 'The warning View is hidden before usage crosses the threshold');
    } finally { release(initial); }

    // Host's normal bridge sends this through Desktop -> AppManager -> WorkerHost -> Worker Runtime -> SDK hook.
    desktop.broadcastLLMOutput({ content: 'local usage fixture' }, 'complete', {
        model: 'Token Monitor local fixture',
        providerId: 'aotui-local-fixture',
        modelId: 'token-monitor-test-model',
        usage: { promptTokens: 750, completionTokens: 0, totalTokens: 750 },
    });
    const threshold = await eventuallyContext(source, context => {
        const [view] = monitorViews(context);
        return !!view && view.includes('750') && view.includes('75%') && view.includes('Warning: usage is above the threshold');
    }, 'the usage View at the configured 75% warning threshold');
    try {
        const [warningView] = monitorViews(threshold);
        assert.equal(monitorViews(threshold).length, 1, 'One current Monitor View is projected');
        assert.ok(warningView!.includes('Warn threshold: 75 %'));
        for (const metadata of [
            'Token Monitor local fixture',
            'aotui-local-fixture',
            'token-monitor-test-model',
            '750 | 0 | 750 | 75%',
        ]) {
            assert.ok(warningView!.includes(metadata), `The View receives usage metadata: ${metadata}`);
        }
    } finally { release(threshold); }

    desktop.broadcastLLMOutput({ content: 'updated local usage fixture' }, 'complete', {
        model: 'Token Monitor local fixture',
        providerId: 'aotui-local-fixture',
        modelId: 'token-monitor-test-model',
        usage: { promptTokens: 900, completionTokens: 0, totalTokens: 900 },
    });
    const latest = await eventuallyContext(source, context => {
        const [view] = monitorViews(context);
        return !!view && view.includes('900') && view.includes('90%');
    }, 'the updated latest usage View');
    try {
        const views = monitorViews(latest);
        assert.equal(views.length, 1, 'Only one current Monitor View is exposed');
        assert.ok(!views[0]!.includes('| 750 |'), 'The previous usage snapshot is not retained as current state');
        assert.equal((contextText(latest).match(/<view id="monitor"/g) ?? []).length, 1);
    } finally { release(latest); }

    await desktop.closeApp(app.appId);
    assert.equal(desktop.getInstalledApps().find(candidate => candidate.appId === app.appId)?.status, 'closed',
        'Closing Token Monitor completes its real Worker unmount and app cleanup');
    desktop.broadcastLLMOutput({ content: 'post-close usage fixture' }, 'complete', {
        model: 'Token Monitor local fixture', providerId: 'aotui-local-fixture', modelId: 'token-monitor-test-model',
        usage: { promptTokens: 950, completionTokens: 0, totalTokens: 950 },
    });
    const closed = await eventuallyContext(source, context => monitorViews(context).length === 0, 'no Monitor View after app close');
    release(closed);

    for (const context of activeContexts) release(context);
    await source.dispose();
    source = undefined;
    assert.equal(await manager.deleteDesktop(info.desktopId), true,
        'Managed Desktop shutdown completes its LLM output channel cleanup');
    shutdown = runtime.beginShutdown().completion;
    const report = await shutdown;
    assert.equal(report.state, 'settled');
    assert.equal(report.resourcesReleased, true, 'Managed Runtime shutdown releases its resources');
    assert.equal(report.pool.report?.state, 'closed');
    assert.equal(report.pool.report?.total, 0, 'No physical Worker remains after Runtime shutdown');
    assert.equal(report.pool.report?.leased, 0);
    console.log(JSON.stringify({ passed: true, app: 'token_monitor', usageUpdates: 2, latestTokens: 900,
        warningThresholdPercent: 75, workerPool: report.pool.report }));
} finally {
    for (const context of activeContexts) release(context);
    try { await source?.dispose(); } catch { /* Continue to managed Worker shutdown. */ }
    try {
        if (runtime) await (shutdown ?? runtime.beginShutdown().completion);
    } catch { /* Preserve the test failure while still restoring its temporary state. */ }
    for (const name of envNames) {
        const value = originalEnv.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await fs.rm(work, { recursive: true, force: true });
}
