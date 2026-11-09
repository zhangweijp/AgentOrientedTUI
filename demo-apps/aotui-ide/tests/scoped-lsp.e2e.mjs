import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ScopedLSP } from '../dist/core/scoped-lsp.js';
import { LSPServer } from '../dist/core/lsp/server.js';
import { directoryIdentity } from '../dist/core/versioned-file-write.js';
import { joinProcessGroup } from '../dist/core/lsp/process-resources.js';

const working = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-lsp-e2e-')));
const facts = { working, node: process.version, cases: [], processes: [], passed: false };
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const source = async root => ({ path: root, identity: await directoryIdentity(root) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const clients = new Set(), services = [];
async function capture(service) { for (const pending of service.clients.values()) { const client = await pending; clients.add(client); } }
async function run(name, action) { await action(); facts.cases.push({ name, passed: true }); console.log('PASS', name); }
async function make(name) { const root = path.join(working, name); await fs.mkdir(root); await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}'); const service = new ScopedLSP(); service.setRoots([await source(root)]); services.push(service); return { root, service }; }
try {
    await run('group permission probes retain ownership until ESRCH, persistent denial fails closed', async () => {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 180)'], { detached: true, stdio: 'ignore' });
        const closed = new Promise(resolve => child.once('close', resolve)), kill = process.kill;
        let denied = 0;
        process.kill = function(target, signal) {
            if (target === -child.pid && signal === 0 && denied < 3) { denied++; throw Object.assign(Error('fixture transient probe'), { code: 'EPERM' }); }
            return kill.call(process, target, signal);
        };
        try { await joinProcessGroup(child.pid); await closed; assert.equal(denied, 3); }
        finally { process.kill = kill; if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
        assert.equal(alive(child.pid), false); assert.equal(alive(-child.pid), false);
        facts.processes.push({ pid: child.pid, scenario: 'transient EPERM probe', processGone: true, groupGone: true });
        const inaccessible = 2147483647, signals = [], started = performance.now();
        process.kill = function(target, signal) {
            if (target === -inaccessible) { signals.push(signal); throw Object.assign(Error('fixture inaccessible group'), { code: 'EPERM' }); }
            return kill.call(process, target, signal);
        };
        try { await assert.rejects(joinProcessGroup(inaccessible), { code: 'EPERM' }); }
        finally { process.kill = kill; }
        assert.ok(performance.now() - started >= 5000); assert.equal(signals.at(-1), 'SIGTERM'); assert.ok(signals.filter(signal => signal === 0).length > 1);
        await assert.rejects(joinProcessGroup(undefined), { code: 'LSP_PROCESS_GROUP_UNVERIFIED' });
    });
    await run('actual TS request held after response cannot commit across root retirement/readd', async () => {
        const { root, service } = await make('late'), file = path.join(root, 'file.ts'), text = 'export const value = 1;'; await fs.writeFile(file, text);
        const first = await service.query('hover', file, text, 1, 15); assert.ok(first.value); await capture(service);
        const client = await [...service.clients.values()][0], pid = client.process.pid, request = client.connection.sendRequest.bind(client.connection), entered = gate(), release = gate();
        client.connection.sendRequest = async (method, ...args) => { const result = await request(method, ...args); if (method === 'textDocument/hover') { entered.resolve(); await release.promise; } return result; };
        const pending = service.query('hover', file, text, 1, 15); void pending.catch(() => {}); await entered.promise;
        await service.removeRoot(root); assert.equal(alive(pid), false); assert.equal(alive(-pid), false);
        service.setRoots([await source(root)]); release.resolve(); await assert.rejects(pending, { code: 'LSP_RESULT_STALE' });
        assert.ok((await service.query('hover', file, text, 1, 15)).value); await capture(service);
        assert.notEqual((await [...service.clients.values()][0]).process.pid, pid); await service.close();
        assert.equal(service.inspect().actualQueries, 0); assert.equal(service.inspect().currentQueries, 0);
    });
    await run('actual spawned TS process is joined when stop wins before initialization', async () => {
        const { root, service } = await make('initializing'), original = LSPServer.Typescript.spawn, entered = gate(), release = gate(), kill = process.kill, signals = []; let pid, verified;
        process.kill = function (target, signal) { try { const result = kill.call(process, target, signal); signals.push({ target, signal, result }); return result; } catch (error) { signals.push({ target, signal, code: error.code }); throw error; } };
        LSPServer.Typescript.spawn = async (...args) => { const handle = await original(...args); pid = handle.process.pid; verified = handle.processGroupVerified; entered.resolve(); await release.promise; return handle; };
        try {
            const pending = service.query('hover', path.join(root, 'file.ts'), 'const value = 1;', 1, 7); void pending.catch(() => {});
            await entered.promise; assert.equal(alive(pid), true); service.stop(); const closing = service.close(); void closing.catch(() => {}); release.resolve();
            const queryError = await pending.catch(error => error); assert.ok(queryError instanceof Error);
            await closing.catch(async error => { console.error('INITIALIZATION_RESOURCE_DEBUG', { queryCode: queryError.code, queryMessage: queryError.message, pid, verified, signals }); throw error; }); assert.equal(alive(pid), false); assert.equal(alive(-pid), false);
            facts.processes.push({ pid, scenario: 'held initialization', processGone: true, groupGone: true });
        } finally { release.resolve(); LSPServer.Typescript.spawn = original; process.kill = kill; }
    });
    await run('actual TS two roots/two Apps, seven LSP requests and 60 document lifecycles remain bounded', async () => {
        const a = await make('one'), b = await make('two'); a.service.setRoots([await source(a.root), await source(b.root)]);
        const file = path.join(a.root, 'file.ts'), consumer = path.join(a.root, 'consumer.ts'), other = path.join(b.root, 'file.ts');
        const fileText = [
            'export function greet(name: string): string {',
            '  return name.trim();',
            '}',
            'export function caller(): string {',
            "  return greet('Ada');",
            '}',
            'export const value: number = 1;',
        ].join('\n');
        const consumerText = [
            "import { caller, greet } from './file';",
            "export const result = greet('other');",
            'caller();',
        ].join('\n');
        const otherText = 'export const value = "other";';
        await fs.writeFile(file, fileText); await fs.writeFile(consumer, consumerText); await fs.writeFile(other, otherText);
        const [one, two] = await Promise.all([a.service.query('hover', file, fileText, 1, 18), b.service.query('hover', other, otherText, 1, 15)]);
        assert.match(JSON.stringify(one.value), /greet/); assert.match(JSON.stringify(two.value), /other/);
        assert.ok((await a.service.query('hover', other, await fs.readFile(other, 'utf8'), 1, 15)).value);
        await capture(a.service); await capture(b.service);
        const hover = await a.service.query('hover', consumer, consumerText, 2, 24); assert.match(JSON.stringify(hover.value), /greet/);
        const definition = await a.service.query('definition', consumer, consumerText, 2, 24);
        assert.ok(definition.value.some(item => item.filePath === file));
        const references = await a.service.query('references', consumer, consumerText, 2, 24);
        assert.ok(references.value.some(item => item.filePath === file)); assert.ok(references.value.some(item => item.filePath === consumer));
        const symbols = await a.service.query('symbols', file, fileText, 1, 18);
        assert.ok(symbols.value.some(item => item.name === 'greet')); assert.ok(symbols.value.some(item => item.name === 'caller'));
        const incoming = await a.service.query('incoming', file, fileText, 1, 18);
        assert.ok(incoming.value.some(item => item.from?.name === 'caller'));
        const outgoing = await a.service.query('outgoing', file, fileText, 4, 18);
        assert.ok(outgoing.value.some(item => item.to?.name === 'greet'));
        const erroneous = fileText.replace('export const value: number = 1;', 'export const value: number = "wrong";');
        const before = await a.service.query('diagnostics', file, erroneous, 1, 1); assert.ok(before.value.some(item => item.code === 2322));
        const after = await a.service.query('diagnostics', file, fileText, 1, 1); assert.ok(!after.value.some(item => item.code === 2322)); assert.ok(after.documentVersion > before.documentVersion);
        await a.service.closeDocument(file); const reopened = await a.service.query('hover', file, fileText, 1, 18); assert.ok(reopened.documentVersion > after.documentVersion);
        await a.service.closeDocument(file); await a.service.closeDocument(consumer); await a.service.closeDocument(other);
        for (let index = 0; index < 60; index++) {
            const current = path.join(a.root, `loop-${index}.ts`), text = `export const value = ${index};`; await fs.writeFile(current, text);
            assert.ok((await a.service.query('hover', current, text, 1, 15)).value); await a.service.closeDocument(current);
            assert.equal(a.service.inspect().currentQueries, 0); assert.equal(a.service.inspect().actualQueries, 0);
            for (const pending of a.service.clients.values()) assert.deepEqual([(await pending).inspect().documentCount, (await pending).inspect().pendingDocuments, (await pending).inspect().diagnosticWaiters], [0, 0, 0]);
        }
        await a.service.close(); await b.service.close();
    });
    await run('an unverified custom server cannot certify healthy release even after normal exit', async () => {
        const { root, service } = await make('custom'), script = path.join(root, 'server.cjs');
        await fs.writeFile(script, `const fs=require('fs');let buffer=Buffer.alloc(0);function send(id,result){const body=JSON.stringify({jsonrpc:'2.0',id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);}process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const size=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+size)return;const m=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);if(m.method==='initialize')send(m.id,{capabilities:{hoverProvider:true}});else if(m.method==='textDocument/hover')send(m.id,{contents:'controlled custom'});else if(m.method==='shutdown')send(m.id,null);else if(m.method==='exit')process.stdin.destroy();}});`);
        await fs.mkdir(path.join(root, '.aotui-ide')); await fs.writeFile(path.join(root, '.aotui-ide/lsp-config.json'), JSON.stringify({ lsp: { typescript: { command: [process.execPath, script] } } }));
        assert.ok((await service.query('hover', path.join(root, 'file.ts'), 'x', 1, 1)).value); await capture(service);
        const client = await [...service.clients.values()][0]; await assert.rejects(service.close(), { code: 'LSP_CLEANUP_FAILED' }); assert.equal(alive(client.process.pid), false); assert.equal(alive(-client.process.pid), false);
    });
    for (const client of clients) {
        assert.equal(alive(client.process.pid), false); assert.equal(alive(-client.process.pid), false);
        assert.deepEqual([client.inspect().documentCount, client.inspect().pendingDocuments, client.inspect().diagnosticWaiters], [0, 0, 0]);
        facts.processes.push({ pid: client.process.pid, processGone: true, groupGone: true, inspect: client.inspect() });
    }
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { for (const service of services) await service.close().catch(() => {}); if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(facts, null, 2)); console.log('LSP_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, processes: facts.processes.length, working })); }
