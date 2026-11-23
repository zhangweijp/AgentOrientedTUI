import type { IDESession } from '../core/ide-session.js';
import { WorkspaceCreateType } from './ide-tool-contracts.js';

export interface WorkspaceCreateViewProps {
    readonly owner: IDESession;
    readonly workspacePath: string;
}

export function WorkspaceCreateView({ owner, workspacePath }: WorkspaceCreateViewProps) {
    return <WorkspaceCreateType idPrefix="create" context={{ owner, path: workspacePath }} name={`Workspace: ${workspacePath}`}>
        <section>
            <h2>Workspace: {workspacePath}</h2>
            <p>Use this page’s XML view_id with create_file_if_absent. The application checks that it is still open and authorized.</p>
        </section>
    </WorkspaceCreateType>;
}
