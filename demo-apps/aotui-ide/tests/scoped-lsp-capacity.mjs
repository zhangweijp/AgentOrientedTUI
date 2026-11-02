import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ScopedLSP } from '../dist/core/scoped-lsp.js';
import { directoryIdentity } from '../dist/core/versioned-file-write.js';
const working = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-lsp-capacity-')));
const facts = { working, cases: [], processes: [], passed: false }, services = [];
const server = path.join(working, 'controlled-server.cjs');
await fs.writeFile(server, String.raw`const fs=require('fs');fs.writeFileSync(process.argv[2],String(process.pid));let buffer=Buffer.alloc(0),hold=false,pending=[];
function send(id,result){const body=JSON.stringify({jsonrpc:'2.0',id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);}
function handle(m){if(m.method==='initialize'){if(!m.params.initializationOptions.holdInitialize)send(m.id,{capabilities:{hoverProvider:true}});}
else if(m.method==='test/hold')hold=true;else if(m.method==='test/release'){hold=false;for(const id of pending)send(id,{contents:'controlled-capacity'});pending=[];}
else if(m.method==='textDocument/hover'){if(hold)pending.push(m.id);else send(m.id,{contents:'controlled-capacity'});}
else if(m.method==='shutdown')send(m.id,null);else if(m.method==='exit')process.stdin.destroy();}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const size=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+size)return;const message=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);handle(message);}});
`);
const code = expected => error => { assert.equal(error.code, expected); return true; };
const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
async function eventually(read, label, ms = 5000) { const end = Date.now() + ms; for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) throw Error(label); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function root(name, initialization = {}) {
    const directory = path.join(working, name), pidFile = path.join(working, name + '.pid'); await fs.mkdir(path.join(directory, '.aotui-ide'), { recursive: true });
    await fs.writeFile(path.join(directory, '.aotui-ide/lsp-config.json'), JSON.stringify({ lsp: { typescript: { command: [process.execPath, server, pidFile], initialization } } }));
    return { path: directory, identity: await directoryIdentity(directory), pidFile };
}
async function recordGone(source) { const pid = Number(await fs.readFile(source.pidFile, 'utf8')); assert.ok(gone(pid)); assert.ok(gone(-pid)); facts.processes.push({ pid, group: pid, processGone: true, groupGone: true, profile: 'controlled custom; cleanup remains unverified' }); }
async function run(name, action) { const time = performance.now(), details = await action(); facts.cases.push({ name, details, elapsedMs: performance.now() - time, passed: true }); console.log('PASS', name); }
try {
    await Promise.all([
        run('actual custom server documents63/64/65 clients7/8/9 and four real requests remain owned after30s', async () => {
            const roots = []; for (let i = 0; i < 9; i++) roots.push(await root('root' + i));
            const service = new ScopedLSP(); services.push(service); service.setRoots(roots);
            const files = Array.from({ length: 65 }, (_, i) => path.join(roots[0].path, 'file' + i + '.ts'));
            for (let i = 0; i < 64; i++) { await fs.writeFile(files[i], 'x'); assert.ok((await service.query('hover', files[i], 'x')).value); }
            const client = await [...service.clients.values()][0]; assert.equal(client.inspect().documentCount, 64);
            await assert.rejects(service.query('hover', files[64], 'x'), code('LSP_DOCUMENT_CAPACITY')); assert.equal(client.inspect().documentCount, 64);
            for (const bytes of [4 * 1024 * 1024 - 1, 4 * 1024 * 1024]) assert.ok((await service.query('hover', files[0], 'x'.repeat(bytes))).value);
            await assert.rejects(service.query('hover', files[0], 'x'.repeat(4 * 1024 * 1024 + 1)), code('LSP_DOCUMENT_TOO_LARGE'));
            for (const file of files.slice(0, 64)) await service.closeDocument(file); assert.equal(client.inspect().documentCount, 0);
            await client.connection.sendNotification('test/hold', {});
            const started = performance.now(), pending = files.slice(0, 4).map(file => service.query('hover', file, 'x'));
            for (const request of pending) void request.catch(() => {});
            await eventually(() => client.inspect().documentCount === 4, 'four actual sent documents'); assert.equal(service.inspect().actualQueries, 4);
            await assert.rejects(service.query('hover', files[4], 'x'), code('LSP_QUERY_CAPACITY'));
            const expired = await Promise.allSettled(pending); assert.ok(expired.every(item => item.status === 'rejected' && item.reason.code === 'LSP_QUERY_FAILED'));
            const deadlineMs = performance.now() - started; assert.ok(deadlineMs >= 29000 && deadlineMs < 35000); assert.equal(service.inspect().actualQueries, 4);
            await assert.rejects(service.query('hover', files[4], 'x'), code('LSP_QUERY_CAPACITY'));
            await client.connection.sendNotification('test/release', {}); await eventually(() => service.inspect().actualQueries === 0 && service.inspect().currentQueries === 0, 'actual late requests settled');
            for (let i = 1; i < 8; i++) { assert.ok((await service.query('hover', path.join(roots[i].path, 'file.ts'), 'x')).value); if (i === 6) assert.equal(service.inspect().clients, 7); }
            assert.equal(service.inspect().clients, 8); await assert.rejects(service.query('hover', path.join(roots[8].path, 'file.ts'), 'x'), code('LSP_CLIENT_CAPACITY')); assert.equal(service.inspect().clients, 8);
            await assert.rejects(service.close(), code('LSP_CLEANUP_FAILED')); assert.equal(service.inspect().clients, 0); for (const source of roots.slice(0, 8)) await recordGone(source);
            return { documents: [63, 64, 65], clients: [7, 8, 9], pending: [4, 5], afterDeadlineActual: 4, deadlineMs, unknownServerNeverCertified: true };
        }),
        run('45s initialization deadline joins its real custom child after query caller30s timeout', async () => {
            const source = await root('initialization', { holdInitialize: true }), service = new ScopedLSP(); services.push(service); service.setRoots([source]);
            const started = performance.now(), query = service.query('hover', path.join(source.path, 'file.ts'), 'x'); void query.catch(() => {});
            await eventually(async () => fs.readFile(source.pidFile, 'utf8').then(Boolean, () => false), 'actual initialization process');
            const clientStart = [...service.clients.values()][0]; void clientStart.catch(() => {});
            await assert.rejects(query, code('LSP_QUERY_FAILED')); assert.equal(service.inspect().actualQueries, 1); assert.equal(service.inspect().startingClients, 1);
            await assert.rejects(clientStart, code('LSP_INITIALIZATION_CLEANUP_FAILED'));
            const deadlineMs = performance.now() - started; assert.ok(deadlineMs >= 44000 && deadlineMs < 50000);
            await assert.rejects(service.close(), code('LSP_CLEANUP_FAILED')); await recordGone(source); assert.equal(service.inspect().actualQueries, 0); assert.equal(service.inspect().startingClients, 0);
            return { deadlineMs, callerTimeoutDidNotReleaseActualInitialization: true, unknownServerNeverCertified: true };
        }),
    ]);
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { for (const service of services) await service.close().catch(() => {}); facts.finishedAt = new Date().toISOString(); await fs.writeFile(process.argv[2], JSON.stringify(facts, null, 2)); console.log('LSP_CAPACITY_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length })); }
