import { View } from '@aotui/sdk';

export interface WorkspaceCreateViewProps {
    readonly viewId: string;
    readonly workspacePath: string;
}

export function WorkspaceCreateView({ viewId, workspacePath }: WorkspaceCreateViewProps) {
    return <View kind="state" id={viewId} type="WorkspaceCreate" name={`Workspace: ${workspacePath}`}>
        <section>
            <h2>Workspace: {workspacePath}</h2>
            <p>Choose this workspacePath explicitly in create_file_if_absent. The application checks that it is still open and authorized.</p>
        </section>
    </View>;
}
