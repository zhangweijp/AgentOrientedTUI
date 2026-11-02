/**
 * M3 SPI: semantic projection lifecycle, independent of the UI renderer.
 * SDK can bracket explicit commits; Runtime owns mutation epochs.
 */
export type ProjectionChange = 'view' | 'ref' | 'tool' | 'content';

export interface ProjectionToken {
    readonly epoch: number;
    readonly ready: boolean;
}

export interface IProjectionPort {
    beginCommit(): void;
    endCommit(): void;
    recordMutation(kind: ProjectionChange): number;
    token(): ProjectionToken;
    subscribe(listener: (token: ProjectionToken) => void): () => void;
}
