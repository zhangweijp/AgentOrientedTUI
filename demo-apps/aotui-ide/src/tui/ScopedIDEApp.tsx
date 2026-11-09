import { View, AppTools, ToolRef, ToolCatalog, useAppRuntimeContext, useEffect, useMemo, useState, useAppLifecycle } from '@aotui/sdk';
import { IDESession } from '../core/ide-session.js';
import { createIDEToolBindings, ideTools, ideToolGroups, type IDEToolGroups, type IDEViewTool } from './ide-tool-contracts.js';
import { WorkspaceCreateView } from './WorkspaceCreateView.js';
import { requireIDE } from '../core/ide-errors.js';
import { resolveIDEOptions } from '../core/app-options.js';
import path from 'node:path';

function Workspace({ owner, tools }: { owner: IDESession; tools: IDEToolGroups }) {
    return <section>
        <h2>Workspace</h2><p>Load existing files before editing, deleting or renaming them. Each file action checks the IDE's current loaded file and workspace state.</p>
        {owner.roots.length === 0 && <p>No folders. Add an authorized folder to begin.</p>}
        {owner.roots.map((root, index) => <section key={root.path}>
            <h3>📁 [{index}] {path.basename(root.path)}</h3>
            <p>Path: {root.path}</p>
            <pre>{owner.trees.get(root.path) ?? 'Loading…'}</pre>
        </section>)}
        {owner.unavailableRoots.length > 0 && <section>
            <h3>Unavailable folders</h3>
            <p>These saved folders are missing or no longer reachable as directories. Their paths remain in this session.
                Restore a folder at its listed path and use add_folder_to_workspace to reconnect it, or use remove_folder_from_workspace to remove its saved entry.</p>
            <ul>{owner.unavailableRoots.map(folder => <li key={folder}>{folder}</li>)}</ul>
        </section>}
        <h3>📂 Opened Files</h3>{owner.files.size ? <ul>{[...owner.files.values()].map(file => <li key={file.viewId}>{file.observed.path} — View {file.viewId}</li>)}</ul> : <p>No files open.</p>}
        {tools.workspace.map(tool => <ToolRef key={tool.name} tool={tool} />)}
        {owner.lastBatch && <><h3>Last batch result</h3><pre>{JSON.stringify(owner.lastBatch, null, 2)}</pre></>}
    </section>;
}

function FileDetail({ file, tools }: { file: { viewId: string; observed: { path: string }; page: string; panels: Record<string, unknown> }; tools: IDEToolGroups }) {
    return <section>
        <h2>{file.observed.path}</h2><p>View ID: {file.viewId}. LSP positions use one-based lines and characters in the complete loaded document.</p>
        <h3>Content</h3><pre>{file.page}</pre>
        {tools.file.map(tool => <ToolRef key={tool.name} tool={tool} />)}
        {Object.entries(file.panels).map(([name, value]) => <section key={name}><h3>{name}</h3><pre>{JSON.stringify(value, null, 2)}</pre></section>)}
        <ToolRef tool={ideTools.read_loaded_diagnostics} />
    </section>;
}

function Search({ owner, tools }: { owner: IDESession; tools: IDEToolGroups }) {
    const search = owner.search!;
    return <section><h2>{'Search: ' + search.query}</h2><p>{search.paths.length} matching files. This result is complete for its accepted search profile.</p>
        <ul>{search.paths.map(file => <li key={file}>{file}</li>)}</ul>
        {tools.search.map(tool => <ToolRef key={tool.name} tool={tool} />)}</section>;
}

export function ScopedIDEApp() {
    const context = useAppRuntimeContext(), config = context.launchConfig ?? {};
    const [, render] = useState(0);
    const owner = useMemo(() => {
        requireIDE(context.persistence, 'IDE_PERSISTENCE_UNAVAILABLE');
        return new IDESession(context.persistence, resolveIDEOptions(context), () => render(value => value + 1));
    }, []);
    const tools = ideToolGroups;

    const isEnabled = (definition: IDEViewTool): boolean => {
        if (!owner.live || !owner.ready) return false;
        if (definition.viewType === 'Workspace') {
            if (definition.name === 'add_folder_to_workspace') return true;
            if (definition.name === 'remove_folder_from_workspace') return owner.roots.length > 0 || owner.unavailableRoots.length > 0;
            if (definition.name === 'batch_edit') return owner.roots.length > 0 && owner.files.size > 0;
            return owner.roots.length > 0;
        }
        if (definition.viewType === 'FileDetail') {
            return owner.files.size > 0 &&
                (definition.name !== 'read_loaded_diagnostics' || config.enableDiagnosticsRead !== false);
        }
        if (definition.viewType === 'SearchResult') return owner.search !== null;
        if (definition.viewType === 'WorkspaceCreate') return config.enableWorkspaceCreate === true && owner.roots.length > 0;
        return false;
    };

    useAppLifecycle({ stop: () => owner.stop(), close: () => owner.close() });
    useEffect(() => { void owner.start().catch(() => {}); }, [owner]);

    return <AppTools definition={ideTools} bindings={createIDEToolBindings(owner, isEnabled)}>
        <View kind="instruction" id="root" type="Root" name="IDE">
            <section>
                <h1>AOTUI IDE - Application Instruction</h1>
                <h2>What it is</h2><p>A text-based Integrated Development Environment for LLM Agents. Work across multiple authorized folders, search source, read and edit loaded files, and inspect language information through LSP.</p>
                <h2>How to use</h2><ol>
                    <li>Start in Workspace. Add authorized folders and inspect each directory tree.</li>
                    <li>Locate files with search_files_by_pattern or search_files_by_content. Review matches in SearchResult.</li>
                    <li>Use multi_open_file with absolute paths to load files and open their FileDetail Views.</li>
                    <li>Read the current FileDetail, then use its editing or language tools. File paths and view IDs are ordinary application inputs; the IDE checks that they refer to currently opened objects.</li>
                    <li>Read Tool receipts and the updated Views. If a write outcome is unknown, inspect the actual file before another write. Reopen a file to refresh its loaded content after an external change.</li>
                </ol>
                <h2>Views</h2>
                <h3>Workspace</h3><p>Shows workspace folders, expanded directory trees and opened files. Folder, search, open/close and create actions belong here.</p>

                <h4>Tool Preconditions</h4><ul>
                    <li>add_folder_to_workspace requires an authorized absolute folder path. remove_folder_from_workspace requires a listed folder.</li>
                    <li>search_files_by_pattern and search_files_by_content require a workspace folder. Optional cwd must remain inside it.</li>
                    <li>multi_open_file requires absolute file paths inside the workspace. multi_close_file requires currently opened files.</li>
                    <li>create_file creates a new file without overwriting an existing one. batch_edit is available after files are loaded and operates only on those loaded files.</li>
                    <li>multi_open_dirs, multi_close_dirs and refresh_workspace require workspace folders.</li>
                </ul>
                <h3>FileDetail</h3><p>Shows one loaded file with line numbers, its visible range, language panels and current actions. File tools are registered once for this View Type; filePath parameters are checked against the application's loaded-file state.</p>

                <h4>Tool Preconditions</h4><ul>
                    <li>write_file, edit_file and delete_file require filePath to identify a loaded file; rename_file checks oldPath and newPath.</li>
                    <li>LSP tools require file_path to select a currently opened file. Positions use one-based lines and characters in the complete loaded document.</li>
                    <li>close_file_detail requires the target View's view_id. Closing the View removes its type-level Tool activation when no FileDetail remains.</li>
                </ul>
                <h3>SearchResult</h3><p>Shows the latest successful search. Use Workspace's multi_open_file to inspect matching paths. close_search_view requires the current SearchResult view_id.</p>

                {config.enableWorkspaceCreate === true && <>
                    <h3>WorkspaceCreate</h3><p>Creates a new file relative to the workspacePath selected from the currently open workspace roots. Requires an existing parent directory and never overwrites a file.</p>

                </>}
                <p>The application defines each ordinary Tool once per View Type. A Tool is callable only while the Runtime observes a matching View and the application enables it. Business paths select files and workspaces; the IDE checks those selections against its own current state. File contents and query results are presented in Views.</p>
                <ToolCatalog definition={ideTools} />
            </section>
            {!owner.ready && <p>{owner.error ? 'Initialization failed: ' + owner.error : 'Restoring the IDE session…'}</p>}
            {owner.warnings.length > 0 && <ul>{owner.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        </View>
        <View kind="state" id="workspace" type="Workspace" name="Workspace"><Workspace owner={owner} tools={tools} /></View>
        {[...owner.files.values()].map(file => <View kind="state" key={file.viewId} id={file.viewId} type="FileDetail" name={'File: ' + file.observed.path}>
            <FileDetail file={file} tools={tools} /></View>)}
        {owner.search && <View kind="state" key={owner.search.incarnation} id="search" type="SearchResult" name="Search Results"><Search owner={owner} tools={tools} /></View>}
        {config.enableWorkspaceCreate === true && owner.ready && owner.roots.map((root, index) => <WorkspaceCreateView key={root.path + ':' + root.identity}
            viewId={'create_' + index} workspacePath={root.path} />)}
    </AppTools>;
}
