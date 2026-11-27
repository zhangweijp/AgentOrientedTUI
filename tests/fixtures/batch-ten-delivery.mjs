import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { journal, modelCall } from './batch-two-support.mjs';

export const appName = 'delivered_files';
export const installation = 'files_install';
export const appEntry = folder => ({ name: installation, source: 'local:' + folder, enabled: true, autoStart: false });
export const llmConfig = url => ({ provider: { id: 'delivery-fixture', baseURL: url }, model: 'delivery-fixture', apiKey: 'fixture-only',
    inputBudget: () => ({ contextWindow: 160_000, maxOutputTokens: 1_000 }) });

export function recordWorkers() {
    const events = [], post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === 'INIT' && message.appName === appName) {
            const threadId = this.threadId;
            events.push({ type: 'init', threadId, module: message.appModulePath });
            this.once('exit', code => events.push({ type: 'exit', threadId, code }));
        }
        return post.call(this, message, ...rest);
    };
    return { events, restore() { Worker.prototype.postMessage = post; } };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function artifactDetails(archive, installed, runtimeParent) {
    const manifest = JSON.parse(await readFile(join(installed, 'aoapp.json'), 'utf8'));
    assert.equal(manifest.app_name, appName);
    const module = join(installed, manifest.entry.main);
    const sdk = import.meta.resolve('@aotui/sdk', pathToFileURL(module).href);
    const appCore = import.meta.resolve('@aotui/core', sdk);
    const runtimeCore = import.meta.resolve('@aotui/core', runtimeParent);
    assert.notEqual(appCore, runtimeCore, 'a separately installed author Core');
    assert.equal(sha256(await readFile(new URL(appCore))), sha256(await readFile(new URL(runtimeCore))));
    return { archive, installed, packageHash: sha256(await readFile(archive)), moduleHash: sha256(await readFile(module)),
        manifest, sdk, appCore, runtimeCore };
}

export async function setupFiles(folder) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'A.txt'), 'Original A');
    await writeFile(join(folder, 'B.txt'), 'Original B');
}

export function savedParts(message, calls) {
    const results = (message?.content ?? []).filter(part => part.type === 'tool-result');
    assert.deepEqual(results.map(part => part.toolCallId), calls.map(call => call.id));
    return results;
}

export async function exerciseDelivery(turn, folder) {
    const requests = {}, results = {};
    const native = (id, name, input = {}) => modelCall(id, `${appName}-${name === "edit" || name === "close" ? "file" : "directory"}-${name}`, input);
    const pages = request => request.messages.filter(message => message.role === 'user' && message.content.startsWith('<view ')).map(message => message.content);
    const editTool = request => request.tools.filter(tool => tool.function.name === `${appName}-file-edit`);
    const run = async (label, calls, beforeReply) => {
        const { body, message } = await turn(label, calls, beforeReply);
        requests[label] = { pages: pages(body), tools: body.tools.map(tool => tool.function) };
        if (calls.length) results[label] = savedParts(message, calls);
        return body;
    };

    const pending = await run('launch', [modelCall('launch', 'system-open_app', { installation_id: installation })]);
    assert.deepEqual(pages(pending), []);
    const directory = await run('open-a', [native('open-a', 'open_file', { name: 'A.txt' })]);
    assert.equal(editTool(directory).length, 0);
    const one = await run('open-b', [native('open-b', 'open_file', { name: 'B.txt' })]);
    assert.equal(editTool(one).length, 1);
    const two = await run('copy-original', [native('reload-a', 'reload_a'),
        native('write-b', 'edit', { view_id: 'doc_2', text: `$ref.${appName}.doc_1.content` })],
    () => writeFile(join(folder, 'A.txt'), 'Ref changed after sending'));
    assert.deepEqual(pages(two).map(page => /^<view view_id="([^"]+)/.exec(page)?.[1]).sort(), ['directory', 'doc_1', 'doc_2']);
    assert.match(pages(two).find(page => page.startsWith('<view view_id="doc_1"')), /Original A/);
    assert.equal(editTool(two).length, 1);
    assert.deepEqual([...editTool(two)[0].function.parameters.required].sort(), ['text', 'view_id']);
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'Original A');
    assert.ok(results['copy-original'].every(result => result.output.type === 'json'));

    const reloaded = await run('revoke', [native('disable-a', 'disable_a'),
        native('reject-a', 'edit', { view_id: 'doc_1', text: 'Forbidden repeat' }),
        native('reject-ref', 'edit', { view_id: 'doc_2', text: `$ref.${appName}.doc_1.content` })]);
    assert.match(pages(reloaded).find(page => page.startsWith('<view view_id="doc_1"')), /Ref changed after sending/);
    const denied = results.revoke[1].output;
    assert.equal(denied.type, 'error-json');
    assert.equal(denied.value.code, 'TOOL_SOURCE_STALE');
    const deniedRef = results.revoke[2].output;
    assert.equal(deniedRef.type, 'error-json');
    assert.equal(deniedRef.value.code, 'REF_NOT_VISIBLE');

    await run('console', [modelCall('console', 'run_code', {
        code: `const found = await tools['${appName}-file-inspect_text']({ view_id: 'doc_2', text: refs.${appName}.doc_2.content }); inspect(found.text);`,
    })]);
    const output = results.console[0].output;
    assert.equal(output.type, 'json', JSON.stringify(output));
    assert.deepEqual(output.value.output, ['Original A']);
    assert.deepEqual(output.value.subcalls.map(item => [item.toolName, item.status, item.phase]),
        [[`${appName}-file-inspect_text`, 'succeeded', 'entered-returned']]);

    await run('close-app', [modelCall('close', 'system-close_app', { app_id: appName })]);
    assert.deepEqual(results['close-app'][0].output, { type: 'json', value: { success: true, app_id: appName } });
    const closed = await run('after-close', []);
    assert.deepEqual(pages(closed), []);
    assert.equal(editTool(closed).length, 0);
    const writes = await journal(folder, 'writes');
    assert.equal(writes.length, 1);
    assert.ok(writes[0].threadId > 0, 'written in the actual App Worker');
    assert.deepEqual({ name: writes[0].name, text: writes[0].text }, { name: 'B.txt', text: 'Original A' });
    assert.equal(await readFile(join(folder, 'A.txt'), 'utf8'), 'Ref changed after sending');
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'Original A');
    return { requests, results, writes };
}
