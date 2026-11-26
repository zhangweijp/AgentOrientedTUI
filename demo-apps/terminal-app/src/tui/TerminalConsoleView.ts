import type { TerminalSession } from '../types.js';

export function terminalConsoleBody(projectPath: string, terminals: readonly TerminalSession[]): string {
    return [
        '## Terminal Console',
        '',
        '- **Project Path:** ' + projectPath,
        '- **Open Terminals:** ' + terminals.length,
        ...terminals.map(terminal => `- ${terminal.id} — ${terminal.status}`),
    ].join('\n');
}
