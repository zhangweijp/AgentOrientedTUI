import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const ORIGINAL = ['beta@example.test', 'alpha@example.test', 'beta@example.test'];
export const CHANGED = ['alpha@example.test', 'beta@example.test'];
export const MAIL_TOOL = 'mail-set_recipients';
export const TO_CONTACTS = { to: '$contacts.list.emails' };

// Some test Apps are compiled as modules in a shared consumer. Give each
// temporary local registration its own manifest without copying the module.
export async function fixtureAppPath(moduleLocation, appName, folder) {
    await mkdir(folder, { recursive: true });
    const localPath = await mkdtemp(join(folder, 'app-manifest-'));
    const modulePath = moduleLocation.startsWith('file:') ? fileURLToPath(moduleLocation) : resolve(moduleLocation);
    await writeFile(join(localPath, 'aoapp.json'), JSON.stringify({
        app_name: appName, version: '0.1.0', entry: { main: modulePath },
        toolAuthoringProtocol: 'view-type-tools-v7', appLifecycleSupport: 'app-lifecycle-v2',
    }));
    return localPath;
}

export async function installFixture(runtime, desktop, appName, installationId, moduleURL, folder, policy) {
    const localPath = await fixtureAppPath(moduleURL, appName, folder);
    await desktop.registerPendingApp({ installationId, localPath, config: { folder } });
    const id = await desktop.openApp(installationId);
    return appClient(runtime, desktop, id, policy);
}

export function appClient(runtime, desktop, appId, policy) {
    const app = desktop.getInstalledApps().find(item => item.appId === appId);
    const access = runtime.getAppInteraction(desktop.id, appId, app?.appInstanceId, policy);
    assert.equal(access.status, 'ready', JSON.stringify(access));
    return { app, client: access.interaction };
}

export async function observe(client, adopt = false) {
    const result = await client.observe({ all: true });
    assert.equal(result.status, 'observed', JSON.stringify(result));
    if (adopt) assert.equal(client.adoptObservation(result.observation.observationId).status, 'adopted');
    return result.observation;
}

export async function watchUntil(check, timeoutMs = 5_000) {
    const end = Date.now() + timeoutMs;
    while (true) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= end) throw new Error('The expected fixture state did not arrive');
        await delay(15);
    }
}

export async function setContacts(folder, emails, options = {}) {
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'contacts.json');
    await writeFile(file + '.next', JSON.stringify({ emails, ...options }));
    await rename(file + '.next', file);
}

export async function journal(folder, name) {
    try { return (await readFile(join(folder, name + '.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function modelCall(id, name, input) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

// Same deterministic HTTP Provider for both consumers. Hosts assemble and route their respective requests.
export async function fixtureProvider() {
    let scripted;
    const requests = [];
    const failures = [];
    const server = createServer(async (request, response) => {
        try {
            assert.equal(request.method, 'POST');
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const encoded = Buffer.concat(chunks);
            const body = JSON.parse(encoded);
            const inputBytes = encoded.byteLength;
            const turn = scripted;
            scripted = undefined;
            assert.equal(request.url, turn?.path ?? '/v1/chat/completions');
            await turn?.beforeReply?.(body);
            if (turn?.errorStatus) {
                const payload = { error: { message: 'Intentional fixture response failure' } };
                requests.push({ label: turn.label, body, inputBytes, response: payload, status: turn.errorStatus });
                response.writeHead(turn.errorStatus, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
                return;
            }
            const sendStream = (frames) => {
                requests.push({ label: turn?.label, path: request.url, body, inputBytes, response: frames });
                response.writeHead(200, { 'content-type': 'text/event-stream' })
                    .end(frames.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n');
            };
            if (turn?.frames) {
                sendStream(turn.frames);
                return;
            }
            const calls = turn?.calls ?? [];
            for (const call of calls) assert.ok(body.tools.some(tool => tool.function.name === call.function.name), call.function.name);
            const message = { role: 'assistant', ...(calls.length ? { tool_calls: calls } : {}),
                ...(turn?.text !== undefined || !calls.length ? { content: turn?.text ?? 'Done.' } : {}) };
            const finish = calls.length ? 'tool_calls' : 'stop';
            if (body.stream) {
                const delta = { ...message, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) };
                const chunk = (delta, finish_reason) => ({ id: 'local-' + requests.length, object: 'chat.completion.chunk',
                    model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason }] });
                const finished = chunk({}, finish);
                const payload = [
                    ...(turn?.reasoning ? [chunk({ reasoning_content: turn.reasoning }, null)] : []),
                    chunk(delta, null), finished,
                    ...(turn && Object.hasOwn(turn, 'usage') ? [{ ...finished, choices: [], usage: turn.usage }] : []),
                ];
                sendStream(payload);
            } else {
                const payload = { choices: [{ message, finish_reason: finish }] };
                requests.push({ label: turn?.label, body, inputBytes, response: payload });
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
            }
        } catch (error) {
            failures.push(String(error));
            response.writeHead(500).end(String(error));
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
        url: 'http://127.0.0.1:' + server.address().port + '/v1',
        requests, failures,
        replyNext(turn) { assert.equal(scripted, undefined); scripted = turn; },
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
