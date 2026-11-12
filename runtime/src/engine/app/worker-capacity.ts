import { closeError } from '../core/close-handle.js';

export interface WorkerCapacityReport {
    readonly state: 'open' | 'closing' | 'closed';
    readonly limit: number;
    readonly total: number;
}

/** Admission only. The Host releases its slot after the Worker actually exits. */
export class WorkerCapacity {
    private state: WorkerCapacityReport['state'] = 'open';
    private total = 0;
    private completion?: Promise<void>;
    private resolveClose?: () => void;

    constructor(private readonly limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw closeError('CONFIG_INVALID');
    }

    reserve(): () => void {
        if (this.state !== 'open') throw closeError('WORKER_CAPACITY_CLOSED');
        if (this.total >= this.limit) throw closeError('WORKER_CAPACITY_EXCEEDED');
        this.total++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.total--;
            this.finishClose();
        };
    }

    close(): Promise<void> {
        if (this.completion) return this.completion;
        this.state = 'closing';
        this.completion = new Promise(resolve => { this.resolveClose = resolve; });
        this.finishClose();
        return this.completion;
    }

    getReport(): WorkerCapacityReport {
        return Object.freeze({ state: this.state, limit: this.limit, total: this.total });
    }

    private finishClose(): void {
        if (this.state !== 'closing' || this.total !== 0) return;
        this.state = 'closed';
        this.resolveClose?.();
        this.resolveClose = undefined;
    }
}
