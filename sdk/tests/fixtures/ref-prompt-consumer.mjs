import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { AppRegistry, createRuntime } from '@aotui/runtime';
import { createViewOwnedTools, modelToolSchema } from '@aotui/runtime/core';
import { defineViewType, getToolCatalog, refParam } from '@aotui/sdk';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { viewTypes } from './full-out/ref-prompt-app.js';

const checkChangedHints = process.argv.includes('--assert-hints');
const runtime = createRuntime();
const beforeFetch = globalThis.fetch;
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
  ['wrong-type', 'select_file', { target: 'tasks.items' }, 'REF_TYPE_MISMATCH'],
  ['wrong-shape', 'select_all', { target: 'files.items[0]' }, 'REF_VALUE_UNSUPPORTED'],
  ['file', 'select_file', { target: 'files.items[0]' }],
  ['task', 'select_task', { target: 'tasks.items' }],
  ['all', 'select_all', { target: 'files.items' }],
  ['many', 'select_many', { ...textArgs, target: ['files.items[1]', 'files.items[0]', 'files.items[1]'] }],
  ['omitted', 'select_many', textArgs],
  ['empty', 'select_many', { ...textArgs, target: [] }],
];

function checkSchemaCapacity() {
  const limit = 64 * 1024;
  const size = value => bytes(JSON.stringify(value));
  const declaration = (refType, padding) => defineViewType()({
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
    try { registry.defineTools([{ name: 'read', viewType: viewType.name, inputSchema, description }]); }
    finally { registry.dispose(); }
    return { inputSchema, staticSchema: getToolCatalog([viewType])[0].inputSchema };
  };
  const receivers = ['editor'];
  const empty = modelToolSchema(declaration('File', '').tools.read.inputSchema, 'Capacity', receivers);
  const priorHint = 'A visible Ref address as view_id.ref_id. Use the containing View id and the exact local Ref name, including any index.';
  const legacy = { ...empty, properties: { ...empty.properties, target: { ...empty.properties.target, description: priorHint } } };
  const pad = n => '"'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2);
  const near = registered('File', pad(limit - size(legacy)));
  const reachable = modelToolSchema(near.inputSchema, 'Capacity', receivers);
  assert.equal(size(reachable), size({ ...legacy, description: near.inputSchema.description }) +
    size(reachable.properties.target.description) - size(priorHint));
  if (checkChangedHints) assert.ok(size(reachable) < limit);
  else assert.equal(size(reachable), limit);
  assert.throws(() => modelToolSchema(near.inputSchema, 'Capacity', [...receivers, 'another_eligible_receiver']),
    { code: 'TOOL_SCHEMA_CAPACITY' });

  const longType = '界😀'.repeat(9000);
  const long = registered(longType, pad(limit - size(declaration(longType, '').tools.read.inputSchema)));
  const longWire = modelToolSchema(long.inputSchema, 'Capacity', receivers);
  assert.equal(size(long.inputSchema), limit);
  assert.equal(long.inputSchema.properties.target['x-aotui-ref-kind'], longType);
  assert.ok(!longWire.properties.target.description.includes(longType));
  if (checkChangedHints) assert.match(longWire.properties.target.description, /Value shape object/);
  return { limit, declarationBytes: size(near.inputSchema), staticBytes: size(near.staticSchema), receiverBytes: size(reachable),
    longTypeBytes: bytes(longType), longDeclarationBytes: size(long.inputSchema), longReceiverBytes: size(longWire),
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
    app_name: 'refs', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v6',
    appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './index.mjs' },
  }));
  const registry = new AppRegistry();
  await registry.registerTransient('local:' + fileURLToPath(broken));
  [diagnostic] = await registry.installAll(desktop);
  assert.equal(diagnostic.status, 'failed');
  const detail = diagnostic.issue.message;
  assert.match(detail, /Ref Hooks must be used inside|useArrayRef/);
  assert.doesNotMatch(detail, /dir\/a\.txt/);
  if (checkChangedHints) {
    assert.match(detail, /useArrayRef.*"items"/);
    assert.match(detail, /child of <View>/);
  }

  await runtime.installDynamicWorkerApp(desktopId, new URL('./full-out/ref-prompt-app.js', import.meta.url).href,
    { appId: 'refs', name: 'refs' });
  const app = desktop.getInstalledApps().find(app => app.appId === 'refs');
  const access = runtime.getAppInteraction(desktopId, app.appId, app.appInstanceId);
  assert.equal(access.status, 'ready');
  client = access.interaction;
  delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
  source = new SemanticAOTUIDrivenSource(desktop, { getAppInteraction(id, appId, instanceId) {
    const result = runtime.getAppInteraction(id, appId, instanceId);
    if (result.status !== 'ready' || appId !== app.appId) return result;
    return { ...result, interaction: { ...client,
      adoptObservation(id) {
        const adopted = client.adoptObservation(id);
        current?.adoptions.push(adopted.status);
        return adopted;
      },
      async invoke(request) {
        const result = await client.invoke(request);
        current?.receipts.push({ request, result });
        return result;
      },
    } };
  } });

  async function run(label, window, calls = []) {
    const turn = { label, window, adoptions: [], receipts: [], toolResults: [] };
    current = turn;
    runs.push(turn);
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.deepEqual(turn.adoptions, ['adopted']);
      assert.equal(turn.body, undefined);
      turn.body = init.body;
      const delta = calls.length ? { tool_calls: calls.map(([id, name, args], index) => ({
        id, index, type: 'function', function: { name: toolName(name), arguments: JSON.stringify({ view_id: 'editor', ...args }) },
      })) } : { content: 'Done' };
      const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'ref-fixture', model: 'fixture', created: 1,
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      return new Response(chunk(delta, null) + chunk({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const finished = Promise.withResolvers();
    const driver = new AgentDriverV2({
      sources: [{ name: 'history', onUpdate: () => () => {}, getContext: () => ({
        messages: [{ role: 'user', content: 'Select visible items.', timestamp: 2 }], tools: {},
      }) }, { name: source.name, onUpdate: () => () => {}, async getContext() {
        const context = await source.getContext();
        return { ...context, async release() { await context.release(); finished.resolve(); },
          async executeTool(...args) {
            const result = await context.executeTool(...args);
            turn.toolResults.push(result);
            return result;
          } };
      } }],
      llm: { model: 'fixture', provider: { id: 'ref-test', baseURL: 'https://fixture.invalid/v1' }, apiKey: 'fixture',
        inputBudget: () => ({ contextWindow: window, maxOutputTokens: 256 }) },
      onRunError(error) { turn.error = { code: error.code, message: error.message, details: error.details }; },
    });
    const timer = setTimeout(() => finished.reject(new Error('Context was not released for ' + label)), 10000);
    try { await Promise.all([driver.trigger(), finished.promise]); }
    finally { clearTimeout(timer); driver.stop(); driver.dispose(); current = undefined; }
    return turn;
  }

  const refused = await run('insufficient', 1024);
  assert.equal(refused.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
  const { inputBytes, safety, outputReserved } = refused.error.details;
  const threshold = inputBytes + safety + outputReserved;
  const below = await run('one-below-threshold', threshold - 1);
  assert.equal(below.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
  assert.equal(below.error.details.inputLimit, inputBytes + safety - 1);
  for (const denied of [refused, below]) {
    assert.equal(denied.body, undefined);
    assert.deepEqual(denied.adoptions, []);
  }
  const accepted = await run('at-threshold', threshold, selections);
  assert.equal(accepted.error, undefined);
  const wire = JSON.parse(accepted.body);
  assert.equal(wire.max_tokens, 256);
  const filesView = wire.messages.find(m => m.role === 'user' && m.content.startsWith('<view id="files"'));
  assert.match(filesView.content, /\[label\]\(File:items\[0\]\)/);
  assert.match(filesView.content, /\[all files\]\(File\[\]:items\)/);
  const catalog = getToolCatalog(viewTypes);
  const schemas = Object.fromEntries(wire.tools.filter(({ function: tool }) => tool.name.startsWith('refs-select_'))
    .map(({ function: tool }) => {
      const staticSchema = catalog.find(entry => toolName(entry.name) === tool.name).inputSchema;
      assert.deepEqual(tool.parameters, { ...staticSchema, properties: { ...staticSchema.properties,
        view_id: { ...staticSchema.properties.view_id, enum: ['editor'] } } });
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
  assert.deepEqual(schemas.many.properties.path, { type: 'string' });
  assert.deepEqual(schemas.many.properties.text, { type: 'string' });
  if (checkChangedHints) {
    assert.match(params.file.description, /"File".*object/);
    assert.match(params.task.description, /"Task".*object/);
    assert.match(params.all.description, /"File".*array/);
    assert.match(params.many.items.description, /"File".*object/);
    for (const schema of [params.file, params.task, params.all, params.many.items])
      assert.match(schema.description, /source View id/);
  } else {
    assert.deepEqual(params.file, params.task);
    assert.deepEqual(params.file, params.all);
  }

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
    const updated = next.messages.find(m => m.content.startsWith('<view id="editor"'));
    const actions = updated.content.split('\n').find(line => line.startsWith('['));
    assert.deepEqual(JSON.parse(actions), expectedActions);
    const original = accepted.receipts.find(({ request }) => request.invocationId === 'file').request;
    oldSource = await client.invoke({ ...original, invocationId: 'old-source' });
    assert.equal(oldSource.kind, 'refused', JSON.stringify(oldSource));
  } finally { await next.release(); }
  console.log(JSON.stringify({ diagnostic, threshold, runs, oldSource, expectedActions, params, capacity,
    wireBytes: bytes(accepted.body), toolsBytes: bytes(JSON.stringify(wire.tools)) }));
} finally {
  globalThis.fetch = beforeFetch;
  source?.dispose();
  const report = await runtime.beginShutdown().completion;
  assert.ok(report.ok && report.resourcesReleased, JSON.stringify(report));
}
