import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export namespace Global {
    export namespace Path {
        export const data = path.join(os.homedir(), '.aotui', 'mcp');
    }
}

export namespace Filesystem {
    export async function readJson<T>(filepath: string): Promise<T> {
        try {
            const data = await fs.readFile(filepath, 'utf8');
            return JSON.parse(data);
        } catch (e: any) {
            if (e.code === 'ENOENT') throw e;
            throw new Error(`Failed to parse JSON at ${filepath}: ${e.message}`);
        }
    }

    export async function writeJson(filepath: string, data: any, mode?: number): Promise<void> {
        await fs.mkdir(path.dirname(filepath), { recursive: true });
        await fs.writeFile(filepath, JSON.stringify(data, null, 2), { mode });
    }
}

export namespace Log {
    export function create({ service }: { service: string }) {
        return {
            debug: (...args: any[]) => console.debug(`[${service}]`, ...args),
            info: (...args: any[]) => console.info(`[${service}]`, ...args),
            warn: (...args: any[]) => console.warn(`[${service}]`, ...args),
            error: (...args: any[]) => console.error(`[${service}]`, ...args),
        };
    }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout after ${ms}ms`));
        }, ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
