import path from 'node:path';
import { createView, type AppAuthorContext, type ViewHandle } from '@aotui/sdk';
import { fileViewName, IDESession, type IDEFile, type IDEProjectionState } from '../core/ide-session.js';
import { IDEError } from '../core/ide-errors.js';
import { RootType, WorkspaceType, FileDetailType, SearchResultType, WorkspaceCreateType, closeFileDetail } from './ide-tool-contracts.js';
import { resolveIDEOptions } from '../core/app-options.js';

function literalBlock(text: string): string {
    let width = 3;
    for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}\n${text}\n${fence}`;
}

function workspaceBody({ roots, trees, unavailableRoots, files }: IDEProjectionState, lastBatch: unknown): string {
    return [
        '## Workspace',
        'Load existing files before editing, deleting or renaming them. Each file action checks the IDE’s current loaded file and workspace state.',
        ...(roots.length ? roots.map((root, index) => [
            '### 📁 [' + index + '] ' + path.basename(root.path),
            'Path: ' + root.path,
            literalBlock(trees.get(root.path) ?? 'Loading…'),
        ].join('\n\n')) : ['No folders. Add an authorized folder to begin.']),
        ...(unavailableRoots.length ? [
            '### Unavailable folders',
            'These saved folders are missing or no longer reachable as directories. Their paths remain in this session.',
            'Restore a folder at its listed path and use add_folder_to_workspace to reconnect it, or use remove_folder_from_workspace to remove its saved entry.',
            unavailableRoots.map(folder => '- ' + folder).join('\n'),
        ] : []),
        '### 📂 Opened Files',
        files.size ? [...files.keys()].map(file => '- ' + file).join('\n') : 'No files open.',
        ...(lastBatch ? ['### Last batch result', literalBlock(JSON.stringify(lastBatch, null, 2))] : []),
    ].join('\n\n');
}

function fileBody(file: IDEFile): string {
    return [
        '## ' + file.observed.path,
        'LSP positions use one-based lines and characters in the complete loaded document.',
        '### Content',
        literalBlock(file.page),
        ...Object.entries(file.panels).flatMap(([name, panel]) => [
            '### ' + name,
            ...(name === 'hover' && panel && typeof panel === 'object' && 'value' in panel && panel.value === null
                ? ['No hover information at the queried position.'] : []),
            literalBlock(JSON.stringify(panel, null, 2)),
        ]),
    ].join('\n\n');
}

const rootBody = `# AOTUI IDE - Application Instruction

## What it is

A text-based Integrated Development Environment for LLM Agents. Work across multiple authorized folders, search source, read and edit loaded files, and inspect language information through LSP.

## How to use

1. Start in Workspace. Add authorized folders and inspect each directory tree.
2. Locate files with search_files_by_pattern or search_files_by_content. Review matches in SearchResult.
3. Use multi_open_file with absolute paths to load files and open their FileDetail Views.
4. Read the current FileDetail, then call its editing or language tools with the page’s XML view_id. Workspace tools take business parameters, including paths for files or folders.
5. Read tool receipts and the updated Views. If a write outcome is unknown, inspect the actual file before another write. Reopen a file to refresh its loaded content after an external change.

## Views

### Workspace

Workspace folders, expanded directory trees and open files. Folder, search, open, close and create actions belong here.

- add_folder_to_workspace requires an authorized absolute folder path. remove_folder_from_workspace requires a listed folder.
- search_files_by_pattern and search_files_by_content require a workspace folder. Optional cwd must remain inside it.
- multi_open_file requires absolute file paths inside the workspace. multi_close_file requires currently open files.
- create_file creates a new file without overwriting an existing one. batch_edit operates on loaded files.
- multi_open_dirs, multi_close_dirs and refresh_workspace require workspace folders.

### FileDetail

One loaded file with line numbers, its visible range and language panels.

- write_file, edit_file and delete_file operate on the receiving file. rename_file takes its new absolute path.
- LSP tools use one-based lines and characters in the complete loaded document.
- close_file_detail closes the receiving FileDetail.

### SearchResult

Shows matches for the latest successful search. Use Workspace's multi_open_file to inspect matching paths. Call close_search_view with an empty object.`;

export function initializeIDE(context: AppAuthorContext): void {
    const config = context.launchConfig ?? {};
    let state: IDEProjectionState;
    let renderFiles: Map<string, IDEFile>;
    let fileViews = new Map<string, ViewHandle>();
    let rootViews = new Map<string, ViewHandle>();
    let search: { incarnation: number; view: ViewHandle } | undefined;

    const owner = new IDESession(resolveIDEOptions(context), render, key => {
        const view = fileViews.get(key);
        return view && context.readViewId(view);
    });

    const root = createView(RootType, {
        id: 'root', name: 'IDE',
        render: () => ({ body: [
            rootBody,
            ...(config.enableWorkspaceCreate === true ? [
                '### WorkspaceCreate',
                'Creates a new file relative to the workspace root shown in the receiving View. Requires an existing parent directory and never overwrites a file.',
            ] : []),
            'Callable tools apply to the observed View. Use its XML view_id for single-file actions and explicit paths for Workspace actions.',
            ...(!owner.ready ? [owner.error ? 'Initialization failed: ' + owner.error : 'Restoring the IDE session…'] : []),
            ...state.warnings.map(warning => '- ' + warning),
        ].join('\n\n') }),
    });
    const workspace = createView(WorkspaceType, {
        id: 'workspace', name: 'Workspace',
        render: () => ({ body: workspaceBody(state, owner.lastBatch), context: { owner, state } }),
    });

    function createFileView(key: string): ViewHandle {
        return createView(FileDetailType, {
            idPrefix: 'fd',
            onClose: () => {
                const file = [...owner.files.values()].find(item => item.key === key);
                return file ? closeFileDetail(owner, file) : {
                    success: false, error: { code: 'IDE_FILE_VIEW_CLOSED', message: 'The FileDetail View is already closed.' },
                };
            },
            render: () => {
                const file = renderFiles.get(key)!;
                return { body: fileBody(file), name: fileViewName(file.observed.path),
                    context: { owner, file, diagnostics: config.enableDiagnosticsRead !== false } };
            },
        });
    }

    function render(candidate?: Partial<IDEProjectionState>): void {
        state = {
            files: candidate?.files ?? owner.files, roots: candidate?.roots ?? owner.roots,
            search: candidate?.search ?? owner.search, trees: candidate?.trees ?? owner.trees,
            unavailableRoots: candidate?.unavailableRoots ?? owner.unavailableRoots,
            warnings: candidate?.warnings ?? owner.warnings,
        };
        renderFiles = new Map([...state.files.values()].map(file => [file.key, file]));
        const nextFiles = new Map([...renderFiles.keys()].map(key => [key, fileViews.get(key) ?? createFileView(key)]));
        const nextRoots = new Map<string, ViewHandle>();
        if (config.enableWorkspaceCreate === true && owner.ready) {
            for (const { path: folder, identity } of state.roots) {
                const key = folder + ':' + identity;
                nextRoots.set(key, rootViews.get(key) ?? createView(WorkspaceCreateType, {
                    idPrefix: 'create', name: 'Workspace: ' + folder,
                    render: () => ({
                        body: '## Workspace: ' + folder + '\n\nUse this page’s XML view_id with create_file_if_absent. The application checks that it is still open and authorized.',
                        context: { owner, path: folder },
                    }),
                }));
            }
        }
        const nextSearch = state.search && (search?.incarnation === state.search.incarnation ? search : {
            incarnation: state.search.incarnation,
            view: createView(SearchResultType, {
                id: 'search', name: 'Search Results',
                render: () => {
                    const { query, paths, incarnation } = state.search!;
                    return { body: [
                        '## Search: ' + query,
                        paths.length + ' matching files. This result is complete for its accepted search profile.',
                        paths.map(file => '- ' + file).join('\n'),
                    ].join('\n\n'), context: { owner, incarnation } };
                },
            }),
        });

        const views = [root, workspace, ...nextFiles.values(), ...(nextSearch ? [nextSearch.view] : []), ...nextRoots.values()];
        const newMount = [...nextFiles.keys()].some(key => !fileViews.has(key))
            || [...nextRoots.keys()].some(key => !rootViews.has(key)) || nextSearch && nextSearch !== search;
        if (candidate && newMount) {
            const result = context.prepareOpeningProjection({ views });
            if (result.status === 'rejected') throw new IDEError(result.issue.code);
        } else context.prepareProjection({ views });
        fileViews = nextFiles;
        rootViews = nextRoots;
        search = nextSearch ?? undefined;
    }

    context.registerCleanup({ stop: () => owner.stop(), close: () => owner.close() });
    render();
    void owner.start().catch(() => {});
}
