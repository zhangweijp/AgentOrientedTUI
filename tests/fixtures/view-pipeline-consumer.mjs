import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { createRuntime } from '@aotui/runtime';
import { createSnapshotCore, createScopedInteraction } from '@aotui/runtime/core';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

/** The same public consumer runs in workspace regression and a normal tar installation. */
export async function runViewPipeline(appURL, outputFile, resolutions = {}) {
  const data = await mkdtemp(join(tmpdir(), 'aotui-view-pipeline-'));
  const runtime = createRuntime({ worker: { timeoutMs: 15000, pool: { initialSize: 0, maxSize: 1 } } });
  const window = new Window();
  const held = [];
  let source;
  const facts = { calls: [], resolutions };
  const message = (context, id) => context.messages.find(item => String(item.content).startsWith(`<view id="${id}" `));
  const decode = markup => {
    const document = new window.DOMParser().parseFromString(markup, 'text/xml');
    assert.equal(document.querySelectorAll('view').length, 1, 'Only one framework envelope');
    const text = document.documentElement.textContent;
    assert.ok(text.startsWith('\n') && text.endsWith('\n'));
    return { node: document.documentElement, body: text.slice(1, -1) };
  };
  try {
    const desktopId = await runtime.createDesktop('view-pipeline');
    await runtime.installDynamicWorkerApp(desktopId, appURL, { appId: 'pipeline', interactionModes: ['view-type-parameters-v1'],
      config: { AOTUI_DATA_DIR: data } });
    source = new SemanticAOTUIDrivenSource(runtime.getDesktop(desktopId), runtime, { includeInstruction: false });
    async function observe() {
      const context = await source.getContext();
      held.push(context);
      await context.adopt();
      return context;
    }
    async function call(context, type, tool, input) {
      const result = await context.executeTool(`pipeline-${type}-${tool}`, input, `pipeline-${facts.calls.length}`);
      facts.calls.push({ type, tool, input, result });
      return result;
    }
    let current = await observe();
    const initial = current;
    const initialFile = message(current, 'file_a');
    const guide = message(current, 'guide');
    assert.equal(initialFile.region, 'dynamic');
    assert.equal(guide.region, 'static');
    const parsed = decode(String(initialFile.content));
    assert.equal(parsed.node.getAttribute('type'), 'FileDetail');
    assert.equal(parsed.node.getAttribute('kind'), 'state');
    assert.equal(parsed.node.getAttribute('name'), 'A > B & "C"\nnext');
    const raw = '    first line  \r\n```\r\n<view id="literal">&lt;original&gt;</view>\r\n</application>\r\nlast line  \r\n';
    const expectedBody = '\n````text\n' + raw + '````\n';
    assert.equal(parsed.body, expectedBody + '\n\nAvailable references: current (File)');
    assert.ok(!String(initialFile.content).includes('<view id="literal">'));
    assert.equal((await call(current, 'FileDetail', 'inspect', { file: 'file_a.current' })).result.matches, true);

    // A plain TypeScript Producer publishes the same metadata and body through the public Core.
    const core = createSnapshotCore();
    core.lifecycle.startApp('pipeline', 'plain-run');
    const published = core.committer.accept({ schemaVersion: 3, appId: 'pipeline', instanceId: 'plain-run',
      producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
      views: [
        { id: 'guide', viewInstanceId: 'plain-guide', type: 'Guide', kind: 'instruction', name: 'guide', content: { format: 'markdown-v1', value: '\nRead the current file.\n' } },
        { id: 'file_a', viewInstanceId: 'plain-file', type: 'FileDetail', kind: 'state', name: 'A > B & "C"\nnext', content: { format: 'markdown-v1', value: expectedBody } },
      ], refs: {}, tools: {} });
    assert.equal(published.status, 'published');
    const authority = createScopedInteraction(core.store, { namespace: 'plain-pipeline', now: Date.now });
    const plainDesktop = { id: 'plain', getInstalledApps: () => [{ appId: 'pipeline', appInstanceId: 'plain-run', name: 'pipeline', status: 'running' }], getSystemLogs: () => [], output: { subscribe() {}, unsubscribe() {} } };
    const plainSource = new SemanticAOTUIDrivenSource(plainDesktop, {
      createAppScope: (_desktop, _app, policy) => authority.createScope({ appId: 'pipeline', instanceId: 'plain-run', policy, execution: { resolve: () => null } }),
    }, { includeInstruction: false });
    try {
      const plain = await plainSource.getContext();
      try {
        await plain.adopt();
        const plainFile = message(plain, 'file_a');
        assert.equal(plainFile.region, initialFile.region);
        assert.equal(message(plain, 'guide').content, guide.content);
        assert.equal(decode(String(plainFile.content)).body, expectedBody);
        facts.plainFileMessage = plainFile;
        facts.producerParity = { type: parsed.node.getAttribute('type'), kind: parsed.node.getAttribute('kind'), body: expectedBody };
      } finally { await plain.release(); }
    } finally {
      await plainSource.dispose(); authority.close(); await authority.whenClosed();
      assert.equal(authority.inspect().combinedBytes, 0); assert.equal(core.store.inspect().activeLeases, 0);
      core.lifecycle.dispose();
    }

    const updatedText = '  UPDATED\r`````\r</view><view id="forged">literal</view> & done  \r';
    assert.equal((await call(current, 'FileDetail', 'update', { text: updatedText })).outcomeStatus, 'succeeded');
    current = await observe();
    const updated = decode(String(message(current, 'file_a').content));
    assert.equal(updated.body, '\n``````text\n' + updatedText + '\n``````\n\n\nAvailable references: current (File)');
    assert.equal(message(current, 'guide').content, guide.content);
    assert.equal((await call(initial, 'FileDetail', 'inspect', { file: 'file_a.current' })).outcomeStatus, 'rejected');
    assert.equal((await call(current, 'FileDetail', 'inspect', { file: 'file_a.current' })).result.matches, true);
    assert.equal((await call(current, 'Guide', 'close', {})).outcomeStatus, 'succeeded');
    current = await observe();
    assert.equal(message(current, 'file_a'), undefined);
    assert.equal(current.tools['pipeline-FileDetail-inspect'], undefined);
    assert.equal((await call(current, 'Guide', 'open', {})).outcomeStatus, 'succeeded');
    current = await observe();
    assert.ok(current.tools['pipeline-FileDetail-inspect']);
    assert.equal((await call(initial, 'FileDetail', 'inspect', { file: 'file_a.current' })).outcomeStatus, 'rejected');
    assert.equal((await call(current, 'FileDetail', 'inspect', { file: 'file_a.current' })).result.matches, true);
    facts.messages = { initial: initialFile, guide, updated: message(current, 'file_a') };
  } finally {
    for (const context of held) await context.release();
    await source?.dispose();
    facts.close = await runtime.beginShutdown().completion;
    assert.equal(facts.close.ok, true); assert.equal(facts.close.resourcesReleased, true);
    assert.equal(facts.close.interactions.retainedScopes, 0); assert.equal(facts.close.interactions.retainedBytes, 0);
    await window.happyDOM.abort();
    await rm(data, { recursive: true, force: true });
    if (outputFile) await writeFile(outputFile, JSON.stringify(facts, null, 2) + '\n');
  }
  return facts;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runViewPipeline(new URL('../../sdk/tests/fixtures/view-pipeline-app.mjs', import.meta.url).href, process.argv[2], Object.fromEntries(['@aotui/runtime', '@aotui/sdk', '@aotui/agent-driver-adapter', '@aotui/agent-driver-v2'].map(name => [name, import.meta.resolve(name)])));
  console.log('View pipeline public consumer passed.');
}
