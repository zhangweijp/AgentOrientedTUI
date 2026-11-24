/**
 * AOTUI SDK - App Runtime Context
 * 
 * App-level Runtime context supplied to the full managed component tree.
 * 
 * Supplies app metadata and the Preact adapter's View attachments.
 */

import type { AppLifecyclePort, RuntimeContext } from '@aotui/core';
import type { AppStatePersistence } from '@aotui/core';
import { useContext, useMemo } from 'preact/hooks';
import { sharedPreactContext } from './shared-preact-context.js';
import type { ViewType } from '../tools/view-type-tool.js';
import type { AppID, DesktopID, AppFrameView, AppLaunchConfig, PreparedProjection, ProjectionLimits } from '@aotui/core';
import type { createViewRefs } from '../app-factory/render-commit.js';

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context Value
 * 
 * Preact adapter supplies this context to the App and its Views.
 */
type SynchronousUpdate<Result> = () => Result & (Extract<Result, PromiseLike<unknown>> extends never ? unknown : never);
type PrepareProjection = <UpdateResult>(update: SynchronousUpdate<UpdateResult>) => Promise<PreparedProjection>;
type PrepareOpeningProjection = <UpdateResult, RevertResult>(
    update: SynchronousUpdate<UpdateResult>, revert: SynchronousUpdate<RevertResult>,
) => Promise<PreparedProjection>;

interface AppRuntimeContextValue {
    persistence?: AppStatePersistence | undefined;
    appLifecycle: AppLifecyclePort;
    /** App ID */
    appId: AppID;

    /** Desktop ID */
    desktopId: DesktopID;

    /** App 启动配置 */
    launchConfig?: AppLaunchConfig | undefined;
    readonly projectionLimits: ProjectionLimits;

    resolveViewType: (definition: ViewType) => ViewType;
    createViewRefs: (label: string) => ReturnType<typeof createViewRefs>;
    views: Map<Element, Omit<AppFrameView, 'content' | 'refs'> & Pick<ReturnType<typeof createViewRefs>, 'readRefs'>>;
    prepareProjection: PrepareProjection;
    prepareOpeningProjection: PrepareOpeningProjection;
    readPreparedViewId: RuntimeContext['readPreparedViewId'];
    requestAttention: RuntimeContext['requestAttention'];
}

interface AppRuntimePublicContextValue {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig | undefined;
    readonly persistence?: AppStatePersistence;
    readonly projectionLimits: ProjectionLimits;
    /** Schedule a render and await local projection preparation. */
    readonly prepareProjection: PrepareProjection;
    /** Prepare a reversible View opening, restoring navigation state on capacity rejection. */
    readonly prepareOpeningProjection: PrepareOpeningProjection;
    readonly readPreparedViewId: RuntimeContext['readPreparedViewId'];
    readonly requestAttention: RuntimeContext['requestAttention'];
}

// ═══════════════════════════════════════════════════════════════
//  Context
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context
 * 
 * The Preact adapter installs the provider at the root.
 */
export const AppRuntimeContext = sharedPreactContext<AppRuntimeContextValue>('app');

// ═══════════════════════════════════════════════════════════════
//  Hook
// ═══════════════════════════════════════════════════════════════

/**
 * 使用App Runtime Context
 * 
 * @throws 如果不在AppRuntimeContext.Provider内调用
 */
export function useInternalAppRuntimeContext(): AppRuntimeContextValue {
    const ctx = useContext(AppRuntimeContext);

    if (!ctx) {
        throw new Error(
            '[AOTUI SDK] useAppRuntimeContext must be used within a managed App component.'
        );
    }

    return ctx;
}

/**
 * Read App metadata, configuration, persistence and local projection preparation.
 */
export function useAppRuntimeContext(): AppRuntimePublicContextValue {
    const context = useInternalAppRuntimeContext();
    return useMemo(() => {
        const persistence = context.persistence;
        return Object.freeze({
            appId: context.appId,
            desktopId: context.desktopId,
            projectionLimits: context.projectionLimits,
            prepareProjection: context.prepareProjection,
            prepareOpeningProjection: context.prepareOpeningProjection,
            readPreparedViewId: context.readPreparedViewId,
            requestAttention: context.requestAttention,
            ...(context.launchConfig === undefined ? {} : { launchConfig: context.launchConfig }),
            ...(persistence === undefined ? {} : { persistence }),
        });
    }, [context]);
}
