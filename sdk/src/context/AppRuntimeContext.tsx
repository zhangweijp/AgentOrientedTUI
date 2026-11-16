/**
 * AOTUI SDK - App Runtime Context
 * 
 * App-level Runtime context supplied to the full managed component tree.
 * 
 * Supplies app metadata, App-owned Tool registration, View mount identities, and Ref publication ports.
 */

import type { AppLifecyclePort } from '@aotui/runtime/spi';
import type { AppStatePersistence } from '@aotui/runtime/spi';
import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import type { ViewType } from '../tools/view-type-tool.js';
import type { AppID, DesktopID, IRefExporter, AppFrameView, RuntimeContext, AppLaunchConfig, PreparedProjection } from '@aotui/runtime/spi';

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context Value
 * 
 * Preact adapter supplies this context to the App and its Views.
 */
export type PrepareProjection = (update: () => void, opening?: { readonly revert: () => void }) => Promise<PreparedProjection>;

interface AppRuntimeContextValue {
    persistence?: AppStatePersistence | undefined;
    appLifecycle?: AppLifecyclePort | undefined;
    /** App ID */
    appId: AppID;

    /** Desktop ID */
    desktopId: DesktopID;

    /** App 启动配置 */
    launchConfig?: AppLaunchConfig | undefined;

    /**
     * RefExporter访问 (用于useRef/useArrayRef)
     */
    refExporter: IRefExporter;

    viewTypes: ReadonlyMap<string, ViewType>;
    views: WeakMap<Element, Pick<AppFrameView, 'id' | 'type' | 'owner' | 'bindings'>>;
    mountView: RuntimeContext['mountView'];
    prepareProjection: PrepareProjection;
}

interface AppRuntimePublicContextValue {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig | undefined;
    readonly persistence?: AppStatePersistence;
    /** Schedule a render and await its local projection. Supply a revert only for reversible View openings. */
    readonly prepareProjection: PrepareProjection;
}

// ═══════════════════════════════════════════════════════════════
//  Context
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context
 * 
 * The Preact adapter installs the provider at the root.
 */
export const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

// [RFC-027-C] Factory Injection Pattern:
// Context不再通过globalThis/Symbol注册，而是由Factory内部直接使用。

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
            prepareProjection: context.prepareProjection,
            ...(context.launchConfig === undefined ? {} : { launchConfig: context.launchConfig }),
            ...(persistence === undefined ? {} : { persistence }),
        });
    }, [context]);
}
