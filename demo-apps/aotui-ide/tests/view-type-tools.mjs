import assert from 'node:assert/strict';
import { createApp, createView } from '@aotui/sdk/app';
import { WorkspaceType, FileDetailType, SearchResultType, WorkspaceCreateType } from '../dist/tui/ide-tool-contracts.js';

async function prepareTools(type, viewId, context) {
  let bindings;
  const factory = createApp({
    app_name: 'ide_tool_fixture',
    viewTypes: [type],
    initialize({ prepareProjection }) {
      prepareProjection({ views: [createView(type, { ...(type.multiplicity === 'single' ? { id: viewId } : { idPrefix: viewId }), region: 'dynamic', render: () => ({ body: '', context }) })] });
    },
  });
  await factory.initialize({
    appLifecycle: { protocol: factory.appLifecycleSupport, register() {} },
    defineViewTypes() {},
    signal: new AbortController().signal,
    publishFrame(build) {
      bindings = build().views[0].bindings;
      return { status: 'prepared', sourceEpoch: 1 };
    },
  });
  return Object.fromEntries(bindings.map(binding => [binding.name, binding]));
}

const prepareFileTools = (owner, path, viewId, diagnostics = true) =>
  prepareTools(FileDetailType, viewId, { owner, file: { observed: { path }, key: 'slot:' + path }, diagnostics });

async function main() {
  let createResult = { success: true, data: { filePath: '/work/new.txt' } };
  let hoverValue = { contents: 'secret LSP payload' };
  const createCalls = [];
  const loadedViews = new Map([
    ['/work/open.ts', 'fd_actual_17'],
    ['/work/rename.ts', 'fd_actual_23'],
  ]);
  const success = data => ({ success: true, data });
  const owner = {
    roots: ['/work'], files: loadedViews, live: true, ready: true,
    invoke: async (name, args, receiver) => {
      const path = receiver?.startsWith('slot:') ? receiver.slice('slot:'.length) : undefined;
      if (name === 'lsp_hover') return success({ documentVersion: 1, value: hoverValue });
      if (name === 'search_files_by_pattern') return success({ paths: ['/work/a.ts'], total: 1 });
      if (name === 'search_files_by_content') return success({ paths: ['/work/a.ts'], matches: [{ line: 1, text: 'secret match payload' }] });
      if (name === 'batch_edit') return success({ results: [{ index: 0, status: 'succeeded', content: 'secret edited content' }] });
      if (name === 'edit_file') return success({ filePath: path, diskCommitted: true, warnings: [] });
      if (name === 'delete_file') {
        loadedViews.delete(path);
        return success({ filePath: path, diskCommitted: true, warnings: [] });
      }
      if (name === 'rename_file') {
        const viewId = loadedViews.get(path);
        loadedViews.delete(path);
        if (viewId) loadedViews.set(args.newPath, viewId);
        return success({ filePath: args.newPath, diskCommitted: true, warnings: [] });
      }
      if (name === 'close_file_detail') {
        loadedViews.delete(path);
        return success({ closed: 1 });
      }
      return success({});
    },
    getLoadedFileViewId: filePath => loadedViews.get(filePath),
    readLoadedDiagnostics: () => ({ success: true, data: {} }),
    createWorkspaceFile: async (...args) => { createCalls.push(args); return createResult; },
  };

  for (const definition of [WorkspaceType, FileDetailType, SearchResultType]) {
    assert.ok(Object.keys(definition.tools).length > 0);
  }
  const bindings = await prepareTools(WorkspaceType, 'workspace', owner);
  const opened = await prepareFileTools(owner, '/work/open.ts', 'fd_actual_17');
  const rename = await prepareFileTools(owner, '/work/rename.ts', 'fd_actual_23', false);
  assert.equal(opened.read_loaded_diagnostics.enabled, true);
  assert.equal(rename.read_loaded_diagnostics.enabled, false);
  const batchEdit = WorkspaceType.tools.batch_edit;
  assert.deepEqual({ ...batchEdit.inputSchema.properties.edits.items }, { type: 'object' },
    'batch fields stay opaque and are validated by IDESession');

  const expectedReceipt = (name, viewId) => ({
    success: true,
    data: {
      message: `${name} completed. Read the current IDE Views for the updated state.`,
      view_id: viewId,
    },
  });

  const patternResult = await bindings.search_files_by_pattern.execute({ pattern: '**/*.ts' });
  assert.deepEqual(patternResult, expectedReceipt('search_files_by_pattern', 'search'),
    'pattern search returns a receipt, not the business result collection');
  const contentResult = await bindings.search_files_by_content.execute({ pattern: 'secret' });
  assert.deepEqual(contentResult, expectedReceipt('search_files_by_content', 'search'),
    'content search results are projected through SearchResult only');
  const batchResult = await bindings.batch_edit.execute({ edits: [{ oldString: 'x', newString: 'y' }] });
  assert.deepEqual(batchResult, expectedReceipt('batch_edit', 'workspace'),
    'batch contents stay in the View and do not leak in the receipt');

  const lspResult = await opened.lsp_hover.execute({ line: 1, character: 1 });
  assert.deepEqual(lspResult, { success: true, data: {
    message: 'Hover information available at 1:1. See FileDetail fd_actual_17, hover section.', view_id: 'fd_actual_17',
  } },
    'LSP receipt points to the actual FileDetail View and omits its result payload');
  hoverValue = null;
  assert.deepEqual(await opened.lsp_hover.execute({ line: 2, character: 1 }), { success: true, data: {
    message: 'No hover information at 2:1. See FileDetail fd_actual_17, hover section.', view_id: 'fd_actual_17',
  } });
  const editResult = await opened.edit_file.execute({ oldString: 'x', newString: 'y' });
  assert.equal(editResult.data.view_id, 'fd_actual_17', 'edit receipt points to the existing FileDetail View');
  const writeResult = await opened.write_file.execute({ content: 'updated' });
  assert.equal(writeResult.data.view_id, 'fd_actual_17', 'write receipt points to the existing FileDetail View');
  const renameResult = await rename.rename_file.execute({ newPath: '/work/renamed.ts' });
  assert.equal(renameResult.data.view_id, 'fd_actual_23', 'rename receipt follows the preserved FileDetail View identity');
  const deleteResult = await opened.delete_file.execute({});
  assert.equal(deleteResult.data.view_id, 'workspace', 'delete receipt points to Workspace after FileDetail closes');
  const renamed = await prepareFileTools(owner, '/work/renamed.ts', 'fd_actual_23');
  const closeResult = await renamed.close_file_detail.execute({});
  assert.equal(closeResult.data.view_id, 'workspace', 'close receipt points to Workspace after FileDetail closes');

  owner.invoke = async () => success({ filePath: '/work/open.ts', diskCommitted: true, warnings: ['Disk effect completed; view synchronization did not complete'] });
  const unsyncedResult = await opened.edit_file.execute({ oldString: 'x', newString: 'y' });
  assert.equal(unsyncedResult.data.view_id, 'workspace', 'a failed projection does not claim the stale FileDetail as current');
  assert.ok(unsyncedResult.data.warnings.includes('Disk effect completed; view synchronization did not complete'),
    "the receipt preserves the application's honest synchronization warning");

  const createFile = (await prepareTools(WorkspaceCreateType, 'create_0', { owner, path: '/work' })).create_file_if_absent;
  const created = await createFile.execute({ relativePath: 'new.txt', content: 'body' });
  assert.deepEqual(createCalls, [['/work', 'new.txt', 'body']]);
  assert.deepEqual(created, {
    success: true,
    data: {
      filePath: '/work/new.txt',
      message: 'create_file_if_absent completed. Read the current IDE Views for the updated state.',
      view_id: 'workspace',
    },
  });

  createResult = {
    success: false,
    error: { code: 'RESOURCE_WRITE_FAILED', message: 'Some file bytes were written.' },
  };
  const partial = await createFile.execute({ relativePath: 'partial.txt', content: 'body' });
  assert.deepEqual(partial, createResult, "the Tool must preserve the application's recovery message");
  console.log('IDE ViewType Tools: receipt, View identity, create, and recovery assertions passed');
}

await main();
