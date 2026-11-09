/**
 * 文件信息（最近打开的文件）
 */
export interface FileInfo {
    path: string;
    lastOpened: number;
}

export interface Diagnostic {
    line?: number;
    character?: number;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    severity: number | 'error' | 'warning' | 'info' | 'hint';
    code?: string | number;
    message: string;
    source?: string;
}
