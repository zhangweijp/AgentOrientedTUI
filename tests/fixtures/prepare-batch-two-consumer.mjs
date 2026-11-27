import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const folder = resolve(process.argv[2]);
const refContract = process.argv[3] === 'batch-three';
const windows = process.argv[3] === 'batch-four';
const markdown = process.argv[3] === 'batch-five';
const usage = process.argv[3] === 'batch-six';
const owners = process.argv[3] === 'batch-seven';
const scopedConsole = process.argv[3] === 'batch-nine';
const consoleBatch = process.argv[3] === 'batch-eight' || scopedConsole;
const projection = process.argv[3] === 'batch-twelve';
const product = refContract || usage || owners || consoleBatch || projection || (markdown && process.argv.includes('--product'));
await mkdir(folder, { recursive: true });
await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'aotui-batch-two-check', private: true, type: 'module' }));
const packs = ['core', 'runtime', 'sdk', ...(product ? ['agent-driver-v2', 'agent-driver-adapter'] : [])].map(name => {
    const tarball = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', folder],
        { cwd: join(root, name), encoding: 'utf8' }).trim();
    return join(folder, tarball);
});
const run = (cmd, args) => execFileSync(cmd, args, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', ...packs,
    'typebox@1.4.3', 'typescript@7.0.2', '@types/node@24',
    ...(markdown ? ['marked@17.0.3', 'linkedom@0.18.12'] : [])]);
await writeFile(join(folder, 'installed.json'), run('npm', ['ls', '--all', '--json']));
const apps = ['batch-two-contacts.ts', 'batch-two-mail.ts'];
for (const name of apps) await cp(join(root, 'sdk', 'tests', 'fixtures', name), join(folder, name));
for (const name of ['batch-two-support.mjs', 'batch-two-public-host.mjs']) await cp(new URL(name, import.meta.url), join(folder, name));
await writeFile(join(folder, 'request-contract.ts'), `
import type { ActiveTurn, AppInteractionPolicy, IDesktop, IKernel, RunningApp } from '@aotui/runtime';
export const desktopFor = (runtime: IKernel, policy: AppInteractionPolicy) =>
  runtime.createDesktop({ policyForApp: ({ installationId }) => {
    if (!installationId) throw Error('Expected an installation identity');
    return policy;
  } });
export async function call(desktop: IDesktop, source: RunningApp, target: RunningApp) {
  const contact = await source.observe();
  if (contact.status === 'rejected') throw Error(contact.issue.message);
  const mail = await target.observe();
  if (mail.status === 'rejected') {
    contact.candidate.discard();
    throw Error(mail.issue.message);
  }
  const adopted = desktop.adoptTurn({ apps: [{ candidate: contact.candidate }, { candidate: mail.candidate }] });
  if (adopted.status === 'rejected') {
    contact.candidate.discard();
    mail.candidate.discard();
    throw Error(adopted.issue.message);
  }
  const turn: ActiveTurn = adopted.turn;
  try {
    const result = await turn.invoke(target.appId, { observationId: mail.candidate.observation.observationId,
      toolId: 'tool', invocationId: 'call', input: { to: '$ref.contacts.list.emails' } });
    if (result.kind !== "refused" && result.locator) return desktop.readReceipt(result.locator);
    return result;
  } finally { turn.release(); }
}
`);
run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022',
    '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', ...apps, 'request-contract.ts']);
async function readmeExample(heading, file) {
    const readme = await readFile(join(folder, 'node_modules', '@aotui', 'runtime', 'README.md'), 'utf8');
    const example = readme.split('\n### ' + heading + '\n')[1]?.match(/```ts\n([\s\S]+?)\n```/)?.[1];
    if (!example) throw new Error('No runnable example for ' + heading + ' in the installed Runtime README');
    await writeFile(join(folder, file), example + '\n');
}
if (refContract) {
    const refApps = ['batch-three-contacts.ts', 'batch-three-mail.ts'];
    for (const name of refApps) await cp(join(root, 'sdk', 'tests', 'fixtures', name), join(folder, name));
    for (const name of ['batch-three-public-host.mjs', 'batch-three-strict.mjs', 'trace-batch-three-worker.mjs'])
        await cp(new URL(name, import.meta.url), join(folder, name));
    await readmeExample('Bind Console input to the current request', 'batch-three-readme.ts');
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false',
        '--target', 'ES2022', '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', ...refApps, 'batch-three-readme.ts']);
}
if (windows) {
    await cp(join(root, 'sdk', 'tests', 'fixtures', 'batch-four-files.ts'), join(folder, 'batch-four-files.ts'));
    for (const name of ['batch-four-support.mjs', 'batch-four-public-host.mjs'])
        await cp(new URL(name, import.meta.url), join(folder, name));
    await readmeExample('Present and manage windows', 'batch-four-readme.ts');
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022',
        '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', 'batch-four-files.ts', 'batch-four-readme.ts']);
}
if (usage || owners || consoleBatch) {
    await cp(join(root, 'sdk', 'tests', 'fixtures', 'batch-four-files.ts'), join(folder, 'batch-four-files.ts'));
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022',
        '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', 'batch-four-files.ts']);
}
if (consoleBatch) {
    const fixtures = ['batch-eight-catalog.ts', 'batch-eight-tasks.ts'];
    for (const name of fixtures) await cp(join(root, 'sdk', 'tests', 'fixtures', name), join(folder, name));
    for (const name of ['batch-eight-support.mjs', 'batch-eight-public-host.mjs', 'batch-eight-sandbox.mjs'])
        await cp(new URL(name, import.meta.url), join(folder, name));
    const readme = await readFile(join(folder, 'node_modules', '@aotui', 'agent-driver-adapter', 'README.md'), 'utf8');
    const example = readme.split('\n### One-shot Console\n')[1]?.match(/```js\n([\s\S]+?)\n```/)?.[1];
    if (!example) throw new Error('Missing installed Console README example');
    await writeFile(join(folder, 'batch-eight-readme.mjs'), example + '\n');
    if (scopedConsole) {
        for (const name of ['batch-nine-support.mjs', 'batch-nine-public-host.mjs', 'batch-nine-process.mjs'])
            await cp(new URL(name, import.meta.url), join(folder, name));
        const scoped = readme.split('\n### Scoped Console\n')[1]?.match(/```js\n([\s\S]+?)\n```/)?.[1];
        if (!scoped) throw new Error('Missing installed scoped Console README example');
        await writeFile(join(folder, 'batch-nine-readme.mjs'), scoped + '\n');
    }
    await readmeExample('Bind Console input to the current request', 'batch-eight-runtime-readme.ts');
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false',
        '--target', 'ES2022', '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', ...fixtures,
        'batch-eight-runtime-readme.ts']);
}
if (usage) {
    await cp(new URL('batch-six-driver-usage.mjs', import.meta.url), join(folder, 'batch-six-driver-usage.mjs'));
    await cp(new URL('batch-six-usage-support.mjs', import.meta.url), join(folder, 'batch-six-usage-support.mjs'));
    await cp(new URL('batch-six-usage-contract.ts', import.meta.url), join(folder, 'batch-six-usage-contract.ts'));
}
if (owners) {
    const contract = 'batch-seven-runtime-contract.ts';
    await cp(new URL(contract, import.meta.url), join(folder, contract));
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false',
        '--target', 'ES2022', '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', contract]);
}
if (markdown) {
    const examples = ['batch-five-content.ts', 'batch-five-plain.ts', 'batch-five-inventory.ts'];
    for (const name of examples) await cp(join(root, 'sdk', 'tests', 'fixtures', name), join(folder, name));
    await cp(new URL('batch-five-host.mjs', import.meta.url), join(folder, 'batch-five-host.mjs'));
    run(join(folder, 'node_modules', '.bin', 'tsc'), ['--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022',
        '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', ...examples]);
}
if (projection) {
    for (const name of ['batch-twelve-prepare.mjs', 'batch-twelve-public-host.mjs', 'batch-ten-delivery.mjs'])
        await cp(new URL(name, import.meta.url), join(folder, name));
    const sdk = JSON.parse(await readFile(join(folder, 'node_modules/@aotui/sdk/package.json'), 'utf8'));
    const app = join(folder, 'todo-source'), source = 'batch-twelve-todo.ts';
    await mkdir(app);
    await cp(join(root, 'sdk/tests/fixtures', source), join(app, source));
    await writeFile(join(app, 'package.json'), JSON.stringify({
        name: 'aotui-todo-prepare', version: '0.1.0', type: 'module', main: './dist/batch-twelve-todo.js',
        aotui: { app_name: 'tasks' },
        types: './dist/batch-twelve-todo.d.ts', files: ['aoapp.json', 'dist'],
        dependencies: { '@aotui/sdk': sdk.version, typebox: '1.4.3' },
    }));
    await writeFile(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ['node'], target: 'ES2022', module: 'NodeNext',
        lib: ['ES2022'], declaration: true, outDir: 'dist',
    }, files: [source] }));
    run(join(folder, 'node_modules/.bin/tsc'), ['-p', join(app, 'tsconfig.json')]);
    run(join(folder, 'node_modules/.bin/generate-aoapp'), [app]);
    const archive = join(folder, run('npm', ['pack', '--ignore-scripts', '--silent', app]).trim());
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', archive]);
    await writeFile(join(folder, 'installed.json'), run('npm', ['ls', '--all', '--json']));
}
