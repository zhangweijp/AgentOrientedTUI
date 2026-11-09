import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'aotui-ide-integration-'));
const cases = [
  ['tests/scoped-ide.e2e.mjs', 'IDE_FACTS'],
  ['tests/scoped-ide-edges.mjs', 'EDGE_FACTS'],
  ['tests/scoped-ide-close.e2e.mjs', 'CLOSE_FACTS'],
  ['tests/scoped-ide-capacity.mjs', 'CAPACITY_FACTS'],
];

try {
  for (const [relative, marker] of cases) {
    const factsFile = path.join(artifacts, path.basename(relative) + '.json');
    const result = spawnSync(process.execPath, [relative, factsFile], {
      cwd: appRoot,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${relative} failed with exit code ${result.status}`);
    const facts = JSON.parse(await readFile(factsFile, 'utf8'));
    assert.equal(facts.passed, true, `${relative} did not report a passing run`);
    console.log(`PASS ${relative}: ${facts.cases.length} cases (${marker})`);
  }
} finally {
  await rm(artifacts, { recursive: true, force: true });
}
