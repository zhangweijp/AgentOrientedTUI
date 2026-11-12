import Type from 'typebox';
import {
    defineViewTypeTool, defineToolSet, type ArgsOf, type ToolBindings, type ToolSetMap,
    type ToolResult,
} from '@aotui/sdk';
import type { IDESession } from '../core/ide-session.js';

export type IDEViewTool = ReturnType<typeof defineViewTypeTool>;

const closed = { additionalProperties: false } as const;
const stringArray = () => Type.Array(Type.String());
const opaqueJsonObject = () => Type.Object({}, { additionalProperties: true });

function receipt(name: string, viewId: string, result: ToolResult, omitData = false): ToolResult {
    if (!result.success) return result;
    const previous = omitData ? {} : result.data ?? {};
    return {
        ...result,
        data: {
            ...previous,
            message: `${name} completed. Read the current IDE Views for the updated state.`,
            view_id: viewId,
        },
    };
}

function fileReceipt(owner: IDESession, name: string, filePath: string, result: ToolResult, omitData = false): ToolResult {
    if (!result.success) return result;
    const warnings = result.data?.warnings;
    const projectionFailed = Array.isArray(warnings) && warnings.includes('Disk effect completed; view synchronization did not complete');
    const viewId = projectionFailed ? undefined : owner.getLoadedFileViewId(filePath);
    return receipt(name, viewId ?? 'workspace', result, omitData);
}
export const ideTools = defineToolSet({
search_files_by_pattern: defineViewTypeTool({
            viewType: 'Workspace', name: 'search_files_by_pattern',
            description: 'Search authorized workspaces by glob pattern and show the current results in SearchResult.',
            inputSchema: Type.Object({ pattern: Type.String({ description: 'Glob pattern to search.' }), cwd: Type.Optional(Type.String({ description: 'Optional directory inside a workspace root.' })) }, closed),
        }),
search_files_by_content: defineViewTypeTool({
            viewType: 'Workspace', name: 'search_files_by_content',
            description: 'Search authorized workspaces by regular expression and show the current results in SearchResult.',
            inputSchema: Type.Object({ pattern: Type.String({ description: 'Regular expression to search.' }), include: Type.Optional(Type.String({ description: 'Optional file glob.' })), cwd: Type.Optional(Type.String({ description: 'Optional directory inside a workspace root.' })) }, closed),
        }),
multi_open_file: defineViewTypeTool({
            viewType: 'Workspace', name: 'multi_open_file',
            description: 'Load files inside a workspace and open one FileDetail View per selected file.',
            inputSchema: Type.Object({ filePaths: Type.Array(Type.String(), { description: 'Absolute paths inside a workspace root.' }), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }, closed),
        }),
multi_close_file: defineViewTypeTool({
            viewType: 'Workspace', name: 'multi_close_file',
            description: 'Close exactly the named currently opened files.',
            inputSchema: Type.Object({ filePaths: stringArray() }, closed),
        }),
create_file: defineViewTypeTool({
            viewType: 'Workspace', name: 'create_file',
            description: 'Create a new absolute workspace file with exact text. Existing files are never overwritten.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path inside a workspace root.' }), content: Type.String({ description: 'Exact UTF-8 file text.' }) }, closed),
        }),
batch_edit: defineViewTypeTool({
            viewType: 'Workspace', name: 'batch_edit',
            description: 'Apply a bounded ordered list of edits to currently loaded files. Every edit needs filePath, oldString and newString.',
            inputSchema: Type.Object({ edits: Type.Array(opaqueJsonObject()) }, closed),
        }),
multi_open_dirs: defineViewTypeTool({
            viewType: 'Workspace', name: 'multi_open_dirs',
            description: 'Expand the named authorized workspace directories.',
            inputSchema: Type.Object({ dirPaths: stringArray() }, closed),
        }),
multi_close_dirs: defineViewTypeTool({
            viewType: 'Workspace', name: 'multi_close_dirs',
            description: 'Collapse the named workspace directories.',
            inputSchema: Type.Object({ dirPaths: stringArray() }, closed),
        }),
add_folder_to_workspace: defineViewTypeTool({
            viewType: 'Workspace', name: 'add_folder_to_workspace',
            description: 'Add an authorized absolute directory as a workspace root.',
            inputSchema: Type.Object({ folderPath: Type.String({ description: 'Absolute directory path to authorize.' }) }, closed),
        }),
remove_folder_from_workspace: defineViewTypeTool({
            viewType: 'Workspace', name: 'remove_folder_from_workspace',
            description: 'Remove an exact workspace root and close files no longer covered by another root.',
            inputSchema: Type.Object({ folderPath: Type.String({ description: 'Exact listed workspace root.' }) }, closed),
        }),
refresh_workspace: defineViewTypeTool({
            viewType: 'Workspace', name: 'refresh_workspace',
            description: 'Reload current workspace trees and expand only their root directories.',
            inputSchema: Type.Object({}, closed),
        }),
write_file: defineViewTypeTool({
            viewType: 'FileDetail', name: 'write_file',
            description: 'Replace the contents of a currently loaded file after checking its disk identity and content.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path of a currently opened file.' }), content: Type.String({ description: 'Replacement file text.' }) }, closed),
        }),
edit_file: defineViewTypeTool({
            viewType: 'FileDetail', name: 'edit_file',
            description: 'Replace matching text in a currently loaded file. replaceAll defaults to false.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path of a currently opened file.' }), oldString: Type.String(), newString: Type.String(), replaceAll: Type.Optional(Type.Boolean()) }, closed),
        }),
delete_file: defineViewTypeTool({
            viewType: 'FileDetail', name: 'delete_file',
            description: 'Delete a currently loaded file after checking that its disk identity and content are unchanged.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path of a currently opened file.' }) }, closed),
        }),
rename_file: defineViewTypeTool({
            viewType: 'FileDetail', name: 'rename_file',
            description: 'Move a currently loaded file without overwriting the destination, preserving its FileDetail View ID.',
            inputSchema: Type.Object({ oldPath: Type.String({ description: 'Absolute path of a currently opened file.' }), newPath: Type.String({ description: 'Absolute destination path inside a workspace root.' }) }, closed),
        }),
lsp_hover: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_hover',
            description: 'Load language-server hover information at a one-based position in an opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }), line: Type.Number(), character: Type.Number() }, closed),
        }),
lsp_goto_definition: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_goto_definition',
            description: 'Load definition locations at a one-based position in an opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }), line: Type.Number(), character: Type.Number() }, closed),
        }),
lsp_find_references: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_find_references',
            description: 'Load reference locations at a one-based position in an opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }), line: Type.Number(), character: Type.Number() }, closed),
        }),
lsp_get_diagnostics: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_get_diagnostics',
            description: 'Refresh diagnostics for a currently opened document and publish them in its FileDetail View.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }) }, closed),
        }),
lsp_document_symbol: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_document_symbol',
            description: 'Load document symbols for a currently opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }) }, closed),
        }),
lsp_incoming_calls: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_incoming_calls',
            description: 'Load incoming calls at a one-based position in an opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }), line: Type.Number(), character: Type.Number() }, closed),
        }),
lsp_outgoing_calls: defineViewTypeTool({
            viewType: 'FileDetail', name: 'lsp_outgoing_calls',
            description: 'Load outgoing calls at a one-based position in an opened document.',
            inputSchema: Type.Object({ file_path: Type.String({ description: 'Absolute path of a currently opened file.' }), line: Type.Number(), character: Type.Number() }, closed),
        }),
close_file_detail: defineViewTypeTool({
            viewType: 'FileDetail', name: 'close_file_detail',
            description: 'Close exactly the FileDetail View identified by view_id.',
            inputSchema: Type.Object({ view_id: Type.String({ description: 'ID of a currently opened FileDetail View.' }) }, closed),
        }),
close_search_view: defineViewTypeTool({
        viewType: 'SearchResult', name: 'close_search_view',
        description: 'Close the current SearchResult View. Its view_id must be search.',
        inputSchema: Type.Object({ view_id: Type.String({ description: 'Current SearchResult View ID.' }) }, closed),
    }),
read_loaded_diagnostics: defineViewTypeTool({
        viewType: 'FileDetail', name: 'read_loaded_diagnostics',
        description: 'Read already loaded diagnostics for the selected opened file. This does not run or refresh the language server.',
        inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path of a currently opened file.' }) }, closed),
    }),
create_file_if_absent: defineViewTypeTool({
        viewType: 'WorkspaceCreate', name: 'create_file_if_absent',
        description: 'Create a file under the selected open workspace root. The relative path must stay inside it, its parent must exist, and existing files are never overwritten.',
        inputSchema: Type.Object({
            workspacePath: Type.String({ description: 'Exact path of an available workspace root shown in WorkspaceCreate.' }),
            relativePath: Type.String({ description: 'New file path relative to that workspace root.' }),
            content: Type.String({ description: 'Exact UTF-8 text to create.' }),
        }, closed),
    })
});

export function createIDEToolBindings(owner: IDESession, enabled: (definition: IDEViewTool) => boolean = () => true): ToolBindings<ToolSetMap<typeof ideTools>> {
return {
search_files_by_pattern: { execute: async (args: ArgsOf<typeof ideTools.search_files_by_pattern>) => receipt('search_files_by_pattern', 'search', await owner.invoke('search_files_by_pattern', args), true), enabled: enabled(ideTools.search_files_by_pattern) },
search_files_by_content: { execute: async (args: ArgsOf<typeof ideTools.search_files_by_content>) => receipt('search_files_by_content', 'search', await owner.invoke('search_files_by_content', args), true), enabled: enabled(ideTools.search_files_by_content) },
multi_open_file: { execute: async (args: ArgsOf<typeof ideTools.multi_open_file>) => receipt('multi_open_file', 'workspace', await owner.invoke('multi_open_file', args)), enabled: enabled(ideTools.multi_open_file) },
multi_close_file: { execute: async (args: ArgsOf<typeof ideTools.multi_close_file>) => receipt('multi_close_file', 'workspace', await owner.invoke('multi_close_file', args)), enabled: enabled(ideTools.multi_close_file) },
create_file: { execute: async (args: ArgsOf<typeof ideTools.create_file>) => receipt('create_file', 'workspace', await owner.invoke('create_file', args)), enabled: enabled(ideTools.create_file) },
batch_edit: { execute: async (args: ArgsOf<typeof ideTools.batch_edit>) => receipt('batch_edit', 'workspace', await owner.invoke('batch_edit', args), true), enabled: enabled(ideTools.batch_edit) },
multi_open_dirs: { execute: async (args: ArgsOf<typeof ideTools.multi_open_dirs>) => receipt('multi_open_dirs', 'workspace', await owner.invoke('multi_open_dirs', args)), enabled: enabled(ideTools.multi_open_dirs) },
multi_close_dirs: { execute: async (args: ArgsOf<typeof ideTools.multi_close_dirs>) => receipt('multi_close_dirs', 'workspace', await owner.invoke('multi_close_dirs', args)), enabled: enabled(ideTools.multi_close_dirs) },
add_folder_to_workspace: { execute: async (args: ArgsOf<typeof ideTools.add_folder_to_workspace>) => receipt('add_folder_to_workspace', 'workspace', await owner.invoke('add_folder_to_workspace', args)), enabled: enabled(ideTools.add_folder_to_workspace) },
remove_folder_from_workspace: { execute: async (args: ArgsOf<typeof ideTools.remove_folder_from_workspace>) => receipt('remove_folder_from_workspace', 'workspace', await owner.invoke('remove_folder_from_workspace', args)), enabled: enabled(ideTools.remove_folder_from_workspace) },
refresh_workspace: { execute: async (args: ArgsOf<typeof ideTools.refresh_workspace>) => receipt('refresh_workspace', 'workspace', await owner.invoke('refresh_workspace', args)), enabled: enabled(ideTools.refresh_workspace) },
write_file: { execute: async (args: ArgsOf<typeof ideTools.write_file>) => fileReceipt(owner, 'write_file', args.filePath, await owner.invokeOpenedFile(args)), enabled: enabled(ideTools.write_file) },
edit_file: { execute: async (args: ArgsOf<typeof ideTools.edit_file>) => fileReceipt(owner, 'edit_file', args.filePath, await owner.invoke('edit_file', args)), enabled: enabled(ideTools.edit_file) },
delete_file: { execute: async (args: ArgsOf<typeof ideTools.delete_file>) => fileReceipt(owner, 'delete_file', args.filePath, await owner.invoke('delete_file', args)), enabled: enabled(ideTools.delete_file) },
rename_file: { execute: async (args: ArgsOf<typeof ideTools.rename_file>) => fileReceipt(owner, 'rename_file', args.newPath, await owner.invoke('rename_file', args)), enabled: enabled(ideTools.rename_file) },
lsp_hover: { execute: async (args: ArgsOf<typeof ideTools.lsp_hover>) => fileReceipt(owner, 'lsp_hover', args.file_path, await owner.invokeLoadedFileTool('lsp_hover', args), true), enabled: enabled(ideTools.lsp_hover) },
lsp_goto_definition: { execute: async (args: ArgsOf<typeof ideTools.lsp_goto_definition>) => fileReceipt(owner, 'lsp_goto_definition', args.file_path, await owner.invokeLoadedFileTool('lsp_goto_definition', args), true), enabled: enabled(ideTools.lsp_goto_definition) },
lsp_find_references: { execute: async (args: ArgsOf<typeof ideTools.lsp_find_references>) => fileReceipt(owner, 'lsp_find_references', args.file_path, await owner.invokeLoadedFileTool('lsp_find_references', args), true), enabled: enabled(ideTools.lsp_find_references) },
lsp_get_diagnostics: { execute: async (args: ArgsOf<typeof ideTools.lsp_get_diagnostics>) => fileReceipt(owner, 'lsp_get_diagnostics', args.file_path, await owner.invokeLoadedFileTool('lsp_get_diagnostics', args), true), enabled: enabled(ideTools.lsp_get_diagnostics) },
lsp_document_symbol: { execute: async (args: ArgsOf<typeof ideTools.lsp_document_symbol>) => fileReceipt(owner, 'lsp_document_symbol', args.file_path, await owner.invokeLoadedFileTool('lsp_document_symbol', args), true), enabled: enabled(ideTools.lsp_document_symbol) },
lsp_incoming_calls: { execute: async (args: ArgsOf<typeof ideTools.lsp_incoming_calls>) => fileReceipt(owner, 'lsp_incoming_calls', args.file_path, await owner.invokeLoadedFileTool('lsp_incoming_calls', args), true), enabled: enabled(ideTools.lsp_incoming_calls) },
lsp_outgoing_calls: { execute: async (args: ArgsOf<typeof ideTools.lsp_outgoing_calls>) => fileReceipt(owner, 'lsp_outgoing_calls', args.file_path, await owner.invokeLoadedFileTool('lsp_outgoing_calls', args), true), enabled: enabled(ideTools.lsp_outgoing_calls) },
close_file_detail: { execute: async (args: ArgsOf<typeof ideTools.close_file_detail>) => receipt('close_file_detail', 'workspace', await owner.invoke('close_file_detail', args, args.view_id)), enabled: enabled(ideTools.close_file_detail) },
close_search_view: { execute: async (args: ArgsOf<typeof ideTools.close_search_view>) => receipt('close_search_view', 'workspace', await owner.invoke('close_search_view', args, 'search')), enabled: enabled(ideTools.close_search_view) },
read_loaded_diagnostics: { execute: (args: ArgsOf<typeof ideTools.read_loaded_diagnostics>) => owner.readLoadedDiagnostics(args.filePath), enabled: enabled(ideTools.read_loaded_diagnostics) },
create_file_if_absent: { execute: async (args: ArgsOf<typeof ideTools.create_file_if_absent>) => receipt('create_file_if_absent', 'workspace', await owner.createWorkspaceFile(
            args.workspacePath, args.relativePath, args.content,
        )), enabled: enabled(ideTools.create_file_if_absent) }
};
}
