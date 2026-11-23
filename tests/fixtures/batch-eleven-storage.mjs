import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { modelCall } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

export const app = 'storage_draft';
export const installation = 'storage-test';
export const catalogEntry = folder => ({ name: installation, source: 'local:' + folder, enabled: true, autoStart: false });

export function trackStorage() {
    const owners = [], post = Worker.prototype.postMessage;
    const byWorker = new WeakMap();
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === 'INIT' && message.appName === app) {
            const owner = { threadId: this.threadId, instanceId: message.appInstanceId, requests: [], replies: [], exited: false };
            owners.push(owner);
            byWorker.set(this, owner);
            this.on('message', event => {
                if (event.type === 'STATE_STORAGE_REQUEST') owner.requests.push(event);
            });
            this.once('exit', code => { owner.exited = true; owner.exitCode = code; });
        } else if (message?.type === 'STATE_STORAGE_RESPONSE') {
            byWorker.get(this)?.replies.push(message);
        }
        return post.call(this, message, ...rest);
    };
    return { owners, restore() { Worker.prototype.postMessage = post; } };
}

export async function exerciseStorage(turn, Database, state, desktopId, owners) {
    const replies = {}, rows = {};
    const requests = () => owners.flatMap(owner => owner.requests)
        .map(event => [event.action, event.address?.key ?? null]);
    const dbPath = join(state, 'app-state/state.sqlite3');
    function snapshot(label) {
        const disk = existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : undefined;
        try {
            const result = disk?.prepare('select namespace, key, record from aotui_state order by namespace, key').all() ?? [];
            rows[label] = result.map(row => ({ namespace: JSON.parse(row.namespace), key: row.key, value: JSON.parse(row.record).value,
                recordVersion: JSON.parse(row.record).version }));
            return Object.fromEntries(rows[label].map(row => {
                assert.deepEqual(row.namespace, [desktopId, installation]);
                assert.equal(row.recordVersion, 1);
                return [row.key, row.value];
            }));
        } finally { disk?.close(); }
    }
    async function run(label, name, input = {}, visible) {
        const calls = name ? [modelCall(label, name, input)] : [];
        const { body, message } = await turn(label, calls);
        if (visible) {
            const projection = body.messages.find(item => item.role === 'user' && item.content.startsWith('<view ') &&
                item.content.includes('app_id="' + app + '"'));
            for (const match of visible) assert.match(projection?.content ?? '', match);
        }
        if (name) {
            assert.ok(body.tools.some(item => item.function?.name === name), name + ' present in actual model request');
            const [result] = savedParts(message, calls);
            assert.equal(result.output.type, 'json', JSON.stringify(result));
            assert.equal(result.output.value.success, true, JSON.stringify(result));
            replies[label] = result;
        }
    }
    const open = label => run(label, 'system-open_app', { installation_id: installation });
    const close = label => run(label, 'system-close_app', { app_id: app });
    const call = (label, name, input, visible) => run(label, app + '-' + name, input, visible);

    await open('open-unused');
    await call('memory-only', 'edit', { text: 'memory only' }, [/Draft: empty/, /Saved lookup: unread/]);
    await run('quiet-close', 'system-close_app', { app_id: app }, [/Draft: memory only/]);
    assert.deepEqual(requests(), []);
    assert.equal(existsSync(dbPath), false);
    assert.equal(owners[0].exited, true);

    await open('open-for-save');
    await call('first-draft', 'edit', { text: 'first draft' }, [/Draft: empty/]);
    await call('save-first', 'save', {}, [/Draft: first draft/]);
    assert.deepEqual(requests(), [['replace', 'draft']]);
    assert.deepEqual(snapshot('after-save-ack'), { draft: 'first draft' });
    await call('second-in-memory', 'edit', { text: 'second draft' });
    await run('close-second', 'system-close_app', { app_id: app }, [/Draft: second draft/]);
    assert.deepEqual(snapshot('after-second-close'), { draft: 'first draft' });
    assert.deepEqual(requests(), [['replace', 'draft'], ['release', null]]);

    await open('reopen-for-load');
    await call('keep-current', 'edit', { text: 'keep current' }, [/Draft: empty/, /Saved lookup: unread/]);
    assert.deepEqual(owners[2].requests, []);
    await call('lookup-first', 'load', { adopt: false }, [/Draft: keep current/]);
    await call('pin-marker', 'keep', {}, [/Draft: keep current/, /Saved lookup: first draft/]);
    await call('delete-only-draft', 'remove');
    assert.deepEqual(snapshot('after-remove'), { marker: 'preserve' });
    await call('read-missing', 'load', { adopt: true });
    await call('new-draft', 'edit', { text: 'cleanup draft' }, [/Draft: keep current/, /Saved lookup: missing/]);
    await call('arm-cleanup', 'arm_close');
    assert.deepEqual(snapshot('before-cleanup'), { marker: 'preserve' });
    await close('explicit-close-save');
    assert.deepEqual(snapshot('after-cleanup'), { draft: 'cleanup draft', marker: 'preserve' });
    assert.deepEqual(requests(), [['replace', 'draft'], ['release', null], ['read', 'draft'], ['replace', 'marker'],
        ['remove', 'draft'], ['read', 'draft'], ['replace', 'draft'], ['release', null]]);
    assert.equal(owners.length, 3);
    assert.ok(owners.every(owner => owner.exited && owner.requests.length === owner.replies.length));
    return { replies, rows, requests: requests() };
}
