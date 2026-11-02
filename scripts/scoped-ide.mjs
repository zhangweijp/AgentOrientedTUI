import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(repo, '.tmp/sdk-runtime-current');
const current = path.join(workspace, 'current');
const consumer = path.join(current, 'consumer');
const [command, ...args] = process.argv.slice(2);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const expected = ['@aotui/runtime', '@aotui/sdk', '@agentina/aotui-ide'];
const entry = path.join(consumer, 'node_modules/@agentina/aotui-ide/examples/local-scoped-ide.mjs');

async function checkPackages(directory, packages) {
    for (const pkg of packages) {
        const location = path.join(directory, 'node_modules', pkg.name);
        if (await fs.realpath(location) !== location) throw new Error('Workspace package link is not an installed artifact: ' + pkg.name);
        const actual = await json(path.join(location, 'package.json'));
        if (actual.name !== pkg.name || actual.version !== pkg.version) throw new Error('Package identity mismatch: ' + pkg.name);
    }
    await fs.access(path.join(directory, 'node_modules/@agentina/aotui-ide/examples/local-scoped-ide.mjs'));
}

async function run(program, argv, cwd, env = process.env) {
    const child = spawn(program, argv, { cwd, env, stdio: 'inherit' });
    const interrupt = signal => child.kill(signal);
    const int = () => interrupt('SIGINT'), term = () => interrupt('SIGTERM');
    process.on('SIGINT', int); process.on('SIGTERM', term);
    try {
        await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} exited ${code ?? signal}`)));
        });
    } finally { process.off('SIGINT', int); process.off('SIGTERM', term); }
}

async function prepare() {
    if (!args[0] || args.slice(1).some(arg => arg !== '--offline')) throw new Error('prepare <delivery-directory> [--offline]');
    const delivery = await fs.realpath(path.resolve(args[0]));
    const artifacts = path.join(delivery, 'artifacts');
    const manifest = await json(path.join(artifacts, 'local-dev.json'));
    if (manifest.schemaVersion !== 1 || manifest.packages.length !== 3
        || expected.some(name => !manifest.packages.some(pkg => pkg.name === name))) throw new Error('Expected one Runtime, SDK and IDE package');
    const files = [['consumer-package.json', manifest.consumerManifestSha256], ['consumer-package-lock.json', manifest.consumerLockSha256]];
    for (const pkg of manifest.packages) {
        if (!/^[a-zA-Z0-9_.-]+\.tgz$/.test(pkg.filename)) throw new Error('Invalid package filename');
        files.push(['pack/' + pkg.filename, pkg.sha256]);
    }
    for (const [file, hash] of files) {
        if (!/^[a-f0-9]{64}$/.test(hash) || await digest(path.join(artifacts, file)) !== hash) throw new Error('Digest mismatch: ' + file);
    }
    const pkg = await json(path.join(artifacts, 'consumer-package.json'));
    for (const item of manifest.packages) {
        if (pkg.dependencies[item.name] !== 'file:../pack/' + item.filename) throw new Error('Consumer must use the exact local tar: ' + item.name);
    }
    const staging = path.join(workspace, 'preparing');
    await fs.mkdir(staging); // Refuse an unfinished prepare; never erase it implicitly.
    try {
        await fs.mkdir(path.join(staging, 'pack'));
        await fs.mkdir(path.join(staging, 'consumer'));
        for (const item of manifest.packages) await fs.copyFile(path.join(artifacts, 'pack', item.filename), path.join(staging, 'pack', item.filename));
        await fs.copyFile(path.join(artifacts, 'consumer-package.json'), path.join(staging, 'consumer/package.json'));
        await fs.copyFile(path.join(artifacts, 'consumer-package-lock.json'), path.join(staging, 'consumer/package-lock.json'));
        const userConfig = path.join(workspace, 'empty.npmrc'), globalConfig = path.join(workspace, 'global-empty.npmrc');
        await fs.writeFile(userConfig, ''); await fs.writeFile(globalConfig, '');
        const env = { ...process.env, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
            npm_config_cache: path.join(workspace, 'npm-cache') };
        await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', args.includes('--offline') ? '--offline' : '--prefer-offline'], path.join(staging, 'consumer'), env);
        if (await digest(path.join(staging, 'consumer/package-lock.json')) !== manifest.consumerLockSha256) throw new Error('npm changed the locked graph');
        await checkPackages(path.join(staging, 'consumer'), manifest.packages);
        await fs.writeFile(path.join(staging, 'source.json'), JSON.stringify({ delivery, preparedAt: new Date().toISOString(), ...manifest }, null, 2) + '\n');
        try {
            const old = await json(path.join(current, 'source.json'));
            if (old.schemaVersion !== 1) throw new Error('Unrecognized current environment');
            await fs.rm(current, { recursive: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(staging, current);
        console.log('Prepared explicit scoped IDE:', consumer);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function installed() {
    const source = await json(path.join(current, 'source.json'));
    await checkPackages(consumer, source.packages);
    return { ...process.env, PATH: path.join(consumer, 'node_modules/.bin') + path.delimiter + process.env.PATH };
}

async function verify() {
    if (args.length) throw new Error('verify takes no arguments');
    const env = await installed();
    const result = path.join(workspace, 'results', new Date().toISOString().replaceAll(/[:.]/g, '-'));
    const temp = path.join(result, 'tmp'); await fs.mkdir(temp, { recursive: true });
    const publicName = 'public-package-' + path.basename(result);
    const tests = [
        ['runtime/tests/w10-package-consumer.mjs', publicName + '.json', [consumer]],
        ['demo-apps/aotui-ide/tests/scoped-ide.e2e.mjs', 'full-ide.json', []],
        ['demo-apps/aotui-ide/tests/local-scoped-ide.e2e.mjs', 'local-entry.json', []],
    ];
    console.log('Verification evidence:', result);
    try {
        for (const [test, output, prefix] of tests) await run(process.execPath, [path.join(repo, test), ...prefix, path.join(result, output)], repo,
            { ...env, AOTUI_IDE_CONSUMER: consumer, TMPDIR: temp });
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
        await fs.rm(path.join(consumer, 'public-checks-' + publicName), { recursive: true, force: true });
    }
}

if (!command || command === '--help') {
    console.log('node scripts/scoped-ide.mjs prepare <delivery-directory> [--offline]\n'
        + 'node scripts/scoped-ide.mjs run --project <directory> [--data <directory>] [--session <key>]\n'
        + 'node scripts/scoped-ide.mjs verify\n'
        + 'One generated environment; explicit scoped route; original shared dist is not rebuilt.');
} else {
    let lock;
    try {
        if (!['prepare', 'run', 'verify'].includes(command)) throw new Error('Unknown command: ' + command);
        await fs.mkdir(path.dirname(workspace), { recursive: true });
        try {
            await fs.mkdir(workspace);
            await fs.writeFile(path.join(workspace, 'owner.json'), JSON.stringify({ original: repo, workspace }) + '\n');
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const owner = await json(path.join(workspace, 'owner.json'));
        if (owner.original !== repo || owner.workspace !== workspace) throw new Error('Unrecognized generated workspace owner');
        const lockPath = path.join(workspace, '.operation.lock');
        try { lock = await fs.open(lockPath, 'wx'); }
        catch (error) { if (error.code === 'EEXIST') throw new Error(`Environment is busy; inspect ${lockPath}. After an interrupted process, remove only this lock once its PID and descendants have exited.`); throw error; }
        await lock.writeFile(JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }) + '\n');
        try {
            if (command === 'prepare') await prepare();
            if (command === 'verify') await verify();
            if (command === 'run') {
                const env = await installed();
                const argv = args.some(arg => arg === '--data' || arg.startsWith('--data=')) ? args : [...args, '--data', path.join(workspace, 'data')];
                await run(process.execPath, [entry, ...argv], repo, env);
            }
        } finally { await lock.close(); lock = undefined; await fs.unlink(lockPath); }
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
    finally { await lock?.close(); }
}
