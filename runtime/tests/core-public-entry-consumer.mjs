import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// A purpose-specific package consumer. It never installs, builds, packs or
// starts Workers. Execute only after the exact consumer/commands are admitted.
const [consumerArgument, factsArgument, compilerArgument] = process.argv.slice(2);
assert.ok(consumerArgument && path.isAbsolute(consumerArgument), 'Explicit absolute installed consumer required');
assert.ok(factsArgument && path.isAbsolute(factsArgument), 'Explicit absolute new facts path required');
const consumer = await fs.realpath(consumerArgument);
const factsPath = path.resolve(factsArgument);
assert.ok(factsPath.startsWith(consumer + path.sep), 'Facts must stay in the admitted consumer');
const compiler = compilerArgument ?? path.join(consumer, 'node_modules/typescript/bin/tsc');
assert.ok(path.isAbsolute(compiler), 'Absolute compiler path required');
const digest = value => createHash('sha256').update(value).digest('hex');
const facts = { consumer, nodeVersion: process.version, passed: false, commands: [],
    completeW10Claimed: false, newInstallPerformed: false,
    installationEvidenceRequiredFromCaller: true, normalInstallVerifiedByThisHarness: false,
    workerOrModelExecutionRequested: false };

try {
    const runtime = await fs.realpath(path.join(consumer, 'node_modules/@aotui/runtime'));
    // This rejects an external workspace link. It does not prove that a normal
    // package-manager tar install happened; the outer runner supplies that evidence.
    assert.ok(runtime.startsWith(consumer + path.sep), 'Runtime must be installed in this consumer, not linked to a workspace');
    const manifestBytes = await fs.readFile(path.join(runtime, 'package.json'));
    const manifest = JSON.parse(manifestBytes);
    const consumerManifest = JSON.parse(await fs.readFile(path.join(consumer, 'package.json'), 'utf8'));
    assert.equal(consumerManifest.type, 'module', 'The admitted consumer must be ESM');
    const compilerManifest = JSON.parse(await fs.readFile(path.resolve(path.dirname(compiler), '../package.json'), 'utf8'));
    assert.equal(compilerManifest.version, '7.0.2', 'Use the unified exact compiler version');
    facts.runtime = { resolvedPath: runtime, name: manifest.name, version: manifest.version,
        manifestSha256: digest(manifestBytes) };
    facts.compiler = { path: compiler, version: compilerManifest.version };

    const documentPath = path.join(runtime, 'docs/core-public-entry.md');
    const documentBytes = await fs.readFile(documentPath);
    const document = documentBytes.toString('utf8');
    const start = '<!-- b1-example:start -->\n```ts\n';
    const end = '```\n<!-- b1-example:end -->';
    assert.equal(document.split(start).length, 2, 'Exactly one b1 start marker');
    assert.equal(document.split(end).length, 2, 'Exactly one b1 end marker');
    const startOffset = document.indexOf(start) + start.length;
    const endOffset = document.indexOf(end, startOffset);
    assert.ok(endOffset > startOffset, 'Ordered b1 markers required');
    const source = document.slice(startOffset, endOffset);
    const directory = path.join(consumer, `core-public-entry-${compilerManifest.version}`);
    await fs.mkdir(directory); // A fresh output directory; never overwrite a previous attempt.
    const sourcePath = path.join(directory, 'tutorial.ts');
    await fs.writeFile(sourcePath, source, { flag: 'wx' });
    assert.equal((await fs.readFile(sourcePath, 'utf8')), source, 'Compile the exact installed document, without replacements');
    const configPath = path.join(directory, 'tsconfig.json');
    const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
        lib: ['ES2022'], types: [], outDir: './out' }, files: ['./tutorial.ts'] };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    facts.document = { path: documentPath, sha256: digest(documentBytes),
        extractedSourceSha256: digest(source), sourcePath, exactExtraction: true };
    facts.config = config;
    const argv = [compiler, '--project', configPath, '--listFiles', '--traceResolution'];
    const compiled = spawnSync(process.execPath, argv, { cwd: consumer, encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    await fs.writeFile(path.join(directory, 'compile.stdout.log'), compiled.stdout ?? '', { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'compile.stderr.log'), compiled.stderr ?? '', { flag: 'wx' });
    facts.commands.push({ argv: [process.execPath, ...argv], cwd: consumer, exitCode: compiled.status,
        signal: compiled.signal, error: compiled.error?.message ?? null,
        stdout: path.join(directory, 'compile.stdout.log'), stderr: path.join(directory, 'compile.stderr.log') });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, 'Exact Core tutorial must compile under the complete public type gate');

    const outputPath = path.join(directory, 'out/tutorial.js');
    const output = await fs.readFile(outputPath);
    facts.generatedModule = { path: outputPath, sha256: digest(output) };
    // Only the generated, exact Core tutorial is imported. It asserts its own
    // observation/activation/close and StateSession behavior before exporting.
    const example = await import(pathToFileURL(outputPath).href);
    assert.ok(example.coreTutorialFacts, 'The actual tutorial must export its witness');
    assert.equal(example.coreTutorialFacts.handlerEntries, 3);
    assert.deepEqual(example.coreTutorialFacts.witness, [
        { text: 'old!', frozen: true }, { text: 'new!', frozen: true },
    ]);
    for (const field of ['scopes', 'logicalBytes', 'leases', 'bindings', 'stateOwners']) {
        assert.equal(example.coreTutorialFacts[field], 0, `${field} must actually reach zero`);
    }
    assert.equal(example.coreTutorialFacts.restoredValue, 41);
    assert.equal(example.coreTutorialFacts.storedKeys, 1);
    facts.tutorial = example.coreTutorialFacts;
    facts.passed = true;
} catch (error) {
    facts.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
    process.exitCode = 1;
} finally {
    await fs.mkdir(path.dirname(factsPath), { recursive: true });
    await fs.writeFile(factsPath, JSON.stringify(facts, null, 2) + '\n', { flag: 'wx' });
}
