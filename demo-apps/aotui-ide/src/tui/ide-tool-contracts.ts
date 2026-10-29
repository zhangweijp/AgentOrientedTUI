import type { OrdinaryParams } from '@aotui/sdk';
const location = { file_path: { type: 'string', required: true }, line: { type: 'number', required: true }, character: { type: 'number', required: true } } as const;
const document = { file_path: { type: 'string', required: true } } as const;
const view = { view_id: { type: 'string', required: true } } as const;
const file = { filePath: { type: 'string', required: true } } as const;
const write = { ...file, content: { type: 'string', required: true } } as const;
const files = { filePaths: { type: 'array', itemType: 'string', required: true } } as const;
const directories = { dirPaths: { type: 'array', itemType: 'string', required: true } } as const;
const folder = { folderPath: { type: 'string', required: true } } as const;
export interface IDEToolContract { name: string; description: string; params: OrdinaryParams }
export const workspaceTools: readonly IDEToolContract[] = [
    { name: 'search_files_by_pattern', description: 'Search authorized workspaces by glob pattern and show a complete result view.', params: { pattern: { type: 'string', required: true }, cwd: { type: 'string', required: false } } },
    { name: 'search_files_by_content', description: 'Search authorized workspaces with a regular expression and show a complete result view.', params: { pattern: { type: 'string', required: true }, include: { type: 'string', required: false }, cwd: { type: 'string', required: false } } },
    { name: 'multi_open_file', description: 'Load files and open their detail views. Offset is zero based; limit defaults to 2000 lines.', params: { ...files, offset: { type: 'number', required: false }, limit: { type: 'number', required: false } } },
    { name: 'multi_close_file', description: 'Close exactly the named open files.', params: files },
    { name: 'create_file', description: 'Exclusively create a file, creating bounded missing parent directories.', params: write },
    { name: 'batch_edit', description: 'Apply a bounded ordered edit list to currently loaded files. Each item has filePath, oldString and newString.', params: { edits: { type: 'array', itemType: 'object', required: true } } },
    { name: 'multi_open_dirs', description: 'Expand the named workspace directories.', params: directories },
    { name: 'multi_close_dirs', description: 'Collapse exactly the named workspace directories.', params: directories },
    { name: 'add_folder_to_workspace', description: 'Add an authorized absolute folder to this workspace.', params: folder },
    { name: 'remove_folder_from_workspace', description: 'Remove the exact workspace root and close files no longer covered by any root.', params: folder },
    { name: 'refresh_workspace', description: 'Reload the workspace tree and reset expanded directories to its roots.', params: {} },
];
export const fileTools: readonly IDEToolContract[] = [
    { name: 'write_file', description: 'Replace the contents of this loaded file after checking its disk identity and content.', params: { content: { type: 'string', required: true } } },
    { name: 'edit_file', description: 'Replace matching text in this loaded file. replaceAll defaults to false.', params: { oldString: { type: 'string', required: true }, newString: { type: 'string', required: true }, replaceAll: { type: 'boolean', required: false } } },
    { name: 'delete_file', description: 'Delete this loaded file after checking that its disk identity and content are unchanged.', params: {} },
    { name: 'rename_file', description: 'Move this loaded file without overwriting the destination, preserving its detail View ID.', params: { newPath: { type: 'string', required: true } } },
    { name: 'lsp_hover', description: 'Load type information at a one-based position in this file view.', params: location },
    { name: 'lsp_goto_definition', description: 'Load definitions at a one-based position in this file view.', params: location },
    { name: 'lsp_find_references', description: 'Load references at a one-based position in this file view.', params: location },
    { name: 'lsp_get_diagnostics', description: 'Load diagnostics for the currently observed document in this file view.', params: document },
    { name: 'lsp_document_symbol', description: 'Load document symbols for this file view.', params: document },
    { name: 'lsp_incoming_calls', description: 'Load incoming calls at a one-based position in this file view.', params: location },
    { name: 'lsp_outgoing_calls', description: 'Load outgoing calls at a one-based position in this file view.', params: location },
    { name: 'close_file_detail', description: 'Close this exact file detail view.', params: view },
];
export const searchTools: readonly IDEToolContract[] = [{ name: 'close_search_view', description: 'Close this exact search result view.', params: view }];
