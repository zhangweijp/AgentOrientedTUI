import { performance } from 'node:perf_hooks';
import {
    createAppInteraction, createSnapshotCore, hostedObservationNamespace,
} from '@aotui/core/host';
import type { ExecutionResolver, InstanceInteraction, AppInteractionPolicy } from '@aotui/core';
import type { CommitResult, PreparedSnapshotFailure, SnapshotIssueCode } from '@aotui/core';

export type SnapshotAcceptance = CommitResult & Readonly<{ healthChanged: boolean }>;

const monotonicNow = () => Math.floor(performance.timeOrigin + performance.now());

/** Owns one App instance's committed source and its observations and calls. */
export class SemanticSnapshotReceiver {
    private readonly core: ReturnType<typeof createSnapshotCore>;
    private interactions?: InstanceInteraction;
    private interactionsClosed = false;
    private stopped = false;
    private completion?: Promise<void>;

    constructor(readonly appId: string, readonly instanceId: string, private readonly now: () => number = monotonicNow) {
        this.core = createSnapshotCore({ appId, instanceId, now });
    }

    interaction(policy: AppInteractionPolicy, execution: ExecutionResolver,
        options?: Pick<Parameters<typeof createAppInteraction>[1], 'observationLimits' | 'refreshProjection' | 'canExposeTools'>): InstanceInteraction {
        if (this.interactionsClosed || this.stopped) throw new Error('App interaction is unavailable');
        return this.interactions ??= createAppInteraction(this.core.store, {
            appId: this.appId, instanceId: this.instanceId, namespace: hostedObservationNamespace(this.instanceId), now: this.now, policy, execution,
            ...options,
        });
    }

    currentPublication() { return this.core.currentPublication(); }

    currentViews() {
        const state = this.core.store.readLatest(this.appId);
        return (state.status === 'ready' ? state.snapshot : state.status === 'degraded' ? state.lastGood : undefined)?.views ?? [];
    }

    getInteractionStats() { return this.interactions?.inspect() ?? null; }

    closeInteractions(): Promise<void> {
        if (!this.interactionsClosed) {
            this.interactionsClosed = true;
            this.interactions?.close();
        }
        return this.interactions?.whenClosed() ?? Promise.resolve();
    }

    acceptPrepared(input: unknown): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        if (!this.hasOwnSource(input)) return this.unavailable('APP_INSTANCE_MISMATCH');
        const before = this.healthKey();
        const result = this.core.committer.accept(input);
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    acceptPrepareFailure(failure: PreparedSnapshotFailure): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        if (failure.appId !== this.appId || failure.instanceId !== this.instanceId) return this.unavailable('APP_INSTANCE_MISMATCH');
        const before = this.healthKey();
        const result = this.core.committer.reportPrepareFailure(failure);
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    invalidatePublication(): void {
        if (this.stopped) return;
        this.core.lifecycle.invalidatePublication({ code: 'SNAPSHOT_UNAVAILABLE', message: 'The App execution is disconnected.' });
    }

    close(): Promise<void> {
        if (this.completion) return this.completion;
        this.stopped = true;
        this.core.lifecycle.stop();
        this.completion = (this.interactions?.whenClosed() ?? Promise.resolve()).then(() => this.core.lifecycle.dispose());
        void this.closeInteractions();
        return this.completion;
    }

    private healthKey(): string {
        const state = this.core.store.readLatest(this.appId);
        return state.status === 'degraded' ? JSON.stringify([state.status, state.issue.code, state.issue.path]) : state.status;
    }

    private unavailable(code: SnapshotIssueCode): SnapshotAcceptance {
        return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: 'Snapshot source is unavailable' }), healthChanged: false });
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
