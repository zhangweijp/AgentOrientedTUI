import { View } from '@aotui/sdk';
import type { IDESession } from '../core/ide-session.js';
import { workspaceCreateBindings, WorkspaceCreateType } from './ide-tool-contracts.js';

export interface WorkspaceCreateViewProps {
    readonly owner: IDESession;
    readonly viewId: string;
    readonly workspacePath: string;
}

export function WorkspaceCreateView({ owner, viewId, workspacePath }: WorkspaceCreateViewProps) {
    return <View kind="state" id={viewId} type={WorkspaceCreateType} bindings={workspaceCreateBindings(owner, workspacePath)} name={`Workspace: ${workspacePath}`}>
        <section>
            <h2>Workspace: {workspacePath}</h2>
            <p>Use this View’s XML id with create_file_if_absent. The application checks that it is still open and authorized.</p>
        </section>
    </View>;
}
