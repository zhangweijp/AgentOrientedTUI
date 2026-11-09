// Retain the M3 repair probes from the Owner's frozen review evidence unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer && evidence);
const cases = [
 ['failed-descendant-render', 'probe-boundary-layout.mjs', []],
 ['failed-initial-cleanup', 'probe-initial-cleanup.mjs', []],
 ['failed-projection-stale-retry', 'probe-stale-unmount.mjs', ['--projection']],
 ['failed-release-before-successor', 'probe-stale-unmount.mjs', []],
 ['root-cleanup-init', 'probe-app-cleanup.mjs', ['init']],
 ['root-cleanup-close', 'probe-app-cleanup.mjs', ['close']],
 ['root-cleanup-reenter', 'probe-app-cleanup.mjs', ['reenter-close']],
 ['root-cleanup-disabled-reenter', 'probe-app-cleanup.mjs', ['reenter-close', '--old-disabled']],
 ['root-cleanup-next-kernel-notice', 'probe-kernel-notice.mjs', []],
];
const results = [];
for (const [name, file, flags] of cases) {
 const command = [process.execPath, '--experimental-import-meta-resolve', new URL('repair-probes/'+file, import.meta.url).pathname, consumer, ...flags];
 const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
 results.push({ name, command, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
 fs.writeFileSync(evidence, JSON.stringify(results, null, 2)+'\n');
 assert.equal(result.status, 0, result.stdout + result.stderr);
 console.log('PASS', name);
}
