import type { SnapshotIssue } from '../../core/snapshot/types.js';

export interface ProjectionToken {
    readonly epoch: number;
    readonly ready: boolean;
}

export interface IProjectionPort {
    readonly failure?: SnapshotIssue | undefined;
    beginCommit(): void;
    /** Close a render batch. A blocked render has outstanding repairs from a prior failure. */
    endCommit(failure?: { readonly error: unknown }, blocked?: boolean, mode?: 'opening' | 'restore'):
        'prepared' | 'blocked' | 'failed' | 'restored' | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;
    token(): ProjectionToken;
    subscribe(listener: (token: ProjectionToken) => void): () => void;
}
