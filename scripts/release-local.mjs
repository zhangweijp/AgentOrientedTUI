import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
    out: { type: 'string' }, 'store-dir': { type: 'string' }, offline: { type: 'boolean' },
} });
assert.ok(path.isAbsolute(options.out ?? ''), 'Use --out with an absolute, new or empty directory');
assert.ok(options['store-dir'] === undefined || path.isAbsolute(options['store-dir']), 'Use an absolute --store-dir');
const repo = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
fs.mkdirSync(options.out, { recursive: true });
const out = fs.realpathSync(options.out);
assert.deepEqual(fs.readdirSync(out), [], '--out must be empty');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aotui-local-release-')));
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
assert.ok(!inside(repo, scratch), 'Use a system temporary directory outside the repository');
const inputs = path.join(out, 'inputs');
const storeDir = options['store-dir'] ?? path.join(out, 'pnpm-store');
const logs = path.join(out, 'logs');
const artifacts = path.join(out, 'artifacts');
for (const directory of [logs, artifacts]) fs.mkdirSync(directory);
const packages = ['core', 'runtime', 'sdk', 'agent-driver-v2', 'agent-driver-adapter'];
const lifecycleSpec = 'tests/agent-driver-adapter/runtime-lifecycle.integration.test.ts';
const lifecycleSupport = 'tests/fixtures/batch-two-support.mjs';
const patchPath = 'patches/provider-utils-4.0.65.patch';
const env = { ...process.env, CI: '1' };
for (const key of Object.keys(env)) {
    if (/^(?:NODE_PATH|NODE_OPTIONS|NODE_PRESERVE_SYMLINKS|TS_NODE_.*|AOTUI_(?:PACKAGE_CONSUMER_DIR|W08_C1_FACTS_DIR|DATA_DIR)|npm_config_(?:cache|node_linker|modules_dir|virtual_store_dir|enable_global_virtual_store|ignore_scripts))$/i.test(key)) delete env[key];
}
env.NPM_CONFIG_CACHE = path.join(scratch, 'npm-cache');
const evidence = { status: 'running', scratch, startedAt: new Date().toISOString(), toolchain: {
    node: process.version, nodePath: process.execPath, platform: process.platform, arch: process.arch, osRelease: os.release(),
}, installs: { offline: !!options.offline, storeDir }, builds: {}, packages: {}, consumers: {}, stages: {}, commands: [] };
const manifest = path.join(out, 'release-manifest.json');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const save = () => json(manifest, evidence);
const relative = file => path.relative(out, file);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const packageJson = folder => read(path.join(folder, 'package.json'));
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });

function run(label, cwd, command, args, additions = {}) {
    const log = path.join(logs, `${label}.log`);
    const argv = [command, ...args];
    const result = spawnSync(command, args, { cwd, env: { ...env, ...additions }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const fact = { label, cwd, argv, exitCode: result.status, signal: result.signal, log: relative(log), status: result.status === 0 ? 'pass' : 'fail' };
    evidence.commands.push(fact);
    fs.writeFileSync(log, `${JSON.stringify(fact)}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`);
    save();
    if (result.status !== 0) throw new Error(`${label} failed (${result.error ?? result.signal ?? result.status}). See ${log}`);
    return result.stdout;
}

function stage(name, action, blockedBy) {
    if (blockedBy) {
        evidence.stages[name] = { status: 'blocked', reason: blockedBy };
    } else {
        try {
            action();
            evidence.stages[name] = { status: 'pass' };
        } catch (error) {
            evidence.stages[name] = { status: 'fail', reason: error.message };
        }
    }
    const result = evidence.stages[name];
    console.log(`${result.status.toUpperCase()} ${name}${result.reason ? ' — ' + result.reason : ''}`);
    save();
    return result.status === 'pass';
}

function inventory(folder, ignoredRoot) {
    const entries = {};
    function visit(directory = '') {
        for (const name of fs.readdirSync(path.join(folder, directory)).sort()) {
            if (!directory && name === ignoredRoot) continue;
            const file = path.join(directory, name);
            const absolute = path.join(folder, file);
            const stat = fs.lstatSync(absolute);
            if (stat.isDirectory()) visit(file);
            else if (stat.isSymbolicLink()) entries[file] = { link: fs.readlinkSync(absolute) };
            else {
                assert.ok(stat.isFile(), `Unsupported file ${absolute}`);
                entries[file] = { sha256: hashFile(absolute), mode: stat.mode & 0o777 };
            }
        }
    }
    visit();
    return entries;
}

function recordInventory(folder, file) {
    const entries = inventory(folder);
    json(file, entries);
    return { file: relative(file), sha256: hashFile(file), count: Object.keys(entries).length };
}

function freeze() {
    const head = run('git-head', repo, 'git', ['rev-parse', 'HEAD']).trim();
    const dirty = run('git-status', repo, 'git', ['status', '--porcelain=v1', '--untracked-files=all']);
    const files = run('git-build-inputs', repo, 'git', ['ls-files', '-co', '--exclude-standard', '-z', '--',
        ...packages, 'package.json', 'pnpm-lock.yaml', 'scripts/release-local.mjs', lifecycleSpec, lifecycleSupport]);
    for (const file of new Set(files.split('\0').filter(Boolean))) {
        if (file.split('/').some(part => ['node_modules', 'dist', 'coverage', '.git', '.tmp', '.pnpm-store'].includes(part))) continue;
        const source = path.join(repo, file);
        if (!fs.existsSync(source)) continue;
        const target = path.join(inputs, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copy(source, target);
    }
    evidence.inputs = { head, dirtySha256: sha(dirty), ...recordInventory(inputs, path.join(out, 'input-files.json')),
        locks: Object.fromEntries(packages.map(pkg => [pkg, hashFile(path.join(inputs, pkg, 'pnpm-lock.yaml'))])),
        driverPatchSha256: hashFile(path.join(inputs, 'agent-driver-v2', patchPath)), runnerSha256: hashFile(fileURLToPath(import.meta.url)) };
}

let pnpm = ['pnpm'];
function runPnpm(label, cwd, args) {
    return run(label, cwd, pnpm[0], [...pnpm.slice(1), ...args]);
}
function install(label, cwd, frozen) {
    runPnpm(label, cwd, ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile',
        options.offline ? '--offline' : '--prefer-offline', '--strict-peer-dependencies',
        '--config.node-linker=isolated', '--config.enable-global-virtual-store=false', '--store-dir', storeDir]);
}
function compiler(label, directory, dependency = 'typescript') {
    const root = fs.realpathSync(path.join(directory, 'node_modules', dependency));
    assert.ok(inside(path.join(directory, 'node_modules'), root), `Compiler resolved outside ${directory}`);
    const { name, version } = packageJson(root);
    const binary = fs.realpathSync(path.join(root, 'bin/tsc'));
    const reported = run(label, directory, process.execPath, [binary, '--version']).trim();
    assert.equal(name, 'typescript');
    assert.equal(reported, `Version ${version}`);
    return { dependency, root, name, version, binary, reported };
}

function build(name) {
    const directory = path.join(scratch, name);
    const output = path.join(out, name);
    copy(inputs, directory);
    fs.mkdirSync(output);
    const built = evidence.builds[name] = {};
    const dependencies = { runtime: ['core'], sdk: ['core'], 'agent-driver-adapter': ['core', 'runtime', 'agent-driver-v2'] };
    for (const pkg of packages) {
        const cwd = path.join(directory, pkg);
        const label = `${name}-${pkg}`;
        const failed = (dependencies[pkg] ?? []).find(dep => evidence.stages[`${name}-${dep}`].status !== 'pass');
        stage(label, () => {
            const target = path.join(output, pkg);
            fs.mkdirSync(target);
            assert.ok(!fs.existsSync(path.join(cwd, 'dist')) && !fs.existsSync(path.join(cwd, 'node_modules')));
            install(`${label}-install`, cwd, true);
            const tsc = compiler(`${label}-compiler`, cwd, pkg === 'sdk' ? '@typescript/native' : 'typescript');
            runPnpm(`${label}-build`, cwd, ['run', 'build']);
            assert.equal(hashFile(path.join(cwd, 'pnpm-lock.yaml')), evidence.inputs.locks[pkg]);
            const [packed] = JSON.parse(run(`${label}-pack`, cwd, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', target]));
            const tar = path.join(target, packed.filename);
            const extracted = path.join(target, 'payload');
            fs.mkdirSync(extracted);
            run(`${label}-inspect-tar`, cwd, 'tar', ['-xzf', tar, '--strip-components', '1', '-C', extracted]);
            const metadata = packageJson(extracted);
            const source = packageJson(cwd);
            assert.equal(metadata.name, source.name);
            assert.equal(metadata.version, source.version);
            for (const key of ['dependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies']) {
                assert.deepEqual(metadata[key], source[key]);
                for (const spec of Object.values(metadata[key] ?? {})) {
                    if (typeof spec === 'string') assert.doesNotMatch(spec, /^(?:file:|link:|workspace:|[./])/);
                }
            }
            const payload = recordInventory(extracted, path.join(target, 'payload.json'));
            if (pkg === 'runtime') {
                assert.deepEqual(metadata.bin, { 'aotui-stdio': 'dist/stdio.js' });
                const files = read(path.join(out, payload.file));
                for (const file of ['dist/stdio.js', 'dist/examples/files/app.mjs', 'examples/files/aoapp.json', 'examples/python-host.py'])
                    assert.ok(Object.hasOwn(files, file), 'Missing Runtime package file ' + file);
                assert.ok(!Object.keys(files).some(file => /^dist\/cli(?:\/|[.-])/.test(file)));
            }
            built[pkg] = { name: metadata.name, version: metadata.version, tar: relative(tar), sha256: hashFile(tar), payload, compiler: tsc,
                dependencies: metadata.dependencies, peerDependencies: metadata.peerDependencies, optionalDependencies: metadata.optionalDependencies };
        }, failed && `Requires ${name}-${failed}`);
    }
}

function selectArtifacts() {
    const a = evidence.builds['build-a'];
    const b = evidence.builds['build-b'];
    assert.equal(a.core.dependencies.typebox, '1.4.3');
    for (const pkg of ['sdk', 'runtime', 'agent-driver-adapter']) assert.equal(a[pkg].dependencies[a.core.name], a.core.version);
    assert.equal(a.sdk.dependencies[a.runtime.name], undefined);
    assert.deepEqual(a['agent-driver-adapter'].peerDependencies, {
        [a.runtime.name]: a.runtime.version, [a['agent-driver-v2'].name]: a['agent-driver-v2'].version,
    });
    for (const pkg of packages) {
        const one = a[pkg], two = b[pkg];
        assert.equal(one.payload.sha256, two.payload.sha256, `${pkg} payload differs; compare the two payload.json files`);
    }
    for (const pkg of packages) {
        const selected = a[pkg], tar = path.join(artifacts, path.basename(selected.tar));
        fs.copyFileSync(path.join(out, selected.tar), tar);
        evidence.packages[pkg] = { ...selected, tar: relative(tar), identicalTarBytes: selected.sha256 === b[pkg].sha256 };
    }
}

function consumerInputs(profile, folder) {
    const host = profile === 'host';
    const coreOnly = profile === 'core';
    const jsx = host || profile === 'author-jsx';
    const selected = (host ? packages : coreOnly ? ['core'] : ['core', 'sdk']).map(pkg => evidence.packages[pkg]);
    const local = Object.fromEntries(selected.map(pkg => [pkg.name, `file:../../${pkg.tar}`]));
    const sdk = packageJson(path.join(inputs, 'sdk'));
    const driver = packageJson(path.join(inputs, 'agent-driver-v2'));
    const nodeTypes = '24.11.0';
    const overrides = { ...local };
    if (host) {
        // Reproduce the existing Driver lock's direct Provider versions in this test graph.
        // Each Provider keeps its own compatible provider-utils dependency.
        const driverModules = path.join(scratch, 'build-a/agent-driver-v2/node_modules');
        for (const name of Object.keys(driver.dependencies).filter(name => /^(?:@ai-sdk\/(?!provider-utils$)|@openrouter\/)/.test(name))) {
            overrides[`${driver.name}>${name}`] = packageJson(path.join(driverModules, name)).version;
        }
        const ai = fs.realpathSync(path.join(driverModules, 'ai'));
        overrides['ai>@ai-sdk/gateway'] = packageJson(path.join(ai, '../@ai-sdk/gateway')).version;
        fs.mkdirSync(path.join(folder, 'patches'));
        const asset = run('extract-driver-patch', folder, 'tar', ['-xOf', path.join(out, evidence.packages['agent-driver-v2'].tar), `package/${patchPath}`]);
        fs.writeFileSync(path.join(folder, patchPath), asset);
        assert.equal(hashFile(path.join(folder, patchPath)), evidence.inputs.driverPatchSha256);
    }
    const viteVersion = host && packageJson(path.join(fs.realpathSync(path.join(scratch,
        'build-a/agent-driver-adapter/node_modules/vitest')), '../vite')).version;
    const direct = host || coreOnly ? local : { [sdk.name]: local[sdk.name] };
    json(path.join(folder, 'package.json'), { private: true, type: 'module',
        dependencies: { ...direct, ...(!coreOnly && { typebox: sdk.peerDependencies.typebox }), ...(jsx && { preact: sdk.peerDependencies.preact }), ...(host && {
            ai: driver.dependencies.ai, zod: driver.devDependencies.zod,
            '@ai-sdk/provider-utils': driver.dependencies['@ai-sdk/provider-utils'],
        }) },
        devDependencies: { typescript: '7.0.2', ...(host && {
            '@types/node': nodeTypes, vitest: '4.1.12', vite: viteVersion, '@types/json-schema': driver.dependencies['@types/json-schema'],
        }) },
        pnpm: { overrides, ...(host && { patchedDependencies: { '@ai-sdk/provider-utils@4.0.65': patchPath }, onlyBuiltDependencies: ['esbuild'] }) },
    });
}

function verifyResolution(label, folder, profile) {
    const host = profile === 'host', coreOnly = profile === 'core';
    const modules = path.join(folder, 'node_modules');
    const names = Object.fromEntries(packages.map(pkg => [pkg, evidence.packages[pkg].name]));
    const packageRoots = {};
    for (const pkg of (host ? packages : coreOnly ? ['core'] : ['sdk'])) {
        const delivered = evidence.packages[pkg];
        const root = fs.realpathSync(path.join(modules, delivered.name));
        assert.ok(inside(modules, root), `${delivered.name} resolved outside consumer`);
        assert.deepEqual(inventory(root, 'node_modules'), read(path.join(out, delivered.payload.file)), `${delivered.name} does not match the selected tar`);
        packageRoots[delivered.name] = root;
    }
    const graph = JSON.parse(runPnpm(`${label}-dependency-graph`, folder, ['list', '--depth', 'Infinity', '--json']));
    const forbidden = host ? [] : ['ai', names.runtime, names['agent-driver-v2'], names['agent-driver-adapter'], 'better-sqlite3',
        ...(coreOnly ? [names.sdk, 'linkedom'] : []), ...(profile === 'author-jsx' ? [] : ['preact'])];
    const resolve = `
      import { realpathSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const [parents, entries, forbidden] = JSON.parse(process.argv[1]);
      const result = { entries: {}, absent: [] };
      for (const [id, name] of Object.entries(entries)) {
        const parent = parents[id];
        result.entries[id] = realpathSync(fileURLToPath(import.meta.resolve(name, parent ? pathToFileURL(parent).href : undefined)));
      }
      for (const name of forbidden) {
        try { import.meta.resolve(name); }
        catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') { result.absent.push(name); continue; } throw error; }
        throw Error('Unexpected dependency: ' + name);
      }
      console.log(JSON.stringify(result));`;
    const entries = coreOnly ? { core: names.core } : { sdk: `${names.sdk}/app`, sdkCore: names.core };
    const parents = coreOnly ? {} : { sdkCore: path.join(packageRoots[names.sdk], 'dist/app.js') };
    if (profile === 'author-jsx') Object.assign(entries, { component: names.sdk, preact: 'preact' });
    if (host) {
        const driver = names['agent-driver-v2'], adapter = names['agent-driver-adapter'];
        Object.assign(entries, { core: names.core, runtime: names.runtime, runtimeCore: names.core,
            adapter, driver, adapterRuntime: names.runtime, adapterDriver: driver,
            driverAI: 'ai', driverUtils: '@ai-sdk/provider-utils', aiUtils: '@ai-sdk/provider-utils', preact: 'preact' });
        Object.assign(parents, { runtimeCore: path.join(packageRoots[names.runtime], 'dist/index.js'),
            adapterRuntime: path.join(packageRoots[adapter], 'dist/index.js'), adapterDriver: path.join(packageRoots[adapter], 'dist/index.js'),
            driverAI: path.join(packageRoots[driver], 'dist/index.js'), driverUtils: path.join(packageRoots[driver], 'dist/index.js') });
        parents.aiUtils = path.join(fs.realpathSync(path.join(modules, 'ai')), 'dist/index.mjs');
    }
    const resolution = JSON.parse(run(`${label}-resolve`, folder, process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '--eval', resolve,
        JSON.stringify([parents, entries, forbidden])]));
    for (const value of Object.values(resolution.entries)) assert.ok(inside(modules, value), `Resolution escaped consumer: ${value}`);
    const expectedCore = read(path.join(out, evidence.packages.core.payload.file));
    for (const name of ['sdkCore', 'runtimeCore']) {
        if (!resolution.entries[name]) continue;
        const root = path.dirname(path.dirname(resolution.entries[name]));
        assert.deepEqual(inventory(root, 'node_modules'), expectedCore, `${name} differs from the delivered Core`);
    }
    if (host) {
        assert.equal(resolution.entries.adapterRuntime, resolution.entries.runtime);
        assert.equal(resolution.entries.adapterDriver, resolution.entries.driver);
        assert.equal(resolution.entries.driverUtils, resolution.entries.aiUtils);
        assert.match(resolution.entries.driverUtils, /provider-utils@4\.0\.65_patch_hash=/);
    } else {
        const visit = node => {
            for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [name, child] of Object.entries(node[group] ?? {})) {
                assert.ok(!forbidden.includes(name) && !name.startsWith('@ai-sdk/'), `Unexpected dependency for ${profile}: ${name}`);
                visit(child);
            }
        };
        graph.forEach(visit);
    }
    return { packageRoots, ...resolution, compiler: compiler(`${label}-compiler`, folder) };
}

function consumers(profile) {
    const host = profile === 'host';
    const durable = path.join(out, 'consumers', profile);
    fs.mkdirSync(durable, { recursive: true });
    const fact = evidence.consumers[profile] = { materials: relative(durable), attempts: {} };
    for (const attempt of ['first', 'reinstall']) {
        const label = `${profile}-${attempt}`;
        const root = path.join(scratch, label);
        const folder = path.join(root, 'consumers', profile);
        const report = path.join(out, 'reports', label);
        const lock = path.join(folder, 'pnpm-lock.yaml');
        const frozen = attempt === 'reinstall';
        const runFact = fact.attempts[attempt] = { cwd: folder, report: relative(report), frozenLockfile: frozen };
        const installed = stage(`${label}-install`, () => {
            fs.mkdirSync(path.dirname(folder), { recursive: true });
            fs.mkdirSync(report, { recursive: true });
            copy(artifacts, path.join(root, 'artifacts'));
            if (frozen) copy(durable, folder);
            else {
                fs.mkdirSync(folder);
                consumerInputs(profile, folder);
                for (const file of fs.readdirSync(folder)) copy(path.join(folder, file), path.join(durable, file));
            }
            assert.ok(!fs.existsSync(path.join(folder, 'node_modules')));
            install(`${label}-install`, folder, frozen);
            if (!frozen) fs.copyFileSync(lock, path.join(durable, 'pnpm-lock.yaml'));
            const materials = inventory(durable);
            for (const [file, item] of Object.entries(materials)) assert.equal(hashFile(path.join(folder, file)), item.sha256);
            assert.ok(!fs.readFileSync(lock, 'utf8').includes(repo) && !fs.readFileSync(lock, 'utf8').includes(scratch), 'Lock must be relocatable');
            fact.inputs = materials;
            runFact.lockSha256 = hashFile(lock);
        }, frozen && !fs.existsSync(path.join(durable, 'pnpm-lock.yaml')) && 'First install did not produce a lockfile');
        const blocked = !installed && `Requires ${label}-install`;
        const data = { AOTUI_DATA_DIR: path.join(folder, 'synthetic-state') };
        stage(`${label}-resolution`, () => { runFact.resolution = verifyResolution(label, folder, profile); }, blocked);
        stage(`${label}-package-consumer`, () => {
            const reportFile = path.join(report, 'package-consumer.json');
            run(`${label}-package-consumer`, folder, process.execPath, [path.join(inputs, 'sdk/tests/package-consumer/verify-package-consumer.mjs'), folder,
                reportFile, host ? 'full' : profile], data);
            const artifact = read(reportFile).artifact;
            if (artifact) {
                const target = path.join(artifacts, path.basename(artifact.file));
                if (frozen) assert.equal(hashFile(target), artifact.sha256);
                else fs.copyFileSync(artifact.file, target);
                runFact.app = { file: relative(target), sha256: artifact.sha256 };
            }
        }, blocked);
        if (!host) continue;
        stage(`${label}-w10`, () => run(`${label}-w10`, folder, process.execPath, [path.join(inputs, 'runtime/tests/verify-installed-contracts.mjs'), folder,
            path.join(report, 'w10.json'), 'ref-only'], data), blocked);
        stage(`${label}-lifecycle`, () => {
            for (const file of [lifecycleSpec, lifecycleSupport]) {
                fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
                copy(path.join(inputs, file), path.join(folder, file));
            }
            run(`${label}-lifecycle`, folder, process.execPath, [path.join(folder, 'node_modules/vitest/vitest.mjs'), 'run', lifecycleSpec, '--maxWorkers', '1'],
                { ...data, AOTUI_PACKAGE_CONSUMER_DIR: folder, AOTUI_W08_C1_FACTS_DIR: report });
        }, blocked);
    }
}

try {
    const ready = stage('freeze', () => {
        evidence.toolchain.pnpm = run('pnpm-version', repo, 'pnpm', ['--version']).trim();
        if (run('pnpm-isolated-version', scratch, 'pnpm', ['--version']).trim() !== evidence.toolchain.pnpm) {
            pnpm = ['corepack', `pnpm@${evidence.toolchain.pnpm}`];
        }
        assert.equal(runPnpm('pnpm-selected-version', scratch, ['--version']).trim(), evidence.toolchain.pnpm);
        evidence.toolchain.npm = run('npm-version', scratch, 'npm', ['--version']).trim();
        freeze();
    });
    if (ready) for (const name of ['build-a', 'build-b']) build(name);
    const comparable = ready && Object.values(evidence.builds).every(group => packages.every(pkg => group[pkg]));
    const deliverable = stage('compare-and-select', selectArtifacts, !comparable && 'Requires both builds and all package payloads');
    const profiles = ['core', 'author-plain', 'author-jsx', 'host'];
    if (deliverable) for (const profile of profiles) consumers(profile);
    else for (const profile of profiles) stage(profile, null, 'Requires compared delivery artifacts');
} catch (error) {
    evidence.error = error.stack;
    console.error(error);
} finally {
    evidence.status = evidence.error || Object.values(evidence.stages).some(step => step.status !== 'pass') ? 'fail' : 'pass';
    evidence.finishedAt = new Date().toISOString();
    save();
    console.log(`Release evidence: ${manifest}`);
    process.exitCode = evidence.status === 'pass' ? 0 : 1;
}
