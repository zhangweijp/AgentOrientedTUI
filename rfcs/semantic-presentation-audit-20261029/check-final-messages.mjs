import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const report = path.join(path.dirname(fileURLToPath(import.meta.url)), 'repair-verification/attempt-2');
const isolated = (await readFile(path.join(report, 'isolation.txt'), 'utf8')).trim();
const { assembleContextRegions } = await import(pathToFileURL(path.join(isolated, 'agent-driver-v2/dist/core/context-regions.js')).href);
const actual = JSON.parse(await readFile(path.join(report, 'host-worker-facts.json'), 'utf8')).initialProjection;
const messages = assembleContextRegions([
  { role: 'system', content: 'You are an AOTUI acceptance agent.', timestamp: 0, region: 'static' },
  ...actual.messages,
  { role: 'user', content: 'Earlier user request.', timestamp: 10, region: 'session' },
  { role: 'user', content: 'Report the currently visible IDE tools without opening a file.', timestamp: 20, region: 'session' },
]);
const workspace = messages.findIndex(message => String(message.content).startsWith('<view id="workspace"'));
const instruction = messages.findIndex(message => String(message.content).includes('# AOTUI IDE - Application Instruction'));
const history = messages.findIndex(message => message.content === 'Earlier user request.');
assert.ok(instruction < history && history < workspace && workspace < messages.length - 1);
assert.ok(messages.every(message => !('timestamp' in message) && !('region' in message)));
assert.ok(!actual.tools.some(name => name.endsWith('-edit_file') || name.endsWith('-batch_edit')));
await writeFile(path.join(report, 'final-messages.json'), JSON.stringify({ messages, tools: actual.tools }, null, 2));
console.log(JSON.stringify({ passed: true, messageCount: messages.length, tools: actual.tools.length, source: 'actual Worker projection through the built Driver context assembler; user messages are fixtures; no live LLM call' }));
