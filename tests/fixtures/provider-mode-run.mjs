import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeBackgroundFiles, runtimeFiles, traditionalFiles } from './provider-mode-files.mjs';
import { budget, providerIds } from './provider-mode-local.mjs';
import { isolatedReplay, refStrategy } from './provider-mode-ref.mjs';

const [root, filter] = process.argv.slice(2);
const cases = [
    ['group-0-short', folder => traditionalFiles(folder, false)],
    ['group-0-long', folder => traditionalFiles(folder, true)],
    ...providerIds.flatMap(provider => ['native', 'dispatch', 'console'].map(mode => [
        mode === 'native' ? 'group-A-' + provider : 'group-C-' + mode + '-' + provider,
        folder => runtimeFiles(folder, provider, mode),
    ])),
    ...['short', 'long'].flatMap(task => ['native', 'dispatch', 'console'].map(mode => [
        (mode === 'native' ? 'group-A-' : 'group-C-' + mode + '-') + 'openai-' + task,
        folder => runtimeFiles(folder, 'openai', mode, task),
    ])),
    ['isolated-schema-replay', isolatedReplay],
    ...[1, 2, 3].map(strategy => ['ref-strategy-' + strategy, folder => refStrategy(folder, strategy)]),
    ['ref-strategy-2-explicit-grant', folder => refStrategy(folder, 2, true)],
    ['group-B-claude-background', claudeBackgroundFiles],
].filter(([name]) => name.includes(filter));
assert.ok(cases.length, filter);

const summary = {};
for (const [name, run] of cases) {
    const folder = join(root, name);
    const details = await run(folder);
    await writeFile(join(folder, 'evidence.json'), JSON.stringify(details, null, 2));
    summary[name] = details.requests ? {
        requests: details.requests.length,
        finalDisk: details.disk ?? details.exactDisk,
        writes: details.writes.length,
    } : Object.fromEntries(Object.entries(details).map(([provider, requests]) => [provider, requests.length]));
    console.log('passed ' + name);
}
await writeFile(join(root, 'summary.json'), JSON.stringify({ budget, localCases: summary,
    online: { providerAcceptance: null, providerCache: null, taskCosts: null, taskLatency: null, realModelMiscalls: null } }, null, 2));
