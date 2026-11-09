import { performance } from 'node:perf_hooks';
import { createSnapshotCore } from '../../core/snapshot/store.js';
import { createScopedInteraction } from '../../core/invocation/scoped-interaction.js';
import type { ExecutionResolver, InteractionAuthority, ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import type { CommitResult, PreparedSnapshotFailure, SnapshotHealth, SnapshotIssueCode } from '../../core/snapshot/types.js';

export interface SemanticSnapshotReport {
    readonly appId: string;
    readonly instanceId: string;
    readonly health: SnapshotHealth;
    readonly revision?: number;
    readonly snapshotId?: string;
    readonly prepared: number;
    readonly published: number;
    readonly unchanged: number;
    readonly rejected: number;
    readonly wrongSource: number;
    readonly prepareFailed: number;
    readonly lastIssueCode?: SnapshotIssueCode;
    readonly lastIssuePath?: string;
    readonly lastViewCount?: number;
    readonly lastRefCount?: number;
    readonly lastToolCount?: number;
}

export type SnapshotAcceptance = CommitResult & Readonly<{ healthChanged: boolean }>;

const monotonicNow = () => Math.floor(performance.timeOrigin + performance.now());

/** Owns one App instance's committed source and the Scopes which refer to it. */
export class SemanticSnapshotReceiver {
    private readonly core: ReturnType<typeof createSnapshotCore>;
    private interactions?: InteractionAuthority;
    private interactionsClosed = false;
    private prepared = 0;
    private published = 0;
    private unchanged = 0;
    private rejected = 0;
    private wrongSource = 0;
    private prepareFailed = 0;
    private lastIssueCode?: SnapshotIssueCode;
    private lastIssuePath?: string;
    private lastViewCount?: number;
    private lastRefCount?: number;
    private lastToolCount?: number;
    private stopped = false;

    constructor(readonly appId: string, readonly instanceId: string, private readonly now: () => number = monotonicNow) {
        this.core = createSnapshotCore({ now });
        this.core.lifecycle.startApp(appId, instanceId);
    }

    createInteractionScope(policy: ScopePolicy, execution: ExecutionResolver): ReturnType<InteractionAuthority['createScope']> {
        if (this.interactionsClosed || this.stopped) return Object.freeze({ status: 'rejected', issue: Object.freeze({
            code: 'REF_EXECUTION_UNAVAILABLE', message: 'Scoped interaction is unavailable' }) });
        this.interactions ??= createScopedInteraction(this.core.store, { namespace: `host:${this.instanceId}`, now: this.now });
        return this.interactions.createScope({ appId: this.appId, instanceId: this.instanceId, policy, execution });
    }

    getInteractionStats() { return this.interactions?.inspect() ?? null; }

    closeInteractions(): Promise<void> {
        this.interactionsClosed = true;
        this.interactions?.close();
        return this.interactions?.whenClosed() ?? Promise.resolve();
    }

    acceptPrepared(input: unknown): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        this.prepared++;
        if (!this.hasOwnSource(input)) return this.wrongInstance();
        const before = this.healthKey();
        const result = this.core.committer.accept(input);
        if (result.status === 'rejected') {
            this.rejected++;
            this.lastIssueCode = result.issue.code;
            this.lastIssuePath = result.issue.path;
        } else {
            if (result.status === 'published') this.published++;
            else this.unchanged++;
            this.lastIssueCode = undefined;
            this.lastIssuePath = undefined;
            this.lastViewCount = result.snapshot.views.length;
            this.lastRefCount = Object.keys(result.snapshot.refs).length;
            this.lastToolCount = Object.keys(result.snapshot.tools).length;
        }
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    acceptPrepareFailure(failure: PreparedSnapshotFailure): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        if (failure.appId !== this.appId || failure.instanceId !== this.instanceId) return this.wrongInstance();
        this.prepareFailed++;
        const before = this.healthKey();
        const result = this.core.committer.reportPrepareFailure(failure);
        if (result.status === 'rejected') {
            this.rejected++;
            this.lastIssueCode = result.issue.code;
            this.lastIssuePath = result.issue.path;
        }
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    close(): void {
        this.closeInteractions();
        if (this.stopped) return;
        this.stopped = true;
        this.core.lifecycle.dispose();
    }

    report(): SemanticSnapshotReport {
        const current = this.core.store.readLatest(this.appId);
        return Object.freeze({
            appId: this.appId, instanceId: this.instanceId, health: current.status,
            ...(current.status === 'ready' ? { revision: current.snapshot.revision, snapshotId: current.snapshot.id } : {}),
            prepared: this.prepared, published: this.published, unchanged: this.unchanged,
            rejected: this.rejected, wrongSource: this.wrongSource, prepareFailed: this.prepareFailed,
            ...(this.lastIssueCode ? { lastIssueCode: this.lastIssueCode } : {}),
            ...(this.lastIssuePath ? { lastIssuePath: this.lastIssuePath } : {}),
            ...(this.lastViewCount !== undefined ? { lastViewCount: this.lastViewCount } : {}),
            ...(this.lastRefCount !== undefined ? { lastRefCount: this.lastRefCount } : {}),
            ...(this.lastToolCount !== undefined ? { lastToolCount: this.lastToolCount } : {}),
        });
    }

    private healthKey(): string {
        const state = this.core.store.readLatest(this.appId);
        return state.status === 'degraded' ? JSON.stringify([state.status, state.issue.code, state.issue.path]) : state.status;
    }

    private unavailable(code: SnapshotIssueCode): SnapshotAcceptance {
        return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: 'Snapshot source is unavailable' }), healthChanged: false });
    }

    private wrongInstance(): SnapshotAcceptance {
        this.rejected++;
        this.wrongSource++;
        this.lastIssueCode = 'APP_INSTANCE_MISMATCH';
        this.lastIssuePath = undefined;
        return this.unavailable('APP_INSTANCE_MISMATCH');
    }

    private hasOwnSource(input: unknown): boolean {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
        try {
            const fields = Object.getOwnPropertyDescriptors(input);
            return !!fields.appId && 'value' in fields.appId && fields.appId.value === this.appId &&
                !!fields.instanceId && 'value' in fields.instanceId && fields.instanceId.value === this.instanceId;
        } catch { return false; }
    }
}
