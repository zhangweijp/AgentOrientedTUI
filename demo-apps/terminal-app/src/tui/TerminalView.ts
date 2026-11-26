import type { TerminalSession } from '../types.js';

export function terminalBody(terminal: TerminalSession): string {
    const active = terminal.commands.at(-1);
    const output = active?.outputLines.slice(-terminal.outputTail).join('\n') ?? '';
    let fenceLength = 3;
    for (const match of output.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return [
        '## Terminal ' + terminal.id,
        '',
        '- **Status:** ' + terminal.status,
        '- **Current Path:** ' + terminal.cwd,
        `- **Output Tail:** ${terminal.outputTail} lines`,
        '',
        '### History Commands',
        '',
        ...(terminal.commands.length ? terminal.commands.map(({ command, status }) => `- **${command}** - ${status}`) : ['No commands yet.']),
        '',
        '### Current Command',
        '',
        ...(active ? [
            '- **Command:** ' + active.command,
            '- **Status:** ' + active.status,
            ...(active.exitCode === undefined ? [] : ['- **Exit Code:** ' + active.exitCode]),
        ] : ['No active command.']),
        '',
        '### Command Output',
        '',
        ...(output ? [fence, output, fence] : ['No output.']),
    ].join('\n');
}
