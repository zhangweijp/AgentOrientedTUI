/* Ready/run/invoke/result protocol adapted from DeepSeek Harness protocol.ts, revision
 * 2e39e70496aa02986ca6a820c5d497e816b69d7e. Copyright (c) 2026 DeepSeek.
 * See LICENSE.deepseek-harness. This transport carries only bounded JSON. */
import type { Readable, Writable } from 'node:stream';

export const VERSION = 6;
export const FRAME_BYTES = 192 * 1024;
export const OUTPUT_BYTES = 8 * 1024;
export const MAX_CALLS = 24;
export const MAX_LOGS = 128;

export function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function frame(message: unknown): string {
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > FRAME_BYTES) throw new Error('Console message exceeds the byte limit.');
    return data + '\n';
}

export function writeFrame(stream: Writable, message: unknown): void {
    stream.write(frame(message));
}

export function readFrames(stream: Readable, accept: (message: Record<string, unknown>) => void, reject: () => void): void {
    const decode = new TextDecoder('utf-8', { fatal: true });
    let carry = Buffer.alloc(0);
    let failed = false;
    const fail = () => {
        if (failed) return;
        failed = true;
        carry = Buffer.alloc(0);
        reject();
    };
    stream.on('error', fail);
    stream.on('end', () => { if (carry.length) fail(); });
    stream.on('data', (chunk: Buffer) => {
        if (failed) return;
        try {
            let start = 0;
            while (start < chunk.length) {
                const end = chunk.indexOf(10, start);
                const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
                if (carry.length + piece.length > FRAME_BYTES) throw new Error();
                const data = carry.length ? Buffer.concat([carry, piece]) : piece;
                if (end < 0) { carry = Buffer.from(data);return; }
                carry = Buffer.alloc(0);
                const value: unknown = JSON.parse(decode.decode(data));
                if (!record(value)) throw new Error();
                accept(value);
                start = end + 1;
            }
        } catch { fail(); }
    });
}

export function clipText(text: string, bytes: number): string {
    let output = '', taken = 0;
    for (const character of text) {
        taken += Buffer.byteLength(character);
        if (taken > bytes) break;
        output += character;
    }
    return output;
}
