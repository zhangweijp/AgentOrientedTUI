import Type from 'typebox';
import { defineViewType, type ToolResult } from '@aotui/sdk';
import type { IDEFile, IDEProjectionState, IDESession } from '../core/ide-session.js';

const closed = { additionalProperties: false } as const;
const positionSchema = Type.Object({ line: Type.Number(), character: Type.Number() }, closed);
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

async function hoverReceipt(owner: IDESession, file: IDEFile, args: Readonly<Type.Static<typeof positionSchema>>): Promise<ToolResult> {
    const result = await owner.invoke('lsp_hover', { ...args, file_path: file.observed.path }, file.key);
    if (!result.success) return result;
    const viewId = owner.getLoadedFileViewId(file.observed.path);
    if (!viewId) return receipt('lsp_hover', 'workspace', result, true);
    const position = `${args.line}:${args.character}`;
    const status = result.data?.value == null
        ? `No hover information at ${position}.`
        : `Hover information available at ${position}.`;
    return { success: true, data: { message: `${status} See FileDetail ${viewId}, hover section.`, view_id: viewId } };
}

type FileDetailContext = { readonly owner: IDESession; readonly file: IDEFile; readonly diagnostics: boolean };

export async function closeFileDetail(owner: IDESession, file: IDEFile): Promise<ToolResult> {
    return receipt('close_file_detail', 'workspace', await owner.invoke('close_file_detail', {}, file.key));
}
const sessionReady = (owner: IDESession) => owner.live && owner.ready;
const fileReady = ({ owner }: FileDetailContext) => sessionReady(owner);
type WorkspaceContext = { readonly owner: IDESession; readonly state: IDEProjectionState };
const workspaceReady = ({ owner, state }: WorkspaceContext) => sessionReady(owner) && state.roots.length > 0;

function workspaceOperation(name: string, viewId = 'workspace', omitData = false) {
    return async ({ input, context: { owner } }: { input: Readonly<Record<string, unknown>>; context: WorkspaceContext }) =>
        receipt(name, viewId, await owner.invoke(name, input), omitData);
}

async function changeFile({ owner, file }: FileDetailContext, operation: string,
    input: Readonly<Record<string, unknown>>, destination = file.observed.path): Promise<ToolResult> {
    return fileReceipt(owner, operation, destination, await owner.invoke(operation, input, file.key));
}

async function queryFile({ owner, file }: FileDetailContext, operation: string, input: object): Promise<ToolResult> {
    const path = file.observed.path;
    const result = await owner.invoke(operation, { ...input, file_path: path }, file.key);
    return fileReceipt(owner, operation, path, result, true);
}

export const RootType = defineViewType({ name: 'Root', multiplicity: 'single', region: 'static' });

export const WorkspaceType = defineViewType<WorkspaceContext>()({ name: 'Workspace', multiplicity: 'single', region: 'dynamic', tools: {
        search_files_by_pattern: { description: 'Search authorized workspaces by glob pattern and show the current results in SearchResult.',
            inputSchema: Type.Object({ pattern: Type.String({ description: 'Glob pattern to search.' }), cwd: Type.Optional(Type.String({ description: 'Optional directory inside a workspace root.' })) }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('search_files_by_pattern', 'search', true),
        },
        search_files_by_content: { description: 'Search authorized workspaces by regular expression and show the current results in SearchResult.',
            inputSchema: Type.Object({ pattern: Type.String({ description: 'Regular expression to search.' }), include: Type.Optional(Type.String({ description: 'Optional file glob.' })), cwd: Type.Optional(Type.String({ description: 'Optional directory inside a workspace root.' })) }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('search_files_by_content', 'search', true),
        },
        multi_open_file: { description: 'Load files inside a workspace and open one FileDetail View per selected file.',
            inputSchema: Type.Object({ filePaths: Type.Array(Type.String(), { description: 'Absolute paths inside a workspace root.' }), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('multi_open_file'),
        },
        multi_close_file: { description: 'Close exactly the named currently opened files.',
            inputSchema: Type.Object({ filePaths: stringArray() }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('multi_close_file'),
        },
        create_file: { description: 'Create a new absolute workspace file with exact text. Existing files are never overwritten.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Absolute path inside a workspace root.' }), content: Type.String({ description: 'Exact UTF-8 file text.' }) }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('create_file'),
        },
        batch_edit: { description: 'Apply a bounded ordered list of edits to currently loaded files. Every edit needs filePath, oldString and newString.',
            inputSchema: Type.Object({ edits: Type.Array(opaqueJsonObject()) }, closed),
            enabled: context => workspaceReady(context) && context.state.files.size > 0,
            execute: workspaceOperation('batch_edit', 'workspace', true),
        },
        multi_open_dirs: { description: 'Expand the named authorized workspace directories.',
            inputSchema: Type.Object({ dirPaths: stringArray() }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('multi_open_dirs'),
        },
        multi_close_dirs: { description: 'Collapse the named workspace directories.',
            inputSchema: Type.Object({ dirPaths: stringArray() }, closed),
            enabled: workspaceReady,
            execute: workspaceOperation('multi_close_dirs'),
        },
        add_folder_to_workspace: { description: 'Add an authorized absolute directory as a workspace root.',
            inputSchema: Type.Object({ folderPath: Type.String({ description: 'Absolute directory path to authorize.' }) }, closed),
            enabled: ({ owner }) => sessionReady(owner),
            execute: workspaceOperation('add_folder_to_workspace'),
        },
        remove_folder_from_workspace: { description: 'Remove an exact workspace root and close files no longer covered by another root.',
            inputSchema: Type.Object({ folderPath: Type.String({ description: 'Exact listed workspace root.' }) }, closed),
            enabled: ({ owner, state }) => sessionReady(owner) && (state.roots.length > 0 || state.unavailableRoots.length > 0),
            execute: workspaceOperation('remove_folder_from_workspace'),
        },
        refresh_workspace: { description: 'Reload current workspace trees and expand only their root directories.',
            inputSchema: Type.Object({}, closed),
            enabled: workspaceReady,
            async execute({ context: { owner } }) {
                return receipt('refresh_workspace', 'workspace', await owner.invoke('refresh_workspace', {}));
            },
        },
} });

export const FileDetailType = defineViewType<FileDetailContext>()({
    name: 'FileDetail', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        write_file: {
            description: 'Replace the contents of a currently loaded file after checking its disk identity and content.',
            inputSchema: Type.Object({ content: Type.String({ description: 'Replacement file text.' }) }, closed),
            enabled: fileReady,
            execute: ({ input, context }) => changeFile(context, 'write_file', input),
        },
        edit_file: {
            description: 'Replace matching text in a currently loaded file. replaceAll defaults to false.',
            inputSchema: Type.Object({ oldString: Type.String(), newString: Type.String(), replaceAll: Type.Optional(Type.Boolean()) }, closed),
            enabled: fileReady,
            execute: ({ input, context }) => changeFile(context, 'edit_file', input),
        },
        delete_file: {
            description: 'Delete a currently loaded file after checking that its disk identity and content are unchanged.',
            enabled: fileReady,
            execute: ({ context }) => changeFile(context, 'delete_file', {}),
        },
        rename_file: {
            description: 'Move a currently loaded file without overwriting the destination, preserving its FileDetail View ID.',
            inputSchema: Type.Object({ newPath: Type.String({ description: 'Absolute destination path inside a workspace root.' }) }, closed),
            enabled: fileReady,
            execute: ({ input, context }) => changeFile(context, 'rename_file', input, input.newPath),
        },
        lsp_hover: {
            description: 'Query language-server hover at a one-based position in an opened document. Read the hover section of its FileDetail View.',
            inputSchema: positionSchema,
            enabled: fileReady,
            execute: ({ input, context: { owner, file } }) => hoverReceipt(owner, file, input),
        },
        lsp_goto_definition: {
            description: 'Load definition locations at a one-based position in an opened document.',
            inputSchema: positionSchema,
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_goto_definition', input),
        },
        lsp_find_references: {
            description: 'Load reference locations at a one-based position in an opened document.',
            inputSchema: positionSchema,
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_find_references', input),
        },
        lsp_get_diagnostics: {
            description: 'Refresh diagnostics for a currently opened document and publish them in its FileDetail View.',
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_get_diagnostics', input),
        },
        lsp_document_symbol: {
            description: 'Load document symbols for a currently opened document.',
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_document_symbol', input),
        },
        lsp_incoming_calls: {
            description: 'Load incoming calls at a one-based position in an opened document.',
            inputSchema: positionSchema,
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_incoming_calls', input),
        },
        lsp_outgoing_calls: {
            description: 'Load outgoing calls at a one-based position in an opened document.',
            inputSchema: positionSchema,
            enabled: fileReady,
            execute: ({ input, context }) => queryFile(context, 'lsp_outgoing_calls', input),
        },
        close_file_detail: {
            description: 'Close this FileDetail View.',
            enabled: fileReady,
            execute: ({ context: { owner, file } }) => closeFileDetail(owner, file),
        },
        read_loaded_diagnostics: {
            description: 'Read already loaded diagnostics for the selected opened file. This does not run or refresh the language server.',
            enabled: context => context.diagnostics && fileReady(context),
            execute: ({ context: { owner, file } }) => owner.readLoadedDiagnostics(file.observed.path),
        },
    },
});

export const SearchResultType = defineViewType<{ owner: IDESession; incarnation: number }>()({
    name: 'SearchResult', multiplicity: 'single', region: 'dynamic',
    tools: {
        close_search_view: {
            description: 'Close this SearchResult View.',
            inputSchema: Type.Object({}, closed),
            enabled: ({ owner }) => sessionReady(owner),
            async execute({ context: { owner, incarnation } }) {
                if (owner.search?.incarnation !== incarnation) return {
                    success: false, error: { code: 'IDE_SEARCH_STALE', message: 'Observe the current SearchResult before closing it.' },
                };
                return receipt('close_search_view', 'workspace', await owner.invoke('close_search_view', {}, 'search'));
            },
        },
    },
});

export const WorkspaceCreateType = defineViewType<{ owner: IDESession; path: string }>()({
    name: 'WorkspaceCreate', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        create_file_if_absent: {
            description: 'Create a file under the selected open workspace root. The relative path must stay inside it, its parent must exist, and existing files are never overwritten.',
            inputSchema: Type.Object({
                relativePath: Type.String({ description: 'New file path relative to that workspace root.' }),
                content: Type.String({ description: 'Exact UTF-8 text to create.' }),
            }, closed),
            enabled: ({ owner }) => sessionReady(owner),
            async execute({ input: { relativePath, content }, context: { owner, path } }) {
                return receipt('create_file_if_absent', 'workspace', await owner.createWorkspaceFile(path, relativePath, content));
            },
        },
    },
});

export const ideViewTypes = [RootType, WorkspaceType, FileDetailType, SearchResultType, WorkspaceCreateType] as const;
