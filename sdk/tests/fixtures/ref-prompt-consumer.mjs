import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { createRuntime } from '@aotui/runtime';
import { createViewOwnedTools, modelToolSchema } from '@aotui/core';
import { defineViewType, refParam } from '@aotui/sdk';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { runProviderTurn } from './scripted-provider-turn.mjs';

const checkListWords = process.argv.includes('--assert-list-words');
const runtime = createRuntime();
const runs = [];
let diagnostic, source, current, client;
const bytes = text => Buffer.byteLength(text, 'utf8');
const toolName = name => 'refs-' + name;
const textArgs = { path: 'dir/a.txt', text: 'files.items[0]' };
const expectedActions = ['dir/a.txt', 'review task', 'dir/a.txt,dir/b.txt',
  ...[[['dir/b.txt', 'dir/a.txt', 'dir/b.txt'], textArgs.path, textArgs.text],
    [null, textArgs.path, textArgs.text], [[], textArgs.path, textArgs.text]].map(value => JSON.stringify(value))];
const selections = [
  ['reorder', 'reverse', {}],
  ['wrong-type', 'select_file', { target: '$refs.tasks.items' }, 'REF_TYPE_MISMATCH'],
  ['wrong-shape', 'select_all', { target: '$refs.files.items[0]' }, 'REF_VALUE_UNSUPPORTED'],
  ['file', 'select_file', { target: '$refs.files.items[0]' }],
  ['task', 'select_task', { target: '$refs.tasks.items' }],
  ['all', 'select_all', { target: '$refs.files.items' }],
  ['many', 'select_many', { ...textArgs, target: ['$refs.files.items[1]', '$refs.files.items[0]', '$refs.files.items[1]'] }],
  ['omitted', 'select_many', textArgs],
  ['empty', 'select_many', { ...textArgs, target: [] }],
];

function checkSchemaCapacity() {
  const limit = 64 * 1024;
  const size = value => bytes(JSON.stringify(value));
  const declaration = (refType, padding) => defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix,
    name: 'Capacity',
    tools: { read: {
      description: 'Read the selected value.',
      inputSchema: Type.Object({ target: refParam(refType, Type.Object({})) }, { description: padding }),
      execute: () => ({ success: true }),
    } },
  });
  const registered = (refType, padding) => {
    const viewType = declaration(refType, padding);
    const { inputSchema, description } = viewType.tools.read;
    const registry = createViewOwnedTools('capacity', 'capacity-1');
    try { registry.defineViewTypes([{ name: viewType.name, multiplicity: viewType.multiplicity, tools: [{ name: 'read', inputSchema, description }] }]); }
    finally { registry.dispose(); }
    return inputSchema;
  };
  const empty = modelToolSchema(declaration('File', '').tools.read.inputSchema, 'Capacity', 'multiple');
  const pad = n => '"'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2);
  const near = registered('File', pad(limit - size(empty)));
  const reachable = modelToolSchema(near, 'Capacity', 'multiple');
  assert.equal(size(reachable), limit);
  assert.throws(() => registered('File', pad(limit - size(empty) + 1)), { code: 'TOOL_SCHEMA_CAPACITY' });

  const longType = '界😀'.repeat(9000);
  const long = registered(longType, pad(limit - size(declaration(longType, '').tools.read.inputSchema)));
  const longWire = modelToolSchema(long, 'Capacity', 'multiple');
  assert.equal(size(long), limit);
  assert.equal(long.properties.target['x-aotui-ref-kind'], longType);
  assert.ok(!longWire.properties.target.description.includes(longType));
  assert.match(longWire.properties.target.description, /Value shape object/);
  return { limit, declarationBytes: size(near), receiverBytes: size(reachable),
    longTypeBytes: bytes(longType), longDeclarationBytes: size(long), longReceiverBytes: size(longWire),
    longHint: longWire.properties.target.description, extraReceiverCode: 'TOOL_SCHEMA_CAPACITY' };
}

try {
  const capacity = checkSchemaCapacity();
  const desktopId = await runtime.createDesktop('ref-prompt');
  const desktop = runtime.getDesktop(desktopId);
  const broken = new URL('./ref-prompt-broken/', import.meta.url);
  await mkdir(broken, { recursive: true });
  await writeFile(new URL('index.mjs', broken), "export { broken as default } from '../full-out/ref-prompt-app.js';\n");
  await writeFile(new URL('aoapp.json', broken), JSON.stringify({
    app_name: 'refs', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v7',
    appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './index.mjs' },
  }));
  const brokenId = await desktop.registerPendingApp({ installationId: 'broken_refs', localPath: fileURLToPath(broken) });
  const failure = await desktop.openApp(brokenId).then(() => null, error => error);
  assert.equal(failure?.code, 'INSTALL_FAILED');
  let cause = failure;
  while (cause.cause) cause = cause.cause;
  diagnostic = { status: 'failed', issue: { code: cause.code, message: cause.message } };
  const detail = diagnostic.issue.message;
  assert.match(detail, /Ref Hooks must be used inside|useArrayRef/);
  assert.doesNotMatch(detail, /dir\/a\.txt/);
  assert.match(detail, /useArrayRef.*"items"/);
  assert.match(detail, /child of <View>/);

  await runtime.installDynamicWorkerApp(desktopId, new URL('./full-out/ref-prompt-app.js', import.meta.url).href,
    { installationId: 'refs_install', name: 'refs' });
  const app = desktop.getInstalledApps().find(app => app.appId === 'refs');
  const access = runtime.getAppInteraction(desktopId, app.appId, app.appInstanceId);
  assert.equal(access.status, 'ready');
  client = access.interaction;
  delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
  source = new SemanticAOTUIDrivenSource({
    id: desktop.id, output: desktop.output, getInstalledApps: () => desktop.getInstalledApps(),
    getAppWindows: (appId, instanceId) => desktop.getAppWindows(appId, instanceId),
    getSystemLogs: () => desktop.getSystemLogs(),
    bindRequestSources: ({ apps }) => desktop.bindRequestSources({ apps: apps.map(({ observationId }) => ({ client, observationId })) }),
  }, { getAppInteraction(id, appId, instanceId) {
    const result = runtime.getAppInteraction(id, appId, instanceId);
    if (result.status !== 'ready' || appId !== app.appId) return result;
    return { ...result, interaction: { ...client,
      adoptObservation(id, windows) {
        const adopted = client.adoptObservation(id, windows);
        current?.adoptions.push(adopted.status);
        return adopted;
      },
      async invoke(request, timeout, sources) {
        const result = await client.invoke(request, timeout, sources);
        current?.receipts.push({ request, result });
        return result;
      },
    } };
  } });

  async function run(label, window, calls = []) {
    const turn = { label, window, adoptions: [], receipts: [], toolResults: [] };
    current = turn;
    runs.push(turn);
    const replies = calls.map(([id, name, args]) => [id, toolName(name), { view_id: 'editor', ...args }]);
    try { await runProviderTurn(source, turn, replies, () => assert.deepEqual(turn.adoptions, ['adopted'])); }
    finally { current = undefined; }
    return turn;
  }

  const refused = await run('insufficient', 1024);
  assert.equal(refused.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
  const { inputBytes, safety, outputReserved } = refused.error.details;
  const below = await run('one-below-smallest-measured-request', inputBytes + safety + outputReserved - 1);
  assert.equal(below.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
  assert.equal(below.error.details.inputLimit, inputBytes + safety - 1);
  for (const denied of [refused, below]) {
    assert.equal(denied.body, undefined);
    assert.deepEqual(denied.adoptions, []);
  }
  const complete = await run('measure-the-complete-request', 100_000);
  assert.equal(complete.error, undefined);
  const sample = JSON.parse(complete.body);
  const fullBytes = bytes(complete.body);
  const fullMargin = Math.max(256, Math.ceil(fullBytes * 0.05)) + 8 * (sample.messages.length + sample.tools.length);
  const threshold = fullBytes + fullMargin + outputReserved;
  const accepted = await run('at-the-complete-request-threshold', threshold, selections);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.body, complete.body);
  const wire = JSON.parse(accepted.body);
  assert.equal(wire.max_tokens, 256);
  const filesView = wire.messages.find(m => m.role === 'user' && m.content.startsWith('<view view_id="files"'));
  assert.match(filesView.content, /\[label\]\(items\[0\]\)/);
  assert.match(filesView.content, /\[all files\]\(protected items: File\[\]\)/);
  assert.ok(filesView.content.includes('\n- password\n'));
  if (checkListWords) {
    for (const line of ['- test.txt — View editor', '- FileDetail: edit, close', '- **Status:** ready',
      '- Open [label](items[0]) &amp; ``  say ` hi  ``', '    1. password',
      '    2. *Choose* [other file](items[1])']) {
      assert.ok(filesView.content.includes(line + '\n'), 'Missing list line ' + line);
    }
    const rows = ['Open file', 'Open file', '**Status:** ready', 'password', 'Nested file', 'State *ready* now',
      '*password*', '[Open](#editor) editor', 'Move ``  say ` hi  `` to [inline ref](items[0])'];
    assert.ok(filesView.content.includes(rows.map(row => '- ' + row + '\n').join('')));
    assert.ok(filesView.content.includes('- Inline boundaries\n' +
      rows.map((row, index) => '    ' + (index + 1) + '. ' + row + '\n').join('')));
  }
  const latest = await client.observe({ all: true });
  assert.equal(latest.status, 'observed', JSON.stringify(latest.issue));
  const observedSchemas = new Map(latest.observation.tools.map(tool => [
    toolName(tool.name), JSON.parse(JSON.stringify(tool.inputSchema)),
  ]));
  client.releaseObservation(latest.observation.observationId);
  const schemas = Object.fromEntries(wire.tools.filter(({ function: tool }) => tool.name.startsWith('refs-select_'))
    .map(({ function: tool }) => {
      assert.deepEqual(tool.parameters, observedSchemas.get(tool.name));
      return [tool.name.slice('refs-select_'.length), tool.parameters];
    }));
  const params = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, schema.properties.target]));
  for (const key of ['all', 'file', 'task']) {
    assert.equal(params[key].type, 'string');
    assert.match(params[key].description, /^Choose the source\. /);
    assert.ok(schemas[key].required.includes('target'));
  }
  assert.equal(params.many.type, 'array');
  assert.equal(params.many.items.type, 'string');
  assert.equal(params.many.description, 'Choose the source.');
  assert.ok(!schemas.many.required.includes('target'));
  assert.equal(schemas.many.properties.path.type, 'string');
  assert.equal(schemas.many.properties.text.type, 'string');
  assert.match(params.file.description, /"File".*object/);
  assert.match(params.task.description, /"Task".*object/);
  assert.match(params.all.description, /"File".*array/);
  assert.match(params.many.items.description, /"File".*object/);
  for (const schema of [params.file, params.task, params.all, params.many.items])
    assert.match(schema.description, /\$app_id\.view_id\.ref_id/);


  assert.equal(accepted.receipts.length, selections.length);
  for (const [i, [id, name, args, code]] of selections.entries()) {
    const { request, result } = accepted.receipts[i];
    assert.equal(request.invocationId, id);
    assert.deepEqual({ ...request.input }, { view_id: 'editor', ...args });
    assert.equal(result.kind, 'receipt');
    if (!code) assert.equal(result.receipt.outcome.status, 'succeeded', name + ': ' + JSON.stringify(result));
    else {
      assert.equal(result.receipt.executionPhase, 'not-dispatched');
      assert.equal(result.receipt.outcome.code, code);
      assert.equal(accepted.toolResults[i].error.code, code);
      assert.match(accepted.toolResults[i].error.message, /File|target/);
    }
  }
  const next = await source.getContext();
  let oldSource;
  try {
    await next.adopt();
    const updated = next.messages.find(m => m.content.startsWith('<view view_id="editor"'));
    const actions = updated.content.split('\n').find(line => line.startsWith('['));
    assert.deepEqual(JSON.parse(actions), expectedActions);
    const original = accepted.receipts.find(({ request }) => request.invocationId === 'file').request;
    oldSource = await client.invoke({ ...original, invocationId: 'old-source' });
    assert.equal(oldSource.kind, 'refused', JSON.stringify(oldSource));
  } finally { await next.release(); }
  console.log(JSON.stringify({ diagnostic, threshold, runs, oldSource, expectedActions, params, capacity,
    wireBytes: bytes(accepted.body), toolsBytes: bytes(JSON.stringify(wire.tools)) }));
} finally {
  source?.dispose();
  const report = await runtime.beginShutdown().completion;
  assert.ok(report.ok && report.resourcesReleased, JSON.stringify(report));
}
