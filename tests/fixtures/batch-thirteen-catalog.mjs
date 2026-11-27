import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { appClient, journal, modelCall } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

export const appName = 'catalog_draft';
export const autoEntry = 'auto_install', manualEntry = 'manual_install', disabledEntry = 'disabled_catalog_install';
export const explicitStorageKey = 'custom_draft_key';
export const draftText = 'One persisted draft';

export function recordCatalogWorkers() {
    const events = [], launched = new WeakSet(), post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === 'INIT') {
            const { threadId } = this;
            events.push({ type: 'init', threadId, appId: message.appId, instanceId: message.appInstanceId, module: message.appModulePath });
            launched.add(this);
            this.once('exit', code => events.push({ type: 'exit', threadId, code }));
        } else if (launched.has(this) && message?.type === 'VIEW_TOOL_INVOKE') {
            events.push({ type: 'invoke', threadId: this.threadId,
                appId: message.appId, instanceId: message.instanceId, name: message.tool.name });
        }
        return post.call(this, message, ...rest);
    };
    return { events, restore() { Worker.prototype.postMessage = post; } };
}

export async function artifactFacts(archive, manifest) {
    const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    return { archiveSha256: await sha(archive), appModuleSha256: await sha(manifest.modulePath), metadata: manifest.metadata };
}

export const appEffects = manifest => journal(dirname(manifest.modulePath), 'catalog-effects');
const pages = body => body.messages.filter(item => item.role === 'user' && item.content.startsWith('<view ')).map(item => item.content);
const toolNames = body => body.tools.map(item => item.function.name);

export function checkPendingRequest(body) {
    assert.deepEqual(pages(body), []);
    assert.ok(toolNames(body).includes('system-open_app'));
    assert.ok(!toolNames(body).some(name => name.startsWith(appName + '-')));
    const text = JSON.stringify(body);
    assert.ok(text.includes(autoEntry) && text.includes(manualEntry));
}

export async function exerciseCatalog(turn, desktop, workerEvents) {
    const viewsAndTools = {}, results = {};
    async function run(label, name, input, beforeReply) {
        const calls = name ? [modelCall(label, name, input)] : [];
        const { body, message } = await turn(label, calls, beforeReply);
        viewsAndTools[label] = { views: pages(body), nativeTools: body.tools.map(item => item.function)
            .filter(tool => tool.name.startsWith(appName)) };
        if (name) {
            assert.ok(toolNames(body).includes(name));
            results[label] = savedParts(message, calls)[0];
            assert.equal(results[label].output.type, 'json', JSON.stringify(results[label]));
            assert.equal(results[label].output.value.success, true, JSON.stringify(results[label]));
        }
        assert.ok(!JSON.stringify(body).includes(disabledEntry), 'Disabled product installation must remain out of the actual request');
        return body;
    }

    const first = await run('manual-open', 'system-open_app', { installation_id: manualEntry });
    assert.ok(JSON.stringify(first).includes(manualEntry));
    assert.deepEqual(viewsAndTools['manual-open'].nativeTools.map(tool => tool.name).sort(), [appName + '-Draft-lookup', appName + '-Draft-save']);
    assert.equal(pages(first).length, 1);
    assert.equal(results['manual-open'].output.value.app_id, appName + '_1');

    const adopt = desktop.adoptTurn;
    let observationId;
    desktop.adoptTurn = function (selection) {
        const result = adopt.call(this, selection);
        if (result.status === 'adopted') {
            observationId = selection.apps.find(({ candidate }) => candidate.observation.source.appId === appName)
                ?.candidate.observation.observationId;
        }
        return result;
    };
    let both;
    try { both = await run('save-one', appName + '-Draft-save', { text: draftText }); }
    finally { desktop.adoptTurn = adopt; }
    assert.ok(observationId, 'The save request adopted the original App observation');
    assert.deepEqual(pages(both).map(page => / app_id="([^"]+)"/.exec(page)?.[1]), [appName, appName + '_1']);
    assert.deepEqual(viewsAndTools['save-one'].nativeTools.map(tool => tool.name).sort(), [
        appName + '-Draft-lookup', appName + '-Draft-save', appName + '_1-Draft-lookup', appName + '_1-Draft-save',
    ]);
    const save = workerEvents.find(event => event.type === 'invoke' && event.name === 'save');
    assert.equal(save?.appId, appName);
    const { client } = appClient(desktop, appName);
    const query = { observationId, invocationId: 'save-one' };
    const original = await client.readReceipt(query);
    assert.equal(original.kind, 'receipt', JSON.stringify(original));
    assert.equal(original.receipt.executionPhase, 'entered-returned');
    assert.equal(original.receipt.outcome.status, 'succeeded');
    assert.equal(original.receipt.invocationId, query.invocationId);
    assert.equal(original.receipt.source.instanceId, save.instanceId);

    const updated = await run('read-isolated', appName + '_1-Draft-lookup', {});
    assert.ok(pages(updated).some(page => page.includes('app_id="' + appName + '"') && page.includes(draftText)));
    assert.ok(pages(updated).some(page => page.includes('app_id="' + appName + '_1"') && page.includes('Draft: empty')));
    const previous = await run('manual-close', 'system-close_app', { app_id: appName + '_1' });
    assert.ok(pages(previous).some(page => page.includes('app_id="' + appName + '_1"') && page.includes('Draft: missing')));
    const last = await run('remaining', undefined, {});
    assert.equal(pages(last).length, 1);
    assert.match(pages(last)[0], /Draft: One persisted draft/);
    assert.deepEqual(viewsAndTools.remaining.nativeTools.map(tool => tool.name).sort(), [appName + '-Draft-lookup', appName + '-Draft-save']);
    return { query, original: original.receipt, viewsAndTools, results };
}
