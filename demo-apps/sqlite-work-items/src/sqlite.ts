import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SqliteIssue = { code: string; message: string };
type SqliteResult = { rows: unknown[] } | { issue: SqliteIssue; started: boolean };
const outputLimit = 64 * 1024;

function commandIssue(started: boolean, code: string | number | null | undefined): SqliteIssue {
    if (code === 'ABORT_ERR') return { code: 'SQLITE_CANCELLED', message: 'The SQLite command was cancelled.' };
    if (!started) return { code: 'SQLITE_START_FAILED', message: 'Could not start SQLite. Check sqliteExecutable or the Host PATH.' };
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { code: 'SQLITE_OUTPUT_LIMIT', message: 'SQLite output exceeded 64 KiB.' };
    }
    return { code: 'SQLITE_COMMAND_FAILED', message: 'SQLite ended without a successful result.' };
}

function absolutePath(value: unknown, name: string): string {
    if (typeof value === 'string' && isAbsolute(value) && !value.includes('\0')) return value;
    throw Object.assign(new Error(`${name} must be an absolute path`), { code: 'SQLITE_CONFIG_INVALID' });
}

export function openSqlite(databasePath: unknown, sqliteExecutable: unknown) {
    const database = pathToFileURL(absolutePath(databasePath, 'databasePath'));
    const executable = sqliteExecutable === undefined ? 'sqlite3' : absolutePath(sqliteExecutable, 'sqliteExecutable');
    const cancellation = new AbortController();
    let childClosed: Promise<SqliteResult> | undefined;

    function query(mode: 'ro' | 'rw', sql: string): Promise<SqliteResult> {
        if (cancellation.signal.aborted) return Promise.resolve({
            started: false, issue: { code: 'SQLITE_CANCELLED', message: 'The App is closing.' },
        });
        if (childClosed) throw new Error('SQLite commands must run serially');
        database.searchParams.set('mode', mode);
        childClosed = new Promise<SqliteResult>(resolve => {
            let started = false;
            let result: SqliteResult;
            const child = execFile(executable, ['-batch', '-bail', '-json', '-init', devNull, database.href, sql], {
                encoding: 'utf8', maxBuffer: outputLimit, signal: cancellation.signal,
            }, (error, stdout) => {
                if (error) {
                    result = { started, issue: commandIssue(started, error.code) };
                    return;
                }
                try {
                    // The CLI emits no JSON at all for an empty result set.
                    const rows: unknown = stdout.trim() === '' ? [] : JSON.parse(stdout);
                    if (Array.isArray(rows)) {
                        result = { rows };
                        return;
                    }
                } catch { /* Invalid JSON is an unconfirmed result. */ }
                result = { started, issue: { code: 'SQLITE_INVALID_OUTPUT', message: 'SQLite returned invalid JSON rows.' } };
            });
            child.once('spawn', () => { started = true; });
            // execFile's callback may report cancellation before the child has closed.
            child.once('close', () => resolve(result));
        }).catch((): SqliteResult => ({ started: false, issue: commandIssue(false, undefined) }))
            .finally(() => { childClosed = undefined; });
        return childClosed;
    }

    function stop() { cancellation.abort(); }
    return { query, stop, async close() { stop(); await childClosed; } };
}
