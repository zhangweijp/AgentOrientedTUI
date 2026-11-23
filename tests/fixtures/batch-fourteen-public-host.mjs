import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource, createNodeConsoleExecutor } from '@aotui/agent-driver-adapter';
import { createRuntime, readAppManifest } from '@aotui/runtime';
import { appClient, fixtureProvider, watchUntil } from './batch-two-support.mjs';
import { captureAdmission, exerciseCinema, exerciseStrict, healthyLog, original, publishSeat } from './batch-fourteen-schema.mjs';
import { exerciseEmptyConsole, exercisePolicyWindows, exerciseStationBudget, setPolicyScenario } from './batch-fourteen-provider-repair.mjs';

const [cinema, healthy, theatre, evidence] = process.argv.slice(2);
process.env.AOTUI_DATA_DIR = join(dirname(evidence), 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const cinemaManifest = await readAppManifest(cinema);
const healthyManifest = await readAppManifest(healthy);
const theatreManifest = await readAppManifest(theatre);
const provider = await fixtureProvider();
const runtime = createRuntime();
const captured = captureAdmission(runtime);
const facts = { wire: provider.requests, adoptions: captured.events, workers: captured.workers, receipts: captured.receipts, passed: false };

function responsesFrames(calls) {
    const frames = calls.flatMap((call, output_index) => {
        const item = { id: 'fn_' + call.id, type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments };
        return [{ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments },
            { type: 'response.output_item.done', output_index, item: { ...item, status: 'completed' } }];
    });
    const message = { type: 'message', id: 'answer' };
    if (!frames.length) frames.push({ type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_text.delta', item_id: message.id, delta: 'Done.' },
        { type: 'response.output_item.done', output_index: 0, item: message });
    frames.push({ type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 10, output_tokens: 2 } } });
    return frames;
}

async function runMode(id, mode, exercise, { scenario = 'cinema', responses = false, oneShot = false } = {}) {
    if (scenario === 'cinema') await publishSeat(cinemaManifest, original);
    else if (scenario !== 'empty') await setPolicyScenario(theatreManifest, scenario);
    const desktop = runtime.getDesktop(await runtime.createDesktop(id));
    captured.attach(desktop);
    const apps = scenario === 'empty' ? [] : [scenario === 'cinema' ? ['cinema_install', cinema] : ['theatre_install', theatre], ['healthy_install', healthy]];
    for (const [installationId, localPath] of apps) {
        await desktop.registerPendingApp({ installationId, localPath });
        await desktop.openApp(installationId);
    }
    const beta = id === 'deepseek';
    const providerId = beta ? id : 'openai';
    const url = beta ? provider.url.replace(/\/v1$/, '/beta') : responses ? 'https://api.openai.com/v1' : provider.url;
    const source = new SemanticAOTUIDrivenSource(desktop, runtime, oneShot ? { consoleExecutor: createNodeConsoleExecutor() } : {});
    if (scenario === 'empty') source.setAppsEnabled(false);
    const history = [], delivered = [], errors = [];
    const limits = { contextWindow: 120_000, maxOutputTokens: 1_000, ...(mode === 'blocked' ? { capabilities: { toolCall: false } } : {}) };
    const driver = new AgentDriverV2({ sources: [source, { name: 'History', onUpdate: () => () => {},
        async getContext() { return { messages: history.slice(), tools: {} }; } }],
        llm: { model: 'cinema-fixture', apiKey: 'fixture', provider: { id: providerId, baseURL: url,
            ...(mode === 'strict' ? { toolSchemaMode: 'strict' } : {}) }, inputBudget: () => limits },
        onAssistantMessage(message) {
            history.push({ ...message, timestamp: history.length + 1, region: 'session' });
            if (typeof message.content === 'string') driver.pause();
        },
        onToolResult(message) {
            history.push({ ...message, timestamp: history.length + 1, region: 'session' });
            delivered.push(message); driver.pause();
        },
        onRunError(error) { errors.push({ code: error.code, message: error.message, details: error.details }); driver.pause(); },
    });
    driver.pause();
    const send = globalThis.fetch;
    if (responses) globalThis.fetch = (target, init) => {
        assert.equal(String(target), 'https://api.openai.com/v1/responses');
        return send(provider.url + '/responses', init);
    };
    const turn = async (label, calls, beforeReply, errorStatus) => {
        const count = delivered.length;
        const first = provider.requests.length;
        provider.replyNext({ label, calls, beforeReply, errorStatus, ...(beta ? { path: '/beta/chat/completions' } : {}),
            ...(responses ? { path: '/v1/responses', frames: responsesFrames(calls) } : {}) });
        history.push({ role: 'user', content: label, timestamp: history.length + 1, region: 'session' });
        driver.resume(); await driver.trigger();
        const request = await watchUntil(() => provider.requests.slice(first).find(item => item.label === label));
        const message = calls.length ? await watchUntil(() => delivered[count]) : undefined;
        await watchUntil(() => driver.getState() === 'idle');
        driver.pause();
        return { body: request.body, message, errors };
    };
    try {
        if (mode !== 'blocked') return await exercise(turn, desktop);
        const before = [provider.requests.length, captured.events.length, captured.workers.length, (await healthyLog(healthyManifest)).length];
        history.push({ role: 'user', content: 'Require management tools', timestamp: 1, region: 'session' });
        driver.resume(); await driver.trigger();
        await watchUntil(() => errors[0]);
        assert.deepEqual([provider.requests.length, captured.events.length, captured.workers.length, (await healthyLog(healthyManifest)).length], before);
        assert.equal(errors[0].code, 'MODEL_TOOL_SCHEMA_UNSUPPORTED');
        return { error: errors[0], sends: 0, adoptions: 0, dispatches: 0 };
    } finally {
        if (responses) globalThis.fetch = send;
        driver.stop();
        await driver.closeToolTurn();
        await source.dispose();
        driver.dispose();
        assert.equal((await desktop.beginClose().completion).resourcesReleased, true);
    }
}

try {
    facts.native = await runMode('native', 'ordinary', (turn, desktop) => exerciseCinema(turn, cinemaManifest,
        appClient(runtime, desktop, 'cinema').client, captured));
    facts.openai = await runMode('openai', 'strict', turn => exerciseStrict(turn, 'strict-openai', healthyManifest, captured));
    facts.deepseek = await runMode('deepseek', 'strict', async turn => {
        const result = await exerciseStrict(turn, 'strict-deepseek', healthyManifest, captured, false);
        const start = provider.requests.length;
        const { errors } = await turn('provider-refusal', [], undefined, 400);
        assert.equal(provider.requests.length - start, 1);
        assert.ok(errors.some(error => error.message === 'Intentional fixture response failure'));
        return { ...result, providerRefusal: errors.at(-1) };
    });
    facts.blocked = await runMode('blocked', 'blocked');
    const repair = facts.repair = {};
    for (const scenario of ['window', 'twins', 'at', 'over', 'split-over', 'empty']) {
        repair[scenario] = await runMode('provider_' + scenario, 'strict', (turn, desktop) => {
            if (scenario === 'window' || scenario === 'twins') return exercisePolicyWindows(turn, desktop, captured, theatreManifest, scenario === 'twins');
            if (scenario === 'empty') return exerciseEmptyConsole(turn);
            return exerciseStationBudget(turn, scenario, theatreManifest, healthyManifest, captured);
        }, { scenario });
    }
    repair.ordinary = await runMode('provider_ordinary', 'ordinary', turn =>
        exerciseStationBudget(turn, 'over', theatreManifest, healthyManifest, captured, false), { scenario: 'over' });
    repair.responses = await runMode('provider_responses', 'strict', turn => exerciseEmptyConsole(turn), { scenario: 'empty', responses: true });
    repair.oneShot = await runMode('provider_one_shot', 'strict', turn => exerciseEmptyConsole(turn, false), { scenario: 'empty', oneShot: true });
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    facts.shutdown = await runtime.beginShutdown().completion;
    captured.restore();
    await provider.close();
    await writeFile(evidence, JSON.stringify(facts, null, 2));
}
