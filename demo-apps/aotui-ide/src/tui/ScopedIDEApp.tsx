import { View, useAppRuntimeContext, useEffect, useMemo, useState, useViewTypeTool,
    useAppLifecycle } from '@aotui/sdk';
import { IDESession, type IDEFile } from '../core/ide-session.js';
import { workspaceTools, fileTools, searchTools, type IDEToolContract } from './ide-tool-contracts.js';
import { DiagnosticsReadTool } from './DiagnosticsReadTool.js';
import { WorkspaceCreateView } from './WorkspaceCreateView.js';
import { requireIDE } from '../core/ide-errors.js';
import { resolveIDEOptions } from '../core/app-options.js';
import path from 'node:path';

function IDETool({ owner, viewId, contract, filePath }: { owner: IDESession; viewId: string; contract: IDEToolContract; filePath?: string }) {
    const enabled = owner.live && owner.ready && (contract.name !== 'batch_edit' || owner.files.size > 0) &&
        (viewId !== 'workspace' || contract.name === 'add_folder_to_workspace' ||
        (contract.name === 'remove_folder_from_workspace' && owner.unavailableRoots.length > 0) || owner.roots.length > 0);
    const target = contract.targetParam ? { param: contract.targetParam, value: contract.targetParam === 'view_id' ? viewId : filePath! } : undefined;
    useViewTypeTool(contract.name, { description: contract.description, params: contract.params, isMutating: true,
        ...(target ? { target } : {}) }, async args => {
        const result = await owner.invoke(contract.name, args, viewId);
        if (!result.success) return result;
        // Queries publish their business data in Views; the result only points to it.
        const destination = contract.name.startsWith('search_files_by_') ? 'search'
            : ['close_file_detail', 'delete_file'].includes(contract.name) ? 'workspace' : viewId;
        const data = contract.name.startsWith('search_files_by_') || contract.name.startsWith('lsp_') || contract.name === 'batch_edit'
            ? {} : result.data;
        return { ...result, data: { ...data, message: `${contract.name} completed. Read the current IDE Views for the updated state.`, view_id: destination } };
    }, { enabled });
    return null;
}
function Workspace({ owner }: { owner: IDESession }) {
    return <section>
        <h2>Workspace</h2><p>Load existing files before editing, deleting or renaming them. Each call uses the IDE's current loaded file and workspace state.</p>
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
        {workspaceTools.map(contract => <IDETool key={contract.name} owner={owner} viewId="workspace" contract={contract} />)}
        {owner.lastBatch && <><h3>Last batch result</h3><pre>{JSON.stringify(owner.lastBatch, null, 2)}</pre></>}
    </section>;
}
function FileDetail({ owner, file, diagnosticsRead }: { owner: IDESession; file: IDEFile; diagnosticsRead: boolean }) {
    return <section>
        <h2>{file.observed.path}</h2><p>View ID: {file.viewId}. LSP positions use one-based lines and characters in the complete loaded document.</p>
        <h3>Content</h3><pre>{file.page}</pre>
        {fileTools.map(contract => <IDETool key={contract.name} owner={owner} viewId={file.viewId} filePath={file.observed.path} contract={contract} />)}
        {Object.entries(file.panels).map(([name, value]) => <section key={name}><h3>{name}</h3><pre>{JSON.stringify(value, null, 2)}</pre></section>)}
        {diagnosticsRead && <DiagnosticsReadTool state={file.diagnostics} />}
    </section>;
}
function Search({ owner }: { owner: IDESession }) {
    const search = owner.search!;
    return <section><h2>{'Search: ' + search.query}</h2><p>{search.paths.length} matching files. This result is complete for its accepted search profile.</p>
        <ul>{search.paths.map(file => <li key={file}>{file}</li>)}</ul>
        {searchTools.map(contract => <IDETool key={contract.name} owner={owner} viewId="search" contract={contract} />)}</section>;
}
export function ScopedIDEApp() {
    const context = useAppRuntimeContext(), config = context.launchConfig ?? {};
    const [, render] = useState(0);
    const owner = useMemo(() => {
        requireIDE(context.persistence, 'IDE_PERSISTENCE_UNAVAILABLE');
        return new IDESession(context.persistence, resolveIDEOptions(context), () => render(value => value + 1));
    }, []);
    useAppLifecycle({ stop: () => owner.stop(), close: () => owner.close() });
    useEffect(() => { void owner.start().catch(() => {}); }, [owner]);
    return <>
        <View id="root" type="Root" name="IDE">
            <section data-role="application-instruction">
                <h1>AOTUI IDE - Application Instruction</h1>
                <h2>What it is</h2><p>A text-based Integrated Development Environment for LLM Agents. Work across multiple authorized folders, search source, read and edit loaded files, and inspect language information through LSP.</p>
                <h2>How to use</h2><ol>
                    <li>Start in Workspace. Add authorized folders and inspect each directory tree.</li>
                    <li>Locate files with search_files_by_pattern or search_files_by_content. Review matches in SearchResult.</li>
                    <li>Use multi_open_file with absolute paths to load files and open their FileDetail Views.</li>
                    <li>Read the current FileDetail, then use its editing or language tools. Use the target file path or view_id required by the Tool schema to select the intended object.</li>
                    <li>Read operation receipts and the updated Views. If a write outcome is unknown, inspect the actual file before another write. Reopen a file to refresh its loaded content after an external change.</li>
                </ol>
                <h2>Views</h2>
                <h3>Workspace</h3><p>Shows workspace folders, expanded directory trees and opened files. Folder, search, open/close and create operations belong here.</p>
                <h4>Available Tools</h4><ul>{workspaceTools.map(tool => <li key={tool.name}>{tool.name}</li>)}</ul>
                <h4>Tool Preconditions</h4><ul>
                    <li>add_folder_to_workspace requires an authorized absolute folder path. remove_folder_from_workspace requires a listed folder.</li>
                    <li>search_files_by_pattern and search_files_by_content require a workspace folder. Optional cwd must remain inside it.</li>
                    <li>multi_open_file requires absolute file paths inside the workspace. multi_close_file requires currently opened files.</li>
                    <li>create_file creates a new file without overwriting an existing one. batch_edit is available after files are loaded and operates only on those loaded files.</li>
                    <li>multi_open_dirs, multi_close_dirs and refresh_workspace require workspace folders.</li>
                </ul>
                <h3>FileDetail</h3><p>Shows one loaded file with line numbers, its visible range, language panels and current operations. Editing tools become available only after this View opens.</p>
                <h4>Available Tools</h4><ul>{fileTools.map(tool => <li key={tool.name}>{tool.name}</li>)}
                    {config.enableDiagnosticsRead !== false && <li>read_loaded_diagnostics</li>}
                </ul>
                <h4>Tool Preconditions</h4><ul>
                    <li>write_file, edit_file and delete_file select a loaded file by filePath; rename_file uses oldPath and newPath. These tools check that its disk identity and content have not changed.</li>
                    <li>LSP tools require this open View and its absolute file_path. Positions use one-based lines and characters in the complete loaded document.</li>
                    <li>close_file_detail requires this View's view_id. Closing the View removes its tools.</li>
                </ul>
                <h3>SearchResult</h3><p>Shows the latest successful search. Use Workspace's multi_open_file to inspect matching paths. close_search_view requires the current SearchResult view_id.</p>
                <h4>Available Tools</h4><ul>{searchTools.map(tool => <li key={tool.name}>{tool.name}</li>)}</ul>
                {config.enableWorkspaceCreate === true && <>
                    <h3>WorkspaceCreate</h3><p>Creates a new file relative to the workspace named in the View. Requires an existing parent directory and never overwrites a file.</p>
                    <h4>Available Tools</h4><ul><li>create_file_if_absent</li></ul>
                </>}
                <p>Available Tools is a static catalog by View Type; listing a tool does not make it callable. Descriptions explain the workflow; the currently callable Tools and their exact parameters are those attached to the current context. File contents and query results are presented in Views.</p>
            </section>
            {!owner.ready && <p>{owner.error ? 'Initialization failed: ' + owner.error : 'Restoring the IDE session…'}</p>}
            {owner.warnings.length > 0 && <ul>{owner.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        </View>
        <View id="workspace" type="Workspace" name="Workspace"><Workspace owner={owner} /></View>
        {[...owner.files.values()].map(file => <View key={file.viewId} id={file.viewId} type="FileDetail" name={'File: ' + file.observed.path}>
            <FileDetail owner={owner} file={file} diagnosticsRead={config.enableDiagnosticsRead !== false} /></View>)}
        {owner.search && <View key={owner.search.incarnation} id="search" type="SearchResult" name="Search Results"><Search owner={owner} /></View>}
        {config.enableWorkspaceCreate === true && owner.ready && owner.roots.map((root, index) => <WorkspaceCreateView key={root.path + ':' + root.identity}
            viewId={'create_' + index} workspaceLabel={root.path} creator={root.creator} isCurrent={() => owner.live && owner.roots.includes(root)} />)}
    </>;
}
