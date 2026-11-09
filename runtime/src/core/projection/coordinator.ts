/**
 * M3: framework-neutral semantic projection change tracking.
 *
 * This is NOT a business state store and does not depend on Preact, DOM, Worker
 * or the Agent/Tool execution path. SDK/Worker adapters choose how to signal
 * commit boundaries and consume the token.
 */
import type { IProjectionPort, ProjectionChange, ProjectionToken } from '../../spi/runtime/projection.interface.js';

export class SemanticProjectionCoordinator implements IProjectionPort {
    private epoch = 0;
    private commitDepth = 0;
    private pendingNotice = false;
    private queuedNotice = false;
    private readonly listeners = new Set<(token: ProjectionToken) => void>();
    private readonly commits = new Set<() => void>();

    beginCommit(): void {
        this.commitDepth++;
    }

    endCommit(): void {
        if (this.commitDepth === 0) {
            throw new Error('Projection commit end without begin');
        }
        this.commitDepth--;
        if (this.commitDepth === 0) {
            for (const complete of [...this.commits]) complete();
            this.scheduleNotice();
        }
    }

    whenCommitted(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' }));
        if (this.commitDepth === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => { this.commits.delete(complete); signal.removeEventListener('abort', abort); };
            const complete = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' })); };
            this.commits.add(complete);
            signal.addEventListener('abort', abort, { once: true });
        });
    }

    recordMutation(_kind: ProjectionChange): number {
        if (this.epoch === Number.MAX_SAFE_INTEGER) {
            throw new Error('Projection epoch exhausted');
        }
        this.epoch++;
        this.pendingNotice = true;
        if (this.commitDepth === 0) this.scheduleNotice();
        return this.epoch;
    }

    token(): ProjectionToken {
        return Object.freeze({
            epoch: this.epoch,
            ready: this.commitDepth === 0,
        });
    }

    subscribe(listener: (token: ProjectionToken) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private scheduleNotice(): void {
        if (!this.pendingNotice || this.queuedNotice || this.commitDepth !== 0) return;
        this.queuedNotice = true;
        queueMicrotask(() => {
            this.queuedNotice = false;
            if (this.commitDepth !== 0 || !this.pendingNotice) return;
            this.pendingNotice = false;
            const snapshot = this.token();
            for (const listener of [...this.listeners]) {
                try {
                    listener(snapshot);
                } catch {
                    // Adapter diagnostics are isolated: a subscriber cannot break
                    // the synchronous semantic registry mutation.
                }
            }
            if (this.pendingNotice) this.scheduleNotice();
        });
    }
}
