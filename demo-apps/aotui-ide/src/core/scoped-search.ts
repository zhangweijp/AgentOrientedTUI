import { Worker } from 'node:worker_threads';
import { IDEError, requireIDE } from './ide-errors.js';

export type SearchRoot = Readonly<{ path: string; identity: string; workspace: string; workspaceIdentity: string }>;

export class ScopedSearch {
    private live = true;
    private worker?: Worker;
    private actual?: Promise<{ paths: string[]; candidates: number; bytes: number }>;
    private cleanupFailed = false;
    private termination?: Promise<void>;
    private terminate(): void {
        if (this.worker && !this.termination) this.termination = this.worker.terminate().then(() => {}, () => { this.cleanupFailed = true; });
    }
    run(input: { roots: SearchRoot[]; kind: 'pattern' | 'content'; pattern: string; include?: string }) {
        requireIDE(this.live, 'SEARCH_CLOSED'); requireIDE(!this.worker, 'SEARCH_BUSY');
        for (const value of [input.pattern, input.include ?? '']) requireIDE(Buffer.byteLength(value) <= 4096, 'SEARCH_PATTERN_TOO_LARGE');
        this.termination = undefined;
        const worker = this.worker = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: input });
        let result: any, failure: Error | undefined;
        this.actual = new Promise((resolve, reject) => {
            const deadline = setTimeout(() => { failure = new IDEError('SEARCH_DEADLINE'); this.terminate(); }, 5000);
            worker.once('message', message => {
                result = message;
                if (!message?.ok && /CLEANUP|CLOSE_UNCERTAIN/.test(message?.code ?? '')) this.cleanupFailed = true;
            });
            worker.once('error', error => { failure = error; });
            worker.once('exit', code => {
                clearTimeout(deadline); this.worker = undefined;
                if (!this.live) reject(new IDEError('SEARCH_CLOSED'));
                else if (failure) reject(failure);
                else if (code || !result?.ok) reject(new IDEError(result?.code ?? 'SEARCH_FAILED', 'none', result?.details));
                else resolve(result.result);
            });
        });
        void this.actual.catch(() => {}); return this.actual;
    }
    stop(): void { this.live = false; this.terminate(); }
    async close(): Promise<void> { this.stop(); await this.actual?.catch(() => {}); await this.termination; requireIDE(!this.worker && !this.cleanupFailed, 'SEARCH_CLEANUP_FAILED'); }
    inspect() { return { live: this.live, workers: this.worker ? 1 : 0 }; }
}
