import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { createRuntime } from '@aotui/runtime';
import { createViewOwnedTools } from '@aotui/core/producer';
import { projectNativeToolSchema } from '@aotui/runtime/adapters';
import { defineViewType, refParam } from '@aotui/sdk';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { runProviderTurn } from './scripted-provider-turn.mjs';

const checkListWords = process.argv.includes('--assert-list-words');
const runtime = createRuntime();
const runs = [];
let diagnostic, source, current, active;
const bytes = text => Buffer.byteLength(text, 'utf8');
const toolName = name => 'refs-Editor-' + name;
const textArgs = { path: 'dir/a.txt', text: 'files.items[0]' };
const expectedActions = ['dir/a.txt', 'review task', 'dir/a.txt,dir/b.txt',
  ...[[['dir/b.txt', 'dir/a.txt', 'dir/b.txt'], textArgs.path, textArgs.text],
    [null, textArgs.path, textArgs.text], [[], textArgs.path, textArgs.text]].map(value => JSON.stringify(value))];
const selections = [
  ['reorder', 'reverse', {}],
  ['wrong-type', 'select_file', { target: '$ref.refs.tasks_1.items' }, 'REF_TYPE_MISMATCH'],
  ['wrong-shape', 'select_all', { target: '$ref.refs.files_1.items[0]' }, 'REF_VALUE_UNSUPPORTED'],
  ['file', 'select_file', { target: '$ref.refs.files_1.items[0]' }],
  ['task', 'select_task', { target: '$ref.refs.tasks_1.items' }],
  ['all', 'select_all', { target: '$ref.refs.files_1.items' }],
  ['many', 'select_many', { ...textArgs, target: ['$ref.refs.files_1.items[1]', '$ref.refs.files_1.items[0]', '$ref.refs.files_1.items[1]'] }],
  ['omitted', 'select_many', textArgs],
  ['empty', 'select_many', { ...textArgs, target: [] }],
];

function checkSchemaCapacity() {
  const limit = 64 * 1024;
  const size = value => bytes(JSON.stringify(value));
  const modelSchemaFor = inputSchema => projectNativeToolSchema({ multiplicity: 'multiple',
    viewType: 'Capacity', inputSchema });
  const declaration = (refType, padding) => defineViewType()({ multiplicity: 'multiple',
    name: 'Capacity',
    tools: { read: {
      description: 'Read the selected value.',
      inputSchema: Type.Object({ target: refParam(refType, Type.Object({}, { additionalProperties: false })) }, { description: padding, additionalProperties: false }),
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
  const empty = modelSchemaFor(declaration('File', '').tools.read.inputSchema);
  const pad = n => '"'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2);
  const near = registered('File', pad(limit - size(empty)));
  const reachable = modelSchemaFor(near);
  assert.equal(size(reachable), limit);
  assert.throws(() => modelSchemaFor(registered('File', pad(limit - size(empty) + 1))),
    { code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED' });

  const longType = '界😀'.repeat(9000);
  const long = registered(longType, pad(limit - size(declaration(longType, '').tools.read.inputSchema)));
  const longWire = modelSchemaFor(long);
  assert.equal(size(long), limit);
  assert.equal(long.properties.target['x-aotui-ref-kind'], longType);
  assert.ok(!longWire.properties.target.description.includes(longType));
  assert.match(longWire.properties.target.description, /type-matched Ref/);
  return { limit, declarationBytes: size(near), receiverBytes: size(reachable),
    longTypeBytes: bytes(longType), longDeclarationBytes: size(long), longReceiverBytes: size(longWire),
    longHint: longWire.properties.target.description, extraReceiverCode: 'MODEL_TOOL_SCHEMA_UNSUPPORTED' };
}

try {
  const capacity = checkSchemaCapacity();
  const desktopId = (await runtime.createDesktop('ref-prompt')).id;
  const desktop = runtime.getDesktop(desktopId);
  const broken = new URL('./ref-prompt-broken/', import.meta.url);
  await mkdir(broken, { recursive: true });
  await writeFile(new URL('index.mjs', broken), "export { broken as default } from '../full-out/ref-prompt-app.js';\n");
  await writeFile(new URL('aoapp.json', broken), JSON.stringify({
    app_name: 'refs', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v9',
    appLifecycleSupport: 'app-lifecycle-v3', entry: { main: './index.mjs' },
  }));
  const brokenId = await desktop.registerPendingApp({ installationId: 'broken_refs', localPath: fileURLToPath(broken) });
  const failure = await desktop.openApp(brokenId).then(() => null, error => error);
  assert.equal(failure?.code, 'INSTALL_FAILED');
  let cause = failure;
  while (cause.cause) cause = cause.cause;
  diagnostic = { status: 'failed', issue: { code: cause.code, message: cause.message } };
  const detail = diagnostic.issue.message;
  assert.match(detail, /Ref ID|Ref id|Ref name/);
  assert.doesNotMatch(detail, /dir\/a\.txt/);
  assert.match(cause.path ?? detail, /items\.0/);

  const app = await desktop.installDynamicWorkerApp(new URL('./full-out/ref-prompt-app.js', import.meta.url).href,
    { installationId: 'refs_install', name: 'refs' });
  delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
  const adopt = desktop.adoptTurn.bind(desktop);
  desktop.adoptTurn = selection => {
    const result = adopt(selection);
    current?.adoptions.push(result.status);
    if (result.status !== 'adopted') return result;
    const { turn } = result;
    active = turn;
    return { ...result, turn: { ...turn, get isCurrent() { return turn.isCurrent; }, async invoke(appId, request, ...options) {
      const invoked = await turn.invoke(appId, request, ...options);
      current?.receipts.push({ request, result: invoked });
      return invoked;
    } } };
  };
  source = new SemanticAOTUIDrivenSource(desktop);

  async function run(label, window, calls = []) {
    const turn = { label, window, adoptions: [], receipts: [], toolResults: [] };
    current = turn;
    runs.push(turn);
    const replies = calls.map(([id, name, args]) => [id, toolName(name), { view_id: 'editor_1', ...args }]);
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
  const originalTurn = active;
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.body, complete.body);
  const wire = JSON.parse(accepted.body);
  assert.equal(wire.max_tokens, 256);
  const filesView = wire.messages.find(m => m.role === 'user' && m.content.startsWith('<view view_id="files_1"'));
  assert.match(filesView.content, /\[label\]\(items\[0\]\)/);
  assert.match(filesView.content, /protected \$ref\.refs\.files_1\.items \(File\[\]\)/);
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
  const latest = await app.observe();
  assert.equal(latest.status, 'prepared', JSON.stringify(latest.issue));
  const { observation } = latest.candidate;
  const observedSchemas = new Map(observation.tools.map(tool => [toolName(tool.name),
    JSON.parse(JSON.stringify(projectNativeToolSchema(tool))),
  ]));
  latest.candidate.discard();
  const schemas = Object.fromEntries(wire.tools.filter(({ function: tool }) => tool.name.startsWith('refs-Editor-select_'))
    .map(({ function: tool }) => {
      assert.deepEqual(tool.parameters, observedSchemas.get(tool.name));
      return [tool.name.slice('refs-Editor-select_'.length), tool.parameters];
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
  assert.match(params.file.description, /File Ref/);
  assert.match(params.task.description, /Task Ref/);
  assert.match(params.all.description, /File Ref/);
  assert.match(params.many.items.description, /File Ref/);
  for (const schema of [params.file, params.task, params.all, params.many.items])
    assert.match(schema.description, /\$ref\.app_id\.view_id\.ref_id/);


  assert.equal(accepted.receipts.length, selections.length);
  for (const [i, [id, name, args, code]] of selections.entries()) {
    const { request, result } = accepted.receipts[i];
    assert.equal(request.invocationId, id);
    assert.equal(request.viewId, 'editor_1');
    assert.deepEqual({ ...request.input }, args);
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
    const updated = next.messages.find(m => m.content.startsWith('<view view_id="editor_1"'));
    const actions = updated.content.split('\n').find(line => line.startsWith('['));
    assert.deepEqual(JSON.parse(actions), expectedActions);
    const original = accepted.receipts.find(({ request }) => request.invocationId === 'file').request;
    oldSource = await originalTurn.invoke(app.appId, { ...original, invocationId: 'old-source' });
    assert.equal(oldSource.code, 'TURN_NOT_ACTIVE', JSON.stringify(oldSource));
  } finally { await next.release(); }
  console.log(JSON.stringify({ diagnostic, threshold, runs, oldSource, expectedActions, params, capacity,
    wireBytes: bytes(accepted.body), toolsBytes: bytes(JSON.stringify(wire.tools)) }));
} finally {
  source?.dispose();
  const report = await runtime.beginClose().completion;
  assert.ok(report.ok && report.resourcesReleased, JSON.stringify(report));
}
