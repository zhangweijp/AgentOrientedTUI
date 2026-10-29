import { View, useAppRuntimeContext, useEffect, useMemo, useState, useViewTypeTool,
    experimental_useAppLifecycle } from '@aotui/sdk';
import { IDESession, type IDEFile } from '../core/ide-session.js';
import { workspaceTools, fileTools, searchTools, type IDEToolContract } from './ide-tool-contracts.js';
import { DiagnosticsReadTool } from './DiagnosticsReadTool.js';
import { WorkspaceCreateView } from './WorkspaceCreateView.js';
import { requireIDE } from '../core/ide-errors.js';
import { resolveIDEOptions } from '../core/app-options.js';

function IDETool({ owner, viewId, contract }: { owner: IDESession; viewId: string; contract: IDEToolContract }) {
    const [Tool] = useViewTypeTool(contract.name, { description: contract.description, params: contract.params, isMutating: true },
        args => owner.invoke(contract.name, args, viewId),
        { enabled: owner.live && owner.ready && (contract.name !== 'batch_edit' || owner.files.size > 0) &&
            (viewId !== 'workspace' || contract.name === 'add_folder_to_workspace' ||
            (contract.name === 'remove_folder_from_workspace' && owner.unavailableRoots.length > 0) || owner.roots.length > 0) });
    return <li><Tool /></li>;
}
function Workspace({ owner }: { owner: IDESession }) {
    return <section>
        <h2>Workspace</h2><p>Load existing files before editing, deleting or renaming them. Each call uses the IDE's current loaded file and workspace state.</p>
        <pre>{owner.tree || 'No folders. Add an authorized folder to begin.'}</pre>
        {owner.unavailableRoots.length > 0 && <section>
            <h3>Unavailable folders</h3>
            <p>These saved folders are missing or no longer reachable as directories. Their paths remain in this session.
                Restore a folder at its listed path and use add_folder_to_workspace to reconnect it, or use remove_folder_from_workspace to remove its saved entry.</p>
            <ul>{owner.unavailableRoots.map(folder => <li key={folder}>{folder}</li>)}</ul>
        </section>}
        <h3>Loaded files</h3><ul>{[...owner.files.values()].map(file => <li key={file.viewId}>{file.observed.path} — View {file.viewId}</li>)}</ul>
        <h3>Actions</h3><ul>{workspaceTools.map(contract => <IDETool key={contract.name} owner={owner} viewId="workspace" contract={contract} />)}</ul>
        {owner.lastBatch && <><h3>Last batch result</h3><pre>{JSON.stringify(owner.lastBatch, null, 2)}</pre></>}
    </section>;
}
function FileDetail({ owner, file, diagnosticsRead }: { owner: IDESession; file: IDEFile; diagnosticsRead: boolean }) {
    return <section>
        <h2>{file.observed.path}</h2><p>View ID: {file.viewId}. LSP positions use one-based lines and characters in the complete loaded document.</p>
        <pre>{file.page}</pre><ul>{fileTools.map(contract => <IDETool key={contract.name} owner={owner} viewId={file.viewId} contract={contract} />)}</ul>
        {Object.entries(file.panels).map(([name, value]) => <section key={name}><h3>{name}</h3><pre>{JSON.stringify(value, null, 2)}</pre></section>)}
        {diagnosticsRead && <DiagnosticsReadTool state={file.diagnostics} />}
    </section>;
}
function Search({ owner }: { owner: IDESession }) {
    const search = owner.search!;
    return <section><h2>{'Search: ' + search.query}</h2><p>{search.paths.length} matching files. This result is complete for its accepted search profile.</p>
        <ul>{search.paths.map(file => <li key={file}>{file}</li>)}</ul>
        <ul>{searchTools.map(contract => <IDETool key={contract.name} owner={owner} viewId="search" contract={contract} />)}</ul></section>;
}
export function ScopedIDEApp() {
    const context = useAppRuntimeContext(), config = context.launchConfig ?? {};
    const [, render] = useState(0);
    const owner = useMemo(() => {
        requireIDE(context.persistence, 'IDE_PERSISTENCE_UNAVAILABLE');
        return new IDESession(context.persistence, resolveIDEOptions(context), () => render(value => value + 1));
    }, []);
    experimental_useAppLifecycle({ stop: () => owner.stop(), close: () => owner.close() });
    useEffect(() => { void owner.start().catch(() => {}); }, [owner]);
    return <>
        <View id="root" type="Root" name="IDE">
            <section data-role="application-instruction">
                <h1>IDE Application Instruction</h1>
                <h2>What it is</h2><p>Browse authorized workspaces, search source, edit loaded files and inspect language information.</p>
                <h2>How to use</h2><p>Explore Workspace, open files with multi_open_file, then inspect FileDetail for content and language tools. Invoke the Tool binding from the observed target View. If a write outcome is unknown, inspect the actual file before another write.</p>
                <h2>Views</h2><p>Workspace owns folders, files and searches.</p>
                {owner.files.size > 0 && <p>Each FileDetail shows a loaded file, language panels and its close action.</p>}
                {owner.search && <p>SearchResult shows the latest successful search and its close action.</p>}
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
