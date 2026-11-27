import { DEFAULT_PROJECTION_LIMITS, SnapshotDataError } from '@aotui/core';
import { captureViewTypes, captureSnapshotDraftEnvelope, type MinimalViewType } from '@aotui/core/producer';
import { performance } from 'node:perf_hooks';
import {
    createHostedAppInteraction, createSnapshotCore, hostedObservationNamespace,
} from '@aotui/core/host';
import type { SnapshotDraftEnvelope } from '@aotui/core/host';
import type { ExecutionResolver, InstanceInteraction, AppInteractionPolicy } from '@aotui/core';
import type { CommitResult, PreparedSnapshotFailure, SnapshotIssueCode, SnapshotIssue, ProjectionLimits } from '@aotui/core';

export type SnapshotAcceptance = CommitResult & Readonly<{ healthChanged: boolean }>;

const monotonicNow = () => Math.floor(performance.timeOrigin + performance.now());

/** Owns one App instance's committed source and its observations and calls. */
export class SemanticSnapshotReceiver {
    private readonly core: ReturnType<typeof createSnapshotCore>;
    private interactions?: InstanceInteraction;
    private control?: ReturnType<typeof createHostedAppInteraction>['control'];
    private interactionsClosed = false;
    private stopped = false;
    private viewTypes?: readonly MinimalViewType[];
    private completion?: Promise<void>;

    constructor(readonly appId: string, readonly instanceId: string, private readonly now: () => number = monotonicNow, private readonly projectionLimits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS) {
        this.core = createSnapshotCore({ appId, instanceId, now, ...(projectionLimits ? { projectionLimits } : {}) });
    }

    interaction(policy: AppInteractionPolicy, execution: ExecutionResolver,
        options?: Pick<Parameters<typeof createHostedAppInteraction>[1], 'observationLimits' | 'refreshProjection' | 'canExposeTools' | 'limits'>): InstanceInteraction {
        if (this.interactionsClosed || this.stopped) throw new Error('App interaction is unavailable');
        if (this.interactions) return this.interactions;
        const owned = createHostedAppInteraction(this.core.store, {
            appId: this.appId, instanceId: this.instanceId, namespace: hostedObservationNamespace(this.instanceId), now: this.now, policy, execution,
            ...options,
        });
        this.control = owned.control;
        return this.interactions = owned.interaction;
    }

    currentPublication() { return this.core.currentPublication(); }

    currentFailure(): SnapshotIssue | undefined {
        const state = this.core.store.readLatest(this.appId);
        return state.status === 'degraded' ? state.issue : undefined;
    }

    rejectPrepared(envelope: SnapshotDraftEnvelope | undefined, issue: SnapshotIssue, mode: 'authoritative' | 'candidate'): SnapshotAcceptance {
        const before = this.healthKey();
        const result = this.core.committer.rejectPrepared(envelope, issue, mode);
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    currentAdmission() {
        const state = this.core.store.readLatest(this.appId);
        return state.status === "ready" ? state.snapshot.admissionSinceRevision : undefined;
    }

    currentViews() {
        const state = this.core.store.readLatest(this.appId);
        return (state.status === 'ready' ? state.snapshot : state.status === 'degraded' ? state.lastGood : undefined)?.views ?? [];
    }

    getInteractionStats() { return this.control?.readStats() ?? null; }

    readHealth() {
        const state = this.core.store.readLatest(this.appId);
        return Object.freeze({ health: state.status, ...(state.status === 'degraded' ? { issue: state.issue } : {}) });
    }

    closeInteractions(): Promise<void> {
        if (!this.interactionsClosed) {
            this.interactionsClosed = true;
            this.interactions?.close();
        }
        return this.interactions?.whenClosed() ?? Promise.resolve();
    }

    acceptPrepared(input: unknown, mode: "authoritative" | "candidate" = "authoritative", declaration?: unknown): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        if (!this.hasOwnSource(input)) return this.unavailable('APP_INSTANCE_MISMATCH');
        const before = this.healthKey();
        let types = this.viewTypes;
        const first = types === undefined;
        try {
            if (!first && declaration !== undefined)
                throw new SnapshotDataError('SNAPSHOT_INVALID', '$.viewTypes', 'ViewTypes already sealed');
            if (first) types = captureViewTypes(declaration, this.projectionLimits.metadata);
        } catch (error) {
            const issue = error instanceof SnapshotDataError
                ? { code: error.code, path: error.path, message: error.message }
                : { code: 'SNAPSHOT_INVALID' as const, path: '$.viewTypes', message: 'Invalid ViewType declarations' };
            return this.rejectPrepared(captureSnapshotDraftEnvelope(input), issue, mode);
        }
        const result = this.core.committer.accept(input, mode, { types: types!, first });
        if (result.status !== 'rejected' && first) this.viewTypes = types;
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    acceptPrepareFailure(failure: PreparedSnapshotFailure): SnapshotAcceptance {
        if (this.stopped) return this.unavailable('APP_STOPPED');
        if (failure.appId !== this.appId || failure.instanceId !== this.instanceId) return this.unavailable('APP_INSTANCE_MISMATCH');
        const before = this.healthKey();
        const result = this.core.committer.reportPrepareFailure(failure);
        return Object.freeze({ ...result, healthChanged: before !== this.healthKey() });
    }

    blockDispatch(issue: import('@aotui/core/host').Issue): void { this.control?.blockDispatch(issue); }

    invalidatePublication(): void {
        if (this.stopped) return;
        this.core.lifecycle.invalidatePublication({ code: 'SNAPSHOT_UNAVAILABLE', message: 'The App execution is disconnected.' });
    }

    close(): Promise<void> {
        if (this.completion) return this.completion;
        this.stopped = true;
        this.viewTypes = undefined;
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
