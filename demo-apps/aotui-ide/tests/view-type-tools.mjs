import assert from 'node:assert/strict';
import { createIDEToolBindings, ideTools } from '../dist/tui/ide-tool-contracts.js';

async function main() {
  let createResult = { success: true, data: { filePath: '/work/new.txt' } };
  const createCalls = [];
  const loadedViews = new Map([
    ['/work/open.ts', 'fd_actual_17'],
    ['/work/rename.ts', 'fd_actual_23'],
  ]);
  const success = data => ({ success: true, data });
  const owner = {
    roots: [], live: true, ready: true,
    invoke: async (name, args) => {
      if (name === 'search_files_by_pattern') return success({ paths: ['/work/a.ts'], total: 1 });
      if (name === 'search_files_by_content') return success({ paths: ['/work/a.ts'], matches: [{ line: 1, text: 'secret match payload' }] });
      if (name === 'batch_edit') return success({ results: [{ index: 0, status: 'succeeded', content: 'secret edited content' }] });
      if (name === 'edit_file') return success({ filePath: args.filePath, diskCommitted: true, warnings: [] });
      if (name === 'delete_file') {
        loadedViews.delete(args.filePath);
        return success({ filePath: args.filePath, diskCommitted: true, warnings: [] });
      }
      if (name === 'rename_file') {
        const viewId = loadedViews.get(args.oldPath);
        loadedViews.delete(args.oldPath);
        if (viewId) loadedViews.set(args.newPath, viewId);
        return success({ filePath: args.newPath, diskCommitted: true, warnings: [] });
      }
      if (name === 'close_file_detail') {
        for (const [filePath, viewId] of loadedViews) if (viewId === args.view_id) loadedViews.delete(filePath);
        return success({ closed: 1 });
      }
      return success({});
    },
    invokeOpenedFile: async args => success({ filePath: args.filePath, diskCommitted: true, warnings: [] }),
    invokeLoadedFileTool: async () => success({ hover: { contents: 'secret LSP payload' }, locations: ['/work/definition.ts'] }),
    getLoadedFileViewId: filePath => loadedViews.get(filePath),
    readLoadedDiagnostics: () => ({ success: true, data: {} }),
    createWorkspaceFile: async (...args) => { createCalls.push(args); return createResult; },
  };

  const ofType = viewType => Object.values(ideTools).filter(tool => tool.viewType === viewType);
  const tools = { workspace: ofType('Workspace'), file: ofType('FileDetail'), search: ofType('SearchResult') };
  const bindings = createIDEToolBindings(owner);
  assert.ok(tools.workspace.length > 0 && tools.file.length > 0 && tools.search.length > 0,
    'every IDE TypeBox declaration should construct successfully');

  const batchEdit = tools.workspace.find(tool => tool.name === 'batch_edit');
  assert.ok(batchEdit);
  assert.deepEqual({ ...batchEdit.inputSchema.properties.edits.items }, { type: 'object' },
    'batch fields stay opaque and are validated by IDESession');

  const byName = (group, name) => {
    const tool = group.find(candidate => candidate.name === name);
    assert.ok(tool, `expected ${name} declaration`);
    return bindings[name];
  };
  const expectedReceipt = (name, viewId) => ({
    success: true,
    data: {
      message: `${name} completed. Read the current IDE Views for the updated state.`,
      view_id: viewId,
    },
  });

  const patternResult = await byName(tools.workspace, 'search_files_by_pattern').execute({ pattern: '**/*.ts' });
  assert.deepEqual(patternResult, expectedReceipt('search_files_by_pattern', 'search'),
    'pattern search returns a receipt, not the business result collection');
  const contentResult = await byName(tools.workspace, 'search_files_by_content').execute({ pattern: 'secret' });
  assert.deepEqual(contentResult, expectedReceipt('search_files_by_content', 'search'),
    'content search results are projected through SearchResult only');
  const batchResult = await bindings.batch_edit.execute({ edits: [{ filePath: '/work/open.ts', oldString: 'x', newString: 'y' }] });
  assert.deepEqual(batchResult, expectedReceipt('batch_edit', 'workspace'),
    'batch contents stay in the View and do not leak in the receipt');

  const lspResult = await byName(tools.file, 'lsp_hover').execute({ file_path: '/work/open.ts', line: 1, character: 1 });
  assert.deepEqual(lspResult, expectedReceipt('lsp_hover', 'fd_actual_17'),
    'LSP receipt points to the actual FileDetail View and omits its result payload');
  const editResult = await byName(tools.file, 'edit_file').execute({ filePath: '/work/open.ts', oldString: 'x', newString: 'y' });
  assert.equal(editResult.data.view_id, 'fd_actual_17', 'edit receipt points to the existing FileDetail View');
  const writeResult = await byName(tools.file, 'write_file').execute({ filePath: '/work/open.ts', content: 'updated' });
  assert.equal(writeResult.data.view_id, 'fd_actual_17', 'write receipt points to the existing FileDetail View');
  const renameResult = await byName(tools.file, 'rename_file').execute({ oldPath: '/work/rename.ts', newPath: '/work/renamed.ts' });
  assert.equal(renameResult.data.view_id, 'fd_actual_23', 'rename receipt follows the preserved FileDetail View identity');
  const deleteResult = await byName(tools.file, 'delete_file').execute({ filePath: '/work/open.ts' });
  assert.equal(deleteResult.data.view_id, 'workspace', 'delete receipt points to Workspace after FileDetail closes');
  const closeResult = await byName(tools.file, 'close_file_detail').execute({ view_id: 'fd_actual_23' });
  assert.equal(closeResult.data.view_id, 'workspace', 'close receipt points to Workspace after FileDetail closes');

  owner.invoke = async () => success({ filePath: '/work/open.ts', diskCommitted: true, warnings: ['Disk effect completed; view synchronization did not complete'] });
  const unsyncedResult = await byName(tools.file, 'edit_file').execute({ filePath: '/work/open.ts', oldString: 'x', newString: 'y' });
  assert.equal(unsyncedResult.data.view_id, 'workspace', 'a failed projection does not claim the stale FileDetail as current');
  assert.ok(unsyncedResult.data.warnings.includes('Disk effect completed; view synchronization did not complete'),
    "the receipt preserves the application's honest synchronization warning");

  const createFile = bindings.create_file_if_absent;
  const created = await createFile.execute({ workspacePath: '/work', relativePath: 'new.txt', content: 'body' });
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
    effects: 'partial',
  };
  const partial = await createFile.execute({ workspacePath: '/work', relativePath: 'partial.txt', content: 'body' });
  assert.deepEqual(partial, createResult, "the Tool must preserve the application's partial-effects fact");
  console.log('IDE ViewType Tools: receipt, View identity, create, and partial-effect assertions passed');
}

await main();
