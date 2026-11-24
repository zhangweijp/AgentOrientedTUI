export interface LogEntry {
    timestamp: number;
    message: string;
    level: 'info' | 'warn' | 'error';
}

export class DesktopLogger {
    private systemLogs: LogEntry[] = [];

    constructor(private readonly maxSystemLogs = 100) {}

    logSystem(message: string, level: LogEntry['level'] = 'info'): void {
        this.systemLogs.push({ timestamp: Date.now(), message, level });
        if (this.systemLogs.length > this.maxSystemLogs) this.systemLogs.shift();
    }

    getSystemLogs(): LogEntry[] {
        return this.systemLogs;
    }

    cleanup(): void {
        this.systemLogs = [];
    }
}
