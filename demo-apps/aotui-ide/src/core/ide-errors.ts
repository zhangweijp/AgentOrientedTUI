export class IDEError extends Error {
    constructor(readonly code: string, readonly effects: 'none' | 'partial' | 'unknown' = 'none', readonly details?: unknown) { super(code); }
}
export function requireIDE(condition: unknown, code: string): asserts condition {
    if (!condition) throw new IDEError(code);
}
export function boundedJSON<T>(value: T, bytes = 256 * 1024): T {
    const pending: Array<[unknown, number]> = [[value, 0]];
    let nodes = 0, measured = 0;
    const stringBytes = (text: string) => {
        requireIDE(Buffer.byteLength(text, 'utf8') <= bytes, 'IDE_RESULT_TOO_LARGE');
        return Buffer.byteLength(JSON.stringify(text), 'utf8');
    };
    while (pending.length) {
        const [item, depth] = pending.pop()!;
        requireIDE(++nodes <= 5000 && depth <= 24, 'IDE_RESULT_TOO_LARGE');
        if (typeof item === 'string') measured += stringBytes(item);
        else if (item === null || typeof item === 'boolean') measured += item === false ? 5 : 4;
        else if (typeof item === 'number') { requireIDE(Number.isFinite(item), 'IDE_RESULT_INVALID'); measured += String(item).length; }
        else {
            requireIDE(item && typeof item === 'object' && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null), 'IDE_RESULT_INVALID');
            const keys = Object.keys(item); requireIDE(nodes + pending.length + keys.length <= 5000, 'IDE_RESULT_TOO_LARGE');
            measured += 2 + Math.max(0, keys.length - 1);
            for (const key of keys) { if (!Array.isArray(item)) measured += stringBytes(key) + 1; pending.push([(item as Record<string, unknown>)[key], depth + 1]); }
        }
        requireIDE(measured <= bytes, 'IDE_RESULT_TOO_LARGE');
    }
    requireIDE(Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes, 'IDE_RESULT_TOO_LARGE');
    return value;
}
export function nextVersion(version: number): number {
    requireIDE(Number.isSafeInteger(version) && version < Number.MAX_SAFE_INTEGER, 'IDE_VERSION_EXHAUSTED');
    return version + 1;
}
export async function closeDirectory(handle: { close(): Promise<void> }): Promise<void> {
    try { await handle.close(); }
    catch (error: any) { if (error.code !== 'ERR_DIR_CLOSED') throw new IDEError('IDE_DIRECTORY_CLOSE_UNCERTAIN', 'unknown'); }
}
