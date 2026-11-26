export type TerminalStatus = 'idle' | 'running';

export type CommandStatus = 'running' | 'success' | 'failed';

export interface CommandRecord {
    command: string;
    status: CommandStatus;
    exitCode?: number;
    outputLines: string[];
}

export interface TerminalSession {
    id: string;
    cwd: string;
    status: TerminalStatus;
    commands: CommandRecord[];
    outputTail: number;
}
