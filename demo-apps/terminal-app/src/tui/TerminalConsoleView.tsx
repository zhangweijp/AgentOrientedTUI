import type { TerminalSession } from '../types.js';

type TerminalConsoleViewProps = {
    projectPath: string;
    terminals: TerminalSession[];
};

export function TerminalConsoleView({ projectPath, terminals }: TerminalConsoleViewProps) {
    const terminalIds = terminals.map(terminal => terminal.id).join(', ') || 'None';

    return (
        <div>
            <h2>Terminal Console</h2>
            <ul>
                <li><strong>Project Path:</strong> {projectPath}</li>
                <li><strong>Open Terminals:</strong> {terminals.length}</li>
                <li><strong>Terminal IDs:</strong> {terminalIds}</li>
            </ul>
            {terminals.length > 0 ? (
                <ul>
                    {terminals.map(terminal => (
                        <li key={terminal.id}>{terminal.id} — {terminal.status}</li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
